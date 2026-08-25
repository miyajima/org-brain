#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalMemoryStore } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import {
  createLocalMcpHttpHandler,
  LOCAL_MCP_PROTOCOL_VERSION
} from "../packages/orgbrain-cli/src/local-mcp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// OrgBrain intentionally exposes only the tools capability. These official
// scenarios validate the production profile without requiring conformance-only
// prompt/resource/media fixtures. Use --full to audit the entire server suite.
const REQUIRED_SCENARIOS = ["tools-list", "dns-rebinding-protection"];

function parseArgs(argv) {
  const options = { scenarios: [...REQUIRED_SCENARIOS], full: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--full") {
      options.full = true;
      options.scenarios = [];
    } else if (arg === "--scenario") {
      const scenario = argv[index + 1];
      if (!scenario) throw new Error("--scenario requires a scenario name");
      options.scenarios = [scenario];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function startHttpServer(store) {
  const handler = createLocalMcpHttpHandler(store);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const url = new URL(incoming.url ?? "/", `http://127.0.0.1:${port}`);
      const body = incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : await readBody(incoming);
      const response = await handler.fetch(new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        body
      }));
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      process.stderr.write(`conformance bridge: ${error instanceof Error ? error.stack : String(error)}\n`);
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "text/plain; charset=utf-8");
      outgoing.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind conformance server");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function runConformance(url, scenario) {
  const args = ["exec", "conformance", "server", "--url", url];
  if (scenario) args.push("--scenario", scenario, "--spec-version", LOCAL_MCP_PROTOCOL_VERSION);
  else args.push("--requirements", LOCAL_MCP_PROTOCOL_VERSION);
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`conformance runner terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const fixtureDir = await mkdtemp(join(tmpdir(), "orgbrain-mcp-conformance-"));
const store = new LocalMemoryStore(join(fixtureDir, "memory.db"));
let server;
let exitCode = 0;
try {
  await store.init();
  server = await startHttpServer(store);
  const scenarios = options.full ? [undefined] : options.scenarios;
  for (const scenario of scenarios) {
    const code = await runConformance(server.url, scenario);
    if (code !== 0) exitCode = code;
  }
} finally {
  await server?.close();
  await rm(fixtureDir, { recursive: true, force: true });
}
process.exitCode = exitCode;
