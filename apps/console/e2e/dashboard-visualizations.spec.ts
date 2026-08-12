import { expect, test } from "@playwright/test";

test.describe("dashboard visualizations", () => {
  test("renders the observed activity home without sensitive payloads", async ({ page }) => {
    await page.goto("/?tenant_id=default&project_id=org-brain&lang=ja");

    await expect(page.getByRole("heading", { name: "組織の活動" })).toBeVisible();
    await expect(page.locator(".insight-page-guide")).toBeVisible();
    await expect(page.locator(".insight-page-guide dt").filter({ hasText: "この画面を使う場面" })).toBeHidden();
    await page.locator(".insight-page-guide summary").click();
    await expect(page.locator(".insight-page-guide dt").filter({ hasText: "この画面を使う場面" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "いま見るべきこと" })).toBeVisible();
    await expect(page.locator(".insight-scope-rail")).toContainText("default");
    await expect(page.locator(".insight-scope-rail")).toContainText("org-brain");
    await expect(page.locator(".insight-scope-rail")).toContainText("含まれるデータ");
    await expect(page.locator(".insight-scope-rail")).toContainText("含まれないデータ");
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();
    await expect(page.locator(".recommended-actions").getByText("Taskが失敗しており、確認が必要です。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "過去24時間のイベント" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("input_ref");
    await expect(page.locator("body")).not.toContainText("raw query");
  });

  test("switches the activity timeline beyond the default 24 hours", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja&period=30d");
    await expect(page.getByRole("navigation", { name: "表示期間" })).toBeVisible();
    await expect(page.getByRole("link", { name: "30日", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "過去30日のイベント" })).toBeVisible();
    await expect(page.getByText("30日前", { exact: true })).toBeVisible();
    await expect(page.locator(".period-comparison")).toContainText("過去24時間との比較");
    await page.locator(".activity-topology > summary").click();
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
    const filteredEvents = page.locator(".timeline-event-list");
    await expect(filteredEvents.getByText("「Login principal group ACL design」を参照しました。")).toHaveCount(1);
    await expect(filteredEvents.getByText("Task「Index parity check」が失敗しました。")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "すべての活動を表示" })).toHaveAttribute("aria-current", "true");
  });

  test("supports keyboard graph selection and source deep links", async ({ page }) => {
    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja");

    await expect(page.getByRole("heading", { name: "知識のつながり" })).toBeVisible();
    await page.getByRole("searchbox", { name: "知識を検索" }).fill("ACL");
    await page.getByRole("button", { name: "適用" }).click();
    await expect(page).toHaveURL(/q=ACL/);
    const decision = page.locator('.knowledge-node[href*="selected=decision%3Adecision-e2e"]');
    await decision.focus();
    await expect(decision).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/selected=decision%3Adecision-e2e/);
    await expect(page.getByRole("heading", { name: "Use authenticated principals for shared memory" })).toBeVisible();
    const sourceHref = await page.getByRole("link", { name: "内容を確認" }).getAttribute("href");
    const sourceUrl = new URL(sourceHref ?? "", page.url());
    expect(sourceUrl.pathname).toBe("/decisions");
    expect(sourceUrl.searchParams.get("tenant_id")).toBe("default");
    expect(sourceUrl.searchParams.get("project_id")).toBe("org-brain");
    expect(sourceUrl.searchParams.get("lang")).toBe("ja");
    await page.getByRole("link", { name: "一覧", exact: true }).click();
    await expect(page.getByRole("heading", { name: "表示中の知識" })).toBeVisible();
    await page.getByText(/^表示中の関係/).click();
    await expect(page.locator(".inspector-relations").getByText("根拠", { exact: true })).toBeVisible();
    await expect(page.locator(".inspector-relations")).toContainText("この知識から");
  });

  test("makes observed actors and projects keyboard-operable", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");

    const actor = page.locator(".topology-entity-link").first();
    await page.locator(".activity-topology > summary").click();
    await actor.focus();
    await expect(actor).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/event=usage%3Aevt-1/);
  });

  test("recovers from a missing graph deep link and explains the fallback", async ({ page }) => {
    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja&selected=memory%3Amissing");
    await expect(page).not.toHaveURL(/selected=/u);
    await expect(page).toHaveURL(/notice=selection-fallback/u);
    await expect(page.locator(".selection-fallback")).toContainText("指定された知識は見つかりませんでした");
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

  test("keeps the activity fallback and bounded graph usable at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");
    await page.locator(".activity-topology > summary").click();
    await expect(page.locator(".topology-fallback")).toBeVisible();
    await expect(page.getByRole("heading", { name: "観測中のエージェント" })).toBeVisible();
    await expect(page.locator(".console-primary-links")).toBeHidden();
    await page.locator(".console-mobile-nav summary").click();
    await expect(page.locator(".console-mobile-nav-panel").getByRole("link", { name: "知識のつながり" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja");
    const graphViewport = page.locator(".graph-viewport");
    expect(await graphViewport.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole("link", { name: "一覧", exact: true }).click();
    await expect(page.getByRole("heading", { name: "表示中の知識" })).toBeVisible();
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

  test("renders honest empty and partial-error states", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=e2e-empty&lang=ja");
    await expect(page.getByText("表示できるアクティビティはまだありません")).toBeVisible();

    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-empty&lang=ja");
    await expect(page.getByText("表示できるノードがありません")).toBeVisible();

    await page.goto("/decisions/history?tenant_id=default&project_id=e2e-partial-error&lang=ja");
    await expect(page.getByRole("alert")).toContainText("Strata detail fixture unavailable");
    await expect(page.getByRole("heading", { name: "知識の履歴" })).toBeVisible();
  });

  test("surfaces API errors and explicit truncation", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=e2e-error&lang=ja");
    await expect(page.getByRole("alert")).toContainText("Dashboard fixture unavailable");
    await expect(page.getByText("活動状況を判断できません")).toBeVisible();
    await expect(page.getByText("表示できるアクティビティはまだありません")).toHaveCount(0);
    await expect(page.getByText("現在、対応が必要なシグナルはありません")).toHaveCount(0);

    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-truncated&lang=ja");
    await expect(page.getByText(/42/)).toBeVisible();

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
    await expect(page.getByText("成功", { exact: true })).toBeVisible();
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

  test("keeps sparse and high-density dashboard states usable", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=e2e-sparse&lang=ja");
    await expect(page.locator(".activity-timeline > header > span")).toContainText("1");
    await expect(page.getByText("Dense activity 1")).toHaveCount(0);

    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-sparse&lang=ja");
    await expect(page.locator(".knowledge-node")).toHaveCount(1);

    await page.goto("/overview?tenant_id=default&project_id=e2e-dense&lang=ja");
    await expect(page.locator(".activity-timeline > header > span")).toContainText("250");
    await page.locator(".timeline-event-list > summary").click();
    const lastDenseActivity = page.getByText("Dense activity 250");
    await lastDenseActivity.scrollIntoViewIfNeeded();
    await expect(lastDenseActivity).toBeVisible();

    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-dense&lang=ja");
    await expect(page.locator(".knowledge-node")).toHaveCount(150);
    await expect(page.locator(".graph-status")).toContainText("150");
    await expect(page.locator(".graph-warning")).toContainText("37");

    await page.goto("/decisions/history?tenant_id=default&project_id=e2e-dense&lang=ja");
    await expect(page.locator(".strata-event")).toHaveCount(101);
    await expect(page.locator(".legend-truncated")).toBeVisible();
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
    await expect(page.locator(".recommended-actions").getByText("Taskが失敗しており、確認が必要です。")).toBeVisible();

    await page.clock.fastForward(59_999);
    expect(incrementalRequests).toBe(1);
    await page.clock.fastForward(1);
    await expect.poll(() => incrementalRequests).toBe(2);
    await expect(page.locator(".recommended-actions").getByText("Taskが失敗しており、確認が必要です。")).toBeVisible();
  });
});
