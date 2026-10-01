import { lstat, readFile } from "node:fs/promises";

const allowed = new Set([
  "ORGBRAIN_JEV_PROJECTS", "ORGBRAIN_JEV_OBJECTIVE", "ORGBRAIN_JEV_CAPTURE_MODE",
  "ORGBRAIN_JEV_CAPTURE_ASSESSMENT_MODE", "ORGBRAIN_JEV_USE_MODE", "ORGBRAIN_JEV_WIKI_MODE",
  "ORGBRAIN_JEV_SEARCH_MODE", "ORGBRAIN_JEV_THRESHOLD", "ORGBRAIN_JEV_RESOLVED_MODEL", "ORGBRAIN_JEV_QUALIFICATION_FILE"
]);

// This file contains flags only. Credentials remain in the process environment.
export async function loadBundledJudgmentSettings({ buildInfo, bundleUrl, env = process.env }) {
  if (buildInfo?.source !== "standalone") return { loaded: false };
  const file = new URL("../jev-settings.json", bundleUrl);
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if (error.code === "ENOENT") return { loaded: false }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("invalid_bundled_judgment_settings");
  let settings;
  try { settings = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("invalid_bundled_judgment_settings"); }
  if (!settings || Array.isArray(settings) || typeof settings !== "object" || Object.entries(settings).some(([key, value]) =>
    !allowed.has(key) || typeof value !== "string" || value.length > 2048 ||
    (key.endsWith("_MODE") && !["off", "shadow", "active"].includes(value)) ||
    (key === "ORGBRAIN_JEV_OBJECTIVE" && !["quality", "cost"].includes(value)) ||
    (key === "ORGBRAIN_JEV_THRESHOLD" && !["0.8", "0.9", "0.95", "0.98"].includes(value))
  )) throw new Error("invalid_bundled_judgment_settings");
  for (const [key, value] of Object.entries(settings)) if (env[key] === undefined) env[key] = value;
  return { loaded: true };
}
