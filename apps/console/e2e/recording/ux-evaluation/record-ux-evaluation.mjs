import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const baseUrl = process.env.RECORDING_BASE_URL ?? "http://127.0.0.1:4321";
const outputDir = process.env.RECORDING_OUTPUT_DIR ?? path.resolve("artifacts/recordings/ux-evaluation-20260818-ja");
const scope = "tenant_id=default&project_id=org-brain&lang=ja";
const viewport = { width: 1440, height: 900 };
const settleMs = 850;

const steps = [
  { action: "navigate", target: `/?${scope}`, subtitle: "ホームのDecision Briefingで、重要な決定と次の操作を一覧します。", pace: 1900 },
  { action: "fill", target: "[data-briefing-search]", value: "context", subtitle: "決定文と理由の要約を検索し、対象を絞り込みます。", pace: 1500 },
  { action: "click", target: "[data-briefing-card] .decision-action", subtitle: "対象の決定を開き、判断の背景を確認します。", pace: 1800 },
  { action: "click", target: ".decision-trace-node:has-text(\"Verified usability note\")", subtitle: "根拠を選ぶと、右側の同じ画面で要約と参照先を確認できます。", pace: 1700 },
  { action: "click", target: "[data-access-open]", subtitle: "Access Drawerで、所有者・共有範囲・保存場所を確認します。", pace: 1500 },
  { action: "assert", target: "[data-access-dialog][open]", subtitle: "資産種別が変わっても、アクセス情報の表示方法は統一されています。", pace: 1600 },
  { action: "click", target: "[data-access-close]", subtitle: "内容を変更せず、決定の道筋マップへ進みます。", pace: 1100 },
  { action: "click", target: ".decision-header-actions a:has-text(\"Decision Trace Mapを開く\")", subtitle: "決定から理由・根拠・成果物までを、一つのマップで追跡します。", pace: 1900 },
  { action: "click", target: "[data-map-fit]", subtitle: "全体を表示すると、ノードとエッジを初期の視野に収められます。", pace: 1600 },
  { action: "click", target: ".decision-inferred-toggle", subtitle: "推論関係は明示的に切り替えたときだけ表示します。", pace: 1500 },
  { action: "click", target: ".decision-map-list button:has-text(\"根拠\")", subtitle: "2D関係リストでも同じ情報を選択できます。この位置は初期画面の下端より下です。", pace: 1700 },
  { action: "click", target: "[data-all-knowledge-map]", subtitle: "全知識を表示すると、決定に未選択のノードも含めて探索できます。", pace: 1900 },
  { action: "click", target: "[data-map-fit]", subtitle: "全ノード表示でも、全体を表示で62ノードの構造を見渡せます。", pace: 1600 },
  { action: "click", target: "[data-trace-step=reason]", subtitle: "判断の道筋は、決定・理由・根拠・成果物の4段階で確認します。", pace: 1700 },
  { action: "navigate", target: `/decisions/decision-console-e2e?${scope}`, subtitle: "決定詳細へ戻り、参照版をSkill化します。", pace: 1700 },
  { action: "click", target: ".decision-header-actions a:has-text(\"この知識をSkill化\")", subtitle: "決定詳細からSkill生成を開始すると、参照版ハッシュも引き継がれます。", pace: 1800 },
  { action: "fill", target: "[data-skill-generate-form] textarea[name=instructions]", value: "利用条件と完了条件を含める", subtitle: "追加指示を入力し、生成条件を明確にします。", pace: 1500 },
  { action: "click", target: "[data-skill-generate-form] button[type=submit]", subtitle: "private draft生成を実行します。このボタンは初期viewportの下側にあります。", pace: 2000 },
  { action: "assert", target: "[data-generation-result]:not([hidden])", subtitle: "生成タスクとdraft IDを確認し、公開前に検証します。", pace: 1800 },
  { action: "click", target: "nav[aria-label=\"Org Brain\"] a[href^=\"/agents\"]:visible", subtitle: "Agentsでは、SkillのLoadoutとAgentへ渡るコンテキストを確認します。", pace: 1700 },
  { action: "click", target: ".decision-asset-card:has-text(\"Release reviewer\")", subtitle: "Agentを選ぶと、役割・参照元の決定・現在のLoadoutが表示されます。", pace: 1700 },
  { action: "fill", target: "[data-context-preview-form] textarea[name=task_text]", value: "リリース判断をレビューする", subtitle: "タスク文を入力し、ACLを反映したeffective contextを事前確認します。", pace: 1600 },
  { action: "click", target: "[data-context-preview-form] button[type=submit]", subtitle: "コンテキストを解決します。このフォームはページ下部にあり、スクロールが発生します。", pace: 2000 },
  { action: "assert", target: "[data-context-result]:not([hidden])", subtitle: "注入・on_demand・権限で除外されたSkillを分けて確認できます。", pace: 1800 },
  { action: "click", target: "nav[aria-label=\"Org Brain\"] a[href^=\"/reviews\"]:visible", subtitle: "Reviewsで、期限・確認・成果物・共有待ちの不足を横断確認します。", pace: 1700 },
  { action: "assert", target: ".decision-review-grid", subtitle: "決定を理解し、根拠を確認し、安全に配布する一連の流れが完了です。", pace: 2300 }
];

