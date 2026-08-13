import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildMcpCaptureRequest,
  captureCandidateJson,
  captureItemPayload,
  classifyMemoryRecord,
  hookCaptureLogFields,
  normalizeRecord,
  postMemoryViaMcp,
  prepareMemoryRecordsV2,
  prepareMemoryRecordForUpsert,
  redactHookMemoryText,
  resolveApiBase,
  resolveMcpConfig,
  resolveProjectNameForWorkspace,
  resolveWorkspaceContext
} from "../packages/orgbrain-cli/src/hook-memory-bridge.mjs";
import { resolveMemoryMode } from "../packages/orgbrain-cli/src/lib/memory-mode.mjs";

describe("hook-memory-bridge promotion", () => {
  it("accepts the shared harness compatibility fixture without a special envelope", async () => {
    const fixtures = JSON.parse(await readFile(
      new URL("../packages/shared/test/fixtures/memory-capture-v2.json", import.meta.url),
      "utf8"
    ));
    for (const fixture of fixtures) {
      const record = normalizeRecord("codex-stop", JSON.stringify({
        hook_event_name: "Stop",
        cwd: "/tmp/workspaces/org-brain",
        turn_id: fixture.event.event_id,
        last_assistant_message: fixture.event.text,
        timestamp: fixture.event.occurred_at
      }));
      const result = await prepareMemoryRecordsV2(record, {
        tenantId: "default",
        projectId: "org-brain",
        businessCategoryId: null,
        workType: "other",
        workspaceRoot: "/tmp/workspaces/org-brain",
        sensitiveMemory: { mode: "deny", allowed_principals: [] }
      }, "default");
      expect(result.records.map((item) => item.kind)).toEqual(fixture.expected_kinds);
    }
  });

  it("redacts credentials and personal contact data before persistence", () => {
    const value = redactHookMemoryText(
      "api_key=supersecretvalue123 contact user@example.com or +81 90 1234 5678"
    );
    expect(value).not.toContain("supersecretvalue123");
    expect(value).not.toContain("user@example.com");
    expect(value).not.toContain("90 1234 5678");
    expect(value).toContain("[REDACTED_SECRET]");
    expect(value).toContain("[REDACTED_EMAIL]");
    expect(value).toContain("[REDACTED_PHONE]");
  });
  it("keeps Cloudflare memory disabled by default", () => {
    expect(resolveMemoryMode({})).toMatchObject({
      cloudMemoryEnabled: false,
      orgSharingEnabled: false,
      scope: "local",
      cloudWritesAllowed: false,
      sharedWrite: false
    });
  });

  it("separates personal portable cloud memory from organization sharing", () => {
    expect(resolveMemoryMode({ ORGBRAIN_ENABLE_CLOUD_MEMORY: "true" })).toMatchObject({
      cloudMemoryEnabled: true,
      orgSharingEnabled: false,
      scope: "personal_cloud",
      cloudWritesAllowed: true,
      sharedWrite: false
    });

    expect(
      resolveMemoryMode({
        ORGBRAIN_ENABLE_CLOUD_MEMORY: "true",
        ORGBRAIN_ENABLE_ORG_SHARING: "true"
      })
    ).toMatchObject({
      cloudMemoryEnabled: true,
      orgSharingEnabled: true,
      scope: "organization",
      cloudWritesAllowed: true,
      sharedWrite: true
    });
  });

  it("does not allow organization sharing without Cloudflare memory", () => {
    expect(resolveMemoryMode({ ORGBRAIN_ENABLE_ORG_SHARING: "true" })).toMatchObject({
      cloudMemoryEnabled: false,
      orgSharingEnabled: true,
      scope: "local",
      cloudWritesAllowed: false,
      sharedWrite: false,
      configurationError: "ORGBRAIN_ENABLE_ORG_SHARING requires ORGBRAIN_ENABLE_CLOUD_MEMORY"
    });
  });

  it("uses ORGBRAIN_API_BASE as a fallback alias when canonical URL is absent", () => {
    expect(resolveApiBase({ ORGBRAIN_API_BASE: "https://legacy.example.test" })).toBe("https://legacy.example.test");
    expect(
      resolveApiBase({
        ORGBRAIN_API_URL: "https://canonical.example.test",
        ORGBRAIN_API_BASE: "https://legacy.example.test"
      })
    ).toBe("https://canonical.example.test");
  });

  it("requires a complete stateless MCP service-token configuration", () => {
    expect(resolveMcpConfig({})).toMatchObject({ configured: false, complete: false });
    expect(resolveMcpConfig({ ORGBRAIN_MCP_URL: "https://mcp.example.test/mcp" })).toMatchObject({
      configured: true,
      complete: false,
      missing: ["ORGBRAIN_MCP_CLIENT_ID", "ORGBRAIN_MCP_CLIENT_SECRET"]
    });
    expect(resolveMcpConfig({
      ORGBRAIN_MCP_URL: "https://mcp.example.test/mcp",
      ORGBRAIN_MCP_CLIENT_ID: "client-id",
      ORGBRAIN_MCP_CLIENT_SECRET: "client-secret"
    })).toMatchObject({
      configured: true,
      complete: true,
      missing: []
    });
  });

  it("builds a zero-discovery MCP 2026-07-28 capture call", () => {
    const request = buildMcpCaptureRequest("default", "codex", {
      externalKey: "codex:turn-1",
      content: "Reusable diagnosis and fix.",
      summary: "Diagnosis",
      tags: ["diagnosis"],
      createdAt: 1_786_000_000_000,
      projectId: "org-brain",
      businessCategoryId: null,
      workType: "implementation"
    });

    expect(request).toMatchObject({
      jsonrpc: "2.0",
      id: "hook:codex:turn-1",
      method: "tools/call",
      params: {
        name: "orgbrain_memories_capture_rationale",
        arguments: {
          tenant_id: "default",
          source: "codex",
          item: {
            external_key: "codex:turn-1",
            project_id: "org-brain"
          }
        },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    });
  });

  it("calls the known capture tool once with modern MCP headers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "hook:codex:turn-1",
      result: {
        content: [{ type: "text", text: JSON.stringify({ inserted: 1, updated: 0 }) }]
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await postMemoryViaMcp({
        url: "https://mcp.example.test/mcp",
        clientId: "client-id",
        clientSecret: "client-secret"
      }, "default", "codex", {
        externalKey: "codex:turn-1",
        content: "Reusable diagnosis and fix.",
        summary: "Diagnosis",
        tags: ["diagnosis"],
        createdAt: 1_786_000_000_000,
        projectId: "org-brain",
        businessCategoryId: null,
        workType: "implementation"
      });

      expect(result).toEqual({ inserted: 1, updated: 0 });
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://mcp.example.test/mcp");
      expect(init.headers).toMatchObject({
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "orgbrain_memories_capture_rationale"
      });
      expect(JSON.parse(init.body)).toMatchObject({
        method: "tools/call",
        params: { name: "orgbrain_memories_capture_rationale" }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips generic agent-turn-complete messages", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/org-brain",
      "last-assistant-message": "必要な作業は終わっています。ほかに進める内容があれば、そのまま書いてください。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("skip");
  });

  it("promotes Japanese diagnosis and fix memories", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/workspaces/org-brain",
      "last-assistant-message":
        "原因は `wrangler` 本体ではなく、Cloudflare OAuth ログイン未完了でした。\n\n今回やったこと:\n- `wrangler login` を実行\n- OAuth 認証完了を確認\n- `wrangler whoami` と `pnpm usage:status` を再実行\n\n結果として D1 クエリは成功し、再発時は最初に `wrangler login` を確認する方針です。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.summary).toContain("org-brain |");
    expect(prepared.record.tags).toContain("promoted");
    expect(prepared.record.tags).toContain("diagnosis");
    expect(prepared.record.content).toContain("# Reusable Memory");
    expect(prepared.record.content).toContain("## Reuse Rule");
    expect(prepared.record.content).not.toContain("## Raw Payload");
  });

  it("promotes command and result pairs", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/workspaces/org-brain",
      "last-assistant-message":
        "調査のため `wrangler d1 execute open-brain --remote --json` を実行し、その後 `pnpm usage:status` も再実行しました。どちらも成功し、remote D1 へ届くことを確認できました。次回も同じ症状ならこの順で確認します。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.tags).toContain("command-result");
  });

  it("uses concrete takeaway details instead of vague Japanese completion titles", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/workspaces/omopay",
      "last-assistant-message":
        "3件とも修正しました。\n\n- `Payment` に `staff` と `store` の整合性バリデーションを追加しました。\n- `Merchant::DistributionSnapshotBuilder` は finalized 期間を再集計しません。\n- `bundle exec rspec spec/models/payment_spec.rb` を実行し、11 examples, 0 failures でした。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.summary).toContain("omopay | command-result | Payment");
    expect(prepared.record.summary).not.toContain("3件とも修正しました");
  });

  it("skips payloads without project id", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "last-assistant-message":
        "原因は認証不足です。対処として `wrangler login` を実行し、再発防止として最初に認証確認を入れます。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("skip");
  });

  it("extracts normalized codex records", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/workspaces/org-brain",
      "turn-id": "turn-123",
      "input-messages": ["現在の利用状況をレポートして"],
      "last-assistant-message": "原因は認証不足です。対処として `wrangler login` を実行しました。"
    });

    const record = normalizeRecord("codex", payload);
    expect(record.externalKey).toBe("codex:turn-123");
    expect(record.projectId).toBe("org-brain");
    expect(classifyMemoryRecord(record).action).toBe("skip");
  });

  it("normalizes Codex Stop lifecycle payloads to the canonical Codex source", () => {
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      cwd: "/tmp/workspaces/org-brain",
      turn_id: "turn-1",
      last_assistant_message:
        "原因は設定の競合でした。対処としてローカル専用設定へ統一し、テストで再発しないことを確認しました。"
    });

    const record = normalizeRecord("codex-stop", payload);
    expect(record.sourceName).toBe("codex");
    expect(record.externalKey).toBe("codex:turn-1");
    expect(record.projectId).toBe("org-brain");
    expect(record.assistantText).toContain("ローカル専用設定");
  });

  it("respects explicit global project scope from payload", () => {
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      cwd: "/tmp/dot-agents",
      project_id: null,
      "last-assistant-message":
        "原因は、このMacでは再生成可能な大きいローカル成果物が複数の定位置に蓄積することです。対処として `df -h ~` で確認し、Chrome の OptGuideOnDeviceModel、Docker の未使用 image/build cache、Atomic Chat モデルを優先して削除します。結果として空き容量を回復でき、再発時も同じ順序で確認できます。"
    });

    const prepared = prepareMemoryRecordForUpsert("codex", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.projectId).toBeNull();
    expect(prepared.record.summary).toContain("(global) | diagnosis");
  });

  it("prompts once per workspace and persists the chosen project name", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-brain-project-map-"));
    const file = path.join(dir, "workspaces.json");
    const legacyFile = path.join(dir, "project-names.json");
    const record = {
      cwd: "/tmp/workspaces/org-brain",
      projectId: "org-brain"
    };

    const selected = await resolveProjectNameForWorkspace(record, {
      file,
      legacyFile,
      env: { ORGBRAIN_TENANT_ID: "tenant-a" },
      prompt: async (cwd, fallback) => {
        expect(cwd).toBe("/tmp/workspaces/org-brain");
        expect(fallback).toBe("org-brain");
        return "client-workspace";
      }
    });

    expect(selected).toBe("client-workspace");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toEqual({
      version: 3,
      workspaces: {
        "/tmp/workspaces/org-brain": {
          tenant_id: "tenant-a",
          project_id: "client-workspace",
          business_category_id: null,
          default_work_type: null,
          sensitive_memory: { mode: "deny", allowed_principals: [] },
          memory_learning_mode: "off"
        }
      }
    });

    const reused = await resolveProjectNameForWorkspace(record, {
      file,
      legacyFile,
      env: { ORGBRAIN_TENANT_ID: "wrong-tenant" },
      prompt: async () => {
        throw new Error("prompt should not be called for saved workspaces");
      }
    });
    expect(reused).toBe("client-workspace");
  });

  it("falls back to basename(cwd) when the first prompt is left blank", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-brain-project-map-"));
    const file = path.join(dir, "workspaces.json");

    const selected = await resolveProjectNameForWorkspace(
      {
        cwd: "/tmp/workspaces/demo-app",
        projectId: "demo-app"
      },
      {
        file,
        legacyFile: path.join(dir, "project-names.json"),
        env: { ORGBRAIN_TENANT_ID: "tenant-a" },
        prompt: async () => ""
      }
    );

    expect(selected).toBe("demo-app");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.workspaces["/tmp/workspaces/demo-app"]).toEqual({
      tenant_id: "tenant-a",
      project_id: "demo-app",
      business_category_id: null,
      default_work_type: null,
      sensitive_memory: { mode: "deny", allowed_principals: [] },
      memory_learning_mode: "off"
    });
  });

  it("uses the saved workspace tenant before the environment fallback", async () => {
    const resolved = await resolveWorkspaceContext(
      { cwd: "/tmp/workspaces/org-brain", projectId: "fallback" },
      {
        config: {
          version: 1,
          workspaces: {
            "/tmp/workspaces/org-brain": {
              tenant_id: "tenant-from-workspace",
              project_id: "project-from-workspace"
            }
          }
        },
        env: { ORGBRAIN_TENANT_ID: "tenant-from-env" },
        migrateLegacy: false
      }
    );

    expect(resolved).toMatchObject({
      tenantId: "tenant-from-workspace",
      projectId: "project-from-workspace",
      source: "workspace"
    });
  });

  it("fails closed when organization sharing cannot resolve a tenant", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-brain-project-map-"));
    await expect(
      resolveWorkspaceContext(
        { cwd: "/tmp/workspaces/org-brain", projectId: "org-brain" },
        {
          workspacesFile: path.join(dir, "workspaces.json"),
          legacyFile: path.join(dir, "project-names.json"),
          env: {
            ORGBRAIN_ENABLE_CLOUD_MEMORY: "true",
            ORGBRAIN_ENABLE_ORG_SHARING: "true"
          },
          prompt: false
        }
      )
    ).rejects.toThrow("Organization sharing requires a workspace tenant mapping");
  });

  it("does not pin the implicit local default tenant before organization sharing is configured", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-brain-project-map-"));
    const workspacesFile = path.join(dir, "workspaces.json");
    const legacyFile = path.join(dir, "project-names.json");

    const local = await resolveWorkspaceContext(
      { cwd: "/tmp/workspaces/org-brain", projectId: "org-brain" },
      { workspacesFile, legacyFile, env: {}, prompt: false }
    );
    expect(local.tenantId).toBe("default");
    expect(JSON.parse(await readFile(workspacesFile, "utf8")).workspaces["/tmp/workspaces/org-brain"].tenant_id).toBeNull();

    const organization = await resolveWorkspaceContext(
      { cwd: "/tmp/workspaces/org-brain", projectId: "org-brain" },
      {
        workspacesFile,
        legacyFile,
        env: {
          ORGBRAIN_ENABLE_CLOUD_MEMORY: "true",
          ORGBRAIN_ENABLE_ORG_SHARING: "true",
          ORGBRAIN_TENANT_ID: "team-tenant"
        },
        prompt: false
      }
    );
    expect(organization.tenantId).toBe("team-tenant");
    expect(JSON.parse(await readFile(workspacesFile, "utf8")).workspaces["/tmp/workspaces/org-brain"].tenant_id).toBe("team-tenant");
  });

  it("preserves both mappings when first-use hooks run concurrently", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-brain-project-map-"));
    const workspacesFile = path.join(dir, "workspaces.json");
    const options = {
      workspacesFile,
      legacyFile: path.join(dir, "project-names.json"),
      env: { ORGBRAIN_TENANT_ID: "tenant-a" },
      prompt: false
    };

    await Promise.all([
      resolveWorkspaceContext({ cwd: "/tmp/workspaces/app-a", projectId: "app-a" }, options),
      resolveWorkspaceContext({ cwd: "/tmp/workspaces/app-b", projectId: "app-b" }, options)
    ]);

    const saved = JSON.parse(await readFile(workspacesFile, "utf8"));
    expect(Object.keys(saved.workspaces).sort()).toEqual([
      "/tmp/workspaces/app-a",
      "/tmp/workspaces/app-b"
    ]);
    await expect(readFile(`${workspacesFile}.lock`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not hold the workspace lock while waiting for an interactive project choice", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "org-brain-project-map-"));
    const workspacesFile = path.join(dir, "workspaces.json");
    const legacyFile = path.join(dir, "project-names.json");
    let releasePrompt;
    let markPromptStarted;
    const promptStarted = new Promise((resolve) => {
      markPromptStarted = resolve;
    });
    const promptRelease = new Promise((resolve) => {
      releasePrompt = resolve;
    });

    const waiting = resolveWorkspaceContext(
      { cwd: "/tmp/workspaces/app-a", projectId: "app-a" },
      {
        workspacesFile,
        legacyFile,
        env: { ORGBRAIN_TENANT_ID: "tenant-a" },
        prompt: async () => {
          markPromptStarted();
          await promptRelease;
          return "chosen-a";
        }
      }
    );
    await promptStarted;

    const concurrent = await resolveWorkspaceContext(
      { cwd: "/tmp/workspaces/app-b", projectId: "app-b" },
      {
        workspacesFile,
        legacyFile,
        env: { ORGBRAIN_TENANT_ID: "tenant-a" },
        prompt: false,
        lock: { timeoutMs: 100 }
      }
    );
    expect(concurrent.projectId).toBe("app-b");

    releasePrompt();
    expect((await waiting).projectId).toBe("chosen-a");
  });

  it("promotes structured project facts from learning-loop payloads", () => {
    const payload = JSON.stringify({
      type: "learning-loop",
      action: "record",
      context: {
        workspaceDir: "/tmp/workspaces/org-brain",
        messageId: "learning-loop:LRN-20260421-001",
        sessionKey: "learning-loop",
        bodyForAgent: "Canonical harness project fact."
      },
      memory_entry: {
        id: "LRN-20260421-001",
        type: "project-fact",
        tags: "toolchain,command,deploy",
        trigger: "org-brain workspace command confirmed",
        action: "use pnpm wrangler deploy from apps/api-gateway",
        result: "api-gateway deploy succeeds only when run from the worker directory",
        reuse: "reuse for this workspace until deploy wiring changes",
        source: "manual"
      }
    });

    const prepared = prepareMemoryRecordForUpsert("openclaw", payload);
    expect(prepared.action).toBe("promote");
    expect(prepared.record.tags).toContain("project-fact");
    expect(prepared.record.tags).toContain("curated-memory");
    expect(prepared.record.tags).toContain("toolchain");
    expect(prepared.record.content).toContain("# Project Fact");
    expect(prepared.record.content).toContain("## Decision");
    expect(prepared.record.content).toContain("## Reason");
    expect(prepared.record.content).toContain("## Evidence");
    expect(prepared.record.content).toContain("## Result");
    expect(prepared.record.content).toContain("## Validity");
    expect(prepared.record.actorId).toContain("openclaw:");
  });

  it("prepares a bounded atomic v2 batch with deterministic metadata", async () => {
    const record = normalizeRecord("codex-stop", JSON.stringify({
      hook_event_name: "Stop",
      cwd: "/tmp/workspaces/org-brain",
      turn_id: "turn-v2",
      last_assistant_message: [
        "## Conclusion",
        "ORGBRAIN_API_URLを唯一の正規API環境変数として採用する。",
        "",
        "## Rationale",
        "API接続先を二つの環境変数で管理すると、connectorとhookの設定が分岐するため。",
        "",
        "## Reuse",
        "新しいconnectorまたはhookを追加する場合は、接続先をORGBRAIN_API_URLから取得する。",
        "",
        "## Evidence",
        "docs/SPEC.md",
        "packages/orgbrain-cli/src/hook-memory-bridge.mjs"
      ].join("\n")
    }));
    const prepared = await prepareMemoryRecordsV2(record, {
      tenantId: "default",
      projectId: "org-brain",
      businessCategoryId: null,
      workType: "implementation",
      workspaceRoot: "/tmp/workspaces/org-brain",
      sensitiveMemory: { mode: "deny", allowed_principals: [] }
    }, "default");
    expect(prepared.records).toHaveLength(1);
    expect(prepared.records[0]).toMatchObject({
      kind: "decision",
      workType: "implementation",
      businessCategoryId: expect.stringMatching(/^bc_prj_/),
      validUntil: expect.any(Number)
    });
    expect(prepared.records[0].canonicalKey).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.records[0].externalKey).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(prepared.report.candidate_hashes).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);

    const canonical = captureCandidateJson(prepared.records[0]);
    const cloudPayload = captureItemPayload(prepared.records[0]);
    const normalizedCloudPayload = {
      ...cloudPayload,
      evidence: cloudPayload.evidence.map((item) => ({
        type: item.evidence_type,
        ref: item.evidence_ref,
        ...(item.note ? { note: item.note } : {}),
        ...(item.weight_score == null ? {} : { weight: item.weight_score })
      }))
    };
    expect(normalizedCloudPayload).toEqual(canonical);
  });

  it("builds one batch MCP call for v2 candidates", () => {
    const request = buildMcpCaptureRequest("default", "codex", [{
      externalKey: "codex:turn-v2:v2:a",
      canonicalKey: "a".repeat(64),
      kind: "constraint",
      content: "legacy API base must not be used",
      summary: "Use the canonical API URL",
      tags: ["capture-v2", "constraint"],
      createdAt: 1_786_000_000_000,
      projectId: "org-brain",
      businessCategoryId: "bc_prj_123",
      workType: "implementation",
      validUntil: 1_800_000_000_000,
      confidenceScore: 0.9,
      utilityScore: 0.8,
      evidence: [],
      captureOrigin: "observed",
      learning: {
        schema_version: 1,
        lesson_type: "decision",
        kind: "constraint",
        trigger: "A hook sends a verified lesson",
        conclusion: "Use exactly one batch capture call",
        rationale: "One bounded call avoids discovery and duplicate writes",
        reuse_rule: "Batch one to three observed lessons",
        outcome: null,
        applicability: { target_files: [], components: ["hook"] },
        evidence_selectors: [],
        gaps: []
      },
      verification: {
        state: "verified",
        verified_at: 1_786_000_000_100,
        attestation_ref: `sha256:${"b".repeat(64)}`
      }
    }]);
    expect(request.params.arguments).toMatchObject({
      tenant_id: "default",
      source: "codex",
      items: [{
        external_key: "codex:turn-v2:v2:a",
        canonical_key: "a".repeat(64),
        kind: "constraint",
        capture_origin: "observed",
        verification: { state: "verified" }
      }]
    });
    expect(request.params.arguments.item).toBeUndefined();
  });

  it("keeps v2 external keys distinct even when the hook event id is very long", async () => {
    const record = normalizeRecord("codex-stop", JSON.stringify({
      hook_event_name: "Stop",
      cwd: "/tmp/workspaces/org-brain",
      turn_id: `turn-${"x".repeat(400)}`,
      last_assistant_message: [
        "We decided to use ORGBRAIN_API_URL because duplicate endpoint variables cause configuration drift.",
        "Evidence: docs/SPEC.md and packages/orgbrain-cli/src/hook-memory-bridge.mjs.",
        "When a connector or hook is added, read its endpoint from ORGBRAIN_API_URL.",
        "The Stop hook must send exactly one batch because discovery and retries otherwise add duplicate writes and latency.",
        "Evidence: packages/orgbrain-cli/src/hook-memory-bridge.mjs and scripts/hook-memory-bridge.test.mjs.",
        "When another lifecycle hook is added, send all of its candidates in one batch request."
      ].join("\n")
    }));
    const prepared = await prepareMemoryRecordsV2(record, {
      tenantId: "default",
      projectId: "org-brain",
      businessCategoryId: null,
      workType: "implementation",
      workspaceRoot: "/tmp/workspaces/org-brain",
      sensitiveMemory: { mode: "deny", allowed_principals: [] }
    }, "default");

    expect(prepared.records).toHaveLength(2);
    expect(new Set(prepared.records.map((item) => item.externalKey)).size).toBe(2);
    expect(prepared.records.every((item) => /^v2:[a-f0-9]{64}$/u.test(item.externalKey))).toBe(true);
  });

  it("logs only candidate hashes and counts for v2 persistence", () => {
    const records = [{ externalKey: "codex:turn-private-event-id" }];
    const report = { candidate_hashes: ["a".repeat(64)] };
    const fields = hookCaptureLogFields("on", records, report, ["memory-private-id"]);

    expect(fields).toEqual({ candidate_count: 1, candidate_hashes: ["a".repeat(64)] });
    expect(JSON.stringify(fields)).not.toContain("turn-private-event-id");
    expect(JSON.stringify(fields)).not.toContain("memory-private-id");
    expect(hookCaptureLogFields("off", records, null, ["memory-id"])).toEqual({
      external_keys: ["codex:turn-private-event-id"],
      memory_ids: ["memory-id"]
    });
  });
});
