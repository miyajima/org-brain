import { expect, test } from "@playwright/test";

test.describe("read-only memory quality view", () => {
  test("shows seven independent axes and privacy-safe active/excluded cases", async ({ page }) => {
    await page.goto("/memories?view=quality");
    const view = page.locator("[data-quality-view]");
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute("data-readonly", "true");
    await expect(view.locator("[data-quality-axis]")).toHaveCount(7);
    await expect(view.getByText("Wilson lower 96.4%", { exact: false })).toHaveCount(7);
    await expect(view.locator("[data-quality-case]")).toHaveCount(2);
    await expect(view.getByText("credential_detected")).toBeVisible();
    await expect(view.getByText("excluded-hash")).toBeVisible();
    await expect(view.getByText("Login principal group ACL design")).toBeVisible();
    await expect(view.getByRole("button", { name: /save|suppress|delete/i })).toHaveCount(0);
  });

  test("has a stable empty state on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/memories?view=quality&project_hash=empty");
    await expect(page.getByText("No quality cases.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
