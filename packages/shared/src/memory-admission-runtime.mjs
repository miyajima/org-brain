const present = value => typeof value === 'string' && value.trim() && !/^(?:未確認|不明|unknown|none)$/iu.test(value.trim());

// Conservative: never discard an explicit decision, a failure lesson, or a reuse rule.
export function isTransientMemory(memory) {
  let tags=memory.tags??[];
  if(memory.tags_json)try{tags=JSON.parse(memory.tags_json);}catch{return false;}
  if (!Array.isArray(tags)) return false;
  if (['decision','constraint','preference','pitfall'].includes(memory.kind)
    || present(memory.reuse_rule ?? memory.reuseRule) || memory.learning?.lesson_type
    || memory.conflicts?.length || tags.some(tag=>['decision','preference','policy','workaround','failure','user-confirmed-learning'].includes(tag))) return false;
  const summary = String(memory.summary ?? '').normalize('NFKC').trim();
  const content = String(memory.content ?? '').normalize('NFKC')
    .replace(/^-\s*(?:Source|Event|Project|RecordedAt):.*$/gmu, '');
  // Configuration and migration facts can remain useful after the work completes.
  if (/(?:[a-z_][a-z0-9_]*\s*[:=]\s*\d+|毎(?:朝|日|週)|移設|移行|現行セット)/iu.test(content)) return false;
  if (/(?:再利用条件|再発防止|適用条件|avoidance_rule|reuse_when)\s*[:：]|(?:必須|禁止|方針|原則|前提|上限|条件|変更不要|設定一つ|manifest|session\.update|再試行|ルール|権限|認証|原因|再発)/iu.test(content)) return false;
  // A command-result tag alone also labels useful explanations. Require an actual status report.
  return /(?:完了しました|完了\s*しました|コミット済み|再起動済み|未着手|実行中|日次レポート|監視レポートを生成|^(?:done|completed)[.!\s])/iu.test(summary);
}
