use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde_json::{json, Map, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use crate::core::error::{CoreError, CoreResult};
use crate::core::project::{NewProject, ProjectPatch, ProjectRecord};
use crate::project_format::{ProjectData, PROJECT_COLLECTIONS};

const INITIAL_MIGRATION: &str = include_str!("../../migrations/0001_initial.sql");
pub const CURRENT_SCHEMA_VERSION: i64 = 5;
pub const NORMALIZED_STATE_VERSION: u64 = 2;

const LEGACY_TABLES: [&str; 23] = [
    "career_attachment_links",
    "career_citations",
    "person_name_details",
    "career_records",
    "person_titles",
    "organizations",
    "app_state",
    "change_sets",
    "snapshots",
    "attachment_links",
    "attachments",
    "citations",
    "sources",
    "event_participants",
    "events",
    "relationships",
    "person_names",
    "people",
    "place_aliases",
    "places",
    "projects",
    "branchloom_metadata",
    "snapshot_payloads",
];

const ENTITY_COLLECTIONS: [(&str, &str); 13] = [
    ("people", "people"),
    ("organizations", "organizations"),
    ("careers", "careers"),
    ("personTitles", "person_titles"),
    ("relationships", "relationships"),
    ("events", "events"),
    ("places", "places"),
    ("sources", "sources"),
    ("citations", "citations"),
    ("attachments", "attachments"),
    ("attachmentLinks", "attachment_links"),
    ("snapshots", "snapshots"),
    ("issues", "issues"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedState {
    pub state_json: String,
    pub snapshot_payloads_json: String,
}

#[derive(Clone, Debug)]
pub struct DesktopRecordChange {
    pub collection: &'static str,
    pub id: String,
    pub project_id: String,
    pub after: Option<Value>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resource {
    Person,
    Organization,
    Career,
    Title,
    Relationship,
    Event,
    Place,
    Source,
    Citation,
    Attachment,
}

impl Resource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Organization => "organization",
            Self::Career => "career",
            Self::Title => "title",
            Self::Relationship => "relationship",
            Self::Event => "event",
            Self::Place => "place",
            Self::Source => "source",
            Self::Citation => "citation",
            Self::Attachment => "attachment",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "person" => Some(Self::Person),
            "organization" => Some(Self::Organization),
            "career" => Some(Self::Career),
            "title" => Some(Self::Title),
            "relationship" => Some(Self::Relationship),
            "event" => Some(Self::Event),
            "place" => Some(Self::Place),
            "source" => Some(Self::Source),
            "citation" => Some(Self::Citation),
            "attachment" => Some(Self::Attachment),
            _ => None,
        }
    }

    pub fn table(self) -> &'static str {
        match self {
            Self::Person => "people",
            Self::Organization => "organizations",
            Self::Career => "careers",
            Self::Title => "person_titles",
            Self::Relationship => "relationships",
            Self::Event => "events",
            Self::Place => "places",
            Self::Source => "sources",
            Self::Citation => "citations",
            Self::Attachment => "attachments",
        }
    }
}

pub struct Storage {
    connection: Connection,
}

impl Storage {
    pub fn inspect_schema(path: impl AsRef<Path>) -> CoreResult<i64> {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    #[cfg(test)]
    fn open_in_memory() -> CoreResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> CoreResult<Self> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;

        let mut storage = Self { connection };
        storage.migrate()?;
        Ok(storage)
    }

