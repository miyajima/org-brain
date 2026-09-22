export type KnowledgeLoopLang = "ja" | "en" | "zh";

const copy = {
  ja: {
    dashboardLoadFailed: "ダッシュボードを取得できませんでした。",
    dashboardTitle: "組織ダッシュボード", dashboardHeading: "判断と目標を、同じ場所で運用する",
    dashboardLead: "Knowledge Packの目標、実測値、共有された判断軸を確認します。未計測を0として扱いません。",
    decisions: "決定事項", rules: "共有ルール", rationales: "判断理由", packs: "Knowledge Pack", openRetros: "開催中のふりかえり", attentionCount: "要対応", confirmed: "確認済み", needsReview: "要確認", adopted: "採用済み", pending: "保留",
    goals: "目標と現状値", addPack: "Knowledge Packを追加", retrospective: "ふりかえり", actions: "改善アクション",
    current: "現状", target: "目標", distance: "目標まで", previous: "前回比", observed: "観測日時",
    import: "GitHub Actionsから取り込む", retryImport: "取り込みを再実行", importing: "取り込み中", importContinuing: "処理継続中です。画面を更新して確認できます。", refresh: "更新する",
    recordNew: "新しい観測値を記録", evidence: "根拠URL・参照", noGoals: "目標はまだありません。", readOnly: "現在の提供状態または権限では、変更操作を利用できません。",
    retroTitle: "判断軸のふりかえり", retroLead: "決定事項・ルール・判断理由を順に読み、採用可否だけを選びます。",
    startNow: "今すぐ実施", title: "タイトル", group: "参加Group", solo: "管理者のみ", cadence: "実施間隔", weekly: "1週間ごと", biweekly: "2週間ごと",
    start: "ふりかえりを開始", enableSchedule: "定期実施を有効化", history: "実施履歴", participants: "参加者", answered: "回答済み", unanswered: "未回答",
    adopt: "採用", reject: "見送る", defer: "保留", reason: "判断理由", saveDecision: "この判断を保存", next: "次へ", back: "前へ", adminReview: "管理者として確定",
    close: "結果を確定して閉じる", acknowledge: "未回答が残る状態で確定することを確認しました", chooseResult: "結果を選択", finalizerOnly: "このふりかえりを作成した管理者だけが結果を確定できます。",
    actionTitle: "改善アクション", actionLead: "担当者・期限・外部Issueを管理し、実装後に同じ目標を再計測します。", addAction: "アクションを追加",
    improvement: "改善内容", owner: "担当者ID", due: "期限", description: "説明", externalIssue: "GitHub Issue等", linkedGoal: "改善を判定する目標",
    baseline: "基準値", verification: "効果確認", measureAgain: "再計測する", verifyNow: "最新値で改善を判定", complete: "完了", inProgress: "着手する", implementationDone: "実装完了・再計測待ち", cancel: "中止する",
    noActions: "改善アクションはまだありません。", unassigned: "未割当", noDue: "期限なし", noNumericVerification: "数値検証なし", externalIssueOpen: "外部Issueを開く", backToWork: "作業へ戻す", actionUpdated: "改善アクションを更新しました。", actionUpdateFailed: "改善アクションを更新できませんでした。", createdFromRetro: "ふりかえり項目から作成"
  },
  en: {
    dashboardLoadFailed: "Dashboard could not be loaded.",
    dashboardTitle: "Organization dashboard", dashboardHeading: "Operate decisions and goals in one place", dashboardLead: "Review Knowledge Pack goals, measurements, and shared decision criteria. Missing data is never treated as zero.",
    decisions: "Decisions", rules: "Shared rules", rationales: "Rationales", packs: "Knowledge Packs", openRetros: "Open retrospectives", attentionCount: "Needs attention", confirmed: "Confirmed", needsReview: "Needs review", adopted: "Adopted", pending: "Pending", goals: "Goals and current values", addPack: "Add Knowledge Pack", retrospective: "Retrospectives", actions: "Improvement actions",
    current: "Current", target: "Target", distance: "Distance", previous: "Change", observed: "Observed", import: "Import from GitHub Actions", retryImport: "Retry import", importing: "Importing", importContinuing: "The import is still running. Refresh to check again.", refresh: "Refresh", recordNew: "Record a new observation", evidence: "Evidence URL or reference", noGoals: "No goals yet.", readOnly: "Changes are unavailable for the current feature mode or permissions.",
    retroTitle: "Decision criteria retrospective", retroLead: "Review each decision, rule, and rationale, then choose whether to adopt it.", startNow: "Start now", title: "Title", group: "Participant group", solo: "Administrator only", cadence: "Cadence", weekly: "Every week", biweekly: "Every two weeks", start: "Start retrospective", enableSchedule: "Enable schedule", history: "History", participants: "Participants", answered: "Answered", unanswered: "Unanswered", adopt: "Adopt", reject: "Do not adopt", defer: "Defer", reason: "Rationale", saveDecision: "Save decision", next: "Next", back: "Previous", adminReview: "Finalize as administrator", close: "Finalize and close", acknowledge: "I acknowledge that unanswered responses remain", chooseResult: "Choose result", finalizerOnly: "Only the administrator who created this retrospective can finalize it.",
    actionTitle: "Improvement actions", actionLead: "Track owners, due dates, and issues, then remeasure the same goal.", addAction: "Add action", improvement: "Improvement", owner: "Owner ID", due: "Due date", description: "Description", externalIssue: "External issue", linkedGoal: "Goal used for verification", baseline: "Baseline", verification: "Verification", measureAgain: "Measure again", verifyNow: "Verify with latest value", complete: "Complete", inProgress: "Start", implementationDone: "Implementation complete", cancel: "Cancel",
    noActions: "No improvement actions yet.", unassigned: "Unassigned", noDue: "No due date", noNumericVerification: "No metric verification", externalIssueOpen: "Open external issue", backToWork: "Return to work", actionUpdated: "Improvement action updated.", actionUpdateFailed: "The improvement action could not be updated.", createdFromRetro: "Create from retrospective item"
  },
  zh: {
    dashboardLoadFailed: "无法加载仪表板。",
    dashboardTitle: "组织仪表板", dashboardHeading: "在同一处运营决策与目标", dashboardLead: "查看 Knowledge Pack 目标、实测值和共享判断标准。未测量的数据不会视为零。",
    decisions: "决策", rules: "共享规则", rationales: "判断理由", packs: "Knowledge Pack", openRetros: "进行中的复盘", attentionCount: "需要处理", confirmed: "已确认", needsReview: "待确认", adopted: "已采用", pending: "待定", goals: "目标与当前值", addPack: "添加 Knowledge Pack", retrospective: "复盘", actions: "改进行动",
    current: "当前", target: "目标", distance: "距离目标", previous: "较上次", observed: "观测时间", import: "从 GitHub Actions 导入", retryImport: "重新导入", importing: "正在导入", importContinuing: "导入仍在进行，请刷新页面查看。", refresh: "刷新", recordNew: "记录新的观测值", evidence: "依据链接或引用", noGoals: "尚未设置目标。", readOnly: "当前功能状态或权限不允许修改。",
    retroTitle: "判断标准复盘", retroLead: "依次查看决策、规则和理由，然后选择是否采用。", startNow: "立即开始", title: "标题", group: "参与群组", solo: "仅管理员", cadence: "周期", weekly: "每周", biweekly: "每两周", start: "开始复盘", enableSchedule: "启用定期复盘", history: "历史记录", participants: "参与者", answered: "已回答", unanswered: "未回答", adopt: "采用", reject: "不采用", defer: "暂缓", reason: "判断理由", saveDecision: "保存判断", next: "下一项", back: "上一项", adminReview: "以管理员身份确认", close: "确认并关闭", acknowledge: "我确认仍有未回答项", chooseResult: "选择结果", finalizerOnly: "只有创建本次复盘的管理员可以确认结果。",
    actionTitle: "改进行动", actionLead: "管理负责人、期限和外部 Issue，并在实施后重新测量同一目标。", addAction: "添加行动", improvement: "改进内容", owner: "负责人ID", due: "期限", description: "说明", externalIssue: "外部 Issue", linkedGoal: "用于验证的目标", baseline: "基准值", verification: "效果确认", measureAgain: "重新测量", verifyNow: "用最新值验证", complete: "完成", inProgress: "开始", implementationDone: "实施完成，等待复测", cancel: "取消",
    noActions: "尚无改进行动。", unassigned: "未分配", noDue: "无期限", noNumericVerification: "无需数值验证", externalIssueOpen: "打开外部 Issue", backToWork: "返回处理中", actionUpdated: "改进行动已更新。", actionUpdateFailed: "无法更新改进行动。", createdFromRetro: "从复盘项目创建"
  }
} as const;

