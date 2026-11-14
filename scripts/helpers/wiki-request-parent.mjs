// Test-only Node parent: report the real native PID, then perform a public call.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { WikiService, setWikiFeature } from "../../packages/orgbrain-cli/src/lib/wiki-service.mjs";
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  // Report only after the complete request has reached the native stdin pipe;
  // killing Node before this point can legitimately cancel an unsent request.
  child.stdin.once("finish", () => process.stdout.write(`${child.pid}\n`));
  return child;
};
syncBuiltinESMExports();
const [config, root, mode] = process.argv.slice(2);
if (mode === "feature") await setWikiFeature(config, false);
else await new WikiService({ config, root }).request({ op: "put", path: "orphan.md", content: "parent died" });
