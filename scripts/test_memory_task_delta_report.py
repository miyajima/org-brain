import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('delta_report',Path(__file__).with_name('memory-task-delta-report.py'));report=importlib.util.module_from_spec(spec);spec.loader.exec_module(report)

class LocalEvidenceTests(unittest.TestCase):
 def test_host_read_and_native_patch_expand_to_exact_backend_operations(self):
  state={'requested_units':['a','b','c'],'allowed_units':['c'],'prior':{'sections':{'a':'old A','b':'old B'}}}
  request={'op':'patch','units':['c'],'sections':{'c':'new C'}}
  self.assertEqual(report.materialize(state,request),{'op':'write','units':['a','b','c'],'sections':{'a':'old A','b':'old B','c':'new C'}})
  with self.assertRaises(ValueError):report.materialize(state,{'op':'patch','units':['a','c'],'sections':{'a':'changed','c':'new C'}})

 def test_host_source_requires_real_backend_result_and_actual_delivered_context(self):
  source={'input':{'op':'read','units':['c']},'output':{'ok':True,'source_sections':{'c':'new C'}},'field':'source_sections','source_fingerprint':'fp'}
  source['digest']=report.js_digest({k:source[k] for k in ['input','output','field','source_fingerprint']})
  state={'source_fingerprint':'fp','allowed_units':['c'],'local':{'source':source,'delivered_digest':report.js_digest('provided source')}}
  backend={'args':source['input'],'result':source['output']}
  self.assertTrue(report.context_verified(state,'provided source',backend))
  self.assertFalse(report.context_verified(state,'different source',backend))
  self.assertFalse(report.context_verified(state,'provided source',{'args':source['input'],'result':{'ok':True,'source_sections':{'c':'forged'}}}))

if __name__=='__main__':unittest.main()
