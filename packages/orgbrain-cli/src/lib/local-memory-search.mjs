import { memoryFromRow, parseJson } from "./local-memory-record.mjs";
import { memoryJudgmentCandidate } from "./local-memory-judge.mjs";
import { workingLlmCandidates } from "./working-llm-candidates.mjs";
import { localAliasQuery, localTaskQueryPlan, matchesLocalTaskQuery, coversLocalTaskQuery, matchesLocalTaskQueryLiterals } from "./local-task-query.mjs";
import { localUseService, localUseFlags } from "./local-memory-use.mjs";
import { embedLocalText, LOCAL_EMBEDDING_PROVIDER } from "./local-embedding.mjs";
import { cosineSimilarity, decodeFloat32Vector } from "./local-dense-embedding.mjs";
import { requiresMultipleEvidenceSources } from "@org-brain/shared/runtime/evidence-disposition";
import { analyzeRetrievalIntent, retrievalQueryTokens, retrievalSubjectQueryTokens, retrievalUnitLexicalSpecificity, retrievalUnitIntentBoost } from "./retrieval-units.mjs";

function memoryAuthority(memory) {
  const kindAuthority = ["decision", "constraint", "org_knowledge"].includes(memory.kind)
    ? 1
    : ["fact", "episodic"].includes(memory.kind)
      ? 0.5
      : 0.75;
  // A free-form policy tag is a useful signal, but cannot by itself confer the
  // same authority as a canonical decision/constraint record.
  const policyAuthority = memory.tags.includes("policy") ? 0.75 : 0;
  return Math.max(
    0,
    Math.min(
      1,
      Number(memory.confidence_score ?? 0.5) * 0.7 +
        Math.max(kindAuthority, policyAuthority) * 0.3
    )
  );
}

export function isPublicLocalMemory(memory) {
  return memory.project_id == null && ["tenant", "org"].includes(memory.scope_type)
    && memory.deleted_at == null && memory.permissions.length === 0
    && memory.verification_state !== "rejected" && !memory.tags.some((tag) => ["source-drift", "compacted"].includes(tag.toLowerCase()))
    && !memory.conflicts.some((conflict) => conflict.toLowerCase().includes("source_drift"));
}

export function canReadMemory(record, principalId) {
  if (!principalId || record.permissions.length === 0) return true;
  return record.permissions.some(
    (entry) =>
      entry.principal_id === principalId &&
      Array.isArray(entry.permissions) &&
      (entry.permissions.includes("read") || entry.permissions.includes("admin"))
  );
}

function buildFtsQueryFromTokens(inputTokens, operator = "AND") {
  const tokens = inputTokens
    .map((token) => token.replaceAll('"', ""))
    .slice(0, 16);
  return tokens.map((token) => `"${token}"*`).join(` ${operator} `);
}

function buildFtsQuery(query, operator = "AND") {
  return buildFtsQueryFromTokens(retrievalQueryTokens(query), operator);
}

function buildFtsQueryVariants(query) {
  return [...new Set([
    buildFtsQuery(query, "AND"),
    buildFtsQuery(query, "OR")
  ].filter(Boolean))];
}

function buildFtsTokenQueryVariants(tokens) {
  return [...new Set([
    buildFtsQueryFromTokens(tokens, "AND"),
    buildFtsQueryFromTokens(tokens, "OR")
  ].filter(Boolean))];
}

function runFtsCandidates(queryVariants, execute) {
  let rows = [];
  for (const query of queryVariants) {
    rows = execute(query);
    if (rows.length > 0) return rows;
  }
  return rows;
}

function relativeWeekdayAgeMs(referenceAt, weekday) {
  if (!Number.isInteger(weekday)) return null;
  const deltaDays = (new Date(referenceAt).getUTCDay() - weekday + 7) % 7 || 7;
  return deltaDays * 24 * 60 * 60 * 1000;
}

