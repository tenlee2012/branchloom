use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use branchloom_core::application::{
    ApplicationService, BusinessResource as Resource, SCHEMA_VERSION,
};
use branchloom_core::contract::{
    capabilities_json, describe_resource, writable_fields, PUBLIC_CONTRACT_VERSION,
};
use branchloom_core::core::error::CoreError;
use branchloom_core::core::project::{NewProject, ProjectPatch};
use branchloom_core::data_location::{
    database_path as canonical_database_path, default_data_directory, profile_data_directory,
};
use branchloom_core::project_format::ProjectTree;
use branchloom_core::sync::{
    load_connection, save_connection, save_sync_baseline, ConflictResolution, GithubConnection,
    GithubRemote, SyncMode, SyncService,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

mod web_bridge;

const CLI_VERSION: &str = env!("CARGO_PKG_VERSION");
const CONTRACT_VERSION: u64 = PUBLIC_CONTRACT_VERSION;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().is_some_and(|value| value == "web-bridge") {
        let data_dir = match resolve_data_dir(&args) {
            Ok(data_dir) => data_dir,
            Err(error) => {
                eprintln!("Error [{}]: {}", error.code, error.message);
                std::process::exit(error.exit_code);
            }
        };
        if let Err(error) = web_bridge::serve(&args[1..], &data_dir) {
            eprintln!("Error [WEB_BRIDGE]: {error}");
            std::process::exit(1);
        }
        return;
    }
    let json_output = option(&args, "--output").is_some_and(|value| value == "json");
    match run(&args) {
        Ok(data) => emit_success(data, json_output),
        Err(error) => {
            if json_output {
                println!(
                    "{}",
                    json!({
                        "ok": false,
                        "contractVersion": CONTRACT_VERSION,
                        "error": {
                            "code": error.code,
                            "message": error.message,
                            "details": error.details,
                        }
                    })
                );
            } else {
                eprintln!("Error [{}]: {}", error.code, error.message);
            }
            std::process::exit(error.exit_code);
        }
    }
}

fn run(args: &[String]) -> CliResult<Value> {
    if args.is_empty() || flag(args, "--help") {
        print_help();
        std::process::exit(0);
    }
    if flag(args, "--version") || args.first().is_some_and(|value| value == "version") {
        return Ok(json!({
            "cliVersion": CLI_VERSION,
            "contractVersion": CONTRACT_VERSION,
            "runtime": "rust",
        }));
    }
    let data_dir = resolve_data_dir(args)?;
    if args.first().is_some_and(|value| value == "doctor") {
        return doctor(&data_dir);
    }
    let resource = args
        .first()
        .ok_or_else(|| CliError::usage("INVALID_ARGUMENT", "Missing resource"))?;
    let action = args
        .get(1)
        .ok_or_else(|| CliError::usage("INVALID_ARGUMENT", "Missing action"))?;
    if resource == "project" {
        return dispatch_project(action, args, &data_dir);
    }
    if resource == "github" {
        return dispatch_github(action, args, &data_dir);
    }
    if resource == "batch" {
        return dispatch_batch(action, args, &data_dir);
    }
    let resource = Resource::parse(resource).ok_or_else(|| {
        CliError::usage(
            "UNSUPPORTED_RESOURCE",
            format!("Unknown resource {resource}"),
        )
    })?;
    dispatch_entity(resource, action, args, &data_dir)
}

