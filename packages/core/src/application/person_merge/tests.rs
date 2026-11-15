use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::tempdir;

use crate::application::ApplicationService;
use crate::core::error::CoreError;
use crate::core::project::NewProject;
use crate::storage::Resource;

fn project(service: &mut ApplicationService, id: &str) {
    service
        .create_project_with_id(
            id.to_owned(),
            NewProject {
                name: id.to_owned(),
                description: String::new(),
            },
        )
        .expect("create project");
}

fn person(id: &str, name: &str, notes: &str) -> Value {
    json!({
        "id": id, "projectId": "project-a", "sex": "unknown", "status": "unknown",
        "names": [{ "value": name, "type": "personal", "primary": true }],
        "biography": "", "notes": notes, "updatedAt": "2026-01-01T00:00:00Z",
    })
}

fn relation(id: &str, from: &str, to: &str, notes: &str) -> Value {
    json!({
        "id": id, "projectId": "project-a", "fromPersonId": from, "toPersonId": to,
        "category": "parent", "type": "biological", "sourceIds": [], "notes": notes,
    })
}

fn input(choices: Value) -> Value {
    json!([{ "keepPersonId": "keep", "removePersonId": "remove", "choices": choices }])
}

fn find<'a>(state: &'a Value, collection: &str, id: &str) -> &'a Value {
    state[collection]
        .as_array()
        .expect("collection")
        .iter()
        .find(|record| record["id"] == id)
        .expect("record")
}

