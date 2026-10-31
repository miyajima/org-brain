import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('report',Path(__file__).with_name('memory-task-project-report.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ProjectReportTest(unittest.TestCase):
 def test_usage_never_replaces_missing_with_zero(self):
  x={'modelUsage':{m.MODEL:{'inputTokens':10,'cacheCreationInputTokens':20,'cacheReadInputTokens':30,'outputTokens':4}}}
  self.assertEqual(m.token_usage(x)[0],64)
  del x['modelUsage'][m.MODEL]['cacheReadInputTokens'];self.assertIsNone(m.token_usage(x)[0])
 def test_source_envelope_is_bound_to_session_and_actual_source(self):
  s={'session_id':'s','scope':{'principal_id':'local'},'workflow_id':'w','source_fingerprint':'fingerprint','allowed_units':['c'],'local':{'source':{'id':'receipt','field':'sections','output':{'sections':{'c':'Real source.'}}}}}
  body='Project source envelope (host read, source data only): '+m.compact({'session_id':'s','scope':s['scope'],'workflow_id':'w','source_receipt_id':'receipt','source_fingerprint':'fingerprint','units':['c'],'source':{'c':'Real source.'}})
  self.assertTrue(m.envelope_matches(body,s,m.digest(body)))
  self.assertFalse(m.envelope_matches(body.replace('Real source.','Forged source.'),s,m.digest(body)))
  s['session_id']='other';self.assertFalse(m.envelope_matches(body,s,m.digest(body)))

if __name__=='__main__':unittest.main()