fn dispatch_batch(action: &str, args: &[String], data_dir: &Path) -> CliResult<Value> {
    if action != "run" {
        return Err(CliError::usage(
            "UNSUPPORTED_ACTION",
            format!("Unsupported batch action {action}"),
        ));
    }
    for argument in args.iter().filter(|argument| argument.starts_with("--")) {
        if ![
            "--data-dir",
            "--profile",
            "--project",
            "--input",
            "--output",
            "--apply",
            "--if-match",
            "--confirm-destructive",
        ]
        .contains(&argument.as_str())
        {
            return Err(CliError::usage(
                "UNKNOWN_OPTION",
                format!("Unknown option {argument}"),
            ));
        }
    }
    let project_id = required_option(args, "--project")?;
    let input = read_batch_input(args)?;
    fs::create_dir_all(data_dir).map_err(CliError::io)?;
    let database_path = canonical_database_path(data_dir);
    let mut service = ApplicationService::open(&database_path).map_err(CliError::core)?;
    let plan = service
        .plan_person_relationship_batch(&project_id, &input)
        .map_err(CliError::core)?;
    let plan_json = batch_plan_json(&plan);
    let current = json!({
        "revision": plan.expected_revision,
        "actions": plan_json["actions"],
        "refMap": plan_json["refMap"],
    });
    let etag = etag("batch.run", &project_id, &input, &current);
    let confirmation = plan
        .high_risk
        .then(|| confirmation_token("batch.run", &project_id, &etag));
    if !flag(args, "--apply") {
        let mut result = json!({
            "status": "preview",
            "operation": "batch.run",
            "target": { "resource": "project", "id": project_id },
            "actions": plan_json["actions"],
            "refMap": plan_json["refMap"],
            "patch": plan.actions.iter().map(|action| json!({
                "op": "add",
                "path": if action.resource == Resource::Person { "/people/-" } else { "/relationships/-" },
                "value": action.record,
            })).collect::<Vec<_>>(),
            "affected": plan.actions.iter().map(|action| json!({
                "resource": action.resource.as_str(),
                "id": action.id,
                "action": action.action,
            })).collect::<Vec<_>>(),
            "cascade": [],
            "warnings": [],
            "highRisk": plan.high_risk,
            "etag": etag,
        });
        if let Some(token) = confirmation {
            result["destructiveConfirmation"] = json!(token);
        }
        return Ok(result);
    }
    require_match(args, &etag)?;
    if let Some(token) = confirmation {
        require_destructive(args, &token)?;
    }
    let applied = service
        .apply_person_relationship_batch(&plan)
        .map_err(CliError::core)?;
    let actions = plan
        .actions
        .iter()
        .zip(applied.records.iter())
        .map(|(action, record)| {
            json!({
                "index": action.index,
                "resource": action.resource.as_str(),
                "action": action.action,
                "id": action.id,
                "ref": action.declared_ref,
                "record": record,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "status": "applied",
        "operation": "batch.run",
        "target": { "resource": "project", "id": project_id },
        "actions": actions,
        "refMap": plan.reference_ids,
        "changeSetId": applied.change_set_id,
        "revision": applied.revision,
    }))
}

fn batch_plan_json(plan: &branchloom_core::application::PersonRelationshipBatchPlan) -> Value {
    json!({
        "actions": plan.actions.iter().map(|action| json!({
            "index": action.index,
            "resource": action.resource.as_str(),
            "action": action.action,
            "id": action.id,
            "ref": action.declared_ref,
            "record": action.record,
        })).collect::<Vec<_>>(),
        "refMap": plan.reference_ids,
    })
}

fn read_batch_input(args: &[String]) -> CliResult<Value> {
    let path = PathBuf::from(required_option(args, "--input")?);
    if !path.is_absolute() {
        return Err(CliError::usage(
            "INVALID_INPUT_PATH",
            "--input must be an absolute JSON file path",
        ));
    }
    let metadata = fs::metadata(&path).map_err(CliError::io)?;
    if !metadata.is_file() || metadata.len() > 10 * 1024 * 1024 {
        return Err(CliError::usage(
            "INVALID_INPUT_FILE",
            "Input must be a JSON file no larger than 10 MiB",
        ));
    }
    serde_json::from_slice(&fs::read(path).map_err(CliError::io)?)
        .map_err(|error| CliError::usage("INVALID_JSON", format!("Invalid input JSON: {error}")))
}

fn dispatch_project(action: &str, args: &[String], data_dir: &Path) -> CliResult<Value> {
    if action == "describe" {
        return Ok(json!({
            "resource": "project",
            "actions": ["describe", "list", "get", "create", "update", "delete", "snapshot", "export", "import"],
            "scope": null,
            "systemFields": ["id", "createdAt", "updatedAt"],
            "readableFields": ["id", "name", "description", "defaultPersonId", "createdAt", "updatedAt"],
            "filterFields": [],
            "includes": [],
            "writeSchemas": {
                "create": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["name"],
                    "properties": {
                        "name": { "type": "string", "minLength": 1 },
                        "description": { "type": "string", "default": "" }
                    }
                },
                "update": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "name": { "type": "string", "minLength": 1 },
                        "description": { "type": "string" }
                    }
                },
                "snapshot": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["note"],
                    "properties": {
                        "note": { "type": "string", "minLength": 1 }
                    }
                }
            },
            "schemaStatus": "published"
        }));
    }
    fs::create_dir_all(data_dir).map_err(CliError::io)?;
    let database_path = canonical_database_path(data_dir);
    let mut service = ApplicationService::open(&database_path).map_err(CliError::core)?;
    match action {
        "list" => {
            let projects = service
                .list_projects()
                .map_err(CliError::core)?
                .into_iter()
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(CliError::internal)?;
            Ok(Value::Array(project_fields(
                projects,
                option(args, "--fields"),
            )?))
        }
        "get" => {
            let id = required_option(args, "--id")?;
            Ok(json!(service.get_project(&id).map_err(CliError::core)?))
        }
        "create" => {
            let expected_revision = service.data_revision().map_err(CliError::core)?;
            let name = required_option(args, "--name")?;
            let description = option(args, "--description").unwrap_or_default();
            let input = json!({ "name": name, "description": description });
            let current = json!(service.list_projects().map_err(CliError::core)?);
            let target_id = preview_target_id("project.create", &input, &current);
            let etag = etag("project.create", &target_id, &input, &current);
            if !flag(args, "--apply") {
                return Ok(preview(
                    "project.create",
                    &target_id,
                    &etag,
                    false,
                    diff_values(&json!({}), &input),
                ));
            }
            require_match(args, &etag)?;
            let created = service
                .create_project_with_id_if_revision(
                    target_id,
                    NewProject { name, description },
                    expected_revision,
                )
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": "project.create",
                "target": { "resource": "project", "id": created.id },
                "record": created,
            }))
        }
        "update" => {
            let expected_revision = service.data_revision().map_err(CliError::core)?;
            let id = required_option(args, "--id")?;
            let existing = service.get_project(&id).map_err(CliError::core)?;
            let name = option(args, "--name").unwrap_or_else(|| existing.name.clone());
            let description =
                option(args, "--description").unwrap_or_else(|| existing.description.clone());
            let input = json!({ "id": id, "name": name, "description": description });
            let current = json!(existing);
            let current_business = json!({
                "id": current["id"],
                "name": current["name"],
                "description": current["description"]
            });
            let etag = etag("project.update", &id, &input, &current);
            if !flag(args, "--apply") {
                return Ok(preview(
                    "project.update",
                    &id,
                    &etag,
                    false,
                    diff_values(&current_business, &input),
                ));
            }
            require_match(args, &etag)?;
            let updated = service
                .update_project_if_revision(
                    &id,
                    ProjectPatch { name, description },
                    expected_revision,
                )
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": "project.update",
                "target": { "resource": "project", "id": id },
                "record": updated,
            }))
        }
        "delete" => {
            let expected_revision = service.data_revision().map_err(CliError::core)?;
            let id = required_option(args, "--id")?;
            let current = json!(service.get_project(&id).map_err(CliError::core)?);
            let cascade = service.project_delete_impact(&id).map_err(CliError::core)?;
            let input = json!({ "id": id });
            let delete_plan = json!({
                "project": current,
                "dataRevision": expected_revision,
                "cascade": cascade,
            });
            let etag = etag("project.delete", &id, &input, &delete_plan);
            let confirmation = confirmation_token("project.delete", &id, &etag);
            if !flag(args, "--apply") {
                let mut value = preview(
                    "project.delete",
                    &id,
                    &etag,
                    true,
                    vec![json!({ "op": "remove", "path": "" })],
                );
                value["cascade"] = json!(cascade);
                value["warnings"] = json!(["Hard deletion cannot be undone"]);
                value["destructiveConfirmation"] = json!(confirmation);
                return Ok(value);
            }
            require_match(args, &etag)?;
            require_destructive(args, &confirmation)?;
            service
                .delete_project_if_revision(&id, expected_revision)
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": "project.delete",
                "target": { "resource": "project", "id": id },
            }))
        }
        "snapshot" => {
            let expected_revision = service.data_revision().map_err(CliError::core)?;
            let id = required_option(args, "--id")?;
            let note = required_option(args, "--note")?;
            if note.trim().is_empty() {
                return Err(CliError::usage(
                    "VALIDATION_ERROR",
                    "Snapshot name must not be blank",
                ));
            }
            service.get_project(&id).map_err(CliError::core)?;
            let current = service
                .load_state()
                .map_err(CliError::core)?
                .map(|state| serde_json::from_str::<Value>(&state.state_json))
                .transpose()
                .map_err(CliError::internal)?
                .unwrap_or(Value::Null);
            let input = json!({ "id": id, "note": note.trim() });
            let etag = etag("project.snapshot", &id, &input, &current);
            if !flag(args, "--apply") {
                return Ok(preview(
                    "project.snapshot",
                    &id,
                    &etag,
                    false,
                    vec![json!({ "op": "add", "path": "/snapshots/-", "value": input })],
                ));
            }
            require_match(args, &etag)?;
            let result = service
                .create_manual_snapshot_if_revision(&id, &note, expected_revision)
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": "project.snapshot",
                "target": { "resource": "snapshot", "id": result.snapshot["id"] },
                "record": result.snapshot,
                "revision": result.revision,
            }))
        }
        "export" => {
            let id = required_option(args, "--id")?;
            let destination = absolute_path_option(args, "--destination")?;
            let current = json!(service.get_project(&id).map_err(CliError::core)?);
            let input = json!({ "id": id, "destination": destination });
            let etag = etag("project.export", &id, &input, &current);
            if !flag(args, "--apply") {
                let mut result = preview("project.export", &id, &etag, false, vec![]);
                result["destination"] = json!(destination);
                return Ok(result);
            }
            require_match(args, &etag)?;
            service
                .export_project_archive(&id, &destination)
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": "project.export",
                "target": { "resource": "project", "id": id },
                "destination": destination,
            }))
        }
        "import" => {
            let expected_revision = service.data_revision().map_err(CliError::core)?;
            let source = absolute_path_option(args, "--source")?;
            let tree = ProjectTree::read_archive(&source).map_err(CliError::core)?;
            let data = tree.parse_project_data().map_err(CliError::core)?;
            let id = data.project_id().map_err(CliError::core)?.to_owned();
            let existing = service
                .list_projects()
                .map_err(CliError::core)?
                .into_iter()
                .find(|project| project.id == id);
            let project_exists = existing.is_some();
            let overwrite = flag(args, "--overwrite");
            let input = json!({
                "source": source,
                "project": data.project,
                "overwrite": overwrite
            });
            let current = json!(existing);
            let etag = etag("project.import", &id, &input, &current);
            let confirmation =
                project_exists.then(|| confirmation_token("project.import", &id, &etag));
            if !flag(args, "--apply") {
                let mut result = preview(
                    "project.import",
                    &id,
                    &etag,
                    project_exists,
                    diff_values(&current, &input["project"]),
                );
                result["source"] = json!(source);
                result["overwrite"] = json!(overwrite);
                if let Some(confirmation) = confirmation {
                    result["destructiveConfirmation"] = json!(confirmation);
                }
                return Ok(result);
            }
            require_match(args, &etag)?;
            if let Some(confirmation) = confirmation {
                require_destructive(args, &confirmation)?;
            }
            let imported = service
                .import_project_archive_if_revision(&source, overwrite, expected_revision)
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": "project.import",
                "target": { "resource": "project", "id": imported.id },
                "record": imported,
            }))
        }
        _ => Err(CliError::usage(
            "UNSUPPORTED_ACTION",
            format!("Unsupported project action {action}"),
        )),
    }
}

