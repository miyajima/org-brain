import { promises as fs } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

export type HighlightShape = 'box' | 'circle';

export interface ChangeTarget {
  selector: string;
  frame?: string;
  shape?: HighlightShape;
  hold_ms?: number;
}

export interface ScenarioStep {
  action: 'navigate' | 'click' | 'fill' | 'assert' | 'wait';
  target: string;
  frame?: string;
  value?: string;
  subtitle?: string;
  pace_before_ms?: number;
  pace_after_ms?: number;
  typing_delay_ms?: number;
  highlight_shape?: HighlightShape;
  dim_background?: boolean;
  change_target?: ChangeTarget;
}

export interface RecordingScenario {
  title: string;
  steps: ScenarioStep[];
}

export interface ExecutionLog {
  step_index: number;
  action: ScenarioStep['action'];
  target: string;
  subtitle: string;
  start_time: string;
  end_time: string;
}

export interface BrowserDiagnostic {
  type: 'console' | 'pageerror' | 'requestfailed';
  timestamp: string;
  message: string;
  url?: string;
}

export interface RecordingConfig {
  baseUrl?: string;
  viewport: { width: number; height: number };
  timeout?: number;
  stepSettleMs?: number;
  headless?: boolean;
  slowMo?: number;
  enableSubtitles?: boolean;
  generateVtt?: boolean;
  enableHighlights?: boolean;
  generateMp4?: boolean;
  generatePlayerHtml?: boolean;
  generateThumbnails?: boolean;
}

const DEFAULT_PACE_BEFORE_MS = 600;
const DEFAULT_PACE_AFTER_MS = 1800;
const DEFAULT_TYPING_DELAY_MS = 55;
const MOBILE_VIEWPORT_MAX_WIDTH = 768;

export const defaultConfig: RecordingConfig = {
  viewport: { width: 1280, height: 720 },
  timeout: 30000,
  stepSettleMs: 900,
  headless: true,
  slowMo: 0,
  enableSubtitles: false,
  generateVtt: false,
  enableHighlights: false,
  generateMp4: false,
  generatePlayerHtml: false,
  generateThumbnails: false,
};

export const demoPreset: RecordingConfig = {
  ...defaultConfig,
  enableSubtitles: true,
  generateVtt: false,
  enableHighlights: true,
  generateMp4: true,
  generatePlayerHtml: true,
  generateThumbnails: true,
};

export class ScenarioRunner {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private diagnostics: BrowserDiagnostic[] = [];

  constructor(private readonly config: RecordingConfig) {}

  async start(outputDir: string): Promise<Page> {
    await fs.mkdir(outputDir, { recursive: true });
    this.diagnostics = [];

    this.browser = await chromium.launch({
      headless: this.config.headless ?? true,
      slowMo: this.config.slowMo ?? 0,
      args: ['--hide-scrollbars'],
    });

    this.context = await this.browser.newContext({
      viewport: this.config.viewport,
      recordVideo: {
        dir: outputDir,
        size: this.config.viewport,
      },
    });

    this.page = await this.context.newPage();
    this.attachDiagnostics(this.page);

    if (this.config.enableHighlights || this.config.enableSubtitles) {
      await this.installHelpers();
    }

    return this.page;
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error('Page is not initialized');
    }

