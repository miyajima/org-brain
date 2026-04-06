#!/usr/bin/env node

import process from "node:process";

function printHelp() {
  console.log(`Org Brain knowledge docs seed

Usage:
  pnpm docs:seed [-- --tenant <tenant_id>] [--json]
  node ./scripts/seed-knowledge-docs.mjs [options]

Options:
  --tenant <tenant_id>   Tenant to seed (default: default)
  --api-base <url>       API base URL (default: https://open-brain-console.pages.dev/api)
  --api-key <value>      Placeholder API key for the Pages proxy (default: seed)
  --json                 Emit machine-readable JSON
  --help                 Show this message
`);
}

function parseArgs(argv) {
  const options = {
    tenant: "default",
    apiBase: "https://open-brain-console.pages.dev/api",
    apiKey: "seed",
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--tenant" || arg.startsWith("--tenant=")) {
      options.tenant = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      continue;
    }
    if (arg === "--api-base" || arg.startsWith("--api-base=")) {
      options.apiBase = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      continue;
    }
    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      options.apiKey = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function yamlScalar(value) {
  return JSON.stringify(value);
}

function renderFrontmatter(frontmatter) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function renderMarkdown(frontmatter, body) {
  return `${renderFrontmatter(frontmatter)}\n${body.trim()}\n`;
}

function buildSeedDocs(updatedAt) {
  const rootTags = ["org-brain", "navigation"];
  return [
    {
      scope: "org",
      kind: "moc",
      title: "Org Brain MOC",
      slug: "ORG",
      markdown: renderMarkdown(
        {
          id: "org-brain-root",
          title: "Org Brain MOC",
          scope: "org",
          kind: "moc",
          tags: rootTags,
          stability: "stable",
          updated_at: updatedAt,
          summary: "Top-level map of contents for Org Brain knowledge docs."
        },
        `# Org Brain

Start here for the stable maps of contents.

- [[projects/org-brain/_index]]
- [[capabilities/_index]]
- [[workflows/_index]]
- [[policies/_index]]`
      )
    },
    {
      scope: "capability",
      kind: "moc",
      title: "Capabilities",
      slug: "capabilities/_index",
      markdown: renderMarkdown(
        {
          id: "org-brain-capabilities-index",
          title: "Capabilities",
          scope: "capability",
          kind: "moc",
          tags: ["capability", "navigation"],
          stability: "stable",
          updated_at: updatedAt,
          related: ["ORG"],
          summary: "Entry point for capability-specific docs."
        },
        `# Capabilities

- [[capabilities/memory-retrieval]]
- [[capabilities/knowledge-docs]]
- [[capabilities/hook-memory-bridge]]`
      )
    },
    {
      scope: "workflow",
      kind: "moc",
      title: "Workflows",
      slug: "workflows/_index",
      markdown: renderMarkdown(
        {
          id: "org-brain-workflows-index",
          title: "Workflows",
          scope: "workflow",
          kind: "moc",
          tags: ["workflow", "navigation"],
          stability: "stable",
          updated_at: updatedAt,
          related: ["ORG"],
          summary: "Entry point for workflow docs."
        },
        `# Workflows

- [[workflows/spec-to-code]]`
      )
    },
    {
      scope: "policy",
      kind: "moc",
      title: "Policies",
      slug: "policies/_index",
      markdown: renderMarkdown(
        {
          id: "org-brain-policies-index",
          title: "Policies",
          scope: "policy",
          kind: "moc",
          tags: ["policy", "navigation"],
          stability: "stable",
          updated_at: updatedAt,
          related: ["ORG"],
          summary: "Entry point for stable operational policies."
        },
        `# Policies

- [[policies/memory-operations]]
- [[policies/remote-mcp-access]]`
      )
    },
    {
      scope: "project",
      kind: "moc",
      title: "org-brain Project",
      slug: "projects/org-brain/_index",
      markdown: renderMarkdown(
        {
          id: "project-org-brain-index",
          title: "org-brain Project",
          scope: "project",
          kind: "moc",
          tags: ["project", "org-brain", "navigation"],
          stability: "stable",
          updated_at: updatedAt,
          project: "org-brain",
          related: ["ORG"],
          summary: "Project entry point for the Org Brain system."
        },
        `# org-brain

- [[projects/org-brain/current-state]]
- [[capabilities/_index]]
- [[workflows/_index]]
- [[policies/_index]]`
      )
    },
    {
      scope: "project",
      kind: "doc",
      title: "Org Brain Current State",
      slug: "projects/org-brain/current-state",
      markdown: renderMarkdown(
        {
          id: "project-org-brain-current-state",
          title: "Org Brain Current State",
          scope: "project",
          kind: "doc",
          tags: ["project", "org-brain", "topology", "operations"],
          stability: "stable",
          updated_at: updatedAt,
          project: "org-brain",
          related: ["projects/org-brain/_index", "capabilities/memory-retrieval", "workflows/spec-to-code"],
          summary: "Current topology, storage, and operator commands for Org Brain."
        },
        `# Current State

Org Brain runs as a Cloudflare-based org bus MVP.

## Topology

- API: \`open-brain-api-gateway\`
- Queue router: \`open-brain-org-router\`
- Capability runner: \`open-brain-cap-runner\`
- Workflow host: \`open-brain-orchestrator\`
- Console: \`open-brain-console\`

## Source Of Truth

- Tasks, task events, memories, retrieval telemetry, and knowledge docs live in D1.
- R2 stores task artifacts and long-form knowledge markdown bodies.
- OpenClaw SQLite is cache only, not the source of truth.

## Operator Commands

- \`pnpm usage:status\`
- \`pnpm metrics:report\`
- \`pnpm metrics:replay\`
- \`pnpm docs:seed\`
- \`pnpm memories:maintain -- --apply --remote\`

See also [[capabilities/memory-retrieval]] and [[policies/memory-operations]].`
      )
    },
    {
      scope: "capability",
      kind: "capability",
      title: "Memory Retrieval",
      slug: "capabilities/memory-retrieval",
      markdown: renderMarkdown(
        {
          id: "capability-memory-retrieval",
          title: "Memory Retrieval",
          scope: "capability",
          kind: "capability",
          tags: ["capability", "memory", "retrieval", "search"],
          stability: "stable",
          updated_at: updatedAt,
          capability: "memory-retrieval",
          related: ["projects/org-brain/current-state", "capabilities/knowledge-docs"],
          summary: "Shared memory search and profile retrieval for API and cap-runner."
        },
        `# Memory Retrieval

Use memory retrieval for both direct API lookups and cap-runner prompt context.

## Endpoints

- \`POST /v1/memories/search\`
- \`POST /v1/memories/profile\`

## Search Modes

- \`bm25_v1\`
- \`bm25_rewrite_v1\`
- \`hybrid_memory_docs_v1\`
- \`fallback_recent_v1\`

## Behavior

- \`rewrite_query=true\` adds phrase, token OR, split token OR, and singularized token OR variants.
- \`search_mode=hybrid\` falls back to knowledge docs only when lexical memory hits are fewer than 3.
- cap-runner uses \`rewrite_query=true\` and \`search_mode=hybrid\`.

Hybrid fallback only becomes useful when [[capabilities/knowledge-docs]] has seeded docs.`
      )
    },
    {
      scope: "capability",
      kind: "capability",
      title: "Knowledge Docs",
      slug: "capabilities/knowledge-docs",
      markdown: renderMarkdown(
        {
          id: "capability-knowledge-docs",
          title: "Knowledge Docs",
          scope: "capability",
          kind: "capability",
          tags: ["capability", "knowledge-docs", "docs", "fts"],
          stability: "stable",
          updated_at: updatedAt,
          capability: "knowledge-docs",
          related: ["capabilities/memory-retrieval", "projects/org-brain/current-state"],
          summary: "Markdown-backed knowledge docs indexed in D1 and used for hybrid retrieval fallback."
        },
        `# Knowledge Docs

Knowledge docs are a read-optimized layer for stable information. They are not the system of record.

## Storage

- Metadata and summaries live in \`knowledge_docs\`
- Relationships live in \`knowledge_links\`
- FTS lives in \`knowledge_docs_fts\`
- Long markdown bodies can spill to R2

## Retrieval Pattern

- Start from MOC docs such as [[ORG]] or [[projects/org-brain/_index]]
- Use \`/v1/docs/:slug/context\` for bounded expansion
- Use doc search as hybrid fallback when memory hits are thin

Seed docs should cover stable architecture, policies, and workflows rather than transient execution logs.`
      )
    },
    {
      scope: "capability",
      kind: "capability",
      title: "Hook Memory Bridge",
      slug: "capabilities/hook-memory-bridge",
      markdown: renderMarkdown(
        {
          id: "capability-hook-memory-bridge",
          title: "Hook Memory Bridge",
          scope: "capability",
          kind: "capability",
          tags: ["capability", "memory", "hooks", "bridge"],
          stability: "stable",
          updated_at: updatedAt,
          capability: "hook-memory-bridge",
          related: ["capabilities/memory-retrieval", "policies/memory-operations"],
          summary: "Local agent hook bridge that distills reusable memories and upserts them to D1."
        },
        `# Hook Memory Bridge

The shared bridge normalizes local agent hook payloads and upserts reusable memories into D1.

## Supported Sources

- Codex
- Claude Code
- Cursor
- OpenClaw
- OpenCode

## Behavior

- Low-signal generic turn-complete chatter is skipped.
- Reusable payloads are promoted into distilled \`# Reusable Memory\` markdown.
- Upserts go through \`POST /v1/memories/upsert\`.

Operational policy is described in [[policies/memory-operations]].`
      )
    },
    {
      scope: "workflow",
      kind: "workflow",
      title: "Spec To Code Workflow",
      slug: "workflows/spec-to-code",
      markdown: renderMarkdown(
        {
          id: "workflow-spec-to-code",
          title: "Spec To Code Workflow",
          scope: "workflow",
          kind: "workflow",
          tags: ["workflow", "spec-to-code", "tasks"],
          stability: "stable",
          updated_at: updatedAt,
          workflow: "spec-to-code",
          related: ["projects/org-brain/current-state"],
          summary: "Sequential workflow that runs plan_writer, code_gen, and code_review tasks."
        },
        `# Spec To Code Workflow

This workflow runs three tasks in order:

1. \`plan_writer\`
2. \`code_gen\`
3. \`code_review\`

Each step waits on a \`task.result\` event before moving to the next stage.`
      )
    },
    {
      scope: "policy",
      kind: "policy",
      title: "Memory Operations",
      slug: "policies/memory-operations",
      markdown: renderMarkdown(
        {
          id: "policy-memory-operations",
          title: "Memory Operations",
          scope: "policy",
          kind: "policy",
          tags: ["policy", "memory", "operations", "maintenance"],
          stability: "stable",
          updated_at: updatedAt,
          related: ["capabilities/hook-memory-bridge", "capabilities/memory-retrieval"],
          summary: "Operational rules for storing, seeding, and compacting Org Brain memories."
        },
        `# Memory Operations

## Source Of Truth

- D1 is the source of truth for memories.
- Hook bridges and sync scripts write into D1.
- Knowledge docs hold stable summaries and policies, not transient turn logs.

## Search Hygiene

- Reusable promoted memories should stay searchable.
- Old raw hook memories can be compacted into digest memories when they become noisy.
- Compacted rows are excluded from retrieval so searches stay focused.

## Maintenance

Run \`pnpm memories:maintain -- --apply --remote\` regularly to compact old raw hook memories and collapse exact duplicates.

Use [[capabilities/knowledge-docs]] for stable architecture and policy material instead of stuffing everything into memories.`
      )
    },
    {
      scope: "policy",
      kind: "policy",
      title: "Remote MCP Access",
      slug: "policies/remote-mcp-access",
      markdown: renderMarkdown(
        {
          id: "policy-remote-mcp-access",
          title: "Remote MCP Access",
          scope: "policy",
          kind: "policy",
          tags: ["policy", "mcp", "auth", "remote-access"],
          stability: "stable",
          updated_at: updatedAt,
          related: ["projects/org-brain/current-state"],
          summary: "Authentication and tenant-isolation policy for the Org Brain remote MCP endpoint."
        },
        `# Remote MCP Access

## Auth

- The primary endpoint is mounted on the API gateway at \`/mcp\`.
- Auth uses \`CF-Access-Client-Id\` and \`CF-Access-Client-Secret\`.
- Tenant access is enforced per token and can be narrowed by principal policy.

## Operational Rules

- Keep service-token tenant grants minimal.
- Prefer API gateway hosted MCP over an extra hop.
- Treat MCP as remote control over Org Brain state and memory APIs.`
      )
    }
  ];
}

function buildApiUrl(baseUrl, route) {
  const base = new URL(baseUrl);
  const normalizedRoute = route.replace(/^\/+/, "");
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return new URL(normalizedRoute, `${base.origin}${basePath}`);
}

async function postDoc(apiBase, apiKey, tenant, doc) {
  const url = buildApiUrl(apiBase, "/v1/docs");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      tenant_id: tenant,
      scope: doc.scope,
      kind: doc.kind,
      title: doc.title,
      slug: doc.slug,
      markdown: doc.markdown
    })
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(`Failed to seed doc ${doc.slug} (${response.status})`);
  }
  return body.data;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const docs = buildSeedDocs(new Date().toISOString().slice(0, 10));
  const results = [];
  for (const doc of docs) {
    const result = await postDoc(options.apiBase, options.apiKey, options.tenant, doc);
    results.push({
      slug: doc.slug,
      created: Boolean(result?.created),
      doc_id: result?.doc?.id ?? null
    });
  }

  const payload = {
    tenant: options.tenant,
    api_base: options.apiBase,
    count: results.length,
    created_count: results.filter((item) => item.created).length,
    updated_count: results.filter((item) => !item.created).length,
    results
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`tenant=${payload.tenant} seeded=${payload.count} created=${payload.created_count} updated=${payload.updated_count}`);
  for (const result of results) {
    console.log(`${result.created ? "created" : "updated"} ${result.slug}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
