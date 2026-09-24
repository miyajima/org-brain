import { redactHookMemoryText } from "../hook-memory-bridge.mjs";

const text = (value) => redactHookMemoryText(String(value ?? "")).trim();
const field = (label, value) => `${label}: ${typeof value === "string" ? JSON.stringify(text(value)) : text(JSON.stringify(value))}`;
const present = (value) => typeof value === "string" && value.trim().length > 0;

function memoryEvidence(memory) {
  return [...(memory.source_references ?? []), ...(memory.evidence ?? [])]
    .map((item) => item.ref).filter(present);
}

function memoryCandidate(result) {
  const { memory } = result;
  const learning = memory.learning ?? {};
  const failure = memory.kind === "pitfall" || learning.lesson_type === "failure";
  const cause = learning.root_cause ?? learning.rationale ?? memory.rationale;
  const correction = learning.correction ?? learning.conclusion;
  const reuse = learning.avoidance_rule ?? learning.reuse_rule ?? memory.reuse_rule;
  const outcome = learning.verified_outcome ?? learning.outcome;
  const evidence = [...new Set(memoryEvidence(memory))];
  const complete = failure && memory.verification_state === "verified"
    && learning.lesson_type === "failure" && !learning.gaps?.length
    && !memory.conflicts?.length && evidence.length > 0
    && [learning.trigger, cause, correction, reuse, outcome].every(present);
  const lines = complete ? [
    "OrgBrain 検証済みの失敗教訓（過去の条件での検証。現在の条件との一致を確認する）",
    field("適用条件", { trigger: learning.trigger, ...learning.applicability }),
    field("失敗した方法", learning.failed_approach ?? "旧形式では未記録"),
    field("原因", cause),
    field("有効だった対処", correction),
    field("確認結果", outcome),
    field("再発防止・再利用条件", reuse),
    field("根拠", evidence)
  ] : [
    failure ? "OrgBrain 未検証または情報不足の失敗教訓（参考。禁止事項として扱わない）"
      : "OrgBrain local memory candidate (historical reference only):",
    // Legacy summaries retain their existing bound. Conditions, when present,
    // are always complete; packing omits the whole entry rather than clipping.
    field("summary", text(memory.summary || memory.content).slice(0, 320)),
    ...(failure && present(memory.rationale) ? [field("理由の記録", memory.rationale)] : []),
    ...(present(memory.reuse_rule) ? [field("再利用条件", memory.reuse_rule)] : []),
    ...(evidence.length ? [field("source_ref", evidence)] : [])
  ];
  return { text: lines.join("\n"), memory: result, failure, complete,
    keys: [`memory:${memory.id}`, ...evidence.filter((ref) => /^(?:sha256:|event:)/u.test(ref)).map((ref) => `evidence:${ref}`)] };
}

export function hookMemoryCandidates(results, attempts) {
  const memories = results.map(memoryCandidate);
  // Only combine known identical conditions and the same verification level.
  // A reported success must never hide a verified failure.
  const latest = new Map();
  for (const attempt of attempts) {
    const key = attempt.conditions_hash
      ? JSON.stringify([attempt.action_key, attempt.target, attempt.attempt_type, attempt.conditions_hash, attempt.verification_state]) : attempt.id;
    if (!latest.has(key) || latest.get(key).performed_at < attempt.performed_at) latest.set(key, attempt);
  }
  const history = [...latest.values()].map((attempt) => ({
    attempt,
    failure: attempt.outcome === "failure",
    keys: [`attempt:${attempt.id}`, ...(attempt.evidence ?? []).map((item) => `evidence:${item.ref_id}`)],
    text: [
      "OrgBrain past attempts（過去の実行結果。失敗だけで再試行を禁止せず、条件の変化と後続の成功記録を確認する）",
      field("記録", attempt.summary_ja),
      field("当時の条件", attempt.conditions ?? {}),
      field("結果", attempt.outcome),
      ...(attempt.outcome === "failure" ? [field("失敗の分類", attempt.failure_kind ?? "unknown"),
        "原因・対処: この実行結果だけでは判断できない。未解決とは断定しない。"] : []),
      field("根拠", (attempt.evidence ?? []).map((item) => item.ref_id)),
      `type=${text(attempt.attempt_type)}; verification=${text(attempt.verification_state)}`
    ].join("\n")
  }));
  return [...memories.filter((item) => item.complete), ...history, ...memories.filter((item) => !item.complete)];
}
