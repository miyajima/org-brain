import { createHash } from 'node:crypto';
import { screenSensitiveMemory } from '../../../shared/src/memory-capture-v2-runtime.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const undecided = /^(?:まだ(?:決めて|決まって|決定して)いない|未定|未決定|わからない|分からない|不明|undecided|not decided|i don'?t know)[。.!！\s]*$/iu;

/** Answers are explicit user decisions, not model-generated learning drafts. */
export async function persistAnsweredQuestionDecisions(store, commitments, options = {}) {
  const result = { saved: 0, deduplicated: 0, skipped: 0, receipts: [] };
  if (!options.enabled || !options.projectId) return result;
  const inputs = [];
  for (const commitment of commitments ?? []) {
    const answer = commitment.answer?.label ?? commitment.answer?.raw;
    const question = commitment.question;
    const evidence = commitment.evidence?.digest;
    if (commitment.authority !== 'explicit_user' || !['user_confirmed', 'user_corrected'].includes(commitment.confirmation_state)
      || !commitment.task_key || !commitment.decision_key
      || commitment.scope?.project_id !== options.projectId || !answer || !question
      || !/^sha256:[a-f0-9]{64}$/u.test(evidence ?? '') || undecided.test(answer)
      || /\[REDACTED_(?:SECRET|EMAIL|PHONE|PATH)\]/u.test(`${question} ${answer}`)
      || !screenSensitiveMemory(`${question}\n${answer}`, options.sensitivePolicy ?? { mode: 'deny', allowed_principals: [] }).allowed) {
      result.skipped++;
      continue;
    }
    const key = hash(JSON.stringify([options.tenantId, options.projectId, commitment.task_key, commitment.decision_key]));
    const summary = `質問: ${question} 回答: ${answer}`;
    const reuse = '同じプロジェクト・タスクでこの質問の判断を再利用する。本人の変更回答または現行根拠との矛盾があれば再確認し、他のタスクへ一般化しない。';
    const observedAt = commitment.updated_at ?? commitment.created_at;
    inputs.push({
      tenant_id: options.tenantId, project_id: options.projectId, work_type: options.workType ?? 'implementation',
      kind: 'decision', content: summary, summary, rationale: null, reuse_rule: reuse,
      scope_type: 'project', scope_key: options.projectId,
      source: 'question-answer', external_key: `question-answer:${key}`,
      tags: ['explicit-user-answer', 'decision'], capture_origin: 'observed', capture_route: 'realtime_hook',
      verification_state: 'verified', verified_at: observedAt,
      expires_at: commitment.expires_at,
      source_references: [{ type: commitment.evidence.type, ref: evidence }],
      evidence: [{ type: commitment.evidence.type, ref: evidence, confirmation_state: commitment.confirmation_state }],
      learning: { schema_version: 2, lesson_type: 'decision', capture_intent: 'verify', decision_type: 'user_choice',
        decision_key: commitment.decision_key, task_key: commitment.task_key,
        question, selected_value: answer, rationale: null, reuse_when: reuse,
        confirmation_state: commitment.confirmation_state, evidence_digest: evidence }
    });
  }
  for (const receipt of await store.captureBatch(inputs)) {
    result.receipts.push(receipt);
    if (receipt.deduplicated) result.deduplicated++;
    else result.saved++;
  }
  return result;
}