fn dispatch_github(action: &str, args: &[String], data_dir: &Path) -> CliResult<Value> {
    if action == "describe" {
        return Ok(json!({
            "resource": "github",
            "actions": ["describe", "connect", "status", "pull", "sync"],
        }));
    }
    let project_id = required_option(args, "--project")?;
    let state_directory = data_dir.join("sync").join(&project_id);
    match action {
        "status" => {
            let connection = load_connection(&state_directory).map_err(CliError::core)?;
            Ok(json!({
                "status": "connected",
                "projectId": project_id,
                "owner": connection.owner,
                "repository": connection.repository,
                "branch": connection.branch,
                "lastSyncedCommit": connection.last_synced_commit,
            }))
        }
        "connect" => {
            fs::create_dir_all(data_dir).map_err(CliError::io)?;
            let database_path = canonical_database_path(data_dir);
            let service = ApplicationService::open(&database_path).map_err(CliError::core)?;
            service.get_project(&project_id).map_err(CliError::core)?;
            let mut connection = GithubConnection {
                owner: required_option(args, "--owner")?,
                repository: required_option(args, "--repo")?,
                branch: option(args, "--branch").unwrap_or_else(|| "main".to_owned()),
                last_synced_commit: None,
            };
            connection.validate().map_err(CliError::core)?;
            let token = github_token()?;
            let remote = GithubRemote::new(connection.clone(), token).map_err(CliError::core)?;
            let repository_exists = remote.repository_exists().map_err(CliError::core)?;
            let existing_connection = if state_directory.join("connection.json").is_file() {
                Some(load_connection(&state_directory).map_err(CliError::core)?)
            } else {
                None
            };
            let input = json!({
                "projectId": project_id,
                "owner": connection.owner,
                "repository": connection.repository,
                "branch": connection.branch,
                "repositoryExists": repository_exists,
                "createRepository": !repository_exists,
            });
            let current = json!(existing_connection);
            let etag = etag("github.connect", &project_id, &input, &current);
            if !flag(args, "--apply") {
                return Ok(json!({
                    "status": "preview",
                    "operation": "github.connect",
                    "target": { "resource": "project", "id": project_id },
                    "repository": {
                        "owner": connection.owner,
                        "name": connection.repository,
                        "branch": connection.branch,
                        "exists": repository_exists,
                        "willCreatePrivate": !repository_exists,
                    },
                    "highRisk": false,
                    "etag": etag,
                }));
            }
            require_match(args, &etag)?;
            if !repository_exists {
                if !flag(args, "--create") {
                    return Err(CliError::usage(
                        "CREATE_CONFIRMATION_REQUIRED",
                        "The GitHub repository does not exist; repeat with --create",
                    ));
                }
                remote.create_private_repository().map_err(CliError::core)?;
                let tree = service
                    .export_project_tree(&project_id)
                    .map_err(CliError::core)?;
                let commit = remote
                    .initialize_created_repository(&tree)
                    .map_err(CliError::core)?;
                save_sync_baseline(&state_directory, &tree, &mut connection, Some(commit))
                    .map_err(CliError::core)?;
            } else {
                save_connection(&state_directory, &connection).map_err(CliError::core)?;
            }
            Ok(json!({
                "status": "applied",
                "operation": "github.connect",
                "target": { "resource": "project", "id": project_id },
                "repository": {
                    "owner": connection.owner,
                    "name": connection.repository,
                    "branch": connection.branch,
                    "privateCreated": !repository_exists,
                }
            }))
        }
        "pull" | "sync" => {
            fs::create_dir_all(data_dir).map_err(CliError::io)?;
            let database_path = canonical_database_path(data_dir);
            let mut application =
                ApplicationService::open(&database_path).map_err(CliError::core)?;
            application
                .get_project(&project_id)
                .map_err(CliError::core)?;
            let connection = load_connection(&state_directory).map_err(CliError::core)?;
            let remote =
                GithubRemote::new(connection.clone(), github_token()?).map_err(CliError::core)?;
            let mode = if action == "pull" {
                SyncMode::PullOnly
            } else {
                SyncMode::PullThenPush
            };
            let mut service =
                SyncService::new(&mut application, &remote, &state_directory, connection)
                    .map_err(CliError::core)?;
            let resolutions = read_conflict_resolutions(args)?;
            let plan = service
                .plan_with_resolutions(&project_id, mode, &resolutions)
                .map_err(CliError::core)?;
            let summary = plan.summary().clone();
            if !flag(args, "--apply") {
                return Ok(json!({
                    "status": if summary.conflicts.is_empty() { "preview" } else { "conflict" },
                    "operation": if action == "pull" { "github.pull" } else { "github.sync" },
                    "target": { "resource": "project", "id": project_id },
                    "pulledCommit": summary.pulled_commit,
                    "changedLocal": summary.changed_local,
                    "willPush": summary.will_push,
                    "conflicts": summary.conflicts,
                    "highRisk": false,
                    "etag": summary.fingerprint,
                }));
            }
            require_match(args, &summary.fingerprint)?;
            let outcome = service.apply(plan, mode).map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": if action == "pull" { "github.pull" } else { "github.sync" },
                "target": { "resource": "project", "id": project_id },
                "result": outcome,
            }))
        }
        _ => Err(CliError::usage(
            "UNSUPPORTED_ACTION",
            format!("Unsupported github action {action}"),
        )),
    }
}

