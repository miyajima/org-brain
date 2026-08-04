import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const apiGatewayDir = resolve(repoRoot, "apps/api-gateway");

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sqlNullable(value) {
  if (value === null || value === undefined) return "NULL";
  return sqlString(value);
}

export function formatJst(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(new Date(timestamp));
}

export function formatUtcDay(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function parseUtcDay(day) {
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid UTC day: ${day}`);
  }
  return timestamp;
}

export function utcDayBounds(day) {
  const start = parseUtcDay(day);
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

export function buildFtsQuery(raw) {
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 6)
    .map((token) => `"${token.replace(/"/g, '""')}"*`);

  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

export async function runD1Query(options, sql) {
  const args = ["wrangler", "d1", "execute", options.database];
  args.push(`--${options.location}`);
  if (options.env) args.push("--env", options.env);
  args.push("--json", "--command", sql);

  const { stdout, stderr } = await execFileAsync("pnpm", args, {
    cwd: apiGatewayDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const detail = stderr?.trim() ? `\n${stderr.trim()}` : "";
    throw new Error(`Failed to parse wrangler JSON output.${detail}\n${stdout}`);
  }

  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first?.success) {
    throw new Error(`Wrangler query failed: ${JSON.stringify(first)}`);
  }
  return first.results ?? [];
}

export async function runD1Queries(options, queryMap) {
  const entries = await Promise.all(
    Object.entries(queryMap).map(async ([key, sql]) => [key, await runD1Query(options, sql)])
  );
  return Object.fromEntries(entries);
}

export async function fetchR2ObjectText(options, bucket, key) {
  const args = ["wrangler", "r2", "object", "get", `${bucket}/${key}`, "--pipe"];
  args.push(`--${options.location === "preview" ? "remote" : options.location}`);
  if (options.env) args.push("--env", options.env);

  const { stdout } = await execFileAsync("pnpm", args, {
    cwd: apiGatewayDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });

  return stdout;
}

export function parseLocationArgs(argv, defaults = {}) {
  const options = {
    tenant: defaults.tenant ?? "default",
    database: defaults.database ?? "open-brain",
    location: defaults.location ?? "remote",
    env: defaults.env,
    json: defaults.json ?? false,
    capability: defaults.capability,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--local") {
      options.location = "local";
      continue;
    }
    if (arg === "--preview") {
      options.location = "preview";
      continue;
    }
    if (arg === "--remote") {
      options.location = "remote";
      continue;
    }
    if (arg === "--tenant" || arg.startsWith("--tenant=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--tenant requires a value");
      options.tenant = value;
      continue;
    }
    if (arg === "--database" || arg.startsWith("--database=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--database requires a value");
      options.database = value;
      continue;
    }
    if (arg === "--env" || arg.startsWith("--env=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--env requires a value");
      options.env = value;
      continue;
    }
    if (arg === "--capability" || arg.startsWith("--capability=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--capability requires a value");
      options.capability = value;
      continue;
    }
  }

  return options;
}
