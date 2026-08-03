import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadLegacyProjectNames,
  loadProjectRootMappings,
  loadWorkspaceConfig,
  migrateLegacyProjectNames,
  projectRootsFromWorkspaceConfig,
  saveWorkspaceConfig
} from "./lib/workspace-config.mjs";

describe("workspace-config", () => {
  it("writes an atomic private versioned workspace map", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "org-brain-workspaces-"));
    const configDir = path.join(root, "nested");
    const file = path.join(configDir, "workspaces.json");

    await saveWorkspaceConfig(file, {
      version: 1,
      workspaces: {
        "/tmp/workspaces/org-brain": {
          tenant_id: "tenant-a",
          project_id: "org-brain"
        }
      }
    });

    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadWorkspaceConfig(file)).toEqual({
      version: 1,
      workspaces: {
        "/tmp/workspaces/org-brain": {
          tenant_id: "tenant-a",
          project_id: "org-brain"
        }
      }
    });
    expect((await readdir(configDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects corrupt workspace maps instead of silently falling back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "org-brain-workspaces-"));
    const file = path.join(root, "workspaces.json");
    await writeFile(file, "{broken", "utf8");
    await expect(loadWorkspaceConfig(file)).rejects.toThrow("Invalid Org Brain workspace config");
  });

  it("does not change permissions on an existing custom parent directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "org-brain-workspaces-"));
    await chmod(root, 0o755);
    const file = path.join(root, "custom-workspaces.json");

    await saveWorkspaceConfig(file, { version: 1, workspaces: {} });

    expect((await stat(root)).mode & 0o777).toBe(0o755);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("migrates legacy project names without deleting or rewriting the source file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "org-brain-workspaces-"));
    const legacyFile = path.join(root, "project-names.json");
    const workspacesFile = path.join(root, "workspaces.json");
    const legacyText = `${JSON.stringify({ "/tmp/workspaces/demo": "demo-project" }, null, 2)}\n`;
    await writeFile(legacyFile, legacyText, "utf8");

    const legacy = await loadLegacyProjectNames(legacyFile);
    const config = await loadWorkspaceConfig(workspacesFile);
    expect(migrateLegacyProjectNames(config, legacy, "tenant-a").changed).toBe(true);
    await saveWorkspaceConfig(workspacesFile, config);

    expect(await readFile(legacyFile, "utf8")).toBe(legacyText);
    expect((await loadWorkspaceConfig(workspacesFile)).workspaces["/tmp/workspaces/demo"]).toEqual({
      tenant_id: "tenant-a",
      project_id: "demo-project"
    });
  });

  it("filters roots by tenant and omits ambiguous project ids", () => {
    const roots = projectRootsFromWorkspaceConfig(
      {
        version: 1,
        workspaces: {
          "/tmp/a": { tenant_id: "tenant-a", project_id: "shared" },
          "/tmp/b": { tenant_id: "tenant-a", project_id: "shared" },
          "/tmp/c": { tenant_id: "tenant-a", project_id: "unique" },
          "/tmp/d": { tenant_id: "tenant-b", project_id: "other" },
          "/tmp/e": { tenant_id: null, project_id: "local-only" }
        }
      },
      "tenant-a"
    );

    expect(roots.has("shared")).toBe(false);
    expect(roots.get("unique")).toBe("/tmp/c");
    expect(roots.has("other")).toBe(false);
    expect(roots.has("local-only")).toBe(false);
    expect(
      projectRootsFromWorkspaceConfig(
        {
          version: 1,
          workspaces: {
            "/tmp/e": { tenant_id: null, project_id: "local-only" }
          }
        },
        "default"
      ).get("local-only")
    ).toBe("/tmp/e");
  });

  it("keeps ORGBRAIN_PROJECT_ROOTS as an explicit compatibility override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "org-brain-workspaces-"));
    const mappedRoot = path.join(root, "mapped");
    const overrideRoot = path.join(root, "override");
    await mkdir(mappedRoot);
    await mkdir(overrideRoot);
    const file = path.join(root, "workspaces.json");
    await saveWorkspaceConfig(file, {
      version: 1,
      workspaces: {
        [mappedRoot]: { tenant_id: "tenant-a", project_id: "demo" }
      }
    });

    const roots = await loadProjectRootMappings({
      tenantId: "tenant-a",
      workspacesFile: file,
      env: { ORGBRAIN_PROJECT_ROOTS: JSON.stringify({ demo: overrideRoot }) }
    });

    expect(roots.get("demo")).toBe(overrideRoot);
    await access(file);
  });
});
