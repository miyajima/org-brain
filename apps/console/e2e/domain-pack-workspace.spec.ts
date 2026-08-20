import AxeBuilder from "@axe-core/playwright";
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
  await page.getByTestId("decision-trace").locator(":scope > summary").click();
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

test("shows Recall history and a prompt-free business trace", async ({ page }) => {
  await page.goto(url(packs.build));
  const history = page.getByTestId("domain-recall-history");
  await expect(history.getByText("日常のFeedbackはAIで行い、ここでは監査時だけ確認します")).toBeVisible();
  await history.locator(":scope > summary").click();
  await expect(history.getByRole("heading", { name: "AIによる想起履歴" })).toBeVisible();
  await expect(history).toContainText("検証中・回答には未反映");
  await expect(history).toContainText("対象が一致");
  await history.getByRole("link", { name: "監査情報を見る" }).click();
  await expect(page.getByRole("heading", { name: "checkout-webのCI変更に関連する確認済みDecision" })).toBeVisible();
  await expect(page.getByText("runnerを2台増やしintegration testを4 shardへ分割する")).toBeVisible();
  await expect(page.getByText("入力本文は保存していません")).toBeVisible();
  await expect(page.getByRole("link", { name: "Decisionの正本へ戻る" })).toHaveAttribute("href", /domain-workspaces\/function\.build-engineering.*lang=ja/);
  await expect(page.getByText("score 0.91")).not.toBeVisible();
  await expect(page.getByText("object exact / intent matched")).toHaveCount(0);
});

test("keeps the decision-first management UX score at 96 or higher", async ({ page, context }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let score = 0;
  const packChecks = [];
  for (const packId of Object.values(packs)) {
    await page.goto(url(packId));
    const shell = page.getByTestId("domain-pack-workspace");
    const result = await shell.evaluate((root) => {
      const decisionNode = root.querySelector("#workspace-decision-title");
      const evidenceNode = root.querySelector("#workspace-evidence-title");
      const metricsNode = root.querySelector("#workspace-kpi-title");
      const activityNode = root.querySelector('[data-testid="domain-recall-history"]');
      const position = Node.DOCUMENT_POSITION_FOLLOWING;
      const smallControls = [...root.querySelectorAll<HTMLElement>("a,button,input,select,summary")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.height < 44;
        }).map((element) => ({ text: element.textContent?.trim(), height: element.getBoundingClientRect().height }));
      const clippedControls = [...root.querySelectorAll<HTMLElement>("a,button,input,select,summary")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && (rect.left < 0 || rect.right > window.innerWidth);
        }).map((element) => element.textContent?.trim());
      return {
        redundantHeroAbsent: !root.textContent?.includes("の判断を確認する") && !root.textContent?.includes("Decision workspace"),
        helpAvailable: Boolean(root.querySelector('.workspace-help > summary[aria-label="この画面の使い方"]')),
        helpClosed: !root.querySelector(".workspace-help")?.hasAttribute("open"),
        decisionVisible: Boolean(decisionNode),
        decisionViewportsFromTop: decisionNode ? (decisionNode.getBoundingClientRect().top + window.scrollY) / window.innerHeight : Number.POSITIVE_INFINITY,
        evidenceAfterDecision: Boolean(decisionNode && evidenceNode && decisionNode.compareDocumentPosition(evidenceNode) & position),
        metricsAfterEvidence: Boolean(evidenceNode && metricsNode && evidenceNode.compareDocumentPosition(metricsNode) & position),
        activityAfterEvidence: Boolean(evidenceNode && activityNode && evidenceNode.compareDocumentPosition(activityNode) & position),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        smallControls,
        clippedControls
      };
    });
    packChecks.push({
      ...result,
      decisionIsPageTitle: await page.locator("h1#workspace-decision-title").isVisible(),
      shareControlHeight: (await page.locator(".share-menu > summary").boundingBox())?.height ?? 0
    });
  }

  if (packChecks.every((item) => item.redundantHeroAbsent && item.decisionIsPageTitle)) score += 10;
  if (packChecks.every((item) => item.decisionVisible && item.decisionViewportsFromTop <= 1)) score += 15;
  if (packChecks.every((item) => item.evidenceAfterDecision && item.metricsAfterEvidence && item.activityAfterEvidence)) score += 15;
  if (packChecks.every((item) => item.helpAvailable && item.helpClosed)) score += 10;
  if (packChecks.every((item) => item.shareControlHeight >= 44)) score += 5;
  if (packChecks.every((item) => !item.overflow && item.smallControls.length === 0 && item.clippedControls.length === 0)) score += 15;

  await page.goto(url(packs.build));
  const decision = page.getByRole("heading", { name: "runner poolを2台増やし、integration testを4 shardへ分割する" });
  const evidence = page.getByRole("heading", { name: "判断を支えた根拠" });
  const activity = page.getByTestId("domain-recall-history");
  if (!(await activity.getAttribute("open")) && await activity.getByText("日常のFeedbackはAIで行い、ここでは監査時だけ確認します").isVisible()) score += 10;

  await page.locator(".workspace-help > summary").click();
  await expect(page.getByText("普段の相談はAIへ。ここでは、チームで確認済みのDecisionと根拠を読みます。")).toBeVisible();
  score += 5;

  await page.locator(".share-menu > summary").click();
  const meetingLink = page.getByRole("link", { name: "共有表示を開く" });
  await expect(meetingLink).toHaveAttribute("href", /view=meeting/);
  await meetingLink.click();
  await expect(page).toHaveURL(/view=meeting/);
  await expect(decision).toBeVisible();
  await expect(evidence).toBeVisible();
  await expect(page.getByTestId("workspace-metrics-detail")).not.toBeVisible();
  await expect(activity).not.toBeVisible();
  score += 10;

  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4321" });
  await page.locator(".share-menu > summary").click();
  await page.getByRole("button", { name: "共有リンクをコピー" }).click();
  await expect(page.getByRole("status")).toHaveText("共有リンクをコピーしました");
  score += 5;

  expect(score, JSON.stringify(packChecks, null, 2)).toBeGreaterThanOrEqual(96);
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

test("keeps the lean Decision surface free of WCAG A and AA violations", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    for (const packId of Object.values(packs)) {
      await page.goto(url(packId));
      const results = await new AxeBuilder({ page })
        .include('[data-testid="domain-pack-workspace"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations, `${packId} at ${viewport.width}px`).toEqual([]);
    }
  }
});
