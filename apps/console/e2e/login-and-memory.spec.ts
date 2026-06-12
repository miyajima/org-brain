import { expect, test } from "@playwright/test";

test.describe("authenticated console flows", () => {
  test("shows login identity and saves display-only profile fields", async ({ page }) => {
    await page.goto("/profile");

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(page.getByText("user:e2e-login-sub · access-jwt")).toBeVisible();
    await expect(page.getByLabel("Display name")).toHaveValue("E2E Login User");
    await expect(page.getByLabel("Company name")).toHaveValue("Example Holdings");
    await expect(page.getByLabel("Organization name")).toHaveValue("Platform Lab");

    await page.getByLabel("Company name").fill("Cross Company Alliance");
    await page.getByLabel("Organization name").fill("Memory Guild");
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText("Saved")).toBeVisible();
  });

  test("searches, opens, and refreshes a managed memory", async ({ page }) => {
    await page.goto("/memories");

    await expect(page.getByRole("heading", { name: "Memory Explorer" })).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Memories" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Login principal group ACL design").first()).toBeVisible();
    await expect(page.getByText("1 visible")).toBeVisible();
    await expect(page.getByText("1 canonical")).toBeVisible();

    await page.getByLabel("Search memories").fill("group ACL login principal");
    await page.getByRole("button", { name: "Search memory" }).click();

    await expect(page).toHaveURL(/q=group\+ACL\+login\+principal/);
    await expect(page.getByText("Ranked matches")).toBeVisible();
    await expect(page.getByText("mock-hybrid")).toBeVisible();
    await expect(page.getByText("Login principals and group ACLs decide who can read shared organization memory.").first()).toBeVisible();

    await page.getByRole("link", { name: /Login principal group ACL design/ }).first().click();

    await expect(page).toHaveURL(/selected=mem_auth_group_acl/);
    await expect(page.getByRole("complementary").getByRole("heading", { name: "Login principal group ACL design" })).toBeVisible();
    await expect(page.getByText("Lifecycle actions")).toBeVisible();
    await expect(page.getByText("user:e2e-login-sub")).toBeVisible();

    const refreshResponse = page.waitForResponse((response) =>
      response.url().includes("/api/v1/memories/refresh") && response.status() === 200
    );
    await page.getByRole("button", { name: "Refresh" }).click();
    await refreshResponse;

    await expect(page.getByRole("heading", { name: "Memory Explorer" })).toBeVisible();
  });
});