    fn migrate(&mut self) -> CoreResult<()> {
        let version = self.schema_version()?;
        if version > CURRENT_SCHEMA_VERSION {
            return Err(CoreError::UnsupportedVersion {
                found: version,
                supported: CURRENT_SCHEMA_VERSION,
            });
        }
        if version == CURRENT_SCHEMA_VERSION {
            self.ensure_normalized_metadata()?;
            return Ok(());
        }
        if version == 0 {
            self.connection.execute_batch(INITIAL_MIGRATION)?;
            return Ok(());
        }
        if self.table_exists("branchloom_metadata")? {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute(
                "INSERT OR IGNORE INTO branchloom_metadata(key, value)
                 VALUES ('data_revision', '0')",
                [],
            )?;
            transaction.execute(
                "INSERT OR IGNORE INTO branchloom_metadata(key, value)
                 SELECT 'state_initialized',
                        CASE WHEN EXISTS(SELECT 1 FROM projects) THEN '1' ELSE '0' END",
                [],
            )?;
            transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)?;
            transaction.commit()?;
            return Ok(());
        }
        if (1..=3).contains(&version) {
            return self.migrate_legacy_schema();
        }
        Err(CoreError::UnsupportedVersion {
            found: version,
            supported: CURRENT_SCHEMA_VERSION,
        })
    }

    pub fn schema_version(&self) -> CoreResult<i64> {
        Ok(self
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    pub fn data_revision(&self) -> CoreResult<i64> {
        read_data_revision(&self.connection)
    }

    fn ensure_normalized_metadata(&self) -> CoreResult<()> {
        self.connection.execute(
            "INSERT OR IGNORE INTO branchloom_metadata(key, value)
             VALUES ('data_revision', '0')",
            [],
        )?;
        self.connection.execute(
            "INSERT OR IGNORE INTO branchloom_metadata(key, value)
             SELECT 'state_initialized',
                    CASE WHEN EXISTS(SELECT 1 FROM projects) THEN '1' ELSE '0' END",
            [],
        )?;
        Ok(())
    }

    fn table_exists(&self, table: &str) -> CoreResult<bool> {
        Ok(self
            .connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    fn migrate_legacy_schema(&mut self) -> CoreResult<()> {
        let legacy_state = if self.table_exists("app_state")? {
            self.connection
                .query_row(
                    "SELECT state_json, snapshot_payloads_json
                     FROM app_state
                     WHERE id = 1",
                    [],
                    |row| {
                        Ok(NormalizedState {
                            state_json: row.get(0)?,
                            snapshot_payloads_json: row.get(1)?,
                        })
                    },
                )
                .optional()?
        } else {
            None
        };

        if legacy_state.is_none() && self.legacy_business_row_count()? > 0 {
            return Err(CoreError::Validation(
                "legacy database contains records but no application state; migration was not performed"
                    .to_owned(),
            ));
        }

        let parsed_state = legacy_state
            .as_ref()
            .map(|state| parse_state_payload(&state.state_json, &state.snapshot_payloads_json))
            .transpose()?;

        self.connection.pragma_update(None, "foreign_keys", false)?;
        let migration_result = (|| -> CoreResult<()> {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            for table in LEGACY_TABLES {
                transaction.execute(&format!("DROP TABLE IF EXISTS {table}"), [])?;
            }
            transaction.execute_batch(INITIAL_MIGRATION)?;
            if let Some((state, payloads)) = parsed_state.as_ref() {
                insert_normalized_state(&transaction, state, payloads)?;
                mark_state_initialized(&transaction)?;
            }
            transaction.commit()?;
            Ok(())
        })();
        let restore_result = self
            .connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(CoreError::from);
        restore_result?;
        migration_result
    }

    fn legacy_business_row_count(&self) -> CoreResult<i64> {
        let mut total = 0;
        for table in [
            "projects",
            "places",
            "people",
            "relationships",
            "events",
            "sources",
            "citations",
            "attachments",
            "snapshots",
            "organizations",
            "career_records",
            "person_titles",
        ] {
            if self.table_exists(table)? {
                total += self.connection.query_row(
                    &format!("SELECT count(*) FROM {table}"),
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
            }
        }
        Ok(total)
    }

    pub fn create_project(&mut self, input: NewProject) -> CoreResult<ProjectRecord> {
        self.create_project_with_id(Uuid::new_v4().to_string(), input)
    }

    pub fn create_project_with_id(
        &mut self,
        id: String,
        input: NewProject,
    ) -> CoreResult<ProjectRecord> {
        self.create_project_with_id_internal(id, input, None)
    }

    pub fn create_project_with_id_if_revision(
        &mut self,
        id: String,
        input: NewProject,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        self.create_project_with_id_internal(id, input, Some(expected_revision))
    }

    fn create_project_with_id_internal(
        &mut self,
        id: String,
        input: NewProject,
        expected_revision: Option<i64>,
    ) -> CoreResult<ProjectRecord> {
        let name = require_name(input.name)?;
        let description = input.description.trim().to_owned();
        let timestamp = utc_timestamp()?;
        let project = ProjectRecord {
            id,
            name,
            description,
            cover_url: None,
            default_person_id: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            last_backup_at: None,
            backup_schedule: "weekly".to_owned(),
        };
        let data_json = serde_json::to_string(&project)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, expected_revision)?;
        transaction.execute(
            "INSERT INTO projects(
                id, name, description, data_json, revision, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
            params![
                project.id,
                project.name,
                project.description,
                data_json,
                project.created_at,
                project.updated_at
            ],
        )?;
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(project)
    }

    pub fn get_project(&self, id: &str) -> CoreResult<ProjectRecord> {
        load_project(&self.connection, id)
    }

    pub fn list_projects(&self) -> CoreResult<Vec<ProjectRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT data_json FROM projects ORDER BY updated_at DESC, id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let value = row?;
            serde_json::from_str(&value).map_err(CoreError::from)
        })
        .collect()
    }

    pub fn update_project(&mut self, id: &str, patch: ProjectPatch) -> CoreResult<ProjectRecord> {
        self.update_project_internal(id, patch, None)
    }

    pub fn update_project_if_revision(
        &mut self,
        id: &str,
        patch: ProjectPatch,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        self.update_project_internal(id, patch, Some(expected_revision))
    }

    pub fn update_project_value_if_revision(
        &mut self,
        id: &str,
        patch: &Value,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        let patch = patch
            .as_object()
            .ok_or_else(|| CoreError::Validation("project patch must be an object".to_owned()))?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, Some(expected_revision))?;
        let mut project = serde_json::to_value(load_project(&transaction, id)?)?;
        let object = project
            .as_object_mut()
            .expect("project serializes as object");
        for (key, value) in patch {
            match key.as_str() {
                "name" | "description" | "defaultPersonId" | "backupSchedule" => {
                    if value.is_null() {
                        object.remove(key);
                    } else {
                        object.insert(key.clone(), value.clone());
                    }
                }
                "coverUrl" => {}
                _ => {
                    return Err(CoreError::Validation(format!(
                        "unsupported project patch field: {key}"
                    )))
                }
            }
        }
        let name = require_name(
            project
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        )?;
        let description = project
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned();
        let schedule = project
            .get("backupSchedule")
            .and_then(Value::as_str)
            .unwrap_or("weekly")
            .to_owned();
        if !matches!(schedule.as_str(), "off" | "daily" | "weekly") {
            return Err(CoreError::Validation(
                "project backup schedule is invalid".to_owned(),
            ));
        }
        if let Some(person_id) = project.get("defaultPersonId").and_then(Value::as_str) {
            let belongs_to_project = transaction
                .query_row(
                    "SELECT 1 FROM people WHERE id = ?1 AND project_id = ?2",
                    params![person_id, id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if !belongs_to_project {
                return Err(CoreError::Validation(format!(
                    "default person is missing from project {id}: {person_id}"
                )));
            }
        }
        let timestamp = utc_timestamp()?;
        let object = project.as_object_mut().expect("project is object");
        object.insert("name".to_owned(), json!(name));
        object.insert("description".to_owned(), json!(description));
        object.insert("backupSchedule".to_owned(), json!(schedule));
        object.insert("updatedAt".to_owned(), json!(timestamp));
        let project_record: ProjectRecord = serde_json::from_value(project.clone())?;
        transaction.execute(
            "UPDATE projects SET name = ?1, description = ?2, data_json = ?3,
             revision = revision + 1, updated_at = ?4 WHERE id = ?5",
            params![
                project_record.name,
                project_record.description,
                serde_json::to_string(&project)?,
                project_record.updated_at,
                id,
            ],
        )?;
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(project_record)
    }

    fn update_project_internal(
        &mut self,
        id: &str,
        patch: ProjectPatch,
        expected_revision: Option<i64>,
    ) -> CoreResult<ProjectRecord> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, expected_revision)?;
        let mut project = load_project(&transaction, id)?;
        project.name = require_name(patch.name)?;
        project.description = patch.description.trim().to_owned();
        project.updated_at = utc_timestamp()?;
        let data_json = serde_json::to_string(&project)?;
        transaction.execute(
            "UPDATE projects
             SET name = ?1, description = ?2, data_json = ?3,
                 revision = revision + 1, updated_at = ?4
             WHERE id = ?5",
            params![
                project.name,
                project.description,
                data_json,
                project.updated_at,
                id
            ],
        )?;
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(project)
    }

    pub fn delete_project(&mut self, id: &str) -> CoreResult<()> {
        self.delete_project_internal(id, None)
    }

    pub fn delete_project_if_revision(
        &mut self,
        id: &str,
        expected_revision: i64,
    ) -> CoreResult<()> {
        self.delete_project_internal(id, Some(expected_revision))
    }

    pub fn project_delete_impact(&self, id: &str) -> CoreResult<Vec<Value>> {
        self.get_project(id)?;
        let mut impact = Vec::new();
        for (collection, table) in ENTITY_COLLECTIONS {
            let sql = format!("SELECT count(*) FROM {table} WHERE project_id = ?1");
            let count: i64 = self.connection.query_row(&sql, [id], |row| row.get(0))?;
            if count > 0 {
                impact.push(json!({
                    "resource": collection,
                    "action": "delete",
                    "count": count,
                }));
            }
        }
        let snapshot_payload_count: i64 = self.connection.query_row(
            "SELECT count(*) FROM snapshot_payloads
             WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?1)",
            [id],
            |row| row.get(0),
        )?;
        if snapshot_payload_count > 0 {
            impact.push(json!({
                "resource": "snapshotPayloads",
                "action": "delete",
                "count": snapshot_payload_count,
            }));
        }
        let change_set_count: i64 = self.connection.query_row(
            "SELECT count(*) FROM change_sets WHERE project_id = ?1",
            [id],
            |row| row.get(0),
        )?;
        if change_set_count > 0 {
            impact.push(json!({
                "resource": "changeSets",
                "action": "delete",
                "count": change_set_count,
            }));
        }
        Ok(impact)
    }

    fn delete_project_internal(
        &mut self,
        id: &str,
        expected_revision: Option<i64>,
    ) -> CoreResult<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, expected_revision)?;
        transaction.execute(
            "DELETE FROM snapshot_payloads
             WHERE snapshot_id IN (SELECT id FROM snapshots WHERE project_id = ?1)",
            [id],
        )?;
        let changed = transaction.execute("DELETE FROM projects WHERE id = ?1", [id])?;
        if changed == 0 {
            return Err(CoreError::NotFound {
                entity: "project",
                id: id.to_owned(),
            });
        }
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn list_records(&self, resource: Resource, project_id: &str) -> CoreResult<Vec<Value>> {
        let sql = format!(
            "SELECT data_json FROM {} WHERE project_id = ?1 ORDER BY rowid",
            resource.table()
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map([project_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let value = row?;
            serde_json::from_str(&value).map_err(CoreError::from)
        })
        .collect()
    }

    pub fn get_record(&self, resource: Resource, id: &str) -> CoreResult<Option<Value>> {
        let sql = format!("SELECT data_json FROM {} WHERE id = ?1", resource.table());
        self.connection
            .query_row(&sql, [id], |row| row.get::<_, String>(0))
            .optional()?
            .map(|value| serde_json::from_str(&value))
            .transpose()
            .map_err(CoreError::from)
    }

    pub fn put_record(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        data: &Value,
    ) -> CoreResult<()> {
        self.put_record_internal(resource, id, project_id, data, None)
    }

    pub fn put_record_if_revision(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        data: &Value,
        expected_revision: i64,
    ) -> CoreResult<()> {
        self.put_record_internal(resource, id, project_id, data, Some(expected_revision))
    }

    pub fn put_record_with_change_set_if_revision(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        data: &Value,
        expected_revision: i64,
        source: &str,
    ) -> CoreResult<String> {
        let timestamp = utc_timestamp()?;
        let updated_at = data
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or(&timestamp);
        let sql = format!(
            "INSERT INTO {}(id, project_id, data_json, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id,
                data_json = excluded.data_json,
                revision = {}.revision + 1,
                updated_at = excluded.updated_at",
            resource.table(),
            resource.table(),
        );
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, Some(expected_revision))?;
        let before = record_json(&transaction, resource, id)?;
        transaction.execute(
            &sql,
            params![id, project_id, serde_json::to_string(data)?, updated_at],
        )?;
        let action = if before.is_some() { "update" } else { "create" };
        let change_set_id = insert_change_set(
            &transaction,
            resource,
            id,
            project_id,
            action,
            before.as_ref(),
            Some(data),
            source,
            true,
            &timestamp,
        )?;
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(change_set_id)
    }

    pub fn apply_desktop_record_changes_if_revision(
        &mut self,
        operation: &str,
        changes: &[DesktopRecordChange],
        expected_revision: i64,
    ) -> CoreResult<i64> {
        if changes.is_empty() {
            return Err(CoreError::Validation(
                "desktop mutation must contain at least one record change".to_owned(),
            ));
        }
        let project_id = &changes[0].project_id;
        if changes
            .iter()
            .any(|change| &change.project_id != project_id)
        {
            return Err(CoreError::Validation(
                "desktop mutation cannot span projects".to_owned(),
            ));
        }
        let timestamp = utc_timestamp()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, Some(expected_revision))?;
        let project_exists = transaction
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [project_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !project_exists {
            return Err(CoreError::NotFound {
                entity: "project",
                id: project_id.clone(),
            });
        }

        let change_set_id = Uuid::new_v4().to_string();
        let mut audit_items = Vec::with_capacity(changes.len());
        for change in changes {
            if !matches!(
                change.collection,
                "people"
                    | "organizations"
                    | "careers"
                    | "personTitles"
                    | "relationships"
                    | "events"
                    | "places"
                    | "sources"
                    | "citations"
                    | "attachments"
                    | "attachmentLinks"
            ) {
                return Err(CoreError::Validation(format!(
                    "unsupported desktop collection: {}",
                    change.collection
                )));
            }
            let table = collection_table(change.collection);
            let before = transaction
                .query_row(
                    &format!("SELECT data_json FROM {table} WHERE id = ?1"),
                    [&change.id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|raw| serde_json::from_str::<Value>(&raw))
                .transpose()?;
            match &change.after {
                Some(after) => {
                    if required_string(after, "id")? != change.id
                        || required_string(after, "projectId")? != change.project_id
                    {
                        return Err(CoreError::Validation(
                            "desktop record identity does not match its mutation".to_owned(),
                        ));
                    }
                    upsert_entity_json(&transaction, table, after)?;
                }
                None => {
                    transaction
                        .execute(&format!("DELETE FROM {table} WHERE id = ?1"), [&change.id])?;
                }
            }
            audit_items.push((change, before));
        }
        let summary = json!({
            "target": { "resource": "project", "id": project_id },
            "affected": changes.iter().map(|change| json!({
                "resource": change.collection,
                "id": change.id,
                "action": if change.after.is_some() { "upsert" } else { "delete" },
            })).collect::<Vec<_>>(),
            "cascade": [],
            "warnings": [],
        });
        transaction.execute(
            "INSERT INTO change_sets(
                id, project_id, source, operation, created_at, revertible, summary_json
             ) VALUES (?1, ?2, 'desktop', ?3, ?4, 1, ?5)",
            params![
                change_set_id,
                project_id,
                operation,
                timestamp,
                serde_json::to_string(&summary)?,
            ],
        )?;
        for (change, before) in audit_items {
            let action = match (&before, &change.after) {
                (None, Some(_)) => "create",
                (Some(_), Some(_)) => "update",
                (_, None) => "delete",
            };
            transaction.execute(
                "INSERT INTO change_items(
                    id, change_set_id, entity_type, entity_id, action, before_json, after_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    Uuid::new_v4().to_string(),
                    change_set_id,
                    change.collection,
                    change.id,
                    action,
                    before.as_ref().map(serde_json::to_string).transpose()?,
                    change
                        .after
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                ],
            )?;
        }
        let revision = bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(revision)
    }

    pub fn insert_cli_batch_if_revision(
        &mut self,
        project_id: &str,
        records: &[(Resource, &str, Value)],
        expected_revision: i64,
    ) -> CoreResult<(String, i64)> {
        if records.is_empty() {
            return Err(CoreError::Validation(
                "batch must contain at least one record".to_owned(),
            ));
        }
        let timestamp = utc_timestamp()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, Some(expected_revision))?;
        let project_exists = transaction
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [project_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !project_exists {
            return Err(CoreError::NotFound {
                entity: "project",
                id: project_id.to_owned(),
            });
        }

        for (resource, action, record) in records {
            let expected_action = if *resource == Resource::Relationship {
                "add"
            } else {
                "create"
            };
            if !matches!(*resource, Resource::Person | Resource::Relationship)
                || *action != expected_action
            {
                return Err(CoreError::Validation(
                    "batch supports only person/create and relationship/add".to_owned(),
                ));
            }
            if required_string(record, "projectId")? != project_id {
                return Err(CoreError::Validation(
                    "all batch records must belong to the selected project".to_owned(),
                ));
            }
            let id = required_string(record, "id")?;
            if record_json(&transaction, *resource, id)?.is_some() {
                return Err(CoreError::Validation(format!(
                    "batch target already exists: {}/{}",
                    resource.as_str(),
                    id
                )));
            }
            insert_entity_json(&transaction, resource.table(), record)?;
        }

        let change_set_id =
            insert_batch_change_set(&transaction, project_id, records, "cli", &timestamp)?;
        let revision = bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok((change_set_id, revision))
    }

    fn put_record_internal(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        data: &Value,
        expected_revision: Option<i64>,
    ) -> CoreResult<()> {
        let timestamp = utc_timestamp()?;
        let updated_at = data
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or(&timestamp);
        let sql = format!(
            "INSERT INTO {}(id, project_id, data_json, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id,
                data_json = excluded.data_json,
                revision = {}.revision + 1,
                updated_at = excluded.updated_at",
            resource.table(),
            resource.table(),
        );
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, expected_revision)?;
        transaction.execute(
            &sql,
            params![id, project_id, serde_json::to_string(data)?, updated_at],
        )?;
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_record(&mut self, resource: Resource, id: &str) -> CoreResult<()> {
        self.delete_record_internal(resource, id, None, "desktop")
    }

    pub fn delete_record_if_revision(
        &mut self,
        resource: Resource,
        id: &str,
        expected_revision: i64,
    ) -> CoreResult<()> {
        self.delete_record_internal(resource, id, Some(expected_revision), "desktop")
    }

    pub fn record_delete_impact(&self, resource: Resource, id: &str) -> CoreResult<Vec<Value>> {
        let plan = plan_record_deletion(&self.connection, resource, id)?;
        Ok(plan.impact())
    }

    pub fn delete_record_with_change_set_if_revision(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        expected_revision: i64,
        source: &str,
    ) -> CoreResult<String> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, Some(expected_revision))?;
        let plan = plan_record_deletion(&transaction, resource, id)?;
        if plan.project_id != project_id {
            return Err(CoreError::Validation(format!(
                "record {id} belongs to project {}, not {project_id}",
                plan.project_id
            )));
        }
        let timestamp = utc_timestamp()?;
        apply_record_deletion(&transaction, &plan, &timestamp)?;
        let change_set_id = insert_record_delete_change_set(
            &transaction,
            resource,
            id,
            project_id,
            &plan,
            source,
            &timestamp,
        )?;
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(change_set_id)
    }

    fn delete_record_internal(
        &mut self,
        resource: Resource,
        id: &str,
        expected_revision: Option<i64>,
        source: &str,
    ) -> CoreResult<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, expected_revision)?;
        let plan = plan_record_deletion(&transaction, resource, id)?;
        let timestamp = utc_timestamp()?;
        apply_record_deletion(&transaction, &plan, &timestamp)?;
        insert_record_delete_change_set(
            &transaction,
            resource,
            id,
            &plan.project_id,
            &plan,
            source,
            &timestamp,
        )?;
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn export_project_data(&self, project_id: &str) -> CoreResult<ProjectData> {
        let mut project = serde_json::to_value(self.get_project(project_id)?)?;
        if let Some(object) = project.as_object_mut() {
            object.remove("lastBackupAt");
            object.remove("backupSchedule");
        }
        let mut collections = BTreeMap::new();
        for (collection, _, _) in PROJECT_COLLECTIONS {
            collections.insert(
                collection.to_owned(),
                self.load_project_json_rows(collection_table(collection), project_id)?,
            );
        }
        let data = ProjectData {
            project,
            collections,
        };
        data.validate()?;
        Ok(data)
    }

    pub fn replace_project_data(&mut self, data: &ProjectData, overwrite: bool) -> CoreResult<()> {
        self.replace_project_data_internal(data, overwrite, None)
    }

    pub fn replace_project_data_if_revision(
        &mut self,
        data: &ProjectData,
        overwrite: bool,
        expected_revision: i64,
    ) -> CoreResult<()> {
        self.replace_project_data_internal(data, overwrite, Some(expected_revision))
    }

    fn replace_project_data_internal(
        &mut self,
        data: &ProjectData,
        overwrite: bool,
        expected_revision: Option<i64>,
    ) -> CoreResult<()> {
        data.validate()?;
        let project_id = data.project_id()?.to_owned();
        let exists = self
            .connection
            .query_row(
                "SELECT 1 FROM projects WHERE id = ?1",
                [&project_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists && !overwrite {
            return Err(CoreError::Conflict(format!(
                "project already exists: {project_id}"
            )));
        }

        let mut project = data.project.clone();
        let project_object = project
            .as_object_mut()
            .ok_or_else(|| CoreError::Validation("project must be an object".to_owned()))?;
        if exists {
            let local = serde_json::to_value(self.get_project(&project_id)?)?;
            for key in ["lastBackupAt", "backupSchedule"] {
                if let Some(value) = local.get(key) {
                    project_object.insert(key.to_owned(), value.clone());
                }
            }
        } else {
            project_object.remove("lastBackupAt");
            project_object.insert("backupSchedule".to_owned(), json!("off"));
        }

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, expected_revision)?;
        if exists {
            // Archives omit local snapshots and audit history. Keep the project row so
            // its delete cascade cannot erase those local-only collections.
            for (collection, _, _) in PROJECT_COLLECTIONS {
                let table = collection_table(collection);
                transaction.execute(
                    &format!("DELETE FROM {table} WHERE project_id = ?1"),
                    [&project_id],
                )?;
            }
            upsert_project_json(&transaction, &project)?;
        } else {
            insert_project_json(&transaction, &project)?;
        }
        for (collection, _, _) in PROJECT_COLLECTIONS {
            let table = collection_table(collection);
            let entities = data
                .collections
                .get(collection)
                .expect("project collections validated");
            for entity in entities {
                insert_entity_json(&transaction, table, entity)?;
            }
        }
        transaction.execute(
            "DELETE FROM snapshot_payloads
             WHERE snapshot_id NOT IN (SELECT id FROM snapshots)",
            [],
        )?;
        bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn load_normalized_state(&self) -> CoreResult<Option<NormalizedState>> {
        let projects = self.load_json_rows("projects")?;
        if projects.is_empty() && !state_initialized(&self.connection)? {
            return Ok(None);
        }
        let mut state = Map::new();
        state.insert("schemaVersion".to_owned(), json!(NORMALIZED_STATE_VERSION));
        state.insert("projects".to_owned(), Value::Array(projects));
        for (collection, table) in ENTITY_COLLECTIONS {
            state.insert(
                collection.to_owned(),
                Value::Array(self.load_json_rows(table)?),
            );
        }

        let mut payloads = Map::new();
        let mut statement = self.connection.prepare(
            "SELECT snapshot_id, payload_json FROM snapshot_payloads ORDER BY snapshot_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, payload) = row?;
            payloads.insert(id, serde_json::from_str(&payload)?);
        }

        Ok(Some(NormalizedState {
            state_json: Value::Object(state).to_string(),
            snapshot_payloads_json: Value::Object(payloads).to_string(),
        }))
    }

    pub fn synchronize_normalized_state(
        &mut self,
        state_json: &str,
        snapshot_payloads_json: &str,
    ) -> CoreResult<()> {
        self.synchronize_normalized_state_internal(state_json, snapshot_payloads_json, None)?;
        Ok(())
    }

    pub fn synchronize_normalized_state_if_revision(
        &mut self,
        state_json: &str,
        snapshot_payloads_json: &str,
        expected_revision: i64,
    ) -> CoreResult<i64> {
        self.synchronize_normalized_state_internal(
            state_json,
            snapshot_payloads_json,
            Some(expected_revision),
        )
    }

    pub fn create_snapshot_if_revision(
        &mut self,
        snapshot: &Value,
        payload: &Value,
        expected_revision: i64,
    ) -> CoreResult<i64> {
        let snapshot_id = required_string(snapshot, "id")?;
        let project_id = required_string(snapshot, "projectId")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, Some(expected_revision))?;
        let project_exists = transaction
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [project_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !project_exists {
            return Err(CoreError::NotFound {
                entity: "project",
                id: project_id.to_owned(),
            });
        }
        insert_entity_json(&transaction, "snapshots", snapshot)?;
        transaction.execute(
            "INSERT INTO snapshot_payloads(snapshot_id, payload_json) VALUES (?1, ?2)",
            params![snapshot_id, serde_json::to_string(payload)?],
        )?;
        let revision = bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(revision)
    }

    pub fn replace_attachment_role_if_revision(
        &mut self,
        attachment: &Value,
        link: &Value,
        expected_revision: i64,
    ) -> CoreResult<i64> {
        let attachment_id = required_string(attachment, "id")?;
        let project_id = required_string(attachment, "projectId")?;
        let link_attachment_id = required_string(link, "attachmentId")?;
        if link_attachment_id != attachment_id {
            return Err(CoreError::Validation(
                "attachment link must reference the imported attachment".to_owned(),
            ));
        }
        if required_string(link, "projectId")? != project_id {
            return Err(CoreError::Validation(
                "attachment and link must belong to the same project".to_owned(),
            ));
        }
        let target_type = required_string(link, "targetType")?;
        let target_id = required_string(link, "targetId")?;
        let role = required_string(link, "role")?;

        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_expected_revision(&transaction, Some(expected_revision))?;
        let project_exists = transaction
            .query_row("SELECT 1 FROM projects WHERE id = ?1", [project_id], |_| {
                Ok(())
            })
            .optional()?
            .is_some();
        if !project_exists {
            return Err(CoreError::NotFound {
                entity: "project",
                id: project_id.to_owned(),
            });
        }

        let mut statement = transaction
            .prepare("SELECT id, data_json FROM attachment_links WHERE project_id = ?1")?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut replaced_attachment_ids = Vec::new();
        for (id, raw) in rows {
            let existing: Value = serde_json::from_str(&raw)?;
            if existing.get("targetType").and_then(Value::as_str) == Some(target_type)
                && existing.get("targetId").and_then(Value::as_str) == Some(target_id)
                && existing.get("role").and_then(Value::as_str) == Some(role)
            {
                if let Some(id) = existing.get("attachmentId").and_then(Value::as_str) {
                    replaced_attachment_ids.push(id.to_owned());
                }
                transaction.execute("DELETE FROM attachment_links WHERE id = ?1", [id])?;
            }
        }

        upsert_entity_json(&transaction, "attachments", attachment)?;
        upsert_entity_json(&transaction, "attachment_links", link)?;

        let mut statement = transaction.prepare("SELECT data_json FROM attachment_links")?;
        let linked_attachment_ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| {
                let raw = row?;
                let value: Value = serde_json::from_str(&raw)?;
                Ok(value
                    .get("attachmentId")
                    .and_then(Value::as_str)
                    .map(str::to_owned))
            })
            .collect::<CoreResult<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<std::collections::HashSet<_>>();
        drop(statement);
        for replaced_id in replaced_attachment_ids {
            if replaced_id != attachment_id && !linked_attachment_ids.contains(&replaced_id) {
                transaction.execute("DELETE FROM attachments WHERE id = ?1", [replaced_id])?;
            }
        }

        let revision = bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(revision)
    }

    fn synchronize_normalized_state_internal(
        &mut self,
        state_json: &str,
        snapshot_payloads_json: &str,
        expected_revision: Option<i64>,
    ) -> CoreResult<i64> {
        let (state, payloads) = parse_state_payload(state_json, snapshot_payloads_json)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let actual_revision = read_data_revision(&transaction)?;
        if let Some(expected_revision) = expected_revision {
            if actual_revision != expected_revision {
                return Err(CoreError::RevisionConflict {
                    expected: expected_revision,
                    actual: actual_revision,
                });
            }
        }
        synchronize_normalized_state(&transaction, &state, &payloads)?;
        let revision = bump_data_revision(&transaction)?;
        transaction.commit()?;
        Ok(revision)
    }

    fn load_json_rows(&self, table: &str) -> CoreResult<Vec<Value>> {
        let mut statement = self
            .connection
            .prepare(&format!("SELECT data_json FROM {table} ORDER BY rowid"))?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let value = row?;
            serde_json::from_str(&value).map_err(CoreError::from)
        })
        .collect()
    }

    fn load_project_json_rows(&self, table: &str, project_id: &str) -> CoreResult<Vec<Value>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT data_json FROM {table} WHERE project_id = ?1 ORDER BY id"
        ))?;
        let rows = statement.query_map([project_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let value = row?;
            serde_json::from_str(&value).map_err(CoreError::from)
        })
        .collect()
    }
}

