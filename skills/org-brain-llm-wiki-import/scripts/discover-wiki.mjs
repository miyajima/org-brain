#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { discoverWiki, parseWikiDiscoveryArgs } from "../../../packages/orgbrain-cli/src/lib/wiki-discovery.mjs";
export { discoverWiki };

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  discoverWiki(parseWikiDiscoveryArgs(process.argv.slice(2))).then((value) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
