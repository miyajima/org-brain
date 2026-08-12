import { dashboardStatusTone, type DashboardTone } from "./dashboard-copy";

export type OperationsAction = {
  id: string;
  tone: DashboardTone;
  count: number;
  title: string;
  reason: string;
  href: string;
};

type OperationsStatus = {
  memories?: { conflicting?: number; expired?: number };
  decision_review?: { unconfirmed?: number; low_confidence?: number };
  tasks?: { failed?: number; stuck?: number };
  audit?: { denied_24h?: number; failed_24h?: number };
  retention_queue?: { overdue?: number; failed?: number; manual_review?: number };
  scheduled_jobs?: Array<{ stale?: boolean; job_name?: string }>;
};

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function buildOperationsActions(status: OperationsStatus): OperationsAction[] {
  const actions: OperationsAction[] = [];
  const failedTasks = count(status.tasks?.failed);
  const stuckTasks = count(status.tasks?.stuck);
  const conflictingMemories = count(status.memories?.conflicting);
  const lowConfidence = count(status.decision_review?.low_confidence);
  const unconfirmed = count(status.decision_review?.unconfirmed);
  const deniedAudit = count(status.audit?.denied_24h);
  const failedAudit = count(status.audit?.failed_24h);
  const retentionOverdue = count(status.retention_queue?.overdue);
  const retentionFailed = count(status.retention_queue?.failed);
  const manualReview = count(status.retention_queue?.manual_review);
  const staleJobs = (status.scheduled_jobs ?? []).filter((job) => job.stale).length;

  if (failedTasks > 0) actions.push({
    id: "failed-tasks",
    tone: "critical",
    count: failedTasks,
    title: "失敗・隔離Task",
    reason: `${failedTasks}件のTaskが失敗しています。原因を確認して再実行または修正してください。`,
    href: "#failed-tasks"
  });
  if (retentionFailed > 0 || retentionOverdue > 0) actions.push({
    id: "retention",
    tone: "critical",
    count: retentionFailed + retentionOverdue,
    title: "保持期限の処理遅延",
    reason: `${retentionFailed + retentionOverdue}件の削除処理が失敗または期限超過です。`,
    href: "#retention-queue"
  });
  if (stuckTasks > 0) actions.push({
    id: "stuck-tasks",
    tone: "critical",
    count: stuckTasks,
    title: "停滞中のTask",
    reason: `${stuckTasks}件のTaskが進行していません。キュー状態を確認してください。`,
    href: "#failed-tasks"
  });
  if (conflictingMemories > 0) actions.push({
    id: "memory-conflicts",
    tone: "warning",
    count: conflictingMemories,
    title: "記憶の競合",
    reason: `${conflictingMemories}件の記憶に競合があります。根拠と最新状態を確認してください。`,
    href: "#memory-health"
  });
  if (lowConfidence > 0 || unconfirmed > 0) actions.push({
    id: "decision-review",
    tone: "warning",
    count: lowConfidence + unconfirmed,
    title: "判断の確認待ち",
    reason: `${lowConfidence + unconfirmed}件の判断に未確認または低信頼の状態があります。`,
    href: "#decision-review"
  });
  if (staleJobs > 0) actions.push({
    id: "stale-jobs",
    tone: "warning",
    count: staleJobs,
    title: "定期処理の遅延",
    reason: `${staleJobs}件の定期処理が古い状態です。最終成功時刻を確認してください。`,
    href: "#scheduled-jobs"
  });
  if (manualReview > 0) actions.push({
    id: "manual-review",
    tone: "warning",
    count: manualReview,
    title: "手動確認待ち",
    reason: `${manualReview}件の保持処理が手動確認を待っています。`,
    href: "#retention-queue"
  });
  if (deniedAudit + failedAudit > 0) actions.push({
    id: "audit-events",
    tone: deniedAudit > 0 ? "warning" : dashboardStatusTone("failed"),
    count: deniedAudit + failedAudit,
    title: "監査イベントの確認",
    reason: `過去24時間に拒否${deniedAudit}件、失敗${failedAudit}件が記録されています。`,
    href: "#audit-quality"
  });

  return actions;
}
