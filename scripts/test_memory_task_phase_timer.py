import json,subprocess,sys,tempfile,unittest
from pathlib import Path
class PhaseTimerTest(unittest.TestCase):
 def test_forwarded_bytes_are_exact_and_log_does_not_contain_source(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);raw=json.dumps({'session_id':'s','cwd':str(root),'private_source':'do not retain source here'}).encode();script=Path(__file__).with_name('memory-task-phase-timer.py')
   p=subprocess.run([sys.executable,str(script),str(root),'context',sys.executable,'-c','import sys;sys.stdout.buffer.write(sys.stdin.buffer.read());sys.stderr.write("diagnostic")'],input=raw,capture_output=True)
   self.assertEqual(p.stdout,raw);self.assertEqual(p.stderr,b'diagnostic');self.assertEqual(p.returncode,0)
   text=(root/'.local/memory-reuse/phase-timing/s.jsonl').read_text();self.assertNotIn('private_source',text);self.assertNotIn('do not retain',text);self.assertGreaterEqual(json.loads(text)['child_process_ms'],0)
if __name__=='__main__':unittest.main()
