use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use uuid::Uuid;

use crate::contract::{
    describe_resource, prepare_create_input, validate_record, validate_update_input,
};
use crate::core::duplicate::{score_duplicate_candidates, DuplicateCandidate};
use crate::core::error::{CoreError, CoreResult};
use crate::core::project::{NewProject, ProjectPatch, ProjectRecord};
use crate::gedcom::{export_gedcom, read_gedcom, GedcomSummary, GEDCOM_EXTENSION};
use crate::project_format::{ProjectData, ProjectTree, ARCHIVE_EXTENSION};
use crate::storage::{DesktopRecordChange, NormalizedState, Resource, Storage};

pub use crate::storage::Resource as BusinessResource;
pub const SCHEMA_VERSION: i64 = crate::storage::CURRENT_SCHEMA_VERSION;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateSnapshot {
    pub revision: i64,
    pub state: Option<NormalizedState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAttachmentResult {
    pub attachment: Value,
    pub link: Value,
    pub already_stored: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAttachmentContent {
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    pub content_hash: String,
    pub already_stored: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GedcomImportResult {
    pub project: ProjectRecord,
    pub summary: GedcomSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualSnapshotResult {
    pub snapshot: Value,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedBatchAction {
    pub index: usize,
    pub resource: Resource,
    pub action: &'static str,
    pub id: String,
    pub declared_ref: Option<String>,
    pub record: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersonRelationshipBatchPlan {
    pub project_id: String,
    pub expected_revision: i64,
    pub actions: Vec<PlannedBatchAction>,
    pub reference_ids: BTreeMap<String, String>,
    pub high_risk: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchApplyResult {
    pub change_set_id: String,
    pub revision: i64,
    pub records: Vec<Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMutationResult {
    pub result: Value,
    pub revision: i64,
}

pub struct ApplicationService {
    storage: Storage,
    data_directory: PathBuf,
}

impl ApplicationService {
    pub fn inspect_schema(path: impl AsRef<Path>) -> CoreResult<i64> {
        Storage::inspect_schema(path)
    }

    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        let path = path.as_ref();
        Ok(Self {
            storage: Storage::open(path)?,
            data_directory: path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf(),
        })
    }

    pub fn schema_version(&self) -> CoreResult<i64> {
        self.storage.schema_version()
    }

    pub fn data_revision(&self) -> CoreResult<i64> {
        self.storage.data_revision()
    }

    pub fn list_projects(&self) -> CoreResult<Vec<ProjectRecord>> {
        self.storage.list_projects()
    }

    pub fn get_project(&self, id: &str) -> CoreResult<ProjectRecord> {
        self.storage.get_project(id)
    }

    pub fn create_project_with_id(
        &mut self,
        id: String,
        input: NewProject,
    ) -> CoreResult<ProjectRecord> {
        self.storage.create_project_with_id(id, input)
    }

    pub fn create_project_with_id_if_revision(
        &mut self,
        id: String,
        input: NewProject,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        self.storage
            .create_project_with_id_if_revision(id, input, expected_revision)
    }

    pub fn update_project(&mut self, id: &str, patch: ProjectPatch) -> CoreResult<ProjectRecord> {
        self.storage.update_project(id, patch)
    }

    pub fn update_project_if_revision(
        &mut self,
        id: &str,
        patch: ProjectPatch,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        self.storage
            .update_project_if_revision(id, patch, expected_revision)
    }

    pub fn update_project_value_if_revision(
        &mut self,
        id: &str,
        patch: &Value,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        self.storage
            .update_project_value_if_revision(id, patch, expected_revision)
    }

    pub fn apply_desktop_mutation_if_revision(
        &mut self,
        method: &str,
        args: &Value,
        expected_revision: i64,
    ) -> CoreResult<DesktopMutationResult> {
        let args = args.as_array().ok_or_else(|| {
            CoreError::Validation("desktop mutation args must be an array".to_owned())
        })?;
        let result = match method {
            "createProject" => {
                let input: NewProject = serde_json::from_value(mutation_arg(args, 0)?.clone())?;
                serde_json::to_value(self.create_project_with_id_if_revision(
                    Uuid::new_v4().to_string(),
                    input,
                    expected_revision,
                )?)?
            }
            "updateProject" => {
                let id = mutation_string_arg(args, 0)?;
                serde_json::to_value(self.update_project_value_if_revision(
                    id,
                    mutation_arg(args, 1)?,
                    expected_revision,
                )?)?
            }
            "deleteProject" => {
                self.delete_project_if_revision(mutation_string_arg(args, 0)?, expected_revision)?;
                Value::Null
            }
            "softDeletePerson" => {
                let id = mutation_string_arg(args, 0)?;
                let mut person =
                    self.get_record(Resource::Person, id)?
                        .ok_or_else(|| CoreError::NotFound {
                            entity: "person",
                            id: id.to_owned(),
                        })?;
                let timestamp = OffsetDateTime::now_utc().format(&Rfc3339)?;
                let object = person.as_object_mut().expect("person record is an object");
                object.insert("deletedAt".to_owned(), json!(timestamp));
                object.insert("updatedAt".to_owned(), json!(timestamp));
                self.save_desktop_records(
                    method,
                    &[(Resource::Person, person)],
                    expected_revision,
                )?;
                Value::Null
            }
            "savePersonWithRelationship" => {
                let mut person = mutation_arg(args, 0)?.clone();
                strip_runtime_media_record(Resource::Person, &mut person);
                let relationship = mutation_arg(args, 1)?.clone();
                validate_record(Resource::Person, &person)?;
                validate_record(Resource::Relationship, &relationship)?;
                let project_id = required_record_string(&person, "projectId")?;
                if required_record_string(&relationship, "projectId")? != project_id {
                    return Err(CoreError::Validation(
                        "person and relationship must belong to the same project".to_owned(),
                    ));
                }
                let person_id = required_record_string(&person, "id")?;
                let from = required_record_string(&relationship, "fromPersonId")?;
                let to = required_record_string(&relationship, "toPersonId")?;
                if from != person_id && to != person_id {
                    return Err(CoreError::Validation(
                        "relationship must reference the new person".to_owned(),
                    ));
                }
                for endpoint in [from, to] {
                    if endpoint != person_id {
                        self.validate_same_project_reference(
                            "relationship",
                            Resource::Person,
                            endpoint,
                            project_id,
                        )?;
                    }
                }
                self.validate_optional_record_reference(
                    "person",
                    &person,
                    "birthPlaceId",
                    Resource::Place,
                    project_id,
                )?;
                self.validate_optional_record_reference(
                    "person",
                    &person,
                    "deathPlaceId",
                    Resource::Place,
                    project_id,
                )?;
                self.validate_record_reference_array(
                    "person",
                    &person,
                    "sourceIds",
                    Resource::Source,
                    project_id,
                )?;
                self.validate_optional_record_reference(
                    "relationship",
                    &relationship,
                    "placeId",
                    Resource::Place,
                    project_id,
                )?;
                self.validate_record_reference_array(
                    "relationship",
                    &relationship,
                    "sourceIds",
                    Resource::Source,
                    project_id,
                )?;
                self.save_desktop_records(
                    method,
                    &[
                        (Resource::Person, person.clone()),
                        (Resource::Relationship, relationship.clone()),
                    ],
                    expected_revision,
                )?;
                json!({ "person": person, "relationship": relationship })
            }
            "saveOrganizationWithCareer" => {
                let organization = mutation_arg(args, 0)?.clone();
                let career = mutation_arg(args, 1)?.clone();
                let project_id = required_record_string(&organization, "projectId")?;
                if required_record_string(&career, "projectId")? != project_id {
                    return Err(CoreError::Validation(
                        "organization and career must belong to the same project".to_owned(),
                    ));
                }
                if career.get("organizationId").and_then(Value::as_str)
                    != Some(required_record_string(&organization, "id")?)
                {
                    return Err(CoreError::Validation(
                        "career must reference the saved organization".to_owned(),
                    ));
                }
                self.validate_desktop_record(Resource::Organization, &organization)?;
                self.validate_desktop_record_except_organization(&career)?;
                self.save_desktop_records(
                    method,
                    &[
                        (Resource::Organization, organization.clone()),
                        (Resource::Career, career.clone()),
                    ],
                    expected_revision,
                )?;
                json!({ "organization": organization, "career": career })
            }
            "saveCitationWithAttachmentLinks" => self.save_citation_with_links(
                mutation_arg(args, 0)?.clone(),
                mutation_arg(args, 1)?,
                expected_revision,
            )?,
            "saveAttachmentLink" => {
                let link = mutation_arg(args, 0)?.clone();
                self.validate_attachment_link(&link)?;
                let project_id = required_record_string(&link, "projectId")?.to_owned();
                let change = DesktopRecordChange {
                    collection: "attachmentLinks",
                    id: required_record_string(&link, "id")?.to_owned(),
                    project_id,
                    after: Some(link.clone()),
                };
                self.storage.apply_desktop_record_changes_if_revision(
                    method,
                    &[change],
                    expected_revision,
                )?;
                link
            }
            "createSnapshot" => {
                let project_id = mutation_string_arg(args, 0)?;
                let reason = mutation_string_arg(args, 1)?;
                let note = mutation_string_arg(args, 2)?;
                if reason != "manual" {
                    return Err(CoreError::Validation(
                        "only manual snapshots can be requested directly".to_owned(),
                    ));
                }
                self.create_manual_snapshot_if_revision(project_id, note, expected_revision)?
                    .snapshot
            }
            "savePerson" => self.save_desktop_record_result(
                method,
                Resource::Person,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "saveOrganization" => self.save_desktop_record_result(
                method,
                Resource::Organization,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "saveCareer" => self.save_desktop_record_result(
                method,
                Resource::Career,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "savePersonTitle" => self.save_desktop_record_result(
                method,
                Resource::Title,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "saveRelationship" => self.save_desktop_record_result(
                method,
                Resource::Relationship,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "saveEvent" => self.save_desktop_record_result(
                method,
                Resource::Event,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "savePlace" => self.save_desktop_record_result(
                method,
                Resource::Place,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "saveSource" => self.save_desktop_record_result(
                method,
                Resource::Source,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "saveCitation" => self.save_desktop_record_result(
                method,
                Resource::Citation,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "saveAttachment" => self.save_desktop_record_result(
                method,
                Resource::Attachment,
                mutation_arg(args, 0)?.clone(),
                expected_revision,
            )?,
            "deleteOrganization" => {
                self.delete_desktop_record(Resource::Organization, args, expected_revision)?
            }
            "deleteCareer" => {
                self.delete_desktop_record(Resource::Career, args, expected_revision)?
            }
            "deletePersonTitle" => {
                self.delete_desktop_record(Resource::Title, args, expected_revision)?
            }
            "deleteRelationship" => {
                self.delete_desktop_record(Resource::Relationship, args, expected_revision)?
            }
            "deleteEvent" => {
                self.delete_desktop_record(Resource::Event, args, expected_revision)?
            }
            "deletePlace" => {
                self.delete_desktop_record(Resource::Place, args, expected_revision)?
            }
            "deleteSource" => {
                self.delete_desktop_record(Resource::Source, args, expected_revision)?
            }
            "deleteCitation" => {
                self.delete_desktop_record(Resource::Citation, args, expected_revision)?
            }
            "deleteAttachment" => {
                self.delete_desktop_record(Resource::Attachment, args, expected_revision)?
            }
            "mergePeople" | "cleanupProject" | "restoreSnapshot" | "resetDemo" | "undo"
            | "redo" => {
                return Err(CoreError::Validation(format!(
                    "{method} is disabled in managed storage until its Rust core implementation is available"
                )))
            }
            _ => {
                return Err(CoreError::Validation(format!(
                    "desktop mutation is not implemented in the Rust core: {method}"
                )))
            }
        };
        Ok(DesktopMutationResult {
            result,
            revision: self.data_revision()?,
        })
    }

    pub fn delete_project(&mut self, id: &str) -> CoreResult<()> {
        self.storage.delete_project(id)
    }

    pub fn delete_project_if_revision(
        &mut self,
        id: &str,
        expected_revision: i64,
    ) -> CoreResult<()> {
        self.storage
            .delete_project_if_revision(id, expected_revision)
    }

    pub fn project_delete_impact(&self, id: &str) -> CoreResult<Vec<Value>> {
        self.storage.project_delete_impact(id)
    }

    pub fn project_is_empty_for_replacement(&self, id: &str) -> CoreResult<bool> {
        self.storage.project_is_empty_for_replacement(id)
    }

    pub fn list_records(&self, resource: Resource, project_id: &str) -> CoreResult<Vec<Value>> {
        self.storage
            .list_records(resource, project_id)
            .map(|mut records| {
                if resource == Resource::Person {
                    records
                        .iter_mut()
                        .for_each(strip_removed_person_name_fields);
                }
                records
            })
    }

    pub fn list_duplicate_candidates(
        &self,
        project_id: &str,
    ) -> CoreResult<Vec<DuplicateCandidate>> {
        self.get_project(project_id)?;
        Ok(score_duplicate_candidates(
            &self.list_records(Resource::Person, project_id)?,
            &self.list_records(Resource::Relationship, project_id)?,
            &self.list_records(Resource::Citation, project_id)?,
            &self.list_records(Resource::Event, project_id)?,
            &self.list_records(Resource::Place, project_id)?,
            &self.list_records(Resource::Source, project_id)?,
        ))
    }

    pub fn describe_resource(&self, resource: Resource) -> Value {
        describe_resource(resource)
    }

    pub fn prepare_create_record(&self, resource: Resource, input: &Value) -> CoreResult<Value> {
        prepare_create_input(resource, input)
    }

    pub fn plan_person_relationship_batch(
        &self,
        project_id: &str,
        input: &Value,
    ) -> CoreResult<PersonRelationshipBatchPlan> {
        self.get_project(project_id)?;
        let root = input
            .as_object()
            .ok_or_else(|| CoreError::Validation("batch input must be an object".to_owned()))?;
        let unknown_root = root
            .keys()
            .filter(|key| key.as_str() != "actions")
            .cloned()
            .collect::<Vec<_>>();
        if !unknown_root.is_empty() {
            return Err(CoreError::Validation(format!(
                "unknown batch fields: {}",
                unknown_root.join(", ")
            )));
        }
        let actions = root
            .get("actions")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::Validation("batch.actions must be an array".to_owned()))?;
        if actions.is_empty() || actions.len() > 100 {
            return Err(CoreError::Validation(
                "batch.actions must contain between 1 and 100 actions".to_owned(),
            ));
        }

        let expected_revision = self.data_revision()?;
        let mut reference_ids = BTreeMap::new();
        let mut known_people = self
            .list_records(Resource::Person, project_id)?
            .into_iter()
            .filter_map(|person| person.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect::<HashSet<_>>();
        let mut relationship_keys = self
            .list_records(Resource::Relationship, project_id)?
            .iter()
            .map(relationship_identity)
            .collect::<CoreResult<HashSet<_>>>()?;
        let mut planned = Vec::with_capacity(actions.len());

        for (index, raw_action) in actions.iter().enumerate() {
            let location = format!("batch.actions[{index}]");
            let action_object = raw_action
                .as_object()
                .ok_or_else(|| CoreError::Validation(format!("{location} must be an object")))?;
            let unknown = action_object
                .keys()
                .filter(|key| !matches!(key.as_str(), "resource" | "action" | "ref" | "payload"))
                .cloned()
                .collect::<Vec<_>>();
            if !unknown.is_empty() {
                return Err(CoreError::Validation(format!(
                    "{location} has unknown fields: {}",
                    unknown.join(", ")
                )));
            }
            let resource_name = action_object
                .get("resource")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CoreError::Validation(format!("{location}.resource must be a string"))
                })?;
            let action_name = action_object
                .get("action")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CoreError::Validation(format!("{location}.action must be a string"))
                })?;
            let (resource, canonical_action) = match (resource_name, action_name) {
                ("person", "create") => (Resource::Person, "create"),
                ("relationship", "add") => (Resource::Relationship, "add"),
                _ => {
                    return Err(CoreError::Validation(format!(
                        "{location} supports only person/create and relationship/add"
                    )))
                }
            };
            let declared_ref = action_object
                .get("ref")
                .map(|value| {
                    let value = value.as_str().ok_or_else(|| {
                        CoreError::Validation(format!("{location}.ref must be a string"))
                    })?;
                    let value = value.trim();
                    if value.is_empty() {
                        return Err(CoreError::Validation(format!(
                            "{location}.ref must not be empty"
                        )));
                    }
                    if reference_ids.contains_key(value) {
                        return Err(CoreError::Validation(format!(
                            "{location}.ref duplicates an earlier ref: {value}"
                        )));
                    }
                    Ok(value.to_owned())
                })
                .transpose()?;
            let mut payload = action_object
                .get("payload")
                .cloned()
                .ok_or_else(|| CoreError::Validation(format!("{location}.payload is required")))?;
            resolve_batch_references(&mut payload, &reference_ids, &location)?;
            let mut record = prepare_create_input(resource, &payload)
                .map_err(|error| CoreError::Validation(format!("{location}.payload: {error}")))?;
            let id = batch_action_id(project_id, input, expected_revision, index, resource);
            let object = record.as_object_mut().ok_or_else(|| {
                CoreError::Validation(format!("{location}.payload must be an object"))
            })?;
            object.insert("id".to_owned(), json!(id));
            object.insert("projectId".to_owned(), json!(project_id));
            validate_record(resource, &record)
                .map_err(|error| CoreError::Validation(format!("{location}.payload: {error}")))?;

            if resource == Resource::Person {
                known_people.insert(id.clone());
            } else {
                self.validate_batch_relationship_references(
                    &record,
                    project_id,
                    &known_people,
                    &location,
                )?;
                let key = relationship_identity(&record)?;
                if !relationship_keys.insert(key) {
                    return Err(CoreError::Validation(format!(
                        "{location} duplicates an existing or earlier relationship"
                    )));
                }
            }
            if let Some(reference) = &declared_ref {
                reference_ids.insert(reference.clone(), id.clone());
            }
            planned.push(PlannedBatchAction {
                index,
                resource,
                action: canonical_action,
                id,
                declared_ref,
                record,
            });
        }

        let high_risk = planned.len() > 10
            || planned
                .iter()
                .any(|action| action.resource == Resource::Relationship);
        Ok(PersonRelationshipBatchPlan {
            project_id: project_id.to_owned(),
            expected_revision,
            actions: planned,
            reference_ids,
            high_risk,
        })
    }

    pub fn apply_person_relationship_batch(
        &mut self,
        plan: &PersonRelationshipBatchPlan,
    ) -> CoreResult<BatchApplyResult> {
        self.validate_person_relationship_batch_plan(plan)?;
        let timestamp = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let mut records = Vec::with_capacity(plan.actions.len());
        let mut storage_records = Vec::with_capacity(plan.actions.len());
        for action in &plan.actions {
            let mut record = action.record.clone();
            record
                .as_object_mut()
                .expect("planned batch records are objects")
                .insert("updatedAt".to_owned(), json!(timestamp));
            storage_records.push((action.resource, action.action, record.clone()));
            records.push(record);
        }
        let (change_set_id, revision) = self.storage.insert_cli_batch_if_revision(
            &plan.project_id,
            &storage_records,
            plan.expected_revision,
        )?;
        Ok(BatchApplyResult {
            change_set_id,
            revision,
            records,
        })
    }

    fn validate_person_relationship_batch_plan(
        &self,
        plan: &PersonRelationshipBatchPlan,
    ) -> CoreResult<()> {
        if plan.actions.is_empty() || plan.actions.len() > 100 {
            return Err(CoreError::Validation(
                "batch must contain between 1 and 100 actions".to_owned(),
            ));
        }
        self.get_project(&plan.project_id)?;
        let mut known_people = self
            .list_records(Resource::Person, &plan.project_id)?
            .into_iter()
            .filter_map(|person| person.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect::<HashSet<_>>();
        let mut relationship_keys = self
            .list_records(Resource::Relationship, &plan.project_id)?
            .iter()
            .map(relationship_identity)
            .collect::<CoreResult<HashSet<_>>>()?;
        let mut declared_refs = BTreeMap::new();
        for (index, action) in plan.actions.iter().enumerate() {
            let location = format!("batch.actions[{index}]");
            if action.index != index
                || !matches!(
                    (action.resource, action.action),
                    (Resource::Person, "create") | (Resource::Relationship, "add")
                )
            {
                return Err(CoreError::Validation(format!(
                    "{location} is not a supported batch action"
                )));
            }
            if action.record.get("id").and_then(Value::as_str) != Some(action.id.as_str())
                || action.record.get("projectId").and_then(Value::as_str)
                    != Some(plan.project_id.as_str())
            {
                return Err(CoreError::Validation(format!(
                    "{location} target identity does not match its record"
                )));
            }
            validate_record(action.resource, &action.record)
                .map_err(|error| CoreError::Validation(format!("{location}.payload: {error}")))?;
            if action.resource == Resource::Person {
                known_people.insert(action.id.clone());
            } else {
                self.validate_batch_relationship_references(
                    &action.record,
                    &plan.project_id,
                    &known_people,
                    &location,
                )?;
                if !relationship_keys.insert(relationship_identity(&action.record)?) {
                    return Err(CoreError::Validation(format!(
                        "{location} duplicates an existing or earlier relationship"
                    )));
                }
            }
            if let Some(reference) = &action.declared_ref {
                if declared_refs
                    .insert(reference.clone(), action.id.clone())
                    .is_some()
                {
                    return Err(CoreError::Validation(format!(
                        "{location}.ref duplicates an earlier ref: {reference}"
                    )));
                }
            }
        }
        if declared_refs != plan.reference_ids {
            return Err(CoreError::Validation(
                "batch ref map does not match the planned actions".to_owned(),
            ));
        }
        Ok(())
    }

    fn validate_batch_relationship_references(
        &self,
        relationship: &Value,
        project_id: &str,
        known_people: &HashSet<String>,
        location: &str,
    ) -> CoreResult<()> {
        for field in ["fromPersonId", "toPersonId"] {
            let id = relationship
                .get(field)
                .and_then(Value::as_str)
                .expect("batch relationship IDs validated");
            if !known_people.contains(id) {
                return Err(CoreError::Validation(format!(
                    "{location}.payload.{field} references a missing or later person: {id}"
                )));
            }
        }
        if let Some(place_id) = relationship.get("placeId").and_then(Value::as_str) {
            self.validate_same_project_reference(
                "relationship",
                Resource::Place,
                place_id,
                project_id,
            )?;
        }
        for source_id in relationship
            .get("sourceIds")
            .and_then(Value::as_array)
            .expect("batch relationship sourceIds validated")
            .iter()
            .map(|value| value.as_str().expect("batch source ID validated"))
        {
            self.validate_same_project_reference(
                "relationship",
                Resource::Source,
                source_id,
                project_id,
            )?;
        }
        Ok(())
    }

    pub fn validate_update_record_input(
        &self,
        resource: Resource,
        input: &Value,
    ) -> CoreResult<()> {
        validate_update_input(resource, input)
    }

    pub fn validate_record(&self, resource: Resource, record: &Value) -> CoreResult<()> {
        validate_record(resource, record)?;
        match resource {
            Resource::Event => self.validate_event_references(record)?,
            Resource::Relationship => self.validate_relationship_references(record)?,
            Resource::Citation => self.validate_citation_references(record)?,
            _ => {}
        }
        Ok(())
    }

    fn validate_event_references(&self, event: &Value) -> CoreResult<()> {
        let project_id = event
            .get("projectId")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::Validation("event.projectId is required".to_owned()))?;
        for person_id in event
            .get("participantIds")
            .and_then(Value::as_array)
            .expect("event participantIds validated")
            .iter()
            .map(|value| value.as_str().expect("event participant id validated"))
        {
            self.validate_same_project_reference("event", Resource::Person, person_id, project_id)?;
        }
        if let Some(place_id) = event.get("placeId").and_then(Value::as_str) {
            self.validate_same_project_reference("event", Resource::Place, place_id, project_id)?;
        }
        for source_id in event
            .get("sourceIds")
            .and_then(Value::as_array)
            .expect("event sourceIds validated")
            .iter()
            .map(|value| value.as_str().expect("event source id validated"))
        {
            self.validate_same_project_reference("event", Resource::Source, source_id, project_id)?;
        }
        Ok(())
    }

    fn validate_relationship_references(&self, relationship: &Value) -> CoreResult<()> {
        let project_id = relationship
            .get("projectId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                CoreError::Validation("relationship.projectId is required".to_owned())
            })?;
        for field in ["fromPersonId", "toPersonId"] {
            let person_id = relationship
                .get(field)
                .and_then(Value::as_str)
                .expect("relationship person id validated");
            self.validate_same_project_reference(
                "relationship",
                Resource::Person,
                person_id,
                project_id,
            )?;
        }
        if let Some(place_id) = relationship.get("placeId").and_then(Value::as_str) {
            self.validate_same_project_reference(
                "relationship",
                Resource::Place,
                place_id,
                project_id,
            )?;
        }
        for source_id in relationship
            .get("sourceIds")
            .and_then(Value::as_array)
            .expect("relationship sourceIds validated")
            .iter()
            .map(|value| value.as_str().expect("relationship source id validated"))
        {
            self.validate_same_project_reference(
                "relationship",
                Resource::Source,
                source_id,
                project_id,
            )?;
        }
        Ok(())
    }

    fn validate_citation_references(&self, citation: &Value) -> CoreResult<()> {
        let project_id = citation
            .get("projectId")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::Validation("citation.projectId is required".to_owned()))?;
        let source_id = citation
            .get("sourceId")
            .and_then(Value::as_str)
            .expect("citation source id validated");
        self.validate_same_project_reference("citation", Resource::Source, source_id, project_id)?;
        let target_type = citation
            .get("targetType")
            .and_then(Value::as_str)
            .expect("citation target type validated");
        let target_resource = Resource::parse(target_type).expect("citation target type validated");
        let target_id = citation
            .get("targetId")
            .and_then(Value::as_str)
            .expect("citation target id validated");
        self.validate_same_project_reference("citation", target_resource, target_id, project_id)
    }

    fn validate_same_project_reference(
        &self,
        owner: &str,
        resource: Resource,
        id: &str,
        project_id: &str,
    ) -> CoreResult<()> {
        let record = self.storage.get_record(resource, id)?.ok_or_else(|| {
            CoreError::Validation(format!(
                "{owner} references missing {}: {id}",
                resource.as_str()
            ))
        })?;
        if record.get("projectId").and_then(Value::as_str) != Some(project_id) {
            return Err(CoreError::Validation(format!(
                "{owner} references {} from another project: {id}",
                resource.as_str()
            )));
        }
        Ok(())
    }

    pub fn get_record(&self, resource: Resource, id: &str) -> CoreResult<Option<Value>> {
        self.storage.get_record(resource, id).map(|record| {
            record.map(|mut value| {
                if resource == Resource::Person {
                    strip_removed_person_name_fields(&mut value);
                }
                value
            })
        })
    }

    pub fn put_record(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        data: &Value,
    ) -> CoreResult<()> {
        self.storage.put_record(resource, id, project_id, data)
    }

    pub fn put_record_if_revision(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        data: &Value,
        expected_revision: i64,
    ) -> CoreResult<()> {
        self.storage
            .put_record_if_revision(resource, id, project_id, data, expected_revision)
    }

    pub fn put_record_from_cli_if_revision(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        data: &Value,
        expected_revision: i64,
    ) -> CoreResult<String> {
        self.validate_record(resource, data)?;
        self.storage.put_record_with_change_set_if_revision(
            resource,
            id,
            project_id,
            data,
            expected_revision,
            "cli",
        )
    }

    pub fn delete_record(&mut self, resource: Resource, id: &str) -> CoreResult<()> {
        self.storage.delete_record(resource, id)
    }

    pub fn record_delete_impact(&self, resource: Resource, id: &str) -> CoreResult<Vec<Value>> {
        self.storage.record_delete_impact(resource, id)
    }

    pub fn delete_record_if_revision(
        &mut self,
        resource: Resource,
        id: &str,
        expected_revision: i64,
    ) -> CoreResult<()> {
        self.storage
            .delete_record_if_revision(resource, id, expected_revision)
    }

    pub fn delete_record_from_cli_if_revision(
        &mut self,
        resource: Resource,
        id: &str,
        project_id: &str,
        expected_revision: i64,
    ) -> CoreResult<String> {
        self.storage.delete_record_with_change_set_if_revision(
            resource,
            id,
            project_id,
            expected_revision,
            "cli",
        )
    }

    fn save_desktop_record_result(
        &mut self,
        operation: &str,
        resource: Resource,
        mut record: Value,
        expected_revision: i64,
    ) -> CoreResult<Value> {
        strip_runtime_media_record(resource, &mut record);
        self.validate_desktop_record(resource, &record)?;
        self.save_desktop_records(operation, &[(resource, record.clone())], expected_revision)?;
        Ok(record)
    }

    fn save_desktop_records(
        &mut self,
        operation: &str,
        records: &[(Resource, Value)],
        expected_revision: i64,
    ) -> CoreResult<i64> {
        let changes = records
            .iter()
            .map(|(resource, record)| {
                Ok(DesktopRecordChange {
                    collection: desktop_collection(*resource),
                    id: required_record_string(record, "id")?.to_owned(),
                    project_id: required_record_string(record, "projectId")?.to_owned(),
                    after: Some(record.clone()),
                })
            })
            .collect::<CoreResult<Vec<_>>>()?;
        self.storage.apply_desktop_record_changes_if_revision(
            operation,
            &changes,
            expected_revision,
        )
    }

    fn delete_desktop_record(
        &mut self,
        resource: Resource,
        args: &[Value],
        expected_revision: i64,
    ) -> CoreResult<Value> {
        self.delete_record_if_revision(resource, mutation_string_arg(args, 0)?, expected_revision)?;
        Ok(Value::Null)
    }

    fn validate_desktop_record(&self, resource: Resource, record: &Value) -> CoreResult<()> {
        let id = required_record_string(record, "id")?;
        let project_id = required_record_string(record, "projectId")?;
        self.get_project(project_id)?;
        if let Some(existing) = self.get_record(resource, id)? {
            if existing.get("projectId").and_then(Value::as_str) != Some(project_id) {
                return Err(CoreError::Validation(format!(
                    "{} cannot move between projects",
                    resource.as_str()
                )));
            }
        }
        match resource {
            Resource::Person
            | Resource::Relationship
            | Resource::Event
            | Resource::Source
            | Resource::Citation => self.validate_record(resource, record)?,
            _ => {}
        }
        match resource {
            Resource::Person => {
                self.validate_optional_record_reference(
                    "person",
                    record,
                    "birthPlaceId",
                    Resource::Place,
                    project_id,
                )?;
                self.validate_optional_record_reference(
                    "person",
                    record,
                    "deathPlaceId",
                    Resource::Place,
                    project_id,
                )?;
                self.validate_record_reference_array(
                    "person",
                    record,
                    "sourceIds",
                    Resource::Source,
                    project_id,
                )?;
            }
            Resource::Organization => {
                if record.get("parentId").and_then(Value::as_str) == Some(id) {
                    return Err(CoreError::Validation(
                        "organization cannot be its own parent".to_owned(),
                    ));
                }
                self.validate_optional_record_reference(
                    "organization",
                    record,
                    "parentId",
                    Resource::Organization,
                    project_id,
                )?;
                self.validate_optional_record_reference(
                    "organization",
                    record,
                    "placeId",
                    Resource::Place,
                    project_id,
                )?;
                self.validate_record_reference_array(
                    "organization",
                    record,
                    "sourceIds",
                    Resource::Source,
                    project_id,
                )?;
            }
            Resource::Career => self.validate_desktop_record_except_organization(record)?,
            Resource::Title => {
                self.validate_required_record_reference(
                    "title",
                    record,
                    "personId",
                    Resource::Person,
                    project_id,
                )?;
                self.validate_optional_record_reference(
                    "title",
                    record,
                    "placeId",
                    Resource::Place,
                    project_id,
                )?;
                self.validate_optional_record_reference(
                    "title",
                    record,
                    "grantedByPersonId",
                    Resource::Person,
                    project_id,
                )?;
                self.validate_record_reference_array(
                    "title",
                    record,
                    "sourceIds",
                    Resource::Source,
                    project_id,
                )?;
            }
            Resource::Place => {
                if record.get("parentId").and_then(Value::as_str) == Some(id) {
                    return Err(CoreError::Validation(
                        "place cannot be its own parent".to_owned(),
                    ));
                }
                self.validate_optional_record_reference(
                    "place",
                    record,
                    "parentId",
                    Resource::Place,
                    project_id,
                )?;
            }
            Resource::Attachment => {
                let size = record.get("size").and_then(Value::as_u64).ok_or_else(|| {
                    CoreError::Validation(
                        "attachment.size must be a non-negative integer".to_owned(),
                    )
                })?;
                let _ = size;
            }
            _ => {}
        }
        Ok(())
    }

    fn validate_desktop_record_except_organization(&self, record: &Value) -> CoreResult<()> {
        let project_id = required_record_string(record, "projectId")?;
        self.validate_required_record_reference(
            "career",
            record,
            "personId",
            Resource::Person,
            project_id,
        )?;
        self.validate_optional_record_reference(
            "career",
            record,
            "jurisdictionPlaceId",
            Resource::Place,
            project_id,
        )?;
        self.validate_optional_record_reference(
            "career",
            record,
            "appointedByPersonId",
            Resource::Person,
            project_id,
        )?;
        self.validate_record_reference_array(
            "career",
            record,
            "sourceIds",
            Resource::Source,
            project_id,
        )
    }

    fn validate_required_record_reference(
        &self,
        owner: &str,
        record: &Value,
        field: &str,
        resource: Resource,
        project_id: &str,
    ) -> CoreResult<()> {
        let id = required_record_string(record, field)?;
        self.validate_same_project_reference(owner, resource, id, project_id)
    }

    fn validate_optional_record_reference(
        &self,
        owner: &str,
        record: &Value,
        field: &str,
        resource: Resource,
        project_id: &str,
    ) -> CoreResult<()> {
        if let Some(id) = record.get(field).and_then(Value::as_str) {
            self.validate_same_project_reference(owner, resource, id, project_id)?;
        }
        Ok(())
    }

    fn validate_record_reference_array(
        &self,
        owner: &str,
        record: &Value,
        field: &str,
        resource: Resource,
        project_id: &str,
    ) -> CoreResult<()> {
        for id in record
            .get(field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = id.as_str().ok_or_else(|| {
                CoreError::Validation(format!("{owner}.{field} values must be strings"))
            })?;
            self.validate_same_project_reference(owner, resource, id, project_id)?;
        }
        Ok(())
    }

    fn validate_attachment_link(&self, link: &Value) -> CoreResult<()> {
        let project_id = required_record_string(link, "projectId")?;
        self.validate_required_record_reference(
            "attachment link",
            link,
            "attachmentId",
            Resource::Attachment,
            project_id,
        )?;
        let target_type = required_record_string(link, "targetType")?;
        let target_id = required_record_string(link, "targetId")?;
        if target_type == "project" {
            if target_id != project_id {
                return Err(CoreError::Validation(
                    "attachment link project target must match projectId".to_owned(),
                ));
            }
            self.get_project(project_id)?;
            return Ok(());
        }
        let resource = Resource::parse(target_type).ok_or_else(|| {
            CoreError::Validation(format!("unsupported attachment target type: {target_type}"))
        })?;
        self.validate_same_project_reference("attachment link", resource, target_id, project_id)
    }

    fn save_citation_with_links(
        &mut self,
        citation: Value,
        attachment_ids: &Value,
        expected_revision: i64,
    ) -> CoreResult<Value> {
        self.validate_desktop_record(Resource::Citation, &citation)?;
        let project_id = required_record_string(&citation, "projectId")?.to_owned();
        let citation_id = required_record_string(&citation, "id")?.to_owned();
        let selected = attachment_ids
            .as_array()
            .ok_or_else(|| CoreError::Validation("attachmentIds must be an array".to_owned()))?
            .iter()
            .map(|value| {
                value.as_str().map(str::to_owned).ok_or_else(|| {
                    CoreError::Validation("attachmentIds values must be strings".to_owned())
                })
            })
            .collect::<CoreResult<HashSet<_>>>()?;
        for attachment_id in &selected {
            self.validate_same_project_reference(
                "citation",
                Resource::Attachment,
                attachment_id,
                &project_id,
            )?;
        }
        let state = self
            .load_state()?
            .ok_or_else(|| CoreError::Validation("desktop state is not initialized".to_owned()))?;
        let state: Value = serde_json::from_str(&state.state_json)?;
        let current_links = state
            .get("attachmentLinks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|link| {
                link.get("projectId").and_then(Value::as_str) == Some(project_id.as_str())
                    && link.get("targetType").and_then(Value::as_str) == Some("citation")
                    && link.get("targetId").and_then(Value::as_str) == Some(citation_id.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        let by_attachment = current_links
            .iter()
            .filter_map(|link| {
                link.get("attachmentId")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_owned(), link.clone()))
            })
            .collect::<BTreeMap<_, _>>();
        let mut changes = vec![DesktopRecordChange {
            collection: "citations",
            id: citation_id.clone(),
            project_id: project_id.clone(),
            after: Some(citation.clone()),
        }];
        for link in current_links {
            let attachment_id = required_record_string(&link, "attachmentId")?;
            if !selected.contains(attachment_id) {
                changes.push(DesktopRecordChange {
                    collection: "attachmentLinks",
                    id: required_record_string(&link, "id")?.to_owned(),
                    project_id: project_id.clone(),
                    after: None,
                });
            }
        }
        for attachment_id in selected {
            let link = by_attachment
                .get(&attachment_id)
                .cloned()
                .unwrap_or_else(|| {
                    json!({
                        "id": Uuid::new_v4().to_string(),
                        "projectId": project_id,
                        "attachmentId": attachment_id,
                        "targetType": "citation",
                        "targetId": citation_id,
                        "role": "evidence",
                    })
                });
            changes.push(DesktopRecordChange {
                collection: "attachmentLinks",
                id: required_record_string(&link, "id")
                    .expect("generated attachment link has id")
                    .to_owned(),
                project_id: project_id.clone(),
                after: Some(link),
            });
        }
        self.storage.apply_desktop_record_changes_if_revision(
            "saveCitationWithAttachmentLinks",
            &changes,
            expected_revision,
        )?;
        Ok(citation)
    }

    pub fn load_state(&self) -> CoreResult<Option<NormalizedState>> {
        self.storage
            .load_normalized_state()?
            .map(sanitize_normalized_state)
            .transpose()
    }

    pub fn load_state_snapshot(&self) -> CoreResult<StateSnapshot> {
        let revision = self.storage.data_revision()?;
        let state = self
            .storage
            .load_normalized_state()?
            .map(sanitize_normalized_state)
            .transpose()?;
        Ok(StateSnapshot { revision, state })
    }

    pub fn synchronize_state_if_revision(
        &mut self,
        state_json: &str,
        snapshot_payloads_json: &str,
        expected_revision: i64,
    ) -> CoreResult<i64> {
        let state: Value = serde_json::from_str(state_json)?;
        validate_normalized_state_for_synchronization(&state)?;
        self.storage.synchronize_normalized_state_if_revision(
            state_json,
            snapshot_payloads_json,
            expected_revision,
        )
    }

    pub fn create_manual_snapshot(
        &mut self,
        project_id: &str,
        note: &str,
    ) -> CoreResult<ManualSnapshotResult> {
        let expected_revision = self.data_revision()?;
        self.create_manual_snapshot_if_revision(project_id, note, expected_revision)
    }

    pub fn create_manual_snapshot_if_revision(
        &mut self,
        project_id: &str,
        note: &str,
        expected_revision: i64,
    ) -> CoreResult<ManualSnapshotResult> {
        let note = note.trim();
        if note.is_empty() {
            return Err(CoreError::Validation(
                "manual snapshot requires a name or note".to_owned(),
            ));
        }
        self.get_project(project_id)?;
        let loaded = self.load_state_snapshot()?;
        if loaded.revision != expected_revision {
            return Err(CoreError::RevisionConflict {
                expected: expected_revision,
                actual: loaded.revision,
            });
        }
        let normalized = loaded
            .state
            .ok_or_else(|| CoreError::Validation("local data is not initialized".to_owned()))?;
        let mut state: Value = serde_json::from_str(&normalized.state_json)?;
        let people = state
            .get("people")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::Validation("people collection is missing".to_owned()))?;
        let relationships = state
            .get("relationships")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                CoreError::Validation("relationships collection is missing".to_owned())
            })?;
        let events = state
            .get("events")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::Validation("events collection is missing".to_owned()))?;
        let summary = json!({
            "people": people.iter().filter(|item| {
                item.get("projectId").and_then(Value::as_str) == Some(project_id)
                    && item.get("deletedAt").is_none_or(Value::is_null)
            }).count(),
            "relationships": relationships.iter().filter(|item| {
                item.get("projectId").and_then(Value::as_str) == Some(project_id)
            }).count(),
            "events": events.iter().filter(|item| {
                item.get("projectId").and_then(Value::as_str) == Some(project_id)
            }).count(),
        });
        let created_at = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let snapshot = json!({
            "id": Uuid::new_v4().to_string(),
            "projectId": project_id,
            "createdAt": created_at,
            "reason": "manual",
            "note": note,
            "summary": summary,
        });
        state
            .get_mut("snapshots")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| CoreError::Validation("snapshots collection is missing".to_owned()))?
            .push(snapshot.clone());
        let revision =
            self.storage
                .create_snapshot_if_revision(&snapshot, &state, expected_revision)?;
        Ok(ManualSnapshotResult { snapshot, revision })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_local_attachment_bytes_if_revision(
        &mut self,
        project_id: &str,
        target_type: &str,
        target_id: &str,
        role: &str,
        name: &str,
        mime_type: &str,
        bytes: &[u8],
        attachment_id: &str,
        link_id: &str,
        expected_revision: i64,
    ) -> CoreResult<LocalAttachmentResult> {
        const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;
        if name.trim().is_empty() || bytes.is_empty() {
            return Err(crate::core::error::CoreError::Validation(
                "local attachment file must be non-empty".to_owned(),
            ));
        }
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(crate::core::error::CoreError::Validation(
                "local attachment file exceeds 100 MiB".to_owned(),
            ));
        }
        if !["avatar", "cover", "evidence", "document", "media", "other"].contains(&role) {
            return Err(crate::core::error::CoreError::Validation(
                "attachment role is invalid".to_owned(),
            ));
        }
        self.get_project(project_id)?;
        match target_type {
            "project" if target_id == project_id => {}
            "person" => {
                let person = self
                    .get_record(Resource::Person, target_id)?
                    .ok_or_else(|| crate::core::error::CoreError::NotFound {
                        entity: "person",
                        id: target_id.to_owned(),
                    })?;
                if person.get("projectId").and_then(Value::as_str) != Some(project_id) {
                    return Err(crate::core::error::CoreError::Validation(
                        "attachment target belongs to another project".to_owned(),
                    ));
                }
            }
            _ => {
                return Err(crate::core::error::CoreError::Validation(
                    "local image target must be project or person".to_owned(),
                ));
            }
        }

        let imported = self.import_attachment_bytes(project_id, name, mime_type, bytes, None)?;
        let content_hash = imported.content_hash;
        let already_stored = imported.already_stored;

        let timestamp = OffsetDateTime::now_utc().format(&Rfc3339)?;
        let attachment = json!({
            "id": attachment_id, "projectId": project_id, "name": name,
            "mimeType": if mime_type.is_empty() { "application/octet-stream" } else { mime_type },
            "size": bytes.len(), "contentHash": content_hash, "missing": false,
            "updatedAt": timestamp,
        });
        let link = json!({
            "id": link_id, "projectId": project_id, "attachmentId": attachment_id,
            "targetType": target_type, "targetId": target_id, "role": role,
            "updatedAt": timestamp,
        });
        self.storage
            .replace_attachment_role_if_revision(&attachment, &link, expected_revision)?;
        Ok(LocalAttachmentResult {
            attachment,
            link,
            already_stored,
        })
    }

    pub fn import_attachment_bytes(
        &self,
        project_id: &str,
        name: &str,
        mime_type: &str,
        bytes: &[u8],
        expected_hash: Option<&str>,
    ) -> CoreResult<ImportedAttachmentContent> {
        const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;
        if name.trim().is_empty() {
            return Err(crate::core::error::CoreError::Validation(
                "attachment name must be non-empty".to_owned(),
            ));
        }
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(crate::core::error::CoreError::Validation(
                "local attachment file exceeds 100 MiB".to_owned(),
            ));
        }
        self.get_project(project_id)?;
        let content_hash = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if expected_hash.is_some_and(|expected| expected != content_hash) {
            return Err(crate::core::error::CoreError::Validation(
                "selected file content does not match the original attachment".to_owned(),
            ));
        }
        let final_path = self.attachment_path(project_id, &content_hash)?;
        let already_stored = final_path.is_file();
        if !already_stored {
            let directory = final_path.parent().ok_or_else(|| {
                crate::core::error::CoreError::Validation(
                    "attachment directory is invalid".to_owned(),
                )
            })?;
            fs::create_dir_all(directory)?;
            let temporary_path =
                directory.join(format!(".{content_hash}.pending-{}", Uuid::new_v4()));
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary_path)?;
            if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                let _ = fs::remove_file(&temporary_path);
                return Err(error.into());
            }
            if let Err(error) = fs::rename(&temporary_path, &final_path) {
                let _ = fs::remove_file(&temporary_path);
                return Err(error.into());
            }
        }
        Ok(ImportedAttachmentContent {
            name: name.to_owned(),
            mime_type: if mime_type.is_empty() {
                "application/octet-stream".to_owned()
            } else {
                mime_type.to_owned()
            },
            size: bytes.len() as u64,
            content_hash,
            already_stored,
        })
    }

    pub fn attachment_exists(&self, project_id: &str, content_hash: &str) -> CoreResult<bool> {
        Ok(self.attachment_path(project_id, content_hash)?.is_file())
    }

    pub fn read_attachment(&self, project_id: &str, content_hash: &str) -> CoreResult<Vec<u8>> {
        Ok(fs::read(self.attachment_path(project_id, content_hash)?)?)
    }

    fn attachment_path(&self, project_id: &str, content_hash: &str) -> CoreResult<PathBuf> {
        self.get_project(project_id)?;
        if content_hash.len() != 64 || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(crate::core::error::CoreError::Validation(
                "attachment content hash is invalid".to_owned(),
            ));
        }
        Ok(self
            .data_directory
            .join("attachments")
            .join(project_id)
            .join(content_hash))
    }

    pub fn set_local_attachment_file_if_revision(
        &mut self,
        project_id: &str,
        target_type: &str,
        target_id: &str,
        role: &str,
        path: &Path,
        attachment_id: &str,
        link_id: &str,
        expected_revision: i64,
    ) -> CoreResult<LocalAttachmentResult> {
        if !path.is_absolute() {
            return Err(crate::core::error::CoreError::Validation(
                "attachment path must be absolute".to_owned(),
            ));
        }
        let bytes = fs::read(path)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("attachment");
        let mime_type = mime_type_for_path(path);
        self.set_local_attachment_bytes_if_revision(
            project_id,
            target_type,
            target_id,
            role,
            name,
            mime_type,
            &bytes,
            attachment_id,
            link_id,
            expected_revision,
        )
    }

    pub fn export_project_tree(&self, project_id: &str) -> CoreResult<ProjectTree> {
        let mut data = self.storage.export_project_data(project_id)?;
        sanitize_project_data(&mut data);
        ProjectTree::from_project_data(&data, &self.data_directory.join("attachments"))
    }

    pub fn export_project_archive(
        &self,
        project_id: &str,
        destination: impl AsRef<Path>,
    ) -> CoreResult<()> {
        self.export_project_tree(project_id)?
            .write_archive(destination.as_ref())
    }

    pub fn import_project_archive(
        &mut self,
        source: impl AsRef<Path>,
        overwrite: bool,
    ) -> CoreResult<ProjectRecord> {
        let source = source.as_ref();
        if source.extension().and_then(|value| value.to_str()) != Some(ARCHIVE_EXTENSION) {
            return Err(crate::core::error::CoreError::Validation(format!(
                "project archive must use .{ARCHIVE_EXTENSION}"
            )));
        }
        let tree = ProjectTree::read_archive(source)?;
        self.import_project_tree(&tree, overwrite)
    }

    pub fn import_project_archive_if_revision(
        &mut self,
        source: impl AsRef<Path>,
        overwrite: bool,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        let source = source.as_ref();
        if source.extension().and_then(|value| value.to_str()) != Some(ARCHIVE_EXTENSION) {
            return Err(crate::core::error::CoreError::Validation(format!(
                "project archive must use .{ARCHIVE_EXTENSION}"
            )));
        }
        let tree = ProjectTree::read_archive(source)?;
        self.import_project_tree_if_revision(&tree, overwrite, expected_revision)
    }

    pub fn import_project_tree(
        &mut self,
        tree: &ProjectTree,
        overwrite: bool,
    ) -> CoreResult<ProjectRecord> {
        let mut data = tree.parse_project_data()?;
        sanitize_project_data(&mut data);
        let project_id = data.project_id()?.to_owned();
        let installed =
            tree.install_attachments(&self.data_directory.join("attachments"), &project_id)?;
        self.storage.replace_project_data(&data, overwrite)?;
        installed.commit();
        self.storage.get_project(&project_id)
    }

    pub fn import_project_tree_if_revision(
        &mut self,
        tree: &ProjectTree,
        overwrite: bool,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        let mut data = tree.parse_project_data()?;
        sanitize_project_data(&mut data);
        let project_id = data.project_id()?.to_owned();
        let installed =
            tree.install_attachments(&self.data_directory.join("attachments"), &project_id)?;
        self.storage
            .replace_project_data_if_revision(&data, overwrite, expected_revision)?;
        installed.commit();
        self.storage.get_project(&project_id)
    }

    pub fn replace_empty_project_with_tree_if_revision(
        &mut self,
        placeholder_project_id: &str,
        tree: &ProjectTree,
        expected_revision: i64,
    ) -> CoreResult<ProjectRecord> {
        let mut data = tree.parse_project_data()?;
        sanitize_project_data(&mut data);
        let project_id = data.project_id()?.to_owned();
        let installed =
            tree.install_attachments(&self.data_directory.join("attachments"), &project_id)?;
        self.storage.replace_empty_project_data_if_revision(
            placeholder_project_id,
            &data,
            expected_revision,
        )?;
        installed.commit();
        self.storage.get_project(&project_id)
    }

    pub fn export_project_gedcom(
        &self,
        project_id: &str,
        destination: impl AsRef<Path>,
    ) -> CoreResult<GedcomSummary> {
        let destination = destination.as_ref();
        validate_gedcom_destination(destination)?;
        let mut data = self.storage.export_project_data(project_id)?;
        sanitize_project_data(&mut data);
        let document = export_gedcom(&data)?;
        let parent = destination.parent().ok_or_else(|| {
            CoreError::Validation("GEDCOM destination must have a parent directory".to_owned())
        })?;
        let mut temporary = NamedTempFile::new_in(parent)?;
        temporary.write_all(document.as_bytes())?;
        temporary.as_file_mut().sync_all()?;
        temporary
            .persist(destination)
            .map_err(|error| CoreError::Io(error.error))?;
        Ok(gedcom_export_summary(&data))
    }

    pub fn import_project_gedcom(
        &mut self,
        source: impl AsRef<Path>,
        overwrite: bool,
    ) -> CoreResult<GedcomImportResult> {
        let imported = read_gedcom(source.as_ref())?;
        let project_id = imported.data.project_id()?.to_owned();
        self.storage
            .replace_project_data(&imported.data, overwrite)?;
        Ok(GedcomImportResult {
            project: self.storage.get_project(&project_id)?,
            summary: imported.summary,
        })
    }

    pub fn import_project_gedcom_if_revision(
        &mut self,
        source: impl AsRef<Path>,
        overwrite: bool,
        expected_revision: i64,
    ) -> CoreResult<GedcomImportResult> {
        let imported = read_gedcom(source.as_ref())?;
        let project_id = imported.data.project_id()?.to_owned();
        self.storage.replace_project_data_if_revision(
            &imported.data,
            overwrite,
            expected_revision,
        )?;
        Ok(GedcomImportResult {
            project: self.storage.get_project(&project_id)?,
            summary: imported.summary,
        })
    }
}

fn validate_gedcom_destination(destination: &Path) -> CoreResult<()> {
    if !destination.is_absolute() {
        return Err(CoreError::Validation(
            "GEDCOM destination must be an absolute path".to_owned(),
        ));
    }
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), GEDCOM_EXTENSION | "gedcom") {
        return Err(CoreError::Validation(
            "GEDCOM destination must use .ged or .gedcom".to_owned(),
        ));
    }
    Ok(())
}

