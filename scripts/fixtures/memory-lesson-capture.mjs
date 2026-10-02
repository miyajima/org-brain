// Synthetic regression fixtures only; not a held-out or live quality sample.
const rationale = 'Concurrent writers contend on the same SQLite database and cannot safely overlap.';
const reuse = 'When diagnostics share one database, run checks sequentially. Independent databases may run concurrently.';
const evidence = 'Evidence: scripts/local-memory.test.mjs and docs/MEMORY_USE_HISTORY.md.';
const conclusion = 'The diagnostic runner uses serialized SQLite checks.';
const complete = [conclusion, `Reason: ${rationale}`, `Reuse: ${reuse}`, evidence].join('\n');
export const lessonCaptureCases = [
  { id: 'separate_labeled_success_procedure', text: complete, expected: [{ content: conclusion, rationale, reuse_rule: reuse, refs: ['scripts/local-memory.test.mjs', 'docs/MEMORY_USE_HISTORY.md'] }] },
  { id: 'separate_failure_rationale', text: ['The workaround is to serialize SQLite diagnostics.', `Because ${rationale[0].toLowerCase()}${rationale.slice(1)}`, `Reuse: ${reuse}`, evidence].join('\n'), expected: [{ content: 'The workaround is to serialize SQLite diagnostics.', rationale: rationale[0].toLowerCase() + rationale.slice(1), reuse_rule: reuse, refs: ['scripts/local-memory.test.mjs', 'docs/MEMORY_USE_HISTORY.md'] }] },
  { id: 'support_fields_are_not_independent_claims', text: [conclusion, 'Rationale: The root cause is lock contention because both writers target the same database.', `Reuse: When diagnostics share one database, they must run sequentially. Independent databases may run concurrently.`, evidence].join('\n'), expected: [{ content: conclusion, rationale: 'The root cause is lock contention because both writers target the same database.', reuse_rule: 'When diagnostics share one database, they must run sequentially. Independent databases may run concurrently.', refs: ['scripts/local-memory.test.mjs', 'docs/MEMORY_USE_HISTORY.md'] }] },
  { id: 'japanese_support_labels', text: ['接続先はORGBRAIN_API_URLを正規変数として採用する。', '理由: 複数の接続先変数を同時に管理すると、各コネクターとフックの設定が独立して変更されて食い違うため。', '再利用条件: 新しいコネクターまたはフックを実装する場合は、この変数から承認済みの接続先だけを読み込む。', evidence].join('\n'), expected: [{ content: '接続先はORGBRAIN_API_URLを正規変数として採用する。', rationale: '複数の接続先変数を同時に管理すると、各コネクターとフックの設定が独立して変更されて食い違うため。', reuse_rule: '新しいコネクターまたはフックを実装する場合は、この変数から承認済みの接続先だけを読み込む。', refs: ['scripts/local-memory.test.mjs', 'docs/MEMORY_USE_HISTORY.md'] }] },
  { id: 'two_lessons_keep_separate_support', text: [complete, 'The deployment checker uses the approved API endpoint.', 'Reason: Local build results cannot establish the configuration of a running remote deployment.', 'Reuse: When validating a deployment, check only the approved endpoint. Stop if the target project differs.', 'Evidence: scripts/api-integration-smoke.mjs'].join('\n'), expected: [{ content: conclusion, rationale, reuse_rule: reuse, refs: ['scripts/local-memory.test.mjs', 'docs/MEMORY_USE_HISTORY.md'] }, { content: 'The deployment checker uses the approved API endpoint.', rationale: 'Local build results cannot establish the configuration of a running remote deployment.', reuse_rule: 'When validating a deployment, check only the approved endpoint. Stop if the target project differs.', refs: ['scripts/api-integration-smoke.mjs'] }] },
  { id: 'later_complete_lesson_survives_cap', text: ['We decided to use a shared adapter for the application.', 'Never print credentials in the application debug logs.', 'Always keep runtime configuration in the repository.', complete].join('\n'), expected: [{ content: conclusion, rationale, reuse_rule: reuse, refs: ['scripts/local-memory.test.mjs', 'docs/MEMORY_USE_HISTORY.md'] }], exact_count: false },
  { id: 'long_reuse_cannot_drop_final_exception', text: [conclusion, `Reason: ${rationale}`, `Reuse: When diagnostics share one database, ${'check the target database scope carefully; '.repeat(14)}never serialize checks against independent databases.`, evidence].join('\n'), expected: [], support_truncated: true },
  { id: 'long_multisentence_reuse_stays_review_only', text: [conclusion, `Reason: ${rationale}`, `Reuse: When diagnostics share one database, ${'check the database scope carefully. '.repeat(32)}Never touch a production database.`, evidence].join('\n'), expected: [], support_truncated: true },
  { id: 'long_rationale_stays_review_only', text: [conclusion, `Reason: ${'Concurrent writers contend on the same shared database. '.repeat(24)}The final condition remains unresolved.`, `Reuse: ${reuse}`, evidence].join('\n'), expected: [], support_truncated: true },
  { id: 'missing_rationale_stays_review_only', text: [conclusion, `Reuse: ${reuse}`, evidence].join('\n'), expected: [] },
  { id: 'unrelated_heading_cannot_supply_evidence', text: [`${conclusion} because concurrent writers contend on the same SQLite database and cannot overlap.`, `Reuse: ${reuse}`, '## Unrelated deployment notes', evidence].join('\n'), expected: [] },
  { id: 'unrelated_reason_heading_cannot_fill_lesson', text: [conclusion, `Reuse: ${reuse}`, evidence, '## Reason', rationale].join('\n'), expected: [] },
  { id: 'orphan_support_is_not_lesson', text: ['Reason: The root cause was shared SQLite lock contention.', `Reuse: ${reuse}`, evidence].join('\n'), expected: [] },
  { id: 'transient_completion', text: 'Implementation completed; commit, push, CI, and build all succeeded.', expected: [] },
  { id: 'self_reported_command_is_not_evidence', text: '`pnpm test` passed with 0 failures.', expected: [] },
  { id: 'unresolved_gaps_stay_review_only', text: `${complete}\n## Gaps\nActual lock recovery remains unverified.`, expected: [] },
  { id: 'secret_is_hard_excluded', text: `${complete}\napi_key=private-fixture-secret-123456`, expected: [], hard_reason: 'credential_detected' }
];

