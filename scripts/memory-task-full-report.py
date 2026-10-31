"""Offline native evidence audit and cost accounting; never launches a model."""
import hashlib
import importlib.util
import json
import re
import shlex
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROOT = REPO / 'artifacts/memory-task-full-20261031'
LEDGER = REPO / 'artifacts/memory-reuse-loop-20261026/attempts.json'
MODEL = 'claude-sonnet-5-5'
CHANNEL = 'task_full_v2'
spec = importlib.util.spec_from_file_location('previous_report', REPO / 'scripts/memory-task-project-report.py')
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
load, save, rows, sha, digest, token_usage = previous.load, previous.save, previous.rows, previous.sha, previous.digest, previous.token_usage


def decode_command(command, prefix, session):
    start = shlex.join(prefix)
    pattern = re.escape(start) + r" task '" + re.escape(session) + r"' <<'ORGBRAIN_TASK_SECTIONS'\n([^\0]*)\nORGBRAIN_TASK_SECTIONS\n?"
    match = re.fullmatch(pattern, command)
    if match:
        raw = match[1] + '\n'
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('section object required')
        return value, raw
    if command.startswith(start + " run '") and command.endswith("'"):
        raw = command[len(start + " run '"):-1].replace("'\\''", "'")
        if start + " run '" + raw.replace("'", "'\\''") + "'" == command:
            return json.loads(raw), None
    raise ValueError('unrecognized native command')


def verified_backend(private, native, call):
    if private.get('native_call_id') != call or private.get('output') != native or private.get('digest') != digest(native):
        raise ValueError('native output or call mismatch')
    if 'backend_output' in private:
        if private.get('backend_digest') != digest(private['backend_output']):
            raise ValueError('private backend mismatch')
        return private['backend_output']
    return native


def strict_sum(items, field):
    return sum(x[field] for x in items) if items and all(type(x.get(field)) in (int, float) for x in items) else None


def summarize(items):
    return {'starts': len(items), 'successful_starts': sum(bool(x.get('success')) for x in items), 'total_tokens': strict_sum(items, 'total_tokens'), 'machine_ms': strict_sum(items, 'total_ms'), 'api_equivalent_usd': strict_sum(items, 'api_equivalent_usd')}


