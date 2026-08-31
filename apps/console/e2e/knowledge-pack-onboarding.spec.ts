import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("guides an administrator from purpose to an installed Knowledge Pack and resumes progress", async ({ page }, testInfo) => {
  const tenantId = `knowledge-pack-e2e-${testInfo.retry}`;
  await page.goto(`/knowledge-packs/onboarding?tenant_id=${tenantId}&lang=ja`);
  await expect(page.getByRole("heading", { name: "業務目標からKnowledge Packの導入まで進める" })).toBeVisible();
  await page.getByRole("button", { name: "セットアップを開始" }).click();

  await expect(page.locator("[data-knowledge-pack-step=purpose]")).toBeVisible();
  await expect(page.locator(".kp-stage-heading")).toBeFocused();
  await page.getByRole("button", { name: "保存して次へ" }).click();
  const validationSummary = page.locator("[data-form-errors]");
  await expect(validationSummary).toBeFocused();
  await expect(validationSummary.getByRole("link")).toHaveCount(2);
  await expect(page.getByLabel("Knowledge Pack名")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("改善したい業務と目的")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Knowledge Pack名").fill("Build reliability");
  await page.getByLabel("改善したい業務と目的").fill("main branchのBuild成功率を改善する");
  await expect(validationSummary).toBeHidden();
  await page.getByRole("button", { name: "保存して次へ" }).click();

  await expect(page.locator("[data-knowledge-pack-step=template]")).toBeVisible();
  await expect(page.locator(".kp-stage-heading")).toBeFocused();
  await page.getByText("Build Engineering", { exact: true }).click();
  await expect(page.locator("[data-knowledge-pack-step=scope]")).toBeVisible();
  await expect(page.locator(".kp-stage-heading")).toBeFocused();
  await page.getByLabel("目標の適用範囲").selectOption("project");
  await expect(page.locator("[data-form-errors]")).toBeHidden();
  await page.getByLabel("Project ID").fill("org-brain");
  await page.getByRole("button", { name: "保存して次へ" }).click();

  await expect(page.locator("[data-knowledge-pack-step=goals]")).toBeVisible();
  const resumedUrl = page.url();
  await page.goto(`/overview?tenant_id=${tenantId}&lang=ja`);
  await page.goto(resumedUrl);
  await expect(page.locator("[data-knowledge-pack-step=goals]")).toBeVisible();

  const firstGoal = page.locator("[data-goal-row]").first();
  await firstGoal.getByLabel("指標").selectOption("build_success_rate");
  await firstGoal.getByLabel("目標値").fill("98");
  await firstGoal.getByLabel("この目標にする理由").fill("失敗したBuildの手戻りを減らす");
  await page.getByRole("button", { name: "保存して次へ" }).click();

  await expect(page.locator("[data-knowledge-pack-step=data_sources]")).toBeVisible();
  const source = page.locator("[data-source-row]").first();
  await source.getByLabel("現状値の取得方法").selectOption("manual");
  await source.getByRole("spinbutton", { name: /^現状値/ }).fill("91");
  await source.getByLabel("根拠の参照").fill("resource:build-baseline");
  await page.getByRole("button", { name: "保存して次へ" }).click();

  await expect(page.locator("[data-knowledge-pack-step=review]")).toBeVisible();
  await expect(page.getByText("PLAN DIGEST", { exact: true })).toBeVisible();
  await expect(page.getByText("評価用のサンプルデータは投入しません。", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Knowledge Packを作成・導入" }).click();

  await expect(page.locator("[data-knowledge-pack-step=completed]")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Knowledge Packの準備ができました" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Pack Workspaceを開く" })).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
  if (process.env.KNOWLEDGE_PACK_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.KNOWLEDGE_PACK_SCREENSHOT_PATH, fullPage: true });
  }
});

