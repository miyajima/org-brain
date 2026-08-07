#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`invalid argument ${name ?? ""}`);
    values.set(name, value);
  }
  return values;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

export async function prepareCloudRestoreConfig(options) {
  const databases = JSON.parse(await readFile(options.databasesJson, "utf8"));
  if (!Array.isArray(databases)) throw new Error("D1 list response must be an array");
  const source = databases.find((database) => database?.name === options.sourceName);
  if (!source?.uuid) throw new Error(`source D1 database not found: ${options.sourceName}`);
  const drill = options.drillName
    ? databases.find((database) => database?.name === options.drillName)
    : null;
  if (options.drillName && !drill?.uuid) throw new Error(`drill D1 database not found: ${options.drillName}`);
  const bindings = [
    { binding: "SOURCE_DB", name: source.name, id: source.uuid },
    ...(drill ? [{ binding: "DRILL_DB", name: drill.name, id: drill.uuid }] : [])
  ];
  const config = [
    `name = ${tomlString("orgbrain-cloud-restore-drill")}`,
    `compatibility_date = ${tomlString("2026-03-03")}`,
    "",
    ...bindings.flatMap((binding) => [
      "[[d1_databases]]",
      `binding = ${tomlString(binding.binding)}`,
      `database_name = ${tomlString(binding.name)}`,
      `database_id = ${tomlString(binding.id)}`,
      ""
    ])
  ].join("\n");
  await writeFile(options.output, config, "utf8");
  return {
    source: { name: source.name, uuid: source.uuid },
    drill: drill ? { name: drill.name, uuid: drill.uuid } : null,
    output: options.output
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  prepareCloudRestoreConfig({
    databasesJson: args.get("--databases-json"),
    sourceName: args.get("--source-name"),
    drillName: args.get("--drill-name") ?? null,
    output: args.get("--output")
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