export function knowledgeLoopCopy(lang: string) {
  return copy[lang === "en" || lang === "zh" ? lang : "ja"];
}

export function knowledgeLoopStatus(lang: string, status: string): string {
  const labels: Record<KnowledgeLoopLang, Record<string, string>> = {
    ja: { measured: "計測済み", unknown: "未計測", stale: "期限切れ", queued: "待機中", running: "実行中", succeeded: "成功", failed: "失敗", open: "未着手", in_progress: "対応中", awaiting_verification: "再計測待ち", completed: "完了", cancelled: "中止", active: "有効", paused: "一時停止", archived: "終了", on_track: "達成", off_track: "未達", improving: "改善", improved: "改善", unchanged: "変化なし", regressing: "悪化", regressed: "悪化", verified: "確認済み", ready: "確認可能", waiting_for_measurement: "計測待ち" },
    en: { measured: "Measured", unknown: "Not measured", stale: "Stale", queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", open: "Open", in_progress: "In progress", awaiting_verification: "Awaiting verification", completed: "Completed", cancelled: "Cancelled", active: "Active", paused: "Paused", archived: "Archived", on_track: "On track", off_track: "Off track", improving: "Improving", improved: "Improved", unchanged: "Unchanged", regressing: "Regressing", regressed: "Regressed", verified: "Verified", ready: "Ready", waiting_for_measurement: "Waiting for measurement" },
    zh: { measured: "已测量", unknown: "未测量", stale: "已过期", queued: "等待中", running: "执行中", succeeded: "成功", failed: "失败", open: "未开始", in_progress: "进行中", awaiting_verification: "等待复测", completed: "已完成", cancelled: "已取消", active: "有效", paused: "已暂停", archived: "已结束", on_track: "已达成", off_track: "未达成", improving: "改善中", improved: "已改善", unchanged: "无变化", regressing: "恶化", regressed: "已恶化", verified: "已确认", ready: "可确认", waiting_for_measurement: "等待测量" }
  };
  const resolved = lang === "en" || lang === "zh" ? lang : "ja";
  return labels[resolved][status] ?? status;
}

export function knowledgeLoopSourceType(lang: string, sourceType: string): string {
  const labels: Record<KnowledgeLoopLang, Record<string, string>> = {
    ja: { decision_memory: "決定事項", decision_rationale: "判断理由", projected_rule: "共有ルール" },
    en: { decision_memory: "Decision", decision_rationale: "Rationale", projected_rule: "Shared rule" },
    zh: { decision_memory: "决策", decision_rationale: "判断理由", projected_rule: "共享规则" }
  };
  const resolved = lang === "en" || lang === "zh" ? lang : "ja";
  return labels[resolved][sourceType] ?? sourceType;
}

export function knowledgeLoopError(lang: string, code: unknown, fallback: string): string {
  const labels: Record<KnowledgeLoopLang, Record<string, string>> = {
    ja: {
      feature_preview: "このテナントではプレビュー中の変更操作を利用できません。",
      no_eligible_candidates: "選択した参加者が閲覧できる候補がありません。",
      retrospective_unanswered_ack_required: "未回答が残ることを確認してから確定してください。",
      retrospective_eligibility_changed: "参加者の閲覧権限が変わりました。この回を中止して作り直してください。",
      fresh_baseline_required: "目標へ紐づける前に、新しい基準値を記録してください。",
      fresh_verification_snapshot_required: "実装完了後の新しい観測値を記録してください。"
    },
    en: {
      feature_preview: "Changes are not available for this tenant during preview.",
      no_eligible_candidates: "No candidates are visible to the selected participants.",
      retrospective_unanswered_ack_required: "Acknowledge the unanswered responses before finalizing.",
      retrospective_eligibility_changed: "Participant access changed. Cancel this retrospective and create a new one.",
      fresh_baseline_required: "Record a fresh baseline before linking this goal.",
      fresh_verification_snapshot_required: "Record a new observation after implementation."
    },
    zh: {
      feature_preview: "此租户在预览期间不能执行更改。",
      no_eligible_candidates: "所选参与者没有可查看的候选项。",
      retrospective_unanswered_ack_required: "请先确认仍有未回答项，再完成复盘。",
      retrospective_eligibility_changed: "参与者权限已变更，请取消本次复盘并重新创建。",
      fresh_baseline_required: "关联目标前，请先记录新的基准值。",
      fresh_verification_snapshot_required: "请记录实施完成后的新观测值。"
    }
  };
  const resolved = lang === "en" || lang === "zh" ? lang : "ja";
  return typeof code === "string" ? labels[resolved][code] ?? fallback : fallback;
}

export function knowledgeLoopUnit(lang: string, unit: string): string {
  if (unit === "percent") return "%";
  if (unit === "count") return lang === "ja" ? "件" : lang === "zh" ? "项" : "";
  if (unit === "seconds") return lang === "ja" ? "秒" : lang === "zh" ? "秒" : "s";
  return unit;
}
