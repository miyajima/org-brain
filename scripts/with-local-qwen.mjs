#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:net";

const MODEL = process.env.ORGBRAIN_LOCAL_EMBEDDING_MODEL || "qwen3-embedding:0.6b";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForReady(endpoint, child, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`ollama serve exited before readiness\n${logs.join("").slice(-8_000)}`);
    }
    try {
      const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`ollama serve readiness timeout\n${logs.join("").slice(-8_000)}`);
}

async function modelInstalled(endpoint, model) {
  const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`ollama tags returned ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.models) && body.models.some((entry) =>
    entry?.name === model || entry?.model === model
  );
}

async function run(command, args, env) {
  const child = spawn(command, args, { env, stdio: "inherit", shell: false });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
  });
  if (code !== 0) throw new Error(`${command} exited with status ${code}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000, "timeout");
    timer.unref();
  });
  if (await Promise.race([exited, timeout]) === "timeout" && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function main() {
  const delimiter = process.argv.indexOf("--");
  const command = delimiter >= 0 ? process.argv[delimiter + 1] : "node";
  const args = delimiter >= 0
    ? process.argv.slice(delimiter + 2)
    : ["--test", "scripts/local-qwen-embedding.test.mjs"];
  if (!command) throw new Error("with-local-qwen requires a command after --");

  const port = await availablePort();
  const host = `127.0.0.1:${port}`;
  const endpoint = `http://${host}`;
  const env = {
    ...process.env,
    OLLAMA_HOST: host,
    OLLAMA_NO_CLOUD: "1",
    ORGBRAIN_LOCAL_EMBEDDING_PROVIDER: "qwen-ollama",
    ORGBRAIN_LOCAL_EMBEDDING_URL: endpoint,
    ORGBRAIN_LOCAL_EMBEDDING_MODEL: MODEL,
    ORGBRAIN_LOCAL_EMBEDDING_DIMENSIONS: "1024"
  };
  const logs = [];
  const server = spawn("ollama", ["serve"], { env, stdio: ["ignore", "pipe", "pipe"], shell: false });
  server.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  server.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  const onSignal = async (signal) => {
    await stop(server);
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await waitForReady(endpoint, server, logs);
    if (!(await modelInstalled(endpoint, MODEL))) {
      await run("ollama", ["pull", MODEL], env);
    }
    await run(command, args, env);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stop(server);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
