#!/usr/bin/env node
import { DEFAULT_LOCAL_DB } from "../packages/orgbrain-cli/src/lib/local-memory-store.mjs";
import { drainJudgmentCapture, inspectJudgmentCapture, recoverJudgmentCapture } from "../packages/orgbrain-cli/src/lib/local-memory-judge-queue.mjs";

try {
  const [action, ...args] = process.argv.slice(2);
  const options = { dbPath: process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB, tenantId: "default" };
  const keys = { "--db": "dbPath", "--tenant": "tenantId", "--project": "projectId", "--id": "id" };
  for (let i = 0; i < args.length; i += 2) {
    if (!keys[args[i]] || !args[i + 1]) throw new Error("invalid_arguments");
    options[keys[args[i]]] = args[i + 1];
  }
  if (!options.projectId || !["status", "drain", "recover"].includes(action)) throw new Error("usage: status|drain|recover --project ID [--db PATH] [--tenant ID] [--id HELD_JOB]");
  const operation = action === "status" ? inspectJudgmentCapture : action === "drain" ? drainJudgmentCapture : recoverJudgmentCapture;
  console.log(JSON.stringify(await operation(options), null, 2));
} catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
