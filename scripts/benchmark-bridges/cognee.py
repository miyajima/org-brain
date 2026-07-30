#!/usr/bin/env python3
"""Product-path benchmark bridge for Cognee OSS.

Cognee requires its cognify pipeline before vector retrieval. The bridge runs
that pipeline once, lazily before the first search, with Gemini Flash-Lite at
ingest and FastEmbed for CHUNKS retrieval. Ingest cost is intentionally
reported as unknown rather than zero.
"""

from __future__ import annotations

import asyncio
import gc
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


COGNEE_ROOT = os.environ.get("COGNEE_ROOT")
if not COGNEE_ROOT:
    raise RuntimeError("COGNEE_ROOT is required")
if not os.environ.get("GEMINI_API_KEY"):
    raise RuntimeError("GEMINI_API_KEY is required for Cognee cognify")

sys.path.insert(0, str(Path(COGNEE_ROOT).resolve()))

PORT = int(os.environ.get("PORT", "8792"))
EXTRACTOR_MODEL = os.environ.get(
    "COGNEE_EXTRACTOR_MODEL", "gemini/gemini-3.5-flash-lite"
)
EMBED_MODEL = os.environ.get("COGNEE_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
EMBED_DIMS = int(os.environ.get("COGNEE_EMBED_DIMS", "384"))

os.environ["ENABLE_BACKEND_ACCESS_CONTROL"] = "false"
os.environ["CACHING"] = "false"
os.environ["LLM_PROVIDER"] = "gemini"
os.environ["LLM_MODEL"] = EXTRACTOR_MODEL
os.environ["LLM_API_KEY"] = os.environ["GEMINI_API_KEY"]
os.environ["LLM_TEMPERATURE"] = "0.0"
os.environ["EMBEDDING_PROVIDER"] = "fastembed"
os.environ["EMBEDDING_MODEL"] = EMBED_MODEL
os.environ["EMBEDDING_DIMENSIONS"] = str(EMBED_DIMS)

import cognee  # noqa: E402
from cognee import SearchType  # noqa: E402


loop = asyncio.new_event_loop()
run_directory: tempfile.TemporaryDirectory[str] | None = None
records_by_tenant: dict[str, list[dict[str, Any]]] = {}
datasets: set[str] = set()
indexed = False


def run(coroutine):
    return loop.run_until_complete(coroutine)


def configure_directories() -> None:
    assert run_directory is not None
    root = Path(run_directory.name)
    cognee.config.data_root_directory(str(root / "data"))
    cognee.config.system_root_directory(str(root / "system"))
    cognee.config.set_vector_db_provider("lancedb")
    cognee.config.set_embedding_config(
        {
            "embedding_provider": "fastembed",
            "embedding_model": EMBED_MODEL,
            "embedding_dimensions": EMBED_DIMS,
        }
    )
    cognee.config.set_llm_config(
        {
            "llm_provider": "gemini",
            "llm_model": EXTRACTOR_MODEL,
            "llm_api_key": os.environ["GEMINI_API_KEY"],
            "llm_temperature": 0.0,
        }
    )


async def reset_cognee() -> None:
    global run_directory, records_by_tenant, datasets, indexed
    try:
        await cognee.prune.prune_data()
        await cognee.prune.prune_system(metadata=True)
    except Exception:
        pass
    if run_directory is not None:
        run_directory.cleanup()
    run_directory = tempfile.TemporaryDirectory(prefix="orgbrain-cognee-benchmark-")
    records_by_tenant = {}
    datasets = set()
    indexed = False
    configure_directories()


async def capture(record: dict[str, Any]) -> dict[str, Any]:
    global indexed
    tenant_id = str(record.get("tenant_id") or "default")
    records_by_tenant.setdefault(tenant_id, []).append(dict(record))
    datasets.add(tenant_id)
    indexed = False
    return {"id": str(record.get("id") or "")}


async def ensure_indexed() -> None:
    global indexed
    if indexed:
        return
    for tenant_id, records in records_by_tenant.items():
        contents = [
            str(record.get("content") or record.get("summary") or "")
            for record in records
        ]
        await cognee.add(contents, dataset_name=tenant_id)
    await cognee.cognify(datasets=sorted(datasets))
    indexed = True


def text_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        preferred = value.get("text")
        values = [preferred] if isinstance(preferred, str) else []
        for nested in value.values():
            values.extend(text_values(nested))
        return values
    if isinstance(value, (list, tuple)):
        values = []
        for nested in value:
            values.extend(text_values(nested))
        return values
    if hasattr(value, "model_dump"):
        return text_values(value.model_dump())
    return []


async def search(query: dict[str, Any]) -> dict[str, Any]:
    await ensure_indexed()
    tenant_id = str(query.get("tenant_id") or "default")
    limit = max(1, int(query.get("limit") or 5))
    response = await cognee.search(
        query_text=str(query.get("query") or ""),
        query_type=SearchType.CHUNKS,
        datasets=[tenant_id],
        top_k=limit,
    )
    candidates = records_by_tenant.get(tenant_id, [])
    seen: set[str] = set()
    results = []
    for text in text_values(response):
        for record in candidates:
            record_id = str(record.get("id") or "")
            content = str(record.get("content") or record.get("summary") or "")
            if record_id not in seen and content and content in text:
                seen.add(record_id)
                results.append({"memory": record, "score": 0})
                break
        if len(results) >= limit:
            break
    return {
        "results": results,
        "usage": {"turns": 1, "cost_usd": None},
        "meta": {
            "provider": "cognee",
            "search_type": "CHUNKS",
            "embedder": EMBED_MODEL,
            "extractor": EXTRACTOR_MODEL,
            "ingest_cost_measured": False,
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
                run(reset_cognee())
                self.send_json(200, {"ok": True})
            elif self.path == "/capture":
                self.send_json(200, run(capture(payload.get("record") or {})))
            elif self.path == "/search":
                self.send_json(200, run(search(payload.get("query") or {})))
            elif self.path == "/capabilities":
                self.send_json(200, {})
            else:
                self.send_json(404, {"error": "not found"})
        except Exception as error:
            self.send_json(500, {"error": str(error)})


if __name__ == "__main__":
    run(reset_cognee())
    print(f"cognee benchmark bridge listening on 127.0.0.1:{PORT}", flush=True)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        gc.collect()
        if run_directory is not None:
            run_directory.cleanup()
        loop.close()
