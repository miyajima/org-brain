import type { IntelligenceLocale } from "./intelligence-locale";
import type { KnowledgeGraphNode } from "./knowledge-graph-ui";
import { eventDeepLink, type DashboardActivity } from "./nervous-system-ui";
import type { StrataDetailPayload, StrataPayload } from "./memory-strata-ui";

export type InsightSurface = "activity" | "connections" | "history";

export type PageGuide = {
  heading: string;
  useWhenLabel: string;
  useWhen: string;
  learnLabel: string;
  learn: string;
  startLabel: string;
  start: string;
};

export type RecommendedAction = {
  id: string;
  tone: "info" | "warning" | "critical";
  title: string;
  reason: string;
  evidence: string;
  cta: string;
  href: string;
};

type Locale = IntelligenceLocale;

const COPY = {
  en: {
    guide: {
      heading: "How to use this view",
      labels: ["Use this when", "What you can learn", "Start here"],
      activity: ["Checking daily operations or investigating a failure or stall", "Who did what and where attention is needed", "Review the most important signal in the mission briefing"],
      connections: ["Before using or changing an important piece of knowledge", "Which decisions, sources, projects, and tasks it affects", "Select a node, then read its evidence and review candidates"],
      history: ["Validating current knowledge or understanding why it changed", "What changed, when it changed, and which evidence supports it", "Read the current summary before exploring the timeline"]
    },
    briefing: "What to look at now",
    activityHealthy: ["No signals currently need attention", "The latest observed activity has no warning or critical signal."],
    activity: { title: "Signal to review", ctaTask: "Review Task", ctaSignal: "Review trace", evidence: "signal" },
    knowledgeHealthy: ["No review candidates for this knowledge", "The selected knowledge has recorded confidence, usage, and relationships."],
    knowledgeEmpty: ["No knowledge is available to review", "Change the scope or add knowledge before reviewing confidence and relationships."],
    knowledge: {
      missingConfidence: ["Confidence is not recorded", "Check the evidence and current state before relying on this knowledge.", "Confidence not measured"],
      lowConfidence: ["Check confidence", "Confidence is below the current review threshold of 70%.", "Confidence {value}%"],
      isolated: ["No recorded relationships yet", "Review related decisions, sources, or tasks to understand its impact.", "Connections 0"],
      unused: ["No recent usage is recorded", "No usage was recorded in the last 30 days; this is a good point to check freshness.", "30-day usage 0"],
      ctaContent: "Review content",
      ctaEvidence: "Add evidence",
      ctaRelations: "Review relationships",
      interpretations: {
        confidenceGood: "Enough confidence for normal review",
        confidenceReview: "Review before relying on it",
        confidenceMissing: "Not enough information to judge",
        usageGood: "Used during the last 30 days",
        usageNone: "No recent usage recorded",
        linksGood: "Connected to {value} related items",
        linksNone: "No related items recorded"
      }
    },
    historyHealthy: ["No review candidates for this history", "The selected knowledge has evidence and no current attention signal."],
    historyEmpty: ["No history is available to review", "Change the scope or record a revision before reviewing changes and evidence."],
    history: {
      attention: ["Review the current attention signal", "This history includes a recorded item that needs review."],
      noSources: ["No supporting source is recorded", "Add or verify a source before treating this as established knowledge.", "Sources 0"],
      partial: ["Part of the history is incomplete", "Some revision fields were unavailable, so the visible history may not tell the whole story.", "Partial history"],
      expired: ["The validity period has ended", "Confirm whether a newer record should replace the current knowledge.", "Validity ended"],
      unconfirmed: ["Confirmation is not recorded", "Review whether the current knowledge has been confirmed.", "Confirmation not recorded"],
      ctaCurrent: "Review current content",
      ctaEvidence: "Review evidence",
      ctaReview: "Review"
    }
  },
  ja: {
    guide: {
      heading: "この画面の使い方",
      labels: ["この画面を使う場面", "ここでわかること", "最初に見る場所"],
      activity: ["日々の状況確認や、失敗・停滞の原因を調べるとき", "誰が何を行い、どこに対応が必要か", "「いま見るべきこと」の重大シグナルから確認"],
      connections: ["重要な知識を利用・変更する前", "関連する判断・資料・プロジェクト・Taskと影響範囲", "ノードを選び、根拠と確認候補を確認"],
      history: ["現在の知識が正しいか、なぜ変わったか確認するとき", "何がいつ変わり、どの根拠に支えられているか", "現在の要約を読んでから時間軸を探索"]
    },
    briefing: "いま見るべきこと",
    activityHealthy: ["現在、対応が必要なシグナルはありません", "直近の観測には警告・重大シグナルが記録されていません。"],
    activity: { title: "確認が必要なシグナル", ctaTask: "Taskを確認", ctaSignal: "トレースを確認", evidence: "シグナル" },
    knowledgeHealthy: ["この知識に確認候補はありません", "選択中の知識には、信頼度・利用・関連が記録されています。"],
    knowledgeEmpty: ["確認できる知識がありません", "対象範囲を変更するか、知識を追加すると信頼度と関連を確認できます。"],
    knowledge: {
      missingConfidence: ["信頼度が未設定です", "この知識を使う前に、根拠と現在の状態を確認してください。", "信頼度 未計測"],
      lowConfidence: ["信頼度を確認", "現在の確認基準である70%を下回っています。", "信頼度 {value}%"],
      isolated: ["関連がまだ記録されていません", "関連する判断・資料・Taskを確認すると、影響範囲を理解できます。", "接続数 0"],
      unused: ["最近の利用が記録されていません", "過去30日間の利用がないため、内容の鮮度を確認できます。", "30日利用 0"],
      ctaContent: "内容を確認",
      ctaEvidence: "根拠を追加",
      ctaRelations: "関連を確認",
      interpretations: {
        confidenceGood: "通常の確認に使える信頼度です",
        confidenceReview: "利用前の確認がおすすめです",
        confidenceMissing: "判断材料がまだありません",
        usageGood: "過去30日間に利用されています",
        usageNone: "最近の利用は未記録です",
        linksGood: "{value}件の関連項目につながっています",
        linksNone: "関連項目はまだ記録されていません"
      }
    },
    historyHealthy: ["この履歴に確認候補はありません", "選択中の知識には根拠があり、現在の注目シグナルもありません。"],
    historyEmpty: ["確認できる履歴がありません", "対象範囲を変更するか、変更を記録すると履歴と根拠を確認できます。"],
    history: {
      attention: ["現在の注目事項を確認", "この履歴にはレビューが必要な項目が記録されています。"],
      noSources: ["根拠となる資料がありません", "確立した知識として扱う前に、参照元を追加または確認してください。", "参照元 0"],
      partial: ["履歴の一部が不完全です", "取得できなかった項目があるため、表示された履歴だけでは全体を判断できない可能性があります。", "部分履歴"],
      expired: ["有効期間が終了しています", "現在の知識を置き換える新しい記録が必要か確認してください。", "有効期間 終了"],
      unconfirmed: ["確認状態が記録されていません", "現在の知識が確認済みかレビューしてください。", "確認状態 未記録"],
      ctaCurrent: "現在の内容を確認",
      ctaEvidence: "根拠を確認",
      ctaReview: "レビューする"
    }
  },
  zh: {
    guide: {
      heading: "如何使用此页面",
      labels: ["何时使用", "可以了解什么", "从哪里开始"],
      activity: ["每日检查，或调查失败和停滞时", "谁做了什么，以及哪里需要处理", "先查看任务简报中的重要信号"],
      connections: ["使用或修改重要知识之前", "相关决策、资料、项目、任务及影响范围", "选择节点后查看证据和待确认事项"],
      history: ["确认当前知识或了解变更原因时", "变更内容、时间以及支撑证据", "先阅读当前摘要，再探索时间线"]
    },
    briefing: "现在需要关注",
    activityHealthy: ["当前没有需要处理的信号", "最近的活动中没有警告或严重信号。"],
    activity: { title: "需要确认的信号", ctaTask: "查看任务", ctaSignal: "查看追踪", evidence: "信号" },
    knowledgeHealthy: ["此知识没有待确认事项", "所选知识已记录可信度、使用情况和关系。"],
    knowledgeEmpty: ["没有可确认的知识", "请更改范围或添加知识后再查看可信度和关系。"],
    knowledge: {
      missingConfidence: ["未记录可信度", "使用此知识前，请确认其证据和当前状态。", "可信度 未测量"],
      lowConfidence: ["确认可信度", "低于当前70%的确认标准。", "可信度 {value}%"],
      isolated: ["尚未记录关系", "确认相关决策、资料或任务有助于了解影响范围。", "连接数 0"],
      unused: ["未记录近期使用", "过去30天没有使用记录，可以检查内容是否仍然有效。", "30天使用 0"],
      ctaContent: "查看内容",
      ctaEvidence: "添加依据",
      ctaRelations: "查看关系",
      interpretations: {
        confidenceGood: "可信度足以进行常规确认",
        confidenceReview: "建议使用前确认",
        confidenceMissing: "尚无足够信息判断",
        usageGood: "过去30天内有使用记录",
        usageNone: "未记录近期使用",
        linksGood: "已连接{value}个相关项目",
        linksNone: "尚未记录相关项目"
      }
    },
    historyHealthy: ["此历史没有待确认事项", "所选知识有证据，且没有当前关注信号。"],
    historyEmpty: ["没有可确认的历史", "请更改范围或记录变更后再查看历史和依据。"],
    history: {
      attention: ["查看当前关注事项", "此历史包含需要审核的记录。"],
      noSources: ["没有支撑资料", "作为正式知识使用前，请添加或确认来源。", "来源 0"],
      partial: ["部分历史不完整", "部分修订字段不可用，当前历史可能不完整。", "部分历史"],
      expired: ["有效期已结束", "请确认是否需要用新记录替换当前知识。", "有效期 已结束"],
      unconfirmed: ["未记录确认状态", "请审核当前知识是否已经确认。", "确认状态 未记录"],
      ctaCurrent: "查看当前内容",
      ctaEvidence: "查看证据",
      ctaReview: "审核"
    }
  }
} as const;

