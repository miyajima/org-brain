import importlib.util,pathlib,unittest
spec=importlib.util.spec_from_file_location('connected',pathlib.Path(__file__).with_name('memory-reuse-connected.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class EvaluationBoundaryTests(unittest.TestCase):
 def test_hook_notification_text_and_quoted_calls_are_not_native_calls(self):
  native={'type':'tool_use','id':'actual','input':{'command':'real'}}
  events=[{'message':'hook notification'},{'message':{'content':'quoted tool_use'}},{'message':{'content':[{'type':'text','text':'quoted call'},native]}}]
  self.assertEqual(m.native_calls(events,set()),[native]);self.assertEqual(m.native_calls(events,{'actual'}),[])
 def test_missing_cost_is_unknown_while_reported_zero_remains_zero(self):
  self.assertIsNone(m.strict_total([{'cost':1},{}],'cost'))
  self.assertIsNone(m.strict_total([{'cost':float('nan')}],'cost'))
  self.assertEqual(m.strict_total([{'cost':0},{'cost':0}],'cost'),0)
if __name__=='__main__':unittest.main()