test("keeps the guided setup accessible and compact across responsive layouts", async ({ page }, testInfo) => {
  const tenantId = `knowledge-pack-responsive-${testInfo.retry}`;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/knowledge-packs/onboarding?tenant_id=${tenantId}&lang=ja`);
  await page.getByRole("button", { name: "セットアップを開始" }).click();

  await expect(page.locator("[data-knowledge-pack-step=purpose]")).toBeVisible();
  await expect(page.locator(".kp-mobile-progress")).toBeVisible();
  await expect(page.locator(".kp-rail ol")).toBeHidden();
  await expect(page.locator("main")).toHaveCount(1);

  const assertNoHorizontalOverflow = async () => {
    expect(await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth
    }))).toEqual({ document: 0, body: 0 });
  };
  await assertNoHorizontalOverflow();

  const undersizedControls = await page.locator("[data-knowledge-pack-step]").evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("a, button, input, textarea, select")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.height < 44;
      })
      .map((element) => ({ name: element.getAttribute("name"), height: element.getBoundingClientRect().height }))
  );
  expect(undersizedControls).toEqual([]);

  const results = await new AxeBuilder({ page })
    .include(".kp-page")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  if (process.env.KNOWLEDGE_PACK_MOBILE_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.KNOWLEDGE_PACK_MOBILE_SCREENSHOT_PATH, fullPage: true });
  }

  await page.getByLabel("Knowledge Pack名").fill("Responsive Pack");
  await page.getByLabel("改善したい業務と目的").fill("小さい画面でも安全に導入を完了する");
  await page.getByRole("button", { name: "保存して次へ" }).click();
  await expect(page.locator("[data-knowledge-pack-step=template]")).toBeVisible();
  const mobileBack = page.locator(".kp-mobile-progress").getByRole("link", { name: "戻る" });
  await expect(mobileBack).toBeVisible();
  await mobileBack.click();
  await expect(page.locator("[data-knowledge-pack-step=purpose]")).toBeVisible();
  await expect(page.locator(".kp-stage-heading")).toBeFocused();
  await assertNoHorizontalOverflow();

  await page.setViewportSize({ width: 844, height: 390 });
  await assertNoHorizontalOverflow();
  await page.setViewportSize({ width: 320, height: 844 });
  await assertNoHorizontalOverflow();

  await page.setViewportSize({ width: 640, height: 720 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await assertNoHorizontalOverflow();
  await expect(page.getByRole("heading", { name: "改善したいことに名前を付ける" })).toBeVisible();
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ forcedColors: "active" });
  await page.locator(".kp-rail").getByRole("link", { name: "テンプレート" }).click();
  await expect(page.locator("[data-knowledge-pack-step=template] .kp-stage-heading")).toBeFocused();
  const forcedColorChoice = page.getByRole("radio").first();
  await forcedColorChoice.focus();
  await expect(forcedColorChoice).toBeFocused();
  expect(await forcedColorChoice.evaluate((element) => ({
    opacity: getComputedStyle(element).opacity,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height
  }))).toEqual({ opacity: "1", width: 16, height: 16 });
  const forcedColorResults = await new AxeBuilder({ page })
    .include(".kp-page")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(forcedColorResults.violations).toEqual([]);

  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" });
  const movingElements = await page.locator(".kp-page").evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("*")].filter((element) => {
      const style = getComputedStyle(element);
      return style.animationName !== "none" || (style.transitionDuration !== "0s" && style.transitionDuration !== "0ms");
    }).map((element) => ({
      tag: element.tagName,
      className: element.className,
      animationName: getComputedStyle(element).animationName,
      transitionDuration: getComputedStyle(element).transitionDuration
    }))
  );
  expect(movingElements).toEqual([]);
});

test("focuses an initial server error and offers a working recovery target", async ({ page }, testInfo) => {
  const tenantId = `knowledge-pack-start-error-${testInfo.retry}`;
  await page.goto(`/knowledge-packs/onboarding?tenant_id=${tenantId}&lang=ja`);
  await page.getByRole("button", { name: "セットアップを開始" }).click();

  const serverError = page.locator("[data-server-error]");
  await expect(serverError).toBeVisible();
  await expect(serverError).toBeFocused();
  const recovery = serverError.getByRole("link", { name: "このステップを確認して再試行" });
  await expect(recovery).toHaveAttribute("href", "#knowledge-pack-form");
  await recovery.click();
  await expect(page.locator("#knowledge-pack-form")).toBeVisible();
});

test("completes the installation with keyboard input only", async ({ page }, testInfo) => {
  const tenantId = `knowledge-pack-keyboard-${testInfo.retry}`;
  await page.goto(`/knowledge-packs/onboarding?tenant_id=${tenantId}&lang=ja`);

  await page.keyboard.press("Tab");
  await expect(page.locator(".console-skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#console-main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "セットアップを開始" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.locator("[data-knowledge-pack-step=purpose] .kp-stage-heading")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Knowledge Pack名")).toBeFocused();
  await page.keyboard.insertText("Keyboard Pack");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("改善したい業務と目的")).toBeFocused();
  await page.keyboard.insertText("キーボードだけで導入を完了する");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "保存して次へ" })).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.locator("[data-knowledge-pack-step=template] .kp-stage-heading")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio").first()).toBeFocused();
  await page.keyboard.press("Space");

  await expect(page.locator("[data-knowledge-pack-step=scope] .kp-stage-heading")).toBeFocused();
  await page.getByRole("button", { name: "保存して次へ" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.locator("[data-knowledge-pack-step=goals] .kp-stage-heading")).toBeFocused();
  const keyboardGoal = page.locator("[data-goal-row]").first();
  await keyboardGoal.getByLabel("指標").focus();
  await page.keyboard.press("b");
  await expect(keyboardGoal.getByLabel("指標")).not.toHaveValue("");
  await keyboardGoal.getByLabel("目標値").focus();
  await page.keyboard.insertText("98");
  await keyboardGoal.getByLabel("この目標にする理由").focus();
  await page.keyboard.insertText("判断基準を共有するため");
  await page.getByRole("button", { name: "保存して次へ" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.locator("[data-knowledge-pack-step=data_sources] .kp-stage-heading")).toBeFocused();
  await page.getByRole("button", { name: "保存して次へ" }).focus();
  await page.keyboard.press("Enter");

  await expect(page.locator("[data-knowledge-pack-step=review] .kp-stage-heading")).toBeFocused();
  const install = page.getByRole("button", { name: "Knowledge Packを作成・導入" });
  await install.focus();
  await expect(install).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-knowledge-pack-step=completed] .kp-completed")).toBeFocused();
});

test("stays within interaction and layout stability budgets", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const metrics = { cls: 0, longestTask: 0 };
    Object.defineProperty(window, "__knowledgePackPerformance", { value: metrics });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!shift.hadRecentInput) metrics.cls += shift.value ?? 0;
      }
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) metrics.longestTask = Math.max(metrics.longestTask, entry.duration);
    }).observe({ type: "longtask", buffered: true });
  });
  const tenantId = `knowledge-pack-performance-${testInfo.retry}`;
  await page.goto(`/knowledge-packs/onboarding?tenant_id=${tenantId}&lang=ja`);
  await page.getByRole("button", { name: "セットアップを開始" }).click();
  await page.getByLabel("Knowledge Pack名").fill("Performance Pack");
  await page.getByLabel("改善したい業務と目的").fill("入力応答と表示安定性を保つ");
  await page.waitForTimeout(250);

  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const observed = (window as unknown as { __knowledgePackPerformance: { cls: number; longestTask: number } }).__knowledgePackPerformance;
    return {
      cls: observed.cls,
      longestTask: observed.longestTask,
      domContentLoaded: navigation.domContentLoadedEventEnd - navigation.startTime,
      nodes: document.querySelectorAll("*").length
    };
  });
  console.info("knowledge-pack-ui-performance", JSON.stringify(metrics));
  expect(metrics.cls).toBeLessThan(0.1);
  expect(metrics.longestTask).toBeLessThan(500);
  expect(metrics.domContentLoaded).toBeLessThan(5_000);
  expect(metrics.nodes).toBeLessThan(1_000);
});