fn dispatch_entity(
    resource: Resource,
    action: &str,
    args: &[String],
    data_dir: &Path,
) -> CliResult<Value> {
    if action == "describe" {
        return Ok(describe_resource(resource));
    }
    fs::create_dir_all(data_dir).map_err(CliError::io)?;
    let database_path = canonical_database_path(data_dir);
    let mut service = ApplicationService::open(&database_path).map_err(CliError::core)?;
    let resource_name = resource_name(resource);
    if resource == Resource::Attachment && action == "import" {
        return import_attachment(args, &mut service);
    }
    if (resource == Resource::Relationship && matches!(action, "create" | "delete"))
        || (resource != Resource::Relationship && matches!(action, "add" | "remove"))
    {
        return Err(CliError::usage(
            "UNSUPPORTED_ACTION",
            format!("Unsupported {resource_name} action {action}"),
        ));
    }
    match action {
        "list" => {
            let project_id = required_option(args, "--project")?;
            let records = service
                .list_records(resource, &project_id)
                .map_err(CliError::core)?;
            Ok(Value::Array(project_fields(
                records,
                option(args, "--fields"),
            )?))
        }
        "get" => {
            let id = required_option(args, "--id")?;
            service
                .get_record(resource, &id)
                .map_err(CliError::core)?
                .ok_or_else(|| CliError::not_found(resource_name, &id))
        }
        "create" | "add" => {
            let expected_revision = service.data_revision().map_err(CliError::core)?;
            let project_id = required_option(args, "--project")?;
            service.get_project(&project_id).map_err(CliError::core)?;
            let raw_input = read_input(args, resource)?;
            let mut input = service
                .prepare_create_record(resource, &raw_input)
                .map_err(CliError::core)?;
            let current = Value::Array(
                service
                    .list_records(resource, &project_id)
                    .map_err(CliError::core)?,
            );
            let operation = format!(
                "{resource_name}.{}",
                if resource == Resource::Relationship {
                    "add"
                } else {
                    "create"
                }
            );
            let target_id = preview_target_id(&operation, &input, &current);
            inject_system_fields(&mut input, &target_id, &project_id)?;
            service
                .validate_record(resource, &input)
                .map_err(CliError::core)?;
            let etag = etag(&operation, &target_id, &input, &current);
            let high_risk = resource == Resource::Relationship;
            let confirmation = high_risk.then(|| confirmation_token(&operation, &target_id, &etag));
            if !flag(args, "--apply") {
                let mut preview = entity_preview(
                    resource_name,
                    &operation,
                    &target_id,
                    &etag,
                    high_risk,
                    diff_values(&json!({}), &input),
                );
                if let Some(token) = confirmation {
                    preview["destructiveConfirmation"] = json!(token);
                }
                return Ok(preview);
            }
            require_match(args, &etag)?;
            if let Some(token) = confirmation {
                require_destructive(args, &token)?;
            }
            touch_updated_at(&mut input)?;
            let change_set_id = service
                .put_record_from_cli_if_revision(
                    resource,
                    &target_id,
                    &project_id,
                    &input,
                    expected_revision,
                )
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": operation,
                "target": { "resource": resource_name, "id": target_id },
                "changeSetId": change_set_id,
                "record": input,
            }))
        }
        "update" => {
            let expected_revision = service.data_revision().map_err(CliError::core)?;
            let id = required_option(args, "--id")?;
            let mut current = service
                .get_record(resource, &id)
                .map_err(CliError::core)?
                .ok_or_else(|| CliError::not_found(resource_name, &id))?;
            let project_id = current
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("INVALID_RECORD", "Record has no projectId"))?
                .to_owned();
            let patch_input = read_input(args, resource)?;
            service
                .validate_update_record_input(resource, &patch_input)
                .map_err(CliError::core)?;
            merge_object(&mut current, patch_input)?;
            inject_system_fields(&mut current, &id, &project_id)?;
            service
                .validate_record(resource, &current)
                .map_err(CliError::core)?;
            let operation = format!("{resource_name}.update");
            let stored = service
                .get_record(resource, &id)
                .map_err(CliError::core)?
                .expect("record checked above");
            let etag = etag(&operation, &id, &current, &stored);
            let high_risk = resource == Resource::Relationship;
            let confirmation = high_risk.then(|| confirmation_token(&operation, &id, &etag));
            if !flag(args, "--apply") {
                let mut preview = entity_preview(
                    resource_name,
                    &operation,
                    &id,
                    &etag,
                    high_risk,
                    diff_values(&stored, &current),
                );
                if let Some(token) = confirmation {
                    preview["destructiveConfirmation"] = json!(token);
                }
                return Ok(preview);
            }
            require_match(args, &etag)?;
            if let Some(token) = confirmation {
                require_destructive(args, &token)?;
            }
            touch_updated_at(&mut current)?;
            let change_set_id = service
                .put_record_from_cli_if_revision(
                    resource,
                    &id,
                    &project_id,
                    &current,
                    expected_revision,
                )
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": operation,
                "target": { "resource": resource_name, "id": id },
                "changeSetId": change_set_id,
                "record": current,
            }))
        }
        "delete" | "remove" => {
            let expected_revision = service.data_revision().map_err(CliError::core)?;
            let id = required_option(args, "--id")?;
            let current = service
                .get_record(resource, &id)
                .map_err(CliError::core)?
                .ok_or_else(|| CliError::not_found(resource_name, &id))?;
            let operation = format!(
                "{resource_name}.{}",
                if resource == Resource::Relationship {
                    "remove"
                } else {
                    "delete"
                }
            );
            let cascade = service
                .record_delete_impact(resource, &id)
                .map_err(CliError::core)?;
            let delete_plan = json!({
                "record": current,
                "dataRevision": expected_revision,
                "cascade": cascade,
            });
            let etag = etag(&operation, &id, &json!({ "id": id }), &delete_plan);
            let confirmation = confirmation_token(&operation, &id, &etag);
            if !flag(args, "--apply") {
                let mut value = entity_preview(
                    resource_name,
                    &operation,
                    &id,
                    &etag,
                    true,
                    vec![json!({ "op": "remove", "path": "" })],
                );
                value["cascade"] = json!(cascade);
                value["destructiveConfirmation"] = json!(confirmation);
                return Ok(value);
            }
            require_match(args, &etag)?;
            require_destructive(args, &confirmation)?;
            let project_id = current
                .get("projectId")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("INVALID_RECORD", "Record has no projectId"))?
                .to_owned();
            let change_set_id = service
                .delete_record_from_cli_if_revision(resource, &id, &project_id, expected_revision)
                .map_err(CliError::core)?;
            Ok(json!({
                "status": "applied",
                "operation": operation,
                "target": { "resource": resource_name, "id": id },
                "changeSetId": change_set_id,
            }))
        }
        _ => Err(CliError::usage(
            "UNSUPPORTED_ACTION",
            format!("Unsupported {resource_name} action {action}"),
        )),
    }
}

