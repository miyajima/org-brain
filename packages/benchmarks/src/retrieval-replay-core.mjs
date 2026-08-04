import { classifyInputRef } from "./retrieval-metrics-core.mjs";

export async function resolveReplayInput(task, loaders, memoryCache = new Map()) {
  const inputSource = classifyInputRef(task.input_ref);

  if (inputSource === "memory") {
    const memoryId = task.input_ref.slice("memory://".length);
    if (memoryCache.has(memoryId)) {
      return { input: memoryCache.get(memoryId), input_source: inputSource };
    }
    const content = await loaders.loadMemory(memoryId);
    memoryCache.set(memoryId, content);
    return { input: content, input_source: inputSource };
  }

  if (inputSource === "r2") {
    const content = await loaders.loadR2(task.input_ref.slice("r2://".length));
    return { input: content, input_source: inputSource };
  }

  return { input: task.input_ref, input_source: inputSource };
}

export function overlapAtFive(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length;
}
