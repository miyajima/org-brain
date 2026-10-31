import importlib.util,json,pathlib,tempfile,unittest,sys,os
spec=importlib.util.spec_from_file_location('execution',pathlib.Path(__file__).with_name('claude_reuse_execution.py'));m=importlib.util.module_from_spec(spec)
class ExecutionTests(unittest.TestCase):
 def test_limit_blocks_a_new_process_and_preserves_ledger(self):
  spec.loader.exec_module(m)
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);ledger=p/'attempts.json';ledger.write_text('[{"id":"prior","status":"observed"}]')
   with self.assertRaisesRegex(RuntimeError,'budget_exhausted'):
    m.execute_cli([sys.executable,'-c',"raise Exception('must not run')"],'',p,os.environ,p/'run',ledger,{'id':'new'},1)
   self.assertEqual(len(json.loads(ledger.read_text())),1)
 def test_launch_is_reserved_before_process_start_and_failure_remains_counted(self):
  spec.loader.exec_module(m)
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d);ledger=p/'attempts.json';ledger.write_text('[]')
   code="import json,pathlib,sys; a=json.loads(pathlib.Path(sys.argv[1]).read_text()); assert a[-1]['status']=='started'; print('reserved'); sys.exit(3)"
   a={'id':'new','label':'unit-process-not-a-model'}
   records=m.execute_cli([sys.executable,'-c',code,str(ledger)],'',p,os.environ,p/'run',ledger,a,1)
   self.assertEqual(a['returncode'],3);self.assertEqual(len(records),1);self.assertEqual(records[0]['status'],'started')
   self.assertIn('reserved',(p/'run/events.jsonl').read_text())
if __name__=='__main__':unittest.main()