fn import_attachment(args: &[String], service: &mut ApplicationService) -> CliResult<Value> {
    for argument in args.iter().filter(|argument| argument.starts_with("--")) {
        if ![
            "--data-dir",
            "--profile",
            "--project",
            "--person",
            "--file",
            "--output",
            "--apply",
            "--if-match",
        ]
        .contains(&argument.as_str())
        {
            return Err(CliError::usage(
                "UNKNOWN_OPTION",
                format!("Unknown option {argument}"),
            ));
        }
    }
    let project_id = required_option(args, "--project")?;
    let person_id = required_option(args, "--person")?;
    let file = PathBuf::from(required_option(args, "--file")?);
    if !file.is_absolute() {
        return Err(CliError::usage(
            "INVALID_ARGUMENT",
            "--file must be an absolute path",
        ));
    }
    let file = fs::canonicalize(&file).map_err(CliError::io)?;
    let metadata = fs::metadata(&file).map_err(CliError::io)?;
    if !metadata.is_file() || metadata.len() > 100 * 1024 * 1024 {
        return Err(CliError::usage(
            "INVALID_ATTACHMENT_FILE",
            "--file must be a regular file no larger than 100 MiB",
        ));
    }
    let bytes = fs::read(&file).map_err(CliError::io)?;
    if bytes.is_empty() {
        return Err(CliError::usage(
            "INVALID_ARGUMENT",
            "avatar file must not be empty",
        ));
    }
    let expected_revision = service.data_revision().map_err(CliError::core)?;
    service.get_project(&project_id).map_err(CliError::core)?;
    let person = service
        .get_record(Resource::Person, &person_id)
        .map_err(CliError::core)?
        .ok_or_else(|| CliError::not_found("person", &person_id))?;
    if person.get("projectId").and_then(Value::as_str) != Some(project_id.as_str()) {
        return Err(CliError::usage(
            "INVALID_TARGET",
            "Person does not belong to the selected project",
        ));
    }
    let content_hash = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let input = json!({
        "projectId": project_id,
        "personId": person_id,
        "role": "avatar",
        "file": file,
        "contentHash": content_hash,
        "size": bytes.len(),
    });
    let current = service
        .load_state()
        .map_err(CliError::core)?
        .map(|state| serde_json::from_str::<Value>(&state.state_json))
        .transpose()
        .map_err(CliError::internal)?
        .unwrap_or(Value::Null);
    let attachment_id = preview_target_id("attachment.import", &input, &current);
    let link_id = preview_target_id("attachment.avatar-link", &input, &current);
    let etag = etag("attachment.import", &attachment_id, &input, &current);
    if !flag(args, "--apply") {
        return Ok(json!({
            "status": "preview",
            "operation": "attachment.import",
            "target": { "resource": "person", "id": person_id },
            "attachmentId": attachment_id,
            "linkId": link_id,
            "resolvedPath": file,
            "contentHash": content_hash,
            "size": bytes.len(),
            "highRisk": false,
            "etag": etag,
            "patch": [{ "op": "replace", "path": "/avatar", "value": attachment_id }],
            "affected": [
                { "resource": "person", "id": person_id, "action": "avatar.set" },
                { "resource": "attachment", "id": attachment_id, "action": "attachment.import" }
            ],
            "cascade": [],
            "warnings": [],
        }));
    }
    require_match(args, &etag)?;
    let result = service
        .set_local_attachment_file_if_revision(
            &project_id,
            "person",
            &person_id,
            "avatar",
            &file,
            &attachment_id,
            &link_id,
            expected_revision,
        )
        .map_err(CliError::core)?;
    Ok(json!({
        "status": "applied",
        "operation": "attachment.import",
        "target": { "resource": "person", "id": person_id },
        "person": person,
        "attachment": result.attachment,
        "link": result.link,
        "alreadyStored": result.already_stored,
    }))
}

