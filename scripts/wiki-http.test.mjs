import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WikiService } from "../packages/orgbrain-cli/src/lib/wiki-service.mjs";
import { createWikiHttpHandler } from "../packages/orgbrain-cli/src/lib/wiki-http.mjs";

test("Malformed multibyte CSRF tokens return 403 without throwing", async () => {
  const handler = createWikiHttpHandler({ config: "/unused/features.json" });
  let status;
  const response = {
    writeHead(value) {
      status = value;
    },
    end() {},
  };
  const handled = await handler(
    {
      url: "/api/v1/features/llm-wiki",
      method: "POST",
      socket: {
        localPort: 8788,
        localAddress: "127.0.0.1",
        remoteAddress: "127.0.0.1",
      },
      headers: {
        host: "127.0.0.1:8788",
        origin: "http://127.0.0.1:8788",
        "x-wiki-csrf": "é".repeat(64),
      },
    },
    response,
  );
  assert.equal(handled, true);
  assert.equal(status, 403);
});

test("Local Wiki HTTP guards Host/Origin and feature state without touching external Wiki", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "wiki-http-")));
  const service = new WikiService({
    config: join(home, "features.json"),
    root: join(home, "wiki"),
  });
  const handler = createWikiHttpHandler(service);
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await (
      await fetch(`${origin}/api/v1/features/llm-wiki`)
    ).json();
    assert.equal(initial.enabled, false);
    assert.equal(
      await new Promise((resolve, reject) => {
        get(
          `${origin}/api/v1/features/llm-wiki`,
          { headers: { host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      }),
      403,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/v1/features/llm-wiki`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
            "x-wiki-csrf": initial.csrf,
          },
          body: '{"enabled":true}',
        })
      ).status,
      403,
    );
    const toggle = async (enabled) =>
      fetch(`${origin}/api/v1/features/llm-wiki`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-wiki-csrf": initial.csrf,
        },
        body: JSON.stringify({ enabled }),
      });
    assert.equal((await toggle(true)).status, 200);
    const request = async (input) =>
      fetch(`${origin}/api/v1/wiki/request`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-wiki-csrf": initial.csrf,
        },
        body: JSON.stringify(input),
      });
    assert.equal((await request({ op: "init" })).status, 200);
    const saved = await (
      await request({ op: "put", path: "test.md", content: "# Test\nEvidence" })
    ).json();
    assert.ok(saved.page_id);
    await toggle(false);
    const blocked = await request({
      op: "put",
      page_id: saved.page_id,
      expected_hash: saved.hash,
      content: "changed",
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, "feature_disabled");
    await toggle(true);
    assert.equal(
      (await (await request({ op: "read", page_id: saved.page_id })).json())
        .hash,
      saved.hash,
    );
    assert.equal(
      (await request({ op: "migrate", from: "/private/vault" })).status,
      400,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