#[derive(Clone, Debug)]
struct DeleteMutation {
    table: &'static str,
    entity_type: &'static str,
    id: String,
    before: Value,
    after: Option<Value>,
}

#[derive(Clone, Debug)]
struct RecordDeletePlan {
    project_id: String,
    target_type: &'static str,
    target_id: String,
    mutations: Vec<DeleteMutation>,
}

impl RecordDeletePlan {
    fn impact(&self) -> Vec<Value> {
        self.mutations
            .iter()
            .filter(|mutation| {
                mutation.entity_type != self.target_type || mutation.id != self.target_id
            })
            .map(|mutation| {
                json!({
                    "resource": collection_name(mutation.table),
                    "id": mutation.id,
                    "action": if mutation.after.is_some() { "update" } else { "delete" },
                })
            })
            .collect()
    }
}

const DELETE_PLAN_TABLES: [(&str, &str); 12] = [
    ("people", "person"),
    ("organizations", "organization"),
    ("careers", "career"),
    ("person_titles", "title"),
    ("relationships", "relationship"),
    ("events", "event"),
    ("places", "place"),
    ("sources", "source"),
    ("citations", "citation"),
    ("attachments", "attachment"),
    ("attachment_links", "attachmentLink"),
    ("issues", "issue"),
];

fn collection_name(table: &str) -> &str {
    match table {
        "person_titles" => "personTitles",
        "attachment_links" => "attachmentLinks",
        other => other,
    }
}

