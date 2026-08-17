import { expect, test } from "@playwright/test";

test.describe("dashboard visualizations", () => {
  test("renders the observed activity home without sensitive payloads", async ({ page }) => {
    await page.goto("/?tenant_id=default&project_id=org-brain&lang=ja");

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
    await expect(page.locator(".recommended-actions")).toHaveCount(0);
    await expect(page.locator(".activity-omissions")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "エージェント、Org Brain、プロジェクト間のアクティビティ経路" })).toBeVisible();
    await expect(page.getByText("中央の項目を選ぶと、下のReplayをその種類に絞り込みます。", { exact: false })).toBeVisible();
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "過去24時間のイベント" })).toBeVisible();
    await expect(page.locator(".timeline-bucket")).toHaveCount(12);
    await expect(page.locator(".timeline-recent").getByText("Task「Index parity check」が失敗しました。")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("input_ref");
    await expect(page.locator("body")).not.toContainText("raw query");
  });

  test("switches the activity timeline beyond the default 24 hours", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja&period=30d");
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
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");
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
    await expect(filteredEvents.getByText("Task「Index parity check」が失敗しました。")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "すべての活動を表示" })).toHaveAttribute("aria-current", "true");
  });

  test("keeps the 3D map search and filters collapsed in one panel", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    try {
      await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja");

      await expect(page.getByRole("heading", { name: "3Dメモリマップ" })).toBeVisible();
      await expect(page.locator("#memory-map-pathway-title")).toHaveText("判断の道筋");
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
    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e");

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
  });

  test("keeps the same semantic decision trace in English", async ({ page }) => {
    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=en&selected=decision:rationale-e2e");

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
    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-failure-trace&lang=ja&selected=decision:rationale-failure-e2e");

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
    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-missing-trace&lang=ja&selected=decision:rationale-missing-e2e");

    await expect(page.locator("[data-trace-step-item='decision']")).toContainText("未検証");
    await page.locator("[data-trace-step='evidence']").click();
    await expect(page.getByText("根拠が未記録です").first()).toBeVisible();
    await page.locator("[data-trace-step='artifact']").click();
    await expect(page.getByText("正式成果物リンク未登録です")).toBeVisible();
    await expect(page.locator(".memory-map-trace-resource")).toHaveCount(0);
  });

  test("keeps the 3D map and node metadata when the trace API fails", async ({ page }) => {
    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-trace-error&lang=ja&selected=decision:rationale-e2e");

    await expect(page.getByRole("heading", { name: "Canonical API endpoint decision" })).toBeVisible();
    await expect(page.locator("[data-map-inspector-project]")).toHaveText("e2e-trace-error");
    await expect(page.locator("[data-map-trace-status]")).toContainText("実データを読み込めませんでした");
    await expect(page.locator("[data-map-stage-shell]")).toBeVisible();
  });

  test("keeps the 3D trace panel usable at a narrow width", async ({ page }) => {
    await page.setViewportSize({ width: 572, height: 844 });
    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e");

    await page.locator("[data-trace-sheet-expand]").click();
    await page.locator("[data-trace-step='artifact']").click();
    const preview = page.getByRole("button", { name: "この画面で確認" }).first();
    await preview.focus();
    await expect(preview).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("uses a full-width map and a bottom trace sheet at an intermediate width", async ({ page }) => {
    await page.setViewportSize({ width: 832, height: 863 });
    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e");

    const geometry = await page.evaluate(() => {
      const layout = document.querySelector<HTMLElement>(".memory-map-layout")!;
      const stage = document.querySelector<HTMLElement>("[data-map-stage-shell]")!.getBoundingClientRect();
      const inspector = document.querySelector<HTMLElement>("[data-map-inspector]")!;
      const inspectorRect = inspector.getBoundingClientRect();
      return {
        mediaMatches: window.matchMedia("(max-width: 900px)").matches,
        layoutDisplay: getComputedStyle(layout).display,
        stageWidth: stage.width,
        inspectorWidth: inspectorRect.width,
        inspectorPosition: getComputedStyle(inspector).position,
        documentHeight: document.documentElement.scrollHeight
      };
    });
    expect(geometry.mediaMatches).toBe(true);
    expect(geometry.layoutDisplay).toBe("block");
    expect(geometry.stageWidth).toBeGreaterThan(760);
    expect(geometry.inspectorWidth).toBeGreaterThan(800);
    expect(geometry.inspectorPosition).toBe("fixed");
    expect(geometry.documentHeight).toBeLessThan(1200);
  });

  test("keeps keyboard node selection concise and closes it after selection", async ({ page }) => {
    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-failure-trace&lang=ja");

    const picker = page.locator(".memory-map-accessible-picker");
    await picker.locator("summary").click();
    await expect(picker.locator("[data-map-accessible-count]")).toHaveText("2件中2件を表示");
    await expect(picker.locator("li")).toHaveCount(2);
    await expect(picker).not.toContainText("failure_prevention:");
    await picker.locator("button").last().click();
    await expect(picker).not.toHaveAttribute("open", "");
  });

  test("keeps the map and trace in a bounded desktop reading surface", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 900 });
    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=decision:rationale-e2e&trace_step=artifact");

    const geometry = await page.evaluate(() => {
      const stage = document.querySelector<HTMLElement>("[data-map-stage-shell]")!.getBoundingClientRect();
      const inspector = document.querySelector<HTMLElement>("[data-map-inspector]")!;
      const inspectorRect = inspector.getBoundingClientRect();
      return {
        stageHeight: stage.height,
        inspectorHeight: inspectorRect.height,
        inspectorClientHeight: inspector.clientHeight,
        inspectorScrollHeight: inspector.scrollHeight
      };
    });
    expect(Math.abs(geometry.stageHeight - geometry.inspectorHeight)).toBeLessThan(3);
    expect(geometry.stageHeight).toBeLessThanOrEqual(545);
    expect(geometry.inspectorScrollHeight).toBeGreaterThanOrEqual(geometry.inspectorClientHeight);
    await page.locator("[data-trace-step='decision']").focus();
    await page.keyboard.press("End");
    await expect(page.locator("[data-trace-step='artifact']")).toBeFocused();
    await expect(page).toHaveURL(/trace_step=artifact/u);
  });

  test("makes observed actors and projects keyboard-operable", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");

    const actor = page.locator(".topology-entity-link").first();
    await actor.focus();
    await expect(actor).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/event=usage%3Aevt-1/);
  });

  test("switches Strata to a vertical timeline at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/decisions/history?tenant_id=default&project_id=org-brain&lang=ja");

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
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");
    await expect(page.locator(".topology-fallback")).toBeVisible();
    await expect(page.getByRole("heading", { name: "観測中のエージェント" })).toBeVisible();
    await expect(page.locator(".console-primary-links")).toBeHidden();
    await page.locator(".console-mobile-nav summary").click();
    await expect(page.locator(".console-mobile-nav-panel").getByRole("link", { name: "知識のつながり" })).toBeVisible();
    expect(await page.locator(".activity-timeline").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.locator(".timeline-overview").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("uses the on-mode navigation and keeps the canonical Task route", async ({ page }) => {
    await page.goto("/?tenant_id=default&project_id=org-brain&lang=ja");
    await expect(page.getByRole("link", { name: "活動", exact: true })).toHaveAttribute("aria-current", "page");
    await page.locator(".console-nav-menu summary").click();
    await expect(page.getByRole("link", { name: "従来のダッシュボード" })).toHaveCount(0);
    const taskHref = await page.getByRole("link", { name: "Task一覧", exact: true }).getAttribute("href");
    const taskUrl = new URL(taskHref ?? "", page.url());
    expect(taskUrl.pathname).toBe("/tasks");
    expect(taskUrl.searchParams.get("tenant_id")).toBe("default");
    expect(taskUrl.searchParams.get("project_id")).toBe("org-brain");
    expect(taskUrl.searchParams.get("lang")).toBe("ja");
    await expect(page.getByRole("link", { name: /Labs/ })).toHaveCount(0);
  });

  test("disables visualization animation for reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");

    const animationName = await page.locator(".flow").first().evaluate((element) =>
      getComputedStyle(element).animationName
    );
    expect(animationName).toBe("none");
  });

  test("renders honest empty activity and partial Strata states", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=e2e-empty&lang=ja");
    await expect(page.getByText("表示できるアクティビティはまだありません")).toBeVisible();

    await page.goto("/decisions/history?tenant_id=default&project_id=e2e-partial-error&lang=ja");
    await expect(page.getByRole("alert")).toContainText("Strata detail fixture unavailable");
    await expect(page.getByRole("heading", { name: "知識の履歴" })).toBeVisible();
  });

  test("surfaces activity API errors and Strata truncation", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=e2e-error&lang=ja");
    await expect(page.getByRole("alert")).toContainText("Dashboard fixture unavailable");
    await expect(page.getByText("活動状況を判断できません")).toBeVisible();
    await expect(page.getByText("表示できるアクティビティはまだありません")).toHaveCount(0);
    await expect(page.getByText("現在、対応が必要なシグナルはありません")).toHaveCount(0);

    await page.goto("/decisions/history?tenant_id=default&project_id=e2e-truncated&lang=ja");
    await expect(page.getByText("古いリビジョンの一部は表示上限により省略されています。")).toBeVisible();
    await expect(page.getByText("参照元の一部は表示上限により省略されています。")).toBeVisible();
  });

  test("keeps the canonical Task dashboard honest and filterable", async ({ page }) => {
    await page.goto("/tasks?tenant_id=default&project_id=e2e-task-error&lang=ja");
    await expect(page.getByRole("alert")).toContainText("Taskを取得できませんでした");
    await expect(page.getByText("Task fixture unavailable")).toBeVisible();
    await expect(page.getByText("現在のスコープに一致するTaskはありません。")).toHaveCount(0);

    await page.goto("/tasks?tenant_id=default&project_id=e2e-task-dense&lang=ja&task_q=memory&task_status=succeeded");
    await expect(page.getByRole("searchbox", { name: "Taskを検索" })).toHaveValue("memory");
    await expect(page.getByRole("combobox", { name: "ステータス" })).toHaveValue("succeeded");
    await expect(page.getByRole("table")).toContainText("記憶品質測定");
    await expect(page.getByText("1ページ目")).toBeVisible();
    await expect(page.getByLabel("このページのステータス").getByText("成功", { exact: true })).toBeVisible();
    await page.goto("/dashboard?tenant_id=default&project_id=e2e-task-dense&lang=ja&task_q=memory&task_status=succeeded");
    await expect(page).toHaveURL(/\/tasks\?/u);
    await expect(page.getByRole("searchbox", { name: "Taskを検索" })).toHaveValue("memory");
  });

  test("keeps Operations tenant-scoped through status and replay", async ({ page }) => {
    await page.context().addCookies([{ name: "orgbrain_tenant", value: "tenant-a", domain: "127.0.0.1", path: "/" }]);
    const replayRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/ops/tasks/") && request.method() === "POST") replayRequests.push(request);
    });

    await page.goto("/operations");
    await expect(page.getByText("対象: tenant-a")).toBeVisible();
    await expect(page.getByRole("heading", { name: "対応が必要な項目" })).toBeVisible();
    await page.getByRole("button", { name: "再実行" }).click();
    await expect.poll(() => replayRequests.length).toBe(1);
    expect(JSON.parse(replayRequests[0].postData() ?? "{}").tenant_id).toBe("tenant-a");
    await expect(page.locator("#replay-result")).toContainText("replayed-tenant-a");
  });

  test("keeps sparse and high-density activity and Strata states usable", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=e2e-sparse&lang=ja");
    await expect(page.locator(".activity-timeline > header > span")).toContainText("1");
    await expect(page.getByText("Dense activity 1")).toHaveCount(0);

    await page.goto("/overview?tenant_id=default&project_id=e2e-dense&lang=ja");
    await expect(page.locator(".activity-timeline > header > span")).toContainText("250");
    await expect(page.locator(".timeline-bucket")).toHaveCount(12);
    expect(await page.locator(".activity-timeline").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator(".timeline-event-list > summary").click();
    await expect(page.locator(".timeline-event-list li")).toHaveCount(244);
    await page.locator(".timeline-event-list li").last().scrollIntoViewIfNeeded();
    await expect(page.locator(".timeline-event-list li").last()).toBeVisible();

    await page.goto("/decisions/history?tenant_id=default&project_id=e2e-dense&lang=ja");
    await expect(page.locator(".strata-event")).toHaveCount(101);
    await expect(page.locator(".legend-truncated")).toBeVisible();
  });

  test("keeps the activity timeline compact without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/overview?tenant_id=default&project_id=e2e-dense&lang=ja");

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
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");

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
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");
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
    await expect(page.locator(".timeline-recent").getByText("Task「Index parity check」が失敗しました。")).toBeVisible();

    await page.clock.fastForward(59_999);
    expect(incrementalRequests).toBe(1);
    await page.clock.fastForward(1);
    await expect.poll(() => incrementalRequests).toBe(2);
    await expect(page.locator(".timeline-recent").getByText("Task「Index parity check」が失敗しました。")).toBeVisible();
  });
});
