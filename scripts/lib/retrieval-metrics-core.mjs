export const RAW_RETENTION_DAYS = 90;

export function percentile(values, pct) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[Math.min(rank, sorted.length - 1)] ?? null;
}

export function computeServiceMetrics(tasks) {
  const byCapability = new Map();
  const allDurations = [];

  for (const task of tasks) {
    const duration = Math.max(0, Number(task.updated_at) - Number(task.created_at));
    allDurations.push(duration);
    const key = task.capability;
    const entry = byCapability.get(key) ?? {
      capability: key,
      task_count: 0,
      succeeded_count: 0,
      failed_count: 0,
      duration_total: 0,
      durations: []
    };

    entry.task_count += 1;
    entry.succeeded_count += task.status === "succeeded" ? 1 : 0;
    entry.failed_count += task.status === "failed" ? 1 : 0;
    entry.duration_total += duration;
    entry.durations.push(duration);
    byCapability.set(key, entry);
  }

  const capability_metrics = [...byCapability.values()].map((entry) => ({
    capability: entry.capability,
    task_count: entry.task_count,
    success_rate: entry.task_count > 0 ? entry.succeeded_count / entry.task_count : 0,
    failed_count: entry.failed_count,
    avg_task_duration_ms: entry.task_count > 0 ? entry.duration_total / entry.task_count : 0,
    p95_task_duration_ms: percentile(entry.durations, 95)
  }));

  const task_count = tasks.length;
  const succeeded_count = tasks.filter((task) => task.status === "succeeded").length;
  const failed_count = tasks.filter((task) => task.status === "failed").length;
  const duration_total = allDurations.reduce((sum, value) => sum + value, 0);

  return {
    overall: {
      task_count,
      success_rate: task_count > 0 ? succeeded_count / task_count : 0,
      failed_count,
      avg_task_duration_ms: task_count > 0 ? duration_total / task_count : 0,
      p95_task_duration_ms: percentile(allDurations, 95)
    },
    by_capability: capability_metrics.sort((left, right) => left.capability.localeCompare(right.capability))
  };
}

export function computeRawRetrievalMetrics(events, tasksById) {
  const groups = new Map();

  for (const event of events) {
    const key = [event.tenant_id, event.capability, event.search_strategy].join("::");
    const entry = groups.get(key) ?? {
      tenant_id: event.tenant_id,
      capability: event.capability,
      search_strategy: event.search_strategy,
      search_count: 0,
      hit_count: 0,
      fallback_count: 0,
      matched_total: 0,
      returned_total: 0,
      latency_total: 0,
      latencies: [],
      task_ids: new Set(),
      succeeded_task_ids: new Set(),
      failed_task_ids: new Set(),
      task_duration_total: 0,
      task_duration_count: 0,
      uses_daily_rollup: false,
      top_memory_ids_json: []
    };

    entry.search_count += 1;
    entry.hit_count += Number(event.matched_count) > 0 ? 1 : 0;
    entry.fallback_count += Number(event.fallback_used) > 0 ? 1 : 0;
    entry.matched_total += Number(event.matched_count);
    entry.returned_total += Number(event.returned_count);
    entry.latency_total += Number(event.latency_ms);
    entry.latencies.push(Number(event.latency_ms));
    entry.top_memory_ids_json.push(event.top_memory_ids_json ?? "[]");

    if (!entry.task_ids.has(event.task_id)) {
      entry.task_ids.add(event.task_id);
      const task = tasksById.get(event.task_id);
      if (task) {
        const duration = Math.max(0, Number(task.updated_at) - Number(task.created_at));
        entry.task_duration_total += duration;
        entry.task_duration_count += 1;
        if (task.status === "succeeded") entry.succeeded_task_ids.add(event.task_id);
        if (task.status === "failed") entry.failed_task_ids.add(event.task_id);
      }
    }

    groups.set(key, entry);
  }

  return [...groups.values()].map((entry) => ({
    tenant_id: entry.tenant_id,
    capability: entry.capability,
    search_strategy: entry.search_strategy,
    search_count: entry.search_count,
    task_count: entry.task_ids.size,
    hit_rate: entry.search_count > 0 ? entry.hit_count / entry.search_count : 0,
    fallback_rate: entry.search_count > 0 ? entry.fallback_count / entry.search_count : 0,
    avg_matched_count: entry.search_count > 0 ? entry.matched_total / entry.search_count : 0,
    avg_returned_count: entry.search_count > 0 ? entry.returned_total / entry.search_count : 0,
    avg_latency_ms: entry.search_count > 0 ? entry.latency_total / entry.search_count : 0,
    p95_latency_ms: percentile(entry.latencies, 95),
    success_rate: entry.task_ids.size > 0 ? entry.succeeded_task_ids.size / entry.task_ids.size : 0,
    avg_task_duration_ms: entry.task_duration_count > 0 ? entry.task_duration_total / entry.task_duration_count : null,
    failed_task_count: entry.failed_task_ids.size,
    uses_daily_rollup: false
  }));
}

