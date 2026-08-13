export function evaluateRetrievalGold(rows, options = {}) {
  const k = Math.max(1, Number(options.k ?? 5));
  const items = rows.map((row) => {
    const expected = new Set(row.expected_ids ?? []);
    const returned = (row.returned_ids ?? []).slice(0, k);
    const rank = returned.findIndex((id) => expected.has(id));
    return {
      id: row.id,
      hit_at_k: rank >= 0,
      reciprocal_rank: rank >= 0 ? 1 / (rank + 1) : 0,
      empty: returned.length === 0,
      returned_ids: returned
    };
  });
  const count = items.length;
  const recallAtK = count ? items.filter((item) => item.hit_at_k).length / count : 0;
  const mrr = count ? items.reduce((sum, item) => sum + item.reciprocal_rank, 0) / count : 0;
  const emptyCount = items.filter((item) => item.empty).length;
  const minimumRecall = Number(options.minimum_recall ?? 0.9);
  const minimumMrr = Number(options.minimum_mrr ?? 0.75);
  return {
    question_count: count,
    recall_at_5: Number(recallAtK.toFixed(4)),
    mrr: Number(mrr.toFixed(4)),
    empty_result_count: emptyCount,
    passed: count >= 20 && recallAtK >= minimumRecall && mrr >= minimumMrr && emptyCount === 0,
    thresholds: {
      minimum_questions: 20,
      minimum_recall_at_5: minimumRecall,
      minimum_mrr: minimumMrr,
      maximum_empty_results: 0
    },
    items
  };
}
