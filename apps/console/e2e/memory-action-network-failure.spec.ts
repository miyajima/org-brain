import { expect, test } from "@playwright/test";

const memoryPage = "/memories?selected=mem_auth_group_acl&tenant_id=default&lang=en";

test.describe("memory controls recover from network failures", () => {
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
