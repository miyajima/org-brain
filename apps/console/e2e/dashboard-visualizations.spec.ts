import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const advancedHref = (path: string) => {
  const url = new URL(path, "http://console.local");
  url.searchParams.set("advanced", "1");
  return `${url.pathname}${url.search}${url.hash}`;
};

test.describe("dashboard visualizations", () => {
  test("renders the observed activity home without sensitive payloads", async ({ page }) => {
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=org-brain&lang=ja"));

    await expect(page.getByRole("heading", { name: "組織の活動" })).toBeVisible();
    await expect(page.locator(".intelligence-header > div:first-child > p:not(.intelligence-eyebrow)")).toHaveCount(0);
    await expect(page.locator(".insight-page-guide")).toHaveCount(0);
    const headerLayout = await page.locator(".intelligence-header").evaluate((header) => {
      const title = header.firstElementChild?.getBoundingClientRect();
      const actions = header.lastElementChild?.getBoundingClientRect();
      const bounds = header.getBoundingClientRect();
      return { height: bounds.height, titleRight: title?.right ?? 0, actionsLeft: actions?.left ?? 0 };
    });
    expect(headerLayout.height).toBeLessThan(130);
    expect(headerLayout.actionsLeft).toBeGreaterThan(headerLayout.titleRight);
    await expect(page.locator(".insight-scope-rail")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "対応が必要なシグナル" })).toBeVisible();
    await expect(page.locator(".recommended-actions .action-card")).toHaveCount(1);
    await expect(page.locator(".activity-health-summary")).toBeVisible();
    await expect(page.locator(".activity-omissions")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "エージェント、Org Brain、プロジェクト間のアクティビティ経路" })).toBeVisible();
    await expect(page.getByText("中央の項目を選ぶと、下のReplayをその種類に絞り込みます。", { exact: false })).toBeVisible();
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "過去24時間のイベント" })).toBeVisible();
    await expect(page.locator(".timeline-bucket")).toHaveCount(12);
    await expect(page.locator(".timeline-recent").getByText("タスク「Index parity check」が失敗しました。")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("input_ref");
    await expect(page.locator("body")).not.toContainText("raw query");
  });

  test("switches the activity timeline beyond the default 24 hours", async ({ page }) => {
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=org-brain&lang=ja&period=30d"));
    await expect(page.getByRole("navigation", { name: "表示期間" })).toBeVisible();
    await expect(page.getByRole("link", { name: "30日", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "過去30日のイベント" })).toBeVisible();
    await expect(page.getByText("30日前", { exact: true })).toBeVisible();
    await expect(page.locator(".period-comparison")).toHaveCount(0);
    await expect(page.locator(".topology-fallback")).toContainText("この期間に観測");
    await expect(page.locator(".topology-fallback")).toContainText("最終観測");
    await expect(page.locator(".topology-fallback")).toContainText("観測元");
  });

  test("turns the four Org Brain capabilities into activity filters", async ({ page }) => {
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=org-brain&lang=ja"));
    const understand = page.getByRole("link", { name: "タイムラインを「理解する」で絞り込む" });
    await expect(understand).toBeVisible();
    await expect(page.locator(".brain-capability-link")).toHaveCount(4);
    await understand.focus();
    await expect(understand).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/activity_capability=understand/u);
    await expect(page.locator(".activity-timeline > header > span")).toHaveText("理解する：1 / 2件");
    const filteredEvents = page.locator(".timeline-recent");
    await expect(filteredEvents.getByText("「Login principal group ACL design」を参照しました。")).toHaveCount(1);
    await expect(filteredEvents.getByText("タスク「Index parity check」が失敗しました。")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "すべての活動を表示" })).toHaveAttribute("aria-current", "true");
  });

  test("keeps one node search visible while advanced filters stay collapsed", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    try {
      await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja"));

      await expect(page.getByRole("heading", { name: "3Dメモリマップ" })).toBeVisible();
      await expect(page.locator("#memory-map-pathway-title")).toHaveText("判断の道筋");
      await expect(page.locator("[data-map-search]")).toHaveCount(1);
      await expect(page.locator("[data-map-search]")).toBeVisible();
      await expect(page.locator("[data-trace-step='decision']")).toContainText("何を決めたか");
      await expect(page.locator("[data-trace-step='reason']")).toContainText("なぜその案を選んだか");
      await expect(page.locator("[data-trace-step='evidence']")).toContainText("何が判断を支えたか");
      await expect(page.locator("[data-trace-step='artifact']")).toContainText("どこに反映されたか");
      const controls = page.locator("[data-map-controls]");
      const summary = controls.locator("summary");
      const toolbar = controls.locator(".memory-map-toolbar");
      const filters = controls.locator(".memory-map-filters");

      await expect(controls).not.toHaveAttribute("open", "");
      await expect(summary).toContainText("検索・フィルター");
      await expect(summary).toContainText("org-brain");
      await expect(toolbar).toBeHidden();
      await expect(filters).toBeHidden();

      await summary.click();
      await expect(controls).toHaveAttribute("open", "");
      await expect(toolbar).toBeVisible();
      await expect(filters).toBeVisible();
      await expect(filters.locator("legend")).toHaveCount(0);
      expect(await filters.locator(".memory-map-date-range").evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe("none");
      expect(await controls.locator(".memory-map-controls-body").evaluate((element) => {
        const [toolbar, filters] = Array.from(element.children).map((child) => child.getBoundingClientRect());
        return Math.abs(toolbar.bottom - filters.top);
      })).toBeLessThan(1);
    } finally {
      await context.close();
    }
  });

  test("shows the Japanese decision trace from decision to evidence and artifacts", async ({ page }) => {
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e"));

    await expect(page.locator("#memory-map-pathway-title")).toHaveText("判断の道筋");
    const trace = page.locator(".memory-map-trace-card").first();
    await expect(trace).toContainText("ORGBRAIN_API_URLを正規の接続先として採用する");
    await expect(page.locator("[data-trace-step-item='decision']")).toContainText("確認済み");
    await page.locator("[data-trace-step='reason']").click();
    await expect(page).toHaveURL(/trace_step=reason/u);
    await expect(trace).toContainText("接続先を一つに固定すると設定ドリフトを防ぎ");
    await expect(trace).toContainText("ORGBRAIN_API_BASEを主経路にする");
    await page.locator("[data-trace-step='evidence']").click();
    await expect(trace).toContainText("apps/api-gateway/src/config.ts");
    await page.locator("[data-trace-step='artifact']").click();
    await expect(page).toHaveURL(/trace_step=artifact/u);
    await expect(page.locator(".memory-map-trace-resource")).toHaveCount(2);
    await expect(page.locator("[data-trace-step-item='artifact']")).toContainText("成果物 2件");
    const preview = page.getByRole("button", { name: "この画面で確認" }).first();
    await preview.click();
    const dialog = page.getByRole("dialog", { name: "正規API URLの実装" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("実装成果物");
    await expect(dialog).toContainText("確認済み");
    const dialogGeometry = await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        centerX: bounds.left + bounds.width / 2,
        centerY: bounds.top + bounds.height / 2,
        viewportCenterX: window.innerWidth / 2,
        viewportCenterY: window.innerHeight / 2
      };
    });
    expect(Math.abs(dialogGeometry.centerX - dialogGeometry.viewportCenterX)).toBeLessThanOrEqual(1);
    expect(Math.abs(dialogGeometry.centerY - dialogGeometry.viewportCenterY)).toBeLessThanOrEqual(1);
    const resourceLink = dialog.getByRole("link", { name: "資料詳細を別タブで開く" });
    await expect(resourceLink).toHaveAttribute("target", "_blank");
    const popupPromise = page.waitForEvent("popup");
    await resourceLink.click();
    const resourcePage = await popupPromise;
    await resourcePage.waitForLoadState("domcontentloaded");
    await expect(page).toHaveURL(/\/memories\/constellation/u);
    await expect(resourcePage.locator("[data-decision-artifacts]")).toContainText("判断の成果物");
    await expect(resourcePage.locator("[data-decision-artifacts]")).toContainText("正規API URLの実装");
    await expect(resourcePage.getByRole("link", { name: /判断の道筋に戻る/u })).toHaveAttribute("href", /trace_step=artifact/u);
    await expect(resourcePage.locator(".resources-workspace")).not.toHaveAttribute("open", "");
    await resourcePage.close();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    const inspectorLink = page.locator("[data-map-inspector-link]");
    await expect(inspectorLink).toBeVisible();
    const inspectorPopup = page.waitForEvent("popup");
    await inspectorLink.click();
    const inspectorPage = await inspectorPopup;
    await expect(inspectorPage).toHaveURL(/^http:\/\/127\.0\.0\.1:/u);
    await inspectorPage.waitForLoadState("domcontentloaded");
    const inspectorDestination = new URL(inspectorPage.url());
    expect(inspectorDestination.pathname).toBe("/resources");
    expect(Object.fromEntries(["tenant_id", "project_id", "lang", "advanced", "decision_ref"].map(key => [key, inspectorDestination.searchParams.get(key)]))).toEqual({ tenant_id: "default", project_id: "org-brain", lang: "ja", advanced: "1", decision_ref: "decision_rationale:rationale-e2e" });
    await expect(inspectorPage.locator("[data-decision-artifacts]")).toContainText("正規API URLの実装");
    await inspectorPage.getByRole("link", { name: /判断の道筋に戻る/u }).click();
    await expect(inspectorPage).toHaveURL(/\/memories\/constellation\?/u);
    await expect(inspectorPage).toHaveURL(/selected=decision%3Arationale-e2e/u);
    const returnDestination = new URL(inspectorPage.url());
    expect(Object.fromEntries(["tenant_id", "project_id", "lang", "advanced", "selected", "trace_step"].map(key => [key, returnDestination.searchParams.get(key)]))).toEqual({ tenant_id: "default", project_id: "org-brain", lang: "ja", advanced: "1", selected: "decision:rationale-e2e", trace_step: "artifact" });
    await expect(inspectorPage.locator("[data-trace-step-item='artifact']")).toContainText("成果物 2件");
    await inspectorPage.close();
  });

  test("keeps the same semantic decision trace in English", async ({ page }) => {
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=en&selected=decision:rationale-e2e"));

    await expect(page.locator("#memory-map-pathway-title")).toHaveText("The path of a decision");
    const trace = page.locator(".memory-map-trace-card").first();
    await expect(trace).toContainText("Adopt ORGBRAIN_API_URL as the canonical endpoint");
    await page.locator("[data-trace-step='reason']").click();
    await expect(trace).toContainText("A single endpoint prevents configuration drift");
    await expect(trace).toContainText("Use ORGBRAIN_API_BASE as the primary endpoint");
    await page.locator("[data-trace-step='evidence']").click();
    await expect(trace).toContainText("apps/api-gateway/src/config.ts");
  });

  test("shows Japanese failure prevention as symptom, cause, correction, and rule", async ({ page }) => {
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=e2e-failure-trace&lang=ja&selected=decision:rationale-failure-e2e"));

    const trace = page.locator(".memory-map-trace-card").first();
    await expect(page.locator("#memory-map-pathway-title")).toHaveText("判断の道筋");
    await expect(trace).toContainText("リトライで試行キーが変わり重複メモリが作られた");
    await page.locator("[data-trace-step='reason']").click();
    await expect(trace).toContainText("リトライカウンタをexternal_keyに含めていた");
    await page.locator("[data-trace-step='evidence']").click();
    await expect(trace).toContainText("失敗した実行");
    await expect(trace).toContainText("修正後の実行");
    await expect(trace).toContainText("pnpm memories:seed-ingestion-local --retry 2");
    await expect(trace).toContainText("pnpm memories:seed-ingestion-local --stable-key");
    await page.locator("[data-trace-step='artifact']").click();
    await expect(trace).toContainText("external_keyをcase_idから安定生成するよう修正した");
    await expect(trace).toContainText("再実行可能な取込ではexternal_keyを不変のcase_idから生成し");
  });

  test("shows honest missing and unverified states for an incomplete trace", async ({ page }) => {
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=e2e-missing-trace&lang=ja&selected=decision:rationale-missing-e2e"));

    await expect(page.locator("[data-trace-step-item='decision']")).toContainText("未検証");
    await page.locator("[data-trace-step='evidence']").click();
    await expect(page.getByText("根拠が未記録です").first()).toBeVisible();
    await page.locator("[data-trace-step='artifact']").click();
    await expect(page.getByText("正式成果物リンク未登録です")).toBeVisible();
    await expect(page.locator(".memory-map-trace-resource")).toHaveCount(0);
  });

  test("keeps the 3D map and node metadata when the trace API fails", async ({ page }) => {
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=e2e-trace-error&lang=ja&selected=decision:rationale-e2e"));

    await expect(page.getByRole("heading", { name: "Canonical API endpoint decision" })).toBeVisible();
    await expect(page.locator("[data-map-inspector-project]")).toHaveText("e2e-trace-error");
    await expect(page.locator("[data-map-trace-status]")).toContainText("実データを読み込めませんでした");
    await expect(page.locator("[data-map-stage-shell]")).toBeVisible();
  });

  test("keeps the 3D trace panel usable at a narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 572, height: 844 });
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e"));

    await expect(page.locator("[data-map-stage]")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("[data-trace-step-item='artifact']")).toContainText("成果物 2件");
    const sheetToggle = page.locator("[data-trace-sheet-toggle]");
    await expect(sheetToggle).toHaveAttribute("aria-expanded", "false");
    await sheetToggle.click();
    await expect(sheetToggle).toHaveAttribute("aria-expanded", "true");
    // Close the bottom sheet to change the stage behind it, then reopen it.
    await sheetToggle.click();
    await expect(sheetToggle).toHaveAttribute("aria-expanded", "false");
    await page.locator("[data-trace-step='artifact']").click();
    await sheetToggle.click();
    await expect(sheetToggle).toHaveAttribute("aria-expanded", "true");
    const preview = page.getByRole("button", { name: "この画面で確認" }).first();
    await preview.focus();
    await expect(preview).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("keeps the map fit control, visual-only graph semantics, and single mobile sheet action", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&view=all"));

    await expect(page.locator("[data-map-mode-badge]")).toHaveText("閲覧可能な全ノード");
    await expect(page.locator("[data-map-visible-count]")).toHaveText("62");
    await expect(page.locator("[data-map-fit]")).toHaveAttribute("aria-label", "メモリマップ全体を表示");
    await expect(page.locator("[data-map-stage]")).toHaveAttribute("role", "img");
    await expect(page.locator("[data-map-stage]")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("[data-map-render-status]")).not.toHaveText("");
    await expect(page.locator("[data-trace-sheet-toggle]")).toHaveCount(1);
    await expect(page.locator("[data-trace-sheet-toggle]")).toHaveAttribute("aria-controls", "memory-map-inspector-content");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await page.locator("[data-trace-sheet-toggle]").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  });

  for (const locale of ["en", "ja", "zh"] as const) {
    test(`has no WCAG A/AA violations in the memory map for ${locale}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(advancedHref(`/memories/constellation?tenant_id=default&project_id=org-brain&lang=${locale}&view=all`));
      const results = await new AxeBuilder({ page })
        .include("[data-memory-map-root]")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test("uses a full-width map and a bottom trace sheet at an intermediate width", async ({ page }) => {
    await page.setViewportSize({ width: 832, height: 863 });
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e"));

    const geometry = await page.evaluate(() => {
      const layout = document.querySelector<HTMLElement>(".memory-map-layout")!;
      const stage = document.querySelector<HTMLElement>("[data-map-stage-shell]")!.getBoundingClientRect();
      const inspector = document.querySelector<HTMLElement>("[data-map-inspector]")!;
      const inspectorRect = inspector.getBoundingClientRect();
      return {
        mediaMatches: window.matchMedia("(max-width: 900px)").matches,
        layoutDisplay: getComputedStyle(layout).display,
        availableWidth: layout.getBoundingClientRect().width,
        stageWidth: stage.width,
        inspectorWidth: inspectorRect.width,
        inspectorPosition: getComputedStyle(inspector).position,
        documentHeight: document.documentElement.scrollHeight
      };
    });
    expect(geometry.mediaMatches).toBe(true);
    expect(geometry.layoutDisplay).toBe("block");
    expect(geometry.stageWidth).toBeGreaterThanOrEqual(geometry.availableWidth - 2);
    expect(geometry.inspectorWidth).toBeGreaterThan(800);
    expect(geometry.inspectorPosition).toBe("fixed");
    expect(geometry.documentHeight).toBeLessThan(1350);
  });

  test("keeps keyboard node selection visible and synchronized after selection", async ({ page }) => {
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=e2e-failure-trace&lang=ja"));

    const search = page.locator("[data-map-search]");
    const results = page.locator("[data-map-search-results]");
    await search.focus();
    await expect(results.locator("[data-map-accessible-count]")).toHaveText("2件中2件を表示");
    await expect(results.locator("li")).toHaveCount(2);
    await expect(results).not.toContainText("failure_prevention:");
    await expect(results).toContainText("プロジェクト:");
    await expect(results).toContainText("確認状態:");
    const scrollBeforeSelection = await page.evaluate(() => window.scrollY);
    await results.locator("button").last().click();
    await expect(results).toBeHidden();
    await expect(search).toBeFocused();
    await expect(page.locator("[data-map-selection-status]")).toContainText("選択したノード:");
    await expect(page).toHaveURL(/selected=/u);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBeforeSelection);
  });

  test("keeps the four-step path and 3D map together in the first desktop viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e"));

    const geometry = await page.evaluate(() => {
      const pathway = document.querySelector<HTMLElement>("[data-map-pathway]")!.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>("[data-map-stage-shell]")!.getBoundingClientRect();
      const search = document.querySelector<HTMLElement>("[data-map-search]")!.getBoundingClientRect();
      return {
        pathwayTop: pathway.top,
        pathwayBottom: pathway.bottom,
        stageTop: stage.top,
        stageBottom: stage.bottom,
        stageHeight: stage.height,
        searchBottom: search.bottom,
        viewportHeight: window.innerHeight
      };
    });
    expect(geometry.pathwayTop).toBeLessThan(geometry.viewportHeight);
    expect(geometry.stageTop).toBeLessThan(geometry.viewportHeight);
    expect(geometry.pathwayBottom).toBeLessThanOrEqual(geometry.stageTop);
    expect(geometry.searchBottom).toBeLessThanOrEqual(geometry.pathwayTop);
    expect(geometry.stageHeight).toBeGreaterThanOrEqual(439);
    expect(geometry.stageBottom).toBeGreaterThan(geometry.viewportHeight - 80);
  });

  test("keeps search, all four path steps, and the map usable at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e"));

    await expect(page.locator("[data-map-search]")).toBeVisible();
    await expect(page.locator("[data-trace-step]")).toHaveCount(4);
    await expect(page.locator("[data-map-stage-shell]")).toBeVisible();
    const geometry = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>("[data-map-stage-shell]")!.getBoundingClientRect();
      const pathway = document.querySelector<HTMLElement>("[data-map-pathway]")!.getBoundingClientRect();
      const stepHeights = Array.from(document.querySelectorAll<HTMLElement>("[data-trace-step]"), (step) => step.getBoundingClientRect().height);
      return {
        noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        pathwayBottom: pathway.bottom,
        stageTop: stage.top,
        stageVisible: stage.top < window.innerHeight,
        stepHeights
      };
    });
    expect(geometry.noHorizontalOverflow).toBe(true);
    expect(geometry.pathwayBottom).toBeLessThanOrEqual(geometry.stageTop);
    expect(geometry.stageVisible).toBe(true);
    expect(Math.min(...geometry.stepHeights)).toBeGreaterThanOrEqual(44);
  });

  for (const width of [320, 768] as const) {
    test(`keeps the memory map readable without horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(advancedHref(`/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&view=all`));
      await expect(page.locator("[data-map-search]")).toBeVisible();
      await expect(page.locator("[data-map-fit]")).toBeVisible();
      await expect(page.locator("[data-map-stage]")).toHaveAttribute("aria-describedby", "memory-map-stage-instructions");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await page.locator("[data-map-search]").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    });
  }

  test("keeps the map and trace in a bounded desktop reading surface", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 900 });
    await page.goto(advancedHref("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e&trace_step=artifact"));

    const geometry = await page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>(".memory-map-workspace")!.getBoundingClientRect();
      const stage = document.querySelector<HTMLElement>("[data-map-stage-shell]")!.getBoundingClientRect();
      const inspector = document.querySelector<HTMLElement>("[data-map-inspector]")!;
      const inspectorRect = inspector.getBoundingClientRect();
      return {
        workspaceHeight: workspace.height,
        stageHeight: stage.height,
        inspectorHeight: inspectorRect.height,
        inspectorClientHeight: inspector.clientHeight,
        inspectorScrollHeight: inspector.scrollHeight
      };
    });
    expect(Math.abs(geometry.workspaceHeight - geometry.inspectorHeight)).toBeLessThan(24);
    expect(geometry.stageHeight).toBeGreaterThanOrEqual(439);
    expect(geometry.stageHeight).toBeLessThanOrEqual(545);
    expect(geometry.inspectorScrollHeight).toBeGreaterThanOrEqual(geometry.inspectorClientHeight);
    await page.locator("[data-trace-step='decision']").focus();
    await page.keyboard.press("End");
    await expect(page.locator("[data-trace-step='artifact']")).toBeFocused();
    await expect(page).toHaveURL(/trace_step=artifact/u);
  });

  test("makes observed actors and projects keyboard-operable", async ({ page }) => {
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=org-brain&lang=ja"));

    const actor = page.locator(".topology-entity-link").first();
    await actor.focus();
    await expect(actor).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/event=usage%3Aevt-1/);
  });

  test("switches Strata to a vertical timeline at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(advancedHref("/decisions/history?tenant_id=default&project_id=org-brain&lang=ja"));

    await expect(page.getByRole("heading", { name: "知識の履歴" })).toBeVisible();
    await expect(page.getByText("現在の内容", { exact: true })).toBeVisible();
    await expect(page.locator(".strata-mobile")).toBeVisible();
    await expect(page.locator(".strata-board")).toBeHidden();
    await expect(page.getByRole("heading", { name: "知識の更新履歴" })).toBeVisible();
    await expect(page.locator(".selected-chain-summary strong")).toHaveText("Login principal group ACL design");
    const reviewTitle = await page.locator(".recommended-actions .action-card").first().locator("strong").textContent();
    await expect(page.locator(".history-overview")).toContainText(reviewTitle ?? "");
    await expect(page.locator("#strata-attention")).toContainText(reviewTitle ?? "");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("keeps the activity fallback usable at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?tenant_id=default&project_id=org-brain&lang=ja");
    const navigation = page.getByRole("navigation", { name: "メインナビゲーション" });
    await expect(navigation.getByRole("link")).toHaveCount(3);
    for (const name of ["ホーム", "知識", "管理"]) await expect(navigation.getByRole("link", { name, exact: true })).toBeVisible();
    const activity = page.locator("section").filter({ has: page.getByRole("heading", { name: "最近の動き", exact: true }) });
    await expect(activity).toContainText("Task failed: Index parity check");
    await expect(page.locator("[data-usage-metrics]")).toContainText("更新");
    const review = page.locator("section").filter({ has: page.getByRole("heading", { name: "確認が必要なこと", exact: true }) });
    await review.getByRole("link", { name: /Login principal group ACL design/u }).click();
    await expect(page).toHaveURL(/\/knowledge\?.*id=mem_auth_group_acl/u);
    await expect(page.locator("[data-knowledge-detail]")).toContainText("矛盾");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("uses the on-mode navigation and keeps the canonical Task route", async ({ page }) => {
    await page.goto("/?tenant_id=default&project_id=org-brain&lang=ja");
    const navigation = page.getByRole("navigation", { name: "メインナビゲーション" });
    const destinations = await navigation.getByRole("link").evaluateAll(links => links.map(link => {
      const url = new URL((link as HTMLAnchorElement).href);
      return { path: url.pathname, tenant: url.searchParams.get("tenant_id"), project: url.searchParams.get("project_id"), lang: url.searchParams.get("lang") };
    }));
    expect(destinations).toEqual(["/", "/knowledge", "/settings"].map(path => ({ path, tenant: "default", project: "org-brain", lang: "ja" })));
    await navigation.getByRole("link", { name: "管理", exact: true }).click();
    await page.getByRole("navigation", { name: "管理項目" }).getByRole("link", { name: "処理状況", exact: true }).click();
    await expect(page.getByRole("heading", { name: "処理状況", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/section=operations/u);
    await page.goto("/tasks/task-e2e?tenant_id=default&project_id=org-brain&lang=ja");
    await expect(page).toHaveURL(/\/settings\?.*section=operations.*id=task-e2e/u);
    await expect(page.getByRole("heading", { name: "選択した処理", exact: true })).toBeVisible();
  });

  test("keeps management route parity and scope in all supported languages", async ({ page }) => {
    for (const [lang, management, groupsLabel] of [["en", "Management sections", "Groups"], ["ja", "管理項目", "グループ"], ["zh", "管理项目", "群组"]] as const) {
      const url = `/settings?tenant_id=tenant-a&project_id=project-a&lang=${lang}`;
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(url);
      const sections = page.getByRole("navigation", { name: management });
      const desktopHrefs = await sections.getByRole("link").evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileHrefs = await sections.getByRole("link").evaluateAll(links => links.map(link => (link as HTMLAnchorElement).href));
      expect(mobileHrefs).toEqual(desktopHrefs);
      await sections.getByRole("link", { name: groupsLabel, exact: true }).click();
      const target = new URL(page.url());
      expect(target.pathname).toBe("/settings");
      expect(Object.fromEntries(["section", "tenant_id", "project_id", "lang"].map(key => [key, target.searchParams.get(key)]))).toEqual({ section: "groups", tenant_id: "tenant-a", project_id: "project-a", lang });
      await expect(page.getByRole("heading", { name: groupsLabel, exact: true })).toBeVisible();
    }
  });

  test("reduces administration navigation for a personal workspace", async ({ page }) => {
    await page.goto("/settings?tenant_id=personal-e2e&lang=ja");
    const sections = page.getByRole("navigation", { name: "管理項目" });
    for (const name of ["ユーザー", "グループ", "組織", "業務分類"]) await expect(sections.getByRole("link", { name, exact: true })).toHaveCount(0);
    await expect(sections.getByRole("link", { name: "プロフィール", exact: true })).toBeVisible();
    await expect(page.locator(".op-workspace-name")).toContainText("personal-e2e");
    await page.goto("/settings?tenant_id=personal-e2e&section=users&lang=ja");
    await expect(page.getByRole("alert")).toContainText("利用できません");
    await expect(page.locator('[data-op-api-form][data-endpoint="/api/v1/users"]')).toHaveCount(0);
  });

  test("disables visualization animation for reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=org-brain&lang=ja"));

    const animationName = await page.locator(".flow").first().evaluate((element) =>
      getComputedStyle(element).animationName
    );
    expect(animationName).toBe("none");
  });

  test("renders honest empty activity and partial Strata states", async ({ page }) => {
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=e2e-empty&lang=ja"));
    await expect(page.getByText("表示できるアクティビティはまだありません")).toBeVisible();

    await page.goto(advancedHref("/decisions/history?tenant_id=default&project_id=e2e-partial-error&lang=ja"));
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText("知識の履歴を判断できません");
    await page.getByRole("alert").getByText("技術情報").click();
    await expect(page.getByRole("alert")).toContainText("Strata detail fixture unavailable");
    await expect(page.getByRole("heading", { name: "知識の履歴" })).toBeVisible();
  });

  test("surfaces activity API errors and Strata truncation", async ({ page }) => {
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=e2e-error&lang=ja"));
    await expect(page.getByRole("alert")).toContainText("Dashboard fixture unavailable");
    await expect(page.getByText("活動状況を判断できません")).toBeVisible();
    await expect(page.getByText("表示できるアクティビティはまだありません")).toHaveCount(0);
    await expect(page.getByText("現在、対応が必要なシグナルはありません")).toHaveCount(0);

    await page.goto(advancedHref("/decisions/history?tenant_id=default&project_id=e2e-truncated&lang=ja"));
    await expect(page.getByText("古いリビジョンの一部は表示上限により省略されています。")).toBeVisible();
    await expect(page.getByText("参照元の一部は表示上限により省略されています。")).toBeVisible();
  });

  test("keeps the canonical Task dashboard honest and filterable", async ({ page }) => {
    await page.goto("/settings?section=operations&tenant_id=default&project_id=e2e-task-error&lang=ja");
    await expect(page.getByRole("alert").filter({ hasText: "タスクを取得できません" })).toBeVisible();
    await expect(page.getByText("この範囲にタスクの記録はありません。", { exact: true })).toHaveCount(0);
    await page.goto("/settings?section=operations&tenant_id=default&project_id=e2e-task-dense&lang=ja");
    await page.getByRole("searchbox", { name: "タスクを検索", exact: true }).fill("memory");
    await page.getByRole("combobox", { name: "ステータス", exact: true }).selectOption("succeeded");
    const search = page.getByRole("search").filter({ has: page.getByRole("searchbox", { name: "タスクを検索", exact: true }) });
    await search.getByRole("button", { name: "検索", exact: true }).click();
    await expect(page).toHaveURL(/task_q=memory/u);
    await expect(page).toHaveURL(/task_status=succeeded/u);
    await expect(page.getByRole("searchbox", { name: "タスクを検索", exact: true })).toHaveValue("memory");
    await expect(page.getByRole("combobox", { name: "ステータス", exact: true })).toHaveValue("succeeded");
    const tasks = page.locator("section").filter({ has: page.getByRole("heading", { name: "最近のタスク", exact: true }) });
    await expect(tasks).toContainText("記憶品質測定");
    await expect(tasks).toContainText("成功");
    await expect(tasks).toContainText("1ページ目");
    const filteredUrl = page.url();
    await page.goto(filteredUrl.replace("/settings?", "/tasks?").replace("section=operations&", ""));
    await expect(page).toHaveURL(/\/settings\?.*section=operations/u);
    await expect(page.getByRole("searchbox", { name: "タスクを検索", exact: true })).toHaveValue("memory");
  });

  test("always offers a next action for every Task detail state", async ({ page }) => {
    const cases = [
      ["task-e2e", "org-brain", "イベント履歴"],
      ["missing", "org-brain", "タスクが見つかりません"],
      ["task-e2e", "e2e-task-detail-error", "タスク詳細を取得できません"],
      ["task-e2e", "e2e-task-events-error", "イベント履歴の一部を取得できませんでした"]
    ] as const;
    for (const [id, project, message] of cases) {
      await page.goto(`/settings?section=operations&id=${id}&tenant_id=default&project_id=${project}&lang=ja`);
      const taskPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "選択した処理", exact: true }) });
      await expect(taskPanel.getByText(message, { exact: false })).toBeVisible();
      await expect(taskPanel.getByRole("link", { name: "一覧に戻る", exact: true })).toBeVisible();
      if (id === "missing" || project !== "org-brain") {
        const retry = taskPanel.getByRole("link", { name: "再試行", exact: true });
        await expect(retry).toBeVisible();
        await retry.click();
        await expect(page).toHaveURL(new RegExp(`id=${id}`));
      }
      await taskPanel.getByRole("link", { name: "一覧に戻る", exact: true }).click();
      await expect(page).toHaveURL(/section=operations/u);
      expect(new URL(page.url()).searchParams.has("id")).toBe(false);
    }
  });

  test("keeps Operations tenant-scoped through status and replay", async ({ page }) => {
    const requests: Array<{url:string;body:Record<string,unknown>}> = [];
    page.on("request", request => {
      if (request.url().includes("/api/v1/ops/tasks/") && request.method() === "POST") requests.push({url:request.url(),body:request.postDataJSON()});
    });
    await page.goto("/settings?section=operations&tenant_id=tenant-a&lang=ja");
    await expect(page.getByRole("heading", { name: "処理状況", exact: true })).toBeVisible();
    const form = page.locator('[data-op-api-form][data-endpoint="/api/v1/ops/tasks/task-failed/replay"]');
    const replay = form.getByRole("button", { name: "処理をやり直す", exact: true });
    const disclosure = form.locator("xpath=ancestor::details[1]");
    await disclosure.locator(":scope > summary").click();
    await replay.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("task-failed");
    expect(requests).toHaveLength(0);
    const response = page.waitForResponse(response => response.url().includes("/api/v1/ops/tasks/task-failed/replay") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "変更を適用", exact: true }).click();
    expect((await response).status()).toBe(201);
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].body.tenant_id).toBe("tenant-a");
    await expect(page.getByRole("status").filter({ hasText: "変更を保存しました。" })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("tenant_id")).toBe("tenant-a");
  });

  test("keeps sparse and high-density activity and Strata states usable", async ({ page }) => {
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=e2e-sparse&lang=ja"));
    await expect(page.locator(".activity-timeline > header > span")).toContainText("1");
    await expect(page.getByText("Dense activity 1")).toHaveCount(0);

    await page.goto(advancedHref("/overview?tenant_id=default&project_id=e2e-dense&lang=ja"));
    await expect(page.locator(".activity-timeline > header > span")).toContainText("250");
    await expect(page.locator(".timeline-bucket")).toHaveCount(12);
    expect(await page.locator(".activity-timeline").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator(".timeline-event-list > summary").click();
    await expect(page.locator(".timeline-event-list li")).toHaveCount(244);
    await page.locator(".timeline-event-list li").last().scrollIntoViewIfNeeded();
    await expect(page.locator(".timeline-event-list li").last()).toBeVisible();

    await page.goto(advancedHref("/decisions/history?tenant_id=default&project_id=e2e-dense&lang=ja"));
    await expect(page.locator(".strata-event")).toHaveCount(101);
    await expect(page.locator(".legend-truncated")).toBeVisible();
  });

  test("keeps the activity timeline compact without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=e2e-dense&lang=ja"));

    await expect(page.locator(".activity-timeline > header > span")).toContainText("250");
    await expect(page.locator(".timeline-bucket")).toHaveCount(12);
    await expect(page.locator(".timeline-recent li")).toHaveCount(6);
    expect(await page.locator(".activity-timeline").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.locator(".timeline-overview").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.locator(".timeline-event-list > summary").click();
    await expect(page.locator(".timeline-event-list li")).toHaveCount(244);
    await page.locator(".timeline-event-list li").last().scrollIntoViewIfNeeded();
    await expect(page.locator(".timeline-event-list li").last()).toBeVisible();
  });

  test("polls at 30 seconds, pauses while hidden, and resumes immediately", async ({ page }) => {
    const clockTime = new Date("2026-06-12T09:00:00Z");
    await page.clock.install({ time: clockTime });
    await page.clock.pauseAt(clockTime);
    const incrementalRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/dashboard/activity") && request.url().includes("after=")) {
        incrementalRequests.push(request.url());
      }
    });
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=org-brain&lang=ja"));

    await page.clock.fastForward(29_999);
    expect(incrementalRequests).toHaveLength(0);
    await page.clock.fastForward(1);
    await expect.poll(() => incrementalRequests.length).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.locator("intelligence-poller")).toHaveAttribute("data-poll-state", "idle");
    await page.clock.fastForward(300_000);
    expect(incrementalRequests).toHaveLength(1);

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.fastForward(1);
    await expect.poll(() => incrementalRequests.length).toBe(2);
  });

  test("retains the last good view during capped polling backoff", async ({ page }) => {
    const clockTime = new Date("2026-06-12T09:00:00Z");
    await page.clock.install({ time: clockTime });
    await page.clock.pauseAt(clockTime);
    await page.goto(advancedHref("/overview?tenant_id=default&project_id=org-brain&lang=ja"));
    let incrementalRequests = 0;
    await page.route("**/api/v1/dashboard/activity**", async (route) => {
      if (!route.request().url().includes("after=")) return route.continue();
      incrementalRequests += 1;
      if (incrementalRequests === 1) {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "temporary", message: "Temporary fixture failure" } }) });
      }
      return route.continue();
    });

    await page.clock.fastForward(30_000);
    await expect.poll(() => incrementalRequests).toBe(1);
    await expect(page.locator("intelligence-poller")).toHaveAttribute("data-poll-state", "backoff");
    await expect(page.locator(".timeline-recent").getByText("タスク「Index parity check」が失敗しました。")).toBeVisible();

    await page.clock.fastForward(59_999);
    expect(incrementalRequests).toBe(1);
    await page.clock.fastForward(1);
    await expect.poll(() => incrementalRequests).toBe(2);
    await expect(page.locator(".timeline-recent").getByText("タスク「Index parity check」が失敗しました。")).toBeVisible();
  });
});
