#!/usr/bin/env node

import { main } from "./sync-agents-memory.mjs";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
