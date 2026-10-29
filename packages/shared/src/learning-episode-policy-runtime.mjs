// Discovery is deliberately broader than admission. This policy never grants
// human authority, verifies a reported outcome, or promotes a candidate.
export const LEARNING_EPISODE_POLICY_VERSION = 'learning-episodes/v1';
export const LEARNING_SUCCESS_SIGNAL = /\b(?:passed|verified|restored|resolved|recovered|successfully)\b|成功|合格|通過|復旧|復元|解消|確認済み|正常に|再検証|冪等|再利用|再起動後|保存.*再読込/iu;
export const LEARNING_PROCEDURE_SIGNAL = /\b(?:run|use|restart(?:ed)?|restor(?:e|ed)|configur(?:e|ed)|implement(?:ed)?|fix(?:ed)?|reus(?:e|ed)|chang(?:e|ed))\b|手順|実行|使用|変更|修正|導入|再起動|照合|復元|再利用|取得/iu;
export const LEARNING_EPISODE_INSTRUCTIONS = 'Find success/recovery/reuse and failure/cause/holds. Keep procedure, reason, bounded outcome, reuse conditions, exceptions and versions. One episode per recovery; distinguish TDD/regression. Outcomes require completed tool evidence and prove only that step; assistant/saved reports remain unverified. TLS/connection/fixture success never implies delivery/Play/natural-use success. User decisions require original human authorship.';
export function learningEpisodeContext(input = {}) {
 const snippets = Array.isArray(input.snippets) ? input.snippets : [];
 const text = [input.text ?? '', ...snippets.filter(s=>s.role!=='tool').map(s=>s.text), ...(input.sources??[]).map(s=>s.text)].join('\n');
 const action = LEARNING_PROCEDURE_SIGNAL.test(text);
 const reason = /\b(?:because|reason|cause|since)\b|理由|原因|ため|ので/iu.test(text);
 const condition = /\b(?:if|when|only|except|unless|reuse|unverified)\b|条件|場合|同じ|再利用|未検証|未測定|限定|ただし/iu.test(text);
 const events = input.events ?? [];
 const failure = /\b(?:fail(?:ed|ure)?|error|regression|held|pending)\b|原因|見落と|不一致|再発|漏れ|保留|切り詰|引き継|再確認/iu.test(text) || events.some(e=>e.status==='failed');
 return {policy_version:LEARNING_EPISODE_POLICY_VERSION,
  discovery:{success:LEARNING_SUCCESS_SIGNAL.test(text)&&action&&(reason||condition),failure:failure&&(action||reason||condition)},
  success_requires:['procedure','why_it_worked','observed_outcome','reuse_when'],
  execution_attested:events.some(e=>e.evidence_kind!=='record_read'&&e.status==='completed'&&(e.exit_code===0||e.http_status>=200&&e.http_status<300)),
  human_authority:input.authorship==='verified'?'source_verified':'unverified',
  adoption:'review_required'};
}