fn gedcom_export_summary(data: &ProjectData) -> GedcomSummary {
    let unsupported_count = [
        "organizations",
        "careers",
        "personTitles",
        "events",
        "sources",
        "citations",
        "attachments",
        "attachmentLinks",
        "issues",
    ]
    .into_iter()
    .map(|collection| data.collections[collection].len())
    .sum::<usize>();
    let warnings = (unsupported_count > 0)
        .then(|| {
            format!(
                "{unsupported_count} 条 Branchloom 扩展记录不属于首版 GEDCOM 映射范围，完整备份请使用 .blp 项目包"
            )
        })
        .into_iter()
        .collect();
    GedcomSummary {
        people: data.collections["people"].len(),
        relationships: data.collections["relationships"].len(),
        places: data.collections["places"].len(),
        warnings,
    }
}

fn resolve_batch_references(
    value: &mut Value,
    references: &BTreeMap<String, String>,
    location: &str,
) -> CoreResult<()> {
    match value {
        Value::Object(object)
            if object.len() == 1 && object.get("ref").is_some_and(Value::is_string) =>
        {
            let reference = object["ref"].as_str().expect("ref string checked");
            let id = references.get(reference).ok_or_else(|| {
                CoreError::Validation(format!(
                    "{location} references an unknown or forward ref: {reference}"
                ))
            })?;
            *value = json!(id);
        }
        Value::Object(object) => {
            for child in object.values_mut() {
                resolve_batch_references(child, references, location)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                resolve_batch_references(child, references, location)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn batch_action_id(
    project_id: &str,
    input: &Value,
    revision: i64,
    index: usize,
    resource: Resource,
) -> String {
    let digest = Sha256::digest(
        serde_json::to_vec(&json!({
            "projectId": project_id,
            "input": input,
            "revision": revision,
            "index": index,
            "resource": resource.as_str(),
        }))
        .expect("batch ID seed is serializable"),
    );
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-7{}-8{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

fn relationship_identity(value: &Value) -> CoreResult<String> {
    let category = value
        .get("category")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CoreError::Validation("relationship.category must be a string".to_owned())
        })?;
    let from = value
        .get("fromPersonId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CoreError::Validation("relationship.fromPersonId must be a string".to_owned())
        })?;
    let to = value
        .get("toPersonId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            CoreError::Validation("relationship.toPersonId must be a string".to_owned())
        })?;
    if category == "partner" && from > to {
        Ok(format!("{category}:{to}:{from}"))
    } else {
        Ok(format!("{category}:{from}:{to}"))
    }
}

fn sanitize_normalized_state(mut state: NormalizedState) -> CoreResult<NormalizedState> {
    let mut state_value: Value = serde_json::from_str(&state.state_json)?;
    sanitize_state_value(&mut state_value);
    state.state_json = serde_json::to_string(&state_value)?;

    let mut snapshot_payloads: Value = serde_json::from_str(&state.snapshot_payloads_json)?;
    sanitize_state_value(&mut snapshot_payloads);
    state.snapshot_payloads_json = serde_json::to_string(&snapshot_payloads)?;
    Ok(state)
}

fn sanitize_project_data(data: &mut ProjectData) {
    sanitize_state_value(&mut data.project);
    strip_null_project_record(&mut data.project);
    for records in data.collections.values_mut() {
        records.iter_mut().for_each(sanitize_state_value);
    }
    normalize_demo_attachment_placeholders(data);
}

fn normalize_demo_attachment_placeholders(data: &mut ProjectData) {
    let Some(attachments) = data.collections.get_mut("attachments") else {
        return;
    };
    for attachment in attachments {
        let Some(object) = attachment.as_object_mut() else {
            continue;
        };
        let Some(content_hash) = object
            .get("contentHash")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        let Some(normalized_hash) = normalized_demo_attachment_hash(&content_hash) else {
            continue;
        };
        object.insert("contentHash".to_owned(), json!(normalized_hash));
        object.insert("missing".to_owned(), json!(true));
    }
}

fn normalized_demo_attachment_hash(content_hash: &str) -> Option<&'static str> {
    match content_hash {
        "sha256:demo-register-page-18"
        | "16899059cd934d04216bab163bb68e887e2bb9a5065e66d8be2fdeafb00694c1" => {
            Some("16899059cd934d04216bab163bb68e887e2bb9a5065e66d8be2fdeafb00694c1")
        }
        "sha256:demo-oral-history-audio"
        | "da0c613c913a52e4be4479c3757ca00257d7a0beed6e93c08bfe67b661a02539" => {
            Some("da0c613c913a52e4be4479c3757ca00257d7a0beed6e93c08bfe67b661a02539")
        }
        "sha256:demo-family-reunion-photo"
        | "4e47845db280c0954dd594fa393cd5c14ee0a815288e061b0a31e1a4817a49df" => {
            Some("4e47845db280c0954dd594fa393cd5c14ee0a815288e061b0a31e1a4817a49df")
        }
        "sha256:demo-missing-letter"
        | "c8989a82a0265e0ee015ccb0f3189086fe0af17d2d134ee4eb0d9553f7a653ee" => {
            Some("c8989a82a0265e0ee015ccb0f3189086fe0af17d2d134ee4eb0d9553f7a653ee")
        }
        _ => None,
    }
}

fn sanitize_state_value(value: &mut Value) {
    strip_removed_person_name_fields(value);
    strip_null_project_optionals(value);
}

fn strip_null_project_optionals(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let Some(projects) = object.get_mut("projects").and_then(Value::as_array_mut) {
                for project in projects {
                    strip_null_project_record(project);
                }
            }
            object.values_mut().for_each(strip_null_project_optionals);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_null_project_optionals),
        _ => {}
    }
}

