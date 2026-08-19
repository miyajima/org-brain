import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.RECORDING_BASE_URL ?? "http://127.0.0.1:4321";
const outputDir = process.env.RECORDING_OUTPUT_DIR;

if (!outputDir) {
  throw new Error("RECORDING_OUTPUT_DIR is required");
}

await fs.mkdir(outputDir, { recursive: true });

const diagnostics = [];
const browser = await chromium.launch({ headless: true, args: ["--hide-scrollbars"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on("console", (message) => {
  diagnostics.push({ type: "console", level: message.type(), message: message.text(), url: page.url() });
});
page.on("pageerror", (error) => {
  diagnostics.push({ type: "pageerror", message: error.message, url: page.url() });
});
page.on("requestfailed", (request) => {
  diagnostics.push({
    type: "requestfailed",
    message: request.failure()?.errorText ?? "Request failed",
    url: request.url()
  });
});

const scoped = (pathname) => {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("tenant_id", "default");
  url.searchParams.set("project_id", "org-brain");
  url.searchParams.set("lang", "ja");
  return url.toString();
};

const routes = [
  { slug: "home", path: "/", heading: "Decision Briefing" },
  { slug: "decision", path: "/decisions/decision-console-e2e", heading: "Keep decision context visible" },
  { slug: "map", path: "/map?decision_id=decision-console-e2e", heading: "Decision Trace Map" },
  { slug: "all-map", path: "/memories/constellation", heading: "3Dメモリマップ" },
  { slug: "skills", path: "/skills?decision_id=decision-console-e2e&source_version_hash=e2e-source-hash", heading: "Skills" },
  { slug: "agents", path: "/agents?agent_id=agent-e2e", heading: "Agents" },
  { slug: "reviews", path: "/reviews", heading: "Reviews" }
];

const routeSummary = [];

try {
  for (const route of routes) {
    await page.goto(scoped(route.path), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.getByRole("heading", { level: 1, name: route.heading }).waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outputDir, `preflight-${route.slug}.png`), fullPage: false });

    routeSummary.push({
      slug: route.slug,
      url: page.url(),
      title: await page.title(),
      headings: await page.getByRole("heading").allTextContents(),
      navigation: await page.getByRole("navigation", { name: "Org Brain" }).getByRole("link").allTextContents()
    });
  }

  await page.goto(scoped("/"), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("link", { name: "Keep decision context visible" }).waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Keep decision context visible" }).click();
  await page.locator(".decision-trace-rail").waitFor({ state: "visible" });

  const selectorChecks = {
    decisionCards: await page.locator(".decision-trace-rail [data-trace-node]").count(),
    skillAction: await page.getByRole("link", { name: "この知識をSkill化" }).count(),
    mapAction: await page.getByRole("link", { name: /Map/ }).count(),
    previewButtons: await page.locator("[data-preview-target]").count()
  };

  await fs.writeFile(
    path.join(outputDir, "preflight-dom.json"),
    JSON.stringify({ routes: routeSummary, selectorChecks }, null, 2),
    "utf8"
  );
} finally {
  await fs.writeFile(path.join(outputDir, "preflight-browser-diagnostics.json"), JSON.stringify(diagnostics, null, 2), "utf8");
  await context.close();
  await browser.close();
}

console.log(JSON.stringify({ outputDir, routes: routeSummary.length, diagnostics: diagnostics.length }, null, 2));
