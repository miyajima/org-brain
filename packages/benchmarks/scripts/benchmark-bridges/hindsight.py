#!/usr/bin/env python3
"""Same-harness bridge for a pinned Hindsight OSS server.

The bridge calls Hindsight's native retain/recall API. Tenant IDs map to
independent Hindsight banks. It does not synthesize record-level ACL behavior.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


HINDSIGHT_ROOT = os.environ.get("HINDSIGHT_ROOT")
if not HINDSIGHT_ROOT:
    raise RuntimeError("HINDSIGHT_ROOT is required")

root = Path(HINDSIGHT_ROOT).resolve()
sys.path.insert(0, str(root / "hindsight-clients" / "python"))

from hindsight_client import Hindsight  # noqa: E402


PORT = int(os.environ.get("PORT", "8792"))
BASE_URL = os.environ.get("HINDSIGHT_API_URL", "http://127.0.0.1:8888")
API_KEY = os.environ.get("HINDSIGHT_API_KEY")
REVISION = os.environ.get(
    "HINDSIGHT_REVISION", "a90f9223765af3c8ad5692ce2b9fa22efbb656ba"
)
RECALL_BUDGET = os.environ.get("HINDSIGHT_RECALL_BUDGET", "mid")
INGEST_MODEL = os.environ.get("HINDSIGHT_API_LLM_MODEL", "gemini-3.5-flash-lite")

client = Hindsight(base_url=BASE_URL, api_key=API_KEY)
generation = 0
active_banks: set[str] = set()
records_by_document: dict[tuple[str, str], dict[str, Any]] = {}


def tenant_bank(tenant_id: str) -> str:
    digest = hashlib.sha256(tenant_id.encode("utf-8")).hexdigest()[:16]
    return f"orgbrain-competitive-{os.getpid()}-{generation}-{digest}"


def reset_memory() -> None:
    global generation, active_banks, records_by_document
    for bank_id in active_banks:
        try:
            client.delete_bank(bank_id)
        except Exception:
            pass
    generation += 1
    active_banks = set()
    records_by_document = {}


def event_time(record: dict[str, Any]) -> datetime | None:
    raw = record.get("created_at")
    if not isinstance(raw, (int, float)):
        return None
    return datetime.fromtimestamp(raw / 1000, tz=timezone.utc)


def capture(record: dict[str, Any]) -> dict[str, Any]:
    tenant_id = str(record.get("tenant_id") or "default")
    bank_id = tenant_bank(tenant_id)
    active_banks.add(bank_id)
    document_id = str(record.get("id") or record.get("external_key") or "")
    content = str(record.get("content") or record.get("summary") or "")
    metadata = {
        "benchmark_id": document_id,
        "project_id": str(record.get("project_id") or ""),
        "kind": str(record.get("kind") or "memory"),
    }
    client.retain(
        bank_id=bank_id,
        content=content,
        timestamp=event_time(record),
        context=str(record.get("summary") or "") or None,
        document_id=document_id,
        metadata=metadata,
        tags=[str(tag) for tag in record.get("tags") or []],
    )
    records_by_document[(bank_id, document_id)] = dict(record)
    return {
        "id": document_id,
        "meta": {"provider": "hindsight", "revision": REVISION},
        "usage": {"ingest_cost_usd": None},
    }


def score_value(row: Any) -> float | None:
    scores = getattr(row, "scores", None)
    if scores is None:
        return None
    values = scores.model_dump(exclude_none=True) if hasattr(scores, "model_dump") else {}
    for key in ("final", "reranker", "semantic", "keyword"):
        if isinstance(values.get(key), (int, float)):
            return float(values[key])
    return None


def search(query: dict[str, Any]) -> dict[str, Any]:
    tenant_id = str(query.get("tenant_id") or "default")
    bank_id = tenant_bank(tenant_id)
    limit = max(1, min(50, int(query.get("limit") or 5)))
    at = query.get("at")
    query_timestamp = None
    if isinstance(at, (int, float)):
        query_timestamp = datetime.fromtimestamp(at / 1000, tz=timezone.utc).isoformat()
    response = client.recall(
        bank_id=bank_id,
        query=str(query.get("query") or ""),
        max_tokens=16000,
        budget=RECALL_BUDGET,
        query_timestamp=query_timestamp,
    )
    results = []
    for row in list(response.results)[:limit]:
        document_id = str(getattr(row, "document_id", "") or "")
        metadata = getattr(row, "metadata", None) or {}
        benchmark_id = document_id or str(metadata.get("benchmark_id") or "")
        record = records_by_document.get((bank_id, benchmark_id))
        if record is None:
            continue
        results.append({"memory": record, "score": score_value(row)})
    return {
        "results": results,
        "usage": {"turns": 1},
        "meta": {
            "provider": "hindsight",
            "revision": REVISION,
            "ingest_model": INGEST_MODEL,
            "recall_budget": RECALL_BUDGET,
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
    print(f"hindsight benchmark bridge listening on 127.0.0.1:{PORT}", flush=True)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        reset_memory()
