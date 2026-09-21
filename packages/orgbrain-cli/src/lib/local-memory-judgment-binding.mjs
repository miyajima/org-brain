import { readFile } from "node:fs/promises";
import { judgmentHash } from "../../../shared/src/memory-judgment-runtime.mjs";

// Bind qualification to both prediction and the code that applies it. A binary
// distribution without these sources must supply a separately qualified build.
export async function localJudgmentImplementationHash() {
  const files = ["../../../shared/src/memory-judgment-runtime.mjs", "../../../shared/src/memory-judgment-evaluation.mjs",
    "./local-memory-judge.mjs", "./local-memory-judge-queue.mjs", "./local-memory-store.mjs", "./task-commitment-store.mjs",
    "../autonomy.mjs", "../hook-memory-bridge.mjs", "./local-memory-judgment-binding.mjs"];
  return judgmentHash(await Promise.all(files.map(async (file) => [file, await readFile(new URL(file, import.meta.url), "utf8")])));
}
