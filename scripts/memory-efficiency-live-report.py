#!/usr/bin/env python3
"""Audit live comparison artifacts and summarize observed paired differences."""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import random
import statistics


def sha(value):
    return hashlib.sha256(value).hexdigest()


def paired(rows, treatment, control, field):
    pairs = []
    clusters = {}
    for task, repeat in sorted({(r["task"], r["repetition"]) for r in rows}):
        a = next((r for r in rows if r["task"] == task and r["repetition"] == repeat and r["variant"] == treatment), None)
        b = next((r for r in rows if r["task"] == task and r["repetition"] == repeat and r["variant"] == control), None)
        if (a is None or b is None or a.get(field) is None or b.get(field) is None
                or a.get("accepted") is not True or b.get("accepted") is not True):
            continue
        pairs.append((a[field], b[field]))
        clusters.setdefault(task, []).append((a[field], b[field]))
    if not pairs:
        return None
    before, after = sum(b for _, b in pairs), sum(a for a, _ in pairs)
    reduction = lambda sample: 100 * (1 - sum(a for a, _ in sample) / sum(b for _, b in sample))
    rng = random.Random(20260923)
    cluster_values = list(clusters.values())
    boot = sorted(reduction([pair for group in rng.choices(cluster_values, k=len(cluster_values)) for pair in group])
                  for _ in range(10000))
    differences = [sum(a - b for a, b in group) for group in cluster_values]
    observed = abs(sum(differences))
    permutations = [abs(sum(d * sign for d, sign in zip(differences, signs)))
                    for signs in itertools.product((-1, 1), repeat=len(differences))]
    return dict(pairs=len(pairs), distinct_tasks=len(clusters), control_total=before, treatment_total=after,
                reduction_pct=100 * (1 - after / before) if before else None,
                pairs_improved=sum(a < b for a, b in pairs),
                task_cluster_bootstrap_95pct_reduction_interval=[boot[249], boot[9749]] if len(clusters)>1 else None,
                task_cluster_sign_flip_two_sided_p=sum(x >= observed for x in permutations) / len(permutations),
                uncertainty_note="Resampling keeps repetitions of one task together; only three task clusters, so this does not prove a population effect")


def report(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    attempts = json.loads((directory / "attempts.json").read_text())
    review_path = directory / "acceptance-review.json"
    reviews = json.loads(review_path.read_text()) if review_path.exists() else []
    review_by_id = {r["id"]: r for r in reviews}
    rows = []
    for record in attempts:
        row = dict(record)
        row["attempt_elapsed_ms"] = record.get("elapsed_ms")
        row["elapsed_ms"] = record.get("elapsed_ms") if record["status"] == "observed" else None
        usage = row.get("usage") or {}
        row["input_tokens"] = usage.get("input_tokens")
        row["cached_input_tokens"] = usage.get("cached_input_tokens")
        row["output_tokens"] = usage.get("output_tokens")
        row["cache_write_input_tokens"] = usage.get("cache_write_input_tokens")
        row["reasoning_output_tokens"] = usage.get("reasoning_output_tokens")
        row["uncached_input_tokens"] = (row["input_tokens"] - row["cached_input_tokens"]
             if type(row["input_tokens"]) is int and type(row["cached_input_tokens"]) is int else None)
        row["total_tokens"] = row["input_tokens"] + row["output_tokens"] if all(
            type(row[k]) is int for k in ("input_tokens", "output_tokens")) else None
        review = review_by_id.get(row["id"], {})
        row["accepted"] = (review.get("accepted") if review.get("answer_sha256") == row.get("answer_sha256") else None)
        answer_path = directory / "runs" / row["id"] / "answer.json"
        events_path = directory / "runs" / row["id"] / "events.jsonl"
        row["artifact_hashes_valid"] = bool(answer_path.exists() and events_path.exists()
            and sha(events_path.read_bytes()) == row.get("events_sha256")
            and sha(json.dumps(json.loads(answer_path.read_text()), ensure_ascii=False).encode()) == row.get("answer_sha256"))
        workspace = Path(row["workspace"])
        row["source_unchanged"] = all((workspace / path).is_file() and sha((workspace / path).read_bytes()) == expected
            for path, expected in manifest["source_hashes"].items())
        row["usage_valid"] = all(type(row.get(k)) is int and row[k] >= 0 for k in
            ("input_tokens", "cached_input_tokens", "output_tokens", "uncached_input_tokens"))
        rows.append(row)
    variants = {}
    fields = ["elapsed_ms", "attempt_elapsed_ms", "cli_elapsed_ms", "context_process_ms", "input_tokens", "cached_input_tokens",
              "uncached_input_tokens", "output_tokens", "reasoning_output_tokens", "cache_write_input_tokens",
              "total_tokens", "command_calls", "failed_commands"]
    for variant in manifest["variants"]:
        selected = [r for r in rows if r["variant"] == variant]
        variants[variant] = dict(runs=len(selected), accepted=sum(r["accepted"] is True for r in selected),
            failed=sum(r["accepted"] is False for r in selected),
            pending=sum(r["accepted"] is None for r in selected), timeouts=sum(r.get("timeout") is True for r in selected),
            usage_unknown=sum(not r["usage_valid"] for r in selected), actual_usd=None)
        for field in fields:
            values = [r[field] for r in selected if r.get(field) is not None]
            variants[variant][field] = (dict(total=sum(values), mean=statistics.mean(values), median=statistics.median(values))
                                      if values and len(values) == len(selected) else None)
    complete = (len(rows) == 18 and all(r["status"] == "observed" and r["usage_valid"]
        and r["artifact_hashes_valid"] and r["source_unchanged"] and r["accepted"] is True for r in rows))
    summary = dict(schema="orgbrain-live-efficiency-report/v1", model=manifest["model"], effort=manifest["effort"],
        complete_matched_acceptance=complete, variants=variants,
        comparisons={f"{a}_versus_{b}": {
                     "complete_comparison": len([r for r in rows if r["variant"] in (a,b)]) == 12
                       and all(r["status"] == "observed" and r["usage_valid"] and r["accepted"] is True
                               and r["artifact_hashes_valid"] and r["source_unchanged"]
                               for r in rows if r["variant"] in (a,b)),
                     "basis": "Accepted matched pairs only; incomplete contrasts cannot establish overall savings",
                     **{field: paired(rows, a, b, field) for field in
                       ["elapsed_ms", "total_tokens", "uncached_input_tokens", "output_tokens"]}}
                     for a, b in [("compact", "full"), ("compact", "none"), ("full", "none")]},
        actual_subscription_bill_savings=None, monetary_qualification="not_measurable_from_subscription_task_usage",
        usage_accounting="cached input is a subset of input; reasoning is a subset of output; missing cache writes remain unknown",
        limitations=["Curated source-verified memory hits, not automatic extraction or production coverage",
                     "Three repository research tasks, two repetitions each; no code repair or end-user workflow tasks",
                     "Isolated CLI configuration, not the desktop plugin and hook environment",
                     "Snapshot includes CLI/shared sources, scripts, docs and migrations, but not apps; missing-file searches are retained",
                     "The same tasks can interact with provider caching; order is balanced, caches cannot be flushed",
                     "Elapsed time includes CLI completion and context process, excludes fixture memory seeding",
                     "Subscription usage cannot establish a monetary saving or a reduction in a fixed monthly bill"],
        rows=rows)
    (directory / "report.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: summary[k] for k in ["complete_matched_acceptance", "variants", "comparisons"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    report(parser.parse_args().directory.resolve())
