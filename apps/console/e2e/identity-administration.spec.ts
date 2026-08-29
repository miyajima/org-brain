import { expect, test } from "@playwright/test";

test.describe("identity administration", () => {
  test("manages organization, users, groups, and business categories", async ({ page }) => {
    await page.goto("/organization?tenant_id=default");
    await expect(page.getByRole("heading", { name: "Organization" })).toBeVisible();
    await page.getByLabel("Display name").fill("Updated Organization");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    await page.goto("/users?tenant_id=default&lang=zh");
    await page.getByLabel("电子邮箱").first().fill("zh-preview@example.com");
    await page.getByLabel("显示名称").first().fill("中文预览用户");
    await page.getByRole("button", { name: "发送邀请" }).click();
    const zhInviteDialog = page.getByRole("dialog");
    await expect(zhInviteDialog).toContainText("将以所选角色邀请此用户加入该租户");
    await expect(zhInviteDialog).toContainText("邀请后仍可更改使用状态和角色");
    await page.keyboard.press("Escape");
    await expect(zhInviteDialog).toBeHidden();

    await page.goto("/users?tenant_id=default");
    await expect(page.getByLabel("Full name").last()).toHaveValue("E2E Full Name");
    await page.getByLabel("Email").first().fill("invite@example.com");
    await page.getByLabel("Display name").first().fill("Invited User");
    await page.getByRole("button", { name: "Invite" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm this change" })).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("invite@example.com");
    await page.getByRole("button", { name: "Apply change" }).click();
    await expect(page.getByText("Invitation created.", { exact: true })).toBeVisible();

    await page.goto("/groups?tenant_id=default");
    await expect(page.getByText("Local review group")).toBeVisible();
    await page.getByRole("link", { name: "Details" }).click();
    await expect(page.getByRole("heading", { name: "Reviewers" })).toBeVisible();
    const ownerRow = page.getByRole("row", { name: /E2E Login User/u });
    await expect(ownerRow.getByText("E2E Login User", { exact: true })).toBeVisible();
    await ownerRow.getByText("Technical details", { exact: true }).click();
    await expect(ownerRow.getByText(/user:e2e-login-sub/u)).toBeVisible();
    await expect(ownerRow.getByText(/cannot remove yourself while you are an owner/u)).toBeVisible();
    await expect(ownerRow.getByRole("link", { name: "Add another owner" })).toHaveAttribute("href", "#add-group-member");
    await expect(ownerRow.getByRole("button", { name: /Remove E2E Login User/u })).toHaveCount(0);

    await page.goto("/groups/group-e2e?tenant_id=default&lang=zh");
    const zhRemoveMember = page.getByRole("button", { name: "从群组移除E2E Member" });
    await expect(zhRemoveMember).toBeEnabled();
    await zhRemoveMember.click();
    const zhDialog = page.getByRole("dialog");
    await expect(zhDialog).toContainText("将失去 2 项访问权限");
    await expect(zhDialog).toContainText("可以重新添加同一用户");
    await page.keyboard.press("Escape");
    await expect(zhDialog).toBeHidden();

    await page.goto("/groups/group-e2e?tenant_id=default");
    const removeMember = page.getByRole("button", { name: "Remove E2E Member from group" });
    await expect(removeMember).toBeEnabled();
    await removeMember.click();
    const removeDialog = page.getByRole("dialog", { name: "Confirm this change" });
    const cancelRemoval = removeDialog.getByRole("button", { name: "Cancel" });
    const applyRemoval = removeDialog.getByRole("button", { name: "Apply change" });
    await expect(removeDialog).toContainText("lose access to 2 items");
    await expect(cancelRemoval).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(applyRemoval).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(cancelRemoval).toBeFocused();
    await applyRemoval.click();
    await expect(page.getByText("Membership updated", { exact: true })).toBeVisible();

    await page.goto("/business-categories?tenant_id=default");
    await expect(page.locator('input[value="Engineering"]')).toBeVisible();
    await page.getByLabel("Label").first().fill("Support");
    await page.getByLabel("Slug").first().fill("support");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Saved")).toBeVisible();
  });
});