export function mergeRetrievalMetrics(rawMetrics, dailyMetrics) {
  const merged = new Map();

  function touch(row, usesDailyRollup) {
    const key = [row.tenant_id, row.capability, row.search_strategy].join("::");
    const entry = merged.get(key) ?? {
      tenant_id: row.tenant_id,
      capability: row.capability,
      search_strategy: row.search_strategy,
      search_count: 0,
      task_count: 0,
      hit_count: 0,
      fallback_count: 0,
      matched_total: 0,
      returned_total: 0,
      latency_total: 0,
      task_success_count: 0,
      task_failed_count: 0,
      task_duration_total: 0,
      task_duration_count: 0,
      p95_values: [],
      uses_daily_rollup: false
    };

    entry.search_count += Number(row.search_count);
    entry.task_count += Number(row.task_count);
    entry.hit_count += Math.round(Number(row.hit_rate) * Number(row.search_count));
    entry.fallback_count += Math.round(Number(row.fallback_rate) * Number(row.search_count));
    entry.matched_total += Number(row.avg_matched_count) * Number(row.search_count);
    entry.returned_total += Number(row.avg_returned_count) * Number(row.search_count);
    entry.latency_total += Number(row.avg_latency_ms) * Number(row.search_count);
    entry.task_success_count += Math.round(Number(row.success_rate) * Number(row.task_count));
    entry.task_failed_count += Number(row.failed_task_count);
    if (row.avg_task_duration_ms !== null && row.avg_task_duration_ms !== undefined) {
      entry.task_duration_total += Number(row.avg_task_duration_ms) * Number(row.task_count);
      entry.task_duration_count += Number(row.task_count);
    }
    if (!usesDailyRollup && row.p95_latency_ms !== null && row.p95_latency_ms !== undefined) {
      entry.p95_values.push(Number(row.p95_latency_ms));
    } else if (usesDailyRollup) {
      entry.uses_daily_rollup = true;
    }

    merged.set(key, entry);
  }

  for (const row of rawMetrics) touch(row, false);
  for (const row of dailyMetrics) touch(row, true);

  return [...merged.values()]
    .map((entry) => ({
      tenant_id: entry.tenant_id,
      capability: entry.capability,
      search_strategy: entry.search_strategy,
      search_count: entry.search_count,
      task_count: entry.task_count,
      hit_rate: entry.search_count > 0 ? entry.hit_count / entry.search_count : 0,
      fallback_rate: entry.search_count > 0 ? entry.fallback_count / entry.search_count : 0,
      avg_matched_count: entry.search_count > 0 ? entry.matched_total / entry.search_count : 0,
      avg_returned_count: entry.search_count > 0 ? entry.returned_total / entry.search_count : 0,
      avg_latency_ms: entry.search_count > 0 ? entry.latency_total / entry.search_count : 0,
      p95_latency_ms: entry.uses_daily_rollup ? null : percentile(entry.p95_values, 95),
      success_rate: entry.task_count > 0 ? entry.task_success_count / entry.task_count : 0,
      avg_task_duration_ms:
        entry.task_duration_count > 0 ? entry.task_duration_total / entry.task_duration_count : null,
      failed_task_count: entry.task_failed_count,
      uses_daily_rollup: entry.uses_daily_rollup
    }))
    .sort((left, right) =>
      left.capability === right.capability
        ? left.search_strategy.localeCompare(right.search_strategy)
        : left.capability.localeCompare(right.capability)
    );
}

export function countTopMemoryIds(events, limit = 10) {
  const counts = new Map();

  for (const event of events) {
    let ids;
    try {
      ids = JSON.parse(event.top_memory_ids_json ?? "[]");
    } catch {
      ids = [];
    }

    for (const id of Array.isArray(ids) ? ids : []) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([memory_id, count]) => ({ memory_id, count }))
    .sort((left, right) => right.count - left.count || left.memory_id.localeCompare(right.memory_id))
    .slice(0, limit);
}

export function classifyInputRef(inputRef) {
  if (inputRef.startsWith("memory://")) return "memory";
  if (inputRef.startsWith("r2://")) return "r2";
  return "inline";
}

export function summarizeReplayComparisons(records) {
  let changed = 0;
  let exact = 0;
  let overlapTotal = 0;
  const sourceCounts = { inline: 0, memory: 0, r2: 0 };

  for (const record of records) {
    sourceCounts[record.input_source] += 1;
    if (record.changed) changed += 1;
    if (record.exact_match) exact += 1;
    overlapTotal += record.overlap_at_5;
  }

  return {
    total_tasks: records.length,
    changed_tasks: changed,
    exact_match_rate: records.length > 0 ? exact / records.length : 0,
    average_overlap_at_5: records.length > 0 ? overlapTotal / records.length : 0,
    input_sources: sourceCounts
  };
}
