#!/usr/bin/env python3
"""Same-harness bridge for pinned Mnemosyne OSS local memory."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


MNEMOSYNE_ROOT = os.environ.get("MNEMOSYNE_ROOT")
if not MNEMOSYNE_ROOT:
    raise RuntimeError("MNEMOSYNE_ROOT is required")

sys.path.insert(0, str(Path(MNEMOSYNE_ROOT).resolve()))
bootstrap_directory = tempfile.mkdtemp(prefix="orgbrain-mnemosyne-bootstrap-")
os.environ.setdefault("MNEMOSYNE_DATA_DIR", bootstrap_directory)
os.environ.setdefault("MNEMOSYNE_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
os.environ.setdefault("MNEMOSYNE_ENHANCED_RECALL", "0")

from mnemosyne import Mnemosyne  # noqa: E402


PORT = int(os.environ.get("PORT", "8793"))
REVISION = os.environ.get(
    "MNEMOSYNE_REVISION", "22c60e2af2335e05864dfc32b803d7bb6439ed62"
)
EMBED_MODEL = os.environ.get("MNEMOSYNE_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")

run_directory: str | None = None
stores: dict[str, Mnemosyne] = {}
records_by_id: dict[tuple[str, str], dict[str, Any]] = {}
records_by_content: dict[tuple[str, str], dict[str, Any]] = {}


def reset_memory() -> None:
    global run_directory, stores, records_by_id, records_by_content
    stores = {}
    records_by_id = {}
    records_by_content = {}
    if run_directory:
        shutil.rmtree(run_directory, ignore_errors=True)
    run_directory = tempfile.mkdtemp(prefix="orgbrain-mnemosyne-benchmark-")


def tenant_store(tenant_id: str) -> Mnemosyne:
    if tenant_id not in stores:
        assert run_directory is not None
        path = Path(run_directory) / f"tenant-{len(stores)}.sqlite"
        stores[tenant_id] = Mnemosyne(session_id=tenant_id, db_path=path)
    return stores[tenant_id]


def capture(record: dict[str, Any]) -> dict[str, Any]:
    tenant_id = str(record.get("tenant_id") or "default")
    store = tenant_store(tenant_id)
    benchmark_id = str(record.get("id") or record.get("external_key") or "")
    content = str(record.get("content") or record.get("summary") or "")
    memory_id = store.remember(
        content,
        source=str(record.get("kind") or "memory"),
        importance=float(record.get("utility_score") or 0.5),
        metadata={
            "benchmark_id": benchmark_id,
            "project_id": record.get("project_id"),
        },
        extract_entities=False,
        extract=False,
    )
    if memory_id:
        records_by_id[(tenant_id, str(memory_id))] = dict(record)
        records_by_content[(tenant_id, content)] = dict(record)
    return {
        "id": benchmark_id,
        "native_id": memory_id,
        "usage": {"cost_usd": 0},
        "meta": {"provider": "mnemosyne", "revision": REVISION},
    }


def search(query: dict[str, Any]) -> dict[str, Any]:
    tenant_id = str(query.get("tenant_id") or "default")
    store = tenant_store(tenant_id)
    limit = max(1, min(50, int(query.get("limit") or 5)))
    recalled = store.recall(str(query.get("query") or ""), top_k=limit)
    results = []
    for row in recalled:
        memory_id = str(row.get("id") or row.get("memory_id") or "")
        content = str(row.get("content") or row.get("text") or "")
        metadata = row.get("metadata") or {}
        benchmark_id = str(metadata.get("benchmark_id") or "") if isinstance(metadata, dict) else ""
        record = records_by_id.get((tenant_id, memory_id))
        if record is None and benchmark_id:
            record = next(
                (
                    value
                    for (candidate_tenant, _), value in records_by_id.items()
                    if candidate_tenant == tenant_id
                    and str(value.get("id") or value.get("external_key") or "") == benchmark_id
                ),
                None,
            )
        if record is None:
            record = records_by_content.get((tenant_id, content))
        if record is None:
            continue
        score = row.get("score")
        results.append({
            "memory": record,
            "score": float(score) if isinstance(score, (int, float)) else None,
        })
    return {
        "results": results,
        "usage": {"turns": 1, "cost_usd": 0},
        "meta": {
            "provider": "mnemosyne",
            "revision": REVISION,
            "embedder": EMBED_MODEL,
            "extraction_enabled": False,
        },
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, status: int, payload: Any) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self) -> None:  # noqa: N802
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path == "/reset":
                reset_memory()
                self.send_json(200, {"ok": True})
            elif self.path == "/capture":
                self.send_json(200, capture(payload.get("record") or {}))
            elif self.path == "/search":
                self.send_json(200, search(payload.get("query") or {}))
            elif self.path == "/capabilities":
                self.send_json(200, {})
            else:
                self.send_json(404, {"error": "not found"})
        except Exception as error:
            self.send_json(500, {"error": str(error)})


if __name__ == "__main__":
    reset_memory()
    print(f"mnemosyne benchmark bridge listening on 127.0.0.1:{PORT}", flush=True)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        reset_memory()
        shutil.rmtree(bootstrap_directory, ignore_errors=True)
