import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const evaluationBundle = {
  contract: "orgbrain-memory-extraction-evaluation/v1",
  set_id: "evaluation-ui-e2e",
  frozen_at: "2026-09-03T00:00:00.000Z",
  guideline_version: "2026-09-03",
  cases: [
    {
      id: "calibration-001",
      phase: "calibration",
      cohort: "decision",
      source_hash: "sha256:calibration-001",
      turns: [
        { id: "turn-user-1", role: "user", content: "<proposed_plan>[docs/plan.md](docs/plan.md) の方針として、今後ローカル評価データはSQLiteに保存してください。</proposed_plan>" },
        { id: "turn-assistant-1", role: "assistant", content: "SQLiteを標準保存先として実装しました。" }
      ],
      model_prediction: { outcome: "candidate", lesson_types: ["decision"] }
    },
    {
      id: "locked-001",
      phase: "locked",
      cohort: "non_durable",
      source_hash: "sha256:locked-001",
      turns: [{ id: "turn-assistant-2", role: "assistant", content: "これからファイルを確認します。" }]
    }
  ]
};
const realEvaluationBundlePath = process.env.ORGBRAIN_EVALUATION_BUNDLE;
const routerV32Bundle = {
  contract: "memory-extraction-router-v32-review/v1",
  experiment_manifest: {
    contract: "memory-extraction-router-v32-manifest/v1",
    experiment_id: "router-v32-ui-e2e",
    dataset_role: "development",
    blind: true,
    case_count: 1
  },
  cases: [{
    id: "router-v32-case-1",
    source_hash: "sha256:router-v32-case-1",
    review_text_contract: "orgbrain-memory-extraction-review-text/v1",
    review_text_hash: "sha256:router-v32-review-text-1",
    session_hash: "session-router-v32-case-1",
    group_id: "group-router-v32-case-1",
    dataset_role: "development",
    turns: [{ id: "router-v32-turn-1", role: "user", content: "決定事項としてSQLiteを採用する。" }]
  }]
};

async function loadBundle(page: import("@playwright/test").Page) {
  await page.locator("[data-bundle-input]").setInputFiles({
    name: "evaluation-ui-e2e.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(evaluationBundle))
  });
}

async function loadPrefilledBundle(page: import("@playwright/test").Page) {
  const prefilled: any = structuredClone(evaluationBundle);
  prefilled.ai_prefill = {
    contract: "orgbrain-memory-extraction-ai-prefill/v1",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    generated_at: "2026-09-04T00:00:00.000Z",
    completed_cases: 2
  };
  prefilled.cases[0].ai_draft = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    source_hash: "sha256:calibration-001",
    outcome: "candidate",
    usefulness: "durable_memory",
    lesson_types: ["decision"],
    support_spans: [{ turn_id: "turn-assistant-1", quote: "SQLiteを標準保存先として実装しました。", start: 0, end: 22 }],
    exclusion_reason: "",
    confidence: "high",
    rationale: "標準保存先を定めた再利用可能な決定です。",
    generated_at: "2026-09-04T00:00:00.000Z"
  };
  prefilled.cases[1].ai_draft = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    source_hash: "sha256:locked-001",
    outcome: "no_candidate",
    usefulness: "not_useful",
    lesson_types: [],
    support_spans: [],
    exclusion_reason: "",
    confidence: "high",
    rationale: "一時的な作業予告で、将来再利用できる知識ではありません。",
    generated_at: "2026-09-04T00:00:00.000Z"
  };
  await page.locator("[data-bundle-input]").setInputFiles({
    name: "evaluation-ui-prefilled-e2e.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(prefilled))
  });
}

async function loadRouterV32Bundle(page: import("@playwright/test").Page) {
  await page.locator("[data-bundle-input]").setInputFiles({
    name: "router-v32-ui-e2e.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(routerV32Bundle))
  });
}