function searchRetrievalUnitsV3(db, {
  tenantId,
  projectId,
  query,
  limit,
  minimumTotalScore,
  includeSuppressed,
  principalId,
  at
}) {
  const candidateLimit = 50;
  const temporalCandidateLimit = 200;
  const intent = analyzeRetrievalIntent(query);
  const relativeAgeMs =
    intent.relative_age_ms ?? relativeWeekdayAgeMs(at, intent.relative_weekday);
  const relativeTargetAt = relativeAgeMs === null ? null : at - relativeAgeMs;
  const ftsQueries = buildFtsQueryVariants(query);
  const subjectFtsQueries = buildFtsTokenQueryVariants(retrievalSubjectQueryTokens(query));
  const loadLexicalRows = (queryVariants) => runFtsCandidates(queryVariants, (ftsQuery) =>
    db.prepare(
      `SELECT u.*, bm25(memory_retrieval_units_fts) AS raw_rank
       FROM memory_retrieval_units_fts
       JOIN memory_retrieval_units u
         ON u.id = memory_retrieval_units_fts.unit_id
        AND u.tenant_id = memory_retrieval_units_fts.tenant_id
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE memory_retrieval_units_fts.tenant_id = ?
         AND memory_retrieval_units_fts MATCH ?
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
         AND (m.expires_at IS NULL OR m.expires_at > ?)
       ORDER BY bm25(memory_retrieval_units_fts) ASC,
                u.content_hash ASC,
                COALESCE(u.event_at, u.created_at) ASC
       LIMIT ?`
    ).all(
      tenantId,
      ftsQuery,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      at,
      candidateLimit
    )
  );
  const lexicalRows = loadLexicalRows(ftsQueries);
  const subjectLexicalRows =
    ftsQueries.length === subjectFtsQueries.length &&
    ftsQueries.every((ftsQuery, index) => ftsQuery === subjectFtsQueries[index])
      ? lexicalRows
      : loadLexicalRows(subjectFtsQueries);
  const relativeWindowMs =
    relativeAgeMs === null
      ? null
      : intent.relative_weekday !== null
        ? 24 * 60 * 60 * 1000
        : Math.max(24 * 60 * 60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, relativeAgeMs * 0.5));
  const loadTemporalLexicalRows = (queryVariants, orderBy) =>
    runFtsCandidates(queryVariants, (ftsQuery) =>
      db.prepare(
        `SELECT u.*, bm25(memory_retrieval_units_fts) AS raw_rank
         FROM memory_retrieval_units_fts
         JOIN memory_retrieval_units u
           ON u.id = memory_retrieval_units_fts.unit_id
          AND u.tenant_id = memory_retrieval_units_fts.tenant_id
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE memory_retrieval_units_fts.tenant_id = ?
           AND memory_retrieval_units_fts MATCH ?
           AND (? IS NULL OR u.project_id = ?)
           AND (? = 1 OR m.lifecycle_state != 'suppressed')
           AND (u.valid_from IS NULL OR u.valid_from <= ?)
           AND (u.valid_until IS NULL OR u.valid_until > ?)
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND ABS(COALESCE(u.event_at, u.created_at) - ?) <= ?
         ORDER BY ${orderBy}
         LIMIT ?`
      ).all(
        tenantId,
        ftsQuery,
        projectId,
        projectId,
        includeSuppressed ? 1 : 0,
        at,
        at,
        at,
        relativeTargetAt,
        relativeWindowMs,
        relativeTargetAt,
        candidateLimit
      )
    );
  const temporalLexicalRows =
    subjectFtsQueries.length > 0 && relativeTargetAt !== null && relativeWindowMs !== null
      ? loadTemporalLexicalRows(
        subjectFtsQueries,
        `ABS(COALESCE(u.event_at, u.created_at) - ?) ASC,
         bm25(memory_retrieval_units_fts) ASC,
         u.content_hash ASC,
         COALESCE(u.event_at, u.created_at) ASC`
      )
      : [];
  const temporalRelevanceRows =
    subjectFtsQueries.length > 0 && relativeTargetAt !== null && relativeWindowMs !== null
      ? loadTemporalLexicalRows(
        subjectFtsQueries,
        `bm25(memory_retrieval_units_fts) ASC,
         ABS(COALESCE(u.event_at, u.created_at) - ?) ASC,
         u.content_hash ASC,
         COALESCE(u.event_at, u.created_at) ASC`
      )
      : [];

  const temporalRows = relativeTargetAt === null
    ? []
    : db.prepare(
      `SELECT u.*, NULL AS raw_rank
       FROM memory_retrieval_units u
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE u.tenant_id = ?
         AND u.unit_type = 'session'
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
         AND (m.expires_at IS NULL OR m.expires_at > ?)
       ORDER BY ABS(COALESCE(u.event_at, u.created_at) - ?) ASC
       LIMIT ?`
    ).all(
      tenantId,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      at,
      relativeTargetAt,
      temporalCandidateLimit
    );
  const intentCandidateTypes = intent.unit_types.filter(
    (unitType) => unitType === "instruction"
  );
  const intentRows = intentCandidateTypes.length === 0
    ? []
    : db.prepare(
      `SELECT u.*, NULL AS raw_rank
       FROM memory_retrieval_units u
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE u.tenant_id = ?
         AND u.unit_type IN (${intentCandidateTypes.map(() => "?").join(",")})
         AND (u.speaker IS NULL OR u.speaker IN ('user', 'unknown'))
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
         AND (m.expires_at IS NULL OR m.expires_at > ?)
       ORDER BY COALESCE(u.event_at, u.created_at) DESC, u.content_hash ASC
       LIMIT ?`
    ).all(
      tenantId,
      ...intentCandidateTypes,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      at,
      candidateLimit
    );

  const rawQueryFeatures = embedLocalText(query);
  let queryFeatures = rawQueryFeatures;
  if (rawQueryFeatures.length > 0) {
    const placeholders = rawQueryFeatures.map(() => "?").join(",");
    const counts = db.prepare(
      `SELECT feature_hash, document_count
       FROM memory_retrieval_unit_feature_stats
       WHERE tenant_id = ? AND feature_hash IN (${placeholders})`
    ).all(tenantId, ...rawQueryFeatures.map((feature) => feature.feature_hash));
    const countByHash = new Map(counts.map((row) => [row.feature_hash, Number(row.document_count)]));
    queryFeatures = rawQueryFeatures
      .filter((feature) => countByHash.has(feature.feature_hash))
      .sort(
        (left, right) =>
          (countByHash.get(left.feature_hash) ?? Infinity) -
          (countByHash.get(right.feature_hash) ?? Infinity)
      )
      .slice(0, 12);
  }
  const semanticRows = queryFeatures.length === 0
    ? []
    : db.prepare(
      `WITH query_features(feature_hash, query_weight) AS (
         VALUES ${queryFeatures.map(() => "(?, ?)").join(",")}
       )
       SELECT f.unit_id AS unitId,
              SUM(f.weight * q.query_weight) AS score
       FROM query_features q
       CROSS JOIN memory_retrieval_unit_features f INDEXED BY idx_retrieval_unit_feature_lookup
         ON f.feature_hash = q.feature_hash
       JOIN memory_retrieval_units u
         ON u.id = f.unit_id
        AND u.tenant_id = f.tenant_id
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE f.tenant_id = ?
         AND (m.expires_at IS NULL OR m.expires_at > ?)
       GROUP BY f.unit_id
       ORDER BY score DESC, u.content_hash, u.unit_type,
                COALESCE(u.event_at, u.created_at), u.text
       LIMIT ?`
    ).all(
      ...queryFeatures.flatMap((feature) => [feature.feature_hash, feature.weight]),
      tenantId,
      at,
      candidateLimit
    ).map((row) => ({ unitId: row.unitId, score: Number(row.score) }));
  const unitById = new Map(lexicalRows.map((row) => [row.id, row]));
  for (const row of subjectLexicalRows) unitById.set(row.id, row);
  for (const row of temporalLexicalRows) unitById.set(row.id, row);
  for (const row of temporalRelevanceRows) unitById.set(row.id, row);
  for (const row of temporalRows) unitById.set(row.id, row);
  for (const row of intentRows) unitById.set(row.id, row);
  const missingUnitIds = semanticRows.map((row) => row.unitId).filter((id) => !unitById.has(id));
  if (missingUnitIds.length > 0) {
    const placeholders = missingUnitIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT u.*
       FROM memory_retrieval_units u
       JOIN memories m ON m.id = u.memory_id AND m.tenant_id = u.tenant_id
       WHERE u.tenant_id = ? AND u.id IN (${placeholders})
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
         AND (m.expires_at IS NULL OR m.expires_at > ?)`
    ).all(
      tenantId,
      ...missingUnitIds,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      at
    );
    for (const row of rows) unitById.set(row.id, row);
  }

  const localSemanticRrfWeight = intent.speaker === "assistant" ? 0.6 : 0.35;
  const fusedByUnit = new Map();
  lexicalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  subjectLexicalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 1.25 / (60 + index + 1));
  });
  temporalLexicalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  temporalRelevanceRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 1 / (60 + index + 1));
  });
  semanticRows.forEach((row, index) => {
    if (!unitById.has(row.unitId)) return;
    fusedByUnit.set(
      row.unitId,
      (fusedByUnit.get(row.unitId) ?? 0) + localSemanticRrfWeight / (60 + index + 1)
    );
  });
  temporalRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 0.75 / (60 + index + 1));
  });
  intentRows.forEach((row, index) => {
    fusedByUnit.set(row.id, (fusedByUnit.get(row.id) ?? 0) + 0.8 / (60 + index + 1));
  });
  const lexicalSpecificity = retrievalUnitLexicalSpecificity([...unitById.values()], query);
  const parentScores = new Map();
  for (const [unitId, baseScore] of fusedByUnit) {
    const unit = unitById.get(unitId);
    if (!unit) continue;
    const current = parentScores.get(unit.memory_id) ?? [];
    current.push({
      unit,
      score: baseScore,
      intentBoost: retrievalUnitIntentBoost(unit, intent),
      lexicalSpecificity: lexicalSpecificity.get(unitId) ?? 0
    });
    parentScores.set(unit.memory_id, current);
  }
  if (parentScores.size === 0) return [];

  const parentIds = [...parentScores.keys()];
  const placeholders = parentIds.map(() => "?").join(",");
  const memories = db.prepare(
    `SELECT * FROM memories WHERE tenant_id = ? AND id IN (${placeholders})`
  ).all(tenantId, ...parentIds);
  const memoryById = new Map(memories.map((row) => [row.id, row]));
  const dated = [...parentScores.entries()].map(([memoryId, units]) => ({
    memoryId,
    eventAt: Math.max(...units.map((entry) => Number(entry.unit.event_at ?? 0)))
  }));
  const minEventAt = Math.min(...dated.map((entry) => entry.eventAt).filter((value) => value > 0));
  const maxEventAt = Math.max(...dated.map((entry) => entry.eventAt));
  const eventRange = Math.max(1, maxEventAt - (Number.isFinite(minEventAt) ? minEventAt : maxEventAt));
  const relativeDistances = relativeTargetAt === null
    ? []
    : dated
      .map((entry) => Math.abs(entry.eventAt - relativeTargetAt))
      .filter(Number.isFinite);
  const minRelativeDistance = relativeDistances.length > 0 ? Math.min(...relativeDistances) : 0;
  const maxRelativeDistance = relativeDistances.length > 0 ? Math.max(...relativeDistances) : 0;
  const relativeDistanceRange = Math.max(1, maxRelativeDistance - minRelativeDistance);

  const ranked = [...parentScores.entries()]
    .flatMap(([memoryId, unitScores]) => {
      const row = memoryById.get(memoryId);
      if (!row) return [];
      const memory = memoryFromRow(row);
      if (!canReadMemory(memory, principalId)) return [];
      const sorted = unitScores.sort((left, right) => right.score - left.score);
      let total = (sorted[0]?.score ?? 0) + (sorted[1]?.score ?? 0) * 0.25 + (sorted[2]?.score ?? 0) * 0.1;
      total += Math.max(0, ...sorted.map((entry) => entry.intentBoost));
      total += Math.max(0, ...sorted.map((entry) => entry.lexicalSpecificity)) * 0.02;
      const eventAt = Math.max(...sorted.map((entry) => Number(entry.unit.event_at ?? 0)));
      if (relativeTargetAt !== null && eventAt > 0) {
        const distance = Math.abs(eventAt - relativeTargetAt);
        total += (1 - (distance - minRelativeDistance) / relativeDistanceRange) * 0.02;
      } else if (intent.temporal_direction && eventAt > 0 && Number.isFinite(minEventAt)) {
        const relative = (eventAt - minEventAt) / eventRange;
        total += intent.temporal_direction === "latest" ? relative * 0.006 : (1 - relative) * 0.006;
      }
      return [{
        memory,
        score: {
          total: Number(total.toFixed(6)),
          lexical:
            lexicalRows.some((unit) => unit.memory_id === memoryId) ||
            subjectLexicalRows.some((unit) => unit.memory_id === memoryId)
              ? 1
              : 0,
          semantic: semanticRows.some((unit) => unitById.get(unit.unitId)?.memory_id === memoryId) ? 1 : 0,
          graph: 0,
          time: intent.temporal_direction || relativeTargetAt !== null ? 1 : 0,
          authority: Number(memory.confidence_score ?? 0.5),
          utility: Number(memory.utility_score ?? 0.5)
        }
      }];
    })
    .sort(
      (left, right) =>
        right.score.total - left.score.total ||
        right.memory.updated_at - left.memory.updated_at ||
        String(left.memory.source_references[0]?.ref ?? "").localeCompare(
          String(right.memory.source_references[0]?.ref ?? "")
        )
    )
    .filter((entry) => minimumTotalScore === null || entry.score.total >= minimumTotalScore);
  const selected = ranked.slice(0, limit);
  if (relativeTargetAt !== null) {
    const reservedMemoryIds = [...new Set(
      [
        ...temporalLexicalRows.slice(0, 2).map((row) => row.memory_id),
        ...temporalRelevanceRows.slice(0, 2).map((row) => row.memory_id),
        ...temporalRows.map((row) => row.memory_id)
      ]
    )].slice(0, 4);
    let replacementIndex = selected.length - 1;
    for (const memoryId of reservedMemoryIds) {
      if (selected.some((entry) => entry.memory.id === memoryId)) continue;
      const reserved = ranked.find((entry) => entry.memory.id === memoryId);
      if (!reserved) continue;
      selected.splice(Math.max(0, replacementIndex), 1, reserved);
      replacementIndex -= 1;
    }
    selected.sort(
      (left, right) =>
        right.score.total - left.score.total ||
        right.memory.updated_at - left.memory.updated_at ||
        String(left.memory.source_references[0]?.ref ?? "").localeCompare(
          String(right.memory.source_references[0]?.ref ?? "")
        )
    );
  }
  return selected;
}

function searchRetrievalUnitsV4(db, options) {
  const {
    tenantId,
    projectId,
    query,
    limit,
    minimumTotalScore,
    includeSuppressed,
    principalId,
    at,
    denseQueryVector = null,
    denseProvider = null,
    retrievalMetadata = null
  } = options;
  const intent = analyzeRetrievalIntent(query);
  const ftsQueries = buildFtsQueryVariants(query);
  if (ftsQueries.length === 0) throw new Error("search requires a query");
  const literalQuery = localTaskQueryPlan(query);
  let taskQuery = literalQuery;
  const taskEligible = (memory) => canReadMemory(memory, principalId)
    && (includeSuppressed || memory.lifecycle_state !== "suppressed")
    && (memory.valid_from == null || memory.valid_from <= at)
    && (memory.valid_until == null || memory.valid_until > at)
    && (memory.expires_at == null || memory.expires_at > at)
    && (options.workType == null || memory.work_type === options.workType || memory.work_type === "other")
    && (options.businessCategoryId == null || memory.business_category_id === options.businessCategoryId);
  const baseCandidates = searchRetrievalUnitsV3(db, { ...options, limit: 50, minimumTotalScore: null });
  const exactFtsQuery = buildFtsQuery(query, "AND");
  const exactStatement = db.prepare(
      `SELECT m.*, m.id AS memory_id, bm25(memories_fts) AS raw_rank
       FROM memories_fts
       JOIN memories m
         ON m.id = memories_fts.memory_id
        AND m.tenant_id = memories_fts.tenant_id
       WHERE memories_fts.tenant_id = ?
         AND memories_fts MATCH ?
         AND (? IS NULL OR m.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (m.valid_from IS NULL OR m.valid_from <= ?)
         AND (m.valid_until IS NULL OR m.valid_until > ?)
         AND (m.expires_at IS NULL OR m.expires_at > ?)
       ORDER BY bm25(memories_fts), m.content_hash
       LIMIT 50`
    );
  const loadExactRows = (ftsQuery) => ftsQuery ? exactStatement.all(
      tenantId,
      ftsQuery,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      at
    )
    : [];
  const exactRows = loadExactRows(exactFtsQuery);
  const exactIds = new Set(exactRows.map((row) => row.memory_id));
  // Separate all-subject lane. Explicit repeated questions may use distinct
  // records, but every question must have a fully matching accessible candidate.
  let taskRows = taskQuery ? loadExactRows(taskQuery.fts).filter((row) => {
    if (exactIds.has(row.memory_id)) return false;
    const memory = memoryFromRow(row);
    return taskEligible(memory) && matchesLocalTaskQuery(memory, taskQuery);
  }) : [];
  if (taskQuery?.clauses.length > 1) {
    const eligible = (memory) => taskEligible(memory) && !memory.conflicts?.length;
    const candidates = [...baseCandidates.map((entry) => entry.memory),
      ...taskRows.map(memoryFromRow), ...exactRows.map(memoryFromRow)].filter(eligible);
    if (!coversLocalTaskQuery(candidates, taskQuery)) {
      taskQuery = null;
      taskRows = [];
    }
  }
  // Partial/intent-only candidates retain the v3 floor, even in low-floor hooks.
  // Qualified task subjects still must meet the unchanged final score threshold.
  const base = baseCandidates.filter((entry) => minimumTotalScore === null
    || entry.score.total >= minimumTotalScore
    || (taskEligible(entry.memory) && matchesLocalTaskQuery(entry.memory, taskQuery)));
  const taskIds = new Set(taskRows.map((row) => row.memory_id));
  const channel = (unitTypes, channelLimit = 50, queryVariants = ftsQueries) => {
    const placeholders = unitTypes.map(() => "?").join(",");
    return runFtsCandidates(queryVariants, (ftsQuery) =>
      db.prepare(
        `SELECT u.memory_id, u.id AS unit_id, u.unit_type, u.event_at,
                u.metadata_json, bm25(memory_retrieval_units_v4_fts) AS raw_rank
         FROM memory_retrieval_units_v4_fts
         JOIN memory_retrieval_units_v4 u
           ON u.id = memory_retrieval_units_v4_fts.unit_id
          AND u.tenant_id = memory_retrieval_units_v4_fts.tenant_id
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE memory_retrieval_units_v4_fts.tenant_id = ?
           AND memory_retrieval_units_v4_fts MATCH ?
           AND u.unit_type IN (${placeholders})
           AND (? IS NULL OR u.project_id = ?)
           AND (? = 1 OR m.lifecycle_state != 'suppressed')
           AND (u.valid_from IS NULL OR u.valid_from <= ?)
           AND (u.valid_until IS NULL OR u.valid_until > ?)
           AND (m.expires_at IS NULL OR m.expires_at > ?)
         ORDER BY bm25(memory_retrieval_units_v4_fts), u.content_hash
         LIMIT ?`
      ).all(
        tenantId,
        ftsQuery,
        ...unitTypes,
        projectId,
        projectId,
        includeSuppressed ? 1 : 0,
        at,
        at,
        at,
        channelLimit
      )
    );
  };
  const strictFtsQueries = ftsQueries.slice(0, 1);
  let lexicalRows = channel(["atomic"], 50, strictFtsQueries);
  let profileRows = channel(["profile", "ledger"], 50, strictFtsQueries);
  let timelineRows = channel(["timeline"], 50, strictFtsQueries);
  let segmentRows = channel(["segment"], 24, strictFtsQueries);
  if (
    ftsQueries.length > strictFtsQueries.length &&
    [lexicalRows, profileRows, timelineRows, segmentRows].every((rows) => rows.length === 0)
  ) {
    lexicalRows = channel(["atomic"], 50);
    profileRows = channel(["profile", "ledger"], 50);
    timelineRows = channel(["timeline"], 50);
    segmentRows = channel(["segment"], 24);
  }
  const queryFeatures = embedLocalText(query).slice(0, 24);
  const segmentMemoryIds = [...new Set(segmentRows.map((row) => row.memory_id))];
  const sparseRows = queryFeatures.length === 0
    ? []
    : db.prepare(
      `WITH query_features(feature_hash, query_weight) AS (
         VALUES ${queryFeatures.map(() => "(?, ?)").join(",")}
       )
       SELECT u.memory_id, SUM(f.weight * q.query_weight) AS sparse_score
       FROM memory_retrieval_unit_features_v4 f
       JOIN query_features q ON q.feature_hash = f.feature_hash
       JOIN memory_retrieval_units_v4 u
         ON u.id = f.unit_id
        AND u.tenant_id = f.tenant_id
       JOIN memories m
         ON m.id = u.memory_id
        AND m.tenant_id = u.tenant_id
       WHERE f.tenant_id = ?
         AND (? IS NULL OR u.project_id = ?)
         AND (? = 1 OR m.lifecycle_state != 'suppressed')
         AND (u.valid_from IS NULL OR u.valid_from <= ?)
         AND (u.valid_until IS NULL OR u.valid_until > ?)
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         ${segmentMemoryIds.length > 0
           ? `AND u.memory_id IN (${segmentMemoryIds.map(() => "?").join(",")})`
           : ""}
       GROUP BY u.memory_id
       ORDER BY sparse_score DESC, u.memory_id
       LIMIT 50`
    ).all(
      ...queryFeatures.flatMap((feature) => [feature.feature_hash, feature.weight]),
      tenantId,
      projectId,
      projectId,
      includeSuppressed ? 1 : 0,
      at,
      at,
      at,
      ...segmentMemoryIds
    );
  const denseRows = !denseQueryVector || !denseProvider
    ? []
    : (() => {
      const rows = db.prepare(
        `SELECT m.*, u.memory_id, e.unit_id, e.feature_count, e.vector_blob
         FROM memory_retrieval_unit_embeddings_v4 e
         JOIN memory_retrieval_units_v4 u
           ON u.id = e.unit_id
          AND u.tenant_id = e.tenant_id
         JOIN memories m
           ON m.id = u.memory_id
          AND m.tenant_id = u.tenant_id
         WHERE e.tenant_id = ?
           AND e.provider = ?
           AND e.feature_count = ?
           AND e.vector_format = 'dense-f32'
           AND e.vector_blob IS NOT NULL
           AND u.unit_type = 'segment'
           AND (? IS NULL OR u.project_id = ?)
           AND (? = 1 OR m.lifecycle_state != 'suppressed')
           AND (u.valid_from IS NULL OR u.valid_from <= ?)
           AND (u.valid_until IS NULL OR u.valid_until > ?)
           AND (m.expires_at IS NULL OR m.expires_at > ?)`
      ).all(
        tenantId,
        denseProvider,
        denseQueryVector.length,
        projectId,
        projectId,
        includeSuppressed ? 1 : 0,
        at,
        at,
        at
      ).filter((row) => taskEligible(memoryFromRow(row)));
      if (retrievalMetadata) retrievalMetadata.dense_scored_unit_count = rows.length;
      const bestByMemory = new Map();
      for (const row of rows) {
        const vector = decodeFloat32Vector(row.vector_blob, Number(row.feature_count));
        const score = cosineSimilarity(denseQueryVector, vector);
        const current = bestByMemory.get(row.memory_id);
        if (!current || score > current.dense_score) {
          bestByMemory.set(row.memory_id, { memory_id: row.memory_id, dense_score: score });
        }
      }
      return [...bestByMemory.values()]
        .sort((left, right) => right.dense_score - left.dense_score || left.memory_id.localeCompare(right.memory_id))
        .slice(0, 50);
    })();
  if (retrievalMetadata) retrievalMetadata.dense_candidate_count = denseRows.length;
  const scores = new Map();
  const addRrf = (rows, weight) => {
    rows.forEach((row, index) => {
      const memoryId = row.memory_id ?? row.memory?.id;
      if (!memoryId) return;
      scores.set(memoryId, (scores.get(memoryId) ?? 0) + weight / (60 + index + 1));
    });
  };
  addRrf(base, 1);
  addRrf(exactRows, 3);
  // Fully covered subject candidates share the existing 50-candidate bound.
  addRrf(taskRows, 1);
  addRrf(sparseRows, 0.9);
  addRrf(denseRows, 1.2);
  addRrf(segmentRows, 0.65);
  for (const row of denseRows) {
    const normalized = Math.max(0, Math.min(1, (row.dense_score + 1) / 2));
    scores.set(row.memory_id, (scores.get(row.memory_id) ?? 0) + normalized * 0.5);
  }
  const structuralScores = new Map();
  const addStructuralRrf = (rows, weight) => {
    rows.forEach((row, index) => {
      const contribution = weight / (60 + index + 1);
      structuralScores.set(
        row.memory_id,
        Math.max(structuralScores.get(row.memory_id) ?? 0, contribution)
      );
    });
  };
  addStructuralRrf(lexicalRows, 1.2);
  if (intent.unit_types.some((type) =>
    ["preference", "instruction", "update", "fact"].includes(type)
  )) {
    addStructuralRrf(profileRows, 1.35);
  }
  if (intent.temporal_direction || intent.relative_age_ms !== null || intent.relative_weekday !== null) {
    addStructuralRrf(timelineRows, 1.35);
  }
  for (const [memoryId, contribution] of structuralScores) {
    scores.set(memoryId, (scores.get(memoryId) ?? 0) + contribution);
  }

  const baseById = new Map(base.map((entry) => [entry.memory.id, {
    ...entry,
    score: { ...entry.score, authority: memoryAuthority(entry.memory) }
  }]));
  const candidateIds = [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 50)
    .map(([id]) => id);
  const missingIds = candidateIds.filter((id) => !baseById.has(id));
  if (missingIds.length > 0) {
    const placeholders = missingIds.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT * FROM memories WHERE tenant_id = ? AND id IN (${placeholders})`
    ).all(tenantId, ...missingIds);
    for (const row of rows) {
      const memory = memoryFromRow(row);
      if (!memory || !canReadMemory(memory, principalId)) continue;
      baseById.set(memory.id, {
        memory,
        score: {
          total: 0,
          lexical: 0,
          semantic: 0,
          graph: 0,
          time: 0,
          authority: memoryAuthority(memory),
          utility: Number(memory.utility_score ?? 0.5)
        }
      });
    }
  }
  // SQLite unicode61 can join Japanese particles to adjacent ASCII words,
  // so FTS prefix matching misses API in "稼働中APIの応答". Restore the exact
  // channel only when every subject term occurs in an already bounded candidate.
  const cjkTerms = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query)
    ? retrievalSubjectQueryTokens(query).slice(0, 16) : [];
  const ranked = candidateIds.flatMap((id, index) => {
    const entry = baseById.get(id);
    if (!entry || !matchesLocalTaskQueryLiterals(entry.memory, literalQuery)) return [];
    let total = scores.get(id) ?? 0;
    const taskMatch = !exactIds.has(id) && taskEligible(entry.memory)
      && (taskIds.has(id) || matchesLocalTaskQuery(entry.memory, taskQuery));
    if (!exactIds.has(id) && taskMatch) {
      total += 3 / (60 + index + 1);
    } else if (cjkTerms.length >= 2 && !exactIds.has(id)) {
      const text = [entry.memory.content, entry.memory.summary, entry.memory.rationale, entry.memory.reuse_rule]
        .filter(Boolean).join("\n").normalize("NFKC").toLowerCase();
      if (cjkTerms.every((term) => text.includes(term))) total += 3 / (60 + index + 1);
    }
    const denseMatch = denseRows.find((row) => row.memory_id === id);
    if (minimumTotalScore !== null && total < minimumTotalScore) return [];
    return [{
      memory: entry.memory,
      score: {
        ...entry.score,
        total: Number(total.toFixed(6)),
        lexical: taskMatch || lexicalRows.some((row) => row.memory_id === id) ? 1 : entry.score.lexical,
        semantic: denseMatch
          ? Number(Math.max(0, Math.min(1, (denseMatch.dense_score + 1) / 2)).toFixed(6))
          : sparseRows.some((row) => row.memory_id === id)
            ? 1
            : entry.score.semantic,
        time: timelineRows.some((row) => row.memory_id === id) ? 1 : entry.score.time
      }
    }];
  }).sort((left, right) => {
    const relevanceDelta = right.score.total - left.score.total;
    if (Math.abs(relevanceDelta) > 0.002) return relevanceDelta;
    return right.score.authority - left.score.authority ||
      relevanceDelta ||
      left.memory.id.localeCompare(right.memory.id);
  });

  const multiEvidence = requiresMultipleEvidenceSources(query);
  if (!multiEvidence) return ranked.slice(0, limit);
  const selected = [];
  const sources = new Set();
  for (const entry of ranked) {
    const source = String(entry.memory.source_references[0]?.ref ?? entry.memory.id);
    if (selected.length < Math.min(3, limit) && sources.has(source)) continue;
    selected.push(entry);
    sources.add(source);
    if (selected.length === limit) break;
  }
  for (const entry of ranked) {
    if (selected.length === limit) break;
    if (!selected.some((item) => item.memory.id === entry.memory.id)) selected.push(entry);
  }
  return selected;
}