fn plan_record_deletion(
    connection: &Connection,
    resource: Resource,
    id: &str,
) -> CoreResult<RecordDeletePlan> {
    let target = connection
        .query_row(
            &format!("SELECT data_json FROM {} WHERE id = ?1", resource.table()),
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| CoreError::NotFound {
            entity: "record",
            id: id.to_owned(),
        })?;
    let target: Value = serde_json::from_str(&target)?;
    let project_id = required_string(&target, "projectId")?.to_owned();
    let target_type = resource.as_str();

    let mut records = BTreeMap::<(&'static str, String), Value>::new();
    for (table, entity_type) in DELETE_PLAN_TABLES {
        let mut statement = connection.prepare(&format!(
            "SELECT id, data_json FROM {table} WHERE project_id = ?1 ORDER BY id"
        ))?;
        let rows = statement.query_map([&project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (record_id, raw) = row?;
            records.insert((entity_type, record_id), serde_json::from_str(&raw)?);
        }
    }

    let mut deleted = BTreeSet::from([(target_type, id.to_owned())]);
    loop {
        let mut newly_deleted = Vec::new();
        for ((entity_type, record_id), record) in &records {
            if deleted.contains(&(*entity_type, record_id.clone())) {
                continue;
            }
            if should_cascade_delete(entity_type, record, &deleted) {
                newly_deleted.push((*entity_type, record_id.clone()));
            }
        }
        if newly_deleted.is_empty() {
            break;
        }
        deleted.extend(newly_deleted);
    }

    let mut mutations = Vec::new();
    for ((entity_type, record_id), before) in records {
        if deleted.contains(&(entity_type, record_id.clone())) {
            let table = table_for_entity_type(entity_type);
            mutations.push(DeleteMutation {
                table,
                entity_type,
                id: record_id,
                before,
                after: None,
            });
            continue;
        }
        let mut after = before.clone();
        rewrite_deleted_references(entity_type, &mut after, &deleted);
        if after != before {
            mutations.push(DeleteMutation {
                table: table_for_entity_type(entity_type),
                entity_type,
                id: record_id,
                before,
                after: Some(after),
            });
        }
    }

    if deleted.contains(&("person", id.to_owned())) {
        let raw = connection.query_row(
            "SELECT data_json FROM projects WHERE id = ?1",
            [&project_id],
            |row| row.get::<_, String>(0),
        )?;
        let before: Value = serde_json::from_str(&raw)?;
        let mut after = before.clone();
        remove_field_if_deleted(&mut after, "defaultPersonId", "person", &deleted);
        if after != before {
            mutations.push(DeleteMutation {
                table: "projects",
                entity_type: "project",
                id: project_id.clone(),
                before,
                after: Some(after),
            });
        }
    }

    mutations.sort_by(|left, right| {
        let left_target = left.entity_type == target_type && left.id == id;
        let right_target = right.entity_type == target_type && right.id == id;
        left_target
            .cmp(&right_target)
            .then_with(|| left.table.cmp(right.table))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(RecordDeletePlan {
        project_id,
        target_type,
        target_id: id.to_owned(),
        mutations,
    })
}

fn should_cascade_delete(
    entity_type: &str,
    record: &Value,
    deleted: &BTreeSet<(&'static str, String)>,
) -> bool {
    match entity_type {
        "relationship" => {
            field_is_deleted(record, "fromPersonId", "person", deleted)
                || field_is_deleted(record, "toPersonId", "person", deleted)
        }
        "career" => field_is_deleted(record, "personId", "person", deleted),
        "title" => field_is_deleted(record, "personId", "person", deleted),
        "citation" => {
            field_is_deleted(record, "sourceId", "source", deleted)
                || typed_target_is_deleted(record, deleted)
        }
        "attachmentLink" => {
            field_is_deleted(record, "attachmentId", "attachment", deleted)
                || typed_target_is_deleted(record, deleted)
        }
        "issue" => typed_target_is_deleted(record, deleted),
        _ => false,
    }
}

fn typed_target_is_deleted(record: &Value, deleted: &BTreeSet<(&'static str, String)>) -> bool {
    let Some(target_type) = record.get("targetType").and_then(Value::as_str) else {
        return false;
    };
    let Some(target_id) = record.get("targetId").and_then(Value::as_str) else {
        return false;
    };
    let Some(target_type) = canonical_target_type(target_type) else {
        return false;
    };
    deleted.contains(&(target_type, target_id.to_owned()))
}

fn canonical_target_type(value: &str) -> Option<&'static str> {
    match value {
        "person" => Some("person"),
        "organization" => Some("organization"),
        "career" => Some("career"),
        "title" | "personTitle" => Some("title"),
        "relationship" => Some("relationship"),
        "event" => Some("event"),
        "place" => Some("place"),
        "source" => Some("source"),
        "citation" => Some("citation"),
        "attachment" => Some("attachment"),
        "project" => Some("project"),
        _ => None,
    }
}

fn rewrite_deleted_references(
    entity_type: &str,
    record: &mut Value,
    deleted: &BTreeSet<(&'static str, String)>,
) {
    match entity_type {
        "person" => {
            remove_field_if_deleted(record, "birthPlaceId", "place", deleted);
            remove_field_if_deleted(record, "deathPlaceId", "place", deleted);
            remove_deleted_array_values(record, "sourceIds", "source", deleted);
        }
        "organization" => {
            remove_field_if_deleted(record, "parentId", "organization", deleted);
            remove_field_if_deleted(record, "placeId", "place", deleted);
            remove_deleted_array_values(record, "sourceIds", "source", deleted);
        }
        "career" => {
            remove_field_if_deleted(record, "organizationId", "organization", deleted);
            remove_field_if_deleted(record, "jurisdictionPlaceId", "place", deleted);
            remove_field_if_deleted(record, "appointedByPersonId", "person", deleted);
            remove_deleted_array_values(record, "sourceIds", "source", deleted);
        }
        "title" => {
            remove_field_if_deleted(record, "placeId", "place", deleted);
            remove_field_if_deleted(record, "grantedByPersonId", "person", deleted);
            remove_deleted_array_values(record, "sourceIds", "source", deleted);
        }
        "relationship" => {
            remove_field_if_deleted(record, "placeId", "place", deleted);
            remove_deleted_array_values(record, "sourceIds", "source", deleted);
        }
        "event" => {
            remove_field_if_deleted(record, "placeId", "place", deleted);
            remove_deleted_array_values(record, "participantIds", "person", deleted);
            remove_deleted_map_keys(record, "participantRoles", "person", deleted);
            remove_deleted_array_values(record, "sourceIds", "source", deleted);
        }
        "place" => remove_field_if_deleted(record, "parentId", "place", deleted),
        _ => {}
    }
}

fn field_is_deleted(
    record: &Value,
    field: &str,
    entity_type: &'static str,
    deleted: &BTreeSet<(&'static str, String)>,
) -> bool {
    record
        .get(field)
        .and_then(Value::as_str)
        .is_some_and(|id| deleted.contains(&(entity_type, id.to_owned())))
}

fn remove_field_if_deleted(
    record: &mut Value,
    field: &str,
    entity_type: &'static str,
    deleted: &BTreeSet<(&'static str, String)>,
) {
    if field_is_deleted(record, field, entity_type, deleted) {
        record.as_object_mut().map(|object| object.remove(field));
    }
}

fn remove_deleted_array_values(
    record: &mut Value,
    field: &str,
    entity_type: &'static str,
    deleted: &BTreeSet<(&'static str, String)>,
) {
    if let Some(values) = record.get_mut(field).and_then(Value::as_array_mut) {
        values.retain(|value| {
            value
                .as_str()
                .is_none_or(|id| !deleted.contains(&(entity_type, id.to_owned())))
        });
    }
}

fn remove_deleted_map_keys(
    record: &mut Value,
    field: &str,
    entity_type: &'static str,
    deleted: &BTreeSet<(&'static str, String)>,
) {
    if let Some(values) = record.get_mut(field).and_then(Value::as_object_mut) {
        values.retain(|id, _| !deleted.contains(&(entity_type, id.to_owned())));
    }
}

fn table_for_entity_type(entity_type: &str) -> &'static str {
    DELETE_PLAN_TABLES
        .iter()
        .find_map(|(table, candidate)| (*candidate == entity_type).then_some(*table))
        .expect("delete plan entity type has a table")
}

fn apply_record_deletion(
    transaction: &Transaction<'_>,
    plan: &RecordDeletePlan,
    timestamp: &str,
) -> CoreResult<()> {
    for mutation in &plan.mutations {
        if let Some(mut after) = mutation.after.clone() {
            if let Some(object) = after.as_object_mut() {
                object.insert("updatedAt".to_owned(), json!(timestamp));
            }
            if mutation.table == "projects" {
                transaction.execute(
                    "UPDATE projects SET data_json = ?1, revision = revision + 1,
                     updated_at = ?2 WHERE id = ?3",
                    params![serde_json::to_string(&after)?, timestamp, mutation.id],
                )?;
            } else {
                transaction.execute(
                    &format!(
                        "UPDATE {} SET data_json = ?1, revision = revision + 1,
                         updated_at = ?2 WHERE id = ?3",
                        mutation.table
                    ),
                    params![serde_json::to_string(&after)?, timestamp, mutation.id],
                )?;
            }
        } else {
            transaction.execute(
                &format!("DELETE FROM {} WHERE id = ?1", mutation.table),
                [&mutation.id],
            )?;
        }
    }
    Ok(())
}

fn insert_record_delete_change_set(
    transaction: &Transaction<'_>,
    resource: Resource,
    entity_id: &str,
    project_id: &str,
    plan: &RecordDeletePlan,
    source: &str,
    created_at: &str,
) -> CoreResult<String> {
    if !matches!(source, "desktop" | "cli") {
        return Err(CoreError::Validation(format!(
            "unsupported change-set source: {source}"
        )));
    }
    let change_set_id = Uuid::new_v4().to_string();
    let summary = json!({
        "target": { "resource": resource.as_str(), "id": entity_id },
        "affected": [{ "resource": resource.as_str(), "id": entity_id, "action": "delete" }],
        "cascade": plan.impact(),
        "warnings": [],
    });
    transaction.execute(
        "INSERT INTO change_sets(
            id, project_id, source, operation, created_at, revertible, summary_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        params![
            change_set_id,
            project_id,
            source,
            format!("{}.delete", resource.as_str()),
            created_at,
            serde_json::to_string(&summary)?,
        ],
    )?;
    for mutation in &plan.mutations {
        transaction.execute(
            "INSERT INTO change_items(
                id, change_set_id, entity_type, entity_id, action, before_json, after_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                Uuid::new_v4().to_string(),
                change_set_id,
                mutation.entity_type,
                mutation.id,
                if mutation.after.is_some() {
                    "update"
                } else {
                    "delete"
                },
                serde_json::to_string(&mutation.before)?,
                mutation
                    .after
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
            ],
        )?;
    }
    Ok(change_set_id)
}

fn read_data_revision(connection: &Connection) -> CoreResult<i64> {
    let raw: String = connection.query_row(
        "SELECT value FROM branchloom_metadata WHERE key = 'data_revision'",
        [],
        |row| row.get(0),
    )?;
    raw.parse::<i64>()
        .map_err(|_| CoreError::Validation("database data_revision metadata is invalid".to_owned()))
}

fn ensure_expected_revision(
    connection: &Connection,
    expected_revision: Option<i64>,
) -> CoreResult<()> {
    if let Some(expected_revision) = expected_revision {
        let actual_revision = read_data_revision(connection)?;
        if actual_revision != expected_revision {
            return Err(CoreError::RevisionConflict {
                expected: expected_revision,
                actual: actual_revision,
            });
        }
    }
    Ok(())
}

fn record_json(
    transaction: &Transaction<'_>,
    resource: Resource,
    id: &str,
) -> CoreResult<Option<Value>> {
    let sql = format!("SELECT data_json FROM {} WHERE id = ?1", resource.table());
    transaction
        .query_row(&sql, [id], |row| row.get::<_, String>(0))
        .optional()?
        .map(|raw| serde_json::from_str(&raw))
        .transpose()
        .map_err(CoreError::from)
}

#[allow(clippy::too_many_arguments)]
fn insert_change_set(
    transaction: &Transaction<'_>,
    resource: Resource,
    entity_id: &str,
    project_id: &str,
    action: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    source: &str,
    revertible: bool,
    created_at: &str,
) -> CoreResult<String> {
    if !matches!(source, "desktop" | "cli") {
        return Err(CoreError::Validation(format!(
            "unsupported change-set source: {source}"
        )));
    }
    let change_set_id = Uuid::new_v4().to_string();
    let change_item_id = Uuid::new_v4().to_string();
    let operation = format!("{}.{}", resource.as_str(), action);
    let summary = json!({
        "target": { "resource": resource.as_str(), "id": entity_id },
        "affected": [{ "resource": resource.as_str(), "id": entity_id, "action": action }],
        "cascade": [],
        "warnings": []
    });
    transaction.execute(
        "INSERT INTO change_sets(
            id, project_id, source, operation, created_at, revertible, summary_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            change_set_id,
            project_id,
            source,
            operation,
            created_at,
            i64::from(revertible),
            serde_json::to_string(&summary)?,
        ],
    )?;
    transaction.execute(
        "INSERT INTO change_items(
            id, change_set_id, entity_type, entity_id, action, before_json, after_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            change_item_id,
            change_set_id,
            resource.as_str(),
            entity_id,
            action,
            before.map(serde_json::to_string).transpose()?,
            after.map(serde_json::to_string).transpose()?,
        ],
    )?;
    Ok(change_set_id)
}

fn insert_batch_change_set(
    transaction: &Transaction<'_>,
    project_id: &str,
    records: &[(Resource, &str, Value)],
    source: &str,
    created_at: &str,
) -> CoreResult<String> {
    if source != "cli" {
        return Err(CoreError::Validation(format!(
            "unsupported batch change-set source: {source}"
        )));
    }
    let change_set_id = Uuid::new_v4().to_string();
    let affected = records
        .iter()
        .map(|(resource, action, record)| {
            json!({
                "resource": resource.as_str(),
                "id": record["id"],
                "action": action,
            })
        })
        .collect::<Vec<_>>();
    let summary = json!({
        "target": { "resource": "project", "id": project_id },
        "affected": affected,
        "cascade": [],
        "warnings": []
    });
    transaction.execute(
        "INSERT INTO change_sets(
            id, project_id, source, operation, created_at, revertible, summary_json
         ) VALUES (?1, ?2, ?3, 'batch.run', ?4, 1, ?5)",
        params![
            change_set_id,
            project_id,
            source,
            created_at,
            serde_json::to_string(&summary)?,
        ],
    )?;
    for (resource, action, record) in records {
        transaction.execute(
            "INSERT INTO change_items(
                id, change_set_id, entity_type, entity_id, action, before_json, after_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
            params![
                Uuid::new_v4().to_string(),
                change_set_id,
                resource.as_str(),
                required_string(record, "id")?,
                action,
                serde_json::to_string(record)?,
            ],
        )?;
    }
    Ok(change_set_id)
}

fn bump_data_revision(transaction: &Transaction<'_>) -> CoreResult<i64> {
    mark_state_initialized(transaction)?;
    transaction.execute(
        "UPDATE branchloom_metadata
         SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
         WHERE key = 'data_revision'",
        [],
    )?;
    read_data_revision(transaction)
}

fn state_initialized(connection: &Connection) -> CoreResult<bool> {
    let value: String = connection.query_row(
        "SELECT value FROM branchloom_metadata WHERE key = 'state_initialized'",
        [],
        |row| row.get(0),
    )?;
    Ok(value == "1")
}

fn mark_state_initialized(connection: &Connection) -> CoreResult<()> {
    connection.execute(
        "UPDATE branchloom_metadata SET value = '1' WHERE key = 'state_initialized'",
        [],
    )?;
    Ok(())
}

fn load_project(connection: &Connection, id: &str) -> CoreResult<ProjectRecord> {
    connection
        .query_row(
            "SELECT data_json FROM projects WHERE id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .map(|value| serde_json::from_str(&value))
        .transpose()?
        .ok_or_else(|| CoreError::NotFound {
            entity: "project",
            id: id.to_owned(),
        })
}

fn parse_state_payload(
    state_json: &str,
    snapshot_payloads_json: &str,
) -> CoreResult<(Value, Value)> {
    let state: Value = serde_json::from_str(state_json)?;
    if state.get("schemaVersion").and_then(Value::as_u64) != Some(NORMALIZED_STATE_VERSION) {
        return Err(CoreError::Validation(format!(
            "application state schemaVersion must be {NORMALIZED_STATE_VERSION}"
        )));
    }
    for (collection, _) in ENTITY_COLLECTIONS {
        required_array(&state, collection)?;
    }
    required_array(&state, "projects")?;
    let payloads: Value = serde_json::from_str(snapshot_payloads_json)?;
    if !payloads.is_object() {
        return Err(CoreError::Validation(
            "snapshot payloads must be a JSON object".to_owned(),
        ));
    }
    Ok((state, payloads))
}

fn insert_normalized_state(
    transaction: &Transaction<'_>,
    state: &Value,
    payloads: &Value,
) -> CoreResult<()> {
    for project in required_array(state, "projects")? {
        insert_project_json(transaction, project)?;
    }
    for (collection, table) in ENTITY_COLLECTIONS {
        for entity in required_array(state, collection)? {
            insert_entity_json(transaction, table, entity)?;
        }
    }
    for (snapshot_id, payload) in payloads
        .as_object()
        .expect("snapshot payload object validated before insert")
    {
        transaction.execute(
            "INSERT INTO snapshot_payloads(snapshot_id, payload_json) VALUES (?1, ?2)",
            params![snapshot_id, serde_json::to_string(payload)?],
        )?;
    }
    Ok(())
}

fn synchronize_normalized_state(
    transaction: &Transaction<'_>,
    state: &Value,
    payloads: &Value,
) -> CoreResult<()> {
    let projects = required_array(state, "projects")?;
    delete_missing_rows(transaction, "projects", projects)?;
    for project in projects {
        upsert_project_json(transaction, project)?;
    }
    for (collection, table) in ENTITY_COLLECTIONS {
        let entities = required_array(state, collection)?;
        delete_missing_rows(transaction, table, entities)?;
        for entity in entities {
            upsert_entity_json(transaction, table, entity)?;
        }
    }

    let payload_object = payloads
        .as_object()
        .expect("snapshot payload object validated before synchronization");
    let mut statement = transaction.prepare("SELECT snapshot_id FROM snapshot_payloads")?;
    let existing = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for snapshot_id in existing {
        if !payload_object.contains_key(&snapshot_id) {
            transaction.execute(
                "DELETE FROM snapshot_payloads WHERE snapshot_id = ?1",
                [&snapshot_id],
            )?;
        }
    }
    for (snapshot_id, payload) in payload_object {
        transaction.execute(
            "INSERT INTO snapshot_payloads(snapshot_id, payload_json) VALUES (?1, ?2)
             ON CONFLICT(snapshot_id) DO UPDATE SET payload_json = excluded.payload_json
             WHERE snapshot_payloads.payload_json <> excluded.payload_json",
            params![snapshot_id, serde_json::to_string(payload)?],
        )?;
    }
    Ok(())
}

fn delete_missing_rows(
    transaction: &Transaction<'_>,
    table: &str,
    incoming: &[Value],
) -> CoreResult<()> {
    let incoming_ids = incoming
        .iter()
        .map(|value| required_string(value, "id"))
        .collect::<CoreResult<std::collections::BTreeSet<_>>>()?;
    let mut statement = transaction.prepare(&format!("SELECT id FROM {table}"))?;
    let existing = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for id in existing {
        if !incoming_ids.contains(id.as_str()) {
            transaction.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [&id])?;
        }
    }
    Ok(())
}

fn required_array<'a>(state: &'a Value, key: &str) -> CoreResult<&'a Vec<Value>> {
    state
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Validation(format!("{key} must be an array")))
}

fn collection_table(collection: &str) -> &'static str {
    match collection {
        "people" => "people",
        "organizations" => "organizations",
        "careers" => "careers",
        "personTitles" => "person_titles",
        "relationships" => "relationships",
        "events" => "events",
        "places" => "places",
        "sources" => "sources",
        "citations" => "citations",
        "attachments" => "attachments",
        "attachmentLinks" => "attachment_links",
        "issues" => "issues",
        _ => unreachable!("unsupported project collection"),
    }
}

fn insert_project_json(transaction: &Transaction<'_>, value: &Value) -> CoreResult<()> {
    let id = required_string(value, "id")?;
    let name = required_string(value, "name")?;
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let created_at = required_string(value, "createdAt")?;
    let updated_at = required_string(value, "updatedAt")?;
    transaction.execute(
        "INSERT INTO projects(
            id, name, description, data_json, revision, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
        params![
            id,
            name,
            description,
            serde_json::to_string(value)?,
            created_at,
            updated_at
        ],
    )?;
    Ok(())
}

fn upsert_project_json(transaction: &Transaction<'_>, value: &Value) -> CoreResult<()> {
    let id = required_string(value, "id")?;
    let name = required_string(value, "name")?;
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let created_at = required_string(value, "createdAt")?;
    let updated_at = required_string(value, "updatedAt")?;
    transaction.execute(
        "INSERT INTO projects(
            id, name, description, data_json, revision, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            data_json = excluded.data_json,
            revision = projects.revision + 1,
            updated_at = excluded.updated_at
         WHERE projects.data_json <> excluded.data_json",
        params![
            id,
            name,
            description,
            serde_json::to_string(value)?,
            created_at,
            updated_at
        ],
    )?;
    Ok(())
}

fn insert_entity_json(transaction: &Transaction<'_>, table: &str, value: &Value) -> CoreResult<()> {
    let id = required_string(value, "id")?;
    let project_id = if table == "issues" {
        value.get("projectId").and_then(Value::as_str)
    } else {
        Some(required_string(value, "projectId")?)
    };
    let timestamp = value
        .get("updatedAt")
        .or_else(|| value.get("createdAt"))
        .and_then(Value::as_str)
        .unwrap_or("1970-01-01T00:00:00.000Z");
    let sql = format!(
        "INSERT INTO {table}(id, project_id, data_json, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)"
    );
    transaction.execute(
        &sql,
        params![id, project_id, serde_json::to_string(value)?, timestamp],
    )?;
    Ok(())
}

fn upsert_entity_json(transaction: &Transaction<'_>, table: &str, value: &Value) -> CoreResult<()> {
    let id = required_string(value, "id")?;
    let project_id = if table == "issues" {
        value.get("projectId").and_then(Value::as_str)
    } else {
        Some(required_string(value, "projectId")?)
    };
    let timestamp = value
        .get("updatedAt")
        .or_else(|| value.get("createdAt"))
        .and_then(Value::as_str)
        .unwrap_or("1970-01-01T00:00:00.000Z");
    let sql = format!(
        "INSERT INTO {table}(id, project_id, data_json, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)
         ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            data_json = excluded.data_json,
            revision = {table}.revision + 1,
            updated_at = excluded.updated_at
         WHERE {table}.data_json <> excluded.data_json
            OR {table}.project_id IS NOT excluded.project_id"
    );
    transaction.execute(
        &sql,
        params![id, project_id, serde_json::to_string(value)?, timestamp],
    )?;
    Ok(())
}

fn required_string<'a>(value: &'a Value, key: &str) -> CoreResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Validation(format!("{key} must be a string")))
}

