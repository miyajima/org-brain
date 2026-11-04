import importlib.util, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('report', Path(__file__).with_name('memory-task-confirmation-report.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

class AcceptanceTests(unittest.TestCase):
    def test_all_requested_facts_and_correct_profit_required(self):
        source = {'units': {'a': {'revenue': 120, 'cost': 80}}}
        self.assertTrue(report.accepts('analysis', ['a'], {'a': 'revenue=120, cost=80, profit=40'}, source))
        self.assertFalse(report.accepts('analysis', ['a'], {'a': 'revenue=120, cost=80, profit=41'}, source))
        self.assertFalse(report.accepts('analysis', ['a'], {}, source))

    def test_sentence_period_is_not_decimal_and_longer_numbers_fail(self):
        source = {'units': {'a': {'revenue': 120, 'cost': 80}}}
        self.assertTrue(report.accepts('analysis', ['a'], {'a':'revenue=120, cost=80, profit=40.'}, source))
        self.assertFalse(report.accepts('analysis', ['a'], {'a':'revenue=120, cost=80, profit=400.'}, source))
        self.assertFalse(report.accepts('analysis', ['a'], {'a':'revenue=120, cost=80, profit=40.5'}, source))

    def test_delta_must_preserve_existing_sections_and_scope(self):
        self.assertTrue(report.delta_valid(['a','b','c'], ['c'], {'a':'old','b':'kept'}, {'a':'old','b':'kept','c':'new'}, ['c']))
        self.assertFalse(report.delta_valid(['a','b','c'], ['c'], {'a':'old','b':'kept'}, {'a':'changed','b':'kept','c':'new'}, ['c']))
        self.assertFalse(report.delta_valid(['a','b','c'], ['c'], {'a':'old','b':'kept'}, {'a':'old','b':'kept','c':'new'}, ['a','c']))

if __name__ == '__main__': unittest.main()