def audit(a, seeds):
    d = ROOT / 'runs' / a['id']
    events, state, result, config = rows(d / 'events.jsonl'), load(d / 'state.json'), load(d / 'result.json'), load(d / 'config.json')
    tokens, usage = token_usage(result)
    init = next((x for x in events if x.get('subtype') == 'init'), {})
    checks = {'actual_model_four_bins': tokens is not None and tokens == a.get('total_tokens') and usage == a.get('usage'), 'model_effort_cli_tools': init.get('model') == MODEL and init.get('tools') == ['Bash'] and bool(init.get('claude_code_version')) and a['argv'][a['argv'].index('--effort')+1] == 'medium', 'test_isolation': config.get('observation_purpose') == 'test' and config.get('db_path', '').startswith(str(ROOT))}
    appended = a['argv'][a['argv'].index('--append-system-prompt')+1]
    marker = 'Project source envelope (host read, source data only): '
    packet = appended[appended.index(marker):]
    checks['complete_bound_source'] = previous.envelope_matches(packet, state, a['source_envelope_digest']) and state['local'].get('source_delivery') == 'cli_system_append' and state['local'].get('source_envelope_digest') == a['source_envelope_digest']
    natives = {b['id']: b for e in events if e.get('type') == 'assistant' for b in e.get('message', {}).get('content', []) if b.get('type') == 'tool_use'}
    outputs = {b['tool_use_id']: b for e in events if e.get('type') == 'user' for b in e.get('message', {}).get('content', []) if b.get('type') == 'tool_result'}
    denied, completed, errors = [], [], []
    for call, block in natives.items():
        try:
            out = outputs[call]
            if out.get('is_error'):
                meta = [m for e in events if e.get('type') == 'user' for m in e.get('tool_result_meta', []) if m.get('id') == call]
                assert any(m.get('non_execution_kind') == 'permission-rule' and m.get('permission_decision', {}).get('source') == 'hook' for m in meta)
                assert not any(x['native_call_id'] == call for x in state['operations'] + state['created_results'])
                denied.append(call)
                continue
            native = json.loads(out['content'])
            private = load(d / (native['reuse_invocation_id'] + '.json'))
            backend = verified_backend(private, native, call)
            assert block['name'] == 'Bash'
            prefix = [str(Path(config['action_adapters'][state['adapter']]['argv'][0])), str(REPO / 'scripts/memory-reuse-claude.mjs')]
            authored, raw = decode_command(block['input']['command'], prefix, state['session_id'])
            request = private['request']
            assert request['task_id'] == state['task_id'] == a['id'] and request['adapter'] == state['adapter'] and request['uses'] == []
            if raw is not None:
                assert private['request_protocol'] == {'kind': 'task_sections_stdin', 'raw_stdin': raw}
                assert authored == request['input']['sections']
            else:
                assert authored == request
            inp = request['input']
            assert inp['op'] == 'write' and inp['units'] == state['requested_units'] and set(inp['sections']) == set(state['allowed_units'])
            assert inp['sections'] == backend['artifact']['sections']
            artifact = backend['artifact']
            created = next(x for x in state['created_results'] if x['native_call_id'] == call)
            assert sha(REPO / artifact['path']) == artifact['sha256'] == native['artifact']['sha256'] == created['content_digest'] == sha(d / 'deliverable.md')
            assert private['scope'] == state['scope'] and private['work_source_fingerprint'] == state['source_fingerprint']
            completed.append(call)
        except (KeyError, ValueError, TypeError, AssertionError, FileNotFoundError) as e:
            errors.append({'call': call, 'error': type(e).__name__ + ':' + str(e)})
    checks['all_native_actions_accounted'] = not errors and len(completed) + len(denied) == len(natives)
    checks['completion_or_verified_no_execution'] = bool(completed) if a.get('success') else not completed and not state['created_results']
    checks['full_scope_no_original_memory_attribution'] = state['choice'] == 'full' and state['scope']['principal_id'] == 'local' and a.get('task_completion', {}).get('reused_units', []) == []
    if a['condition'] != 'none':
        prior = state['prior']
        checks['real_prior_provenance'] = prior['id'] in seeds and a['expected_prior_id'] == prior['id'] and sha(REPO / prior['path']) == prior['content_digest'] and all(sha(ROOT / 'originals' / x['path']) == x['sha256'] for x in prior['file_sources'])
        checks['selection_is_simulated'] = state.get('decision_source') == 'simulated_local_user' and state['local']['decision']['provenance'] == 'simulated_local_user'
    else:
        checks['no_memory_control'] = state.get('prior') is None and state['local']['condition'] == 'control'
    return {'id': a['id'], 'passed': all(checks.values()), 'checks': checks, 'errors': errors, 'cli_version': init.get('claude_code_version'), 'completed_calls': completed, 'verified_non_execution_denials': denied, 'delivered': bool(completed), 'raw_driver_success': a.get('success')}


def changes(value, base):
    return {k: (value[k]/base[k]-1)*100 if base.get(k) and value.get(k) is not None else None for k in ['total_tokens', 'machine_ms', 'api_equivalent_usd']}


