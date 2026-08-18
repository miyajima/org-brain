import { dashboardStatusTone, type DashboardTone } from "./dashboard-copy";

export type OperationsAction = {
  id: string;
  tone: DashboardTone;
  count: number;
  title: string;
  reason: string;
  href: string;
};
type OperationsLocale = "en" | "ja" | "zh";

type OperationsStatus = {
  memories?: { conflicting?: number; expired?: number };
  decision_review?: { unconfirmed?: number; low_confidence?: number };
  tasks?: { failed?: number; stuck?: number };
  audit?: { denied_24h?: number; failed_24h?: number };
  retention_queue?: { overdue?: number; failed?: number; manual_review?: number };
  scheduled_jobs?: Array<{ stale?: boolean; job_name?: string }>;
};

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function buildOperationsActions(status: OperationsStatus, locale: OperationsLocale = "ja"): OperationsAction[] {
  const copy = {
    en: {
      failed: ["Failed or quarantined Tasks", (n: number) => `${n} Tasks failed. Review the cause, then replay or fix them.`],
      retention: ["Retention processing delayed", (n: number) => `${n} deletion jobs failed or passed their deadline.`],
      stuck: ["Stalled Tasks", (n: number) => `${n} Tasks are not progressing. Review the queue state.`],
      conflict: ["Memory conflicts", (n: number) => `${n} memories conflict. Review the evidence and latest state.`],
      decision: ["Decisions awaiting review", (n: number) => `${n} decisions are unconfirmed or low confidence.`],
      stale: ["Scheduled jobs delayed", (n: number) => `${n} scheduled jobs are stale. Review their last successful run.`],
      manual: ["Manual review pending", (n: number) => `${n} retention jobs are waiting for manual review.`],
      audit: ["Review audit events", (denied: number, failed: number) => `${denied} denied and ${failed} failed events were recorded in the last 24 hours.`]
    },
    ja: {
      failed: ["失敗・隔離Task", (n: number) => `${n}件のTaskが失敗しています。原因を確認して再実行または修正してください。`],
      retention: ["保持期限の処理遅延", (n: number) => `${n}件の削除処理が失敗または期限超過です。`],
      stuck: ["停滞中のTask", (n: number) => `${n}件のTaskが進行していません。キュー状態を確認してください。`],
      conflict: ["記憶の競合", (n: number) => `${n}件の記憶に競合があります。根拠と最新状態を確認してください。`],
      decision: ["判断の確認待ち", (n: number) => `${n}件の判断に未確認または低信頼の状態があります。`],
      stale: ["定期処理の遅延", (n: number) => `${n}件の定期処理が古い状態です。最終成功時刻を確認してください。`],
      manual: ["手動確認待ち", (n: number) => `${n}件の保持処理が手動確認を待っています。`],
      audit: ["監査イベントの確認", (denied: number, failed: number) => `過去24時間に拒否${denied}件、失敗${failed}件が記録されています。`]
    },
    zh: {
      failed: ["失败或隔离的任务", (n: number) => `${n} 个任务失败。请检查原因后重试或修复。`],
      retention: ["保留处理延迟", (n: number) => `${n} 个删除任务失败或已超期。`],
      stuck: ["停滞的任务", (n: number) => `${n} 个任务没有进展。请检查队列状态。`],
      conflict: ["记忆冲突", (n: number) => `${n} 条记忆存在冲突。请检查依据和最新状态。`],
      decision: ["待审核决策", (n: number) => `${n} 个决策未确认或可信度较低。`],
      stale: ["定时任务延迟", (n: number) => `${n} 个定时任务状态过旧。请检查上次成功时间。`],
      manual: ["等待人工审核", (n: number) => `${n} 个保留任务正在等待人工审核。`],
      audit: ["检查审计事件", (denied: number, failed: number) => `过去24小时记录了 ${denied} 个拒绝事件和 ${failed} 个失败事件。`]
    }
  }[locale];
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
    title: copy.failed[0] as string,
    reason: (copy.failed[1] as (count: number) => string)(failedTasks),
    href: "#failed-tasks"
  });
  if (retentionFailed > 0 || retentionOverdue > 0) actions.push({
    id: "retention",
    tone: "critical",
    count: retentionFailed + retentionOverdue,
    title: copy.retention[0] as string,
    reason: (copy.retention[1] as (count: number) => string)(retentionFailed + retentionOverdue),
    href: "#retention-queue"
  });
  if (stuckTasks > 0) actions.push({
    id: "stuck-tasks",
    tone: "critical",
    count: stuckTasks,
    title: copy.stuck[0] as string,
    reason: (copy.stuck[1] as (count: number) => string)(stuckTasks),
    href: "#failed-tasks"
  });
  if (conflictingMemories > 0) actions.push({
    id: "memory-conflicts",
    tone: "warning",
    count: conflictingMemories,
    title: copy.conflict[0] as string,
    reason: (copy.conflict[1] as (count: number) => string)(conflictingMemories),
    href: "#memory-health"
  });
  if (lowConfidence > 0 || unconfirmed > 0) actions.push({
    id: "decision-review",
    tone: "warning",
    count: lowConfidence + unconfirmed,
    title: copy.decision[0] as string,
    reason: (copy.decision[1] as (count: number) => string)(lowConfidence + unconfirmed),
    href: "#decision-review"
  });
  if (staleJobs > 0) actions.push({
    id: "stale-jobs",
    tone: "warning",
    count: staleJobs,
    title: copy.stale[0] as string,
    reason: (copy.stale[1] as (count: number) => string)(staleJobs),
    href: "#scheduled-jobs"
  });
  if (manualReview > 0) actions.push({
    id: "manual-review",
    tone: "warning",
    count: manualReview,
    title: copy.manual[0] as string,
    reason: (copy.manual[1] as (count: number) => string)(manualReview),
    href: "#retention-queue"
  });
  if (deniedAudit + failedAudit > 0) actions.push({
    id: "audit-events",
    tone: deniedAudit > 0 ? "warning" : dashboardStatusTone("failed"),
    count: deniedAudit + failedAudit,
    title: copy.audit[0] as string,
    reason: (copy.audit[1] as (denied: number, failed: number) => string)(deniedAudit, failedAudit),
    href: "#audit-quality"
  });

  return actions;
}
