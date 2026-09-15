const EXPLICIT_DECISION = /(?:\b(?:we\s+(?:decided|adopted|selected|will\s+use)|(?:I|we)\s+(?:will|'ll)\s+(?:use|choose|pick|adopt|go\s+with)|let['’]?s\s+go\s+with|going\s+forward\s+we\s+(?:will|must)|from\s+now\s+on\s+we\s+(?:will|must))\b|(?:決定|採用|選択|選定|標準化|統一|固定)(?:した|する|します|しました|し(?=[、,]|つつ|て|$))|(?:に|で)決め(?:た|る|ます|ました)|(?:に|で|と)(?:し(?:た|ます|ました)|進め(?:る|ます|ました)|いき(?:ます|ました)|しておき(?:ます|ました))|(?:基本方針|運用方針|実装方針|開発方針|ルール|標準|原則|方式)(?:は|を|として|に).{1,240}(?:です|とする|にする|にした|採用する|固定する|統一する)|基本コンセプト.{1,240}方針.{1,240}(?:する|してください|設計)|(?:今後|以後|次回以降)(?:は|も)?.{1,240}(?:する|します|してください|ください|しておいて|必須|使う|使用する|行う|扱う|残して良い|運用にする)|^(?:では|じゃあ|それでは).{1,120}(?:に|へ)切り替えて(?:ください)?[。.]?$|(?:既定|デフォルト)(?:と|に)する|^\s*\d+桁で(?:よい|いい)(?:です)?[。.]?$|^.{1,160}(?:プロファイル|方式|ツール)(?:は|を).{0,120}使って(?:ください)?[。.]?$|^(?:同じ|全体|本番|変更|実装|修正).{1,160}(?:しない|触らない|禁止)(?:[。.]|$))/iu;
const COMMITMENT = /(?:\b(?:we\s+(?:decided|adopted|selected|will)|going\s+forward|from\s+now\s+on)\b|(?:決定|採用|選択|選定|標準化|統一|固定)(?:した|する|します|しました)|(?:に|で)決め(?:た|る|ます|ました)|(?:基本方針|運用方針|実装方針|開発方針)(?:は|を|として|に)|(?:今後|以後|次回以降)|しておいて|必須)/iu;
const TRANSIENT = /(?:今回だけ|このターン|このデモだけ|一時的|ひとまず|今だけ|今は|今のところ|今の所|仮(?:に|の)|\b(?:for now|this time only|temporary|one[- ]off)\b)/iu;
const QUESTION = /(?:[?？]|でしょうか|ですか|必要か|どう思う|どちらがよい|どれがよい)\s*$/iu;
const PROPOSAL_ONLY = /(?:\b(?:suggest|proposal|propose|consider|might|could)\b|提案|検討|かもしれない|するとよい)/iu;
const SELECTION_TASK = /(?:検索|比較|調査|候補).{0,240}(?:選定|選択)してください/iu;
const META_OR_FIXTURE = /(?:^\s*(?:[\[{]|",|\\n?\d+[.)、])|"(?:decision|task|checked_kinds|metrics)"|入力は信頼しない|JSONを返す|Decision Memory|Decisions table|createDecisionMemory|user['’]s decision|生成候補|評価プロンプト|<skill>|<recommended_plugins>|<environment_context>|<app-context>|# AGENTS\.md instructions)/iu;
const INJECTED_PARENT_MARKER = /(?:<skill>|<recommended_plugins>|<environment_context>|<app-context>|# AGENTS\.md instructions)/iu;

export function isInjectedUserContextText(value) {
  return INJECTED_PARENT_MARKER.test(String(value ?? ""));
}

export function isExplicitUserDecisionText(value) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text || META_OR_FIXTURE.test(text) || TRANSIENT.test(text) || QUESTION.test(text) || SELECTION_TASK.test(text)) return false;
  if (!EXPLICIT_DECISION.test(text)) return false;
  if (PROPOSAL_ONLY.test(text) && !COMMITMENT.test(text)) return false;
  return true;
}

export function explicitUserDecisionSpans(spans) {
  const candidates = Array.isArray(spans) ? spans : [];
  const injectedParents = new Set(candidates.filter((span) => INJECTED_PARENT_MARKER.test(String(span?.text ?? "")))
    .map((span) => span?.parent_span_id ?? span?.span_id).filter(Boolean));
  return candidates.filter((span) => span?.role === "user" && span.context_only !== true
    && !injectedParents.has(span?.parent_span_id ?? span?.span_id) && isExplicitUserDecisionText(span.text));
}
