import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('human_study', Path(__file__).with_name('memory-task-human.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class HumanTimingTests(unittest.TestCase):
    def make_study(self, directory):
        self.now = 100.0
        return m.Study(Path(directory), [{'id': 'case-1', 'digest': 'bound', 'stage': 'decision', 'allowed': ['existing', 'delta', 'full']}], clock=lambda: self.now)

    def test_pause_excludes_wait_and_answer_binds_displayed_card(self):
        with tempfile.TemporaryDirectory() as directory:
            s = self.make_study(directory)
            s.event({'id': 'case-1', 'digest': 'bound', 'action': 'start'})
            self.now += 5
            s.event({'id': 'case-1', 'digest': 'bound', 'action': 'pause'})
            self.now += 100
            s.event({'id': 'case-1', 'digest': 'bound', 'action': 'resume'})
            self.now += 3
            result = s.event({'id': 'case-1', 'digest': 'bound', 'action': 'answer', 'value': 'delta'})
            self.assertEqual(result['active_ms'], 8000)
            self.assertEqual(result['elapsed_ms'], 108000)
            self.assertEqual(result['value'], 'delta')
            with self.assertRaises(ValueError):
                s.event({'id': 'case-1', 'digest': 'bound', 'action': 'answer', 'value': 'existing'})

    def test_missing_and_interrupted_timing_are_not_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            s = self.make_study(directory)
            with self.assertRaises(ValueError):
                s.event({'id': 'case-1', 'digest': 'bound', 'action': 'answer', 'value': 'existing'})
            s.event({'id': 'case-1', 'digest': 'bound', 'action': 'skip'})
            self.assertIsNone(s.records['case-1']['active_ms'])
        with tempfile.TemporaryDirectory() as directory:
            s = self.make_study(directory)
            s.event({'id': 'case-1', 'digest': 'bound', 'action': 'start'})
            restarted = self.make_study(directory)
            self.assertTrue(restarted.records['case-1']['interrupted'])
            self.assertIsNone(restarted.records['case-1']['active_ms'])

    def test_wrong_card_and_unapproved_choice_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            s = self.make_study(directory)
            for event in [{'id': 'other', 'digest': 'bound', 'action': 'start'}, {'id': 'case-1', 'digest': 'tampered', 'action': 'start'}]:
                with self.assertRaises(ValueError):
                    s.event(event)
            s.event({'id': 'case-1', 'digest': 'bound', 'action': 'start'})
            with self.assertRaises(ValueError):
                s.event({'id': 'case-1', 'digest': 'bound', 'action': 'answer', 'value': 'invented'})

    def test_reload_does_not_turn_unobserved_gap_into_attention(self):
        with tempfile.TemporaryDirectory() as directory:
            s = self.make_study(directory)
            s.event({'id': 'case-1', 'digest': 'bound', 'action': 'start'})
            self.now += 100
            record = s.event({'id': 'case-1', 'digest': 'bound', 'action': 'interrupt'})
            self.assertIsNone(record['active_ms'])
            self.assertTrue(record['interrupted'])

    def test_creation_is_charged_once_and_missing_human_stays_missing(self):
        result = m.net_effect(baseline_ms=20000, reuse_ms=10000, creation_ms=4000, baseline_human_ms=5000, reuse_human_ms=7000)
        self.assertEqual(result['reuse_total_ms'], 21000)
        self.assertEqual(result['saved_ms'], 4000)
        result = m.net_effect(baseline_ms=20000, reuse_ms=10000, creation_ms=4000, baseline_human_ms=None, reuse_human_ms=7000)
        self.assertIsNone(result['saved_ms'])


if __name__ == '__main__':
    unittest.main()