def main():
    started = time.monotonic()
    ledger = load(LEDGER)
    attempts = [x for x in ledger if x.get('channel') == CHANNEL]
    seeds = {r['id'] for a in attempts if a['phase'] == 'seed' and a.get('success') for r in load(ROOT / 'runs' / a['id'] / 'state.json')['created_results']}
    audits = [audit(x, seeds) for x in attempts]
    save(ROOT / 'audit.json', audits)
    by_condition = {c: summarize([a for a in attempts if a['phase'] == 'comparison' and a['condition'] == c]) for c in ['none', 'current', 'improved']}
    pairs = []
    for case in load(ROOT / 'cases.json'):
        group = {}
        for c in by_condition:
            xs = [a for a in attempts if a['phase'] == 'comparison' and a['case'] == case['id'] and a['condition'] == c]
            group[c] = {**summarize(xs), 'eventually_completed': any(a.get('success') for a in xs), 'first_start_success': bool(xs and xs[0].get('success')), 'ids': [a['id'] for a in xs]}
        pairs.append({'case': case['id'], 'conditions': group, 'improved_vs_none_pct': changes(group['improved'], group['none'])})
    timings = {}
    for c in by_condition:
        xs = [a for a in attempts if a['phase'] == 'comparison' and a['condition'] == c]
        hosts = [load(ROOT / 'runs' / a['id'] / 'host.json') for a in xs]
        timings[c] = {'host_process_ms': strict_sum(xs, 'setup_ms'), 'offer_body_ms': strict_sum(hosts, 'offer_body_ms'), 'scripted_answer_body_ms': strict_sum(hosts, 'scripted_answer_body_ms'), 'source_body_ms': strict_sum(hosts, 'source_body_ms'), 'hooks_child_ms': {p: sum(a['phase_times_ms'][p] for a in xs) for p in ['context', 'pre', 'post', 'stop']}, 'bundle_body_ms': {p: sum(v[p] for a in xs for v in a['invocation_timings'] if v) for p in ['validation_ms', 'adapter_ms', 'helper_body_ms']}, 'cli_ms': strict_sum(xs, 'cli_ms'), 'api_ms': strict_sum(xs, 'api_ms'), 'harness_setup_ms_excluded': strict_sum(xs, 'harness_setup_ms')}
    report = {'model': MODEL, 'effort': 'medium', 'cumulative_starts': len(ledger), 'additional_starts': len(attempts), 'cumulative_limit': 461, 'usd_limit': 3.60, 'all_evaluation': summarize(attempts), 'preparation': summarize([x for x in attempts if x['phase'] == 'seed']), 'by_condition': by_condition, 'improved_vs_none_pct': changes(by_condition['improved'], by_condition['none']), 'improved_vs_current_spend_pct': changes(by_condition['improved'], by_condition['current']), 'current_is_equal_completed_workload': all(p['conditions']['current']['eventually_completed'] for p in pairs), 'pairs': pairs, 'timings': timings, 'failed_starts': [{k: a.get(k) for k in ['id', 'label', 'total_tokens', 'total_ms', 'api_equivalent_usd', 'recovery_from']} for a in attempts if not a.get('success')], 'audited_starts': len(audits), 'audit_passed': sum(a['passed'] for a in audits), 'audited_deliveries': sum(a['delivered'] for a in audits), 'cli_versions': sorted({a['cli_version'] for a in audits}), 'quality_review': load(ROOT / 'quality-review.json', {'status': 'pending'}), 'human': {'actual_active_ms': None, 'adoption_decisions': None, 'estimate_only': True, 'familiar_scan_seconds': [10, 20], 'unfamiliar_applicability_seconds': [45, 90], 'open_original_seconds': [120, 300], 'reading_study_mean_characters_per_minute': 653, 'study_url': 'https://www.jstage.jst.go.jp/article/itej/72/10/72_J154/_article/-char/ja/', 'scope_note': 'Normal prose reading study, not memory-adoption decision timing. Engineering estimates are not observed human time.'}, 'original_model_memory_read_claims': 0, 'reused_result_units_in_full': 0, 'organic_reuse': None, 'real_team_use': None, 'actual_billing_usd': None, 'parent_implementation_audit_cost': None, 'cloud_deployed': False, 'audit_ms': (time.monotonic()-started)*1000, 'overlap_note': 'Host phases nest within host_process. Bundle adapter and validation nest within helper body. Hook durations nest within CLI. Never add overlapping phases to total. CLI minus API is not pure tracking cost.'}
    common = [p for p in pairs if p['conditions']['current']['eventually_completed']]
    matched = {c: {k: sum(p['conditions'][c][k] for p in common) for k in ['total_tokens', 'machine_ms', 'api_equivalent_usd']} for c in ['current', 'improved']}
    report['completed_current_reference'] = {'n': len(common), **matched, 'improved_change_pct': changes(matched['improved'], matched['current']), 'selection_warning': 'Excludes incomplete current case; reference only, not all six workloads.'}
    report['usage_by_condition'] = {c: {k: sum(a['usage'][k] for a in attempts if a['phase'] == 'comparison' and a['condition'] == c) for k in ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']} for c in by_condition}
    report['confirmation_and_tracking_increment_vs_none'] = {'host_process_ms_per_task': (timings['improved']['host_process_ms']-timings['none']['host_process_ms'])/6, 'hook_child_ms_per_task': (sum(timings['improved']['hooks_child_ms'].values())-sum(timings['none']['hooks_child_ms'].values()))/6, 'classification': 'Observed phase differences including runtime variation; not a causal isolation of pure tracking.'}
    report['human']['machine_gain_seconds_per_task'] = (by_condition['none']['machine_ms']-by_condition['improved']['machine_ms'])/6000
    creation = report['preparation']
    allocated = {k: by_condition['improved'][k]+creation[k] for k in ['total_tokens', 'machine_ms', 'api_equivalent_usd']}
    report['reference_all_creation_allocated_to_six_full_tasks'] = {'values': allocated, 'change_vs_none_pct': changes(allocated, by_condition['none']), 'note': 'Allocation reference only. These full tasks do not reuse prior content. Do not infer creation payback or work avoided.'}
    report['validation'] = load(ROOT/'validation.json', {})
    report['adoption'] = load(ROOT/'adoption.json', {})
    save(ROOT / 'report.json', report)
    print(json.dumps({k: report[k] for k in ['cumulative_starts', 'additional_starts', 'all_evaluation', 'by_condition', 'improved_vs_none_pct', 'audit_passed', 'audited_starts', 'current_is_equal_completed_workload']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
