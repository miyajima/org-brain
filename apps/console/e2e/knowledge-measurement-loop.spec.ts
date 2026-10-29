import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("shows the post-onboarding measurement loop and its work locations", async ({ page }) => {
  await page.goto("/knowledge-dashboard?tenant_id=default&project_id=org-brain&lang=ja");
  await expect(page).toHaveURL(/\/\?.*project_id=org-brain/u);
  await expect(page.getByRole("heading", { name: "プロジェクトの指標と改善" })).toBeVisible();
  await expect(page.getByText("Build成功率")).toBeVisible();
  await expect(page.locator("#goal-goal-link-e2e")).toContainText("91");
  await page.getByRole("link", { name: "振り返りを開く" }).click();
  await expect(page.getByRole("heading", { name: "振り返り", exact:true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "定期実施を有効化" })).toBeVisible();
  await expect(page.getByLabel("実施間隔")).toHaveValue("7");
  await expect(page.getByText(/14 · 有効/)).toBeVisible();
  await page.getByRole("link", { name: /CI decision review/ }).click();
  await expect(page.getByText("Retry only infrastructure failures", {exact:true}).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /https:\/\/example.com\/evidence/ })).toHaveAttribute("href", "https://example.com/evidence");
  await expect(page.getByText("internal:evidence")).not.toHaveAttribute("href");
  await page.getByRole("radio", { name: "採用", exact: true }).check();
  await page.getByRole("button", { name: "この判断を保存" }).click();
  await expect(page.getByText("Retry only infrastructure failures", {exact:true}).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "管理者として確定" })).toBeVisible();
  await expect(page.getByText("回答済み").first()).toBeVisible();
  await page.getByLabel("結果を選択").selectOption("not_adopted");
  await page.getByLabel("未回答が残る状態で確定することを確認しました").check();
  await page.getByRole("button", { name: "結果を確定して閉じる" }).click();
  await Promise.all([
    page.waitForNavigation({waitUntil:"domcontentloaded"}),
    page.getByRole("dialog").getByRole("button", {name:"変更を適用"}).click()
  ]);
  await expect(page).toHaveURL(/\/settings\?.*section=retrospectives.*id=retro-e2e/);
  await expect(page.getByRole("status")).toContainText("保存しました");
  await expect(page.getByText("Retry only infrastructure failures", {exact:true}).first()).toBeVisible();

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(accessibility.violations).toEqual([]);

  await page.goto("/improvement-actions?tenant_id=default&project_id=org-brain&lang=ja");
  await expect(page.getByRole("heading", { name: "改善アクション" })).toBeVisible();
  await expect(page.getByText("Stabilize CI")).toBeVisible();
  await expect(page.getByText("基準値")).toBeVisible();
  await expect(page.getByRole("link", { name: "外部Issueを開く ↗" })).toHaveAttribute("href", "https://github.com/example/repo/issues/1");
});

test("keeps participant and admin retrospective controls hidden in read-only preview", async ({ page }) => {
  for (const suffix of ["", "/admin"]) {
    await page.goto(`/retrospectives/retro-e2e${suffix}?tenant_id=preview-readonly&lang=ja`);
    await expect(page).toHaveURL(/\/settings\?.*section=retrospectives.*id=retro-e2e/);
    await expect(page.getByText("Retry only infrastructure failures", {exact:true}).first()).toBeVisible();
    await expect(page.locator('[data-extension-workspace="retrospectives"]').locator('button[type="submit"], input[type="radio"], select[name^="result:"], input[name="acknowledge_unanswered"]')).toHaveCount(0);
  }
});

test("keeps the Knowledge Loop usable at 390px in ja, en, and zh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [lang, heading] of [
    ["ja", "プロジェクトの指標と改善"],
    ["en", "Project metrics and improvements"],
    ["zh", "项目指标与改进"]
  ] as const) {
    await page.goto(`/dashboard/knowledge?tenant_id=default&project_id=org-brain&lang=${lang}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  }
});


test("hides disabled features and explains direct access", async ({ page }) => {
  await page.goto("/profile?tenant_id=features-off&lang=en");
  await expect(page.locator('a[href*="/dashboard/knowledge"]')).toHaveCount(0);
  await expect(page.getByRole("navigation", {name:"Management sections"}).locator('a[href*="section=metrics"],a[href*="section=retrospectives"],a[href*="section=improvements"]')).toHaveCount(0);
  const response = await page.goto("/dashboard/knowledge?tenant_id=features-off&lang=en");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/\?.*view=goals/);
  const goals=page.getByRole("region", {name:"Project metrics and improvements"});
  await expect(goals.getByText("Business metrics are unavailable in this scope.")).toBeVisible();
  await expect(goals.locator("[data-op-api-form]")).toHaveCount(0);
  await page.goto("/retrospectives?tenant_id=features-off&lang=en");
  await expect(page.getByText("This management section is unavailable", {exact:true})).toBeVisible();
  await expect(page.locator("[data-extension-workspace]")).toHaveCount(0);
});

test("does not turn a failed dashboard into zero counts", async ({ page }) => {
  await page.goto("/dashboard/knowledge?tenant_id=dashboard-unavailable&lang=en");
  const goals=page.getByRole("region", {name:"Project metrics and improvements"});
  await expect(goals.getByRole("alert")).toHaveText("Unavailable (HTTP 503). Try again.");
  await expect(goals.locator('[id^="goal-"]')).toHaveCount(0);
});