export function assessLessonCapture(extract, profile, fixture) {
  const result = extract({ source: 'synthetic-fixture', project_id: 'lesson-capture', event_id: fixture.id, occurred_at: 1_790_956_800_000, text: fixture.text }, { capture_profile: profile });
  const matches = fixture.expected.map(expected => result.drafts.some(draft => draft.content === expected.content
    && draft.rationale === expected.rationale && draft.reuse_rule === expected.reuse_rule
    && JSON.stringify(draft.evidence.map(item => item.ref).sort()) === JSON.stringify([...expected.refs].sort())));
  const countPass = fixture.exact_count === false ? result.drafts.length >= fixture.expected.length : result.drafts.length === fixture.expected.length;
  return { id: fixture.id, rule_complete_candidates: result.drafts.length, review_candidates: result.review_drafts.length,
    generated_candidates: result.drafts.length + result.review_drafts.length,
    expected_atomic_lessons: fixture.expected.length, preserved_atomic_lessons: matches.filter(Boolean).length,
    passed: matches.every(Boolean) && countPass && result.drafts.length + result.review_drafts.length <= 3
      && (!fixture.hard_reason || result.excluded.some(item => item.reason === fixture.hard_reason))
      && (!fixture.support_truncated || result.review_drafts.some(item => item.gaps?.includes('support_fields_truncated') && item.review_reason_codes.includes('quality_unresolved_gaps'))),
    command_evidence_count: [...result.drafts, ...result.review_drafts].flatMap(item => item.evidence).filter(item => item.type === 'command').length,
    activated_verified_memories: 0 };
}
