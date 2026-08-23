import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { collectCompatibilityManifestEntries, createApiManifest } from "../src/index.js";

describe("API manifest fixture", () => {
  it("is deterministically generated from route definitions", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const ossRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const timestamp = Number(execFileSync("git", ["show", "-s", "--format=%ct", ossRef], {
      cwd: root,
      encoding: "utf8"
    }).trim());
    const manifest = createApiManifest({
      ossRef,
      generatedAt: new Date(timestamp * 1000).toISOString(),
      routes: collectCompatibilityManifestEntries()
    });
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const digest = createHash("sha256").update(serialized).digest("hex");
    const fixtureDirectory = resolve(root, "packages/server-core/fixtures");
    await mkdir(fixtureDirectory, { recursive: true });
    await Promise.all([
      writeFile(resolve(fixtureDirectory, "api-manifest.json"), serialized, "utf8"),
      writeFile(resolve(fixtureDirectory, "api-manifest.sha256"), `${digest}\n`, "utf8")
    ]);
    expect(manifest.routes).toHaveLength(194);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
