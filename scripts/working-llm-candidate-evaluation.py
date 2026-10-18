"""Paired evaluation of full-memory and compact-preview two-stage selection."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import statistics
import subprocess
import time


ROOT = Path(__file__).resolve().parent.parent
HELPER_PATH = ROOT / "scripts/working-llm-selection-evaluation.py"
_SPEC = importlib.util.spec_from_file_location("working_llm_selection_evaluation", HELPER_PATH)
_HELPER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_HELPER)

BASE_PROMPT = _HELPER.PROMPT + "\n\nAlways review and detail-confirm selected memories before applying them."
MAX_CASES = 64
USAGE_KEYS = {
    "input_tokens": ("input_tokens",),
    "cached_input_tokens": ("cached_input_tokens", "input_tokens_details.cached_tokens"),
    "cache_write_tokens": ("cache_write_tokens", "cache_write_input_tokens", "cache_creation_input_tokens", "input_tokens_details.cache_write_tokens"),
    "output_tokens": ("output_tokens",),
    "reasoning_output_tokens": ("reasoning_output_tokens", "output_tokens_details.reasoning_tokens"),
}


class CallFailure(RuntimeError):
    def __init__(self, message, usage=None, seconds=None):
        super().__init__(message)
        self.usage = usage
        self.seconds = seconds


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "backslashreplace")


def _read_json(path, label):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid {label}") from error


def _ids_from_documents(payload, label):
    if not isinstance(payload, dict) or not isinstance(payload.get("query"), str) or not isinstance(payload.get("documents"), list):
        raise ValueError(f"invalid {label} payload")
    ids = []
    for doc in payload["documents"]:
        if not isinstance(doc, dict) or not isinstance(doc.get("id"), str) or not doc["id"]:
            raise ValueError(f"invalid {label} candidate")
        ids.append(doc["id"])
    if len(set(ids)) != len(ids):
        raise ValueError(f"duplicate {label} candidate id")
    return ids


def validate_cases(value):
    """Validate the prepared envelope without exposing labels to model inputs."""
    if not isinstance(value, dict) or not isinstance(value.get("cases"), list):
        raise ValueError("invalid prepared cases")
    cases = value["cases"]
    if not cases or len(cases) > MAX_CASES:
        raise ValueError("case count outside the bounded range")
    seen_cases = set()
    for row in cases:
        if not isinstance(row, dict):
            raise ValueError("invalid case row")
        case_id = row.get("case_id")
        if not isinstance(case_id, str) or not case_id or case_id in seen_cases:
            raise ValueError("invalid or duplicate case id")
        seen_cases.add(case_id)
        baseline_ids = _ids_from_documents(row.get("baseline_payload"), "baseline")
        compact_ids = _ids_from_documents(row.get("compact_payload"), "compact")
        if baseline_ids != compact_ids:
            raise ValueError("baseline and compact candidate ids do not align")
        if row["baseline_payload"]["query"] != row["compact_payload"]["query"]:
            raise ValueError("baseline and compact queries do not align")
        expected = row.get("expected_ids")
        if not isinstance(expected, list) or any(not isinstance(item, str) or not item for item in expected):
            raise ValueError("invalid expected ids")
        if len(set(expected)) != len(expected):
            raise ValueError("duplicate expected id")
        if any(item not in baseline_ids and not item.startswith("GOLD_NOT_RETRIEVED_") for item in expected):
            raise ValueError("unknown expected id")
        details = row.get("details")
        if not isinstance(details, dict) or set(details) != set(compact_ids):
            raise ValueError("details do not cover exactly the candidates")
        baseline_by_id = {doc["id"]: doc for doc in row["baseline_payload"]["documents"]}
        for candidate_id in compact_ids:
            detail = details[candidate_id]
            baseline_doc = baseline_by_id[candidate_id]
            if not isinstance(detail, dict) or detail.get("id") != candidate_id:
                raise ValueError("invalid selected detail")
            if "memory" not in detail or detail["memory"] != baseline_doc.get("memory"):
                raise ValueError("detail does not match full baseline memory")
    return cases


def allowed_ids(payload):
    """Return IDs permitted in this stage's output."""
    if isinstance(payload, dict) and "initial_selected_ids" in payload:
        selected = payload["initial_selected_ids"]
        if not isinstance(selected, list):
            raise ValueError("invalid initial selection")
        return list(selected)
    return _ids_from_documents(payload, "model")