fn resource_name(resource: Resource) -> &'static str {
    resource.as_str()
}

fn entity_preview(
    resource: &str,
    operation: &str,
    target_id: &str,
    etag: &str,
    high_risk: bool,
    patch: Vec<Value>,
) -> Value {
    json!({
        "status": "preview",
        "operation": operation,
        "target": { "resource": resource, "id": target_id },
        "patch": patch,
        "affected": [{ "resource": resource, "id": target_id, "action": operation }],
        "cascade": [],
        "warnings": [],
        "highRisk": high_risk,
        "etag": etag,
    })
}

fn read_input(args: &[String], resource: Resource) -> CliResult<Value> {
    if let Some(path) = option(args, "--input") {
        let business_options = business_option_names(args);
        if let Some(option) = business_options
            .iter()
            .find(|key| key.as_str() != "--input" && !is_business_option(resource, key))
        {
            return Err(CliError::usage(
                "UNKNOWN_OPTION",
                format!("Unknown option {option}"),
            ));
        }
        if business_options.iter().any(|key| key.as_str() != "--input") {
            return Err(CliError::usage(
                "MIXED_INPUT",
                "Business field options cannot be combined with --input",
            ));
        }
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(CliError::usage(
                "INVALID_INPUT_PATH",
                "--input must be an absolute JSON file path",
            ));
        }
        let metadata = fs::metadata(&path).map_err(CliError::io)?;
        if !metadata.is_file() || metadata.len() > 10 * 1024 * 1024 {
            return Err(CliError::usage(
                "INVALID_INPUT_FILE",
                "Input must be a JSON file no larger than 10 MiB",
            ));
        }
        let value: Value =
            serde_json::from_slice(&fs::read(path).map_err(CliError::io)?).map_err(|error| {
                CliError::usage("INVALID_JSON", format!("Invalid input JSON: {error}"))
            })?;
        if !value.is_object() {
            return Err(CliError::usage(
                "INVALID_JSON",
                "Input JSON must be an object",
            ));
        }
        return Ok(value);
    }
    let controls = [
        "--data-dir",
        "--profile",
        "--project",
        "--id",
        "--output",
        "--if-match",
        "--confirm-destructive",
        "--fields",
        "--apply",
        "--input",
    ];
    let mut object = Map::new();
    let mut index = 2;
    while index < args.len() {
        let key = &args[index];
        if !key.starts_with("--") {
            index += 1;
            continue;
        }
        if controls.contains(&key.as_str()) {
            index += if key == "--apply" { 1 } else { 2 };
            continue;
        }
        if !is_business_option(resource, key) {
            return Err(CliError::usage(
                "UNKNOWN_OPTION",
                format!("Unknown option {key}"),
            ));
        }
        let value = args.get(index + 1).ok_or_else(|| {
            CliError::usage("MISSING_OPTION_VALUE", format!("{key} needs a value"))
        })?;
        object.insert(
            kebab_to_camel(key.trim_start_matches("--")),
            parse_option_value(value),
        );
        index += 2;
    }
    Ok(Value::Object(object))
}

fn is_business_option(resource: Resource, option: &str) -> bool {
    let field = kebab_to_camel(option.trim_start_matches("--"));
    writable_fields(resource).contains(&field.as_str())
}

fn business_option_names(args: &[String]) -> Vec<String> {
    let controls = [
        "--data-dir",
        "--profile",
        "--project",
        "--id",
        "--output",
        "--if-match",
        "--confirm-destructive",
        "--fields",
        "--apply",
        "--input",
    ];
    args.iter()
        .filter(|argument| argument.starts_with("--") && !controls.contains(&argument.as_str()))
        .cloned()
        .chain(
            args.iter()
                .filter(|argument| argument.as_str() == "--input")
                .cloned(),
        )
        .collect()
}

fn project_fields(records: Vec<Value>, fields: Option<String>) -> CliResult<Vec<Value>> {
    let Some(fields) = fields else {
        return Ok(records);
    };
    let requested: Vec<&str> = fields
        .split(',')
        .map(str::trim)
        .filter(|field| !field.is_empty())
        .collect();
    if requested.is_empty() {
        return Err(CliError::usage(
            "INVALID_FIELDS",
            "--fields must contain at least one field",
        ));
    }
    records
        .into_iter()
        .map(|record| {
            let object = record
                .as_object()
                .ok_or_else(|| CliError::usage("INVALID_RECORD", "Record is not an object"))?;
            let mut projected = Map::new();
            for field in ["id", "projectId"] {
                if let Some(value) = object.get(field) {
                    projected.insert(field.to_owned(), value.clone());
                }
            }
            for field in &requested {
                if let Some(value) = object.get(*field) {
                    projected.insert((*field).to_owned(), value.clone());
                }
            }
            Ok(Value::Object(projected))
        })
        .collect()
}

fn parse_option_value(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned()))
}

fn kebab_to_camel(value: &str) -> String {
    let mut result = String::new();
    let mut uppercase = false;
    for character in value.chars() {
        if character == '-' {
            uppercase = true;
        } else if uppercase {
            result.extend(character.to_uppercase());
            uppercase = false;
        } else {
            result.push(character);
        }
    }
    result
}

fn inject_system_fields(value: &mut Value, id: &str, project_id: &str) -> CliResult<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| CliError::usage("INVALID_JSON", "Input must be an object"))?;
    object.insert("id".to_owned(), json!(id));
    object.insert("projectId".to_owned(), json!(project_id));
    Ok(())
}