const diagnostics = [];
let page;
let cursor = { x: 90, y: 76 };

async function installOverlay() {
  await page.evaluate(() => {
    if (document.getElementById("ux-recording-style")) return;
    const style = document.createElement("style");
    style.id = "ux-recording-style";
    style.textContent = `
      #ux-recording-caption { position: fixed; z-index: 2147483646; left: 5%; right: 5%; bottom: 18px; padding: 12px 18px; border: 1px solid rgba(143,213,255,.62); border-radius: 14px; background: rgba(3,12,24,.94); color: #f3f8ff; font: 600 18px/1.45 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif; text-align: center; box-shadow: 0 10px 32px rgba(0,0,0,.4); pointer-events: none; }
      #ux-recording-highlight { position: fixed; z-index: 2147483645; border: 3px solid #8fd5ff; border-radius: 10px; box-shadow: 0 0 0 5px rgba(99,189,255,.2), 0 0 26px rgba(99,189,255,.68); pointer-events: none; transition: top .2s ease,left .2s ease,width .2s ease,height .2s ease; }
      #ux-recording-pulse { position: fixed; z-index: 2147483644; width: 26px; height: 26px; margin: -13px 0 0 -13px; border: 3px solid #fff; border-radius: 50%; box-shadow: 0 0 0 8px rgba(99,189,255,.34), 0 0 30px rgba(99,189,255,.9); pointer-events: none; animation: ux-recording-pulse .7s ease-out forwards; }
      @keyframes ux-recording-pulse { from { transform: scale(.8); opacity: 1; } to { transform: scale(1.9); opacity: 0; } }
      @media (max-width: 700px) { #ux-recording-caption { font-size: 15px; bottom: calc(12px + env(safe-area-inset-bottom)); } }
    `;
    document.head.appendChild(style);
    const caption = document.createElement("div");
    caption.id = "ux-recording-caption";
    caption.setAttribute("aria-hidden", "true");
    document.body.appendChild(caption);
  });
}

async function setCaption(text, index) {
  await installOverlay();
  await page.evaluate(({ text, index, total }) => {
    const caption = document.getElementById("ux-recording-caption");
    if (caption) caption.textContent = `${index + 1}/${total}  ${text}`;
  }, { text, index, total: steps.length });
}

async function clearHighlight() {
  await page.evaluate(() => {
    document.getElementById("ux-recording-highlight")?.remove();
  });
}

async function showHighlight(locator) {
  await installOverlay();
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate((box) => {
    let highlight = document.getElementById("ux-recording-highlight");
    if (!highlight) {
      highlight = document.createElement("div");
      highlight.id = "ux-recording-highlight";
      document.body.appendChild(highlight);
    }
    Object.assign(highlight.style, { top: `${Math.max(0, box.y - 5)}px`, left: `${Math.max(0, box.x - 5)}px`, width: `${box.width + 10}px`, height: `${box.height + 10}px` });
  }, box);
}