    return this.page;
  }

  async execute(scenario: RecordingScenario): Promise<ExecutionLog[]> {
    const page = this.getPage();
    const logs: ExecutionLog[] = [];

    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index];
      const start = new Date().toISOString();

      await page.waitForTimeout(step.pace_before_ms ?? DEFAULT_PACE_BEFORE_MS);
      await this.setCaption(index, scenario.steps.length, step.subtitle ?? '');
      await this.centerTargetIfNeeded(step);
      await this.showHighlight(step);
      await this.runStep(step);
      await this.setCaption(index, scenario.steps.length, step.subtitle ?? '');
      await page.waitForTimeout(step.pace_after_ms ?? DEFAULT_PACE_AFTER_MS);
      await this.clearHighlight();

      logs.push({
        step_index: index,
        action: step.action,
        target: step.target,
        subtitle: step.subtitle ?? '',
        start_time: start,
        end_time: new Date().toISOString(),
      });
    }

    return logs;
  }

  async saveExecutionLogs(filePath: string, logs: ExecutionLog[]): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(logs, null, 2), 'utf8');
  }

  async saveBrowserDiagnostics(filePath: string): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(this.diagnostics, null, 2), 'utf8');
  }

  async stop(): Promise<string | null> {
    const page = this.page;

    await this.context?.close();
    await this.browser?.close();

    this.page = null;
    this.context = null;
    this.browser = null;

    return page?.video()?.path() ?? null;
  }

  private async runStep(step: ScenarioStep): Promise<void> {
    const page = this.getPage();
    const targetPage = step.frame ? page.frameLocator(step.frame).locator(step.target) : page.locator(step.target);

    switch (step.action) {
      case 'navigate': {
        const url = this.resolveUrl(step.target);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
        break;
      }
      case 'click':
        await targetPage.click({ timeout: this.config.timeout });
        break;
      case 'fill':
        await targetPage.click({ timeout: this.config.timeout });
        await targetPage.fill('');
        await targetPage.type(step.value ?? '', { delay: step.typing_delay_ms ?? DEFAULT_TYPING_DELAY_MS });
        break;
      case 'assert':
        await targetPage.waitFor({ state: 'visible', timeout: this.config.timeout });
        break;
      case 'wait':
        await page.waitForTimeout(Number(step.target));
        break;
      default:
        throw new Error(`Unsupported action: ${String(step.action)}`);
    }

    await page.waitForTimeout(this.config.stepSettleMs ?? 900);
  }

  private attachDiagnostics(page: Page): void {
    page.on('console', (message) => {
      this.diagnostics.push({
        type: 'console',
        timestamp: new Date().toISOString(),
        message: `[${message.type()}] ${message.text()}`,
        url: page.url(),
      });
    });

    page.on('pageerror', (error) => {
      this.diagnostics.push({
        type: 'pageerror',
        timestamp: new Date().toISOString(),
        message: error.message,
        url: page.url(),
      });
    });

    page.on('requestfailed', (request) => {
      this.diagnostics.push({
        type: 'requestfailed',
        timestamp: new Date().toISOString(),
        message: request.failure()?.errorText ?? 'Request failed',
        url: request.url(),
      });
    });
  }

  private resolveUrl(target: string): string {
    if (/^https?:\/\//u.test(target)) {
      return target;
    }
    if (!this.config.baseUrl) {
      throw new Error(`Relative target requires baseUrl: ${target}`);
    }
    return new URL(target, this.config.baseUrl).toString();
  }

  private async installHelpers(): Promise<void> {
    const page = this.getPage();

    await page.addInitScript(
      (payload: { enableHighlights: boolean; enableSubtitles: boolean }) => {
        const { enableHighlights, enableSubtitles } = payload;
        if (!enableHighlights && !enableSubtitles) {
          return;
        }

        const styleId = '__pw_recording_helpers__';
        const cursorId = '__pw_cursor_helper__';
        const focusId = '__pw_focus_helper__';
        const captionId = '__pw_caption_helper__';
        const captionStepId = '__pw_caption_step__';
        const captionTextId = '__pw_caption_text__';

        const ensureStyle = () => {
          if (document.getElementById(styleId)) return;
          const style = document.createElement('style');
          style.id = styleId;
          style.textContent = [
            enableHighlights ? 'html, body, * { cursor: none !important; }' : '',
            '#' + cursorId + ' { position: fixed; width: 14px; height: 14px; border: 2px solid rgba(17,17,17,0.9); border-radius: 999px; background: rgba(255,255,255,0.92); box-shadow: 0 0 0 2px rgba(0,0,0,0.16); transform: translate(-50%, -50%); pointer-events: none; z-index: 2147483647; display: none; }',
            '#' + focusId + ' { position: fixed; pointer-events: none; z-index: 2147483646; display: none; border: 3px solid rgba(249,115,22,0.98); box-sizing: border-box; background: rgba(255,196,64,0.12); }',
            '#' + captionId + ' { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); display: none; width: min(920px, calc(100vw - 48px)); pointer-events: none; z-index: 2147483645; padding: 14px 18px 16px; border-radius: 18px; background: rgba(15,23,42,0.86); border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 22px 48px rgba(15,23,42,0.42); color: #fff; font-family: sans-serif; }',
            '#' + captionStepId + ' { font-size: 12px; font-weight: 700; letter-spacing: 0.12em; color: #fbbf24; margin-bottom: 10px; }',
            '#' + captionTextId + ' { font-size: 26px; line-height: 1.42; font-weight: 700; text-align: center; }',
            '@media (max-width: 768px) {',
            '  #' + captionStepId + ' { font-size: 8.4px; }',
            '  #' + captionTextId + ' { font-size: 18.2px; }',
            '}',
          ].join('\n');
          document.head.appendChild(style);
        };

        const ensureNode = (id: string) => {
          let node = document.getElementById(id);
          if (node) return node;
          node = document.createElement('div');
          node.id = id;
          document.body.appendChild(node);
          return node;
        };

        const mount = () => {
          ensureStyle();
          const cursor = ensureNode(cursorId);
          const focus = ensureNode(focusId);
          const caption = ensureNode(captionId);

          if (!document.getElementById(captionStepId)) {
            const step = document.createElement('div');
            step.id = captionStepId;
            caption.appendChild(step);
          }
          if (!document.getElementById(captionTextId)) {
            const text = document.createElement('div');
            text.id = captionTextId;
            caption.appendChild(text);
          }

          if (enableHighlights) {
            document.addEventListener(
              'mousemove',
              (event) => {
                cursor.style.display = 'block';
                cursor.style.left = event.clientX + 'px';
                cursor.style.top = event.clientY + 'px';
              },
              true
            );
            document.addEventListener('mousedown', () => {
              cursor.style.transform = 'translate(-50%, -50%) scale(0.88)';
            }, true);
            document.addEventListener('mouseup', () => {
              cursor.style.transform = 'translate(-50%, -50%) scale(1)';
            }, true);
          }

          window.__pwSetCaption = (payload: { stepLabel?: string; text?: string }) => {
            if (!enableSubtitles) return;
            const host = document.querySelector<HTMLDialogElement>('dialog[open]') ?? document.body;
            if (caption.parentElement !== host) host.appendChild(caption);
            const step = document.getElementById(captionStepId);
            const text = document.getElementById(captionTextId);
            if (!step || !text) return;
            step.textContent = payload.stepLabel ?? '';
            text.textContent = payload.text ?? '';
            caption.style.display = payload.text ? 'block' : 'none';
          };

          window.__pwClearCaption = () => {
            caption.style.display = 'none';
          };

          window.__pwShowFocus = (payload: { x: number; y: number; width: number; height: number; shape: HighlightShape; dimBackground: boolean }) => {
            if (!enableHighlights) return;
            const host = document.querySelector<HTMLDialogElement>('dialog[open]') ?? document.body;
            if (focus.parentElement !== host) host.appendChild(focus);
            const padding = 10;
            focus.style.display = 'block';
            focus.style.boxShadow = payload.dimBackground
              ? '0 0 0 9999px rgba(15,23,42,0.44), 0 0 0 4px rgba(249,115,22,0.22)'
              : '0 0 0 4px rgba(249,115,22,0.22)';
            if (payload.shape === 'circle') {
              const diameter = Math.max(payload.width, payload.height) + padding * 2;
              focus.style.left = payload.x + payload.width / 2 - diameter / 2 + 'px';
              focus.style.top = payload.y + payload.height / 2 - diameter / 2 + 'px';
              focus.style.width = diameter + 'px';
              focus.style.height = diameter + 'px';
              focus.style.borderRadius = '999px';
            } else {
              focus.style.left = payload.x - padding + 'px';
              focus.style.top = payload.y - padding + 'px';
              focus.style.width = payload.width + padding * 2 + 'px';
              focus.style.height = payload.height + padding * 2 + 'px';
              focus.style.borderRadius = '16px';
            }
          };

          window.__pwHideFocus = () => {
            focus.style.display = 'none';
          };
        };

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', mount, { once: true });
        } else {
          mount();
        }
      },
      {
        enableHighlights: this.config.enableHighlights ?? false,
        enableSubtitles: this.config.enableSubtitles ?? false,
      }
    );
  }

  private async setCaption(index: number, total: number, text: string): Promise<void> {
    if (!this.config.enableSubtitles || !text) {
      return;
    }

    const page = this.getPage();
    await page.evaluate(
      (payload: { stepLabel: string; value: string }) => {
        const { stepLabel, value } = payload;
        window.__pwSetCaption?.({ stepLabel, text: value });
      },
      {
        stepLabel: `STEP ${index + 1} / ${total}`,
        value: text,
      }
    );
  }

  private async centerTargetIfNeeded(step: ScenarioStep): Promise<void> {
    if (step.action === 'navigate' || step.action === 'wait') {
      return;
    }

    const page = this.getPage();
    const target = step.change_target ?? {
      selector: step.target,
      frame: step.frame,
    };
    const locator = target.frame ? page.frameLocator(target.frame).locator(target.selector) : page.locator(target.selector);

    await locator.scrollIntoViewIfNeeded({ timeout: this.config.timeout });
    await locator.evaluate((element: Element) => {
      element.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'auto',
      });
    });
    await page.waitForTimeout(250);
  }

  private async showHighlight(step: ScenarioStep): Promise<void> {
    if (!this.config.enableHighlights) {
      return;
    }

    const page = this.getPage();
    const target = step.change_target ?? {
      selector: step.target,
      frame: step.frame,
      shape: step.highlight_shape ?? 'box',
    };

    if (step.action === 'navigate' || step.action === 'wait') {
      return;
    }

    const locator = target.frame ? page.frameLocator(target.frame).locator(target.selector) : page.locator(target.selector);
    const box = await locator.boundingBox();
    if (!box) {
      return;
    }

    await page.evaluate(
      (payload: {
        x: number;
        y: number;
        width: number;
        height: number;
        shape: HighlightShape;
        dimBackground: boolean;
      }) => {
        const { x, y, width, height, shape, dimBackground } = payload;
        window.__pwShowFocus?.({ x, y, width, height, shape, dimBackground });
      },
      {
        ...box,
        shape: target.shape ?? 'box',
        dimBackground: step.dim_background ?? false,
      }
    );

    if (target.hold_ms) {
      await page.waitForTimeout(target.hold_ms);
    }
  }

  private async clearHighlight(): Promise<void> {
    const page = this.page;
    if (!page) {
      return;
    }

    if (this.config.enableHighlights) {
      await page.evaluate(() => {
        window.__pwHideFocus?.();
      });
    }

    if (this.config.enableSubtitles) {
      await page.evaluate(() => {
        window.__pwClearCaption?.();
      });
    }
  }
}

declare global {
  interface Window {
    __pwSetCaption?: (payload: { stepLabel?: string; text?: string }) => void;
    __pwClearCaption?: () => void;
    __pwShowFocus?: (payload: { x: number; y: number; width: number; height: number; shape: HighlightShape; dimBackground: boolean }) => void;
    __pwHideFocus?: () => void;
  }
}
