import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = process.env.ORGBRAIN_TEST_CLI
  ? path.resolve(process.env.ORGBRAIN_TEST_CLI)
  : fileURLToPath(new URL("../packages/orgbrain-cli/src/local-memory.mjs", import.meta.url));

test("workspace resolve returns the configured identity without opening the memory DB", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "orgbrain-workspace-resolve-"));
  try {
    const checkout = path.join(temporary, "checkout");
    const projectFileRoot = path.join(temporary, "project-file");
    const unknown = path.join(temporary, "unknown");
    const mappingFile = path.join(temporary, "workspaces.json");
    const dbFile = path.join(temporary, "no-db", "memory.sqlite");
    await Promise.all([mkdir(checkout), mkdir(projectFileRoot), mkdir(unknown)]);
    await mkdir(path.join(projectFileRoot, "src"));
    const git = spawnSync("git", ["init", "-q", projectFileRoot], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    await writeFile(path.join(projectFileRoot, ".orgbrain.local.json"), JSON.stringify({
      version: 1, tenant_id: "tenant-b", project_id: "project-b"
    }), { mode: 0o600 });
    await writeFile(mappingFile, JSON.stringify({
      version: 3,
      workspaces: {
        [checkout]: { tenant_id: "tenant-a", project_id: "project-a" }
      }
    }));
    const env = { ...process.env, ORGBRAIN_WORKSPACES_FILE: mappingFile, ORGBRAIN_LOCAL_DB: dbFile };

    const mapped = spawnSync(process.execPath, [cli, "workspace", "resolve", "--root", checkout], {
      encoding: "utf8", env
    });
    assert.equal(mapped.status, 0, mapped.stderr);
    assert.deepEqual(JSON.parse(mapped.stdout), {
      found: true,
      project_id: "project-a",
      tenant_id: "tenant-a",
      workspace_root: checkout,
      source: "workspace"
    });

    const projectFile = spawnSync(process.execPath, [cli, "workspace", "resolve", "--root", path.join(projectFileRoot, "src")], {
      encoding: "utf8", env
    });
    assert.equal(projectFile.status, 0, projectFile.stderr);
    assert.deepEqual(JSON.parse(projectFile.stdout), {
      found: true,
      project_id: "project-b",
      tenant_id: "tenant-b",
      workspace_root: await realpath(projectFileRoot),
      source: "project-file"
    });

    if (process.platform !== "win32") {
      await chmod(path.join(projectFileRoot, ".orgbrain.local.json"), 0o644);
      const publicFile = spawnSync(process.execPath, [cli, "workspace", "resolve", "--root", projectFileRoot], {
        encoding: "utf8", env
      });
      assert.equal(publicFile.status, 1);
      assert.match(publicFile.stderr, /must be private/u);
      await chmod(path.join(projectFileRoot, ".orgbrain.local.json"), 0o600);
    }

    const staged = spawnSync("git", ["-C", projectFileRoot, "add", "-f", ".orgbrain.local.json"], { encoding: "utf8" });
    assert.equal(staged.status, 0, staged.stderr);
    const tracked = spawnSync(process.execPath, [cli, "workspace", "resolve", "--root", projectFileRoot], {
      encoding: "utf8", env
    });
    assert.equal(tracked.status, 1);
    assert.match(tracked.stderr, /must not be tracked by Git/u);
    const unstaged = spawnSync("git", ["-C", projectFileRoot, "rm", "--cached", "-q", ".orgbrain.local.json"], {
      encoding: "utf8"
    });
    assert.equal(unstaged.status, 0, unstaged.stderr);

    const unmapped = spawnSync(process.execPath, [cli, "workspace", "resolve", "--root", unknown], {
      encoding: "utf8", env
    });
    assert.equal(unmapped.status, 2, unmapped.stderr);
    assert.deepEqual(JSON.parse(unmapped.stdout), {
      found: false,
      project_id: null,
      tenant_id: null,
      workspace_root: null,
      source: "unmapped"
    });
    await assert.rejects(access(dbFile), { code: "ENOENT" });

    await writeFile(path.join(projectFileRoot, ".orgbrain.local.json"), JSON.stringify({
      version: 1, tenant_id: "tenant-b", project_id: "project-b", api_key: "never-echo-this"
    }));
    const invalid = spawnSync(process.execPath, [cli, "workspace", "resolve", "--root", projectFileRoot], {
      encoding: "utf8", env
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /unsupported fields: api_key/u);
    assert.doesNotMatch(invalid.stderr, /never-echo-this/u);

    await writeFile(mappingFile, JSON.stringify({
      version: 3,
      workspaces: {
        [checkout]: { tenant_id: "tenant-a", project_id: "project-a" },
        [projectFileRoot]: { tenant_id: "tenant-c", project_id: "private-override" }
      }
    }));
    const overridden = spawnSync(process.execPath, [cli, "workspace", "resolve", "--root", path.join(projectFileRoot, "src")], {
      encoding: "utf8", env
    });
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.equal(JSON.parse(overridden.stdout).project_id, "private-override");
    assert.equal(JSON.parse(overridden.stdout).source, "workspace-root");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