async function showPulse(point) {
  await page.evaluate((point) => {
    document.getElementById("ux-recording-pulse")?.remove();
    const pulse = document.createElement("div");
    pulse.id = "ux-recording-pulse";
    Object.assign(pulse.style, { left: `${point.x}px`, top: `${point.y}px` });
    document.body.appendChild(pulse);
  }, point);
}

async function pageState() {
  return page.evaluate(() => ({ scrollY: Math.round(scrollY), scrollHeight: Math.round(document.documentElement.scrollHeight), viewportWidth: innerWidth, viewportHeight: innerHeight }));
}

async function targetState(locator) {
  const box = await locator.boundingBox();
  const state = await pageState();
  if (!box) return { box: null, ...state, inViewport: false };
  return { box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), bottom: Math.round(box.y + box.height) }, ...state, inViewport: box.y >= 0 && box.y + box.height <= state.viewportHeight };
}

async function focusTarget(locator) {
  const before = await targetState(locator);
  if (!before.inViewport) {
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
  }
  const afterScroll = await targetState(locator);
  if (!afterScroll.box) throw new Error("Target has no bounding box");
  const center = { x: afterScroll.box.x + afterScroll.box.width / 2, y: afterScroll.box.y + afterScroll.box.height / 2 };
  const distance = Math.round(Math.hypot(center.x - cursor.x, center.y - cursor.y));
  await showHighlight(locator);
  await page.mouse.move(center.x, center.y, { steps: 18 });
  const previousCursor = cursor;
  cursor = center;
  return { before, afterScroll, center, previousCursor, distance, scrollDelta: afterScroll.scrollY - before.scrollY, requiredScroll: !before.inViewport || afterScroll.scrollY !== before.scrollY };
}

function cssText(selector) {
  return selector.includes(":has-text(") ? selector : selector;
}