def build_stage_two_payload(case, selected_ids):
    candidates = case["compact_payload"]["documents"]
    selected = _HELPER.validate_selection({"selected_ids": selected_ids}, [row["id"] for row in candidates])
    return {
        "query": case["compact_payload"]["query"],
        "initial_candidates": candidates,
        "initial_selected_ids": selected,
        "selected_details": [case["details"][candidate_id] for candidate_id in selected],
    }


def build_prompt(payload, stage):
    instructions = {
        "legacy_full": "The candidate records contain full original memory details. Select relevant memories from these records.",
        "compact_preview": "The candidate records are compact previews. Treat selections as provisional; the next stage will confirm all selected full originals before application.",
        "compact_detail": "Review the selected full original details against the query. You may reorder or drop IDs, but may return only IDs in initial_selected_ids.",
    }
    if stage not in instructions:
        raise ValueError("unknown evaluation stage")
    return BASE_PROMPT + "\n" + instructions[stage] + "\n\nINPUT_JSON:\n" + _json_bytes(payload).decode("utf-8")


def _usage_value(usage, dotted_key):
    value = usage
    for part in dotted_key.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def aggregate_usage(calls):
    result = {}
    for name, keys in USAGE_KEYS.items():
        observed = [next((value for key in keys if (value := _usage_value(row.get("usage"), key)) is not None), None) for row in calls]
        known = [value for value in observed if value is not None]
        missing = len(calls) - len(known)
        result[name] = {
            "known_sum": sum(known) if known else None,
            "observed_calls": len(known),
            "missing_calls": missing,
            "complete": missing == 0,
        }
    return result


def _summarize_calls(calls):
    durations = [row["seconds"] for row in calls if isinstance(row.get("seconds"), (int, float))]
    return {
        "call_count": len(calls),
        "seconds_total": sum(durations),
        "seconds_mean": statistics.mean(durations) if durations else None,
        "seconds_median": statistics.median(durations) if durations else None,
        "payload_json_bytes_total": sum(row.get("payload_json_bytes", 0) for row in calls),
        "prompt_bytes_total": sum(row.get("prompt_bytes", 0) for row in calls),
        "usage": aggregate_usage(calls),
    }


def _selection_metrics(cases, predictions):
    if not predictions:
        return {"scored_count": 0, "metrics": None}
    scored = [row for row in cases if row["case_id"] in predictions]
    adapted = [
        {"case_id": row["case_id"], "payload": row["baseline_payload"], "expected_ids": row["expected_ids"]}
        for row in scored
    ]
    return {"scored_count": len(scored), "metrics": _HELPER.metrics(adapted, predictions)}


