import importlib.util,json,shlex,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('actions_eval',Path(__file__).with_name('memory-reuse-actions-eval.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class NativeBoundaryTests(unittest.TestCase):
 def test_direct_and_configured_wrapped_actions_are_actual_inputs_not_report_text(self):
  rid='claude:case';operation={'op':'apply','plan':{'target':'queue'}}
  direct=shlex.join([m.e.NODE,str(m.e.ADAPTER),'api',str(m.ROOT),rid,json.dumps(operation)])
  helper=m.ROOT/'runtime/r11/scripts/memory-reuse-claude.mjs'
  wrapped=shlex.join([m.e.NODE,str(helper),'run',json.dumps({'task_id':rid,'adapter':'plan','input':operation,'uses':['item']})])
  self.assertEqual(m.parsed_arguments(direct,rid),[operation]);self.assertEqual(m.parsed_arguments(wrapped,rid),[operation])
  self.assertEqual(m.parsed_arguments('echo '+shlex.quote(wrapped),rid),[])
 def test_unconfigured_wrapper_paths_are_not_treated_as_the_real_adapter(self):
  command=shlex.join([m.e.NODE,'/untrusted/scripts/memory-reuse-claude.mjs','run',json.dumps({'input':{'op':'apply'}})])
  self.assertEqual(m.parsed_arguments(command,'claude:case'),[])
if __name__=='__main__':unittest.main()
