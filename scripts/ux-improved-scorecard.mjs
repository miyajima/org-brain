#!/usr/bin/env node

import { runCli } from "./product-ux-scorecard.mjs";

process.stderr.write("ux-improved-scorecard.mjs is a compatibility entry point; provide measurement input instead of embedded scores.\n");
await runCli(process.argv.slice(2));
