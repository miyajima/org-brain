import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


MODULE_PATH = Path(__file__).with_name("working-llm-selection-evaluation.py")
SPEC = importlib.util.spec_from_file_location("working_llm_selection_evaluation", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WorkingLlmSelectionEvaluationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        db = sqlite3.connect(self.directory / "gemma.sqlite")
        db.execute(
            "CREATE TABLE memories (tenant_id TEXT NOT NULL, id TEXT NOT NULL, summary TEXT, "
            "rationale TEXT, reuse_rule TEXT, content TEXT, PRIMARY KEY (tenant_id, id))"
        )
        db.executemany(
            "INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)",
            [
                ("default", "mem-a", "summary", "rationale", "reuse rule", "content"),
                ("default", "mem-b", None, None, None, "x" * 3999 + "😀Z"),
                ("default", "mem-gold", "unretrieved target", None, None, "gold content"),
            ],
        )
        db.commit()
        db.close()

        self.queries = {
            "queries": [
                {"id": "stored-1", "query": "question one", "expected_ids": ["mem-a"]},
                {"id": "stored-2", "query": "question two", "expected_ids": ["mem-gold"]},
                {"id": "stored-3", "query": "unrelated", "expected_ids": []},
            ]
        }
        self.result = {
            "schema": "local-relevance-comparison/v1",
            "phase": "holdout",
            "rows": [
                {
                    "id": "stored-1",
                    "query": "question one",
                    "expected_ids": ["mem-a"],
                    "arms": {"gemma": ["mem-a", "mem-b"]},
                },
                {
                    "id": "stored-2",
                    "query": "question two",
                    "expected_ids": ["mem-gold"],
                    "arms": {"gemma": ["mem-b", "mem-a"]},
                },
                {
                    "id": "stored-3",
                    "query": "unrelated",
                    "expected_ids": [],
                    "arms": {"gemma": []},
                },
            ],
        }
        (self.directory / "holdout-queries.json").write_text(json.dumps(self.queries))
        (self.directory / "holdout-result.json").write_text(json.dumps(self.result))

    def tearDown(self):
        self.tmp.cleanup()

    def test_loads_aligned_private_labels_and_reconstructs_exact_documents(self):
        cases = MODULE.load_frozen_cases(self.directory)

        self.assertEqual([case["case_id"] for case in cases], ["Q001", "Q002", "Q003"])
        self.assertEqual(cases[0]["payload"]["query"], "question one")
        self.assertEqual(cases[0]["expected_ids"], ["D001"])
        self.assertEqual(
            cases[0]["payload"]["documents"][0],
            {"id": "D001", "text": "summary\nrationale\nreuse rule\ncontent"},
        )
        truncated = cases[0]["payload"]["documents"][1]["text"]
        self.assertEqual(truncated, "x" * 3999 + "\ud83d")
        self.assertEqual(len(truncated.encode("utf-16-le", errors="surrogatepass")) // 2, 4000)
        self.assertEqual(cases[1]["expected_ids"], ["GOLD_NOT_RETRIEVED_1"])
        self.assertNotIn(
            "GOLD_NOT_RETRIEVED_1",
            {doc["id"] for doc in cases[1]["payload"]["documents"]},
        )
        self.assertEqual(cases[2]["payload"]["documents"], [])
        self.assertNotIn("expected_ids", cases[0]["payload"])

    def test_rejects_query_misalignment_and_unknown_memory_ids(self):
        changed = dict(self.result)
        changed["rows"] = [dict(row) for row in self.result["rows"]]
        changed["rows"][0] = {**changed["rows"][0], "query": "different question"}
        (self.directory / "holdout-result.json").write_text(json.dumps(changed))
        with self.assertRaises(ValueError):
            MODULE.load_frozen_cases(self.directory)

        (self.directory / "holdout-result.json").write_text(json.dumps(self.result))
        changed = dict(self.result)
        changed["rows"] = [dict(row) for row in self.result["rows"]]
        changed["rows"][0] = {
            **changed["rows"][0],
            "arms": {"gemma": ["missing-memory"]},
        }
        (self.directory / "holdout-result.json").write_text(json.dumps(changed))
        with self.assertRaises(ValueError):
            MODULE.load_frozen_cases(self.directory)

    def test_rejects_candidate_id_that_exists_only_outside_default_tenant(self):
        db = sqlite3.connect(self.directory / "gemma.sqlite")
        db.execute(
            "UPDATE memories SET tenant_id = 'other' WHERE tenant_id = 'default' AND id = 'mem-a'"
        )
        db.commit()
        db.close()

        with self.assertRaises(ValueError):
            MODULE.load_frozen_cases(self.directory)

    def test_validate_selection_accepts_only_unique_known_ids_and_at_most_five(self):
        allowed = [f"D{index:03}" for index in range(1, 7)]
        self.assertEqual(MODULE.validate_selection({"selected_ids": ["D001", "D002"]}, allowed), ["D001", "D002"])
        self.assertEqual(MODULE.validate_selection({"selected_ids": []}, allowed), [])
        for value in (
            ["D001"],
            {"selected_ids": ["D001"], "extra": True},
            {"selected_ids": ["D001", "D001"]},
            {"selected_ids": ["D999"]},
            {"selected_ids": ["D001"] * 6},
            {"selected_ids": [1]},
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.validate_selection(value, allowed)

    def test_metrics_score_ordered_ids_and_count_only_losses_for_retrieved_targets(self):
        cases = MODULE.load_frozen_cases(self.directory)
        predictions = {"Q001": ["D002"], "Q002": ["D001"], "Q003": []}
        result = MODULE.metrics(cases, predictions)

        self.assertEqual(result["positive_count"], 2)
        self.assertEqual(result["negative_count"], 1)
        self.assertEqual(result["hit_at_1"], 0.0)
        self.assertEqual(result["hit_at_5"], 0.0)
        self.assertEqual(result["mrr_at_5"], 0.0)
        self.assertEqual(result["negative_any_result_rate"], 0.0)
        self.assertAlmostEqual(result["mean_result_count"], 2 / 3)
        self.assertEqual(result["lost_targets_if_expected_in_candidates"], 1)
        self.assertNotIn("precision", result)

    def test_unretrieved_gold_remains_positive_and_never_enters_model_payload(self):
        case = MODULE.load_frozen_cases(self.directory)[1]

        self.assertEqual(case["expected_ids"], ["GOLD_NOT_RETRIEVED_1"])
        self.assertNotIn("GOLD_NOT_RETRIEVED_1", case["payload"]["query"])
        self.assertNotIn(
            "GOLD_NOT_RETRIEVED_1",
            {document["id"] for document in case["payload"]["documents"]},
        )

        result = MODULE.metrics([case], {"Q002": ["D001"]})

        self.assertEqual(result["positive_count"], 1)
        self.assertEqual(result["negative_count"], 0)
        self.assertEqual(result["hit_at_1"], 0.0)
        self.assertEqual(result["hit_at_5"], 0.0)
        self.assertEqual(result["mrr_at_5"], 0.0)
        self.assertEqual(result["lost_targets_if_expected_in_candidates"], 0)

    def test_metrics_rejects_incomplete_or_invalid_prediction_maps(self):
        cases = MODULE.load_frozen_cases(self.directory)
        for predictions in (
            {"Q001": ["D001"]},
            {"Q001": ["D001"], "Q002": ["D001"], "Q003": [], "Q999": []},
            {"Q001": ["unknown"], "Q002": ["D001"], "Q003": []},
            {"Q001": ["D001", "D001"], "Q002": ["D001"], "Q003": []},
        ):
            with self.subTest(predictions=predictions), self.assertRaises(ValueError):
                MODULE.metrics(cases, predictions)


if __name__ == "__main__":
    unittest.main()
