import importlib.util,unittest
from pathlib import Path
class ReportTest(unittest.TestCase):
 def test_only_complete_current_pairs_are_compared_and_missing_cost_stays_missing(self):
  s=importlib.util.spec_from_file_location('report',Path(__file__).with_name('memory-reuse-resolution-report.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
  records=[{'case':c,'condition':arm,'phase':'resolution','status':'observed','prompt_revision':2} for c in [1,2] for arm in ['none','knowledge','results']]
  records[0]['phase']='preparation';self.assertEqual(m.paired_cases(records),[2]);self.assertIsNone(m.total([{'cost':None}], 'cost'));self.assertEqual(m.total([{'cost':0}], 'cost'),0)
if __name__=='__main__':unittest.main()
