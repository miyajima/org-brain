import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ScenarioRunner, demoPreset, type RecordingConfig, type RecordingScenario } from './scenario-runner.js';
import { createPlayerHtml, createThumbnail, transcodeToMp4 } from './postprocess.js';

const baseUrl = process.env.RECORDING_BASE_URL ?? 'http://127.0.0.1:4321';
const outputDir = process.env.RECORDING_OUTPUT_DIR;

if (!outputDir) {
  throw new Error('RECORDING_OUTPUT_DIR is required');
}

const config: RecordingConfig = {
  ...demoPreset,
  baseUrl,
  viewport: { width: 1440, height: 900 },
  timeout: 30_000,
  stepSettleMs: 650,
  slowMo: 0,
  generateVtt: false,
};

const scope = 'tenant_id=default&project_id=org-brain&lang=ja';

const scenario: RecordingScenario = {
  title: 'Decision-first Console v2 walkthrough',
  steps: [
    {
      action: 'navigate',
      target: `/?${scope}`,
      subtitle: '新しいホームはDecision Briefingです。重要な決定と、次に取る操作を一画面で確認します。',
      pace_after_ms: 2200,
    },
    {
      action: 'assert',
      target: '.decision-stat-grid',
      subtitle: '新規・変更・期限切れ・未確認・成果物未接続・共有待ちを、同じ基準で俯瞰できます。',
      pace_after_ms: 2000,
      highlight_shape: 'box',
    },
    {
      action: 'fill',
      target: '[data-briefing-search]',
      value: 'context',
      subtitle: '検索は決定文だけでなく、理由の要約も対象です。画面の文脈を失わずに絞り込みます。',
      typing_delay_ms: 85,
      pace_after_ms: 1800,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'click',
      target: '[data-briefing-card] .decision-action',
      subtitle: '対象の決定を開きます。ホームから詳細までは一回の遷移です。',
      pace_after_ms: 1800,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '.decision-trace-layout',
      subtitle: '詳細画面では、決定から結果までの流れを常設レールで追跡できます。',
      pace_after_ms: 2100,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '.decision-trace-node:has-text("Verified usability note")',
      subtitle: '根拠を選ぶと、右側の同じ画面内で要約と参照先を確認できます。',
      pace_after_ms: 1800,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'click',
      target: '.decision-trace-node:has-text("Console release checklist")',
      subtitle: '成果物も同じ経路上に並ぶため、判断と実装結果が分断されません。',
      pace_after_ms: 1800,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'click',
      target: '[data-access-drawer][data-resource-type="decision_memory"] [data-access-open]',
      subtitle: 'Access Drawerは、どの資産でも同じ場所から開けます。',
      pace_after_ms: 1200,
      highlight_shape: 'box',
    },
    {
      action: 'assert',
      target: '[data-access-drawer][data-resource-type="decision_memory"] [data-access-dialog][open]',
      subtitle: '所有者、保存場所、利用Agent、共有範囲を共通の表現で確認・変更できます。',
      pace_after_ms: 2100,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '[data-access-drawer][data-resource-type="decision_memory"] [data-access-close]',
      subtitle: 'ここでは内容を変更せず、決定のTrace Mapへ進みます。',
      pace_after_ms: 1200,
      highlight_shape: 'circle',
    },
    {
      action: 'click',
      target: 'a.decision-action:has-text("Decision Trace Mapを開く")',
      subtitle: 'マップは全メモリではなく、選択中の決定を中心に表示します。',
      pace_after_ms: 1800,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '[data-map-canvas]',
      subtitle: '既定では、保存済み・確認済みの関係だけを3Dで描画します。',
      pace_after_ms: 2200,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '[data-inferred-toggle]',
      subtitle: '推論関係は明示的に切り替えたときだけ追加され、確定情報と混ざりません。',
      pace_after_ms: 1800,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '.decision-map-list',
      subtitle: '同じ関係をキーボード操作できる2Dリストでも確認できます。',
      pace_after_ms: 1900,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '[data-all-knowledge-map]',
      subtitle: '全知識ビューでは、決定に未選択の知識も含めて、保存済みのつながりを一つの3D空間で確認できます。',
      pace_after_ms: 1900,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '[data-memory-map-root]',
      subtitle: '非選択のノードも常に光り、全体の構造を見失わずに探索できます。',
      pace_after_ms: 2200,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: 'nav[aria-label="Org Brain"] a[href^="/map"]:visible',
      subtitle: '必要になったら、Mapへ戻って中心にする決定を選び直せます。',
      pace_after_ms: 1600,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '.decision-map-picker summary',
      subtitle: '選択パネルを開き、閲覧できる決定を確認します。',
      pace_after_ms: 1200,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '[data-map-picker-item]',
      subtitle: '決定を一つ選ぶと、その決定を中心にしたTrace Mapへ戻ります。',
      pace_after_ms: 1700,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'click',
      target: '.decision-header-actions a.decision-action:not(.decision-action-secondary)',
      subtitle: '中心の決定へ戻り、確認済みの知識をSkill化します。',
      pace_after_ms: 1500,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: 'a.decision-action:has-text("この知識をSkill化")',
      subtitle: 'Skill生成は、ユーザーが選択した決定からだけ開始します。',
      pace_after_ms: 1700,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '[data-generation-wizard]',
      subtitle: '選択対象、追加指示、生成結果、検証条件の4段階を一つのウィザードで確認します。',
      pace_after_ms: 1900,
      highlight_shape: 'box',
    },
    {
      action: 'fill',
      target: '[data-skill-generate-form] textarea[name="instructions"]',
      value: '権限確認、利用条件、完了条件を含める',
      subtitle: '必要な利用条件と完了条件だけを追加指示として入力します。',
      typing_delay_ms: 75,
      pace_after_ms: 1700,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '[data-skill-generate-form] .decision-private-note',
      subtitle: '生成直後は必ずprivate draftです。部分的な結果が公開されることはありません。',
      pace_after_ms: 1800,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '[data-skill-generate-form] button[type="submit"]',
      subtitle: '選択済みの版ハッシュを固定して、非同期生成を開始します。',
      pace_after_ms: 1600,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '[data-generation-result]:not([hidden])',
      subtitle: '生成タスクとdraft IDを確認し、Ownerまたは管理者が検証後にPublishします。',
      pace_after_ms: 2100,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: 'nav[aria-label="Org Brain"] a[href^="/agents"]:visible',
      subtitle: '次にAgents画面で、知識を実務へ配布するLoadoutを確認します。',
      pace_after_ms: 1600,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '.decision-asset-card:has-text("Release reviewer")',
      subtitle: '名前付きAgentを選ぶと、役割・参照元の決定・現在のLoadout・最終利用が表示されます。',
      pace_after_ms: 1700,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '[data-binding-row][data-skill-id="skill-e2e"]',
      subtitle: '各Skillはalways・auto・on_demand、優先度、固定版または最新公開版を設定できます。',
      pace_after_ms: 2100,
      highlight_shape: 'box',
    },
    {
      action: 'fill',
      target: '[data-context-preview-form] textarea[name="task_text"]',
      value: 'リリース判断をレビューする',
      subtitle: '保存前に、Agentへ渡るeffective contextをタスク文で事前確認します。',
      typing_delay_ms: 80,
      pace_after_ms: 1700,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'click',
      target: '[data-context-preview-form] button[type="submit"]',
      subtitle: 'ACLを最優先にして、注入対象とon_demand handleを解決します。',
      pace_after_ms: 1600,
      highlight_shape: 'box',
      dim_background: true,
    },
    {
      action: 'assert',
      target: '[data-context-result]:not([hidden])',
      subtitle: '注入されるSkill、取得用handle、権限や状態で除外された項目を分けて確認できます。',
      pace_after_ms: 2200,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '[data-access-drawer][data-resource-type="agent"] [data-access-open]',
      subtitle: 'Agentにも同じAccess Drawerがあり、資産種別ごとに操作を覚え直す必要はありません。',
      pace_after_ms: 1200,
      highlight_shape: 'box',
    },
    {
      action: 'assert',
      target: '[data-access-drawer][data-resource-type="agent"] [data-access-dialog][open]',
      subtitle: '共有範囲と保存場所を、決定・Skill・Agent・Loadoutで統一して扱います。',
      pace_after_ms: 1900,
      highlight_shape: 'box',
    },
    {
      action: 'click',
      target: '[data-access-drawer][data-resource-type="agent"] [data-access-close]',
      subtitle: '最後にReviewsで、配布前に解消すべき不足を確認します。',
      pace_after_ms: 1200,
      highlight_shape: 'circle',
    },
    {
      action: 'click',
      target: 'nav[aria-label="Org Brain"] a[href^="/reviews"]:visible',
      subtitle: 'Reviewsは、期限・確認・成果物・共有範囲の問題を横断して集約します。',
      pace_after_ms: 1700,
      highlight_shape: 'box',
    },
    {
      action: 'assert',
      target: '.decision-review-grid',
      subtitle: 'これで、決定を理解し、根拠を確認し、SkillとAgentへ安全に配布する一連の流れが完了です。',
      pace_after_ms: 2800,
      highlight_shape: 'box',
    },
  ],
};