#[test]
fn desktop_merge_applies_choices_and_preserves_project_references_and_snapshot() {
    let directory = tempdir().expect("temporary directory");
    let database = directory.path().join("merge.sqlite3");
    let mut service = ApplicationService::open(&database).expect("open core");
    project(&mut service, "project-a");
    project(&mut service, "project-b");
    let initial = service.load_state().expect("load state").expect("state");
    let mut state: Value = serde_json::from_str(&initial.state_json).expect("parse state");
    state["projects"][0]["defaultPersonId"] = json!("remove");
    let mut outside = person("outside", "乙", "");
    outside["projectId"] = json!("project-b");
    state["people"] = json!([
        person("keep", "甲", "旧备注"),
        person("remove", "甲的别名", "新备注"),
        person("other", "丙", ""),
        outside
    ]);
    state["relationships"] = json!([
        relation("z-retained", "keep", "other", "甲的记录"),
        relation("a-duplicate", "remove", "other", "副本的记录"),
        relation("cycle-after-merge", "other", "remove", ""),
        relation("unrelated-self", "other", "other", ""),
        relation("direct", "keep", "remove", ""),
    ]);
    state["events"] = json!([{
        "id": "event", "projectId": "project-a", "type": "custom", "title": "聚会",
        "date": {"precision": "exact", "start": "2020", "end": "2020"},
        "participantIds": ["keep", "remove", "other"],
        "participantRoles": {"remove": "主持人", "other": "见证人"},
        "sourceIds": [], "notes": "",
    }]);
    state["careers"] = json!([{
        "id": "career", "projectId": "project-a", "personId": "remove", "appointedByPersonId": "remove",
    }]);
    state["personTitles"] = json!([{
        "id": "title", "projectId": "project-a", "personId": "remove", "grantedByPersonId": "remove",
    }]);
    state["sources"] = json!([{
        "id": "source", "projectId": "project-a", "type": "book", "title": "测试史料", "notes": "",
    }]);
    state["citations"] = json!([
        {"id": "citation", "projectId": "project-a", "sourceId": "source", "targetType": "relationship", "targetId": "a-duplicate", "notes": ""},
        {"id": "unselected", "projectId": "project-a", "sourceId": "source", "targetType": "relationship", "targetId": "cycle-after-merge", "notes": ""},
    ]);
    state["attachments"] = json!([
        {"id": "attachment", "projectId": "project-a", "name": "photo.png", "contentHash": "photo", "size": 100},
        {"id": "attachment-keep", "projectId": "project-a", "name": "keep.png", "contentHash": "keep-avatar", "size": 100},
        {"id": "attachment-remove", "projectId": "project-a", "name": "remove.png", "contentHash": "remove-avatar", "size": 100},
    ]);
    state["attachmentLinks"] = json!([
        {"id": "link", "projectId": "project-a", "attachmentId": "attachment", "targetType": "relationship", "targetId": "direct"},
        {"id": "existing-link", "projectId": "project-a", "attachmentId": "attachment", "targetType": "person", "targetId": "keep"},
        {"id": "link-to-unselected", "projectId": "project-a", "attachmentId": "attachment", "targetType": "citation", "targetId": "unselected"},
        {"id": "avatar-keep", "projectId": "project-a", "attachmentId": "attachment-keep", "targetType": "person", "targetId": "keep", "role": "avatar"},
        {"id": "avatar-remove", "projectId": "project-a", "attachmentId": "attachment-remove", "targetType": "person", "targetId": "remove", "role": "avatar"},
    ]);
    state["issues"] = json!([
        {"id": "manual", "origin": "manual", "severity": "info", "code": "follow-up", "message": "核对史料", "targetType": "person", "targetId": "remove"},
    ]);
    let revision = service
        .synchronize_state_if_revision(
            &state.to_string(),
            &initial.snapshot_payloads_json,
            service.data_revision().expect("revision"),
        )
        .expect("seed merge data");

    let merged = service.apply_desktop_mutation_if_revision("mergePeople", &input(json!({
        "notes": "remove", "avatarUrl": "remove", "retainedCitationIds": ["citation"],
        "relationshipConflictChoices": [{ "relationshipIds": ["a-duplicate", "z-retained"], "fields": {"notes": "a-duplicate"} }],
    })), revision).expect("merge people through normal desktop mutation");
    assert_eq!(merged.revision, revision + 1);
    assert_eq!(merged.result["retainedPerson"]["notes"], "新备注");
    assert_eq!(
        merged.result["retainedPerson"]["names"][1]["value"],
        "甲的别名"
    );
    assert_eq!(merged.result["summary"]["removedRelationships"], 2);
    let snapshot = &merged.result["snapshot"];
    assert_eq!(snapshot["reason"], "merge");
    assert_eq!(snapshot["summary"]["people"], 3);

    let reopened = ApplicationService::open(&database).expect("reopen core");
    let saved = reopened.load_state().expect("load state").expect("state");
    let state: Value = serde_json::from_str(&saved.state_json).expect("parse state");
    let payloads: Value =
        serde_json::from_str(&saved.snapshot_payloads_json).expect("parse snapshot payloads");
    let payload = &payloads[snapshot["id"].as_str().expect("snapshot id")];
    assert_eq!(payload["projects"].as_array().expect("projects").len(), 1);
    assert_eq!(
        find(payload, "projects", "project-a")["defaultPersonId"],
        "remove"
    );
    assert_eq!(find(payload, "people", "remove")["notes"], "新备注");
    assert_eq!(
        find(payload, "attachmentLinks", "avatar-remove")["targetId"],
        "remove"
    );

    assert!(reopened
        .get_record(Resource::Person, "remove")
        .expect("lookup duplicate")
        .is_none());
    assert_eq!(find(&state, "people", "outside"), &outside);
    assert_eq!(
        find(&state, "projects", "project-a")["defaultPersonId"],
        "keep"
    );
    assert_eq!(
        find(&state, "relationships", "z-retained")["notes"],
        "副本的记录"
    );
    assert_eq!(
        find(&state, "relationships", "cycle-after-merge")["toPersonId"],
        "keep"
    );
    assert_eq!(
        find(&state, "relationships", "unrelated-self"),
        &relation("unrelated-self", "other", "other", "")
    );
    assert_eq!(state["citations"].as_array().expect("citations").len(), 1);
    assert_eq!(
        find(&state, "citations", "citation")["targetId"],
        "z-retained"
    );
    assert_eq!(state["attachmentLinks"].as_array().expect("links").len(), 2);
    assert_eq!(
        find(&state, "attachmentLinks", "existing-link")["targetId"],
        "keep"
    );
    assert_eq!(
        find(&state, "attachmentLinks", "avatar-remove")["targetId"],
        "keep"
    );
    assert_eq!(
        find(&state, "events", "event")["participantIds"],
        json!(["keep", "other"])
    );
    assert_eq!(
        find(&state, "events", "event")["participantRoles"],
        json!({"keep": "主持人", "other": "见证人"})
    );
    for (collection, id, field) in [
        ("careers", "career", "appointedByPersonId"),
        ("personTitles", "title", "grantedByPersonId"),
    ] {
        assert_eq!(find(&state, collection, id)["personId"], "keep");
        assert_eq!(find(&state, collection, id)[field], "keep");
    }
    assert_eq!(find(&state, "issues", "manual")["targetId"], "keep");
    let connection = Connection::open(&database).expect("open test audit log");
    let audited: i64 = connection
        .query_row(
            "SELECT count(*) FROM change_items JOIN change_sets ON change_set_id = change_sets.id
         WHERE operation = 'mergePeople' AND entity_id = 'remove' AND action = 'delete'",
            [],
            |row| row.get(0),
        )
        .expect("audit deletion");
    assert_eq!(audited, 1);
}

