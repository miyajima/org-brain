import { boundedString } from "./lib/mcp/common.mjs";
import { memoryReadDefinitions, callMemoryRead } from "./lib/mcp/memory-read.mjs";
import { memoryCaptureDefinitions, callMemoryCapture } from "./lib/mcp/memory-capture.mjs";
import { contextUseDefinitions, callContextUse } from "./lib/mcp/context-use.mjs";
import { knowledgeDefinitions, callKnowledge } from "./lib/mcp/knowledge.mjs";
import { operationsDefinitions, callOperations } from "./lib/mcp/operations.mjs";


import { WIKI_TOOLS, enabledWikiTools, callWikiTool } from "./lib/wiki-mcp.mjs";
import { wikiStatusSync } from "./lib/wiki-service.mjs";
import { answerGuidanceForDisposition } from "../../shared/src/evidence-disposition.mjs";


import { createMcpHandler, fromJsonSchema, hostHeaderValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins, McpServer, originValidationResponse } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";


import { recallBundleMarkdown } from "./lib/local-domain-recall.mjs";


// Calibrated for the high-precision bridge; explicit callers may lower it.


export const LOCAL_MCP_PROTOCOL_VERSION = "2026-07-28";
export const LOCAL_MCP_COMPAT_PROTOCOL_VERSION = "2025-11-25";
const ORGBRAIN_TOOL_PRESENTATION = Object.freeze({
  title: "OrgBrain",
  _meta: Object.freeze({
    "openai/toolInvocation/invoking": "OrgBrainを使用しています…",
    "openai/toolInvocation/invoked": "OrgBrainを使用しました"
  })
});

const TOOL_DEFINITIONS = [...memoryReadDefinitions, ...memoryCaptureDefinitions, ...contextUseDefinitions, ...knowledgeDefinitions, ...operationsDefinitions];

export const LOCAL_MCP_TOOL_PROFILES = Object.freeze({
  default: null,
  "answer-ux-readonly": Object.freeze([
    "orgbrain_context_enrich",
    "orgbrain_domain_context"
  ])
});

function toolDefinitionsForProfile(profile = "default") {
  if (!Object.hasOwn(LOCAL_MCP_TOOL_PROFILES, profile)) {
    throw new Error(`unknown MCP tool profile: ${profile}`);
  }
  const allowed = LOCAL_MCP_TOOL_PROFILES[profile];
  if (allowed === null) return TOOL_DEFINITIONS;
  const allowedSet = new Set(allowed);
  const definitions = TOOL_DEFINITIONS.filter((definition) => allowedSet.has(definition.name));
  if (definitions.length !== allowed.length) throw new Error(`incomplete MCP tool profile: ${profile}`);
  return definitions;
}

function content(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}


async function callTool(store, name, input, toolProfile = "default") {
  if (WIKI_TOOLS.some((tool) => tool.name === name)) return callWikiTool(store, name, input);
  if (memoryReadDefinitions.some((definition) => definition.name === name)) return callMemoryRead(store, name, input, toolProfile);
  if (memoryCaptureDefinitions.some((definition) => definition.name === name)) return callMemoryCapture(store, name, input, toolProfile);
  if (contextUseDefinitions.some((definition) => definition.name === name)) return callContextUse(store, name, input, toolProfile);
  if (knowledgeDefinitions.some((definition) => definition.name === name)) return callKnowledge(store, name, input, toolProfile);
  if (operationsDefinitions.some((definition) => definition.name === name)) return callOperations(store, name, input, toolProfile);
  throw new Error(`unknown tool: ${name}`);
}

export function sanitizeAnswerUxToolResult(name, result) {
  if (name === "orgbrain_context_enrich") {
    const summaryByMemoryId = new Map((result?.results ?? []).map((item) => [
      item?.memory?.id,
      boundedString(item?.memory?.summary, 500) ?? boundedString(item?.memory?.content, 500)
    ]));
    const bundle = result?.evidence_bundle ?? {};
    return {
      evidence_bundle: {
        query_at: bundle.query_at ?? null,
        evidence_status: bundle.evidence_status ?? "insufficient",
        answer_template: bundle.answer_template ?? "abstention",
        evidence: (bundle.evidence ?? []).slice(0, 3).map((item) => ({
          summary: summaryByMemoryId.get(item?.memory_id) ?? boundedString(item?.text, 500),
          source_ref: boundedString(item?.source_reference?.ref, 500)
        })),
        conflicts_count: Number.isInteger(bundle.conflicts_count) ? bundle.conflicts_count
          : Array.isArray(bundle.conflicts) ? bundle.conflicts.length : 0,
        missing_evidence: Array.isArray(bundle.missing_evidence) ? bundle.missing_evidence : [],
        abstention_recommended: bundle.abstention_recommended === true,
        degraded_reasons: Array.isArray(bundle.degraded_reasons) ? bundle.degraded_reasons : [],
        answer_guidance: bundle.answer_guidance ?? answerGuidanceForDisposition(
          { evidence_status: bundle.evidence_status ?? "insufficient" },
          (bundle.evidence ?? []).map((item) => item.source_reference)
        )
      },
      prior_attempts: (result?.prior_attempts ?? []).slice(0, 3).map((attempt) => ({
        summary_ja: attempt.summary_ja,
        action: attempt.action_label,
        target: attempt.target,
        performed_at: attempt.performed_at,
        executed_by_type: attempt.executed_by_type,
        executed_by: attempt.executed_by,
        outcome: attempt.outcome,
        result_summary: attempt.result_summary,
        verification_state: attempt.verification_state,
        evidence: attempt.evidence
      })),
      ...(typeof result?.domain_recall_markdown === "string" && result.domain_recall_markdown
        ? { domain_recall_markdown: result.domain_recall_markdown }
        : {})
    };
  }
  if (name === "orgbrain_domain_context") {
    return {
      inject: result?.inject === true,
      reason: boundedString(result?.reason, 160),
      answer_context_markdown: result?.inject && result?.bundle ? recallBundleMarkdown(result.bundle) : ""
    };
  }
  return result;
}

