import { expect, test } from "@playwright/test";

test("previews and batch-installs the four first-party Domain Packs without fixtures", async ({ page }) => {
  await page.goto("/domain-packs?tenant_id=default");
  await expect(page.getByRole("heading", { name: "業務ドメインをひとまとまりで導入" })).toBeVisible();
  for (const name of ["Build Engineering", "SRE", "Sales", "PdM — B2C Marketplace"]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Enterprise Pack Builder" })).toHaveCount(0);
  await page.getByRole("button", { name: "Install diffをpreview" }).click();
  await expect(page.locator("p.surface-label", { hasText: "INSTALL DIFF" })).toBeVisible();
  await expect(page.getByText("examples/story-v1.json", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "選択したPackを適用" }).click();
  await expect(page.getByText("4 Packを適用しました。fixtureは投入されていません。")).toBeVisible();
});

test("creates a Manifest-external metric and adds it to a Dashboard", async ({ page }) => {
  await page.goto("/domain-metrics?tenant_id=default");
  await page.locator('input[name="key"]').fill("quality_adjusted_activation_rate");
  await page.getByLabel("表示名").fill("Quality adjusted activation");
  await page.locator('select[name="source_type"]').selectOption("derived");
  await page.locator('input[name="formula_metric_keys"]').fill("qualified_activated_users,new_users");
  await page.getByRole("button", { name: "カスタム指標を作成" }).click();
  await expect(page.getByText("カスタム指標を作成しました。")).toBeVisible();
  await expect(page.getByText("quality_adjusted_activation_rate", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dashboardへ追加" }).click();
  await expect(page.getByText("Manifest外の指標をDashboardへ追加しました。")).toBeVisible();
});