export async function search(input, dependencies) {
    const { openDb } = dependencies;
    const db = openDb();
    try {
      const flags = localUseFlags(db);
      const query = input.query ?? input.q;
      const historical = input.include_history === true || input.include_suppressed === true;
      const enabled = (flags.context || flags.ranking) && !historical;
      const limit = Math.max(1, Math.min(100, Number(input.limit) || 10));
      const ftsQuery = buildFtsQuery(query, "OR");
      const at = input.at ?? Date.now();
      let shared = [];
      let sharedSearch = "complete";
      try {
        if (ftsQuery) shared = db.prepare(`
          SELECT m.* FROM all_memories_fts CROSS JOIN memories m ON m.rowid = all_memories_fts.rowid
          WHERE all_memories_fts MATCH ? AND m.tenant_id = 'all' AND m.project_id IS NULL
            AND m.scope_type IN ('tenant','org') AND COALESCE(m.permissions_json,'[]') = '[]'
            AND m.deleted_at IS NULL AND m.lifecycle_state = 'active'
            AND COALESCE(m.verification_state,'unverified') != 'rejected'
            AND (m.valid_from IS NULL OR m.valid_from <= ?) AND (m.valid_until IS NULL OR m.valid_until > ?)
            AND (m.expires_at IS NULL OR m.expires_at > ?)
            AND (? IS NULL OR m.business_category_id = ?) AND (? IS NULL OR m.work_type IN (?, 'other'))
            AND COALESCE(m.tags_json,'[]') NOT LIKE '%"source-drift"%'
            AND COALESCE(m.tags_json,'[]') NOT LIKE '%"compacted"%'
            AND COALESCE(m.conflicts_json,'[]') NOT LIKE '%source_drift%'
          AND rank MATCH 'bm25(2,1)'
          ORDER BY rank LIMIT ?
        `).all(ftsQuery, at, at, at, input.business_category_id ?? null, input.business_category_id ?? null,
          input.work_type ?? null, input.work_type ?? null, limit).map((row, index) => ({
          memory: memoryFromRow(row), score: { lexical: 1 / (index + 1), total: 1 / (index + 1) }
        })).filter(({score}) => input.minimum_total_score == null || score.total >= input.minimum_total_score);
      } catch { sharedSearch = "incomplete"; }
      const finish = (ordinary) => {
        if (input.retrieval_metadata) input.retrieval_metadata.shared_search = sharedSearch;
        if (!shared.length) return ordinary;
        const merged = [];
        for (let index = 0; merged.length < limit && (index < ordinary.length || index < shared.length); index++) {
          if (ordinary[index]) merged.push(ordinary[index]);
          if (merged.length < limit && shared[index]) merged.push(shared[index]);
        }
        return merged;
      };
      if (input.tenant_id === "all") return finish([]);
      const baseInput = { ...input, query, limit: enabled ? 50 : input.limit };
      let base = await searchBase(baseInput, dependencies);
      const alias = !historical && input.project_id ? localAliasQuery(query) : null;
      const originalPlan = alias && localTaskQueryPlan(query);
      const aliasPlan = originalPlan && localTaskQueryPlan(alias);
      if (aliasPlan) {
        const applicable = (memory, plan) => memory.project_id === input.project_id && memory.lifecycle_state === "active"
          && (memory.expires_at == null || memory.expires_at > at) && memory.verification_state !== "rejected"
          && (!memory.permissions.length || Boolean(input.principal_id)) && matchesLocalTaskQuery(memory, plan);
        if (!base.some(({ memory }) => applicable(memory, originalPlan))) {
          if (input.retrieval_metadata) input.retrieval_metadata.alias_retry = true;
          const alternative = await searchBase({ ...baseInput, query: alias, retrieval_metadata: null },
            { ...dependencies, denseEmbeddingProvider: null });
          const matching = alternative.filter(({ memory }) => applicable(memory, aliasPlan));
          if (matching.length) {
            const alreadyAdded = new Set(matching.map(({ memory }) => memory.id));
            base = [...matching, ...base.filter(({ memory }) => !alreadyAdded.has(memory.id))]
              .slice(0, enabled ? 50 : limit);
          }
        }
      }
      const explainIntegrity = (results) => results.map((item) => {
        const row = db.prepare(`SELECT 1 FROM memory_integrity_relations r
          JOIN memories a ON a.tenant_id=r.tenant_id AND a.id=r.from_memory_id
          JOIN memories b ON b.tenant_id=r.tenant_id AND b.id=r.to_memory_id
          WHERE r.tenant_id=? AND r.status='confirmed' AND r.relation='contradicts'
            AND a.current_version=r.from_version AND b.current_version=r.to_version
            AND ((r.from_memory_id=? AND r.from_version=?) OR (r.to_memory_id=? AND r.to_version=?)) LIMIT 1`)
          .get(input.tenant_id || "default", item.memory.id, item.memory.current_version,
            item.memory.id, item.memory.current_version);
        return row ? { ...item, integrity_warnings: ["unresolved_contradiction"] } : item;
      });
      if (!enabled) return finish(explainIntegrity(base));
      const service = localUseService(db, input.tenant_id || "default", input.principal_id || process.env.ORGBRAIN_USE_PRINCIPAL || "local", () => input.at ?? Date.now(), input);
      const result = await service.search({query,project_id:input.project_id,work_type:input.work_type,task_id:input.task_id,
        context:input.use_context,snapshot_id:input.use_snapshot_id,context_enabled:flags.context,ranking_enabled:flags.ranking,limit:input.limit || 10,at:input.at,
        base:base.map(x=>({id:x.memory.id,kind:"memory",memory_kind:x.memory.kind,current_version:x.memory.current_version,score:x.score.total}))});
      return finish(explainIntegrity(result.results.flatMap(row=>{
        const original = base.find(x=>x.memory.id===row.id);
        const memory = original?.memory ?? (()=>{const raw=db.prepare("SELECT * FROM memories WHERE tenant_id=? AND id=?").get(input.tenant_id || "default",row.id);return raw?memoryFromRow(raw):null;})();
        if (input.minimum_total_score != null && row.score < Number(input.minimum_total_score)) return [];
        if (!memory || (input.business_category_id && memory.business_category_id !== input.business_category_id)) return [];
        return [{memory,score:{...(original?.score??{}),total:row.score},use_history:row.use_history,use_history_meta:result.meta}];
      })));
    } finally { db.close(); }
  }