function localized(locale: Locale) {
  return COPY[locale] ?? COPY.en;
}

export function insightBriefingTitle(locale: Locale): string {
  return localized(locale).briefing;
}

export function pageGuide(surface: InsightSurface, locale: Locale): PageGuide {
  const copy = localized(locale).guide;
  const values = copy[surface];
  return {
    heading: copy.heading,
    useWhenLabel: copy.labels[0],
    useWhen: values[0],
    learnLabel: copy.labels[1],
    learn: values[1],
    startLabel: copy.labels[2],
    start: values[2]
  };
}

function scopedParams(params: URLSearchParams): URLSearchParams {
  const scope = new URLSearchParams();
  for (const key of ["tenant_id", "project_id", "lang"]) {
    const value = params.get(key);
    if (value) scope.set(key, value);
  }
  return scope;
}

function scopedPath(pathname: string, params: URLSearchParams): string {
  const scope = scopedParams(params);
  return scope.size ? `${pathname}?${scope.toString()}` : pathname;
}

function activitySelectionHref(eventId: string, params: URLSearchParams, pathname: string): string {
  const next = new URLSearchParams(params);
  next.set("event", eventId);
  return `${pathname}?${next.toString()}`;
}

export function activityRecommendedActions(
  data: DashboardActivity,
  params: URLSearchParams,
  pathname: string,
  locale: Locale
): RecommendedAction[] {
  const copy = localized(locale).activity;
  const actions: RecommendedAction[] = [];
  const matchedEventIds = new Set<string>();
  for (const signal of data.attention) {
    const event = data.events.find((candidate) => candidate.task_id === signal.subject_id || candidate.subject.id === signal.subject_id);
    if (event) matchedEventIds.add(event.id);
    const taskLike = signal.subject_type.includes("task") || Boolean(event?.task_id);
    const taskHref = event ? eventDeepLink(event, scopedParams(params)) : null;
    const href = taskLike && taskHref
      ? taskHref
      : event
        ? activitySelectionHref(event.id, params, pathname)
      : taskLike && signal.subject_id
        ? scopedPath(`/tasks/${encodeURIComponent(signal.subject_id)}`, params)
        : "#attention-signals";
    actions.push({
      id: signal.id,
      tone: signal.severity,
      title: copy.title,
      reason: signal.reason,
      evidence: `${copy.evidence} · ${signal.kind}`,
      cta: taskLike ? copy.ctaTask : copy.ctaSignal,
      href
    });
  }
  for (const event of data.events) {
    if (actions.length >= 3) break;
    if (matchedEventIds.has(event.id) || (event.severity !== "critical" && event.status !== "failed")) continue;
    actions.push({
      id: event.id,
      tone: event.severity === "critical" ? "critical" : "warning",
      title: copy.title,
      reason: event.summary,
      evidence: `${event.type} · ${event.status ?? event.severity}`,
      cta: event.task_id ? copy.ctaTask : copy.ctaSignal,
      href: event.task_id ? eventDeepLink(event, scopedParams(params)) ?? activitySelectionHref(event.id, params, pathname) : activitySelectionHref(event.id, params, pathname)
    });
  }
  return actions.slice(0, 3);
}

