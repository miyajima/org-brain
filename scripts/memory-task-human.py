"""Loopback-only human measurement. No models, cloud writes or synthetic answers."""
import argparse
import hashlib
import json
import math
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import RLock


def net_effect(*, baseline_ms, reuse_ms, creation_ms, baseline_human_ms, reuse_human_ms):
    baseline = None if baseline_human_ms is None else baseline_ms + baseline_human_ms
    reuse = None if reuse_human_ms is None else reuse_ms + creation_ms + reuse_human_ms
    return {'baseline_total_ms': baseline, 'reuse_total_ms': reuse, 'saved_ms': None if baseline is None or reuse is None else baseline-reuse}


class Study:
    def __init__(self, directory, cards, clock=time.monotonic):
        self.directory, self.cards, self.clock, self.lock = Path(directory), {x['id']: x for x in cards}, clock, RLock()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory/'human-records.json'
        self.records = json.loads(self.path.read_text()) if self.path.exists() else {}
        for value in self.records.values():
            if not value.get('complete'):
                value.update(interrupted=True, active_ms=None, running=False)
        self.persist()

    def persist(self):
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.records, ensure_ascii=False, indent=2)+'\n')
        temporary.chmod(0o600)
        temporary.replace(self.path)

    def event(self, event):
        with self.lock:
            key = event.get('id')
            card = self.cards.get(key)
            if not card or event.get('digest') != card['digest']:
                raise ValueError('card_binding_mismatch')
            action, now = event.get('action'), self.clock()
            record = self.records.get(key)
            if record and record.get('complete'):
                raise ValueError('answer_already_recorded')
            if action == 'skip':
                record = {'id': key, 'digest': card['digest'], 'stage': card['stage'], 'complete': True, 'skipped': True, 'active_ms': None, 'elapsed_ms': None, 'value': None, 'timing_source': 'missing'}
            elif action == 'start':
                if record:
                    raise ValueError('already_started')
                # Only one card may accrue attention time at once.
                if any(x.get('running') for x in self.records.values()):
                    raise ValueError('another_card_is_running')
                record = {'id': key, 'digest': card['digest'], 'stage': card['stage'], 'start_clock': now, 'last_clock': now, 'active_ms': 0, 'running': True, 'complete': False, 'interrupted': False, 'timing_source': 'user_start_pause_stop_with_page_focus'}
            else:
                if not record or record.get('interrupted'):
                    raise ValueError('unstarted_or_interrupted_timing')
                if record['running']:
                    record['active_ms'] += max(0, now-record['last_clock'])*1000
                record['last_clock'] = now
                if action == 'interrupt':
                    record.update(running=False, interrupted=True, active_ms=None)
                elif action == 'pause':
                    record['running'] = False
                elif action == 'resume':
                    if record['running'] or any(x.get('running') for k,x in self.records.items() if k != key):
                        raise ValueError('invalid_resume')
                    record['running'] = True
                elif action == 'answer':
                    if event.get('value') not in card['allowed']:
                        raise ValueError('unapproved_answer')
                    repair = event.get('rework_seconds')
                    if repair is not None and (type(repair) not in (int,float) or not math.isfinite(repair) or repair < 0):
                        raise ValueError('invalid_rework_time')
                    record.update(running=False, complete=True, value=event['value'], elapsed_ms=max(0,now-record['start_clock'])*1000, notes=str(event.get('notes',''))[:2000], rework_ms=None if repair is None else repair*1000, rework_source=None if repair is None else 'self_reported', recorded_at=time.time())
                else:
                    raise ValueError('unknown_event')
            self.records[key] = record
            self.persist()
            with (self.directory/'human-events.jsonl').open('a') as f:
                f.write(json.dumps({'id': key, 'digest': card['digest'], 'action': action, 'stage': card['stage'], 'clock': now, 'active_ms': record['active_ms'], 'value': record.get('value')}, ensure_ascii=False)+'\n')
            return dict(record)


def serve(root, port=0):
    data = json.loads((root/'human-cards.json').read_text())
    study = Study(root/'human', data['cards'])
    template = Path(__file__).with_suffix('.html').read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, body, kind='application/json; charset=utf-8'):
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode())

        def valid_host(self):
            return self.headers.get('Host') == '127.0.0.1:'+str(self.server.server_port)

        def do_GET(self):
            if not self.valid_host():
                return self.reply(403, {'error': 'loopback_host_required'})
            if self.path == '/':
                return self.reply(200, template, 'text/html; charset=utf-8')
            if self.path == '/data':
                return self.reply(200, {**data, 'records': study.records})
            self.reply(404, {'error': 'not_found'})

        def do_POST(self):
            origin = 'http://127.0.0.1:'+str(self.server.server_port)
            if not self.valid_host() or self.headers.get('Origin') != origin or self.path != '/event':
                return self.reply(403, {'error': 'same_origin_only'})
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > 16384:
                    raise ValueError('event_size_limit')
                event = json.loads(self.rfile.read(length))
                result = study.event(event)
                self.reply(200, result)
            except (ValueError, TypeError, KeyError) as error:
                self.reply(400, {'error': str(error)})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    address = {'url': 'http://127.0.0.1:'+str(server.server_port), 'purpose': 'controlled_human_evaluation', 'model_starts': 0, 'cloud_deploy': False, 'cards_digest': hashlib.sha256((root/'human-cards.json').read_bytes()).hexdigest()}
    (root/'human-server.json').write_text(json.dumps(address, indent=2)+'\n')
    print(json.dumps(address), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--port', type=int, default=0)
    args = p.parse_args()
    serve(args.root.resolve(), args.port)
