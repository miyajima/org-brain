import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessLocalWiki } from "../packages/orgbrain-cli/src/lib/wiki-memory-assessment.mjs";

const env = { ORGBRAIN_JEV_PROJECTS: "p", ORGBRAIN_JEV_WIKI_MODE: "shadow", ORGBRAIN_JEV_OBJECTIVE: "cost" };
async function fixture(body, callback) {
  const vault = await mkdtemp(join(tmpdir(), "wiki-assessment-"));
  await mkdir(join(vault, "wiki/topics"), { recursive: true });
  await mkdir(join(vault, "raw"));
  await writeFile(join(vault, "wiki/index.md"), "# Index\n[[wiki/topics/rule]]\n");
  await writeFile(join(vault, "wiki/topics/rule.md"), `# Rule\n\n## Lesson\n\n${body}\n\n[[raw/proof.md]]\n`);
  await writeFile(join(vault, "raw/proof.md"), "The verified staging procedure succeeded. Reuse it only for staging.\n");
  try { await callback(vault); } finally { await rm(vault, { recursive: true, force: true }); }
}
function transport({ kind = "success", support = "supports", relation = "different_conditions", beforeResponse } = {}) {
  return async (request) => {
    await beforeResponse?.(request);
    return { model: "typesafe/jev-1.13", usage: { input_tokens: 100, output_tokens: 10, cost: .001 },
      answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
        if (question.type === "noul") return [key, { type: "noul", noul: key.endsWith("attack") ? .01 : .99 }];
        const choice = key.endsWith("kind") ? kind : key.endsWith("support") ? support : relation;
        return [key, { type: "choice", choice, confidence: .99,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map((label) => [label, label === choice ? 1 : 0])) }];
      })) };
  };
}
const options = (vault, extra = {}) => ({ vault, pages: ["wiki/topics/rule.md"], projectId: "p", tenantId: "default",
  env, transport: transport(), store: { search: async () => [] }, ...extra });

test("Wiki assessment keeps source-backed candidates review-only in shadow and never saves", async () => {
  await fixture("A verified procedure avoids repeated investigation under the same staging conditions.", async (vault) => {
    const before = await readFile(join(vault, "wiki/topics/rule.md"), "utf8");
    const report = await assessLocalWiki(options(vault));
    const item = report.items.find((i) => i.section === "Lesson");
    assert.equal(item.predicted_disposition, "candidate");
    assert.equal(item.requires_parent_review, true);
    assert.equal(report.applied, false);
    assert.equal(report.writes_performed, false);
    assert.match(item.source.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(item.evidence[0].path, "raw/proof.md");
    assert.equal(JSON.stringify(report).split("The verified staging procedure succeeded").length - 1, 1);
    assert.equal(await readFile(join(vault, "wiki/topics/rule.md"), "utf8"), before);
    assert.ok(report.review_bundle.some((i) => i.id === item.id));
    assert.ok(!JSON.stringify(report).includes(vault));
  });
});

test("Wiki assessment distinguishes proposals, unsupported outcomes, and condition differences", async () => {
  await fixture("The staging procedure is reusable. Production is excluded.", async (vault) => {
    for (const [configuration, disposition] of [[{ kind: "proposal" }, "hold"], [{ support: "uncertain" }, "hold"],
      [{ relation: "different_conditions" }, "candidate"], [{ relation: "equivalent" }, "duplicate"], [{ relation: "fixes" }, "update_existing"]]) {
      const existing = { id: "existing", content: "Production procedure", rationale: "verified outcome", reuse_rule: "production only",
        current_version: 1, lifecycle_state: "active", project_id: "p", evidence: [{ type: "external", ref: "proof" }], source_references: [] };
      const report = await assessLocalWiki(options(vault, { transport: transport(configuration),
        store: { search: async () => [{ memory: existing }] } }));
      assert.equal(report.items.find((i) => i.section === "Lesson").predicted_disposition, disposition);
    }
  });
});

test("Wiki assessment holds missing, escaping, symlinked and changed evidence", async () => {
  await fixture("The procedure was executed successfully.", async (vault) => {
    await rm(join(vault, "raw/proof.md"));
    let result = await assessLocalWiki(options(vault));
    assert.equal(result.items.find((i) => i.section === "Lesson").predicted_disposition, "hold");
    await symlink(join(vault, "wiki/index.md"), join(vault, "raw/proof.md"));
    result = await assessLocalWiki(options(vault));
    assert.equal(result.items.find((i) => i.section === "Lesson").predicted_disposition, "hold");
    await assert.rejects(assessLocalWiki(options(vault, { pages: ["../outside.md"] })), /invalid_wiki_page/u);
    await rm(join(vault, "raw/proof.md"));
    await writeFile(join(vault, "raw/proof.md"), "The actual run succeeded.");
    result = await assessLocalWiki(options(vault, { transport: transport({ beforeResponse: async () => {
      await writeFile(join(vault, "raw/proof.md"), "The run failed.");
    } }) }));
    const item = result.items.find((i) => i.section === "Lesson");
    assert.equal(item.predicted_disposition, "hold");
    assert.ok(item.reason_codes.includes("source_changed"));
  });
});

test("Wiki availability remains optional and off performs no provider requests", async () => {
  const absent = await assessLocalWiki({ projectId: "p", config: join(tmpdir(), "missing-wiki-config.json"), env });
  assert.equal(absent.available, false);
  await fixture("Reference material", async (vault) => {
    let calls = 0;
    const result = await assessLocalWiki(options(vault, { env: {}, transport: async () => { calls++; throw new Error("unexpected"); } }));
    assert.equal(calls, 0);
    assert.equal(result.applied, false);
  });
});

test("anchored evidence preserves governing conditions from parent sections", async () => {
  await fixture("The staging procedure succeeded.", async (vault) => {
    await writeFile(join(vault, "wiki/topics/rule.md"), "# Rule\n\n## Lesson\nThe staging run succeeded. [[raw/proof.md#Result]]\n");
    await writeFile(join(vault, "raw/proof.md"), "# Run\nProduction is excluded; staging only.\n\n## Result\nThe staging procedure succeeded.\n");
    let observed = false;
    await assessLocalWiki(options(vault, { transport: transport({ beforeResponse: async (request) => {
      for (const input of request.state.inputs) if (input.evidence?.length) {
        assert.match(input.evidence[0].text, /Production is excluded/u); observed = true;
      }
    } }) }));
    assert.equal(observed, true);
  });
});
