#!/usr/bin/env python3
"""Same-harness HTTP bridge for the Mem0 OSS Memory implementation.

The bridge deliberately uses Mem0's own embedded Qdrant vector store and
FastEmbed implementation. It maps OrgBrain tenant IDs to Mem0 user IDs, but it
does not add record ACL filtering that Mem0 did not perform itself.
"""

from __future__ import annotations

import gc
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


MEM0_ROOT = os.environ.get("MEM0_ROOT")
if not MEM0_ROOT:
    raise RuntimeError("MEM0_ROOT is required")

sys.path.insert(0, str(Path(MEM0_ROOT).resolve()))
os.environ.setdefault("MEM0_TELEMETRY", "false")

from mem0 import Memory  # noqa: E402


PORT = int(os.environ.get("PORT", "8790"))
EMBED_MODEL = os.environ.get("MEM0_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
EMBED_DIMS = int(os.environ.get("MEM0_EMBED_DIMS", "384"))
EXTRACTOR_MODEL = os.environ.get("MEM0_EXTRACTOR_MODEL", "gemini-3.5-flash-lite")

memory: Memory | None = None
run_directory: tempfile.TemporaryDirectory[str] | None = None
records_by_mem0_id: dict[str, dict[str, Any]] = {}


def build_memory() -> Memory:
    global run_directory
    run_directory = tempfile.TemporaryDirectory(prefix="orgbrain-mem0-benchmark-")
    root = Path(run_directory.name)
    return Memory.from_config(
        {
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": "competitive_memory_v1",
                    "path": str(root / "qdrant"),
                    "embedding_model_dims": EMBED_DIMS,
                    "on_disk": False,
                },
            },
            "embedder": {
                "provider": "fastembed",
                "config": {
                    "model": EMBED_MODEL,
                    "embedding_dims": EMBED_DIMS,
                },
            },
            # competitive-memory-v1 captures with infer=False, so this model is
            # declared for the fixed extractor boundary but is never called.
            "llm": {
                "provider": "gemini",
                "config": {
                    "model": EXTRACTOR_MODEL,
                    "api_key": os.environ.get("GEMINI_API_KEY"),
                },
            },
            "history_db_path": str(root / "history.sqlite"),
        }
    )


def reset_memory() -> None:
    global memory, run_directory, records_by_mem0_id
    memory = None
    records_by_mem0_id = {}
    gc.collect()
    if run_directory is not None:
        run_directory.cleanup()
        run_directory = None
    memory = build_memory()


def capture(record: dict[str, Any]) -> dict[str, Any]:
    if memory is None:
        reset_memory()
    assert memory is not None
    tenant_id = str(record.get("tenant_id") or "default")
    content = str(record.get("content") or record.get("summary") or "")
    result = memory.add(
        [{"role": "user", "content": content}],
        user_id=tenant_id,
        metadata={
            "benchmark_id": str(record.get("id") or record.get("external_key") or ""),
            "project_id": record.get("project_id"),
            "kind": record.get("kind"),
        },
        infer=False,
    )
    rows = result.get("results") or []
    for row in rows:
        mem0_id = str(row.get("id") or "")
        if mem0_id:
            records_by_mem0_id[mem0_id] = dict(record)
    return {"id": str(record.get("id") or ""), "mem0_ids": [row.get("id") for row in rows]}


def search(query: dict[str, Any]) -> dict[str, Any]:
    if memory is None:
        reset_memory()
    assert memory is not None
    tenant_id = str(query.get("tenant_id") or "default")
    limit = max(1, int(query.get("limit") or 5))
    response = memory.search(
        str(query.get("query") or ""),
        top_k=limit,
        filters={"user_id": tenant_id},
        threshold=0,
    )
    results = []
    for row in response.get("results") or []:
        mem0_id = str(row.get("id") or "")
        record = records_by_mem0_id.get(mem0_id)
        if record is None:
            continue
        results.append({"memory": record, "score": row.get("score")})
    return {
        "results": results,
        "usage": {"turns": 1, "cost_usd": 0},
        "meta": {
            "provider": "mem0",
            "embedder": EMBED_MODEL,
            "extractor": EXTRACTOR_MODEL,
            "inference_enabled": False,
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
    print(f"mem0 benchmark bridge listening on 127.0.0.1:{PORT}", flush=True)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        memory = None
        gc.collect()
        if run_directory is not None:
            run_directory.cleanup()
