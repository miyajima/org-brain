import { parentPort, workerData } from "node:worker_threads";
import { runDeterministicTransientItem } from "./transient-benchmark-item.mjs";

try {
  const results = workerData.items.map(({ index, item }) => ({
    index,
    result: runDeterministicTransientItem(workerData.options, item)
  }));
  parentPort.postMessage({ ok: true, results });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack || error.message : String(error)
  });
}
