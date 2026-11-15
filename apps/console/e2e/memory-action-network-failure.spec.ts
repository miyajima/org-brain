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
});
