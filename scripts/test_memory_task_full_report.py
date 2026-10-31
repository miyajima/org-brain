import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('full_report', Path(__file__).with_name('memory-task-full-report.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class EvidenceTests(unittest.TestCase):
    def test_literal_shell_text_round_trip_and_command_boundaries(self):
        sections = {'start': "'quoted' `cmd` $(secret)\n次の行"}
        command = "/node /helper task 'session-1' <<'ORGBRAIN_TASK_SECTIONS'\n" + json.dumps(sections, ensure_ascii=False) + '\nORGBRAIN_TASK_SECTIONS'
        value, raw = report.decode_command(command, ['/node', '/helper'], 'session-1')
        self.assertEqual(value, sections)
        self.assertEqual(json.loads(raw), sections)
        for bad in [command + '\necho bypass', command.replace("<<'ORGBRAIN_TASK_SECTIONS'", '<<ORGBRAIN_TASK_SECTIONS'), command.replace("'session-1'", "'other'")]:
            with self.assertRaises(ValueError):
                report.decode_command(bad, ['/node', '/helper'], 'session-1')

    def test_compact_receipt_keeps_backend_and_native_proof(self):
        native = {'ok': True, 'artifact': {'path': 'a.md', 'sha256': 'hash'}, 'reuse_invocation_id': 'i', 'exit_code': 0}
        backend = {**native, 'artifact': {**native['artifact'], 'sections': {'a': 'text'}}}
        private = {'native_call_id': 'call-1', 'output': native, 'digest': report.digest(native), 'backend_output': backend, 'backend_digest': report.digest(backend)}
        self.assertEqual(report.verified_backend(private, native, 'call-1'), backend)
        for changed in [{**private, 'native_call_id': 'forged'}, {**private, 'backend_output': {**backend, 'ok': False}}, {**private, 'output': {**native, 'exit_code': 1}}]:
            with self.assertRaises(ValueError):
                report.verified_backend(changed, native, 'call-1')

    def test_missing_tokens_are_unknown_and_failed_attempt_cost_is_kept(self):
        self.assertEqual(report.token_usage({'modelUsage': {report.MODEL: {'inputTokens': 1}}}), (None, None))
        attempts = [{'success': False, 'total_tokens': 30, 'total_ms': 1000, 'api_equivalent_usd': .1}, {'success': True, 'total_tokens': 20, 'total_ms': 500, 'api_equivalent_usd': .05}]
        summary = report.summarize(attempts)
        self.assertEqual(summary['total_tokens'], 50)
        self.assertEqual(summary['machine_ms'], 1500)
        self.assertEqual(summary['successful_starts'], 1)
        self.assertIsNone(report.summarize([{'total_tokens': None}])['total_tokens'])


if __name__ == '__main__':
    unittest.main()
