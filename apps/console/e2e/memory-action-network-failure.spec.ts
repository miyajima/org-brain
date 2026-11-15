import { expect, test } from "@playwright/test";

const memoryPage = "/memories?selected=mem_auth_group_acl&tenant_id=default&lang=en&advanced=1";

test.describe("memory controls recover from network failures", () => {
  for (const action of ["refresh", "edit", "assessment"] as const) {
    test(`sends the session CSRF token with ${action}`, async ({ page }) => {
      await page.addInitScript(() => sessionStorage.setItem("orgbrain_csrf", "test-csrf"));
      const path = action === "refresh" ? "memories/refresh" : action === "edit" ? "memories/revise" : "memory-use-evaluations";
      await page.route(`**/api/v1/${path}`, (route) => route.fulfill({ status: 403, json: { ok: false } }));
      await page.goto(memoryPage);
      await expect(page).toHaveURL(/\/memories\?/u);
      if (action === "assessment") {
        await page.locator("[data-memory-use-history] summary").click();
        await page.locator("[data-use-feedback] textarea").fill("Observed improvement");
      }
      const request = page.waitForRequest(`**/api/v1/${path}`);
      if (action === "refresh") await page.locator('[data-memory-action="refresh"]').click();
      else if (action === "edit") await page.locator("[data-memory-save]").click();
      else await page.locator('[data-use-feedback] button[type="submit"]').click();
      expect((await request).headers()["x-csrf-token"]).toBe("test-csrf");
    });
  }
  test("lifecycle action re-enables its button and reports failure when the request never completes", async ({ page }) => {
    await page.route("**/api/v1/memories/refresh", route => route.abort("failed"));
    await page.goto(memoryPage);
    const refresh = page.locator('[data-memory-action="refresh"]');
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.locator("[data-memory-action-status]")).toContainText("refresh failed.");
    await expect(refresh).toBeEnabled();
  });

  test("memory edit form re-enables save and reports failure when the request never completes", async ({ page }) => {
    await page.route("**/api/v1/memories/revise", route => route.abort("failed"));
    await page.goto(memoryPage);
    const save = page.locator("[data-memory-save]");
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator("[data-memory-edit-status]")).toContainText("保存に失敗しました。");
    await expect(save).toBeEnabled();
  });

  test("retries a lost assessment receipt with the same ID and changes it for new input", async ({ page }) => {
    const bodies: Array<{ id: string; feedback: { statement: string } }> = [];
    await page.route("**/api/v1/memory-use-evaluations", (route) => {
      bodies.push(route.request().postDataJSON());
      return bodies.length < 3 ? route.abort("failed") : route.fulfill({ json: { ok: true, data: { verification_state: "verified" } } });
    });
    await page.goto(memoryPage);
    await expect(page).toHaveURL(/\/memories\?/u);
    await page.locator("[data-memory-use-history] summary").click();
    const form = page.locator("[data-use-feedback]");
    await form.locator("textarea").fill("First observation");
    await form.locator('button[type="submit"]').click();
    await expect(form.locator("[data-use-feedback-status]")).toContainText("Retry uses the same ID");
    await form.locator('button[type="submit"]').click();
    await expect.poll(() => bodies.length).toBe(2);
    await expect(form.locator('button[type="submit"]')).toBeEnabled();
    expect(bodies[1].id).toBe(bodies[0].id);
    await form.locator("textarea").fill("Changed observation");
    await form.locator('button[type="submit"]').click();
    await expect(form.locator("[data-use-feedback-status]")).toHaveText("Assessment recorded.");
    expect(bodies[2].id).not.toBe(bodies[1].id);
    expect(bodies[2].feedback.statement).toBe("Changed observation");
  });

  test("does not update edit controls after the page exits while a response is pending", async ({ page }) => {
    let release!: () => void;
    let intercepted!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { intercepted = resolve; });
    await page.route("**/api/v1/memories/revise", async (route) => {
      intercepted();
      await pending;
      await route.fulfill({ status: 403, json: { ok: false } });
    });
    await page.goto(memoryPage);
    await expect(page).toHaveURL(/\/memories\?/u);
    await page.locator("[data-memory-save]").click();
    await started;
    const status = page.locator("[data-memory-edit-status]");
    await expect(status).toHaveText("saving...");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await expect(page.locator("[data-memory-save]")).toBeEnabled();
    const response = page.waitForResponse("**/api/v1/memories/revise");
    release();
    await response;
    await page.waitForTimeout(100);
    await expect(status).toHaveText("saving...");
    await expect(page.locator("[data-memory-save]")).toBeEnabled();
  });

  test("remounts controls once and keeps them active after a cached-page return", async ({ page }) => {
    await page.goto(memoryPage);
    await expect(page).toHaveURL(/\/memories\?/u);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    const mount = () => page.evaluateHandle(async () => {
      const moduleUrl = "/src/lib/memory-page-controller.ts";
      const { mountMemoryPage } = await import(/* @vite-ignore */ moduleUrl);
      return mountMemoryPage(document.querySelector<HTMLElement>("[data-memory-page]")!);
    });
    const first = await mount();
    await first.evaluate((dispose: () => void) => { dispose(); dispose(); });
    const second = await mount();
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    let requests = 0;
    await page.route("**/api/v1/memories/refresh", (route) => {
      requests += 1;
      return route.fulfill({ status: 403, json: { ok: false } });
    });
    await page.locator('[data-memory-action="refresh"]').click();
    await expect(page.locator("[data-memory-action-status]")).toHaveText("refresh failed.");
    expect(requests).toBe(1);
    await second.evaluate((dispose: () => void) => dispose());
  });

  test("reuses the assessment ID after disposal while the first receipt is pending", async ({ page }) => {
    const ids: string[] = [];
    let release!: () => void;
    let intercepted!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { intercepted = resolve; });
    await page.route("**/api/v1/memory-use-evaluations", async (route) => {
      ids.push(route.request().postDataJSON().id);
      if (ids.length === 1) { intercepted(); await pending; }
      await route.fulfill({ json: { ok: true, data: { verification_state: "verified" } } });
    });
    await page.goto(memoryPage);
    await expect(page).toHaveURL(/\/memories\?/u);
    await page.locator("[data-memory-use-history] summary").click();
    const form = page.locator("[data-use-feedback]");
    await form.locator("textarea").fill("Same observation");
    await form.locator('button[type="submit"]').click();
    await started;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    const dispose = await page.evaluateHandle(async () => {
      const moduleUrl = "/src/lib/memory-page-controller.ts";
      const { mountMemoryPage } = await import(/* @vite-ignore */ moduleUrl);
      return mountMemoryPage(document.querySelector<HTMLElement>("[data-memory-page]")!);
    });
    await form.locator('button[type="submit"]').click();
    await expect(form.locator("[data-use-feedback-status]")).toHaveText("Assessment recorded.");
    expect(ids[1]).toBe(ids[0]);
    release();
    await form.locator("textarea").fill("Different observation");
    await form.locator('button[type="submit"]').click();
    await expect.poll(() => ids.length).toBe(3);
    expect(ids[2]).not.toBe(ids[1]);
    await dispose.evaluate((stop: () => void) => stop());
  });

  test("does not let an older assessment receipt replace a newer submission", async ({ page }) => {
    const ids: string[] = [];
    let release!: () => void;
    let intercepted!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { intercepted = resolve; });
    await page.route("**/api/v1/memory-use-evaluations", async (route) => {
      ids.push(route.request().postDataJSON().id);
      if (ids.length === 1) { intercepted(); await pending; }
      await route.fulfill({ json: { ok: true, data: { verification_state: "verified" } } });
    });
    await page.goto(memoryPage);
    await page.locator("[data-memory-use-history] summary").click();
    const form = page.locator("[data-use-feedback]");
    await form.locator("textarea").fill("Older observation");
    await form.locator('button[type="submit"]').click();
    await started;
    await form.locator("textarea").fill("Newer observation");
    await form.evaluate((element: HTMLFormElement) => element.requestSubmit());
    await expect(form.locator("[data-use-feedback-status]")).toHaveText("Assessment recorded.");
    expect(ids[1]).not.toBe(ids[0]);
    await expect(form.locator('input[name="supersedes_id"]')).toHaveValue(ids[1]);
    const firstResponse = page.waitForResponse("**/api/v1/memory-use-evaluations");
    release();
    await firstResponse;
    await page.waitForTimeout(100);
    await expect(form.locator('input[name="supersedes_id"]')).toHaveValue(ids[1]);
  });

  test("requires the memory ID for permanent deletion and recovers when deletion fails", async ({ page }) => {
    let requests = 0;
    await page.route("**/api/v1/memories/mem_auth_group_acl?**", (route) => {
      requests += 1;
      return route.abort("failed");
    });
    await page.goto("/memories?selected=mem_auth_group_acl&tenant_id=r8b-trash-fixture&lang=en&advanced=1");
    await expect(page).toHaveURL(/\/memories\?/u);
    const button = page.locator('[data-memory-action="permanent-delete"]');
    await expect(button).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept("wrong"));
    await button.click();
    expect(requests).toBe(0);
    page.once("dialog", (dialog) => dialog.accept("mem_auth_group_acl"));
    await button.click();
    await expect(page.locator("[data-memory-action-status]")).toHaveText("permanent-delete failed.");
    await expect(button).toBeEnabled();
    expect(requests).toBe(1);
  });
});
