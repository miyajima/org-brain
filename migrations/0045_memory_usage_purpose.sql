-- Existing observations remain unclassified; never infer an audit/task label.
ALTER TABLE memory_usage_events ADD COLUMN usage_purpose TEXT NOT NULL DEFAULT 'unclassified';
