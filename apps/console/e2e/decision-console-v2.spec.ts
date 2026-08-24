import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { auditUrl } from "./route-audit-cases";

const decisionId = "decision-console-e2e";

test.describe("Decision-first Console v2", () => {
  test("moves keyboard focus to the main content from the skip link", async ({ page }) => {
    await page.goto(auditUrl("/", "ja"));
    await page.getByRole("link", { name: "メインコンテンツへ移動" }).press("Enter");
    await expect(page.locator("#console-main")).toBeFocused();
  });

  test("keeps an archived configured tenant visibly in team scope", async ({ page }) => {
    await page.goto(auditUrl("/?tenant_id=archived-team-e2e", "ja"));
    await expect(page.locator(".console-context-chip")).toContainText("チーム · archived-team-e2e");
    await page.getByRole("navigation", { name: "Org Brain" }).getByText("管理", { exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Org Brain" }).getByRole("link", { name: "グループ" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Org Brain" }).getByRole("link", { name: "ユーザー" })).toBeVisible();
  });


  test("keeps the Decision index and legacy editor redirects scope-safe", async ({ page }) => {
    await page.goto(auditUrl("/decisions?q=cache", "ja"));
    await expect(page.getByRole("heading", { level: 1, name: "決定一覧" })).toBeVisible();
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

  test("keeps briefing controls in the mobile first viewport and syncs shareable filter state", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(auditUrl("/?briefing_filter=changed&briefing_q=decision", "ja"));
    const search = page.locator("[data-briefing-search]");
    await expect(search).toHaveValue("decision");
    expect(await search.evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    expect(await page.locator("[data-briefing-card]").first().evaluate((element) => element.getBoundingClientRect().top <= window.innerHeight)).toBe(true);
    expect(await page.locator("[data-briefing-card]").first().locator(".decision-brief-aside .decision-action").evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    await page.locator(".decision-filter-tabs").getByRole("button", { name: /^すべて\s+\d+/u }).click();
    expect(new URL(page.url()).searchParams.has("briefing_filter")).toBe(false);
    await search.fill("decision");
    expect(new URL(page.url()).searchParams.get("briefing_q")).toBe("decision");
  });

  test("keeps ten decisions scannable with counts, sorting, and wrapped mobile filters", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(auditUrl("/", "ja"));
    await expect(page.locator("[data-briefing-card]")).toHaveCount(10);
    await expect(page.locator("[data-briefing-result-count]")).toContainText("10件を表示");
    const filters = page.locator(".decision-filter-tabs");
    expect(await filters.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await page.locator("select[data-briefing-sort]").selectOption("updated");
    await expect.poll(() => new URL(page.url()).searchParams.get("briefing_sort")).toBe("updated");
    await page.locator("[data-briefing-search]").fill("監査ログ");
    await expect(page.locator("[data-briefing-result-count]")).toContainText("1件を表示");
    await expect(page.locator("[data-briefing-card]:visible")).toHaveCount(1);
  });

  test("keeps a forty-decision synthetic fixture searchable without changing the API contract", async ({ page }) => {
    await page.goto(auditUrl("/?tenant_id=scale-40-e2e", "ja"));
    await expect(page.locator("[data-briefing-card]")).toHaveCount(40);
    await expect(page.locator("[data-briefing-result-count]")).toContainText("40件を表示");
    await page.locator("[data-briefing-search]").fill("共有前にアクセス範囲を確定する 40");
    await expect(page.locator("[data-briefing-card]:visible")).toHaveCount(1);
    await expect(page.locator("[data-briefing-result-count]")).toContainText("1件を表示");
  });

  test("shows each review decision once and consolidates the all-clear state", async ({ page }) => {
    await page.goto(auditUrl("/reviews", "ja"));
    await expect(page.locator("[data-review-decision]")).toHaveCount(7);
    await expect(page.locator(".decision-review-queue > header > strong")).toContainText("9 件の確認事項");
    await expect(page.locator('[data-review-decision="decision-scale-02"] .decision-flag-row span')).toHaveCount(2);

    await page.goto(auditUrl("/reviews?tenant_id=empty-review-e2e", "ja"));
    await expect(page.locator(".decision-review-clear")).toContainText("要確認の決定はありません");
    await expect(page.locator(".decision-review-queue")).toHaveCount(0);
  });

  test("keeps Agent preview controls within the mobile viewport and preserves navigation context", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(auditUrl("/agents?agent_id=agent-e2e&decision_id=" + decisionId + "&source_hash=e2e-source-h", "ja"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const preview = page.locator(".agent-context-preview");
    const submit = page.locator("[data-context-preview-form] button[type=submit]");
    const mobileSubmit = page.locator("[data-context-mobile-submit]");
    expect(await preview.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    expect(await submit.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    await expect(mobileSubmit).toBeVisible();
    expect(await mobileSubmit.evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    await page.getByRole("navigation", { name: "Org Brain" }).getByText("メニュー", { exact: true }).click();
    await page.getByRole("navigation", { name: "Org Brain" }).getByRole("link", { name: "スキル" }).click();
    expect(new URL(page.url()).searchParams.get("decision_id")).toBe(decisionId);
    expect(new URL(page.url()).searchParams.get("source_hash")).toBe("e2e-source-h");
  });

  test("preserves Map and Skill inventory search state in shareable URLs", async ({ page }) => {
    await page.goto(auditUrl("/map?map_q=cache", "ja"));
    const picker = page.locator(".decision-map-picker");
    await picker.locator("summary").click();
    const mapSearch = picker.locator("[data-map-picker-search]");
    await expect(mapSearch).toHaveValue("cache");
    await mapSearch.fill("decision");
    await expect.poll(() => new URL(page.url()).searchParams.get("map_q")).toBe("decision");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(auditUrl(`/skills?decision_id=${decisionId}&source_hash=e2e-source-h&skill_q=rollout`, "ja"));
    const skillSearch = page.locator("[data-skill-search]");
    await expect(skillSearch).toHaveValue("rollout");
    await expect(page.locator("[data-skill-mobile-submit]")).toBeVisible();
    expect(await page.locator("[data-skill-mobile-submit]").evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
    await skillSearch.fill("checklist");
    await expect.poll(() => page.evaluate(() => new URL(window.location.href).searchParams.get("skill_q"))).toBe("checklist");
  });

  test("reaches the complete decision trace from the briefing in one transition", async ({ page }) => {
    await page.goto(auditUrl("/", "ja"));
    await expect(page.getByRole("heading", { level: 1, name: "決定一覧" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Org Brain" }).getByRole("link", { name: "決定" })).toBeVisible();
    await page.getByRole("link", { name: "Keep decision context visible" }).click();
    await expect(page).toHaveURL(new RegExp(`/decisions/${decisionId}`));
    await expect(page.getByRole("heading", { level: 1, name: "Keep decision context visible" })).toBeVisible();
    for (const stage of ["決定", "理由", "根拠", "成果物", "スキル", "利用するエージェント", "結果"]) {
      await expect(page.locator(".decision-trace-rail").getByRole("heading", { name: stage, exact: true })).toBeVisible();
    }
    await page.getByRole("button", { name: /Verified usability note/ }).click();
    await expect(page.locator("[data-preview-label]")).toHaveText("Verified usability note");
  });

  test("generates a private Skill draft from the selected immutable decision version", async ({ page }) => {
    await page.goto(auditUrl(`/decisions/${decisionId}`, "ja"));
    await page.getByRole("link", { name: "この知識からスキルを作成" }).click();
    await expect(page).toHaveURL(/\/skills\?/u);
    await expect(page.locator("[data-generation-wizard]")).toContainText(decisionId);
    await expect(page.locator("#skill-source-help")).toContainText("e2e-source-h");
    await page.locator("[data-skill-generate-form] textarea[name=instructions]").fill("権限確認と完了条件を含める");
    await page.getByRole("button", { name: "非公開の下書きを生成" }).click();
    await expect(page.locator("[data-generation-result]")).toBeVisible();
    await expect(page.locator("[data-generation-result]")).toBeFocused();
    await expect(page.locator("[data-generation-task]")).toHaveText("task-generation-e2e");
    await expect(page.locator("[data-generation-status]")).toHaveText("非公開の下書きを生成しました。まだ公開されていません。");
    await expect(page.locator("[data-generation-refresh]")).toHaveText("下書きの内容を確認");
  });

  test("keeps the accessible map operable and reveals inferred relationships only after opt-in", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(auditUrl(`/map?decision_id=${decisionId}`, "en"));
    await expect(page.getByRole("heading", { level: 1, name: "Decision Trace Map" })).toBeVisible();
    await expect(page.locator("[data-map-fallback]")).toBeVisible();
    await expect(page.locator("[data-map-canvas]")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("[data-map-status]")).toHaveText("The accessible 2D view is active.");
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
    await expect(page.locator("[data-map-content]")).toBeHidden();
    await allKnowledge.click();
    await expect(page).toHaveURL(/\/memories\/constellation\?.*view=all/u);
    await expect(page.locator("[data-map-mode-badge]")).toHaveText("閲覧可能な全ノード");
    await expect(page.locator("[data-map-visible-count]")).toHaveText("62");
    await expect(page.locator("[data-map-mode-toggle]")).toHaveText("代表表示に戻す");
    expect(await page.locator("[data-map-accessible-search]").evaluate((element) => element.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);

    await page.goto(auditUrl(`/map?decision_id=${decisionId}`, "ja"));
    await expect(page.locator("[data-map-glow=ambient-selection]")).toBeVisible();
  });

  test("limits the decision picker, reports results, and explains a zero-match search", async ({ page }) => {
    await page.goto(auditUrl("/map", "ja"));
    const picker = page.locator(".decision-map-picker");
    await picker.locator("summary").click();
    await expect(picker.locator("[data-map-picker-item]:visible")).toHaveCount(6);
    await expect(picker.locator("[data-map-picker-result]")).toContainText("10件中、先頭の6件");
    await picker.locator("[data-map-picker-search]").fill("一致しない検索語");
    await expect(picker.locator("[data-map-picker-item]:visible")).toHaveCount(0);
    await expect(picker.locator("[data-map-picker-empty]")).toBeVisible();
    await expect(picker.locator("[data-map-picker-result]")).toContainText("0件");
  });

  test("labels an all-node view honestly when the 1,500-memory ceiling truncates it", async ({ page }) => {
    await page.goto(auditUrl("/memories/constellation?view=all&project_id=e2e-map-truncated", "ja"));
    await expect(page.locator("[data-map-mode-badge]")).toHaveText("表示上限まで表示");
    await expect(page.locator("[data-map-truncated]")).toContainText("表示上限により一部ノードを省略しています");
    await expect(page.locator("[data-map-truncated]")).toContainText("/ 2400");
  });

  test("keeps the map action rail visible while reaching the relationship list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(auditUrl(`/map?decision_id=${decisionId}`, "ja"));
    const rail = page.locator(".decision-map-action-rail");
    await page.locator(".decision-map-list button").first().scrollIntoViewIfNeeded();
    await expect(rail).toBeInViewport();
    await expect(rail.locator("[data-all-knowledge-map]")).toBeInViewport();
  });

  test("updates a searched decision in place without reloading or requiring another page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(auditUrl("/map", "ja"));
    await page.evaluate(() => Object.assign(window, { __decisionMapPageMarker: "preserved" }));

    const picker = page.locator(".decision-map-picker");
    await picker.locator("summary").click();
    await picker.locator("[data-map-picker-search]").fill("Keep decision");
    const item = picker.locator("[data-map-picker-item]:visible");
    await expect(item).toHaveCount(1);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await item.click();

    await expect(page).toHaveURL(/decision_id=decision-console-e2e/u);
    await expect(picker).not.toHaveAttribute("open", "");
    await expect(page.locator("[data-map-content]")).toBeVisible();
    await expect(page.locator("[data-node-count]")).toHaveText("7");
    await expect(page.locator("[data-map-preview-label]")).toHaveText("Keep decision context visible");
    await expect(page.locator("[data-map-list-action]")).toBeVisible();
    expect(await page.evaluate(() => (window as typeof window & { __decisionMapPageMarker?: string }).__decisionMapPageMarker)).toBe("preserved");
    expect(Math.abs(await page.evaluate(() => window.scrollY) - scrollBefore)).toBeLessThanOrEqual(16);
    expect(await page.locator("[data-map-content]").evaluate((element) => element.getBoundingClientRect().top < window.innerHeight)).toBe(true);
  });

  test("keeps the latest in-place map selection when responses finish out of order", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/v1/decisions/race-*/map*", async (route) => {
      const decision = new URL(route.request().url()).pathname.split("/").at(-2) || "";
      if (decision === "race-slow") await new Promise((resolve) => setTimeout(resolve, 180));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            nodes: [{ id: decision, stage: "decision", label: decision === "race-fast" ? "Latest decision" : "Stale decision", summary: decision, status: "active", metadata: {} }],
            edges: [],
            truncated: false,
            omitted_node_count: 0,
            omitted_edge_count: 0
          }
        })
      });
    });
    await page.goto(auditUrl("/map", "en"));

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("orgbrain:decision-map-select", { detail: { decisionId: "race-slow" } }));
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("orgbrain:decision-map-select", { detail: { decisionId: "race-fast" } }));
      }, 10);
    });

    await expect(page.locator("[data-map-preview-label]")).toHaveText("Latest decision");
    await page.waitForTimeout(250);
    await expect(page.locator("[data-map-preview-label]")).toHaveText("Latest decision");
    await expect(page.locator("[data-decision-map]")).toHaveAttribute("data-api-path", "/api/v1/decisions/race-fast/map");
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

  for (const [path, title] of [
    [`/skills?decision_id=${decisionId}&source_hash=e2e-source-h&start=generate`, "スキル"],
    ["/agents?agent_id=agent-e2e", "エージェント"],
    ["/reviews", "要確認の決定"]
  ] as const) {
    test(`has no WCAG A/AA violations on the V2 ${title} screen`, async ({ page }) => {
      await page.goto(auditUrl(path, "ja"));
      await expect(page.locator("main h1")).toHaveText(title);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test("keeps V2 asset screens usable in landscape without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    for (const path of [
      `/skills?decision_id=${decisionId}&source_hash=e2e-source-h&start=generate`,
      "/agents?agent_id=agent-e2e",
      "/reviews"
    ]) {
      await page.goto(auditUrl(path, "ja"));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), path).toBe(true);
    }
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
