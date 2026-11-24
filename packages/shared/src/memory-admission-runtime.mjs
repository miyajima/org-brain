const present = value => typeof value === 'string' && value.trim() && !/^(?:未確認|不明|unknown|none)$/iu.test(value.trim());

const SUGGESTION_OUTPUT = /^(?:```(?:json)?\s*)?\{\s*"suggestions"\s*:\s*\[/iu;
const DATED_REPORT = /^#{1,6}[^\n]*?(?:日次レポート|daily report)/iu;
const REPORT_DATE = /(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|20\d{2}年\d{1,2}月\d{1,2}日)/u;
const COMMIT_STATUS = /(?:^|\|\s*|\n\s*(?:[-*]\s*)?)\d+件をコミット済み\s*[:：]\s*`?[a-f\d]{7,40}\b/iu;

function isGeneratedReuse(footer, original) {
  if (/^When the same symptom appears, run `[^`\n]+`(?:, `[^`\n]+`)* first\.\nTreat the result as confirmed only if the follow-up command succeeds\.$/u.test(footer)) return true;
  const snippets = footer.match(/^If the same symptom recurs, assume (.+)\nApply (.+)$/u)?.slice(1)
    ?? footer.match(/^Reuse this workaround only for the same project pattern\.\nValidate with the same check after applying: (.+)$/u)?.slice(1);
  const flattened = original.replace(/\s+/gu,' ');
  return Boolean(snippets?.every(text => flattened.includes(text)));
}

// Match only high-signal shapes for scheduled cleanup. Do not let a nested
// report heading terminate the legacy Takeaway section.
export function definiteTransientReason(memory) {
  if (present(memory.reuse_rule ?? memory.reuseRule)) return null;
  const summary = String(memory.summary ?? '').normalize('NFKC').trim();
  const raw = String(memory.content ?? '').normalize('NFKC').trim();
  const legacy = raw.startsWith('# Reusable Memory');
  const legacyReuse = legacy ? raw.match(/^## Reuse Rule[^\S\n]*\n([\s\S]*)$/mu) : null;
  if (legacyReuse?.[1].trim() && !isGeneratedReuse(legacyReuse[1].trim(), raw.slice(0, legacyReuse.index))) return null;
  const takeaway = legacy
    ? raw.match(/^## Takeaway[^\S\n]*\n([\s\S]*?)(?=^## (?:Evidence|Reuse Rule)\s*$|(?![\s\S]))/mu)?.[1]?.trim() ?? raw
    : raw;
  if (SUGGESTION_OUTPUT.test(takeaway)) return 'bulk_suggestions';
  if (DATED_REPORT.test(takeaway) && REPORT_DATE.test(takeaway.split('\n', 1)[0])) return 'dated_report';
  if (COMMIT_STATUS.test(`${summary}\n${takeaway}`)) return 'commit_status';
  const lesson = memory.learning;
  if (lesson?.lesson_type === 'failure' && present(lesson.symptom) && ![
    lesson.failed_approach, lesson.root_cause, lesson.correction, lesson.verified_outcome, lesson.avoidance_rule
  ].some(present)) return 'symptom_only';
  return null;
}

// Conservative: never discard an explicit decision, a failure lesson, or a reuse rule.
export function isTransientMemory(memory) {
  let tags=memory.tags??[];
  if(memory.tags_json)try{tags=JSON.parse(memory.tags_json);}catch{return false;}
  if (!Array.isArray(tags)) return false;
  if (['decision', 'constraint', 'preference'].includes(memory.kind)
    || memory.conflicts?.length || tags.includes('user-confirmed-learning')) return false;
  if (definiteTransientReason(memory)) return true;
  const summary = String(memory.summary ?? '').normalize('NFKC').trim();
  const raw = String(memory.content ?? '').normalize('NFKC').trim();
  if (memory.kind === 'pitfall'
    || present(memory.reuse_rule ?? memory.reuseRule) || memory.learning?.lesson_type
    || tags.some(tag=>['decision','preference','policy','workaround','failure'].includes(tag))) return false;
  const content = raw.replace(/^-\s*(?:Source|Event|Project|RecordedAt):.*$/gmu, '');
  // Configuration and migration facts can remain useful after the work completes.
  if (/(?:[a-z_][a-z0-9_]*\s*[:=]\s*\d+|毎(?:朝|日|週)|移設|移行|現行セット)/iu.test(content)) return false;
  if (/(?:再利用条件|再発防止|適用条件|avoidance_rule|reuse_when)\s*[:：]|(?:必須|禁止|方針|原則|前提|上限|条件|変更不要|設定一つ|manifest|session\.update|再試行|ルール|権限|認証|原因|再発)/iu.test(content)) return false;
  // A command-result tag alone also labels useful explanations. Require an actual status report.
  return /(?:完了しました|完了\s*しました|コミット済み|再起動済み|未着手|実行中|日次レポート|監視レポートを生成|^(?:done|completed)[.!\s])/iu.test(summary);
}
