import { expect, test } from "@playwright/test";

const base = "/domain-workspaces";
const tenant = "workspace-demo";
const packs = {
  build: "function.build-engineering",
  sre: "function.sre",
  sales: "function.sales",
  pdm: "function.pdm-b2c-marketplace"
};
const url = (packId: string, tenantId = tenant) => `${base}/${encodeURIComponent(packId)}?tenant_id=${tenantId}&lang=ja`;

test("lists the four installed Pack Workspaces", async ({ page }) => {
  await page.goto(`${base}?tenant_id=${tenant}&lang=ja`);
  await expect(page.getByRole("heading", { name: "チームの指標と判断を確認する" })).toBeVisible();
  for (const title of ["Build Engineering", "SRE", "Sales", "PdM — B2C Marketplace"]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: /Workspaceを開く/ })).toHaveCount(4);
});

test("shows comparable KPI and complete Decision traces for every Pack", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });

  await page.goto(url(packs.build));
  await expect(page.getByTestId("metric-change_failure_rate")).toContainText("9%");
  await expect(page.getByTestId("metric-deployment_frequency")).toContainText("3回/日");
  await expect(page.getByText("checkout-web CI 7日間レポート")).toBeVisible();
  await expect(page.getByTestId("decision-trace").getByRole("listitem")).toHaveCount(5);

  await page.goto(url(packs.sre));
  await expect(page.getByTestId("metric-http_5xx_rate")).toContainText("0.5%");
  await expect(page.getByTestId("metric-error_budget_burn_rate")).toContainText("Target 1倍");
  await expect(page.getByText("payments-api SLO・retry snapshot")).toBeVisible();

  await page.goto(url(packs.sales));
  await expect(page.getByTestId("metric-opportunity_count")).toContainText("23件");
  await expect(page.getByTestId("metric-opportunity_count")).toContainText("Baseline 16件");
  await expect(page.getByTestId("metric-opportunity_conversion_rate")).toContainText("31.9%");
  await expect(page.getByTestId("metric-appointment_count")).toContainText("72件");

  await page.goto(url(packs.pdm));
  await expect(page.getByTestId("pdm-success-conditions")).toContainText("実験条件 達成");
  await expect(page.getByTestId("pdm-success-conditions")).toContainText("長期Target 28% · 未達");
  await expect(page.getByTestId("metric-ltv_cac")).toContainText("2.79倍");
  await expect(page.getByTestId("quality-adjusted-warning")).toContainText("60%");
  await expect(page.getByTestId("quality-adjusted-warning")).toContainText("42%");
  await expect(page.getByText("Paid Social cohort report")).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("renders explicit connector readiness states without false zeroes", async ({ page }) => {
  for (const [tenantId, expected] of [
    ["workspace-unconfigured", "未接続"],
    ["workspace-configured", "接続準備済み"],
    ["workspace-error", "取得エラー"],
    ["workspace-stale", "期限切れ"]
  ] as const) {
    await page.goto(url(packs.build, tenantId));
    await expect(page.getByRole("heading", { name: "データ取得状態" })).toBeVisible();
    if (tenantId === "workspace-stale") {
      await expect(page.getByTestId("metric-build_success_rate")).toContainText(expected);
    } else {
      await expect(page.locator(".source-grid article").first()).toContainText(expected);
      await expect(page.getByTestId("metric-build_success_rate").locator(".metric-current strong")).toHaveText("—");
    }
  }
});

test("keeps the Pack switcher reachable and content overflow-free at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(url(packs.pdm));
  const select = page.locator("#pack-workspace-select");
  await expect(select).toBeVisible();
  await expect(select.locator("option")).toHaveCount(4);
  expect(await select.inputValue()).toContain(encodeURIComponent(packs.pdm));
  const diagnostics = await page.getByTestId("domain-pack-workspace").evaluate((root) => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    smallControls: [...root.querySelectorAll<HTMLElement>("a,button,input,select,summary")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.height < 44;
      })
      .map((element) => ({ text: element.textContent?.trim(), height: element.getBoundingClientRect().height }))
  }));
  expect(diagnostics.overflow).toBe(false);
  expect(diagnostics.smallControls).toEqual([]);
});

test("uses sequential heading levels and disables animation for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(url(packs.build));
  const audit = await page.getByTestId("domain-pack-workspace").evaluate((root) => {
    const headings = [...root.querySelectorAll<HTMLElement>("h1,h2,h3,h4")].map((heading) => Number(heading.tagName.slice(1)));
    const skips = headings.filter((level, index) => index > 0 && level > headings[index - 1] + 1);
    const moving = [...root.querySelectorAll<HTMLElement>("*")].filter((element) => {
      const style = getComputedStyle(element);
      return style.animationName !== "none" || (style.transitionDuration !== "0s" && style.transitionDuration !== "0ms");
    }).length;
    return { skips, moving };
  });
  expect(audit.skips).toEqual([]);
  expect(audit.moving).toBe(0);
});
