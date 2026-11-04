import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('coherence_eval',Path(__file__).with_name('memory-task-coherence-eval.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class EvaluationBudgetTests(unittest.TestCase):
    def test_missing_budget_stops_before_fresh_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);ledger=root/'ledger.json';ledger.write_text('[]')
            with patch.object(m.base,'ROOT',root),patch.object(m.base,'LEDGER',ledger),patch.object(m.base,'setup',side_effect=AssertionError('must_not_prepare')) as fresh:
                with self.assertRaises(AssertionError):m.base.one({'id':'case'},'improved')
                fresh.assert_not_called()

    def test_failed_start_needs_a_reviewed_recovery_and_then_uses_fresh_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);ledger=root/'ledger.json';old={'id':'failed-id','label':'comparison-case-improved','channel':m.CHANNEL,'success':False,'api_equivalent_usd':.01};ledger.write_text(json.dumps([old]));(root/'budget-proposal.json').write_text(json.dumps({'approved_cumulative_cap':m.CAP,'approved_api_equivalent_usd':m.LIMIT}))
            with patch.object(m.base,'ROOT',root),patch.object(m.base,'LEDGER',ledger),patch.object(m.base,'setup',side_effect=RuntimeError('fresh_setup_reached')):
                with self.assertRaisesRegex(RuntimeError,'failure_requires_diagnosis'):m.base.one({'id':'case'},'improved')
                (root/'recoveries.json').write_text(json.dumps({'failed-id':'Diagnosed native rejection; retry the same approved scope and retain the failed cost.'}))
                with self.assertRaisesRegex(RuntimeError,'fresh_setup_reached'):m.base.one({'id':'case'},'improved')


if __name__=='__main__':unittest.main()