fn strip_null_project_record(value: &mut Value) {
    let Some(project) = value.as_object_mut() else {
        return;
    };
    for key in [
        "coverUrl",
        "defaultPersonId",
        "lastBackupAt",
        "backupSchedule",
    ] {
        if project.get(key).is_some_and(Value::is_null) {
            project.remove(key);
        }
    }
}

fn strip_removed_person_name_fields(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let is_person = object.get("names").is_some_and(Value::is_array)
                && object.contains_key("sex")
                && object.contains_key("status");
            if is_person {
                if let Some(names) = object.get_mut("names").and_then(Value::as_array_mut) {
                    for name in names {
                        if let Some(name) = name.as_object_mut() {
                            name.remove("language");
                            name.remove("script");
                        }
                    }
                }
            }
            object
                .values_mut()
                .for_each(strip_removed_person_name_fields);
        }
        Value::Array(items) => items.iter_mut().for_each(strip_removed_person_name_fields),
        _ => {}
    }
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn validate_normalized_state_for_synchronization(state: &Value) -> CoreResult<()> {
    let projects = state
        .get("projects")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Validation("projects must be an array".to_owned()))?;
    let project_ids = projects
        .iter()
        .map(|project| required_record_string(project, "id").map(str::to_owned))
        .collect::<CoreResult<HashSet<_>>>()?;
    let collections = [
        ("people", "person", Some(Resource::Person)),
        (
            "organizations",
            "organization",
            Some(Resource::Organization),
        ),
        ("careers", "career", Some(Resource::Career)),
        ("personTitles", "title", Some(Resource::Title)),
        (
            "relationships",
            "relationship",
            Some(Resource::Relationship),
        ),
        ("events", "event", Some(Resource::Event)),
        ("places", "place", Some(Resource::Place)),
        ("sources", "source", Some(Resource::Source)),
        ("citations", "citation", Some(Resource::Citation)),
        ("attachments", "attachment", Some(Resource::Attachment)),
        ("attachmentLinks", "attachmentLink", None),
        ("snapshots", "snapshot", None),
        ("issues", "issue", None),
    ];
    let mut index = BTreeMap::<(&'static str, String), String>::new();
    for (collection, entity_type, resource) in collections {
        let records = state
            .get(collection)
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::Validation(format!("{collection} must be an array")))?;
        for record in records {
            let id = required_record_string(record, "id")?;
            let project_id = if entity_type == "issue" {
                if let Some(project_id) = record.get("projectId").and_then(Value::as_str) {
                    project_id.to_owned()
                } else {
                    let target_type = required_record_string(record, "targetType")?;
                    let target_type =
                        canonical_normalized_target_type(target_type).ok_or_else(|| {
                            CoreError::Validation(format!(
                                "unsupported issue target type: {target_type}"
                            ))
                        })?;
                    let target_id = required_record_string(record, "targetId")?;
                    index
                        .get(&(target_type, target_id.to_owned()))
                        .cloned()
                        .ok_or_else(|| {
                            CoreError::Validation(format!(
                                "issue references missing {target_type}: {target_id}"
                            ))
                        })?
                }
            } else {
                required_record_string(record, "projectId")?.to_owned()
            };
            if !project_ids.contains(&project_id) {
                return Err(CoreError::Validation(format!(
                    "{collection}/{id} belongs to a missing project: {project_id}"
                )));
            }
            if index
                .insert((entity_type, id.to_owned()), project_id)
                .is_some()
            {
                return Err(CoreError::Validation(format!(
                    "duplicate id in {collection}: {id}"
                )));
            }
            if let Some(resource) = resource {
                if matches!(
                    resource,
                    Resource::Person
                        | Resource::Relationship
                        | Resource::Event
                        | Resource::Source
                        | Resource::Citation
                ) {
                    validate_record(resource, record)?;
                }
            }
        }
    }

    let records = |collection: &str| {
        state
            .get(collection)
            .and_then(Value::as_array)
            .expect("normalized collection checked")
    };
    let check_field = |owner: &str,
                       record: &Value,
                       field: &str,
                       target_type: &'static str,
                       required: bool|
     -> CoreResult<()> {
        let value = record.get(field);
        if value.is_none() && !required {
            return Ok(());
        }
        let id = value
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::Validation(format!("{owner}.{field} must be a string")))?;
        validate_normalized_reference(&index, owner, record, target_type, id)
    };
    let check_array =
        |owner: &str, record: &Value, field: &str, target_type: &'static str| -> CoreResult<()> {
            for value in record
                .get(field)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let id = value.as_str().ok_or_else(|| {
                    CoreError::Validation(format!("{owner}.{field} values must be strings"))
                })?;
                validate_normalized_reference(&index, owner, record, target_type, id)?;
            }
            Ok(())
        };

    for person in records("people") {
        check_field("person", person, "birthPlaceId", "place", false)?;
        check_field("person", person, "deathPlaceId", "place", false)?;
        check_array("person", person, "sourceIds", "source")?;
    }
    for organization in records("organizations") {
        check_field(
            "organization",
            organization,
            "parentId",
            "organization",
            false,
        )?;
        check_field("organization", organization, "placeId", "place", false)?;
        check_array("organization", organization, "sourceIds", "source")?;
    }
    for career in records("careers") {
        check_field("career", career, "personId", "person", true)?;
        check_field("career", career, "organizationId", "organization", false)?;
        check_field("career", career, "jurisdictionPlaceId", "place", false)?;
        check_field("career", career, "appointedByPersonId", "person", false)?;
        check_array("career", career, "sourceIds", "source")?;
    }
    for title in records("personTitles") {
        check_field("title", title, "personId", "person", true)?;
        check_field("title", title, "placeId", "place", false)?;
        check_field("title", title, "grantedByPersonId", "person", false)?;
        check_array("title", title, "sourceIds", "source")?;
    }
    for relationship in records("relationships") {
        check_field("relationship", relationship, "fromPersonId", "person", true)?;
        check_field("relationship", relationship, "toPersonId", "person", true)?;
        check_field("relationship", relationship, "placeId", "place", false)?;
        check_array("relationship", relationship, "sourceIds", "source")?;
    }
    for event in records("events") {
        check_field("event", event, "placeId", "place", false)?;
        check_array("event", event, "participantIds", "person")?;
        check_array("event", event, "sourceIds", "source")?;
    }
    for place in records("places") {
        check_field("place", place, "parentId", "place", false)?;
    }
    for citation in records("citations") {
        check_field("citation", citation, "sourceId", "source", true)?;
        let target_type = required_record_string(citation, "targetType")?;
        let target_type = canonical_normalized_target_type(target_type).ok_or_else(|| {
            CoreError::Validation(format!("unsupported citation target type: {target_type}"))
        })?;
        check_field("citation", citation, "targetId", target_type, true)?;
    }
    for link in records("attachmentLinks") {
        check_field("attachment link", link, "attachmentId", "attachment", true)?;
        let target_type = required_record_string(link, "targetType")?;
        if target_type == "project" {
            if required_record_string(link, "targetId")?
                != required_record_string(link, "projectId")?
            {
                return Err(CoreError::Validation(
                    "attachment link project target must match projectId".to_owned(),
                ));
            }
        } else {
            let target_type = canonical_normalized_target_type(target_type).ok_or_else(|| {
                CoreError::Validation(format!(
                    "unsupported attachment link target type: {target_type}"
                ))
            })?;
            check_field("attachment link", link, "targetId", target_type, true)?;
        }
    }
    Ok(())
}

