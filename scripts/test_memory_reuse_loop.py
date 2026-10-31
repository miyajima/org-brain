import importlib.util, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('loop',Path(__file__).with_name('memory-reuse-loop.py'))
loop=importlib.util.module_from_spec(spec);spec.loader.exec_module(loop)
class NativeArguments(unittest.TestCase):
 def test_known_scalar_assignments_and_two_invocations(self):
  cmd=f'A={loop.NODE}; S={loop.ADAPTER}; D={loop.ROOT}; $A $S api $D task \'{{"op":"index"}}\'; $A $S api $D task \'{{"op":"read","document":"queue.json"}}\''
  self.assertEqual(loop.native_adapter_arguments(cmd,'task'),[{'op':'index'},{'op':'read','document':'queue.json'}])
 def test_quoted_commands_and_foreign_scope_are_not_execution(self):
  self.assertEqual(loop.native_adapter_arguments('echo "quoted command"','task'),[])
  self.assertEqual(loop.native_adapter_arguments(f'{loop.NODE} {loop.ADAPTER} api {loop.ROOT} other \'{{"op":"index"}}\'','task'),[])
 def test_provider_tokens_include_all_input_categories_and_output_once(self):
  self.assertEqual(loop.provider_tokens({'input_tokens':1,'cache_creation_input_tokens':2,'cache_read_input_tokens':3,'output_tokens':4,'output_tokens_details':{'thinking_tokens':2}}),10)
  self.assertEqual(loop.provider_tokens(dict.fromkeys(['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens'],0)),0)
 def test_missing_and_invalid_usage_is_unknown(self):
  for value in [None,{}, {'input_tokens':False,'cache_creation_input_tokens':0,'cache_read_input_tokens':0,'output_tokens':0}]:self.assertIsNone(loop.provider_tokens(value))
if __name__=='__main__':unittest.main()