function profileToolResult(toolProfile, name, result) {
  return toolProfile === "answer-ux-readonly" ? sanitizeAnswerUxToolResult(name, result) : result;
}


export async function handleLocalMcpRequest(store, request, options = {}) {
  const toolProfile = options.toolProfile ?? "default";
  const definitions = [...toolDefinitionsForProfile(toolProfile), ...enabledWikiTools(toolProfile)];
  if (request.method === "initialize") {
    throw Object.assign(new Error(`unsupported protocol version; use ${LOCAL_MCP_PROTOCOL_VERSION}`), { code: -32001 });
  }
  if (request.method === "ping") return {};
  if (request.method === "server/discover") {
    return { supportedVersions: [LOCAL_MCP_PROTOCOL_VERSION], ttlMs: 300_000, cacheScope: "private" };
  }
  if (request.method === "tools/list") return { tools: definitions };
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (WIKI_TOOLS.some((tool) => tool.name === name) && !wikiStatusSync().enabled) {
      return { content: content({ error: "feature_disabled" }), isError: true };
    }
    if (!definitions.some((definition) => definition.name === name)) {
      throw Object.assign(new Error(`tool not available in active profile: ${name}`), { code: -32601 });
    }
    const input = request.params?.arguments || {};
    try {
      const result = await callTool(store, name, input, toolProfile);
      return { content: content(profileToolResult(toolProfile, name, result)), isError: false };
    } catch (error) {
      return {
        content: content({ error: error instanceof Error ? error.message : String(error) }),
        isError: true
      };
    }
  }
  throw Object.assign(new Error(`method not found: ${request.method}`), { code: -32601 });
}

export function createLocalMcpServer(store, {
  protocolVersion = LOCAL_MCP_PROTOCOL_VERSION,
  toolProfile = "default"
} = {}) {
  const definitions = [...toolDefinitionsForProfile(toolProfile), ...(toolProfile === "default" ? WIKI_TOOLS : [])];
  const server = new McpServer(
    { name: "OrgBrain Local", version: "0.1.0" },
    {
      instructions: "Search OrgBrain before repeating source discovery. Use propose then confirm for interactive memory writes.",
      supportedProtocolVersions: [protocolVersion],
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "private" },
        "tools/list": { ttlMs: toolProfile === "default" ? 0 : 300_000, cacheScope: "private" }
      }
    }
  );
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        ...ORGBRAIN_TOOL_PRESENTATION,
        description: definition.description,
        inputSchema: fromJsonSchema(definition.inputSchema)
      },
      async (input) => {
        try {
          const result = await callTool(store, definition.name, input, toolProfile);
          return { content: content(profileToolResult(toolProfile, definition.name, result)), isError: false };
        } catch (error) {
          return {
            content: content({ error: error instanceof Error ? error.message : String(error) }),
            isError: true
          };
        }
      }
    );
  }
  if (toolProfile === "default") {
    // Keep handlers available for stale connections; gate visibility separately.
    server.server.setRequestHandler("tools/list", () => ({
      tools: [...toolDefinitionsForProfile(toolProfile), ...enabledWikiTools(toolProfile)]
        .map((definition) => ({ ...definition, ...ORGBRAIN_TOOL_PRESENTATION }))
    }));
    let previous = enabledWikiTools(toolProfile).length > 0;
    const timer = setInterval(() => {
      let enabled = false;
      try { enabled = wikiStatusSync().enabled; } catch {}
      if (previous !== enabled) {
        previous = enabled;
        server.sendToolListChanged();
      }
    }, 1000);
    timer.unref();
    const close = server.close.bind(server);
    server.close = async () => { clearInterval(timer); await close(); };
  }
  return server;
}

export function createLocalMcpHttpHandler(store, options = {}) {
  const protocolVersion = options.protocolVersion ?? LOCAL_MCP_PROTOCOL_VERSION;
  const allowedHostnames = options.allowedHostnames ?? localhostAllowedHostnames();
  const allowedOriginHostnames = options.allowedOriginHostnames ?? localhostAllowedOrigins();
  const handler = createMcpHandler(
    () => createLocalMcpServer(store, { protocolVersion, toolProfile: options.toolProfile ?? "default" }),
    {
      legacy: options.legacy ?? "reject",
      route: options.route ?? "/mcp"
    }
  );
  return {
    ...handler,
    async fetch(request) {
      const rejected = hostHeaderValidationResponse(request, allowedHostnames)
        ?? originValidationResponse(request, allowedOriginHostnames);
      return rejected ?? handler.fetch(request);
    }
  };
}

export async function startLocalMcp(store, options = {}) {
  await store.init();
  const compatibility = options.compatibility === true;
  if (compatibility) {
    const deadline = Date.parse(String(options.legacyUntil ?? ""));
    if (!Number.isFinite(deadline)) throw new Error("--legacy-until must be a valid ISO-8601 timestamp");
    if (deadline <= Date.now()) throw new Error("local MCP compatibility deadline has expired");
  }
  return serveStdio(
    () => createLocalMcpServer(store, {
      protocolVersion: compatibility ? LOCAL_MCP_COMPAT_PROTOCOL_VERSION : LOCAL_MCP_PROTOCOL_VERSION,
      toolProfile: options.toolProfile ?? "default"
    }),
    {
      legacy: compatibility ? "serve" : "reject",
      onerror: (error) => process.stderr.write(`orgbrain mcp: ${error.message}\n`)
    }
  );
}