fn validate_normalized_reference(
    index: &BTreeMap<(&'static str, String), String>,
    owner: &str,
    record: &Value,
    target_type: &'static str,
    target_id: &str,
) -> CoreResult<()> {
    let project_id = required_record_string(record, "projectId")?;
    match index.get(&(target_type, target_id.to_owned())) {
        Some(target_project_id) if target_project_id == project_id => Ok(()),
        Some(_) => Err(CoreError::Validation(format!(
            "{owner} references {target_type} from another project: {target_id}"
        ))),
        None => Err(CoreError::Validation(format!(
            "{owner} references missing {target_type}: {target_id}"
        ))),
    }
}

fn canonical_normalized_target_type(value: &str) -> Option<&'static str> {
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
        _ => None,
    }
}

fn mutation_arg<'a>(args: &'a [Value], index: usize) -> CoreResult<&'a Value> {
    args.get(index).ok_or_else(|| {
        CoreError::Validation(format!("desktop mutation argument {index} is required"))
    })
}

fn mutation_string_arg(args: &[Value], index: usize) -> CoreResult<&str> {
    mutation_arg(args, index)?.as_str().ok_or_else(|| {
        CoreError::Validation(format!(
            "desktop mutation argument {index} must be a string"
        ))
    })
}

fn required_record_string<'a>(record: &'a Value, field: &str) -> CoreResult<&'a str> {
    record
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Validation(format!("desktop record {field} must be a string")))
}

