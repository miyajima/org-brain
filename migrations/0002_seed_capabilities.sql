INSERT INTO capabilities (
  tenant_id,
  name,
  version,
  input_schema,
  output_schema,
  max_concurrency,
  cost_limit_ms,
  allowed_tools,
  updated_at
)
VALUES
  (
    'default',
    'plan_writer',
    1,
    '{"type":"object","required":["input_ref"]}',
    '{"type":"object","required":["output_ref"]}',
    2,
    120000,
    '["memory.search","r2"]',
    strftime('%s','now') * 1000
  ),
  (
    'default',
    'code_gen',
    1,
    '{"type":"object","required":["input_ref"]}',
    '{"type":"object","required":["output_ref"]}',
    2,
    300000,
    '["memory.search","r2"]',
    strftime('%s','now') * 1000
  ),
  (
    'default',
    'code_review',
    1,
    '{"type":"object","required":["input_ref"]}',
    '{"type":"object","required":["output_ref"]}',
    2,
    300000,
    '["memory.search","r2","threads"]',
    strftime('%s','now') * 1000
  )
ON CONFLICT(tenant_id, name) DO UPDATE SET
  version = excluded.version,
  input_schema = excluded.input_schema,
  output_schema = excluded.output_schema,
  max_concurrency = excluded.max_concurrency,
  cost_limit_ms = excluded.cost_limit_ms,
  allowed_tools = excluded.allowed_tools,
  updated_at = excluded.updated_at;
