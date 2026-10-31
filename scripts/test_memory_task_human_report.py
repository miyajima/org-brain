import importlib.util
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('human_report',Path(__file__).with_name('memory-task-human-report.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class HumanEvidenceTests(unittest.TestCase):
    def test_a_different_human_choice_is_not_adoption_of_the_fixed_branch(self):
        decision={'digest':'bound','active_ms':1000,'rework_ms':0,'value':'full','complete':True}
        self.assertFalse(m.human_answer_matches(decision,'bound','delta'))
        self.assertTrue(m.human_answer_matches({**decision,'value':'delta'},'bound','delta'))
        self.assertFalse(m.human_answer_matches({**decision,'value':'delta'},'changed','delta'))

    def test_unknown_external_work_is_not_zero_and_negative_timing_rejected(self):
        self.assertIsNone(m.human_total({'active_ms':1000,'rework_ms':None}))
        self.assertEqual(m.human_total({'active_ms':1000,'rework_ms':0}),1000)
        self.assertIsNone(m.human_total({'active_ms':-1,'rework_ms':0}))

    def test_delta_preserves_prior_text_and_rejects_changes_to_retained_units(self):
        state={'requested_units':['a','b','c'],'allowed_units':['c'],'choice':'delta','prior':{'sections':{'a':"'quoted'",'b':'unchanged'}}}
        inp={'op':'patch','units':['c'],'sections':{'c':'new'}}
        self.assertEqual(m.effective_sections(state,inp),{'a':"'quoted'",'b':'unchanged','c':'new'})
        for bad in [{**inp,'sections':{'a':'altered','c':'new'}},{**inp,'op':'write'}]:
            with self.assertRaises(ValueError):m.effective_sections(state,bad)


if __name__=='__main__':unittest.main()
