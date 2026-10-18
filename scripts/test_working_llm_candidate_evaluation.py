import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "working_llm_candidate_evaluation", ROOT / "working-llm-candidate-evaluation.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def case(case_id="Q001", candidates=("D001", "D002"), expected=("D001",)):
    full = {
        "query": "東京の契約条件を確認",
        "documents": [
            {"id": candidate, "memory": {"id": f"real-{candidate}", "content": f"full {candidate}"}}
            for candidate in candidates
        ],
    }
    compact = {
        "query": full["query"],
        "documents": [
            {"id": candidate, "preview": f"preview {candidate}", "source_version": f"v-{candidate}"}
            for candidate in candidates
        ],
    }
    details = {
        candidate: {"id": candidate, "memory": full["documents"][index]["memory"]}
        for index, candidate in enumerate(candidates)
    }
    return {
        "case_id": case_id,
        "baseline_payload": full,
        "compact_payload": compact,
        "details": details,
        "expected_ids": list(expected),
    }


class CandidateEvaluationTests(unittest.TestCase):
    def test_stage_two_retains_previews_and_only_selected_full_details(self):
        row = case()
        payload = MODULE.build_stage_two_payload(row, ["D002"])
        self.assertEqual(payload["initial_candidates"], row["compact_payload"]["documents"])
        self.assertEqual(payload["initial_selected_ids"], ["D002"])
        self.assertEqual(payload["selected_details"], [row["details"]["D002"]])
        self.assertEqual(MODULE.allowed_ids(payload), ["D002"])

    def test_gold_labels_never_enter_any_model_payload_or_prompt(self):
        row = case(expected=("GOLD_NOT_RETRIEVED_1",))
        calls = []

        def fake_call(payload, stage, allowed):
            calls.append((payload, stage, allowed))
            return {"selected_ids": []}, {"input_tokens": 10}, 0.1

        MODULE.evaluate_cases([row], fake_call)
        for payload, stage, allowed in calls:
            prompt = MODULE.build_prompt(payload, stage)
            self.assertNotIn("GOLD_NOT_RETRIEVED_1", prompt)
            self.assertNotIn("expected_ids", prompt)
            self.assertNotIn("expected_ids", payload)

    def test_empty_first_stage_skips_second_call_but_keeps_empty_baseline_call(self):
        row = case(candidates=(), expected=("GOLD_NOT_RETRIEVED_1",))
        calls = []

        def fake_call(payload, stage, allowed):
            calls.append(stage)
            return {"selected_ids": []}, {"input_tokens": 1}, 0.01

        result = MODULE.evaluate_cases([row], fake_call)
        self.assertEqual(calls, ["legacy_full", "compact_preview"])
        self.assertEqual(result["rows"][0]["compact_status"], "skipped_empty_selection")
        self.assertEqual(result["rows"][0]["final_selected_ids"], [])

    def test_stage_two_unknown_or_unselected_ids_fail_closed(self):
        row = case()
        seen = []

        def fake_call(payload, stage, allowed):
            seen.append((stage, allowed))
            if stage == "compact_preview":
                return {"selected_ids": ["D001"]}, {"input_tokens": 7, "cache_write_input_tokens": 0}, 0.01
            if stage == "compact_detail":
                return {"selected_ids": ["D002"]}, {"input_tokens": 8, "cache_write_input_tokens": 1}, 0.01
            return {"selected_ids": []}, {}, 0.01

        result = MODULE.evaluate_cases([row], fake_call)
        self.assertEqual(seen[-1], ("compact_detail", ["D001"]))
        self.assertEqual(result["rows"][0]["final_selected_ids"], None)
        self.assertEqual(result["rows"][0]["compact_status"], "selection_invalid")
        self.assertEqual(result["arms"]["compact_total"]["usage"]["input_tokens"]["known_sum"], 15)
        self.assertEqual(result["arms"]["compact_total"]["usage"]["cache_write_tokens"]["known_sum"], 1)

    def test_missing_usage_is_not_reported_as_zero(self):
        usage = MODULE.aggregate_usage([{"usage": {"input_tokens": 8}}, {"usage": None}])
        self.assertEqual(usage["input_tokens"], {"known_sum": 8, "observed_calls": 1, "missing_calls": 1, "complete": False})
        self.assertEqual(usage["output_tokens"]["known_sum"], None)

    def test_stage_one_prompt_requires_detail_confirmation(self):
        prompt = MODULE.build_prompt(case()["compact_payload"], "compact_preview")
        self.assertIn("confirm", prompt.lower())
        self.assertIn("untrusted data", prompt.lower())


if __name__ == "__main__":
    unittest.main()
