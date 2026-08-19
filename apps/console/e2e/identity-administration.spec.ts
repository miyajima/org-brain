import { expect, test } from "@playwright/test";

test.describe("identity administration", () => {
  test("manages organization, users, groups, and business categories", async ({ page }) => {
    await page.goto("/organization?tenant_id=default");
    await expect(page.getByRole("heading", { name: "Organization" })).toBeVisible();
    await page.getByLabel("Display name").fill("Updated Organization");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    await page.goto("/users?tenant_id=default");
    await expect(page.getByLabel("Full name").last()).toHaveValue("E2E Full Name");
    await page.getByLabel("Email").first().fill("invite@example.com");
    await page.getByLabel("Display name").first().fill("Invited User");
    await page.getByRole("button", { name: "Invite" }).click();
    await expect(page.getByText("Invitation created.", { exact: true })).toBeVisible();

    await page.goto("/groups?tenant_id=default");
    await expect(page.getByText("Local review group")).toBeVisible();
    await page.getByRole("link", { name: "Details" }).click();
    await expect(page.getByRole("heading", { name: "Reviewers" })).toBeVisible();
    await expect(page.getByText("user:e2e-login-sub")).toBeVisible();

    await page.goto("/business-categories?tenant_id=default");
    await expect(page.locator('input[value="Engineering"]')).toBeVisible();
    await page.getByLabel("Label").first().fill("Support");
    await page.getByLabel("Slug").first().fill("support");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Saved")).toBeVisible();
  });
});
