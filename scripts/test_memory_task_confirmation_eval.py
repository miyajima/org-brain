import importlib.util,unittest
from pathlib import Path
class AccountingTest(unittest.TestCase):
 def setUp(self):
  s=importlib.util.spec_from_file_location('task_eval',Path(__file__).with_name('memory-task-confirmation-eval.py'));self.m=importlib.util.module_from_spec(s);s.loader.exec_module(self.m)
 def test_whole_call_model_usage_includes_a_budget_crossing_response(self):
  r={'modelUsage':{self.m.MODEL:{'inputTokens':1,'cacheCreationInputTokens':2,'cacheReadInputTokens':3,'outputTokens':4}},'usage':{'input_tokens':0,'output_tokens':1},'total_cost_usd':0.01}
  tokens,usage=self.m.accounting(r);self.assertEqual(tokens,10);self.assertEqual(usage['output_tokens'],4)
 def test_missing_usage_is_not_zero(self):
  self.assertEqual(self.m.accounting({'modelUsage':{self.m.MODEL:{'inputTokens':0}}}),(None,None))
if __name__=='__main__':unittest.main()