test.describe("direct-only memory extraction evaluation", () => {
  test("shows prefilled Sol high drafts without applying them to human answers", async ({ page }) => {
    await page.goto("/admin/memory-extraction-evaluation");
    await loadPrefilledBundle(page);
    await expect(page.getByText("gpt-5.6-sol/highの事前評価です。内容を確認してから人の回答へ反映してください。")).toBeVisible();
    await expect(page.locator("[data-ai-draft-outcome]")).toHaveText("候補あり");
    await expect(page.getByRole("button", { name: "再評価", exact: true })).toBeVisible();
    await expect(page.locator('input[name="outcome"]:checked')).toHaveCount(0);
    await page.getByRole("button", { name: "この下書きを反映" }).click();
    await expect(page.locator('input[name="outcome"][value="candidate"]')).toBeChecked();
  });

  test("reviews a v3.2 blind case with mandatory future-use text and no AI panel", async ({ page }) => {
    await page.goto("/admin/memory-extraction-evaluation");
    await loadRouterV32Bundle(page);
    await expect(page.locator("[data-progress-count]")).toHaveText("0 / 1");
    await expect(page.locator("[data-ai-draft-panel]")).toBeHidden();
    await expect(page.getByText("model_prediction", { exact: false })).toHaveCount(0);
    await page.locator('input[name="outcome"][value="candidate"]').check();
    await page.locator('input[name="lesson_type"][value="decision"]').check();
    await page.locator('input[name="confidence"][value="high"]').check();
    await page.locator('textarea[name="future_use"]').fill("構成を選ぶときに参照する");
    const content = page.locator("[data-turn-id='router-v32-turn-1']");
    await content.evaluate((element) => {
      const text = element.firstChild;
      if (!text) throw new Error("missing text node");
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, text.textContent?.length ?? 0);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.locator(".episode-turn").first().getByRole("button", { name: "選択範囲を追加" }).click();
    await page.getByRole("button", { name: "評価を確定", exact: true }).click();
    await expect(page.locator("[data-progress-count]")).toHaveText("1 / 1");
    await expect(page.getByRole("button", { name: "回答JSONを書き出す" })).toBeEnabled();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "回答JSONを書き出す" }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(exported.annotations["router-v32-case-1"]).toMatchObject({ review_status: "accepted", future_use: "構成を選ぶときに参照する" });
    expect(JSON.stringify(exported)).not.toContain("model_prediction");
  });

  test("creates a Sol high draft, applies it explicitly, and records AI assistance", async ({ page }) => {
    await page.goto("/admin/memory-extraction-evaluation");
    await loadBundle(page);
    await expect(page.locator("[data-turn-id='turn-user-1']")).toContainText("今後ローカル評価データはSQLiteに保存してください。");
    await expect(page.getByText("docs/plan.md", { exact: false })).toHaveCount(0);
    await expect(page.getByText("proposed_plan", { exact: false })).toHaveCount(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "AI評価", exact: true }).click();

    await expect(page.getByText("AI下書きができました。内容を確認してから反映してください。")).toBeVisible();
    await expect(page.locator("[data-ai-draft-outcome]")).toHaveText("候補あり");
    await expect(page.locator("[data-ai-draft-usefulness]")).toHaveText("永続化対象");
    await expect(page.locator("[data-ai-draft-spans] li")).toHaveCount(1);
    await expect(page.locator('input[name="outcome"]:checked')).toHaveCount(0);

    await page.getByRole("button", { name: "この下書きを反映" }).click();
    await expect(page.locator('input[name="outcome"][value="candidate"]')).toBeChecked();
    await expect(page.locator('input[name="lesson_type"][value="decision"]')).toBeChecked();
    await expect(page.locator('input[name="confidence"][value="high"]')).toBeChecked();
    await expect(page.locator("[data-evidence-list] li")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "この下書きを反映" })).toBeDisabled();
    const stored = await page.evaluate(() => localStorage.getItem("orgbrain:memory-extraction-evaluation:v1:evaluation-ui-e2e"));
    expect(stored).toContain('"model":"gpt-5.6-sol"');
    expect(stored).toContain('"reasoning_effort":"high"');
  });

  test("loads a bundle from an explicit loopback-only URL", async ({ page }) => {
    await page.route("http://127.0.0.1:18766/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(evaluationBundle)
      });
    });
    await page.goto("/admin/memory-extraction-evaluation?local_bundle_url=http%3A%2F%2F127.0.0.1%3A18766%2Fbundle.json");
    await expect(page.locator("[data-progress-count]")).toHaveText("0 / 2");
    await expect(page).toHaveURL(/\/admin\/memory-extraction-evaluation$/u);
  });

  test("loads a 500-case bundle without exposing predictions", async ({ page }) => {
    // Keep the scale regression reproducible without private local evaluation data.
    // An explicit bundle still exercises the same assertions when supplied.
    const bundle = realEvaluationBundlePath
      ? JSON.parse(readFileSync(realEvaluationBundlePath, "utf8"))
      : {
          ...evaluationBundle,
          set_id: "synthetic-500-case-e2e",
          cases: Array.from({ length: 500 }, (_, index) => ({
            ...evaluationBundle.cases[index < 75 ? 0 : 1],
            id: `synthetic-case-${index}`,
            source_hash: `sha256:synthetic-case-${index}`
          }))
        };
    await page.goto("/admin/memory-extraction-evaluation");
    await page.locator("[data-bundle-input]").setInputFiles({
      name: "500-case-evaluation.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(bundle))
    });

    await expect(page.locator("[data-progress-count]")).toHaveText("0 / 500");
    await expect(page.locator("[data-case-list] button")).toHaveCount(500);
    await expect(page.locator("[data-case-list] button").nth(74)).toBeEnabled();
    await expect(page.locator("[data-case-list] button").nth(75)).toBeDisabled();
    await expect(page.locator("[data-turns] .turn-content").first()).not.toBeEmpty();
    await expect(page.getByText("model_prediction", { exact: false })).toHaveCount(0);

    await page.locator('input[name="outcome"][value="no_candidate"]').check();
    await page.locator('input[name="confidence"][value="medium"]').check();
    const stored = await page.evaluate((setId) => localStorage.getItem(
      `orgbrain:memory-extraction-evaluation:v1:${setId}`
    ), bundle.set_id);
    expect(stored).toContain('"outcome":"no_candidate"');

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "回答JSONを書き出す" }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).not.toContain("model_prediction");
  });

  test("is absent from navigation and stores a blinded calibration label locally", async ({ page }) => {
    const response = await page.goto("/admin/memory-extraction-evaluation");
    expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.getByRole("heading", { name: "記憶抽出の人手評価" })).toBeVisible();
    await expect(page.locator('nav a[href*="memory-extraction-evaluation"]')).toHaveCount(0);

    await loadBundle(page);
    await expect(page.getByText("calibration-001", { exact: true })).toBeVisible();
    await expect(page.getByText("model_prediction", { exact: false })).toHaveCount(0);
    const lockedCase = page.locator("[data-case-list] button").nth(1);
    await expect(lockedCase).toBeDisabled();

    await page.locator('input[name="outcome"][value="candidate"]').check();
    await page.locator('input[name="lesson_type"][value="decision"]').check();
    const content = page.locator("[data-turn-id='turn-user-1']");
    await content.evaluate((element) => {
      const text = element.firstChild;
      if (!text) throw new Error("missing text node");
      const range = document.createRange();
      range.setStart(text, 2);
      range.setEnd(text, 17);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.locator(".episode-turn").first().getByRole("button", { name: "選択範囲を追加" }).click();
    await page.locator('input[name="confidence"][value="high"]').check();

    await expect(page.locator("[data-evidence-list] li")).toHaveCount(1);
    await expect(lockedCase).toBeEnabled();
    const stored = await page.evaluate(() => localStorage.getItem("orgbrain:memory-extraction-evaluation:v1:evaluation-ui-e2e"));
    expect(stored).toContain('"outcome":"candidate"');

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "回答JSONを書き出す" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("evaluation-ui-e2e-annotations.json");
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(exported).toMatchObject({
      contract: "orgbrain-memory-extraction-annotations/v1",
      set_id: "evaluation-ui-e2e",
      annotations: { "calibration-001": { outcome: "candidate", lesson_types: ["decision"] } }
    });
    expect(JSON.stringify(exported)).not.toContain("model_prediction");

    await page.getByRole("button", { name: "完了して次へ" }).click();
    await expect(page.getByText("locked-001", { exact: true })).toBeVisible();
  });

  test("restores local progress after loading the same frozen set again", async ({ page }) => {
    await page.goto("/admin/memory-extraction-evaluation");
    await page.evaluate((progress) => {
      localStorage.setItem("orgbrain:memory-extraction-evaluation:v1:evaluation-ui-e2e", JSON.stringify(progress));
    }, {
      contract: "orgbrain-memory-extraction-annotations/v1",
      source_contract: "orgbrain-memory-extraction-evaluation/v1",
      set_id: "evaluation-ui-e2e",
      reviewer_id: "reviewer-local",
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:01:00.000Z",
      annotations: {
        "calibration-001": {
          case_id: "calibration-001",
          outcome: "no_candidate",
          lesson_types: [],
          evidence_spans: [],
          exclusion_reason: "",
          confidence: "medium",
          note: "",
          started_at: "2026-09-03T00:00:00.000Z",
          updated_at: "2026-09-03T00:01:00.000Z",
          completed_at: "2026-09-03T00:01:00.000Z"
        }
      }
    });
    await loadBundle(page);
    await page.locator("[data-case-list] button").first().click();
    await expect(page.locator('input[name="outcome"][value="no_candidate"]')).toBeChecked();
    await expect(page.locator('input[name="confidence"][value="medium"]')).toBeChecked();
    await expect(page.locator("[data-case-list] button").nth(1)).toBeEnabled();
  });

  test("keeps the loaded review workspace accessible and free of page overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/memory-extraction-evaluation");
    await loadBundle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
