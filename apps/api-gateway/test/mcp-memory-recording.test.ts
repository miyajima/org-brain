import { expect, it } from "vitest";
import { updateAccessPolicy } from "../src/access-policy-service";
import { getMemoryDetails, stableResultReadable } from "../src/memory-service";
import { handleOrgBrainMcpRequest } from "../src/mcp";
import type { McpAuthResult } from "../src/mcp-security";
import type { Env } from "../src/types";
import { memoryD1Fixture } from "./fixtures/memory-d1";

it("returns the original recording account and client after sharing, until access is revoked", async () => {
  const { env, sql } = memoryD1Fixture();
  const tenant = "pilot";
  const project = "cross-client";
  const query = { project_id: project, q: "marigold", strict_project: true };
  const author = "user:alice";
  const collaborator = "user:bob";
  const call = async (principal: string, recordingClient: string, name: string, args: object) => {
    const auth = {
      tenantId: tenant, allowedTenants: [tenant], principal, runtimeActor: principal,
      source: "oauth", defaultRole: "contributor", scopes: ["orgbrain:read", "orgbrain:write"],
      recordingClient
    } satisfies McpAuthResult;
    const response = await handleOrgBrainMcpRequest(new Request("https://fixture.example/mcp", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name, arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "untrusted-body-client", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {}
          }
        }
      })
    }), env, { waitUntil() {} } as unknown as ExecutionContext, auth);
    expect(response.status).toBe(200);
    const { result, error } = await response.json() as {
      result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown
    };
    expect(error).toBeUndefined();
    expect(result, JSON.stringify(result)).not.toHaveProperty("isError", true);
    return JSON.parse(result!.content[0].text);
  };
  const propose = (client: string, key: string, source = "fixture", isPrivate = true) =>
    call(author, client, "orgbrain_memories_propose", {
      source, actor_id: collaborator, ...(isPrivate ? { visibility: "private" } : {}), item: {
        external_key: key, summary: `Marigold ${key}`, project_id: project,
        tags: ["curated-memory"],
        content: `Marigold ${key} reports use the suffix SILVER to identify this release.`
      }
    });
  const confirm = (token: string) => call(author, "Cursor", "orgbrain_memories_confirm", {
    confirmation_token: token, approved: true
  });
  const search = (principal: string, client = "Claude Code") =>
    call(principal, client, "orgbrain_memories_search", query);
  const retrieve = (principal: string, q = "marigold") =>
    call(principal, "Cursor", "orgbrain_memories_retrieve_context", { project_id: project, q });
  try {
    env.API_RATE_LIMITER = { async limit() { return { success: true }; } } as Env["API_RATE_LIMITER"];
    env.EVIDENCE_DISPOSITION_MODE = "shadow";
    for (const [id, name] of [[author, "Alice"], [collaborator, "Bob"]]) {
      sql.prepare("INSERT INTO user_profiles(tenant_id,principal,display_name,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(tenant, id, name, 1, 1);
      sql.prepare("INSERT INTO principal_role_assignments(id,tenant_id,project_id,principal,role,created_by_principal,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, tenant, project, id, "contributor", id, 1, 1);
    }
    const target = await confirm((await propose("Codex", "target", "Gemini CLI")).confirmation_token);
    const privateMemory = await confirm((await propose("Cursor", "private")).confirmation_token);
    const setAccess = (id: string, shared: boolean) => updateAccessPolicy(env, {
      resource_type: "memory", resource_id: id, scope: shared ? "restricted" : "private",
      restricted_subjects: shared ? [{ subject_type: "principal", subject_id: collaborator }] : []
    }, { tenantId: tenant, actorPrincipal: author, isAdmin: false });
    const detail = (id: string) => getMemoryDetails(env, tenant, id, { actorPrincipal: collaborator });
    expect((await search(collaborator)).results).toEqual([]);
    expect((await detail(target.memory_id)).memory).toBeNull();
    expect((await search(author)).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.memory_id, recorded_by: { name: "Alice", client: "Codex" } })
    ]));

    await setAccess(target.memory_id, true);
    expect((await search(collaborator)).results).toEqual([
      expect.objectContaining({ id: target.memory_id, recorded_by: { name: "Alice", client: "Codex" } })
    ]);
    const context = await retrieve(collaborator);
    expect(context.evidence_bundle.abstention_recommended).toBe(false);
    expect(context.evidence_bundle.evidence).toEqual([
      expect.objectContaining({
        memory_id: target.memory_id,
        title: "Marigold target",
        text: expect.stringMatching(/SILVER/u),
        recorded_by: { name: "Alice", client: "Codex" }
      })
    ]);
    expect(context.evidence_bundle.answer_guidance.instructions).toContain("recorded_by");
    const natural = await retrieve(collaborator, "What Marigold target should we use?");
    expect(natural.meta.task_query?.coverage).toBe("covered");
    expect(natural.evidence_bundle.evidence[0]?.text).toContain("SILVER");
    expect((await retrieve(collaborator, "marigold 比較")).evidence_bundle.evidence).toEqual([]);
    const relation = await call(author, "Codex", "orgbrain_memory_relation_propose", {
      from_memory_id: target.memory_id, from_version: 1, to_memory_id: privateMemory.memory_id, to_version: 1,
      relation: "contradicts", evidence: [{ type: "file", ref: "docs/SPEC.md" }]
    });
    await call(author, "Codex", "orgbrain_memory_relation_review", { relation_id: relation.id, decision: "confirm" });
    const disputed = await retrieve(collaborator);
    expect(disputed.evidence_bundle.evidence).toEqual([]);
    expect(disputed.evidence_bundle.evidence_status).toBe("conflicted");
    await call(author, "Codex", "orgbrain_memory_relation_review", { relation_id: relation.id, decision: "resolve" });
    sql.prepare("UPDATE memories SET content=? WHERE id=?")
      .run("Marigold target export now uses GOLD.", target.memory_id);
    expect((await retrieve(collaborator)).evidence_bundle.evidence).toEqual([]);
    expect((await detail(target.memory_id)).memory?.recorded_by).toEqual({ name: "Alice", client: "Codex" });
    expect((await detail(privateMemory.memory_id)).memory).toBeNull();
    sql.prepare("UPDATE user_profiles SET display_name=? WHERE tenant_id=? AND principal=?")
      .run("fixture@example.invalid", tenant, author);
    expect((await detail(target.memory_id)).memory?.recorded_by).toEqual({ name: null, client: "Codex" });

    await setAccess(target.memory_id, false);
    expect((await detail(target.memory_id)).memory).toBeNull();
    expect((await search(collaborator)).results).toEqual([]);
    expect((await retrieve(collaborator)).evidence_bundle.evidence).toEqual([]);
    const legacyPolicy = sql.prepare("SELECT permissions_json FROM memories WHERE id=?")
      .get(target.memory_id) as { permissions_json: string };
    expect(stableResultReadable(legacyPolicy.permissions_json, collaborator)).toBe(false);
    expect(stableResultReadable(legacyPolicy.permissions_json, author)).toBe(true);

    const publicMemory = await confirm((await propose("Cursor", "shared-key", "fixture", false)).confirmation_token);
    const privateCollision = await call(author, "Codex", "orgbrain_memories_propose", {
      visibility: "private", item: {
        external_key: "shared-key", project_id: project, summary: "Secret marigold rule",
        tags: ["curated-memory"], content: "Marigold private exports use the PLATINUM suffix."
      }
    });
    const savedPrivate = await confirm(privateCollision.confirmation_token);
    expect(savedPrivate.memory_id).not.toBe(publicMemory.memory_id);
    expect((await search(collaborator)).results).toEqual([
      expect.objectContaining({ id: publicMemory.memory_id, recorded_by: { name: null, client: "Cursor" } })
    ]);
    expect((await detail(savedPrivate.memory_id)).memory).toBeNull();
    const privateKey = sql.prepare("SELECT external_key FROM memories WHERE id=?")
      .get(savedPrivate.memory_id) as { external_key: string };
    const overwrite = await call(collaborator, "Cursor", "orgbrain_memories_propose", {
      item: { external_key: privateKey.external_key, project_id: project, content: "Overwrite the private rule." }
    });
    await expect(call(collaborator, "Cursor", "orgbrain_memories_confirm", {
      confirmation_token: overwrite.confirmation_token, approved: true
    })).rejects.toThrow(/reserved/u);
    expect((await detail(savedPrivate.memory_id)).memory).toBeNull();
  } finally {
    sql.close();
  }
});