export function activityHealthyCopy(locale: Locale): { title: string; body: string } {
  const [title, body] = localized(locale).activityHealthy;
  return { title, body };
}

export function knowledgeRecommendedActions(node: KnowledgeGraphNode | null, deepLink: string | null, locale: Locale): RecommendedAction[] {
  if (!node) return [];
  const copy = localized(locale).knowledge;
  const href = deepLink ?? "#knowledge-edge-list";
  const fallbackCta = deepLink ? copy.ctaContent : copy.ctaRelations;
  const actions: RecommendedAction[] = [];
  if (node.confidence == null) {
    actions.push({ id: `${node.id}:confidence-missing`, tone: "warning", title: copy.missingConfidence[0], reason: copy.missingConfidence[1], evidence: copy.missingConfidence[2], cta: deepLink ? copy.ctaEvidence : copy.ctaRelations, href });
  } else if (node.confidence < 0.7) {
    actions.push({ id: `${node.id}:confidence-low`, tone: "warning", title: copy.lowConfidence[0], reason: copy.lowConfidence[1], evidence: copy.lowConfidence[2].replace("{value}", String(Math.round(node.confidence * 100))), cta: deepLink ? copy.ctaEvidence : copy.ctaRelations, href });
  }
  if (!node.degree_recorded || node.degree === 0) {
    actions.push({ id: `${node.id}:isolated`, tone: "info", title: copy.isolated[0], reason: copy.isolated[1], evidence: copy.isolated[2], cta: copy.ctaRelations, href: "#knowledge-node-list" });
  }
  if (!node.usage_count_30d_recorded || node.usage_count_30d === 0) {
    actions.push({ id: `${node.id}:unused`, tone: "info", title: copy.unused[0], reason: copy.unused[1], evidence: copy.unused[2], cta: fallbackCta, href });
  }
  return actions.slice(0, 3);
}