fn require_name(name: String) -> CoreResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::Validation(
            "project name must not be empty".to_owned(),
        ));
    }
    Ok(name.to_owned())
}

fn utc_timestamp() -> CoreResult<String> {
    Ok(OffsetDateTime::now_utc().format(&Rfc3339)?)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn migrates_a_new_database_to_the_current_schema() {
        let storage = Storage::open_in_memory().expect("open migrated database");
        assert_eq!(
            storage.schema_version().expect("read schema version"),
            CURRENT_SCHEMA_VERSION
        );
        let app_state_count: i64 = storage
            .connection
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'app_state'",
                [],
                |row| row.get(0),
            )
            .expect("inspect app_state table");
        assert_eq!(app_state_count, 0);
    }

    #[test]
    fn creates_and_renames_a_project_without_changing_its_stable_id() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let created = storage
            .create_project(NewProject {
                name: "  林氏家谱  ".to_owned(),
                description: " 初始资料 ".to_owned(),
            })
            .expect("create project");
        let updated = storage
            .update_project(
                &created.id,
                ProjectPatch {
                    name: "林氏家族档案".to_owned(),
                    description: "整理中".to_owned(),
                },
            )
            .expect("rename project");
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "林氏家族档案");
    }

    #[test]
    fn project_delete_reports_and_removes_snapshot_payloads() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let mut state = test_state();
        state["projects"][0]["coverUrl"] = Value::Null;
        state["projects"][0]["defaultPersonId"] = Value::Null;
        state["projects"][0]["lastBackupAt"] = Value::Null;
        state["projects"][0]["backupSchedule"] = json!("weekly");
        state["snapshots"] = json!([{
            "id": "snapshot-test",
            "projectId": "project-test",
            "createdAt": "2026-01-02T00:00:00.000Z",
            "updatedAt": "2026-01-02T00:00:00.000Z"
        }]);
        let payloads = json!({ "snapshot-test": state.clone() });
        storage
            .synchronize_normalized_state(&state.to_string(), &payloads.to_string())
            .expect("save project with snapshot payload");

        let impact = storage
            .project_delete_impact("project-test")
            .expect("preview project deletion");
        assert!(impact
            .iter()
            .any(|item| { item["resource"] == "snapshots" && item["count"] == 1 }));
        assert!(impact
            .iter()
            .any(|item| { item["resource"] == "snapshotPayloads" && item["count"] == 1 }));

        storage
            .delete_project("project-test")
            .expect("delete project");
        let payload_count: i64 = storage
            .connection
            .query_row("SELECT count(*) FROM snapshot_payloads", [], |row| {
                row.get(0)
            })
            .expect("count remaining payloads");
        assert_eq!(payload_count, 0);
    }

    #[test]
    fn normalized_state_round_trips_without_an_app_state_blob() {
        let directory = tempdir().expect("create temp directory");
        let mut storage =
            Storage::open(directory.path().join("branchloom.sqlite3")).expect("open storage");
        let state = json!({
            "schemaVersion": 2,
            "projects": [{
                "id": "project-test",
                "name": "Test",
                "description": "",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }],
            "people": [{
                "id": "person-test",
                "projectId": "project-test",
                "names": [],
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }],
            "organizations": [],
            "careers": [],
            "personTitles": [],
            "relationships": [],
            "events": [],
            "places": [],
            "sources": [],
            "citations": [],
            "attachments": [],
            "attachmentLinks": [],
            "snapshots": [],
            "issues": []
        });
        storage
            .synchronize_normalized_state(&state.to_string(), "{}")
            .expect("save normalized state");
        let loaded = storage
            .load_normalized_state()
            .expect("load normalized state")
            .expect("state exists");
        let loaded: Value = serde_json::from_str(&loaded.state_json).expect("parse state");
        assert_eq!(loaded["people"][0]["id"], "person-test");
    }

    #[test]
    fn revision_guard_rejects_a_stale_full_state_without_overwriting_newer_data() {
        let mut storage = Storage::open_in_memory().expect("open database");
        assert_eq!(storage.data_revision().expect("initial revision"), 0);
        let first_revision = storage
            .synchronize_normalized_state_if_revision(&test_state().to_string(), "{}", 0)
            .expect("install initial state");
        assert_eq!(first_revision, 1);
        storage
            .put_record(
                Resource::Person,
                "person-external",
                "project-test",
                &json!({
                    "id": "person-external",
                    "projectId": "project-test",
                    "names": [],
                    "updatedAt": "2026-01-02T00:00:00.000Z"
                }),
            )
            .expect("write external record");

        let stale = storage.synchronize_normalized_state_if_revision(
            &test_state().to_string(),
            "{}",
            first_revision,
        );
        assert!(matches!(stale, Err(CoreError::RevisionConflict { .. })));
        assert!(storage
            .get_record(Resource::Person, "person-external")
            .expect("read external record")
            .is_some());
        assert_eq!(storage.data_revision().expect("latest revision"), 2);
    }

    #[test]
    fn cli_batch_rolls_back_every_record_and_creates_one_change_set() {
        let mut storage = Storage::open_in_memory().expect("open database");
        storage
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let revision = storage.data_revision().expect("read revision");
        let person = json!({
            "id": "person-one",
            "projectId": "project-test",
            "names": [{ "value": "One", "type": "personal", "primary": true }],
            "updatedAt": "2030-01-02T03:04:05Z"
        });
        let duplicate = person.clone();
        let failed = storage.insert_cli_batch_if_revision(
            "project-test",
            &[
                (Resource::Person, "create", person.clone()),
                (Resource::Person, "create", duplicate),
            ],
            revision,
        );
        assert!(matches!(failed, Err(CoreError::Validation(_))));
        assert!(storage
            .get_record(Resource::Person, "person-one")
            .expect("read rolled-back person")
            .is_none());
        assert_eq!(storage.data_revision().unwrap(), revision);

        let second = json!({
            "id": "person-two",
            "projectId": "project-test",
            "names": [{ "value": "Two", "type": "personal", "primary": true }],
            "updatedAt": "2030-01-02T03:04:05Z"
        });
        let (change_set_id, next_revision) = storage
            .insert_cli_batch_if_revision(
                "project-test",
                &[
                    (Resource::Person, "create", person),
                    (Resource::Person, "create", second),
                ],
                revision,
            )
            .expect("apply valid batch");
        assert_eq!(next_revision, revision + 1);
        let change_sets: i64 = storage
            .connection
            .query_row(
                "SELECT count(*) FROM change_sets WHERE id = ?1 AND operation = 'batch.run'",
                [&change_set_id],
                |row| row.get(0),
            )
            .expect("count change sets");
        let change_items: i64 = storage
            .connection
            .query_row(
                "SELECT count(*) FROM change_items WHERE change_set_id = ?1",
                [&change_set_id],
                |row| row.get(0),
            )
            .expect("count change items");
        assert_eq!(change_sets, 1);
        assert_eq!(change_items, 2);
    }

    #[test]
    fn desktop_and_cli_connections_can_share_one_wal_database() {
        let directory = tempdir().expect("create temporary directory");
        let database_path = directory.path().join("branchloom.sqlite3");
        let mut desktop = Storage::open(&database_path).expect("open desktop connection");
        let cli = Storage::open(&database_path).expect("open CLI connection");

        let project = desktop
            .create_project(NewProject {
                name: "Shared database".to_owned(),
                description: String::new(),
            })
            .expect("write through desktop connection");
        assert_eq!(
            cli.get_project(&project.id)
                .expect("read through CLI connection")
                .name,
            "Shared database"
        );
    }

    #[test]
    fn an_initialized_empty_state_does_not_reseed_demo_data() {
        let mut storage = Storage::open_in_memory().expect("open database");
        let mut empty = test_state();
        empty["projects"] = json!([]);
        empty["people"] = json!([]);
        storage
            .synchronize_normalized_state_if_revision(&empty.to_string(), "{}", 0)
            .expect("save empty initialized state");

        let loaded = storage
            .load_normalized_state()
            .expect("load empty state")
            .expect("empty state remains initialized");
        let loaded: Value = serde_json::from_str(&loaded.state_json).expect("parse state");
        assert_eq!(loaded["projects"], json!([]));
    }

    #[test]
    fn upgrades_the_first_normalized_schema_without_losing_records() {
        let directory = tempdir().expect("create temporary directory");
        let database_path = directory.path().join("branchloom.sqlite3");
        {
            let mut storage = Storage::open(&database_path).expect("create normalized database");
            storage
                .synchronize_normalized_state(&test_state().to_string(), "{}")
                .expect("save normalized state");
            storage
                .connection
                .pragma_update(None, "user_version", 1)
                .expect("simulate the first normalized schema version");
        }

        let storage = Storage::open(&database_path).expect("upgrade normalized database");
        assert_eq!(
            storage.schema_version().expect("read schema version"),
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(
            storage
                .get_record(Resource::Person, "person-test")
                .expect("read person")
                .expect("person exists")["id"],
            "person-test"
        );
    }

    #[test]
    fn upgrades_schema_four_with_revision_metadata_and_existing_state() {
        let directory = tempdir().expect("create temporary directory");
        let database_path = directory.path().join("branchloom.sqlite3");
        {
            let mut storage = Storage::open(&database_path).expect("create normalized database");
            storage
                .synchronize_normalized_state(&test_state().to_string(), "{}")
                .expect("save normalized state");
            storage
                .connection
                .execute(
                    "DELETE FROM branchloom_metadata
                     WHERE key IN ('data_revision', 'state_initialized')",
                    [],
                )
                .expect("remove new metadata");
            storage
                .connection
                .pragma_update(None, "user_version", 4)
                .expect("simulate schema four");
        }

        let storage = Storage::open(&database_path).expect("upgrade schema four");
        assert_eq!(storage.data_revision().expect("read revision"), 0);
        assert!(storage
            .load_normalized_state()
            .expect("load state")
            .is_some());
        assert_eq!(
            storage.schema_version().expect("read schema version"),
            CURRENT_SCHEMA_VERSION
        );
    }

    #[test]
    fn migrates_legacy_version_three_app_state_to_normalized_tables() {
        let directory = tempdir().expect("create temporary directory");
        let database_path = directory.path().join("branchloom.sqlite3");
        let connection = Connection::open(&database_path).expect("create legacy database");
        connection
            .execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
                 CREATE TABLE app_state (
                    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
                    state_json TEXT NOT NULL,
                    snapshot_payloads_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 PRAGMA user_version = 3;",
            )
            .expect("create legacy schema");
        connection
            .execute(
                "INSERT INTO app_state(
                    id, state_json, snapshot_payloads_json, updated_at
                 ) VALUES (1, ?1, '{}', '2026-01-01T00:00:00Z')",
                [test_state().to_string()],
            )
            .expect("insert legacy application state");
        drop(connection);

        let storage = Storage::open(&database_path).expect("migrate legacy database");
        assert_eq!(
            storage.schema_version().expect("read schema version"),
            CURRENT_SCHEMA_VERSION
        );
        assert_eq!(
            storage
                .get_record(Resource::Person, "person-test")
                .expect("read migrated person")
                .expect("migrated person exists")["id"],
            "person-test"
        );
        assert!(!storage
            .table_exists("app_state")
            .expect("inspect legacy table"));
    }

    #[test]
    fn migrates_an_empty_legacy_version_three_database() {
        let connection = Connection::open_in_memory().expect("create legacy database");
        connection
            .execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
                 CREATE TABLE app_state (
                    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
                    state_json TEXT NOT NULL,
                    snapshot_payloads_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                 );
                 PRAGMA user_version = 3;",
            )
            .expect("create empty legacy schema");

        let storage = Storage::from_connection(connection).expect("migrate empty legacy database");
        assert_eq!(
            storage.schema_version().expect("read schema version"),
            CURRENT_SCHEMA_VERSION
        );
        assert!(storage
            .load_normalized_state()
            .expect("load normalized state")
            .is_none());
    }

    #[test]
    fn refuses_to_discard_legacy_records_without_application_state() {
        let directory = tempdir().expect("create temporary directory");
        let database_path = directory.path().join("branchloom.sqlite3");
        let connection = Connection::open(&database_path).expect("create legacy database");
        connection
            .execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL);
                 INSERT INTO projects(id) VALUES ('legacy-project');
                 PRAGMA user_version = 3;",
            )
            .expect("create legacy record");
        drop(connection);

        let result = Storage::open(&database_path);
        assert!(matches!(result, Err(CoreError::Validation(_))));
        let connection = Connection::open(&database_path).expect("reopen rejected database");
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read unchanged schema version");
        assert_eq!(version, 3);
        let project_count: i64 = connection
            .query_row("SELECT count(*) FROM projects", [], |row| row.get(0))
            .expect("read unchanged legacy rows");
        assert_eq!(project_count, 1);
    }

    #[test]
    fn rejects_future_schema_versions_without_overwriting_them() {
        let connection = Connection::open_in_memory().expect("open database");
        connection
            .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .expect("set future schema");
        let result = Storage::from_connection(connection);
        assert!(matches!(result, Err(CoreError::UnsupportedVersion { .. })));
    }

    #[test]
    fn record_delete_cascades_and_rewrites_json_references_in_one_audited_transaction() {
        let mut storage = Storage::open_in_memory().expect("open storage");
        let mut state = test_state();
        state["people"] = json!([
            { "id": "person-test", "projectId": "project-test", "names": [], "updatedAt": "2026-01-01T00:00:00Z" },
            { "id": "person-keep", "projectId": "project-test", "names": [], "updatedAt": "2026-01-01T00:00:00Z" }
        ]);
        state["relationships"] = json!([{
            "id": "relationship-test", "projectId": "project-test",
            "fromPersonId": "person-test", "toPersonId": "person-keep",
            "sourceIds": [], "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        state["events"] = json!([{
            "id": "event-test", "projectId": "project-test",
            "participantIds": ["person-test", "person-keep"],
            "participantRoles": { "person-test": "subject", "person-keep": "witness" },
            "sourceIds": [], "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        state["sources"] = json!([{
            "id": "source-test", "projectId": "project-test", "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        state["citations"] = json!([{
            "id": "citation-test", "projectId": "project-test", "sourceId": "source-test",
            "targetType": "relationship", "targetId": "relationship-test",
            "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        state["attachments"] = json!([{
            "id": "attachment-test", "projectId": "project-test", "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        state["attachmentLinks"] = json!([{
            "id": "link-test", "projectId": "project-test", "attachmentId": "attachment-test",
            "targetType": "relationship", "targetId": "relationship-test",
            "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        storage
            .synchronize_normalized_state(&state.to_string(), "{}")
            .expect("seed state");

        let revision = storage.data_revision().expect("read revision");
        let impact = storage
            .record_delete_impact(Resource::Person, "person-test")
            .expect("plan deletion");
        assert!(impact
            .iter()
            .any(|item| { item["resource"] == "relationships" && item["action"] == "delete" }));
        let change_set_id = storage
            .delete_record_with_change_set_if_revision(
                Resource::Person,
                "person-test",
                "project-test",
                revision,
                "cli",
            )
            .expect("delete person");

        assert!(storage
            .get_record(Resource::Relationship, "relationship-test")
            .expect("read relationship")
            .is_none());
        assert!(storage
            .get_record(Resource::Citation, "citation-test")
            .expect("read citation")
            .is_none());
        let event = storage
            .get_record(Resource::Event, "event-test")
            .expect("read event")
            .expect("event remains");
        assert_eq!(event["participantIds"], json!(["person-keep"]));
        assert!(event["participantRoles"].get("person-test").is_none());
        let item_count: i64 = storage
            .connection
            .query_row(
                "SELECT count(*) FROM change_items WHERE change_set_id = ?1",
                [&change_set_id],
                |row| row.get(0),
            )
            .expect("count audited mutations");
        assert!(item_count >= 5);
    }

    #[test]
    fn overwrite_import_preserves_local_snapshots_payloads_and_audit_history() {
        let mut storage = Storage::open_in_memory().expect("open storage");
        let mut state = test_state();
        state["projects"][0]["backupSchedule"] = json!("off");
        storage
            .synchronize_normalized_state(&state.to_string(), "{}")
            .expect("seed state");
        let exported = storage
            .export_project_data("project-test")
            .expect("export project");
        storage
            .connection
            .execute(
                "INSERT INTO snapshots(id, project_id, data_json, revision, created_at, updated_at)
                 VALUES ('snapshot-test', 'project-test', ?1, 1, ?2, ?2)",
                params![
                    json!({
                        "id": "snapshot-test", "projectId": "project-test", "reason": "manual",
                        "createdAt": "2026-01-01T00:00:00Z", "note": "keep"
                    })
                    .to_string(),
                    "2026-01-01T00:00:00Z"
                ],
            )
            .expect("insert snapshot");
        storage
            .connection
            .execute(
                "INSERT INTO snapshot_payloads(snapshot_id, payload_json) VALUES ('snapshot-test', '{}')",
                [],
            )
            .expect("insert payload");
        storage
            .connection
            .execute(
                "INSERT INTO snapshot_payloads(snapshot_id, payload_json) VALUES ('orphan-old', '{}')",
                [],
            )
            .expect("insert legacy orphan payload");
        storage
            .connection
            .execute(
                "INSERT INTO change_sets(id, project_id, source, operation, created_at, revertible, summary_json)
                 VALUES ('change-test', 'project-test', 'cli', 'person.update', ?1, 0, '{}')",
                ["2026-01-01T00:00:00Z"],
            )
            .expect("insert audit history");

        storage
            .replace_project_data(&exported, true)
            .expect("overwrite project");
        for table in ["snapshots", "snapshot_payloads", "change_sets"] {
            let count: i64 = storage
                .connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count preserved rows");
            assert_eq!(count, 1, "{table} must be preserved");
        }
    }

    fn test_state() -> Value {
        json!({
            "schemaVersion": 2,
            "projects": [{
                "id": "project-test",
                "name": "Test",
                "description": "",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }],
            "people": [{
                "id": "person-test",
                "projectId": "project-test",
                "names": [],
                "updatedAt": "2026-01-01T00:00:00.000Z"
            }],
            "organizations": [],
            "careers": [],
            "personTitles": [],
            "relationships": [],
            "events": [],
            "places": [],
            "sources": [],
            "citations": [],
            "attachments": [],
            "attachmentLinks": [],
            "snapshots": [],
            "issues": []
        })
    }
}