fn touch_updated_at(value: &mut Value) -> CliResult<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| CliError::usage("INVALID_JSON", "Input must be an object"))?;
    object.insert(
        "updatedAt".to_owned(),
        json!(OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(CliError::internal)?),
    );
    Ok(())
}

fn merge_object(target: &mut Value, patch: Value) -> CliResult<()> {
    let target = target
        .as_object_mut()
        .ok_or_else(|| CliError::usage("INVALID_RECORD", "Stored record is not an object"))?;
    let patch = patch
        .as_object()
        .ok_or_else(|| CliError::usage("INVALID_JSON", "Input must be an object"))?;
    for (key, value) in patch {
        if matches!(key.as_str(), "id" | "projectId") {
            continue;
        }
        target.insert(key.clone(), value.clone());
    }
    Ok(())
}

fn diff_values(before: &Value, after: &Value) -> Vec<Value> {
    let mut patch = Vec::new();
    diff_value_at("", before, after, &mut patch);
    patch
}

fn diff_value_at(path: &str, before: &Value, after: &Value, patch: &mut Vec<Value>) {
    if before == after {
        return;
    }
    match (before, after) {
        (Value::Object(left), Value::Object(right)) => {
            let mut keys = left.keys().chain(right.keys()).collect::<Vec<_>>();
            keys.sort();
            keys.dedup();
            for key in keys {
                let child_path = format!("{path}/{}", escape_json_pointer(key));
                match (left.get(key), right.get(key)) {
                    (None, Some(value)) => {
                        patch.push(json!({ "op": "add", "path": child_path, "value": value }))
                    }
                    (Some(_), None) => patch.push(json!({ "op": "remove", "path": child_path })),
                    (Some(old), Some(new)) => diff_value_at(&child_path, old, new, patch),
                    (None, None) => {}
                }
            }
        }
        _ => patch.push(json!({
            "op": if before.is_null() { "add" } else { "replace" },
            "path": path,
            "value": after,
        })),
    }
}

fn escape_json_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn doctor(data_dir: &Path) -> CliResult<Value> {
    let database_path = canonical_database_path(data_dir);
    let directory_exists = data_dir.is_dir();
    let database_exists = database_path.is_file();
    let schema_version = if database_exists {
        Some(ApplicationService::inspect_schema(&database_path).map_err(CliError::core)?)
    } else {
        None
    };
    let compatible = schema_version.is_none_or(|version| version <= SCHEMA_VERSION);
    let migration_required = schema_version.is_some_and(|version| version < SCHEMA_VERSION);
    Ok(json!({
        "cliVersion": CLI_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "capabilities": capabilities_json(),
        "runtime": "rust",
        "compatible": compatible,
        "dataDirectory": {
            "path": data_dir,
            "exists": directory_exists,
        },
        "database": {
            "path": database_path,
            "exists": database_exists,
            "schemaVersion": schema_version,
            "supportedSchemaVersion": SCHEMA_VERSION,
            "migrationRequired": migration_required,
        }
    }))
}

fn preview(
    operation: &str,
    target_id: &str,
    etag: &str,
    high_risk: bool,
    patch: Vec<Value>,
) -> Value {
    json!({
        "status": "preview",
        "operation": operation,
        "target": { "resource": "project", "id": target_id },
        "patch": patch,
        "affected": [{ "resource": "project", "id": target_id, "action": operation }],
        "cascade": [],
        "warnings": [],
        "highRisk": high_risk,
        "etag": etag,
    })
}

fn preview_target_id(operation: &str, input: &Value, current: &Value) -> String {
    let hash = digest(&json!({ "operation": operation, "input": input, "current": current }));
    format!(
        "{}-{}-{}-{}-{}",
        &hash[0..8],
        &hash[8..12],
        &hash[12..16],
        &hash[16..20],
        &hash[20..32]
    )
}

fn etag(operation: &str, target_id: &str, input: &Value, current: &Value) -> String {
    format!(
        "v1.{}",
        digest(&json!({
            "operation": operation,
            "targetId": target_id,
            "input": input,
            "current": current,
        }))
    )
}

fn digest(value: &Value) -> String {
    let canonical = canonical_json(value);
    Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object.iter().collect();
            let normalized: Map<String, Value> = sorted
                .into_iter()
                .map(|(key, value)| (key.clone(), canonical_value(value)))
                .collect();
            Value::Object(normalized).to_string()
        }
        _ => canonical_value(value).to_string(),
    }
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_value).collect()),
        Value::Object(object) => {
            let sorted: BTreeMap<_, _> = object.iter().collect();
            Value::Object(
                sorted
                    .into_iter()
                    .map(|(key, value)| (key.clone(), canonical_value(value)))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

fn require_match(args: &[String], expected: &str) -> CliResult<()> {
    let actual = required_option(args, "--if-match")?;
    if actual != expected {
        return Err(CliError {
            code: "STALE_PREVIEW",
            message: "The preview no longer matches current data".to_owned(),
            details: json!({ "expected": expected, "actual": actual }),
            exit_code: 4,
        });
    }
    Ok(())
}

fn confirmation_token(operation: &str, target_id: &str, etag: &str) -> String {
    format!(
        "confirm.{}",
        &digest(&json!({
            "operation": operation,
            "targetId": target_id,
            "etag": etag,
        }))[0..24]
    )
}

fn require_destructive(args: &[String], expected: &str) -> CliResult<()> {
    let actual = option(args, "--confirm-destructive");
    if actual.as_deref() != Some(expected) {
        return Err(CliError {
            code: "DESTRUCTIVE_CONFIRMATION_REQUIRED",
            message: "The destructive confirmation does not match the preview".to_owned(),
            details: Value::Null,
            exit_code: 4,
        });
    }
    Ok(())
}

fn resolve_data_dir(args: &[String]) -> CliResult<PathBuf> {
    if option(args, "--data-dir").is_some() && option(args, "--profile").is_some() {
        return Err(CliError::usage(
            "CONFLICTING_OPTIONS",
            "--data-dir and --profile are mutually exclusive",
        ));
    }
    if let Some(value) = option(args, "--data-dir") {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(CliError::usage(
                "INVALID_DATA_DIR",
                "--data-dir must be an absolute path",
            ));
        }
        return Ok(path);
    }
    if let Some(profile) = option(args, "--profile") {
        return profile_data_directory(&profile)
            .map_err(|_| CliError::usage("INVALID_PROFILE", "Invalid profile name"));
    }
    let environment_data_dir = env::var_os("BRANCHLOOM_DATA_DIR");
    let environment_profile = env::var_os("BRANCHLOOM_PROFILE");
    if environment_data_dir.is_some() && environment_profile.is_some() {
        return Err(CliError::usage(
            "CONFLICTING_ENVIRONMENT",
            "BRANCHLOOM_DATA_DIR and BRANCHLOOM_PROFILE are mutually exclusive",
        ));
    }
    if let Some(value) = environment_data_dir {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(CliError::usage(
                "INVALID_DATA_DIR",
                "BRANCHLOOM_DATA_DIR must be an absolute path",
            ));
        }
        return Ok(path);
    }
    if let Some(value) = environment_profile {
        let profile = value
            .to_str()
            .ok_or_else(|| CliError::usage("INVALID_PROFILE", "Invalid profile name"))?;
        return profile_data_directory(profile)
            .map_err(|_| CliError::usage("INVALID_PROFILE", "Invalid profile name"));
    }
    default_data_directory().map_err(CliError::core)
}

