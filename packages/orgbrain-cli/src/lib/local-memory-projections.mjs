import { embedLocalText, LOCAL_EMBEDDING_PROVIDER, localEmbeddingText } from "./local-embedding.mjs";
import { buildRetrievalUnits, buildRetrievalUnitsV4, buildVerifiedLearningRetrievalUnits } from "./retrieval-units.mjs";
import { json, memoryFromRow } from "./local-memory-record.mjs";

/** @param {import("node:sqlite").DatabaseSync} db */
export function rebuildFts(db) {
  db.exec("DROP TABLE IF EXISTS memories_fts");
  db.exec(`
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      memory_id UNINDEXED,
      tenant_id UNINDEXED,
      content,
      summary,
      tags,
      entities,
      tokenize = 'unicode61'
    )
  `);
  db.exec(`
    INSERT INTO memories_fts(memory_id, tenant_id, content, summary, tags, entities)
    SELECT id, tenant_id, content, COALESCE(summary, ''), tags_json, entities_json
    FROM memories
    WHERE lifecycle_state != 'suppressed' AND deleted_at IS NULL
  `);
}

function rebuildRetrievalUnitsFts(db) {
  db.exec("DROP TABLE IF EXISTS memory_retrieval_units_fts");
  db.exec(`
    CREATE VIRTUAL TABLE memory_retrieval_units_fts USING fts5(
      unit_id UNINDEXED,
      memory_id UNINDEXED,
      tenant_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    )
  `);
  db.exec(`
    INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text)
    SELECT id, memory_id, tenant_id, text
    FROM memory_retrieval_units
  `);
}

function rebuildRetrievalUnitsV4Fts(db) {
  db.exec("DROP TABLE IF EXISTS memory_retrieval_units_v4_fts");
  db.exec(`
    CREATE VIRTUAL TABLE memory_retrieval_units_v4_fts USING fts5(
      unit_id UNINDEXED,
      memory_id UNINDEXED,
      tenant_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    )
  `);
  db.exec(`
    INSERT INTO memory_retrieval_units_v4_fts(unit_id, memory_id, tenant_id, text)
    SELECT id, memory_id, tenant_id, text
    FROM memory_retrieval_units_v4
  `);
}

function rebuildStableRetrievalUnitsFts(db) {
  db.exec("DROP TABLE IF EXISTS retrieval_units_fts");
  db.exec(`
    CREATE VIRTUAL TABLE retrieval_units_fts USING fts5(
      unit_id UNINDEXED,
      generation_id UNINDEXED,
      tenant_id UNINDEXED,
      text,
      tokenize = 'unicode61'
    )
  `);
  db.exec(`
    INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text)
    SELECT id, generation_id, tenant_id, text
    FROM retrieval_units
  `);
}

function rebuildStableRetrievalFeatureStats(db) {
  db.prepare("DELETE FROM retrieval_unit_feature_stats").run();
  db.exec(`
    INSERT INTO retrieval_unit_feature_stats(generation_id, tenant_id, feature_hash, document_count)
    SELECT generation_id, tenant_id, feature_hash, COUNT(DISTINCT unit_id)
    FROM retrieval_unit_features
    GROUP BY generation_id, tenant_id, feature_hash
  `);
}

