use std::process::Command;

use branchloom_core::application::{ApplicationService, BusinessResource as Resource};
use branchloom_core::core::project::NewProject;
use branchloom_core::data_location::database_path;
use serde_json::json;
use serde_json::Value;
use tempfile::tempdir;

fn run(arguments: &[&str]) -> (i32, Value, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_branchloom"))
        .args(arguments)
        .output()
        .expect("run Branchloom CLI");
    (
        output.status.code().unwrap_or(-1),
        serde_json::from_slice(&output.stdout).expect("parse JSON envelope"),
        String::from_utf8(output.stderr).expect("decode stderr"),
    )
}

fn run_with_home(arguments: &[&str], home: &std::path::Path) -> (i32, Value, String) {
    let output = Command::new(env!("CARGO_BIN_EXE_branchloom"))
        .args(arguments)
        .env("HOME", home)
        .env_remove("BRANCHLOOM_DATA_DIR")
        .env_remove("BRANCHLOOM_PROFILE")
        .env_remove("XDG_DATA_HOME")
        .output()
        .expect("run Branchloom CLI");
    (
        output.status.code().unwrap_or(-1),
        serde_json::from_slice(&output.stdout).expect("parse JSON envelope"),
        String::from_utf8(output.stderr).expect("decode stderr"),
    )
}

#[test]
fn doctor_is_read_only_for_a_missing_directory() {
    let parent = tempdir().expect("create temporary parent");
    let data_dir = parent.path().join("missing");
    let (status, envelope, stderr) = run(&[
        "doctor",
        "--data-dir",
        data_dir.to_str().expect("UTF-8 path"),
        "--output",
        "json",
    ]);

    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["runtime"], "rust");
    assert!(envelope["data"]["capabilities"]
        .as_array()
        .expect("capabilities")
        .contains(&json!("batch.person-relationship-atomic")));
    assert_eq!(envelope["data"]["dataDirectory"]["exists"], false);
    assert!(!data_dir.exists());
}

#[test]
fn default_data_directory_matches_the_desktop_application_identifier() {
    let home = tempdir().expect("create temporary home");
    let (status, envelope, stderr) = run_with_home(&["doctor", "--output", "json"], home.path());

    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    let path = envelope["data"]["dataDirectory"]["path"]
        .as_str()
        .expect("data directory path");
    assert!(path.ends_with("app.branchloom.desktop"));
    assert!(!std::path::Path::new(path).exists());
}