export async function searchBase({
    tenant_id: tenantId,
    project_id: projectId = null,
    business_category_id: businessCategoryId = null,
    work_type: workType = null,
    query,
    limit = 10,
    minimum_total_score: minimumTotalScoreInput = null,
    include_suppressed = false,
    principal_id: principalId = null,
    search_mode: searchMode = "hybrid_v4",
    retrieval_metadata: retrievalMetadata = null,
    query_embedding_timeout_ms: queryEmbeddingTimeoutMs = null,
    at = Date.now()
  }, dependencies) {
    const { openDb, denseEmbeddingProvider } = dependencies;
    if (searchMode === "hybrid_v3" || searchMode === "hybrid_v4") {
      // The dense lane is an addition to lexical retrieval. An unavailable or
      // slow embedding service degrades this search; it must not fail it.
      let denseQueryVector = null, embeddingFailure = null;
      if (searchMode === "hybrid_v4" && denseEmbeddingProvider) {
        try {
          denseQueryVector = await denseEmbeddingProvider.embedQuery(query,
            Number(queryEmbeddingTimeoutMs) > 0 ? { timeoutMs: Number(queryEmbeddingTimeoutMs) } : {});
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          embeddingFailure = /^local_embedding_[a-z0-9_]{1,80}$/u.test(message) ? message : "local_embedding_failed";
        }
      }
      if (retrievalMetadata) Object.assign(retrievalMetadata, {
        ...(embeddingFailure ? { degraded_reasons: [...new Set([...(retrievalMetadata.degraded_reasons ?? []), embeddingFailure])] } : {}),
        search_mode: searchMode,
        dense_provider: denseQueryVector ? denseEmbeddingProvider.provider : null,
        dimensions: denseQueryVector?.length ?? null,
        query_embedding_completed: Boolean(denseQueryVector),
        dense_scored_unit_count: 0,
        dense_candidate_count: 0
      });
      const db = openDb({ readOnly: true });
      try {
        const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
        const parsedMinimumTotalScore =
          minimumTotalScoreInput === null || minimumTotalScoreInput === undefined
            ? null
            : Number(minimumTotalScoreInput);
        if (
          parsedMinimumTotalScore !== null &&
          (!Number.isFinite(parsedMinimumTotalScore) || parsedMinimumTotalScore < 0)
        ) {
          throw new Error("minimum_total_score must be a non-negative finite number");
        }
        const results = (searchMode === "hybrid_v4" ? searchRetrievalUnitsV4 : searchRetrievalUnitsV3)(db, {
          tenantId,
          projectId,
          query,
          limit: safeLimit,
          minimumTotalScore: parsedMinimumTotalScore,
          workType,
          businessCategoryId,
          includeSuppressed: include_suppressed,
          principalId,
          at,
          denseQueryVector,
          denseProvider: denseEmbeddingProvider?.provider ?? null,
          retrievalMetadata
        });
        return results.filter(({ memory }) =>
          (businessCategoryId === null || memory.business_category_id === businessCategoryId) &&
          (workType === null || memory.work_type === workType || memory.work_type === "other")
        );
      } finally {
        db.close();
      }
    }
    const ftsQuery = buildFtsQuery(query, "AND");
    if (!ftsQuery) throw new Error("search requires a query");
    const db = openDb({ readOnly: true });
    try {
      const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
      const statement = db.prepare(
        `SELECT m.*, bm25(memories_fts) AS raw_rank
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.memory_id AND m.tenant_id = memories_fts.tenant_id
         WHERE memories_fts.tenant_id = ?
           AND memories_fts MATCH ?
           AND (? IS NULL OR m.project_id = ?)
           AND (? = 1 OR m.lifecycle_state != 'suppressed')
           AND (m.valid_from IS NULL OR m.valid_from <= ?)
           AND (m.valid_until IS NULL OR m.valid_until > ?)
         ORDER BY bm25(memories_fts) ASC, m.updated_at DESC
         LIMIT ?`
      );
      let lexicalRows = statement.all(
        tenantId,
        ftsQuery,
        projectId,
        projectId,
        include_suppressed ? 1 : 0,
        at,
        at,
        safeLimit * 5
      );
      if (lexicalRows.length === 0) {
        lexicalRows = statement.all(
          tenantId,
          buildFtsQuery(query, "OR"),
          projectId,
          projectId,
          include_suppressed ? 1 : 0,
          at,
          at,
          safeLimit * 5
        );
      }
      const rawQueryFeatures = embedLocalText(query);
      let queryFeatures = rawQueryFeatures;
      if (rawQueryFeatures.length > 0) {
        const placeholders = rawQueryFeatures.map(() => "?").join(",");
        const featureCounts = db.prepare(
          `SELECT feature_hash, document_count AS matches
           FROM memory_embedding_feature_stats
           WHERE tenant_id = ? AND feature_hash IN (${placeholders})
           ORDER BY document_count ASC
           LIMIT 8`
        ).all(tenantId, ...rawQueryFeatures.map((feature) => feature.feature_hash));
        const countByHash = new Map(
          featureCounts.map((row) => [row.feature_hash, Number(row.matches)])
        );
        const minimumCount = Math.min(...countByHash.values());
        const maximumUsefulCount = minimumCount * 4;
        queryFeatures = rawQueryFeatures
          .filter((feature) => (countByHash.get(feature.feature_hash) ?? Infinity) <= maximumUsefulCount)
          .sort(
            (left, right) =>
              (countByHash.get(left.feature_hash) ?? Infinity) -
              (countByHash.get(right.feature_hash) ?? Infinity)
          )
          .slice(0, 4);
      }
      let semanticRows = [];
      if (queryFeatures.length > 0) {
        const semanticScores = new Map();
        const featureLookup = db.prepare(
          `SELECT memory_id, weight
           FROM memory_embedding_features
           WHERE tenant_id = ? AND feature_hash = ?
           LIMIT ?`
        );
        for (const feature of queryFeatures) {
          const matches = featureLookup.all(tenantId, feature.feature_hash, safeLimit * 20);
          for (const match of matches) {
            semanticScores.set(
              match.memory_id,
              (semanticScores.get(match.memory_id) ?? 0) + Number(match.weight) * feature.weight
            );
          }
        }
        semanticRows = [...semanticScores.entries()]
          .map(([memory_id, semantic_score]) => ({ memory_id, semantic_score }))
          .sort((left, right) => right.semantic_score - left.semantic_score)
          .slice(0, safeLimit * 5);
      }
      const lexicalById = new Map(
        lexicalRows.map((row) => [
          row.id,
          0.5 + 0.5 * Math.max(0, 1 / (1 + Math.abs(Number(row.raw_rank || 0))))
        ])
      );
      const semanticById = new Map(
        semanticRows.map((row) => [row.memory_id, Math.max(0, Math.min(1, Number(row.semantic_score || 0)))])
      );
      const candidateIds = [...new Set([
        ...lexicalRows.map((row) => row.id),
        ...semanticRows.map((row) => row.memory_id)
      ])];
      if (candidateIds.length === 0) return [];
      const graphRaw = new Map();
      if (candidateIds.length > 0) {
        const placeholders = candidateIds.map(() => "?").join(",");
        const edges = db.prepare(
          `SELECT from_memory_id, to_memory_id
           FROM memory_edges
           WHERE tenant_id = ?
             AND (from_memory_id IN (${placeholders}) OR to_memory_id IN (${placeholders}))
           LIMIT ?`
        ).all(tenantId, ...candidateIds, ...candidateIds, safeLimit * 20);
        const seedIds = new Set(candidateIds);
        const candidateLookup = new Set(candidateIds);
        for (const edge of edges) {
          const fromSeed = seedIds.has(edge.from_memory_id);
          const toSeed = seedIds.has(edge.to_memory_id);
          if (fromSeed) {
            graphRaw.set(edge.to_memory_id, (graphRaw.get(edge.to_memory_id) ?? 0) + 1);
            if (!candidateLookup.has(edge.to_memory_id)) {
              candidateIds.push(edge.to_memory_id);
              candidateLookup.add(edge.to_memory_id);
            }
          }
          if (toSeed) {
            graphRaw.set(edge.from_memory_id, (graphRaw.get(edge.from_memory_id) ?? 0) + 1);
            if (!candidateLookup.has(edge.from_memory_id)) {
              candidateIds.push(edge.from_memory_id);
              candidateLookup.add(edge.from_memory_id);
            }
          }
        }
      }
      const maxGraph = Math.max(0, ...graphRaw.values());
      const rowsById = new Map(lexicalRows.map((row) => [row.id, row]));
      const missingIds = candidateIds.filter((id) => !rowsById.has(id));
      if (missingIds.length > 0) {
        const placeholders = missingIds.map(() => "?").join(",");
        const fetched = db.prepare(
          `SELECT * FROM memories
           WHERE tenant_id = ? AND id IN (${placeholders})`
        ).all(tenantId, ...missingIds);
        for (const row of fetched) rowsById.set(row.id, row);
      }
      return [...rowsById.values()]
        .filter((row) =>
          (projectId === null || row.project_id === projectId) &&
          (businessCategoryId === null || row.business_category_id === businessCategoryId) &&
          (workType === null || row.work_type === workType || row.work_type === "other") &&
          (include_suppressed || row.lifecycle_state !== "suppressed") &&
          (row.valid_from === null || row.valid_from <= at) &&
          (row.valid_until === null || row.valid_until > at)
        )
        .map((row) => {
        const lexical = lexicalById.get(row.id) ?? 0;
        const semantic = semanticById.get(row.id) ?? 0;
        const graph = maxGraph > 0 ? (graphRaw.get(row.id) ?? 0) / maxGraph : 0;
        const ageDays = Math.max(0, (at - row.updated_at) / 86_400_000);
        const time = 1 / (1 + ageDays / 30);
        const tags = parseJson(row.tags_json);
        const kindAuthority = ["decision", "constraint", "org_knowledge"].includes(row.kind)
          ? 1
          : row.kind === "fact" || row.kind === "episodic"
            ? 0.5
            : 0.75;
        const authority = Math.max(
          0,
          Math.min(
            1,
            Number(row.confidence_score ?? 0.5) * 0.7 +
              Math.max(kindAuthority, tags.includes("policy") ? 1 : 0) * 0.3
          )
        );
        const utility = Math.max(0, Math.min(1, Number(row.utility_score ?? 0.5)));
        const hasLexicalMatch = lexical > 0;
        const weights = hasLexicalMatch
          ? { lexical: 0.35, semantic: 0.05, graph: 0.1, time: 0.1, authority: 0.3, utility: 0.1 }
          : { lexical: 0, semantic: 0.45, graph: 0.15, time: 0.1, authority: 0.2, utility: 0.1 };
        return {
          memory: memoryFromRow(row),
          score: {
            total: Number(
              (
                lexical * weights.lexical +
                semantic * weights.semantic +
                graph * weights.graph +
                time * weights.time +
                authority * weights.authority +
                utility * weights.utility
              )
                .toFixed(6)
            ),
            lexical: Number(lexical.toFixed(6)),
            semantic: Number(semantic.toFixed(6)),
            graph: Number(graph.toFixed(6)),
            time: Number(time.toFixed(6)),
            authority: Number(authority.toFixed(6)),
            utility: Number(utility.toFixed(6))
          }
        };
      }).filter((result) => canReadMemory(result.memory, principalId))
        .sort((left, right) => right.score.total - left.score.total || right.memory.updated_at - left.memory.updated_at)
        .slice(0, safeLimit);
    } finally {
      db.close();
    }
  }