function deleteStableRetrievalUnits(db, tenantId, sourceId) {
  const units = db.prepare(
    "SELECT id, generation_id FROM retrieval_units WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?"
  ).all(tenantId, sourceId);
  for (const unit of units) {
    db.prepare("DELETE FROM retrieval_unit_features WHERE tenant_id = ? AND generation_id = ? AND unit_id = ?")
      .run(tenantId, unit.generation_id, unit.id);
    db.prepare("DELETE FROM retrieval_unit_embeddings WHERE tenant_id = ? AND generation_id = ? AND unit_id = ?")
      .run(tenantId, unit.generation_id, unit.id);
  }
  db.prepare("DELETE FROM retrieval_units_fts WHERE tenant_id = ? AND unit_id IN (SELECT id FROM retrieval_units WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?)")
    .run(tenantId, tenantId, sourceId);
  db.prepare("DELETE FROM retrieval_units WHERE tenant_id = ? AND source_type = 'memory' AND source_id = ?")
    .run(tenantId, sourceId);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function writeStableRetrievalUnits(db, record, writeFts = true, deleteExisting = true, updateFeatureStats = true) {
  if (deleteExisting) deleteStableRetrievalUnits(db, record.tenant_id, record.id);
  if (record.lifecycle_state === "suppressed") return;
  const generations = [
    {
      id: "gen_baseline_units",
      units: "memory_retrieval_units",
      features: "memory_retrieval_unit_features",
      embeddings: "memory_retrieval_unit_embeddings",
      metadata: "'{}'",
      segment: "NULL",
      vectorFormat: "'sparse-fallback'",
      vectorBlob: "NULL"
    },
    {
      id: "gen_structured_context",
      units: "memory_retrieval_units_v4",
      features: "memory_retrieval_unit_features_v4",
      embeddings: "memory_retrieval_unit_embeddings_v4",
      metadata: "u.metadata_json",
      segment: "u.segment_id",
      vectorFormat: "e.vector_format",
      vectorBlob: "e.vector_blob"
    }
  ];
  for (const generation of generations) {
    db.prepare(
      `INSERT INTO retrieval_units(
         id, generation_id, tenant_id, project_id, source_type, source_id,
         business_category_id, work_type, unit_type, text, speaker, event_at,
         valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
         metadata_json, segment_id, content_hash, extractor_name, extractor_version,
         extraction_state, degraded_reason, created_at
       )
       SELECT ? || ':' || u.id, ?, u.tenant_id, u.project_id, 'memory', u.memory_id,
              ?, ?, u.unit_type, u.text, u.speaker, u.event_at,
              u.valid_from, u.valid_until, u.source_ref_json, u.source_span_start,
              u.source_span_end, ${generation.metadata}, ${generation.segment},
              u.content_hash, u.extractor, u.extractor_version,
              u.extraction_state, u.degraded_reason, u.created_at
       FROM ${generation.units} u
       WHERE u.tenant_id = ? AND u.memory_id = ?`
    ).run(
      generation.id,
      generation.id,
      record.business_category_id ?? null,
      record.work_type ?? null,
      record.tenant_id,
      record.id
    );
    db.prepare(
      `INSERT INTO retrieval_unit_features(unit_id, generation_id, tenant_id, feature_hash, weight)
       SELECT ? || ':' || f.unit_id, ?, f.tenant_id, f.feature_hash, f.weight
       FROM ${generation.features} f
       JOIN ${generation.units} u ON u.tenant_id = f.tenant_id AND u.id = f.unit_id
       WHERE u.tenant_id = ? AND u.memory_id = ?`
    ).run(generation.id, generation.id, record.tenant_id, record.id);
    db.prepare(
      `INSERT INTO retrieval_unit_embeddings(
         unit_id, generation_id, tenant_id, provider, feature_count,
         vector_format, vector_blob, updated_at
       )
       SELECT ? || ':' || e.unit_id, ?, e.tenant_id, e.provider, e.feature_count,
              ${generation.vectorFormat}, ${generation.vectorBlob}, e.updated_at
       FROM ${generation.embeddings} e
       JOIN ${generation.units} u ON u.tenant_id = e.tenant_id AND u.id = e.unit_id
       WHERE u.tenant_id = ? AND u.memory_id = ?`
    ).run(generation.id, generation.id, record.tenant_id, record.id);
    if (writeFts) {
      db.prepare(
        `INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text)
         SELECT id, generation_id, tenant_id, text
         FROM retrieval_units
         WHERE generation_id = ? AND tenant_id = ? AND source_type = 'memory' AND source_id = ?`
      ).run(generation.id, record.tenant_id, record.id);
    }
  }
  for (const unit of buildVerifiedLearningRetrievalUnits({
    ...record,
    learning_json: record.learning ? json(record.learning) : null
  })) {
    const unitId = `gen_verified_learning:${unit.id}`;
    db.prepare(
      `INSERT INTO retrieval_units(
         id, generation_id, tenant_id, project_id, source_type, source_id,
         business_category_id, work_type, unit_type, text, speaker, event_at,
         valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
         metadata_json, segment_id, content_hash, extractor_name, extractor_version,
         extraction_state, degraded_reason, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      unitId, "gen_verified_learning", unit.tenant_id, unit.project_id, "memory", unit.memory_id,
      record.business_category_id ?? null, record.work_type ?? null, unit.unit_type, unit.text, unit.speaker,
      unit.event_at, unit.valid_from, unit.valid_until, unit.source_ref_json, unit.source_span_start,
      unit.source_span_end, unit.metadata_json, unit.segment_id, unit.content_hash, unit.extractor,
      unit.extractor_version, unit.extraction_state, unit.degraded_reason, unit.created_at
    );
    const features = embedLocalText(unit.text);
    for (const feature of features) {
      db.prepare(
        "INSERT INTO retrieval_unit_features(unit_id, generation_id, tenant_id, feature_hash, weight) VALUES(?,?,?,?,?)"
      ).run(unitId, "gen_verified_learning", unit.tenant_id, feature.feature_hash, feature.weight);
    }
    db.prepare(
      `INSERT INTO retrieval_unit_embeddings(
         unit_id, generation_id, tenant_id, provider, feature_count, vector_format, vector_blob, updated_at
       ) VALUES(?,?,?,?,?,?,?,?)`
    ).run(unitId, "gen_verified_learning", unit.tenant_id, LOCAL_EMBEDDING_PROVIDER, features.length, "sparse-fallback", null, unit.created_at);
    if (writeFts) db.prepare(
      "INSERT INTO retrieval_units_fts(unit_id, generation_id, tenant_id, text) VALUES(?,?,?,?)"
    ).run(unitId, "gen_verified_learning", unit.tenant_id, unit.text);
  }
  if (updateFeatureStats) rebuildStableRetrievalFeatureStats(db);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function rebuildStableRetrievalUnits(db) {
  db.prepare(
    `DELETE FROM retrieval_unit_features WHERE unit_id IN (
       SELECT id FROM retrieval_units WHERE source_type = 'memory'
     )`
  ).run();
  db.prepare(
    `DELETE FROM retrieval_unit_embeddings WHERE unit_id IN (
       SELECT id FROM retrieval_units WHERE source_type = 'memory'
     )`
  ).run();
  db.prepare("DELETE FROM retrieval_unit_feature_stats").run();
  db.prepare("DELETE FROM retrieval_units WHERE source_type = 'memory'").run();
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeStableRetrievalUnits(db, memoryFromRow(row), false, false, false);
  rebuildStableRetrievalUnitsFts(db);
  rebuildStableRetrievalFeatureStats(db);
}

function deleteLocalEmbedding(db, tenantId, memoryId, updateFeatureStats = true) {
  const oldFeatures = updateFeatureStats
    ? db.prepare(
        "SELECT feature_hash FROM memory_embedding_features WHERE tenant_id = ? AND memory_id = ?"
      ).all(tenantId, memoryId)
    : [];
  db.prepare("DELETE FROM memory_embedding_features WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  db.prepare("DELETE FROM memory_embeddings WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  if (!updateFeatureStats) return;
  const decrement = db.prepare(
    `UPDATE memory_embedding_feature_stats
     SET document_count = document_count - 1
     WHERE tenant_id = ? AND feature_hash = ?`
  );
  const removeEmpty = db.prepare(
    `DELETE FROM memory_embedding_feature_stats
     WHERE tenant_id = ? AND feature_hash = ? AND document_count <= 0`
  );
  for (const feature of oldFeatures) {
    decrement.run(tenantId, feature.feature_hash);
    removeEmpty.run(tenantId, feature.feature_hash);
  }
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function writeLocalEmbedding(db, record, updateFeatureStats = true) {
  deleteLocalEmbedding(db, record.tenant_id, record.id, updateFeatureStats);
  if (record.lifecycle_state === "suppressed") return;
  const features = embedLocalText(localEmbeddingText(record));
  const insertFeature = db.prepare(
    "INSERT INTO memory_embedding_features(memory_id, tenant_id, feature_hash, weight) VALUES(?,?,?,?)"
  );
  const incrementFeatureCount = db.prepare(
    `INSERT INTO memory_embedding_feature_stats(tenant_id, feature_hash, document_count)
     VALUES(?,?,1)
     ON CONFLICT(tenant_id, feature_hash)
     DO UPDATE SET document_count = document_count + 1`
  );
  for (const feature of features) {
    insertFeature.run(record.id, record.tenant_id, feature.feature_hash, feature.weight);
    if (updateFeatureStats) incrementFeatureCount.run(record.tenant_id, feature.feature_hash);
  }
  db.prepare(
    `INSERT INTO memory_embeddings(memory_id, tenant_id, provider, feature_count, updated_at)
     VALUES(?,?,?,?,?)`
  ).run(record.id, record.tenant_id, LOCAL_EMBEDDING_PROVIDER, features.length, record.updated_at);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function rebuildLocalEmbeddings(db) {
  db.prepare("DELETE FROM memory_embedding_features").run();
  db.prepare("DELETE FROM memory_embeddings").run();
  db.prepare("DELETE FROM memory_embedding_feature_stats").run();
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeLocalEmbedding(db, memoryFromRow(row), false);
  db.exec(`
    INSERT INTO memory_embedding_feature_stats(tenant_id, feature_hash, document_count)
    SELECT tenant_id, feature_hash, COUNT(*)
    FROM memory_embedding_features
    GROUP BY tenant_id, feature_hash
  `);
}

function deleteRetrievalUnitEmbedding(db, tenantId, unitId, updateFeatureStats = true) {
  const oldFeatures = updateFeatureStats
    ? db.prepare(
        "SELECT feature_hash FROM memory_retrieval_unit_features WHERE tenant_id = ? AND unit_id = ?"
      ).all(tenantId, unitId)
    : [];
  db.prepare("DELETE FROM memory_retrieval_unit_features WHERE tenant_id = ? AND unit_id = ?")
    .run(tenantId, unitId);
  db.prepare("DELETE FROM memory_retrieval_unit_embeddings WHERE tenant_id = ? AND unit_id = ?")
    .run(tenantId, unitId);
  if (!updateFeatureStats) return;
  const decrement = db.prepare(
    `UPDATE memory_retrieval_unit_feature_stats
     SET document_count = document_count - 1
     WHERE tenant_id = ? AND feature_hash = ?`
  );
  const removeEmpty = db.prepare(
    `DELETE FROM memory_retrieval_unit_feature_stats
     WHERE tenant_id = ? AND feature_hash = ? AND document_count <= 0`
  );
  for (const feature of oldFeatures) {
    decrement.run(tenantId, feature.feature_hash);
    removeEmpty.run(tenantId, feature.feature_hash);
  }
}

function writeRetrievalUnitEmbedding(db, unit, updateFeatureStats = true) {
  deleteRetrievalUnitEmbedding(db, unit.tenant_id, unit.id, updateFeatureStats);
  const features = embedLocalText(unit.text);
  const insertFeature = db.prepare(
    `INSERT INTO memory_retrieval_unit_features(unit_id, tenant_id, feature_hash, weight)
     VALUES(?,?,?,?)`
  );
  const incrementFeatureCount = db.prepare(
    `INSERT INTO memory_retrieval_unit_feature_stats(tenant_id, feature_hash, document_count)
     VALUES(?,?,1)
     ON CONFLICT(tenant_id, feature_hash)
     DO UPDATE SET document_count = document_count + 1`
  );
  for (const feature of features) {
    insertFeature.run(unit.id, unit.tenant_id, feature.feature_hash, feature.weight);
    if (updateFeatureStats) incrementFeatureCount.run(unit.tenant_id, feature.feature_hash);
  }
  db.prepare(
    `INSERT INTO memory_retrieval_unit_embeddings(unit_id, tenant_id, provider, feature_count, updated_at)
     VALUES(?,?,?,?,?)`
  ).run(unit.id, unit.tenant_id, LOCAL_EMBEDDING_PROVIDER, features.length, unit.created_at);
}

function deleteRetrievalUnits(db, tenantId, memoryId, updateFeatureStats = true) {
  const units = db.prepare(
    "SELECT id FROM memory_retrieval_units WHERE tenant_id = ? AND memory_id = ?"
  ).all(tenantId, memoryId);
  for (const unit of units) deleteRetrievalUnitEmbedding(db, tenantId, unit.id, updateFeatureStats);
  db.prepare("DELETE FROM memory_retrieval_units_fts WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  db.prepare("DELETE FROM memory_retrieval_units WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function writeRetrievalUnits(
  db,
  record,
  updateFeatureStats = true,
  writeFts = true,
  deleteExisting = true
) {
  if (deleteExisting) deleteRetrievalUnits(db, record.tenant_id, record.id, updateFeatureStats);
  if (record.lifecycle_state === "suppressed") return;
  const units = buildRetrievalUnits(record);
  const insertUnit = db.prepare(
    `INSERT INTO memory_retrieval_units(
      id, memory_id, tenant_id, project_id, unit_type, speaker, text, event_at,
      valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
      content_hash, extractor, extractor_version, extraction_state, degraded_reason, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertFts = writeFts
    ? db.prepare(
        `INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text)
         VALUES(?,?,?,?)`
      )
    : null;
  for (const unit of units) {
    insertUnit.run(
      unit.id,
      unit.memory_id,
      unit.tenant_id,
      unit.project_id,
      unit.unit_type,
      unit.speaker,
      unit.text,
      unit.event_at,
      unit.valid_from,
      unit.valid_until,
      unit.source_ref_json,
      unit.source_span_start,
      unit.source_span_end,
      unit.content_hash,
      unit.extractor,
      unit.extractor_version,
      unit.extraction_state,
      unit.degraded_reason,
      unit.created_at
    );
    if (insertFts) insertFts.run(unit.id, unit.memory_id, unit.tenant_id, unit.text);
    writeRetrievalUnitEmbedding(db, unit, updateFeatureStats);
  }
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function rebuildRetrievalUnits(db) {
  db.prepare("DELETE FROM memory_retrieval_unit_features").run();
  db.prepare("DELETE FROM memory_retrieval_unit_embeddings").run();
  db.prepare("DELETE FROM memory_retrieval_unit_feature_stats").run();
  db.prepare("DELETE FROM memory_retrieval_units").run();
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeRetrievalUnits(db, memoryFromRow(row), false, false, false);
  rebuildRetrievalUnitsFts(db);
  db.exec(`
    INSERT INTO memory_retrieval_unit_feature_stats(tenant_id, feature_hash, document_count)
    SELECT tenant_id, feature_hash, COUNT(*)
    FROM memory_retrieval_unit_features
    GROUP BY tenant_id, feature_hash
  `);
}

function deleteRetrievalUnitsV4(db, tenantId, memoryId) {
  const ids = db.prepare(
    "SELECT id FROM memory_retrieval_units_v4 WHERE tenant_id = ? AND memory_id = ?"
  ).all(tenantId, memoryId).map((row) => row.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM memory_retrieval_unit_features_v4
       WHERE tenant_id = ? AND unit_id IN (${placeholders})`
    ).run(tenantId, ...ids);
    db.prepare(
      `DELETE FROM memory_retrieval_unit_embeddings_v4
       WHERE tenant_id = ? AND unit_id IN (${placeholders})`
    ).run(tenantId, ...ids);
  }
  db.prepare("DELETE FROM memory_retrieval_units_v4_fts WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
  db.prepare("DELETE FROM memory_retrieval_units_v4 WHERE tenant_id = ? AND memory_id = ?")
    .run(tenantId, memoryId);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function wipeMemoryProjections(db, tenantId, memoryId) {
  db.prepare("DELETE FROM memories_fts WHERE tenant_id = ? AND memory_id = ?").run(tenantId, memoryId);
  deleteLocalEmbedding(db, tenantId, memoryId);
  deleteRetrievalUnits(db, tenantId, memoryId);
  deleteRetrievalUnitsV4(db, tenantId, memoryId);
  deleteStableRetrievalUnits(db, tenantId, memoryId);
  rebuildStableRetrievalFeatureStats(db);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function writeRetrievalUnitsV4(db, record, writeFts = true, deleteExisting = true) {
  if (deleteExisting) deleteRetrievalUnitsV4(db, record.tenant_id, record.id);
  if (record.lifecycle_state === "suppressed") return;
  const insertUnit = db.prepare(
    `INSERT INTO memory_retrieval_units_v4(
      id, memory_id, tenant_id, project_id, unit_type, speaker, text, event_at,
      valid_from, valid_until, source_ref_json, source_span_start, source_span_end,
      content_hash, metadata_json, segment_id, extractor, extractor_version,
      extraction_state, degraded_reason, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertFts = writeFts
    ? db.prepare(
        `INSERT INTO memory_retrieval_units_v4_fts(unit_id, memory_id, tenant_id, text)
         VALUES(?,?,?,?)`
      )
    : null;
  const insertFeature = db.prepare(
    `INSERT INTO memory_retrieval_unit_features_v4(unit_id, tenant_id, feature_hash, weight)
     VALUES(?,?,?,?)`
  );
  const insertEmbedding = db.prepare(
    `INSERT INTO memory_retrieval_unit_embeddings_v4(
       unit_id, tenant_id, provider, feature_count, vector_format, vector_blob, updated_at
     ) VALUES(?,?,?,?,?,?,?)`
  );
  for (const unit of buildRetrievalUnitsV4(record)) {
    insertUnit.run(
      unit.id, unit.memory_id, unit.tenant_id, unit.project_id, unit.unit_type,
      unit.speaker, unit.text, unit.event_at, unit.valid_from, unit.valid_until,
      unit.source_ref_json, unit.source_span_start, unit.source_span_end,
      unit.content_hash, unit.metadata_json, unit.segment_id, unit.extractor,
      unit.extractor_version, unit.extraction_state, unit.degraded_reason, unit.created_at
    );
    if (insertFts) insertFts.run(unit.id, unit.memory_id, unit.tenant_id, unit.text);
    const features = embedLocalText(unit.text);
    for (const feature of features) {
      insertFeature.run(unit.id, unit.tenant_id, feature.feature_hash, feature.weight);
    }
    insertEmbedding.run(
      unit.id,
      unit.tenant_id,
      LOCAL_EMBEDDING_PROVIDER,
      features.length,
      "sparse-fallback",
      null,
      unit.created_at
    );
  }
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function rebuildRetrievalUnitsV4(db) {
  db.prepare("DELETE FROM memory_retrieval_unit_features_v4").run();
  db.prepare("DELETE FROM memory_retrieval_unit_embeddings_v4").run();
  db.prepare("DELETE FROM memory_retrieval_unit_feature_stats_v4").run();
  db.prepare("DELETE FROM memory_retrieval_units_v4").run();
  const rows = db.prepare("SELECT * FROM memories WHERE lifecycle_state != 'suppressed'").all();
  for (const row of rows) writeRetrievalUnitsV4(db, memoryFromRow(row), false, false);
  rebuildRetrievalUnitsV4Fts(db);
  db.exec(`
    INSERT INTO memory_retrieval_unit_feature_stats_v4(tenant_id, feature_hash, document_count)
    SELECT tenant_id, feature_hash, COUNT(*)
    FROM memory_retrieval_unit_features_v4
    GROUP BY tenant_id, feature_hash
  `);
}

