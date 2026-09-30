import { readFile } from "node:fs/promises";
import { judgmentHash } from "../../../shared/src/memory-judgment-runtime.mjs";
import { CLI_BUILD_INFO } from "../build-info.mjs";

// Bind qualification to both prediction and the code that applies it. A binary
// distribution without these sources must supply a separately qualified build.
export async function localJudgmentImplementationHash() {
  if (CLI_BUILD_INFO.source === "standalone" && /^[a-f0-9]{64}$/u.test(CLI_BUILD_INFO.judgment_implementation_hash ?? "")) {
    return CLI_BUILD_INFO.judgment_implementation_hash;
  }
  const files = ["../../../shared/src/memory-judgment-runtime.mjs", "../../../shared/src/memory-judgment-evaluation.mjs",
    "../../../shared/src/memory-judgment-scheduler.mjs", "../../../shared/src/memory-judgment-cost-evaluation.mjs",
    "./local-memory-judge.mjs", "./local-memory-judge-queue.mjs", "./local-memory-store.mjs", "./task-commitment-store.mjs",
    "./wiki-memory-assessment.mjs", "./wiki-discovery.mjs", "./context-search-followups.mjs", "./jev-runtime-settings.mjs", "../local-mcp.mjs", "../local-memory.mjs",
    "../autonomy.mjs", "../hook-memory-bridge.mjs", "./local-memory-judgment-binding.mjs", "./compact-memory-context.mjs"];
  return judgmentHash(await Promise.all(files.map(async (file) => [file, await readFile(new URL(file, import.meta.url), "utf8")])));
}