export async function selectMemorySearchResults(results, { tenant_id: tenantId, project_id: projectId = null,
    business_category_id: businessCategoryId = null, work_type: workType = null,
    principal_id: principalId = null, query, use_context: useContext = null, usage_purpose: usagePurpose = "unclassified",
    at: queryAt = null, apply_selection: applySelection = true, answer_ux_projection: answerUxProjection = false } = {}, dependencies) {
    const { getMemory, memoryJudge, relevanceSelector } = dependencies;
    const at = queryAt ?? Date.now();
    const hostPending = relevanceSelector?.provider === "working-llm" && !answerUxProjection;
    const eligible = (memory, currentAt) => (memory.tenant_id === tenantId || memory.tenant_id === "all" && isPublicLocalMemory(memory))
      && (!projectId || memory.project_id == null || memory.project_id === projectId)
      && memory.lifecycle_state === "active" && canReadMemory(memory, principalId)
      && (!hostPending || !memory.permissions.length || Boolean(principalId))
      && (!businessCategoryId || memory.business_category_id === businessCategoryId)
      && (!workType || memory.work_type === workType || memory.work_type === "other")
      && (memory.valid_from == null || memory.valid_from <= currentAt)
      && (memory.valid_until == null || memory.valid_until > currentAt)
      && (memory.expires_at == null || memory.expires_at > currentAt);
    let localRelevance = null;
    if (relevanceSelector || answerUxProjection) {
      const eligibleResults = [];
      for (const result of results) {
        const memory = await getMemory(result.memory.tenant_id === "all" ? "all" : tenantId, result.memory.id);
        if (memory && eligible(memory, queryAt ?? Date.now())) eligibleResults.push({...result,memory});
      }
      // Internal answer-friendly profile: keep its existing sanitized evidence
      // contract without exposing IDs/full bodies or invoking a relevance model.
      if (answerUxProjection) return {results:eligibleResults,memory_judgment:{mode:"off",applied:false,decisions:[]},
        local_relevance:{status:"answer_ux_projection",candidate_count:eligibleResults.length,kept_count:eligibleResults.length}};
      if (relevanceSelector.provider === "working-llm") {
        return {results:[],candidates:workingLlmCandidates(eligibleResults, eligibleResults.length, {tenant_id:tenantId,principal_id:principalId,project_id:projectId,business_category_id:businessCategoryId,work_type:workType}),
          memory_judgment:{mode:"off",applied:false}, local_relevance:{provider:"working-llm",status:"pending_host_selection",
            candidate_count:eligibleResults.length,returned_candidate_count:eligibleResults.length,scored_count:0,kept_count:0}};
      }
      const originals = new Map(eligibleResults.map(({memory}) => [memory.id, JSON.stringify(memoryJudgmentCandidate(memory))]));
      const selected = eligibleResults.length ? await relevanceSelector.select(query, eligibleResults)
        : {results:[],metadata:{status:"complete",candidate_count:0,scored_count:0,kept_count:0}};
      results = [];
      let changed = 0;
      for (const result of selected.results) {
        const memory = await getMemory(result.memory.tenant_id === "all" ? "all" : tenantId, result.memory.id);
        if (!memory || !eligible(memory, queryAt ?? Date.now())
          || JSON.stringify(memoryJudgmentCandidate(memory)) !== originals.get(result.memory.id)) { changed++; continue; }
        results.push({...result, memory});
      }
      localRelevance = {...selected.metadata, kept_count:results.length, source_changed_count:changed};
    }
    const candidates = results.filter(({ memory }) => eligible(memory, at)).map(({ memory }) => memoryJudgmentCandidate(memory));
    let judgment = await memoryJudge({ stage: "use",
      context: { tenant_id: tenantId, project_id: projectId, principal_id: principalId || "local", query, use_context: useContext }, candidates });
    if (judgment.mode !== "off") {
      const refreshed = [];
      let changed = false;
      for (const result of results) {
        const memory = await getMemory(result.memory.tenant_id === "all" ? "all" : tenantId, result.memory.id);
        if (!memory || !eligible(memory, queryAt ?? Date.now())) { changed = true; continue; }
        if (JSON.stringify(memoryJudgmentCandidate(memory)) !== JSON.stringify(memoryJudgmentCandidate(result.memory))) changed = true;
        refreshed.push({ ...result, memory });
      }
      results = refreshed;
      if (changed) judgment = { ...judgment, applied: false, status: "fallback", reason_code: "source_changed" };
    }
    if (["audit", "diagnostic", "test"].includes(usagePurpose)) judgment = { ...judgment, applied: false };
    if (applySelection && judgment.applied) {
      const byId = new Map(judgment.decisions.map((decision) => [decision.id, decision]));
      results = results.filter(({ memory }) => {
        const candidate = memoryJudgmentCandidate(memory);
        return candidate.protected_reasons.length || candidate.conflicts.length
          || byId.get(memory.id)?.action !== "omit";
      });
    }
    return { results, memory_judgment: judgment, local_relevance: localRelevance };
  }

