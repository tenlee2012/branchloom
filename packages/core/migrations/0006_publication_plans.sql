-- Plans live in the project's canonical JSON so snapshots and field-wise sync preserve them.
-- Raise the schema version to prevent older clients from dropping the new project field.
INSERT OR IGNORE INTO branchloom_metadata(key, value) VALUES ('publication_plan_format', '1');
PRAGMA user_version = 6;