const activeScenario: RecordingScenario = process.env.RECORDING_SMOKE === 'true'
  ? { ...scenario, title: `${scenario.title} smoke`, steps: scenario.steps.slice(0, 3) }
  : scenario;

async function main(): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  const runner = new ScenarioRunner(config);
  await runner.start(outputDir);

  const executionLogs = await runner.execute(activeScenario);
  const page = runner.getPage();
  await page.screenshot({ path: path.join(outputDir, 'final-screen.png'), fullPage: false });

  const videoPath = await runner.stop();
  if (!videoPath) {
    throw new Error('Video path is not available');
  }

  const recordingPath = path.join(outputDir, 'recording.webm');
  const executionLogPath = path.join(outputDir, 'execution-logs.json');
  const diagnosticsPath = path.join(outputDir, 'browser-diagnostics.json');
  await runner.saveExecutionLogs(executionLogPath, executionLogs);
  await runner.saveBrowserDiagnostics(diagnosticsPath);

  if (videoPath !== recordingPath) {
    await fs.copyFile(videoPath, recordingPath);
  }

  const mp4Path = path.join(outputDir, 'decision-console-v2-walkthrough-ja.mp4');
  await transcodeToMp4(recordingPath, mp4Path);

  await Promise.allSettled([
    createThumbnail(mp4Path, path.join(outputDir, 'thumb-home.png'), 5),
    createThumbnail(mp4Path, path.join(outputDir, 'thumb-skill.png'), 45),
    createThumbnail(mp4Path, path.join(outputDir, 'thumb-agent.png'), 82),
  ]);

  const playerPath = await createPlayerHtml({
    title: 'Decision-first Console v2 操作説明',
    description: '決定の確認からSkill生成、Agent Loadout、レビューまでを日本語字幕付きで案内します。',
    outputDir,
    webmPath: recordingPath,
    mp4Path,
  });

  await fs.writeFile(
    path.join(outputDir, 'recording-manifest.json'),
    JSON.stringify(
      {
        title: activeScenario.title,
        step_count: activeScenario.steps.length,
        viewport: config.viewport,
        subtitle_mode: 'burned-in-overlay',
        external_vtt: false,
        recordingPath,
        mp4Path,
        playerPath,
        executionLogPath,
        diagnosticsPath,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(
    JSON.stringify(
      {
        outputDir,
        stepCount: activeScenario.steps.length,
        recordingPath,
        mp4Path,
        playerPath,
        executionLogPath,
        diagnosticsPath,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