fn absolute_path_option(args: &[String], key: &str) -> CliResult<PathBuf> {
    let path = PathBuf::from(required_option(args, key)?);
    if !path.is_absolute() {
        return Err(CliError::usage(
            "INVALID_PATH",
            format!("{key} must be an absolute path"),
        ));
    }
    Ok(path)
}

fn github_token() -> CliResult<String> {
    env::var("BRANCHLOOM_GITHUB_TOKEN").map_err(|_| {
        CliError::usage(
            "GITHUB_AUTH_REQUIRED",
            "Set BRANCHLOOM_GITHUB_TOKEN for this command; the token is not stored in project data",
        )
    })
}

fn read_conflict_resolutions(args: &[String]) -> CliResult<Vec<ConflictResolution>> {
    let Some(path) = option(args, "--resolutions") else {
        return Ok(Vec::new());
    };
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(CliError::usage(
            "INVALID_PATH",
            "--resolutions must be an absolute JSON file path",
        ));
    }
    let metadata = fs::metadata(&path).map_err(CliError::io)?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err(CliError::usage(
            "INVALID_RESOLUTIONS_FILE",
            "Conflict resolutions must be a JSON file no larger than 1 MiB",
        ));
    }
    serde_json::from_slice(&fs::read(path).map_err(CliError::io)?).map_err(|error| {
        CliError::usage(
            "INVALID_RESOLUTIONS",
            format!("Invalid conflict resolutions JSON: {error}"),
        )
    })
}

fn required_option(args: &[String], key: &str) -> CliResult<String> {
    option(args, key)
        .ok_or_else(|| CliError::usage("MISSING_OPTION", format!("Missing required option {key}")))
}

fn option(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|argument| argument == key)
        .and_then(|index| args.get(index + 1))
        .filter(|value| !value.starts_with("--"))
        .cloned()
}

fn flag(args: &[String], key: &str) -> bool {
    args.iter().any(|argument| argument == key)
}

fn emit_success(data: Value, json_output: bool) {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": true,
                "contractVersion": CONTRACT_VERSION,
                "data": data,
                "warnings": [],
                "page": null,
            })
        );
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&data).expect("serialize CLI output")
        );
    }
}

fn print_help() {
    println!(
        "Branchloom CLI {CLI_VERSION}\n\n\
Usage:\n  branchloom <resource> <action> [options]\n  branchloom doctor [--output json]\n\n\
Resources:\n  project\n\n\
  person, organization, career, title, relationship, event,\n\
  place, source, citation, attachment\n\
  github\n  batch run\n\n\
Write protocol:\n  Writes preview by default. Apply the exact preview with:\n  --apply --if-match <etag>\n\n\
Person avatar:\n  branchloom attachment import --project <project-id> --person <person-id>\n  --file <absolute-image-path> --output json\n\n\
Manual snapshot:\n  branchloom project snapshot --id <project-id> --note <name> --output json\n\n\
Atomic person and relationship batch:\n  branchloom batch run --project <project-id> --input <absolute-json-file> --output json\n\n\
Global options:\n  --data-dir <path>   Use an explicit data directory\n  --profile <name>    Use an isolated named profile\n  --output json       Emit one machine-readable JSON envelope\n  --help              Show this help\n  --version           Show version information"
    );
}

type CliResult<T> = Result<T, CliError>;

struct CliError {
    code: &'static str,
    message: String,
    details: Value,
    exit_code: i32,
}

impl CliError {
    fn usage(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: Value::Null,
            exit_code: 2,
        }
    }

    fn core(error: CoreError) -> Self {
        match error {
            CoreError::RevisionConflict { expected, actual } => Self {
                code: "REVISION_CONFLICT",
                message: format!("Data revision conflict: expected {expected}, actual {actual}"),
                details: json!({ "expected": expected, "actual": actual }),
                exit_code: 4,
            },
            CoreError::Conflict(message) => Self {
                code: "SYNC_CONFLICT",
                message,
                details: Value::Null,
                exit_code: 4,
            },
            CoreError::NotFound { entity, id } => Self {
                code: "NOT_FOUND",
                message: format!("{entity} not found: {id}"),
                details: json!({ "resource": entity, "id": id }),
                exit_code: 3,
            },
            CoreError::UnsupportedVersion { found, supported } => Self {
                code: "UNSUPPORTED_VERSION",
                message: format!(
                    "Database schema version {found} is newer than supported version {supported}"
                ),
                details: json!({ "found": found, "supported": supported }),
                exit_code: 5,
            },
            CoreError::Validation(message) => Self {
                code: "VALIDATION_ERROR",
                message,
                details: Value::Null,
                exit_code: 2,
            },
            error => Self::internal(error),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            code: "CORE_ERROR",
            message: error.to_string(),
            details: Value::Null,
            exit_code: 1,
        }
    }

    fn io(error: std::io::Error) -> Self {
        Self {
            code: "IO_ERROR",
            message: error.to_string(),
            details: Value::Null,
            exit_code: 1,
        }
    }

    fn not_found(resource: &str, id: &str) -> Self {
        Self {
            code: "NOT_FOUND",
            message: format!("{resource} not found: {id}"),
            details: json!({ "resource": resource, "id": id }),
            exit_code: 3,
        }
    }
}
