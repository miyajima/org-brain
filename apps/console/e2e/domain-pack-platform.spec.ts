import { expect, test } from "@playwright/test";

test("previews and batch-installs the four first-party Domain Packs without fixtures", async ({ page }) => {
  await page.goto("/domain-packs?tenant_id=default&lang=ja");
  await expect(page).toHaveURL(/\/settings\?.*section=packs/);
  await expect(page.getByRole("heading", { name: "業務ドメインをひとまとまりで導入" })).toBeVisible();
  for (const name of ["Build Engineering", "SRE", "Sales", "PdM — B2C Marketplace"]) {
    await expect(page.getByText(name, {exact:true})).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Enterprise Pack Builder" })).toHaveCount(0);
  await page.getByRole("button", { name: "導入差分を確認" }).click();
  await expect(page.locator("[data-pack-plan]")).toBeVisible();
  await expect(page.getByText("業務データは導入されません。", {exact:true})).toBeVisible();
  const installation = page.waitForRequest(request => request.method() === "POST" && new URLSearchParams(request.postData() ?? "").get("action") === "install");
  await page.getByRole("button", { name: "選択したパックを適用" }).click();
  const body = new URLSearchParams((await installation).postData() ?? "");
  expect(body.getAll("pack_ids")).toHaveLength(4);
  expect(body.get("plan_digest")).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.getByRole("status")).toContainText("保存しました");
  await expect(page.getByText("業務データは導入されません。", {exact:true})).toBeVisible();
});

test("creates a Manifest-external metric and adds it to a Dashboard", async ({ page }) => {
  await page.goto("/domain-metrics?tenant_id=default");
  await expect(page).toHaveURL(/\/settings\?.*section=metrics/);
  await page.locator('input[name="key"]').fill("quality_adjusted_activation_rate");
  await page.getByLabel("表示名").fill("Quality adjusted activation");
  await page.locator('select[name="source_type"]').selectOption("derived");
  await page.locator('input[name="formula_metric_keys"]').fill("qualified_activated_users,new_users");
  await page.getByRole("button", { name: "カスタム指標を作成" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await expect(page.getByText("quality_adjusted_activation_rate", { exact: true })).toBeVisible();
  await page.getByLabel("追加する指標").selectOption("quality_adjusted_activation_rate");
  await page.getByLabel("Dashboard名", {exact:true}).fill("Quality dashboard");
  const addition = page.waitForRequest(request => request.method() === "POST" && new URLSearchParams(request.postData() ?? "").get("action") === "dashboard");
  await page.getByRole("button", { name: "Dashboardへ追加" }).click();
  expect(new URLSearchParams((await addition).postData() ?? "").get("metric_key")).toBe("quality_adjusted_activation_rate");
  await expect(page.getByRole("status")).toContainText("保存しました");
  await expect(page.getByText(/現在のDashboard:.*Quality dashboard/)).toBeVisible();
});