#[test]
fn project_write_previews_then_applies_the_same_target() {
    let data_dir = tempdir().expect("create CLI data directory");
    let path = data_dir.path().to_str().expect("UTF-8 path");
    let (_, preview, _) = run(&[
        "project",
        "create",
        "--data-dir",
        path,
        "--name",
        "CLI fixture",
        "--output",
        "json",
    ]);
    assert_eq!(preview["data"]["status"], "preview");
    let etag = preview["data"]["etag"]
        .as_str()
        .expect("preview etag")
        .to_owned();
    let target = preview["data"]["target"]["id"]
        .as_str()
        .expect("preview target")
        .to_owned();

    let (status, applied, stderr) = run(&[
        "project",
        "create",
        "--data-dir",
        path,
        "--name",
        "CLI fixture",
        "--apply",
        "--if-match",
        &etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(applied["data"]["status"], "applied");
    assert_eq!(applied["data"]["target"]["id"], target);

    let (status, listed, stderr) = run(&[
        "project",
        "list",
        "--data-dir",
        path,
        "--fields",
        "id,name",
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(listed["data"][0]["name"], "CLI fixture");
    assert_eq!(
        listed["data"][0].as_object().expect("project object").len(),
        2
    );
}

#[test]
fn project_snapshot_previews_then_persists_a_restorable_payload() {
    let data_dir = tempdir().expect("create CLI data directory");
    let path = data_dir.path().to_str().expect("UTF-8 path");
    let (_, project_preview, _) = run(&[
        "project",
        "create",
        "--data-dir",
        path,
        "--name",
        "Snapshot fixture",
        "--output",
        "json",
    ]);
    let project_etag = project_preview["data"]["etag"]
        .as_str()
        .expect("project etag");
    let (_, project, _) = run(&[
        "project",
        "create",
        "--data-dir",
        path,
        "--name",
        "Snapshot fixture",
        "--apply",
        "--if-match",
        project_etag,
        "--output",
        "json",
    ]);
    let project_id = project["data"]["target"]["id"]
        .as_str()
        .expect("project id");

    let (status, preview, stderr) = run(&[
        "project",
        "snapshot",
        "--data-dir",
        path,
        "--id",
        project_id,
        "--note",
        "校对前",
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(preview["data"]["status"], "preview");
    assert_eq!(preview["data"]["operation"], "project.snapshot");
    let snapshot_etag = preview["data"]["etag"].as_str().expect("snapshot etag");

    let (status, applied, stderr) = run(&[
        "project",
        "snapshot",
        "--data-dir",
        path,
        "--id",
        project_id,
        "--note",
        "校对前",
        "--apply",
        "--if-match",
        snapshot_etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(applied["data"]["record"]["note"], "校对前");
    assert_eq!(applied["data"]["record"]["reason"], "manual");
    let snapshot_id = applied["data"]["record"]["id"]
        .as_str()
        .expect("snapshot id");

    let service = ApplicationService::open(database_path(data_dir.path())).expect("open core");
    let normalized = service
        .load_state()
        .expect("load state")
        .expect("initialized state");
    let state: Value = serde_json::from_str(&normalized.state_json).expect("parse state");
    let payloads: Value =
        serde_json::from_str(&normalized.snapshot_payloads_json).expect("parse payloads");
    assert!(state["snapshots"]
        .as_array()
        .expect("snapshots")
        .iter()
        .any(|snapshot| snapshot["id"] == snapshot_id));
    assert_eq!(payloads[snapshot_id]["projects"][0]["id"], project_id);
}

#[test]
fn entity_writes_are_visible_through_the_shared_rust_core() {
    let data_dir = tempdir().expect("create CLI data directory");
    let path = data_dir.path().to_str().expect("UTF-8 path");
    let (_, project_preview, _) = run(&[
        "project",
        "create",
        "--data-dir",
        path,
        "--name",
        "Shared",
        "--output",
        "json",
    ]);
    let project_etag = project_preview["data"]["etag"]
        .as_str()
        .expect("project etag");
    let (_, project, _) = run(&[
        "project",
        "create",
        "--data-dir",
        path,
        "--name",
        "Shared",
        "--apply",
        "--if-match",
        project_etag,
        "--output",
        "json",
    ]);
    let project_id = project["data"]["target"]["id"]
        .as_str()
        .expect("project id");
    let input_path = data_dir.path().join("person.json");
    std::fs::write(
        &input_path,
        r#"{"names":[{"value":"Alex","type":"personal","primary":true}],"sex":"unknown","status":"unknown"}"#,
    )
    .expect("write input");
    let (_, preview, _) = run(&[
        "person",
        "create",
        "--data-dir",
        path,
        "--project",
        project_id,
        "--input",
        input_path.to_str().expect("input path"),
        "--output",
        "json",
    ]);
    let etag = preview["data"]["etag"].as_str().expect("person etag");
    let (status, applied, stderr) = run(&[
        "person",
        "create",
        "--data-dir",
        path,
        "--project",
        project_id,
        "--input",
        input_path.to_str().expect("input path"),
        "--apply",
        "--if-match",
        etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(applied["data"]["record"]["names"][0]["value"], "Alex");
    assert!(applied["data"]["changeSetId"].as_str().is_some());
    assert!(preview["data"]["patch"]
        .as_array()
        .expect("preview patch")
        .iter()
        .any(|entry| entry["path"] == "/names"));

    let (_, listed, _) = run(&[
        "person",
        "list",
        "--data-dir",
        path,
        "--project",
        project_id,
        "--output",
        "json",
    ]);
    assert_eq!(listed["data"].as_array().expect("people array").len(), 1);

    let (status, deletion, stderr) = run(&[
        "project",
        "delete",
        "--data-dir",
        path,
        "--id",
        project_id,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert!(deletion["data"]["cascade"]
        .as_array()
        .expect("project deletion cascade")
        .iter()
        .any(|entry| entry["resource"] == "people" && entry["count"] == 1));
}

#[test]
fn project_delete_rejects_a_preview_created_before_dependent_data_changed() {
    let data_dir = tempdir().expect("create CLI data directory");
    let path = data_dir.path().to_str().expect("UTF-8 path");
    let database = database_path(data_dir.path());
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
    drop(service);

    let (_, preview, _) = run(&[
        "project",
        "delete",
        "--data-dir",
        path,
        "--id",
        "project-test",
        "--output",
        "json",
    ]);
    let etag = preview["data"]["etag"].as_str().expect("delete etag");
    let confirmation = preview["data"]["destructiveConfirmation"]
        .as_str()
        .expect("confirmation token");

    let mut service = ApplicationService::open(&database).expect("reopen core");
    service
        .put_record(
            Resource::Person,
            "person-added-later",
            "project-test",
            &json!({
                "id": "person-added-later",
                "projectId": "project-test",
                "names": [{ "value": "Later", "type": "personal", "primary": true }],
                "sex": "unknown",
                "status": "unknown",
                "biography": "",
                "notes": ""
            }),
        )
        .expect("add dependent data after preview");
    drop(service);

    let (status, envelope, _) = run(&[
        "project",
        "delete",
        "--data-dir",
        path,
        "--id",
        "project-test",
        "--apply",
        "--if-match",
        etag,
        "--confirm-destructive",
        confirmation,
        "--output",
        "json",
    ]);
    assert_eq!(status, 4);
    assert_eq!(envelope["error"]["code"], "STALE_PREVIEW");
    let service = ApplicationService::open(&database).expect("verify core");
    assert!(service.get_project("project-test").is_ok());
    assert!(service
        .get_record(Resource::Person, "person-added-later")
        .expect("read later person")
        .is_some());
}

#[test]
fn person_describe_publishes_scope_and_write_schema() {
    let (status, envelope, stderr) = run(&["person", "describe", "--output", "json"]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(envelope["contractVersion"], 3);
    assert_eq!(
        envelope["data"]["scope"]["project"]["allowedWithInput"],
        true
    );
    assert_eq!(
        envelope["data"]["writeSchemas"]["create"]["properties"]["names"]["items"]
            ["additionalProperties"],
        false
    );
    let name_properties =
        &envelope["data"]["writeSchemas"]["create"]["properties"]["names"]["items"]["properties"];
    assert!(name_properties.get("language").is_none());
    assert!(name_properties.get("script").is_none());
}

#[test]
fn event_describe_and_write_use_the_published_schema() {
    let (status, description, stderr) = run(&["event", "describe", "--output", "json"]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(description["contractVersion"], 3);
    assert_eq!(description["data"]["schemaStatus"], "published");
    assert_eq!(
        description["data"]["writeSchemas"]["create"]["required"],
        json!(["type", "title", "date"])
    );

    let data_dir = tempdir().expect("create CLI data directory");
    let mut service = ApplicationService::open(database_path(data_dir.path())).expect("open core");
    service
        .create_project_with_id(
            "project-events".to_owned(),
            NewProject {
                name: "Events project".to_owned(),
                description: String::new(),
            },
        )
        .expect("create project");
    service
        .put_record(
            Resource::Person,
            "person-taizu",
            "project-events",
            &json!({
                "id": "person-taizu",
                "projectId": "project-events",
                "names": [{ "value": "赵匡胤", "type": "personal", "primary": true }],
                "sex": "male",
                "status": "deceased",
                "biography": "",
                "notes": ""
            }),
        )
        .expect("create participant");
    drop(service);

    let input = data_dir.path().join("event.json");
    std::fs::write(
        &input,
        r#"{"type":"accession","title":"赵匡胤即皇帝位","date":{"precision":"exact","start":"0960-02-04"},"participantIds":["person-taizu"],"participantRoles":{"person-taizu":"即位者"}}"#,
    )
    .expect("write event input");
    let path = data_dir.path().to_str().expect("data path");
    let input = input.to_str().expect("input path");
    let (status, preview, stderr) = run(&[
        "event",
        "create",
        "--data-dir",
        path,
        "--project",
        "project-events",
        "--input",
        input,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(preview["data"]["status"], "preview");
    assert_eq!(preview["data"]["highRisk"], false);
    let etag = preview["data"]["etag"].as_str().expect("event etag");

    let (status, applied, stderr) = run(&[
        "event",
        "create",
        "--data-dir",
        path,
        "--project",
        "project-events",
        "--input",
        input,
        "--apply",
        "--if-match",
        etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(applied["data"]["status"], "applied");
    assert_eq!(applied["data"]["record"]["sourceIds"], json!([]));
    assert_eq!(applied["data"]["record"]["notes"], "");
    assert!(applied["data"]["changeSetId"].as_str().is_some());
}

#[test]
fn relationship_source_and_citation_writes_use_the_published_schemas() {
    for (resource, action) in [
        ("relationship", "add"),
        ("source", "create"),
        ("citation", "create"),
    ] {
        let (status, description, stderr) = run(&[resource, "describe", "--output", "json"]);
        assert_eq!(status, 0);
        assert!(stderr.is_empty());
        assert_eq!(description["data"]["schemaStatus"], "published");
        assert!(description["data"]["writeSchemas"][action].is_object());
    }

    let data_dir = tempdir().expect("create CLI data directory");
    let mut service = ApplicationService::open(database_path(data_dir.path())).expect("open core");
    service
        .create_project_with_id(
            "project-genealogy".to_owned(),
            NewProject {
                name: "Genealogy project".to_owned(),
                description: String::new(),
            },
        )
        .expect("create project");
    for (id, name) in [("person-hongyin", "赵弘殷"), ("person-taizu", "赵匡胤")] {
        service
            .put_record(
                Resource::Person,
                id,
                "project-genealogy",
                &json!({
                    "id": id,
                    "projectId": "project-genealogy",
                    "names": [{ "value": name, "type": "personal", "primary": true }],
                    "sex": "male",
                    "status": "deceased",
                    "biography": "",
                    "notes": ""
                }),
            )
            .expect("create person");
    }
    drop(service);

    let path = data_dir.path().to_str().expect("data path");
    let source_input = data_dir.path().join("source.json");
    std::fs::write(
        &source_input,
        r#"{"title":"宋史","type":"book","author":"脱脱等"}"#,
    )
    .expect("write source input");
    let source_input = source_input.to_str().expect("source input path");
    let (status, source_preview, stderr) = run(&[
        "source",
        "create",
        "--data-dir",
        path,
        "--project",
        "project-genealogy",
        "--input",
        source_input,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(source_preview["data"]["highRisk"], false);
    let source_etag = source_preview["data"]["etag"]
        .as_str()
        .expect("source etag");
    let (status, source, stderr) = run(&[
        "source",
        "create",
        "--data-dir",
        path,
        "--project",
        "project-genealogy",
        "--input",
        source_input,
        "--apply",
        "--if-match",
        source_etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    let source_id = source["data"]["target"]["id"].as_str().expect("source id");
    assert_eq!(source["data"]["record"]["notes"], "");

    let citation_input = data_dir.path().join("citation.json");
    std::fs::write(
        &citation_input,
        serde_json::to_vec(&json!({
            "sourceId": source_id,
            "targetType": "person",
            "targetId": "person-taizu",
            "locator": "卷一 本纪第一"
        }))
        .expect("serialize citation input"),
    )
    .expect("write citation input");
    let citation_input = citation_input.to_str().expect("citation input path");
    let (_, citation_preview, _) = run(&[
        "citation",
        "create",
        "--data-dir",
        path,
        "--project",
        "project-genealogy",
        "--input",
        citation_input,
        "--output",
        "json",
    ]);
    let citation_etag = citation_preview["data"]["etag"]
        .as_str()
        .expect("citation etag");
    let (status, citation, stderr) = run(&[
        "citation",
        "create",
        "--data-dir",
        path,
        "--project",
        "project-genealogy",
        "--input",
        citation_input,
        "--apply",
        "--if-match",
        citation_etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(citation["data"]["record"]["targetId"], "person-taizu");

    let relationship_input = data_dir.path().join("relationship.json");
    std::fs::write(
        &relationship_input,
        serde_json::to_vec(&json!({
            "fromPersonId": "person-hongyin",
            "toPersonId": "person-taizu",
            "category": "parent",
            "type": "biological",
            "sourceIds": [source_id]
        }))
        .expect("serialize relationship input"),
    )
    .expect("write relationship input");
    let relationship_input = relationship_input
        .to_str()
        .expect("relationship input path");
    let (status, relationship_preview, stderr) = run(&[
        "relationship",
        "add",
        "--data-dir",
        path,
        "--project",
        "project-genealogy",
        "--input",
        relationship_input,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(relationship_preview["data"]["highRisk"], true);
    let relationship_etag = relationship_preview["data"]["etag"]
        .as_str()
        .expect("relationship etag");
    let confirmation = relationship_preview["data"]["destructiveConfirmation"]
        .as_str()
        .expect("relationship confirmation");

    let (status, rejected, stderr) = run(&[
        "relationship",
        "add",
        "--data-dir",
        path,
        "--project",
        "project-genealogy",
        "--input",
        relationship_input,
        "--apply",
        "--if-match",
        relationship_etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 4);
    assert!(stderr.is_empty());
    assert_eq!(
        rejected["error"]["code"],
        "DESTRUCTIVE_CONFIRMATION_REQUIRED"
    );

    let (status, relationship, stderr) = run(&[
        "relationship",
        "add",
        "--data-dir",
        path,
        "--project",
        "project-genealogy",
        "--input",
        relationship_input,
        "--apply",
        "--if-match",
        relationship_etag,
        "--confirm-destructive",
        confirmation,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(relationship["data"]["status"], "applied");
    assert_eq!(relationship["data"]["record"]["sourceIds"][0], source_id);
}

#[test]
fn batch_run_atomically_creates_people_and_relationships_with_local_refs() {
    let data_dir = tempdir().expect("create CLI data directory");
    let mut service = ApplicationService::open(database_path(data_dir.path())).expect("open core");
    service
        .create_project_with_id(
            "project-batch".to_owned(),
            NewProject {
                name: "Batch project".to_owned(),
                description: String::new(),
            },
        )
        .expect("create project");
    let initial_revision = service.data_revision().expect("read initial revision");
    drop(service);

    let input_path = data_dir.path().join("batch.json");
    std::fs::write(
        &input_path,
        serde_json::to_vec(&json!({
            "actions": [
                {
                    "resource": "person",
                    "action": "create",
                    "ref": "parent",
                    "payload": {
                        "names": [{ "value": "Parent", "type": "personal", "primary": true }],
                        "sex": "female",
                        "status": "unknown"
                    }
                },
                {
                    "resource": "person",
                    "action": "create",
                    "ref": "child",
                    "payload": {
                        "names": [{ "value": "Child", "type": "personal", "primary": true }]
                    }
                },
                {
                    "resource": "relationship",
                    "action": "add",
                    "ref": "parent-link",
                    "payload": {
                        "fromPersonId": { "ref": "parent" },
                        "toPersonId": { "ref": "child" },
                        "category": "parent",
                        "type": "biological"
                    }
                }
            ]
        }))
        .expect("serialize batch input"),
    )
    .expect("write batch input");
    let data_path = data_dir.path().to_str().expect("data path");
    let input_path = input_path.to_str().expect("input path");

    let (status, preview, stderr) = run(&[
        "batch",
        "run",
        "--data-dir",
        data_path,
        "--project",
        "project-batch",
        "--input",
        input_path,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(preview["data"]["status"], "preview");
    assert_eq!(preview["data"]["operation"], "batch.run");
    assert_eq!(preview["data"]["actions"].as_array().unwrap().len(), 3);
    assert_eq!(preview["data"]["affected"].as_array().unwrap().len(), 3);
    assert_eq!(preview["data"]["highRisk"], true);
    let parent_id = preview["data"]["refMap"]["parent"]
        .as_str()
        .expect("parent ref")
        .to_owned();
    let child_id = preview["data"]["refMap"]["child"]
        .as_str()
        .expect("child ref")
        .to_owned();
    assert_eq!(
        preview["data"]["actions"][2]["record"]["fromPersonId"],
        parent_id
    );
    assert_eq!(
        preview["data"]["actions"][2]["record"]["toPersonId"],
        child_id
    );
    let etag = preview["data"]["etag"].as_str().expect("batch etag");
    let confirmation = preview["data"]["destructiveConfirmation"]
        .as_str()
        .expect("batch confirmation");

    let service = ApplicationService::open(database_path(data_dir.path())).expect("inspect core");
    assert!(service
        .list_records(Resource::Person, "project-batch")
        .unwrap()
        .is_empty());
    assert_eq!(service.data_revision().unwrap(), initial_revision);
    drop(service);

    let (status, rejected, stderr) = run(&[
        "batch",
        "run",
        "--data-dir",
        data_path,
        "--project",
        "project-batch",
        "--input",
        input_path,
        "--apply",
        "--if-match",
        etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 4);
    assert!(stderr.is_empty());
    assert_eq!(
        rejected["error"]["code"],
        "DESTRUCTIVE_CONFIRMATION_REQUIRED"
    );

    let (status, applied, stderr) = run(&[
        "batch",
        "run",
        "--data-dir",
        data_path,
        "--project",
        "project-batch",
        "--input",
        input_path,
        "--apply",
        "--if-match",
        etag,
        "--confirm-destructive",
        confirmation,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(applied["data"]["status"], "applied");
    assert!(applied["data"]["changeSetId"].as_str().is_some());
    assert_eq!(applied["data"]["revision"], initial_revision + 1);
    assert_eq!(applied["data"]["actions"].as_array().unwrap().len(), 3);

    let service = ApplicationService::open(database_path(data_dir.path())).expect("reopen core");
    assert_eq!(
        service
            .list_records(Resource::Person, "project-batch")
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        service
            .list_records(Resource::Relationship, "project-batch")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(service.data_revision().unwrap(), initial_revision + 1);
}

#[test]
fn project_scope_can_be_combined_with_json_input_but_system_fields_cannot() {
    let data_dir = tempdir().expect("create CLI data directory");
    let path = data_dir.path().to_str().expect("UTF-8 path");
    let (_, project_preview, _) = run(&[
        "project",
        "create",
        "--data-dir",
        path,
        "--name",
        "Scoped input",
        "--output",
        "json",
    ]);
    let etag = project_preview["data"]["etag"]
        .as_str()
        .expect("project etag");
    let (_, project, _) = run(&[
        "project",
        "create",
        "--data-dir",
        path,
        "--name",
        "Scoped input",
        "--apply",
        "--if-match",
        etag,
        "--output",
        "json",
    ]);
    let project_id = project["data"]["target"]["id"]
        .as_str()
        .expect("project id");

    let valid_input = data_dir.path().join("valid-person.json");
    std::fs::write(
        &valid_input,
        r#"{"names":[{"value":"赵匡胤","type":"personal","primary":true}]}"#,
    )
    .expect("write valid input");
    let (status, preview, stderr) = run(&[
        "person",
        "create",
        "--data-dir",
        path,
        "--project",
        project_id,
        "--input",
        valid_input.to_str().expect("input path"),
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(preview["data"]["status"], "preview");

    let invalid_input = data_dir.path().join("invalid-person.json");
    std::fs::write(
        &invalid_input,
        format!(
            r#"{{"projectId":"{project_id}","names":[{{"value":"赵匡胤","type":"personal","primary":true}}]}}"#
        ),
    )
    .expect("write invalid input");
    let (status, rejected, stderr) = run(&[
        "person",
        "create",
        "--data-dir",
        path,
        "--project",
        project_id,
        "--input",
        invalid_input.to_str().expect("input path"),
        "--output",
        "json",
    ]);
    assert_eq!(status, 2);
    assert!(stderr.is_empty());
    assert_eq!(rejected["error"]["code"], "VALIDATION_ERROR");
    assert!(rejected["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("projectId"));

    let removed_name_fields = data_dir.path().join("removed-name-fields.json");
    std::fs::write(
        &removed_name_fields,
        r#"{"names":[{"value":"赵匡胤","type":"personal","primary":true,"language":"zh-CN","script":"Hans"}]}"#,
    )
    .expect("write input with removed name fields");
    let (status, rejected, stderr) = run(&[
        "person",
        "create",
        "--data-dir",
        path,
        "--project",
        project_id,
        "--input",
        removed_name_fields.to_str().expect("input path"),
        "--output",
        "json",
    ]);
    assert_eq!(status, 2);
    assert!(stderr.is_empty());
    assert_eq!(rejected["error"]["code"], "VALIDATION_ERROR");
    assert!(rejected["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("language"));
}

#[test]
fn explicit_preview_flag_is_rejected_as_an_unknown_option() {
    let data_dir = tempdir().expect("create CLI data directory");
    let data_path = data_dir.path().to_str().expect("data path");
    let (_, project_preview, _) = run(&[
        "project",
        "create",
        "--data-dir",
        data_path,
        "--name",
        "Unknown option",
        "--output",
        "json",
    ]);
    let project_etag = project_preview["data"]["etag"]
        .as_str()
        .expect("project etag");
    let (_, project, _) = run(&[
        "project",
        "create",
        "--data-dir",
        data_path,
        "--name",
        "Unknown option",
        "--apply",
        "--if-match",
        project_etag,
        "--output",
        "json",
    ]);
    let project_id = project["data"]["target"]["id"]
        .as_str()
        .expect("project id");
    let input = data_dir.path().join("person.json");
    std::fs::write(
        &input,
        r#"{"names":[{"value":"Alex","type":"personal","primary":true}]}"#,
    )
    .expect("write input");
    let (status, envelope, stderr) = run(&[
        "person",
        "create",
        "--data-dir",
        data_path,
        "--project",
        project_id,
        "--input",
        input.to_str().expect("input path"),
        "--preview",
        "--output",
        "json",
    ]);
    assert_eq!(status, 2);
    assert!(stderr.is_empty());
    assert_eq!(envelope["error"]["code"], "UNKNOWN_OPTION");
    assert!(envelope["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("--preview"));
}

#[test]
fn blp_export_and_import_use_the_same_project_format() {
    let parent = tempdir().expect("create temporary parent");
    let source_dir = parent.path().join("source");
    let target_dir = parent.path().join("target");
    let source = source_dir.to_str().expect("source path");
    let target = target_dir.to_str().expect("target path");
    let (_, create_preview, _) = run(&[
        "project",
        "create",
        "--data-dir",
        source,
        "--name",
        "Portable family",
        "--output",
        "json",
    ]);
    let create_etag = create_preview["data"]["etag"]
        .as_str()
        .expect("create etag");
    let (_, created, _) = run(&[
        "project",
        "create",
        "--data-dir",
        source,
        "--name",
        "Portable family",
        "--apply",
        "--if-match",
        create_etag,
        "--output",
        "json",
    ]);
    let project_id = created["data"]["target"]["id"]
        .as_str()
        .expect("project id");
    let archive = parent.path().join("portable.blp");
    let archive_path = archive.to_str().expect("archive path");

    let (_, export_preview, _) = run(&[
        "project",
        "export",
        "--data-dir",
        source,
        "--id",
        project_id,
        "--destination",
        archive_path,
        "--output",
        "json",
    ]);
    let export_etag = export_preview["data"]["etag"]
        .as_str()
        .expect("export etag");
    let (status, _, stderr) = run(&[
        "project",
        "export",
        "--data-dir",
        source,
        "--id",
        project_id,
        "--destination",
        archive_path,
        "--apply",
        "--if-match",
        export_etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert!(archive.is_file());

    let (_, import_preview, _) = run(&[
        "project",
        "import",
        "--data-dir",
        target,
        "--source",
        archive_path,
        "--output",
        "json",
    ]);
    let import_etag = import_preview["data"]["etag"]
        .as_str()
        .expect("import etag");
    let (status, imported, stderr) = run(&[
        "project",
        "import",
        "--data-dir",
        target,
        "--source",
        archive_path,
        "--apply",
        "--if-match",
        import_etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(imported["data"]["target"]["id"], project_id);
    assert_eq!(imported["data"]["record"]["name"], "Portable family");

    let (_, overwrite_preview, _) = run(&[
        "project",
        "import",
        "--data-dir",
        target,
        "--source",
        archive_path,
        "--overwrite",
        "--output",
        "json",
    ]);
    let overwrite_etag = overwrite_preview["data"]["etag"]
        .as_str()
        .expect("overwrite etag");
    let confirmation = overwrite_preview["data"]["destructiveConfirmation"]
        .as_str()
        .expect("overwrite confirmation");
    let (status, rejected, _) = run(&[
        "project",
        "import",
        "--data-dir",
        target,
        "--source",
        archive_path,
        "--overwrite",
        "--apply",
        "--if-match",
        overwrite_etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 4);
    assert_eq!(
        rejected["error"]["code"],
        "DESTRUCTIVE_CONFIRMATION_REQUIRED"
    );

    let (status, overwritten, stderr) = run(&[
        "project",
        "import",
        "--data-dir",
        target,
        "--source",
        archive_path,
        "--overwrite",
        "--apply",
        "--if-match",
        overwrite_etag,
        "--confirm-destructive",
        confirmation,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(overwritten["data"]["target"]["id"], project_id);
}

#[test]
fn attachment_import_sets_a_person_avatar_from_an_absolute_local_file() {
    let data_dir = tempdir().expect("create CLI data directory");
    let mut service = ApplicationService::open(database_path(data_dir.path())).expect("open core");
    service
        .create_project_with_id(
            "project-avatar".to_owned(),
            NewProject {
                name: "Avatar project".to_owned(),
                description: String::new(),
            },
        )
        .expect("create project");
    service
        .put_record(
            Resource::Person,
            "person-avatar",
            "project-avatar",
            &json!({
                "id": "person-avatar",
                "projectId": "project-avatar",
                "names": [{ "value": "Alex", "type": "personal", "primary": true }],
                "sex": "unknown",
                "status": "unknown",
                "biography": "",
                "notes": "",
                "updatedAt": "2030-01-02T03:04:05Z"
            }),
        )
        .expect("create person");
    let project_before = service
        .get_project("project-avatar")
        .expect("read project before avatar import");
    drop(service);
    let avatar = data_dir.path().join("avatar.png");
    std::fs::write(&avatar, b"local-avatar-content").expect("write avatar fixture");
    let data_path = data_dir.path().to_str().expect("data path");
    let avatar_path = avatar.to_str().expect("avatar path");

    let (status, rejected, stderr) = run(&[
        "attachment",
        "import",
        "--data-dir",
        data_path,
        "--project",
        "project-avatar",
        "--person",
        "person-avatar",
        "--file",
        "avatar.png",
        "--output",
        "json",
    ]);
    assert_eq!(status, 2);
    assert!(stderr.is_empty());
    assert_eq!(rejected["error"]["code"], "INVALID_ARGUMENT");

    let (status, preview, stderr) = run(&[
        "attachment",
        "import",
        "--data-dir",
        data_path,
        "--project",
        "project-avatar",
        "--person",
        "person-avatar",
        "--file",
        avatar_path,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(preview["data"]["status"], "preview");
    assert_eq!(preview["data"]["target"]["id"], "person-avatar");
    assert_eq!(
        preview["data"]["resolvedPath"],
        std::fs::canonicalize(&avatar)
            .expect("canonical avatar path")
            .to_str()
            .expect("canonical UTF-8 path")
    );
    let etag = preview["data"]["etag"].as_str().expect("preview etag");

    let (status, applied, stderr) = run(&[
        "attachment",
        "import",
        "--data-dir",
        data_path,
        "--project",
        "project-avatar",
        "--person",
        "person-avatar",
        "--file",
        avatar_path,
        "--apply",
        "--if-match",
        etag,
        "--output",
        "json",
    ]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert_eq!(applied["data"]["status"], "applied");
    assert_eq!(applied["data"]["link"]["role"], "avatar");
    assert_eq!(applied["data"]["link"]["targetId"], "person-avatar");

    let service = ApplicationService::open(database_path(data_dir.path())).expect("reopen core");
    assert_eq!(
        service
            .get_project("project-avatar")
            .expect("read project after avatar import"),
        project_before
    );
    let state = service.load_state().expect("load state").expect("state");
    let state: Value = serde_json::from_str(&state.state_json).expect("parse state");
    assert_eq!(state["attachmentLinks"].as_array().unwrap().len(), 1);
    let hash = applied["data"]["attachment"]["contentHash"]
        .as_str()
        .expect("content hash");
    assert!(data_dir
        .path()
        .join("attachments")
        .join("project-avatar")
        .join(hash)
        .is_file());
}
