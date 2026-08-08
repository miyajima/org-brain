import { expect, test } from "@playwright/test";

test.describe("dashboard visualizations", () => {
  test("renders the observed activity home without sensitive payloads", async ({ page }) => {
    await page.goto("/?tenant_id=default&project_id=org-brain&lang=ja");

    await expect(page.getByRole("heading", { name: "あなたの組織は、リアルタイムで学習しています" })).toBeVisible();
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("A task failed and needs review")).toBeVisible();
    await expect(page.getByRole("heading", { name: "過去24時間のイベント" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("input_ref");
    await expect(page.locator("body")).not.toContainText("raw query");
  });

  test("supports keyboard graph selection and source deep links", async ({ page }) => {
    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja");

    await expect(page.getByRole("heading", { name: "ナレッジ・コンステレーション" })).toBeVisible();
    const decision = page.locator('.knowledge-node[href*="selected=decision%3Adecision-e2e"]');
    await decision.focus();
    await expect(decision).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/selected=decision%3Adecision-e2e/);
    await expect(page.getByRole("heading", { name: "Use authenticated principals for shared memory" })).toBeVisible();
    const sourceHref = await page.getByRole("link", { name: "記録を開く" }).getAttribute("href");
    const sourceUrl = new URL(sourceHref ?? "", page.url());
    expect(sourceUrl.pathname).toBe("/decisions");
    expect(sourceUrl.searchParams.get("tenant_id")).toBe("default");
    expect(sourceUrl.searchParams.get("project_id")).toBe("org-brain");
    expect(sourceUrl.searchParams.get("lang")).toBe("ja");
    await expect(page.getByRole("heading", { name: "表示中の知識" })).toBeVisible();
    await page.getByText(/^表示中の関係/).click();
    await expect(page.getByText("derived_from", { exact: true })).toBeVisible();
  });

  test("switches Strata to a vertical timeline at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/decisions/history?tenant_id=default&project_id=org-brain&lang=ja");

    await expect(page.getByRole("heading", { name: "いま、あなたの組織が知っていること" })).toBeVisible();
    await expect(page.locator(".strata-mobile")).toBeVisible();
    await expect(page.locator(".strata-board")).toBeHidden();
    await expect(page.getByRole("heading", { name: "知識の更新履歴" })).toBeVisible();
    await expect(page.locator(".selected-chain-summary strong")).toHaveText("Login principal group ACL design");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("keeps the activity fallback and bounded graph usable at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/overview?tenant_id=default&project_id=org-brain&lang=ja");
    await expect(page.locator(".topology-fallback")).toBeVisible();
    await expect(page.getByRole("heading", { name: "観測中のエージェント" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.goto("/memories/constellation?tenant_id=default&project_id=org-brain&lang=ja");
    await expect(page.getByRole("heading", { name: "表示中の知識" })).toBeVisible();
    const graphViewport = page.locator(".graph-viewport");
    expect(await graphViewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("uses the on-mode navigation and retains scope in its classic fallback", async ({ page }) => {
    await page.goto("/?tenant_id=default&project_id=org-brain&lang=ja");
    await expect(page.getByRole("link", { name: "概要" })).toHaveAttribute("aria-current", "page");
    await page.getByText("管理", { exact: true }).click();
    const legacyHref = await page.getByRole("link", { name: "従来のダッシュボード" }).getAttribute("href");
    const legacyUrl = new URL(legacyHref ?? "", page.url());
    expect(legacyUrl.pathname).toBe("/dashboard");
    expect(legacyUrl.searchParams.get("tenant_id")).toBe("default");
    expect(legacyUrl.searchParams.get("project_id")).toBe("org-brain");
    expect(legacyUrl.searchParams.get("lang")).toBe("ja");
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
    await expect(page.getByRole("heading", { name: "いま、あなたの組織が知っていること" })).toBeVisible();
  });

  test("surfaces API errors and explicit truncation", async ({ page }) => {
    await page.goto("/overview?tenant_id=default&project_id=e2e-error&lang=ja");
    await expect(page.getByRole("alert")).toContainText("Dashboard fixture unavailable");
    await expect(page.getByText("表示できるアクティビティはまだありません")).toBeVisible();

    await page.goto("/memories/constellation?tenant_id=default&project_id=e2e-truncated&lang=ja");
    await expect(page.getByText(/42/)).toBeVisible();

    await page.goto("/decisions/history?tenant_id=default&project_id=e2e-truncated&lang=ja");
    await expect(page.getByText("古いリビジョンの一部は表示上限により省略されています。")).toBeVisible();
    await expect(page.getByText("参照元の一部は表示上限により省略されています。")).toBeVisible();
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
    await expect(page.getByText("A task failed and needs review")).toBeVisible();

    await page.clock.fastForward(59_999);
    expect(incrementalRequests).toBe(1);
    await page.clock.fastForward(1);
    await expect.poll(() => incrementalRequests).toBe(2);
    await expect(page.getByText("A task failed and needs review")).toBeVisible();
  });
});