#[test]
fn desktop_merge_rejects_stale_previews_and_rolls_back_when_snapshot_write_fails() {
    let directory = tempdir().expect("temporary directory");
    let database = directory.path().join("merge.sqlite3");
    let mut service = ApplicationService::open(&database).expect("open core");
    project(&mut service, "project-a");
    for record in [
        person("keep", "甲", "旧备注"),
        person("remove", "甲的别名", "新备注"),
    ] {
        service
            .put_record(
                Resource::Person,
                record["id"].as_str().expect("person id"),
                "project-a",
                &record,
            )
            .expect("store person");
    }
    let initial = service.load_state_snapshot().expect("load state");
    assert!(
        matches!(service.apply_desktop_mutation_if_revision("mergePeople", &input(json!({})), initial.revision),
        Err(CoreError::Validation(message)) if message.contains("notes"))
    );
    assert_eq!(
        service.load_state_snapshot().expect("unchanged state"),
        initial
    );

    let mut concurrent = ApplicationService::open(&database).expect("open concurrent core");
    concurrent
        .put_record(
            Resource::Person,
            "keep",
            "project-a",
            &person("keep", "甲（补录）", "旧备注"),
        )
        .expect("edit person");
    let before = service.load_state_snapshot().expect("load state");
    let choices = input(json!({"notes": "remove"}));
    assert!(matches!(
        service.apply_desktop_mutation_if_revision("mergePeople", &choices, initial.revision),
        Err(CoreError::RevisionConflict { .. })
    ));
    assert_eq!(
        service.load_state_snapshot().expect("unchanged state"),
        before
    );

    let connection = Connection::open(&database).expect("open test database");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_merge_snapshot BEFORE INSERT ON snapshot_payloads
         BEGIN SELECT RAISE(ABORT, 'test snapshot write failure'); END;",
        )
        .expect("inject failure after records and snapshot metadata are written");
    assert!(
        matches!(service.apply_desktop_mutation_if_revision("mergePeople", &choices, before.revision),
        Err(CoreError::Storage(error)) if error.to_string().contains("test snapshot write failure"))
    );
    assert_eq!(
        service
            .load_state_snapshot()
            .expect("rolled-back state and snapshots"),
        before
    );
    let audits: i64 = connection
        .query_row(
            "SELECT count(*) FROM change_sets WHERE operation = 'mergePeople'",
            [],
            |row| row.get(0),
        )
        .expect("audit log");
    assert_eq!(audits, 0);
}
