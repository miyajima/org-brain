import { expect, test } from "@playwright/test";

test.describe("identity administration", () => {
  test("saves organization details in the management workspace", async ({ page }) => {
    await page.goto("/organization?tenant_id=default&project_id=org-brain&lang=en");
    await expect(page).toHaveURL(/\/settings\?.*section=organization/);
    await expect(page.getByRole("heading", { name: "Organization", exact: true })).toBeVisible();
    const form = page.locator('[data-op-api-form][data-endpoint="/api/v1/organization"]');
    await form.getByLabel("Display name", { exact: true }).fill("Updated Organization");
    const response = page.waitForResponse(response => response.url().includes("/api/v1/organization") && response.request().method() === "PATCH");
    await form.getByRole("button", { name: "Save changes", exact: true }).click();
    const saved = await response;
    expect(saved.status()).toBe(200);
    expect(saved.request().postDataJSON()).toMatchObject({ tenant_id: "default", display_name: "Updated Organization" });
    await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
    await expect(page).toHaveURL(/project_id=org-brain/);
  });

  test("reviews localized invitations and cancels without sending", async ({ page }) => {
    const invitations: unknown[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/v1/users" && request.method() === "POST") invitations.push(request.postDataJSON());
    });
    await page.goto("/settings?section=users&tenant_id=default&lang=zh");
    await page.getByText("邀请用户", { exact: true }).click();
    const form = page.locator('[data-op-api-form][data-endpoint="/api/v1/users"]');
    await form.getByLabel("邮箱", { exact: true }).fill("zh-preview@example.com");
    await form.getByLabel("显示名称", { exact: true }).fill("中文预览用户");
    await form.getByRole("button", { name: "创建邀请", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("zh-preview@example.com");
    await expect(dialog).toContainText("查看者");
    await expect(dialog).toContainText("邀请后仍可更改使用状态和角色");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(invitations).toEqual([]);
  });

  test("creates an invitation only after reviewing the target and role", async ({ page }) => {
    await page.goto("/users?tenant_id=default&lang=en");
    const existing = page.locator("details.op-disclosure").filter({ has: page.locator('summary', { hasText: "E2E Full Name" }) });
    await existing.locator(":scope > summary").click();
    await expect(existing.getByLabel("Full name", { exact: true })).toHaveValue("E2E Full Name");
    await page.getByText("Invite user", { exact: true }).click();
    const form = page.locator('[data-op-api-form][data-endpoint="/api/v1/users"]');
    await form.getByLabel("Email", { exact: true }).fill("invite@example.com");
    await form.getByLabel("Display name", { exact: true }).fill("Invited User");
    await form.getByRole("button", { name: "Create invitation", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("invite@example.com");
    await expect(dialog).toContainText("Reader");
    const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/users" && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Apply change", exact: true }).click();
    const saved = await response;
    expect(saved.status()).toBe(201);
    expect(saved.request().postDataJSON()).toMatchObject({ tenant_id: "default", email: "invite@example.com", display_name: "Invited User", role: "reader" });
    await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  });

  test("protects an owner and explains how to add another owner", async ({ page }) => {
    await page.goto("/groups?tenant_id=default&lang=en");
    await expect(page.getByText("Local review group", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /Reviewers.*View members/u }).click();
    await expect(page.getByRole("heading", { name: "Reviewers", exact: true })).toBeVisible();
    const owner = page.locator("details.op-disclosure").filter({ has: page.locator('summary', { hasText: "E2E Login User" }) });
    await owner.locator(":scope > summary").click();
    await owner.getByText("Technical details", { exact: true }).click();
    await expect(owner.getByText("user:e2e-login-sub", { exact: true })).toBeVisible();
    await expect(owner).toContainText(/cannot remove yourself while you are an owner/u);
    await expect(owner.getByRole("button", { name: "Review removal impact", exact: true })).toHaveCount(0);
    const addOwner = owner.getByRole("link", { name: "Add another owner", exact: true });
    await expect(addOwner).toBeVisible();
    await expect(addOwner).toHaveAttribute("href", "#add-group-member");
  });

  test("previews removal in Chinese and leaves membership intact on cancellation", async ({ page }) => {
    let removals = 0;
    page.on("request", request => { if (request.method() === "DELETE" && request.url().includes("/api/v1/groups/group-e2e/members/")) removals++; });
    await page.goto("/groups/group-e2e?tenant_id=default&lang=zh");
    const member = page.locator("details.op-disclosure").filter({ has: page.locator('summary', { hasText: "E2E Member" }) });
    await member.locator(":scope > summary").click();
    await member.getByRole("button", { name: "查看移除影响", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("将失去 2 项访问权限");
    await expect(dialog).toContainText("保留 1 项");
    await expect(dialog).toContainText("可以重新添加同一用户");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(removals).toBe(0);
    await expect(member.getByRole("button", { name: "查看移除影响", exact: true })).toBeEnabled();
  });

  test("confirms member impact with keyboard focus and the reviewed digest", async ({ page }) => {
    await page.goto("/settings?section=groups&id=group-e2e&tenant_id=default&lang=en");
    const member = page.locator("details.op-disclosure").filter({ has: page.locator('summary', { hasText: "E2E Member" }) });
    await member.locator(":scope > summary").click();
    await member.getByRole("button", { name: "Review removal impact", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    const apply = dialog.getByRole("button", { name: "Apply change", exact: true });
    await expect(dialog).toContainText("access to 2 items");
    await expect(dialog).toContainText("access to 1");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(apply).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancel).toBeFocused();
    const response = page.waitForResponse(response => response.request().method() === "DELETE" && response.url().includes("/api/v1/groups/group-e2e/members/user%3Amember"));
    await apply.click();
    const saved = await response;
    expect(saved.status()).toBe(200);
    expect(saved.request().headers()["if-match"]).toBe("e2e-impact-digest");
    await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  });

  test("adds a business category", async ({ page }) => {
    await page.goto("/business-categories?tenant_id=default&lang=en");
    await page.getByText("Engineering", { exact: true }).click();
    await expect(page.locator('input[value="Engineering"]')).toBeVisible();
    await page.getByText("Add category", { exact: true }).click();
    const form = page.locator('[data-op-api-form][data-endpoint="/api/v1/business-categories"]');
    await form.getByLabel("Label", { exact: true }).fill("Support");
    await form.getByLabel("Slug", { exact: true }).fill("support");
    const response = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/business-categories");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    const saved = await response;
    expect(saved.status()).toBe(201);
    expect(saved.request().postDataJSON()).toMatchObject({ tenant_id: "default", label: "Support", slug: "support", is_active: true });
    await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
  });
});