def evaluate_cases(cases, call_fn):
    """Run injectable, no-retry paired selection and return success-only metrics."""
    cases = validate_cases({"cases": cases})
    calls_by_stage = {"legacy_full": [], "compact_preview": [], "compact_detail": []}
    predictions = {stage: {} for stage in calls_by_stage}
    rows = []

    def invoke(case_id, payload, stage):
        encoded = _json_bytes(payload)
        prompt = build_prompt(payload, stage)
        item = {"case_id": case_id, "stage": stage, "payload_json_bytes": len(encoded), "prompt_bytes": len(prompt.encode("utf-8")), "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest()}
        started = time.perf_counter()
        usage = None
        elapsed = None
        try:
            raw, usage, reported_seconds = call_fn(payload, stage, allowed_ids(payload))
            elapsed = float(reported_seconds) if isinstance(reported_seconds, (int, float)) else time.perf_counter() - started
            selected = _HELPER.validate_selection(raw, allowed_ids(payload))
            item.update({"seconds": elapsed, "usage": usage if isinstance(usage, dict) else None, "selected_ids": selected, "status": "complete"})
        except Exception as error:
            item.update({"seconds": elapsed if elapsed is not None else getattr(error, "seconds", None) or time.perf_counter() - started, "usage": usage if isinstance(usage, dict) else getattr(error, "usage", None), "selected_ids": None, "status": "error", "error_type": type(error).__name__})
        calls_by_stage[stage].append(item)
        return item

    for index, row in enumerate(cases):
        call_order = ["legacy_full", "compact_preview"] if index % 2 == 0 else ["compact_preview", "legacy_full"]
        row_calls = {}
        preview_selected = None
        for stage in call_order:
            if stage == "legacy_full":
                item = invoke(row["case_id"], row["baseline_payload"], stage)
                row_calls[stage] = item
                if item["status"] == "complete":
                    predictions[stage][row["case_id"]] = item["selected_ids"]
            else:
                item = invoke(row["case_id"], row["compact_payload"], stage)
                row_calls[stage] = item
                if item["status"] == "complete":
                    preview_selected = item["selected_ids"]
                    predictions[stage][row["case_id"]] = preview_selected
        detail_item = None
        if preview_selected is None:
            compact_status = "skipped_preview_failed"
        elif not preview_selected:
            compact_status = "skipped_empty_selection"
            predictions["compact_detail"][row["case_id"]] = []
        else:
            detail_payload = build_stage_two_payload(row, preview_selected)
            detail_item = invoke(row["case_id"], detail_payload, "compact_detail")
            compact_status = detail_item["status"] if detail_item["status"] == "complete" else "selection_invalid"
            if detail_item["status"] == "complete":
                predictions["compact_detail"][row["case_id"]] = detail_item["selected_ids"]
        rows.append({
            "case_id": row["case_id"],
            "legacy_status": row_calls["legacy_full"]["status"],
            "legacy_selected_ids": row_calls["legacy_full"]["selected_ids"],
            "preview_status": row_calls["compact_preview"]["status"],
            "preview_selected_ids": row_calls["compact_preview"]["selected_ids"],
            "compact_status": compact_status,
            "detail_selected_ids": detail_item["selected_ids"] if detail_item else ([] if compact_status == "skipped_empty_selection" else None),
            "final_selected_ids": detail_item["selected_ids"] if detail_item and detail_item["status"] == "complete" else ([] if compact_status == "skipped_empty_selection" else None),
        })

    stage_summary = {}
    for stage, calls in calls_by_stage.items():
        stage_summary[stage] = {**_summarize_calls(calls), **_selection_metrics(cases, predictions[stage]), "failed_count": sum(call["status"] != "complete" for call in calls)}
    compact_calls = calls_by_stage["compact_preview"] + calls_by_stage["compact_detail"]
    compact_success_cases = {row["case_id"] for row in cases if row["case_id"] in predictions["compact_detail"]}
    compact_predictions = {key: value for key, value in predictions["compact_detail"].items() if key in compact_success_cases}
    compact_cases = [row for row in cases if row["case_id"] in compact_success_cases]
    stage_summary["compact_total"] = {**_summarize_calls(compact_calls), **_selection_metrics(compact_cases, compact_predictions), "failed_count": sum(row["compact_status"] in ("skipped_preview_failed", "selection_invalid") for row in rows), "skipped_empty_selection_count": sum(row["compact_status"] == "skipped_empty_selection" for row in rows)}
    return {"rows": rows, "calls": [call for stage in calls_by_stage.values() for call in stage], "arms": stage_summary}


def _append_event(path, event):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, (json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)


def _save_private(path, value, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(path, flags, 0o600)
    try:
        os.write(fd, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def _codex_call_factory(out_dir, codex_home, timeout):
    schema_path = out_dir / "schema.json"
    _save_private(schema_path, {
        "type": "object", "properties": {"selected_ids": {"type": "array", "items": {"type": "string"}, "maxItems": 5}},
        "required": ["selected_ids"], "additionalProperties": False,
    })
    counter = {"value": 0}

    def call(payload, stage, allowed):
        counter["value"] += 1
        number = counter["value"]
        prefix = out_dir / f"call-{number:03d}-{stage}"
        prompt = build_prompt(payload, stage)
        prompt_path, answer_path = Path(str(prefix) + ".prompt.txt"), Path(str(prefix) + ".answer.json")
        stdout_path, stderr_path = Path(str(prefix) + ".events.jsonl"), Path(str(prefix) + ".stderr.txt")
        _save_private(prompt_path, prompt)
        argv = ["codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--model", "gpt-6.1-sol", "-c", "model_reasoning_effort=high", "-c", "project_doc_max_bytes=0", "-c", "web_search=disabled"]
        for feature in ["hooks", "memories", "apps", "plugins", "multi_agent", "shell_tool", "computer_use", "browser_use"]:
            argv += ["--disable", feature]
        argv += ["--json", "--color", "never", "--cd", "/private/tmp/orgbrain-selector-evaluation", "--output-schema", str(schema_path), "--output-last-message", str(answer_path), "-"]
        _append_event(out_dir / "calls.jsonl", {"event": "started", "number": number, "stage": stage, "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest()})
        started = time.perf_counter()
        proc = None
        error = None
        with stdout_path.open("x", encoding="utf-8") as stdout, stderr_path.open("x", encoding="utf-8") as stderr:
            for path in (stdout_path, stderr_path):
                path.chmod(0o600)
            proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, text=True, start_new_session=True, env={**os.environ, "CODEX_HOME": str(codex_home)})
            try:
                proc.communicate(prompt, timeout=timeout)
                if proc.returncode:
                    error = "codex_exit"
            except BaseException:
                if proc.poll() is None:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.communicate()
                raise
        seconds = time.perf_counter() - started
        usage = None
        unexpected_tools = []
        for line in stdout_path.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "turn.completed":
                usage = event.get("usage")
            item = event.get("item", {})
            if event.get("type") == "item.completed" and item.get("type") not in ("agent_message", "reasoning"):
                unexpected_tools.append(item.get("type"))
        if unexpected_tools:
            error = "unexpected_tool_use"
        if error:
            _append_event(out_dir / "calls.jsonl", {"event": "completed", "number": number, "status": error, "seconds": seconds, "usage": usage})
            raise CallFailure(error, usage, seconds)
        try:
            raw = json.loads(answer_path.read_text(encoding="utf-8"))
        except Exception as exc:
            _append_event(out_dir / "calls.jsonl", {"event": "completed", "number": number, "status": "selection_invalid", "seconds": seconds, "usage": usage})
            raise CallFailure("selection_invalid", usage, seconds) from exc
        _append_event(out_dir / "calls.jsonl", {"event": "response_received", "number": number, "seconds": seconds, "usage": usage})
        return raw, usage, seconds

    return call


def _load_historical_reference(cases_path, results_path, current_cases):
    """Read a previous fixed-set run as a labelled historical reference only."""
    historical_cases = _read_json(cases_path, "historical cases")
    result = _read_json(results_path, "historical results")
    rows = result.get("rows") if isinstance(result, dict) else None
    if not isinstance(historical_cases, list) or not isinstance(rows, list):
        raise ValueError("invalid historical reference")
    by_id = {row.get("case_id"): row for row in rows if isinstance(row, dict)}
    if len(by_id) != len(rows) or set(by_id) != {row["case_id"] for row in current_cases}:
        raise ValueError("historical case ids do not align")
    old_case_ids = [row.get("case_id") for row in historical_cases if isinstance(row, dict)]
    if len(old_case_ids) != len(historical_cases) or len(set(old_case_ids)) != len(old_case_ids) or set(old_case_ids) != set(by_id):
        raise ValueError("historical case input does not align")
    current_by_id = {row["case_id"]: row for row in current_cases}
    for old in historical_cases:
        current = current_by_id[old["case_id"]]
        old_ids = _ids_from_documents(old.get("payload"), "historical")
        current_ids = _ids_from_documents(current["baseline_payload"], "current")
        if old.get("expected_ids") != current["expected_ids"] or old_ids != current_ids:
            raise ValueError("historical input or labels do not align with the current fixture")
    predictions = {}
    for row in historical_cases:
        prior = by_id[row["case_id"]].get("raw")
        if not isinstance(prior, dict) or prior.get("error") or not isinstance(prior.get("selected_ids"), list):
            continue
        predictions[row["case_id"]] = prior["selected_ids"]
    usable = [row for row in historical_cases if row.get("case_id") in predictions]
    if not usable:
        raise ValueError("historical reference has no complete raw selections")
    return {
        "label": "historical_fixed_set_raw_4000_reference_only",
        "used_in_fresh_comparison": False,
        "scored_count": len(usable),
        "metrics": _HELPER.metrics(usable, predictions),
        "case_file_sha256": hashlib.sha256(Path(cases_path).read_bytes()).hexdigest(),
        "results_file_sha256": hashlib.sha256(Path(results_path).read_bytes()).hexdigest(),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--protocol", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--codex-home", required=True, help="pre-provisioned isolated Codex home; credentials are not inspected")
    parser.add_argument("--accept-protocol-sha256")
    parser.add_argument("--historical-cases")
    parser.add_argument("--historical-results")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    if (args.historical_cases is None) != (args.historical_results is None):
        raise SystemExit("provide both historical paths or neither")
    if not 1 <= args.timeout_seconds <= 600:
        raise SystemExit("timeout must be 1..600 seconds")
    cases_bytes = Path(args.cases).read_bytes()
    protocol_bytes = Path(args.protocol).read_bytes()
    cases_data = json.loads(cases_bytes)
    protocol_data = json.loads(protocol_bytes)
    cases = validate_cases(cases_data)
    if not isinstance(protocol_data, dict):
        raise SystemExit("protocol must be a JSON object")
    protocol_hash = hashlib.sha256(protocol_bytes).hexdigest()
    helper_hash = hashlib.sha256(HELPER_PATH.read_bytes()).hexdigest()
    runner_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    case_hash = hashlib.sha256(cases_bytes).hexdigest()
    preflight = {"case_count": len(cases), "protocol_sha256": protocol_hash, "cases_sha256": case_hash, "helper_sha256": helper_hash, "runner_sha256": runner_hash, "execute": args.execute}
    if not args.execute:
        print(json.dumps(preflight, separators=(",", ":")))
        return 0
    if args.accept_protocol_sha256 != protocol_hash:
        raise SystemExit("execution requires exact --accept-protocol-sha256")
    codex_home = Path(args.codex_home)
    if not codex_home.is_dir():
        raise SystemExit("isolated Codex home must already exist")
    reference = None
    if args.historical_cases:
        reference = _load_historical_reference(args.historical_cases, args.historical_results, cases)
    output = Path(args.out)
    if not output.parent.is_dir():
        raise SystemExit("output parent must already exist")
    try:
        output.mkdir(mode=0o700, exist_ok=False)
    except FileExistsError as error:
        raise SystemExit("output exists; refuse overwrite or retry") from error
    os.chmod(output, 0o700)
    manifest = {**preflight, "model": "gpt-6.1-sol", "reasoning_effort": "high", "timeout_seconds": args.timeout_seconds, "payload_schema": "baseline_payload/compact_payload/details/expected_ids"}
    _save_private(output / "manifest-frozen.json", manifest, exclusive=True)
    _save_private(output / "run-started.json", {"started_at_unix": time.time(), "manifest_sha256": hashlib.sha256(_json_bytes(manifest)).hexdigest()}, exclusive=True)
    evaluated = evaluate_cases(cases, _codex_call_factory(output, codex_home, args.timeout_seconds))
    result = {"manifest": manifest, "historical_reference": reference, **evaluated}
    _save_private(output / "results.json", result, exclusive=True)
    for path in output.iterdir():
        if path.is_file():
            path.chmod(0o600)
    print(json.dumps({"status": "complete", "case_count": len(cases), "results": str(output / "results.json")}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
