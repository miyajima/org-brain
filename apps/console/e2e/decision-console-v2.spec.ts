import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { auditUrl } from "./route-audit-cases";

const decisionId = "decision-console-e2e";

test.describe("Decision-first Console v2", () => {
  test("keeps the Decision index and legacy editor redirects scope-safe", async ({ page }) => {
    await page.goto(auditUrl("/decisions?q=cache", "ja"));
    await expect(page.getByRole("heading", { level: 1, name: "Decision Briefing" })).toBeVisible();
    let target = new URL(page.url());
    expect(target.pathname).toBe("/");
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      q: "cache",
      tenant_id: "default",
      project_id: "org-brain",
      lang: "ja"
    });

    await page.goto(auditUrl("/decisions?selected=" + decisionId + "&q=cache", "ja"));
    await expect(page.getByRole("heading", { level: 1, name: "決定を編集" })).toBeVisible();
    target = new URL(page.url());
    expect(target.pathname).toBe("/decisions/new");
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      edit: decisionId,
      q: "cache",
      tenant_id: "default",
      project_id: "org-brain",
      lang: "ja"
    });
  });

  test("reaches the complete decision trace from the briefing in one transition", async ({ page }) => {
    await page.goto(auditUrl("/", "ja"));
    await expect(page.getByRole("heading", { level: 1, name: "Decision Briefing" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Org Brain" }).getByRole("link", { name: "決定" })).toBeVisible();
    await page.getByRole("link", { name: "Keep decision context visible" }).click();
    await expect(page).toHaveURL(new RegExp(`/decisions/${decisionId}`));
    await expect(page.getByRole("heading", { level: 1, name: "Keep decision context visible" })).toBeVisible();
    for (const stage of ["決定", "理由", "根拠", "成果物", "Skill", "利用Agent", "結果"]) {
      await expect(page.locator(".decision-trace-rail").getByRole("heading", { name: stage, exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: /Verified usability note/ }).click();
    await expect(page.locator("[data-preview-label]")).toHaveText("Verified usability note");
  });

  test("generates a private Skill draft from the selected immutable decision version", async ({ page }) => {
    await page.goto(auditUrl(`/decisions/${decisionId}`, "ja"));
    await page.getByRole("link", { name: "この知識をSkill化" }).click();
    await expect(page).toHaveURL(/\/skills\?/u);
    await expect(page.locator("[data-generation-wizard]")).toContainText(decisionId);
    await expect(page.locator("#skill-source-help")).toContainText("e2e-source-h");
    await page.locator("[data-skill-generate-form] textarea[name=instructions]").fill("権限確認と完了条件を含める");
    await page.getByRole("button", { name: "private draftを生成" }).click();
    await expect(page.locator("[data-generation-result]")).toBeVisible();
    await expect(page.locator("[data-generation-task]")).toHaveText("task-generation-e2e");
    await expect(page.locator("[data-generation-status]")).toContainText("private draft");
  });

  test("keeps the accessible map operable and reveals inferred relationships only after opt-in", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(auditUrl(`/map?decision_id=${decisionId}`, "en"));
    await expect(page.getByRole("heading", { level: 1, name: "Decision Trace Map" })).toBeVisible();
    await expect(page.locator("[data-map-fallback]")).toBeVisible();
    const nodes = page.locator(".decision-map-list [data-map-node]");
    await expect(nodes).toHaveCount(7);
    await nodes.first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(nodes.nth(1)).toBeFocused();
    await page.locator("[data-inferred-toggle]").check();
    await expect(page.getByRole("button", { name: /Suggested follow-up/ }).first()).toBeVisible();
    await expect(page.locator("[data-map-preview-facts]")).toContainText("Connections");
    await expect(page.locator("[data-map-preview-connections-list] button").first()).toBeVisible();
    await expect(page.locator("[data-map-fit]")).toHaveAttribute("aria-label", "Fit the complete decision trace in view");
    await expect(page.locator(".decision-map-legend")).toContainText("Stage and relationship legend");
    await nodes.nth(1).press("Enter");
    await expect(nodes.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(page.locator("[data-map-selection-status]")).toContainText("Selected node:");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".decision-map-timeline")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });

  test("keeps the all-knowledge map and first map action in view", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(auditUrl("/map", "ja"));
    const allKnowledge = page.getByRole("link", { name: "全知識を表示" });
    const picker = page.locator(".decision-map-picker");
    await expect(allKnowledge).toBeVisible();
    await expect(picker.locator("summary")).toBeVisible();
    expect(await allKnowledge.evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    expect(await picker.locator("summary").evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    await expect(picker).not.toHaveAttribute("open", "");
    await picker.locator("summary").click();
    await expect(picker.locator("[data-map-picker-search]")).toBeVisible();
    await expect(page.locator("[data-map-glow=ambient-selection]")).toHaveCount(0);
    await allKnowledge.click();
    await expect(page).toHaveURL(/\/memories\/constellation\?.*view=all/u);
    await expect(page.locator("[data-map-mode-badge]")).toHaveText("閲覧可能な全ノード");
    await expect(page.locator("[data-map-visible-count]")).toHaveText("62");
    await expect(page.locator("[data-map-mode-toggle]")).toHaveText("代表表示に戻す");
    expect(await page.locator("[data-map-accessible-search]").evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);

    await page.goto(auditUrl(`/map?decision_id=${decisionId}`, "ja"));
    await expect(page.locator("[data-map-glow=ambient-selection]")).toBeVisible();
  });

  for (const width of [320, 768] as const) {
    test(`keeps decision map controls usable without horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(auditUrl(`/map?decision_id=${decisionId}`, "ja"));
      await expect(page.locator("[data-map-fit]")).toBeVisible();
      await expect(page.locator("[data-map-canvas]")).toHaveAttribute("aria-describedby", "decision-map-instructions");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (width === 320) {
        await expect(page.locator(".decision-map-picker")).not.toHaveAttribute("open", "");
        await expect(page.locator(".decision-map-picker summary")).toBeVisible();
      }
    });
  }

  for (const [locale, title] of [["en", "Decision Trace Map"], ["ja", "決定の道筋マップ"], ["zh", "决策路径地图"]] as const) {
    test(`keeps the map selection contract accessible in ${locale}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(auditUrl(`/map?decision_id=${decisionId}`, locale));
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.locator("[data-map-canvas]")).toHaveAttribute("role", "img");
      await expect(page.locator("[data-map-fit]")).toBeVisible();
      const selected = page.locator("[data-map-node][aria-pressed='true']").first();
      await selected.press("Enter");
      await expect(selected).toHaveAttribute("aria-current", "true");
      await expect(page.locator("[data-map-selection-status]")).not.toHaveText("");
      await expect(page.locator(".decision-map-legend")).toBeVisible();
    });
  }

  for (const locale of ["en", "ja", "zh"] as const) {
    test(`has no WCAG A/AA violations in the decision map for ${locale}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(auditUrl(`/map?decision_id=${decisionId}`, locale));
      const results = await new AxeBuilder({ page })
        .include("[data-decision-map]")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test("previews effective Agent context and exposes the shared access drawer", async ({ page }) => {
    await page.goto(auditUrl("/agents?agent_id=agent-e2e", "en"));
    await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Release reviewer", exact: true })).toBeVisible();
    await expect(page.locator("[data-binding-row][data-skill-id=skill-e2e] input[name=enabled]")).toBeChecked();
    await page.locator("[data-context-preview-form] textarea").fill("Review the release decision");
    await page.getByRole("button", { name: "Resolve context" }).click();
    await expect(page.locator("[data-context-result]")).toBeVisible();
    await expect(page.locator("[data-context-injected]")).toContainText("Decision rollout checklist");
    await expect(page.locator("[data-context-on-demand]")).toContainText("orgbrain://skills/");
    await expect(page.locator("[data-context-omitted]")).toContainText("not_published");

    await page.getByRole("button", { name: "Access" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Access & storage" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("user:e2e-login-sub");
    await dialog.getByLabel("Visibility").selectOption("tenant");
    await dialog.getByRole("button", { name: "Save access" }).click();
    await expect(dialog).toContainText("Access updated");
  });

  for (const locale of ["en", "ja", "zh"] as const) {
    test(`has no WCAG A/AA violations in the decision detail for ${locale}`, async ({ page }) => {
      await page.goto(auditUrl(`/decisions/${decisionId}`, locale));
      await expect(page.locator("main h1")).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
});