export function knowledgeHealthyCopy(locale: Locale, hasSelection = true): { title: string; body: string } {
  const [title, body] = hasSelection ? localized(locale).knowledgeHealthy : localized(locale).knowledgeEmpty;
  return { title, body };
}

export function knowledgeMetricInterpretations(node: KnowledgeGraphNode, locale: Locale) {
  const copy = localized(locale).knowledge.interpretations;
  return {
    confidence: node.confidence == null ? copy.confidenceMissing : node.confidence < 0.7 ? copy.confidenceReview : copy.confidenceGood,
    usage: !node.usage_count_30d_recorded ? copy.confidenceMissing : node.usage_count_30d === 0 ? copy.usageNone : copy.usageGood,
    links: !node.degree_recorded ? copy.confidenceMissing : node.degree === 0 ? copy.linksNone : copy.linksGood.replace("{value}", String(node.degree))
  };
}

function latestConfirmation(detail: StrataDetailPayload | null): unknown {
  const latest = detail?.chain?.revisions.at(-1)?.snapshot;
  return latest?.confirmation_state ?? latest?.confirmationState;
}

export function historyRecommendedActions(
  data: StrataPayload,
  detail: StrataDetailPayload | null,
  deepLink: string | null,
  locale: Locale
): RecommendedAction[] {
  const chain = detail?.chain ?? data.chains[0] ?? null;
  if (!chain) return [];
  const copy = localized(locale).history;
  const currentHref = deepLink ?? "#selected-chain-history";
  const actions: RecommendedAction[] = [];
  if (chain.attention) {
    actions.push({ id: `${chain.id}:attention`, tone: chain.attention.severity === "critical" ? "critical" : "warning", title: copy.attention[0], reason: chain.attention.reason || copy.attention[1], evidence: chain.attention.kind, cta: copy.ctaReview, href: "#strata-attention" });
  }
  if (chain.source_count === 0) {
    actions.push({ id: `${chain.id}:sources`, tone: "warning", title: copy.noSources[0], reason: copy.noSources[1], evidence: copy.noSources[2], cta: copy.ctaEvidence, href: currentHref });
  }
  if (chain.partial || detail?.truncated.revisions) {
    actions.push({ id: `${chain.id}:partial`, tone: "info", title: copy.partial[0], reason: copy.partial[1], evidence: copy.partial[2], cta: copy.ctaReview, href: "#selected-chain-history" });
  }
  if (chain.valid_until != null && chain.valid_until < data.generated_at) {
    actions.push({ id: `${chain.id}:expired`, tone: "warning", title: copy.expired[0], reason: copy.expired[1], evidence: copy.expired[2], cta: copy.ctaCurrent, href: currentHref });
  }
  if (detail?.chain && latestConfirmation(detail) == null) {
    actions.push({ id: `${chain.id}:unconfirmed`, tone: "info", title: copy.unconfirmed[0], reason: copy.unconfirmed[1], evidence: copy.unconfirmed[2], cta: copy.ctaReview, href: currentHref });
  }
  return actions.slice(0, 3);
}

export function historyHealthyCopy(locale: Locale, hasHistory = true): { title: string; body: string } {
  const [title, body] = hasHistory ? localized(locale).historyHealthy : localized(locale).historyEmpty;
  return { title, body };
}
