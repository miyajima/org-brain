// Only summarize allowlisted CI metadata and test counts, never environment dumps.
const fs = require('node:fs');
const path = require('node:path');
const base = process.argv[2] || '.';
const output = path.join(base, 'e2e-evidence');
fs.mkdirSync(output, { recursive: true });
let stats = null;
try { stats = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8')).stats; }
catch { /* Setup failure or cancellation can prevent a Playwright report. */ }
const metadata = {
  commit: process.env.GITHUB_SHA,
  runId: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  scope: process.env.EVIDENCE_SCOPE,
  testStepOutcome: process.env.E2E_OUTCOME,
  report: `${base}/playwright-report/index.html`,
  counts: stats ? {
    passed: stats.expected, failed: stats.unexpected,
    flaky: stats.flaky, skipped: stats.skipped,
  } : null,
};
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(metadata, null, 2) + '\n');
const counts = metadata.counts
  ? Object.entries(metadata.counts).map(([key, value]) => `${key}: ${value}`).join(', ')
  : 'No test result available (setup failure, interruption, or tests never started)';
fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
  '## Browser E2E evidence',
  `- Commit: ${metadata.commit}`,
  `- Run / attempt: ${metadata.runId} / ${metadata.attempt}`,
  `- Suite / scope: ${metadata.scope}`,
  `- Test step: ${metadata.testStepOutcome}`,
  `- Counts: ${counts}`,
  `- HTML report in artifact: ${metadata.report}`,
  `- Machine-readable results: ${base}/e2e-evidence/{results.json,results.xml,summary.json}`,
  '- Evidence retained for 14 days; missing reports do not mean tests passed.',
  '',
].join('\n'));