async function runStep(step, index) {
  if (step.action === "navigate") {
    await page.goto(new URL(step.target, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(settleMs);
    await setCaption(step.subtitle, index);
    await page.waitForTimeout(step.pace);
    return { step_index: index, action: step.action, target: step.target, subtitle: step.subtitle, url: page.url(), viewport: await pageState(), requiredScroll: false, scrollDelta: 0, mouseDistancePx: 0 };
  }

  const locator = page.locator(cssText(step.target)).first();
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  await setCaption(step.subtitle, index);
  const focused = await focusTarget(locator);
  const beforeUrl = page.url();
  if (step.action === "click") {
    await showPulse(focused.center);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(settleMs);
  } else if (step.action === "fill") {
    await locator.click();
    await locator.fill("");
    await locator.pressSequentially(step.value ?? "", { delay: 58 });
    await page.waitForTimeout(settleMs);
  } else if (step.action === "assert") {
    await page.waitForTimeout(settleMs);
  }
  await page.waitForTimeout(step.pace);
  const navigated = beforeUrl !== page.url();
  const result = navigated ? await pageState() : await targetState(locator);
  await clearHighlight();
  return { step_index: index, action: step.action, target: step.target, subtitle: step.subtitle, url_before: beforeUrl, url_after: page.url(), before: focused.before, after: result, navigated, requiredScroll: focused.requiredScroll, scrollDelta: focused.scrollDelta, mouseDistancePx: focused.distance, targetCenter: focused.center };
}

async function runMobileAudit(browser) {
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobile.newPage();
  const routes = [
    ["home", `/?${scope}`, ["[data-briefing-search]", "[data-briefing-card]", "[data-briefing-card] .decision-action"]],
    ["map", `/map?decision_id=decision-console-e2e&${scope}`, ["[data-all-knowledge-map]", ".decision-map-picker summary", "[data-map-fit]"]],
    ["all-map", `/memories/constellation?view=all&${scope}`, ["[data-map-fit]", "[data-trace-step=reason]", "[data-memory-map-root]"]],
    ["skills", `/skills?decision_id=decision-console-e2e&source_hash=e2e-source-hash&${scope}`, ["[data-generation-wizard] textarea", "[data-generation-wizard] button[type=submit]"]],
    ["agents", `/agents?agent_id=agent-e2e&${scope}`, ["[data-context-preview-form] textarea", "[data-context-preview-form] button[type=submit]"]]
  ];
  const result = [];
  for (const [slug, route, selectors] of routes) {
    await mobilePage.goto(new URL(route, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await mobilePage.waitForTimeout(700);
    const data = await mobilePage.evaluate((selectors) => {
      const measure = (selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return { present: false };
        const box = element.getBoundingClientRect();
        return { present: true, x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), bottom: Math.round(box.bottom), inViewport: box.top >= 0 && box.bottom <= innerHeight };
      };
      return { viewport: { width: innerWidth, height: innerHeight }, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, targets: Object.fromEntries(selectors.map((selector) => [selector, measure(selector)])) };
    }, selectors);
    result.push({ slug, url: mobilePage.url(), ...data });
  }
  await mobile.close();
  return result;
}

async function makeMedia(recordingPath) {
  const mp4Path = path.join(outputDir, "ux-evaluation-ja.mp4");
  await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", recordingPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Path]);
  for (const [name, seconds] of [["thumb-home.png", 4], ["thumb-map.png", 34], ["thumb-agents.png", 70]]) {
    await execFileAsync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(seconds), "-i", mp4Path, "-frames:v", "1", "-vf", "scale=640:-1", path.join(outputDir, name)]);
  }
  const playerPath = path.join(outputDir, "player.html");
  await fs.writeFile(playerPath, `<!doctype html><meta charset="utf-8"><title>Org Brain UX evaluation walkthrough</title><style>body{margin:0;background:#07111f;color:#f3f8ff;font:16px system-ui;padding:24px}video{display:block;max-width:100%;margin-top:16px;border:1px solid #31506d;border-radius:14px}</style><h1>Org Brain UX evaluation walkthrough</h1><p>日本語字幕を動画内に表示しています。操作距離とスクロールの計測結果は metrics.json を参照してください。</p><video controls preload="metadata"><source src="ux-evaluation-ja.mp4" type="video/mp4"><source src="recording.webm" type="video/webm"></video>`, "utf8");
  return { mp4Path, playerPath };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--hide-scrollbars"] });
  const context = await browser.newContext({ viewport, recordVideo: { dir: outputDir, size: viewport } });
  page = await context.newPage();
  page.on("console", (message) => diagnostics.push({ type: "console", level: message.type(), message: message.text(), url: page.url() }));
  page.on("pageerror", (error) => diagnostics.push({ type: "pageerror", message: error.message, url: page.url() }));
  page.on("requestfailed", (request) => diagnostics.push({ type: "requestfailed", message: request.failure()?.errorText ?? "Request failed", url: request.url() }));

  const metrics = [];
  for (let index = 0; index < steps.length; index += 1) metrics.push(await runStep(steps[index], index));
  await page.screenshot({ path: path.join(outputDir, "final-screen.png"), fullPage: false });
  const mobileAudit = await runMobileAudit(browser);
  await fs.writeFile(path.join(outputDir, "metrics.json"), JSON.stringify({ viewport, steps: metrics, mobileAudit }, null, 2), "utf8");
  await fs.writeFile(path.join(outputDir, "browser-diagnostics.json"), JSON.stringify(diagnostics, null, 2), "utf8");

  await context.close();
  const videoPath = await page.video().path();
  await browser.close();
  const recordingPath = path.join(outputDir, "recording.webm");
  if (videoPath !== recordingPath) await fs.copyFile(videoPath, recordingPath);
  const media = await makeMedia(recordingPath);
  await fs.writeFile(path.join(outputDir, "recording-manifest.json"), JSON.stringify({ title: "Decision-first Console UX evaluation", subtitle_mode: "burned-in-overlay", external_vtt: false, viewport, step_count: steps.length, recordingPath, ...media, metricsPath: path.join(outputDir, "metrics.json"), diagnosticsPath: path.join(outputDir, "browser-diagnostics.json") }, null, 2), "utf8");
  console.log(JSON.stringify({ outputDir, stepCount: steps.length, recordingPath, ...media, diagnostics: diagnostics.length }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
