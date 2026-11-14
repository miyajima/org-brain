import { spawn } from "node:child_process";

// Both storage requests and feature administration run wholly inside this
// native process. This helper never owns the feature lock or writes config.
export function requestEngine(binary, args, input) {
  const payload = JSON.stringify(input); // Reject unserializable input before spawning.
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "", stderr = "", finished = false;
    const fail = (error, kill = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (kill) child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(
      "wiki_engine_timeout: inspect state before retrying a write",
    ), true), 120_000);
    child.once("error", error => fail(error));
    child.stdout.on("data", data => {
      if (finished) return;
      stdout += data;
      if (stdout.length > 20_000_000)
        fail(new Error("wiki_response_too_large"), true);
    });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    child.on("close", code => {
      if (finished) return;
      clearTimeout(timer);
      try {
        const value = JSON.parse(stdout);
        if (value?.error) fail(new Error(value.error));
        else if (code !== 0) fail(new Error(stderr || "wiki_engine_failed"));
        else { finished = true; resolve(value); }
      } catch (error) {
        fail(new Error(stderr || "wiki_engine_invalid_response", { cause: error }));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
  });
}
