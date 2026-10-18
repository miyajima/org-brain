#!/usr/bin/env python3
"""Loopback-only, bounded Qwen3 cross-encoder. Never generates free-form text."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import sys
import subprocess
import signal
import threading
import time
from pathlib import Path

MODEL = "Qwen/Qwen3-Reranker-0.6B"
SCORING_VERSION = "memory-relevance-yes-no/v1"
PREFIX = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
INSTRUCTION = "Given a task or question, retrieve historical memories that directly help answer it or perform it. The memory must match the requested subject and conditions; a shared general topic alone is insufficient."


def yes_no_score(yes, no):
    if not math.isfinite(yes) or not math.isfinite(no):
        raise ValueError("invalid_logits")
    delta = yes - no
    return 1 / (1 + math.exp(-delta)) if delta >= 0 else math.exp(delta) / (1 + math.exp(delta))


def format_pair(query, document):
    def data(text):
        return text.replace("<|", "＜｜").replace("|>", "｜＞")
    return f"<Instruct>: {INSTRUCTION}\n<Query>: {data(query)}\n<Document>: {data(document)}"


def validate_request(value):
    if not isinstance(value, dict):
        raise ValueError("invalid_request")
    query, documents = value.get("query"), value.get("documents")
    if not isinstance(query, str) or not query.strip() or len(query) > 2000:
        raise ValueError("invalid_query")
    if not isinstance(documents, list) or not 1 <= len(documents) <= 50:
        raise ValueError("invalid_documents")
    ids = set()
    for row in documents:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not 1 <= len(row["id"]) <= 128:
            raise ValueError("invalid_document_id")
        if row["id"] in ids or not isinstance(row.get("text"), str) or not 1 <= len(row["text"]) <= 8000:
            raise ValueError("invalid_document")
        ids.add(row["id"])
    return query, documents


class Scorer:
    def __init__(self, manifest):
        import mlx.core as mx
        from mlx_lm import load
        self.mx = mx
        self.model, self.tokenizer = load(manifest["path"])
        self.prefix = self.tokenizer.encode(PREFIX, add_special_tokens=False)
        self.suffix = self.tokenizer.encode(SUFFIX, add_special_tokens=False)
        self.yes = self.tokenizer.encode("yes", add_special_tokens=False)
        self.no = self.tokenizer.encode("no", add_special_tokens=False)
        if len(self.yes) != 1 or len(self.no) != 1:
            raise ValueError("reranker_label_tokenization_changed")
        self.metadata = {"model": MODEL, "revision": manifest["revision"], "scoring_version": SCORING_VERSION,
                         "instruction_hash": hashlib.sha256(INSTRUCTION.encode()).hexdigest()}

    def score(self, query, documents):
        mx = self.mx
        scores = []
        for offset in range(0, len(documents), 4):
            batch = documents[offset:offset + 4]
            inputs = []
            for row in batch:
                body = self.tokenizer.encode(format_pair(query, row["text"]), add_special_tokens=False)
                inputs.append(self.prefix + body[:4096 - len(self.prefix) - len(self.suffix)] + self.suffix)
            width = max(map(len, inputs))
            tokens = mx.array([row + [self.tokenizer.pad_token_id or 0] * (width - len(row)) for row in inputs])
            # Right padding cannot affect a real token's causal attention. Project
            # only each row's final real state, avoiding a [B,L,vocab] allocation.
            hidden = self.model.model(tokens)
            last = hidden[mx.arange(len(inputs)), mx.array([len(row) - 1 for row in inputs]), :]
            logits = self.model.model.embed_tokens.as_linear(last) if self.model.args.tie_word_embeddings else self.model.lm_head(last)
            pairs = mx.stack([logits[:, self.yes[0]], logits[:, self.no[0]]], axis=1).astype(mx.float32)
            mx.eval(pairs)
            scores.extend({"id": row["id"], "score": yes_no_score(yes, no)}
                          for row, (yes, no) in zip(batch, pairs.tolist()))
        return {**self.metadata, "scores": scores}



class OneShotScorer:
    """Stdlib-only broker: a worker owns all model and GPU allocations."""
    def __init__(self, manifest, manifest_path, timeout=29, command=None):
        self.metadata = {"model": MODEL, "revision": manifest["revision"],
                         "scoring_version": SCORING_VERSION,
                         "instruction_hash": hashlib.sha256(INSTRUCTION.encode()).hexdigest()}
        self.command = command or [sys.executable, str(Path(__file__).resolve()),
                                   "--manifest", str(manifest_path), "--worker"]
        self.timeout = timeout
        self.busy = threading.Lock()
        self.lifecycle = threading.Lock()
        self.child = None
        self.closed = False

    def score(self, query, documents):
        if not self.busy.acquire(blocking=False):
            raise RuntimeError("reranker_busy")
        try:
            with self.lifecycle:
                if self.closed:
                    raise RuntimeError("reranker_closed")
                self.child = subprocess.Popen(self.command, text=True,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    env={**os.environ, "HF_HUB_OFFLINE": "1", "TOKENIZERS_PARALLELISM": "false",
                         "ORGBRAIN_RERANKER_PARENT_PID": str(os.getpid())})
                child = self.child
            try:
                stdout, _ = child.communicate(json.dumps({"query": query, "documents": documents}),
                                              timeout=self.timeout)
            except BaseException:
                child.kill()
                child.communicate()
                raise
            if child.returncode:
                raise RuntimeError("reranker_worker_failed")
            result = json.loads(stdout)
            if not isinstance(result, dict) or not isinstance(result.get("scores"), list):
                raise ValueError("invalid_worker_response")
            return result
        finally:
            with self.lifecycle:
                self.child = None
            self.busy.release()

    def close(self):
        with self.lifecycle:
            self.closed = True
            child = self.child
            if child is not None:
                child.kill()
                child.wait(timeout=5)



def worker(manifest):
    from contextlib import redirect_stdout
    expected_parent = int(os.environ.get("ORGBRAIN_RERANKER_PARENT_PID", os.getppid()))
    def watch_parent():
        while True:
            if os.getppid() != expected_parent:
                os._exit(1)
            time.sleep(.25)
    threading.Thread(target=watch_parent, daemon=True).start()
    started = time.perf_counter()
    query, documents = validate_request(json.loads(sys.stdin.buffer.read(256001)))
    # Third-party load diagnostics must never mix with the stdout JSON protocol.
    with redirect_stdout(sys.stderr):
        scorer = Scorer(manifest)
        loaded = time.perf_counter()
        result = scorer.score(query, documents)
        finished = time.perf_counter()
        result["runtime"] = {"python": sys.version.split()[0], "worker_pid": os.getpid(),
            "load_seconds": loaded - started, "score_seconds": finished - loaded,
            "mlx_active_bytes": scorer.mx.get_active_memory(),
            "mlx_cache_bytes": scorer.mx.get_cache_memory(),
            "mlx_peak_bytes": scorer.mx.get_peak_memory()}
    print(json.dumps(result), flush=True)


def make_server(scorer, port):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass

        def respond(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            self.respond(200, {"ready": True, "mode": "on-demand", "worker_active": scorer.busy.locked() if isinstance(scorer, OneShotScorer) else False, "python": sys.version.split()[0], **scorer.metadata}) if self.path == "/health" else self.respond(404, {"error": "not_found"})

        def do_POST(self):
            if self.path != "/rerank":
                return self.respond(404, {"error": "not_found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 256000:
                    return self.respond(413, {"error": "request_size"})
                query, documents = validate_request(json.loads(self.rfile.read(length)))
            except (ValueError, TypeError):
                return self.respond(400, {"error": "invalid_request"})
            try:
                self.respond(200, scorer.score(query, documents))
            except Exception:
                self.respond(503, {"error": "reranker_unavailable"})
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--port", type=int, default=11435)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--worker-timeout", type=float, default=29)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    if manifest.get("model") != MODEL or not manifest.get("revision") or not Path(manifest["path"]).is_dir():
        raise ValueError("invalid_model_manifest")
    if args.worker:
        return worker(manifest)
    if not 0 < args.worker_timeout <= 120:
        raise ValueError("invalid_worker_timeout")
    scorer = OneShotScorer(manifest, args.manifest, timeout=args.worker_timeout)

    server = make_server(scorer, args.port)
    print(json.dumps({"ready": True, "port": args.port, "mode": "on-demand", **scorer.metadata}), flush=True)
    def terminate(_signum, _frame):
        scorer.close()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        server.serve_forever()
    finally:
        scorer.close()
        server.server_close()


if __name__ == "__main__":
    main()