fn desktop_collection(resource: Resource) -> &'static str {
    match resource {
        Resource::Person => "people",
        Resource::Organization => "organizations",
        Resource::Career => "careers",
        Resource::Title => "personTitles",
        Resource::Relationship => "relationships",
        Resource::Event => "events",
        Resource::Place => "places",
        Resource::Source => "sources",
        Resource::Citation => "citations",
        Resource::Attachment => "attachments",
    }
}

fn strip_runtime_media_record(resource: Resource, record: &mut Value) {
    let Some(object) = record.as_object_mut() else {
        return;
    };
    match resource {
        Resource::Person => {
            object.remove("avatarUrl");
        }
        Resource::Attachment => {
            object.remove("previewUrl");
        }
        _ => {}
    }
}

pub type StatePayload = NormalizedState;

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn gedcom_export_atomically_replaces_an_existing_destination() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-gedcom-export".to_owned(),
                NewProject {
                    name: "GEDCOM Export".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let destination = directory.path().join("family.ged");
        fs::write(&destination, b"previous export").expect("write previous export");

        service
            .export_project_gedcom("project-gedcom-export", &destination)
            .expect("replace GEDCOM export");

        let exported = fs::read_to_string(destination).expect("read replaced GEDCOM");
        assert!(exported.starts_with("0 HEAD\r\n"));
        assert!(exported.ends_with("0 TRLR\r\n"));
        assert!(!exported.contains("previous export"));
    }

    #[test]
    fn project_archive_normalizes_legacy_demo_attachment_placeholders() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-demo-export".to_owned(),
                NewProject {
                    name: "Demo Export".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        service
            .put_record(
                Resource::Attachment,
                "attachment-demo",
                "project-demo-export",
                &json!({
                    "id": "attachment-demo",
                    "projectId": "project-demo-export",
                    "name": "演示访谈.m4a",
                    "mimeType": "audio/mp4",
                    "size": 1024,
                    "contentHash": "sha256:demo-oral-history-audio",
                    "missing": false
                }),
            )
            .expect("store legacy demo attachment");
        service
            .put_record(
                Resource::Attachment,
                "attachment-demo-normalized",
                "project-demo-export",
                &json!({
                    "id": "attachment-demo-normalized",
                    "projectId": "project-demo-export",
                    "name": "演示合影.jpg",
                    "mimeType": "image/jpeg",
                    "size": 2048,
                    "contentHash": "4e47845db280c0954dd594fa393cd5c14ee0a815288e061b0a31e1a4817a49df",
                    "missing": false
                }),
            )
            .expect("store normalized demo attachment");
        let archive = directory.path().join("demo.blp");

        service
            .export_project_archive("project-demo-export", &archive)
            .expect("export demo project archive");

        let tree = ProjectTree::read_archive(&archive).expect("read project archive");
        let data = tree.parse_project_data().expect("parse project data");
        let attachments = &data.collections["attachments"];
        let attachment = attachments
            .iter()
            .find(|attachment| attachment["id"] == "attachment-demo")
            .expect("legacy demo attachment");
        assert_eq!(
            attachment["contentHash"],
            "da0c613c913a52e4be4479c3757ca00257d7a0beed6e93c08bfe67b661a02539"
        );
        assert_eq!(attachment["missing"], true);
        let normalized_attachment = attachments
            .iter()
            .find(|attachment| attachment["id"] == "attachment-demo-normalized")
            .expect("normalized demo attachment");
        assert_eq!(
            normalized_attachment["contentHash"],
            "4e47845db280c0954dd594fa393cd5c14ee0a815288e061b0a31e1a4817a49df"
        );
        assert_eq!(normalized_attachment["missing"], true);
        assert!(tree
            .files()
            .keys()
            .all(|path| !path.starts_with("media/sha256/")));
    }

    #[test]
    fn duplicate_candidate_query_is_read_only_and_uses_core_name_semantics() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        for (id, personal_name) in [("zhao-kai", "赵楷"), ("zhao-gong", "赵栱")] {
            service
                .put_record(
                    Resource::Person,
                    id,
                    "project-test",
                    &json!({
                        "id": id,
                        "projectId": "project-test",
                        "names": [
                            { "value": personal_name, "type": "personal", "primary": true },
                            { "value": "郓王", "type": "honorific", "primary": false }
                        ],
                        "sex": "male",
                        "status": "deceased",
                        "biography": "",
                        "notes": ""
                    }),
                )
                .expect("store person");
        }
        let revision = service.data_revision().expect("read revision");

        let first = service
            .list_duplicate_candidates("project-test")
            .expect("list candidates");
        let second = service
            .list_duplicate_candidates("project-test")
            .expect("repeat list candidates");

        assert!(first.is_empty());
        assert_eq!(first, second);
        assert_eq!(service.data_revision().unwrap(), revision);
    }

    #[test]
    fn event_validation_requires_references_in_the_same_project() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let person = json!({
            "id": "person-test",
            "projectId": "project-test",
            "names": [{ "value": "赵匡胤", "type": "personal", "primary": true }],
            "sex": "male",
            "status": "deceased",
            "biography": "",
            "notes": ""
        });
        service
            .put_record(Resource::Person, "person-test", "project-test", &person)
            .expect("store person");

        let event = json!({
            "id": "event-test",
            "projectId": "project-test",
            "type": "accession",
            "title": "赵匡胤即皇帝位",
            "date": { "precision": "exact", "start": "0960-02-04" },
            "participantIds": ["person-test"],
            "sourceIds": [],
            "notes": ""
        });
        service
            .validate_record(Resource::Event, &event)
            .expect("event references person in project");

        let mut missing = event;
        missing["participantIds"] = json!(["person-missing"]);
        assert!(matches!(
            service.validate_record(Resource::Event, &missing),
            Err(CoreError::Validation(message)) if message.contains("missing person")
        ));
    }

    #[test]
    fn relationship_and_citation_validation_require_same_project_references() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        for (id, name) in [("project-test", "Test"), ("project-other", "Other")] {
            service
                .create_project_with_id(
                    id.to_owned(),
                    NewProject {
                        name: name.to_owned(),
                        description: String::new(),
                    },
                )
                .expect("create project");
        }
        for (id, project_id, name) in [
            ("person-parent", "project-test", "赵弘殷"),
            ("person-child", "project-test", "赵匡胤"),
            ("person-other", "project-other", "他项目人物"),
        ] {
            let person = json!({
                "id": id,
                "projectId": project_id,
                "names": [{ "value": name, "type": "personal", "primary": true }],
                "sex": "male",
                "status": "deceased",
                "biography": "",
                "notes": ""
            });
            service
                .put_record(Resource::Person, id, project_id, &person)
                .expect("store person");
        }
        let source = json!({
            "id": "source-song-shi",
            "projectId": "project-test",
            "title": "宋史",
            "type": "book",
            "notes": ""
        });
        service
            .put_record(Resource::Source, "source-song-shi", "project-test", &source)
            .expect("store source");

        let relationship = json!({
            "id": "relationship-test",
            "projectId": "project-test",
            "fromPersonId": "person-parent",
            "toPersonId": "person-child",
            "category": "parent",
            "type": "biological",
            "sourceIds": ["source-song-shi"],
            "notes": ""
        });
        service
            .validate_record(Resource::Relationship, &relationship)
            .expect("relationship references records in project");

        let mut cross_project = relationship.clone();
        cross_project["toPersonId"] = json!("person-other");
        assert!(matches!(
            service.validate_record(Resource::Relationship, &cross_project),
            Err(CoreError::Validation(message)) if message.contains("another project")
        ));

        let citation = json!({
            "id": "citation-test",
            "projectId": "project-test",
            "sourceId": "source-song-shi",
            "targetType": "person",
            "targetId": "person-child",
            "notes": ""
        });
        service
            .validate_record(Resource::Citation, &citation)
            .expect("citation references source and target in project");

        let mut missing_target = citation;
        missing_target["targetId"] = json!("person-missing");
        assert!(matches!(
            service.validate_record(Resource::Citation, &missing_target),
            Err(CoreError::Validation(message)) if message.contains("missing person")
        ));
    }

    #[test]
    fn person_relationship_batch_resolves_refs_and_commits_once() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        service
            .put_record(
                Resource::Person,
                "person-child",
                "project-test",
                &json!({
                    "id": "person-child",
                    "projectId": "project-test",
                    "names": [{ "value": "Child", "type": "personal", "primary": true }],
                    "sex": "unknown",
                    "status": "unknown",
                    "biography": "",
                    "notes": ""
                }),
            )
            .expect("create existing child");
        let before_revision = service.data_revision().expect("read revision");
        let input = json!({
            "actions": [
                {
                    "resource": "person",
                    "action": "create",
                    "ref": "new-parent",
                    "payload": {
                        "names": [{ "value": "Parent", "type": "personal", "primary": true }],
                        "sex": "female",
                        "status": "unknown"
                    }
                },
                {
                    "resource": "relationship",
                    "action": "add",
                    "payload": {
                        "fromPersonId": { "ref": "new-parent" },
                        "toPersonId": "person-child",
                        "category": "parent",
                        "type": "biological"
                    }
                }
            ]
        });

        let plan = service
            .plan_person_relationship_batch("project-test", &input)
            .expect("plan batch");
        assert_eq!(
            plan,
            service
                .plan_person_relationship_batch("project-test", &input)
                .expect("repeat stable plan")
        );
        assert!(plan.high_risk);
        let parent_id = plan.reference_ids["new-parent"].clone();
        assert_eq!(plan.actions[1].record["fromPersonId"], parent_id);
        assert_eq!(service.data_revision().unwrap(), before_revision);

        let applied = service
            .apply_person_relationship_batch(&plan)
            .expect("apply batch");
        assert_eq!(applied.revision, before_revision + 1);
        assert!(!applied.change_set_id.is_empty());
        assert!(service
            .get_record(Resource::Person, &parent_id)
            .expect("read parent")
            .is_some());
        let relationships = service
            .list_records(Resource::Relationship, "project-test")
            .expect("list relationships");
        assert_eq!(relationships.len(), 1);
        assert_eq!(relationships[0]["fromPersonId"], parent_id);
    }

    #[test]
    fn person_relationship_batch_rejects_forward_refs_without_writing() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let before_revision = service.data_revision().expect("read revision");
        let input = json!({
            "actions": [
                {
                    "resource": "relationship",
                    "action": "add",
                    "payload": {
                        "fromPersonId": { "ref": "later" },
                        "toPersonId": { "ref": "later" },
                        "category": "partner",
                        "type": "married"
                    }
                },
                {
                    "resource": "person",
                    "action": "create",
                    "ref": "later",
                    "payload": {
                        "names": [{ "value": "Later", "type": "personal", "primary": true }]
                    }
                }
            ]
        });

        assert!(matches!(
            service.plan_person_relationship_batch("project-test", &input),
            Err(CoreError::Validation(message)) if message.contains("forward ref")
        ));
        assert_eq!(service.data_revision().unwrap(), before_revision);
        assert!(service
            .list_records(Resource::Person, "project-test")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn read_paths_hide_removed_person_name_fields_from_desktop_and_cli_consumers() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let legacy_person = json!({
            "id": "person-legacy",
            "projectId": "project-test",
            "names": [{
                "value": "Alex",
                "type": "personal",
                "primary": true,
                "language": "en",
                "script": "Latn"
            }],
            "sex": "unknown",
            "status": "unknown",
            "biography": "",
            "notes": "",
            "updatedAt": "2030-01-02T03:04:05Z"
        });
        service
            .storage
            .put_record(
                Resource::Person,
                "person-legacy",
                "project-test",
                &legacy_person,
            )
            .expect("store legacy person");

        let record = service
            .get_record(Resource::Person, "person-legacy")
            .expect("read person")
            .expect("person exists");
        assert!(record["names"][0].get("language").is_none());
        assert!(record["names"][0].get("script").is_none());

        let state = service.load_state().expect("load state").expect("state");
        let value: Value = serde_json::from_str(&state.state_json).expect("parse state");
        assert!(value["people"][0]["names"][0].get("language").is_none());
        assert!(value["people"][0]["names"][0].get("script").is_none());
    }

    #[test]
    fn local_avatar_content_is_deduplicated_and_linked_through_the_core() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let person = json!({
            "id": "person-test",
            "projectId": "project-test",
            "names": [{ "value": "Alex", "type": "personal", "primary": true }],
            "sex": "unknown",
            "status": "unknown",
            "biography": "",
            "notes": "",
            "updatedAt": "2030-01-02T03:04:05Z"
        });
        service
            .put_record(Resource::Person, "person-test", "project-test", &person)
            .expect("create person");
        let project_before = service.get_project("project-test").expect("read project");
        let raw_before = service
            .storage
            .load_normalized_state()
            .expect("load raw state")
            .expect("raw state");
        let raw_before: Value =
            serde_json::from_str(&raw_before.state_json).expect("parse raw state");
        let raw_project_before = raw_before["projects"][0].clone();

        let revision = service.data_revision().expect("read revision");
        let first = service
            .set_local_attachment_bytes_if_revision(
                "project-test",
                "person",
                "person-test",
                "avatar",
                "avatar.png",
                "image/png",
                b"image-content",
                "attachment-one",
                "link-one",
                revision,
            )
            .expect("set avatar");
        assert!(!first.already_stored);
        assert!(service
            .attachment_exists(
                "project-test",
                first.attachment["contentHash"].as_str().unwrap()
            )
            .expect("check attachment"));
        assert_eq!(
            service
                .read_attachment(
                    "project-test",
                    first.attachment["contentHash"].as_str().unwrap()
                )
                .expect("read attachment"),
            b"image-content"
        );

        let revision = service.data_revision().expect("read revision");
        let second = service
            .set_local_attachment_bytes_if_revision(
                "project-test",
                "person",
                "person-test",
                "avatar",
                "avatar-copy.png",
                "image/png",
                b"image-content",
                "attachment-two",
                "link-two",
                revision,
            )
            .expect("replace avatar with same content");
        assert!(second.already_stored);
        let state = service.load_state().expect("load state").expect("state");
        let value: Value = serde_json::from_str(&state.state_json).expect("parse state");
        let avatar_links = value["attachmentLinks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|link| link["targetId"] == "person-test" && link["role"] == "avatar")
            .collect::<Vec<_>>();
        assert_eq!(avatar_links.len(), 1);
        assert_eq!(avatar_links[0]["attachmentId"], "attachment-two");
        assert_eq!(value["attachments"].as_array().unwrap().len(), 1);
        assert_eq!(
            service.get_project("project-test").expect("read project"),
            project_before
        );
        let raw_after = service
            .storage
            .load_normalized_state()
            .expect("load raw state")
            .expect("raw state");
        let raw_after: Value =
            serde_json::from_str(&raw_after.state_json).expect("parse raw state");
        assert_eq!(raw_after["projects"][0], raw_project_before);
        for key in ["coverUrl", "defaultPersonId", "lastBackupAt"] {
            assert!(value["projects"][0].get(key).is_none());
        }
    }

    #[test]
    fn normalized_state_omits_null_project_optionals_from_main_and_snapshots() {
        let project = json!({
            "id": "project-test",
            "name": "Test",
            "description": "",
            "coverUrl": null,
            "defaultPersonId": null,
            "createdAt": "2030-01-02T03:04:05Z",
            "updatedAt": "2030-01-02T03:04:05Z",
            "lastBackupAt": null,
            "backupSchedule": null
        });
        let state = json!({ "projects": [project] });
        let sanitized = sanitize_normalized_state(NormalizedState {
            state_json: serde_json::to_string(&state).expect("serialize state"),
            snapshot_payloads_json: serde_json::to_string(&json!({
                "snapshot-test": state
            }))
            .expect("serialize snapshots"),
        })
        .expect("sanitize normalized state");

        let main: Value = serde_json::from_str(&sanitized.state_json).expect("parse main state");
        let snapshots: Value = serde_json::from_str(&sanitized.snapshot_payloads_json)
            .expect("parse snapshot payloads");
        for project in [
            &main["projects"][0],
            &snapshots["snapshot-test"]["projects"][0],
        ] {
            for key in [
                "coverUrl",
                "defaultPersonId",
                "lastBackupAt",
                "backupSchedule",
            ] {
                assert!(project.get(key).is_none(), "{key} should be omitted");
            }
        }
    }

    #[test]
    fn manual_snapshot_is_created_atomically_with_a_restorable_payload() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        service
            .create_project_with_id(
                "project-test".to_owned(),
                NewProject {
                    name: "Test".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let person = json!({
            "id": "person-test",
            "projectId": "project-test",
            "names": [{ "value": "赵匡胤", "type": "personal", "primary": true }],
            "sex": "male",
            "status": "deceased",
            "biography": "",
            "notes": ""
        });
        service
            .put_record(Resource::Person, "person-test", "project-test", &person)
            .expect("store person");

        let before = service.data_revision().expect("read revision");
        let created = service
            .create_manual_snapshot_if_revision("project-test", "  研究节点  ", before)
            .expect("create snapshot");
        assert_eq!(created.revision, before + 1);
        assert_eq!(created.snapshot["reason"], "manual");
        assert_eq!(created.snapshot["note"], "研究节点");
        assert_eq!(created.snapshot["summary"]["people"], 1);

        let state = service.load_state().expect("load state").expect("state");
        let state_value: Value = serde_json::from_str(&state.state_json).expect("parse state");
        let payloads: Value =
            serde_json::from_str(&state.snapshot_payloads_json).expect("parse payloads");
        let snapshot_id = created.snapshot["id"].as_str().expect("snapshot id");
        assert_eq!(state_value["snapshots"][0]["id"], snapshot_id);
        assert_eq!(payloads[snapshot_id]["snapshots"][0]["id"], snapshot_id);

        assert!(matches!(
            service.create_manual_snapshot_if_revision("project-test", "stale", before),
            Err(CoreError::RevisionConflict { .. })
        ));
        assert!(matches!(
            service.create_manual_snapshot("project-test", "   "),
            Err(CoreError::Validation(message)) if message.contains("requires")
        ));
    }

    #[test]
    fn desktop_mutations_are_validated_and_written_by_the_core() {
        let directory = tempdir().expect("create data directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut service = ApplicationService::open(&database).expect("open core");
        for (id, name) in [("project-a", "A"), ("project-b", "B")] {
            service
                .create_project_with_id(
                    id.to_owned(),
                    NewProject {
                        name: name.to_owned(),
                        description: String::new(),
                    },
                )
                .expect("create project");
        }
        for (id, project_id) in [("person-a", "project-a"), ("person-b", "project-b")] {
            service
                .put_record(
                    Resource::Person,
                    id,
                    project_id,
                    &json!({
                        "id": id,
                        "projectId": project_id,
                        "names": [{ "value": id, "type": "personal", "primary": true }],
                        "sex": "unknown",
                        "status": "unknown",
                        "biography": "",
                        "notes": "",
                        "updatedAt": "2026-01-01T00:00:00Z"
                    }),
                )
                .expect("create person");
        }
        let before = service.data_revision().expect("read revision");
        let cross_project = json!([{
            "id": "relationship-cross",
            "projectId": "project-a",
            "fromPersonId": "person-a",
            "toPersonId": "person-b",
            "category": "partner",
            "type": "married",
            "sourceIds": [],
            "notes": "",
            "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        assert!(matches!(
            service.apply_desktop_mutation_if_revision(
                "saveRelationship",
                &cross_project,
                before,
            ),
            Err(CoreError::Validation(message)) if message.contains("another project")
        ));
        assert_eq!(service.data_revision().unwrap(), before);

        let valid = json!([{
            "id": "person-new",
            "projectId": "project-a",
            "names": [{ "value": "New", "type": "personal", "primary": true }],
            "sex": "unknown",
            "status": "unknown",
            "biography": "",
            "notes": "",
            "updatedAt": "2026-01-01T00:00:00Z"
        }]);
        let outcome = service
            .apply_desktop_mutation_if_revision("savePerson", &valid, before)
            .expect("save through desktop command");
        assert_eq!(outcome.result["id"], "person-new");
        assert_eq!(outcome.revision, before + 1);

        let snapshot = service.load_state().expect("load state").expect("state");
        let mut full_state: Value =
            serde_json::from_str(&snapshot.state_json).expect("parse state");
        full_state["relationships"]
            .as_array_mut()
            .expect("relationships")
            .push(cross_project[0].clone());
        let revision = service.data_revision().expect("read current revision");
        assert!(matches!(
            service.synchronize_state_if_revision(
                &full_state.to_string(),
                &snapshot.snapshot_payloads_json,
                revision,
            ),
            Err(CoreError::Validation(message)) if message.contains("another project")
        ));
        assert_eq!(service.data_revision().unwrap(), revision);
    }
}
