use std::collections::HashSet;

use serde_json::{json, Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::core::error::{CoreError, CoreResult};
use crate::storage::Resource;

pub const PUBLIC_CONTRACT_VERSION: u64 = 3;

pub const CAPABILITIES: &[&str] = &[
    "describe.write-schema",
    "event.write-schema",
    "relationship.write-schema",
    "source.write-schema",
    "citation.write-schema",
    "input.project-scope-with-json-file",
    "input.system-fields-rejected",
    "person.embedded-names-without-name-id",
    "attachment.person-avatar-local-file",
    "batch.person-relationship-atomic",
    "preview.field-patch",
    "write.etag",
    "write.change-set",
];

const SYSTEM_FIELDS: &[&str] = &["id", "projectId", "revision", "createdAt", "updatedAt"];
const PERSON_FIELDS: &[&str] = &[
    "names",
    "sex",
    "status",
    "birth",
    "death",
    "birthPlaceId",
    "deathPlaceId",
    "biography",
    "notes",
];
const NAME_FIELDS: &[&str] = &[
    "value",
    "type",
    "primary",
    "customTypeLabel",
    "familyName",
    "givenName",
    "validFrom",
    "validTo",
    "context",
    "notes",
];
const NAME_TYPES: &[&str] = &[
    "personal",
    "courtesy",
    "art",
    "genealogy",
    "generation",
    "childhood",
    "former",
    "pen",
    "religious",
    "posthumous",
    "temple",
    "honorific",
    "alias",
    "custom",
];
const SEX_VALUES: &[&str] = &["female", "male", "nonbinary", "unknown"];
const STATUS_VALUES: &[&str] = &["living", "deceased", "unknown"];
const DATE_PRECISIONS: &[&str] = &["exact", "about", "before", "after", "range", "unknown"];
const RELATIONSHIP_CATEGORIES: &[&str] = &["parent", "partner"];
const PARENT_RELATIONSHIP_TYPES: &[&str] = &["biological", "adoptive", "step", "guardian"];
const PARTNER_RELATIONSHIP_TYPES: &[&str] =
    &["engaged", "married", "partner", "separated", "divorced"];
const SOURCE_TYPES: &[&str] = &["book", "archive", "web", "interview", "other"];
const CITATION_TARGET_TYPES: &[&str] = &["person", "relationship", "event", "career"];

pub fn capabilities_json() -> Value {
    json!(CAPABILITIES)
}

pub fn describe_resource(resource: Resource) -> Value {
    let name = resource.as_str();
    let actions = if resource == Resource::Relationship {
        json!(["describe", "list", "get", "add", "update", "remove"])
    } else {
        json!(["describe", "list", "get", "create", "update", "delete"])
    };
    if resource == Resource::Attachment {
        return json!({
            "resource": name,
            "actions": ["describe", "list", "get", "import", "delete"],
            "scope": { "project": { "required": true, "option": "--project" } },
            "systemFields": SYSTEM_FIELDS,
            "readableFields": ["id", "projectId", "name", "mimeType", "size", "contentHash", "missing", "updatedAt"],
            "filterFields": [],
            "includes": [],
            "writeSchemas": {
                "import": {
                    "fileOption": "--file",
                    "absolutePathRequired": true,
                    "targetOptions": { "person": "--person" },
                    "role": { "enum": ["avatar"] }
                }
            },
            "schemaStatus": "published",
        });
    }
    let date_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["precision"],
        "properties": {
            "display": { "type": "string", "description": "Current desktop compatibility field; do not store unparsed source text." },
            "start": { "type": "string", "pattern": "^[0-9]{1,4}(-[0-9]{2})?(-[0-9]{2})?$" },
            "end": { "type": "string", "pattern": "^[0-9]{1,4}(-[0-9]{2})?(-[0-9]{2})?$" },
            "precision": { "enum": DATE_PRECISIONS }
        }
    });
    if resource == Resource::Event {
        let properties = json!({
            "type": { "type": "string", "minLength": 1 },
            "title": { "type": "string", "minLength": 1 },
            "date": date_schema,
            "placeId": { "type": "string", "minLength": 1 },
            "participantIds": {
                "type": "array",
                "uniqueItems": true,
                "items": { "type": "string", "minLength": 1 },
                "default": []
            },
            "participantRoles": {
                "type": "object",
                "propertyNames": { "minLength": 1 },
                "additionalProperties": { "type": "string", "minLength": 1 }
            },
            "sourceIds": {
                "type": "array",
                "uniqueItems": true,
                "items": { "type": "string", "minLength": 1 },
                "default": []
            },
            "notes": { "type": "string", "default": "" }
        });
        return json!({
            "resource": name,
            "actions": actions,
            "scope": { "project": { "required": true, "option": "--project", "allowedWithInput": true } },
            "systemFields": SYSTEM_FIELDS,
            "readableFields": [
                "id", "projectId", "type", "title", "date", "placeId",
                "participantIds", "participantRoles", "sourceIds", "notes", "updatedAt"
            ],
            "filterFields": ["type"],
            "includes": [],
            "writeSchemas": {
                "create": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["type", "title", "date"],
                    "properties": properties
                },
                "update": {
                    "type": "object",
                    "additionalProperties": false,
                    "minProperties": 1,
                    "properties": properties
                }
            },
            "schemaStatus": "published",
        });
    }
    if resource == Resource::Relationship {
        let relationship_types = PARENT_RELATIONSHIP_TYPES
            .iter()
            .chain(PARTNER_RELATIONSHIP_TYPES.iter())
            .copied()
            .collect::<Vec<_>>();
        let properties = json!({
            "fromPersonId": { "type": "string", "minLength": 1 },
            "toPersonId": { "type": "string", "minLength": 1 },
            "category": { "enum": RELATIONSHIP_CATEGORIES },
            "type": { "enum": relationship_types },
            "start": date_schema,
            "end": date_schema,
            "placeId": { "type": "string", "minLength": 1 },
            "notes": { "type": "string", "default": "" },
            "sourceIds": {
                "type": "array",
                "uniqueItems": true,
                "items": { "type": "string", "minLength": 1 },
                "default": []
            }
        });
        let category_rules = json!([
            {
                "if": { "properties": { "category": { "const": "parent" } }, "required": ["category"] },
                "then": { "properties": { "type": { "enum": PARENT_RELATIONSHIP_TYPES } } }
            },
            {
                "if": { "properties": { "category": { "const": "partner" } }, "required": ["category"] },
                "then": { "properties": { "type": { "enum": PARTNER_RELATIONSHIP_TYPES } } }
            }
        ]);
        return json!({
            "resource": name,
            "actions": actions,
            "scope": { "project": { "required": true, "option": "--project", "allowedWithInput": true } },
            "systemFields": SYSTEM_FIELDS,
            "readableFields": [
                "id", "projectId", "fromPersonId", "toPersonId", "category", "type",
                "start", "end", "placeId", "notes", "sourceIds", "updatedAt"
            ],
            "filterFields": ["category", "type"],
            "includes": [],
            "writeSchemas": {
                "add": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["fromPersonId", "toPersonId", "category", "type"],
                    "properties": properties,
                    "allOf": category_rules
                },
                "update": {
                    "type": "object",
                    "additionalProperties": false,
                    "minProperties": 1,
                    "properties": properties,
                    "allOf": category_rules
                }
            },
            "schemaStatus": "published",
        });
    }
    if resource == Resource::Source {
        let properties = json!({
            "title": { "type": "string", "minLength": 1 },
            "type": { "enum": SOURCE_TYPES },
            "author": { "type": "string" },
            "repository": { "type": "string" },
            "url": { "type": "string" },
            "date": date_schema,
            "referenceCode": { "type": "string" },
            "notes": { "type": "string", "default": "" }
        });
        return json!({
            "resource": name,
            "actions": actions,
            "scope": { "project": { "required": true, "option": "--project", "allowedWithInput": true } },
            "systemFields": SYSTEM_FIELDS,
            "readableFields": [
                "id", "projectId", "title", "type", "author", "repository", "url",
                "date", "referenceCode", "notes", "updatedAt"
            ],
            "filterFields": ["type"],
            "includes": [],
            "writeSchemas": {
                "create": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["title", "type"],
                    "properties": properties
                },
                "update": {
                    "type": "object",
                    "additionalProperties": false,
                    "minProperties": 1,
                    "properties": properties
                }
            },
            "schemaStatus": "published",
        });
    }
    if resource == Resource::Citation {
        let properties = json!({
            "sourceId": { "type": "string", "minLength": 1 },
            "targetType": { "enum": CITATION_TARGET_TYPES },
            "targetId": { "type": "string", "minLength": 1 },
            "locator": { "type": "string" },
            "excerpt": { "type": "string" },
            "accessedAt": date_schema,
            "notes": { "type": "string", "default": "" }
        });
        return json!({
            "resource": name,
            "actions": actions,
            "scope": { "project": { "required": true, "option": "--project", "allowedWithInput": true } },
            "systemFields": SYSTEM_FIELDS,
            "readableFields": [
                "id", "projectId", "sourceId", "targetType", "targetId", "locator",
                "excerpt", "accessedAt", "notes", "updatedAt"
            ],
            "filterFields": ["targetType"],
            "includes": [],
            "writeSchemas": {
                "create": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["sourceId", "targetType", "targetId"],
                    "properties": properties
                },
                "update": {
                    "type": "object",
                    "additionalProperties": false,
                    "minProperties": 1,
                    "properties": properties
                }
            },
            "schemaStatus": "published",
        });
    }
    if resource != Resource::Person {
        return json!({
            "resource": name,
            "actions": actions,
            "scope": { "project": { "required": true, "option": "--project" } },
            "systemFields": SYSTEM_FIELDS,
            "readableFields": [],
            "filterFields": [],
            "includes": [],
            "writeSchemas": {},
            "schemaStatus": "not-yet-published",
        });
    }

    let name_schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["value", "type", "primary"],
        "properties": {
            "value": { "type": "string", "minLength": 1 },
            "type": { "enum": NAME_TYPES },
            "primary": { "type": "boolean" },
            "customTypeLabel": { "type": "string" },
            "familyName": { "type": "string" },
            "givenName": { "type": "string" },
            "validFrom": date_schema,
            "validTo": date_schema,
            "context": { "type": "string" },
            "notes": { "type": "string" }
        }
    });
    let properties = json!({
        "names": { "type": "array", "minItems": 1, "items": name_schema },
        "sex": { "enum": SEX_VALUES, "default": "unknown" },
        "status": { "enum": STATUS_VALUES, "default": "unknown" },
        "birth": date_schema,
        "death": date_schema,
        "birthPlaceId": { "type": "string" },
        "deathPlaceId": { "type": "string" },
        "biography": { "type": "string", "default": "" },
        "notes": { "type": "string", "default": "" }
    });
    json!({
        "resource": name,
        "actions": actions,
        "scope": { "project": { "required": true, "option": "--project", "allowedWithInput": true } },
        "systemFields": SYSTEM_FIELDS,
        "readableFields": [
            "id", "projectId", "names", "sex", "status", "birth", "death",
            "birthPlaceId", "deathPlaceId", "biography", "notes", "updatedAt"
        ],
        "filterFields": ["sex", "status"],
        "includes": [],
        "writeSchemas": {
            "create": {
                "type": "object",
                "additionalProperties": false,
                "required": ["names"],
                "properties": properties
            },
            "update": {
                "type": "object",
                "additionalProperties": false,
                "minProperties": 1,
                "properties": properties
            }
        },
        "schemaStatus": "published",
    })
}

pub fn writable_fields(resource: Resource) -> &'static [&'static str] {
    match resource {
        Resource::Person => PERSON_FIELDS,
        Resource::Organization => &[
            "name",
            "type",
            "aliases",
            "parentId",
            "placeId",
            "validFrom",
            "validTo",
            "notes",
            "sourceIds",
        ],
        Resource::Career => &[
            "personId",
            "category",
            "organizationId",
            "positionTitle",
            "department",
            "regime",
            "rankOrGrade",
            "appointmentType",
            "jurisdictionPlaceId",
            "appointedByPersonId",
            "start",
            "end",
            "status",
            "description",
            "notes",
            "sourceIds",
        ],
        Resource::Title => &[
            "personId",
            "type",
            "value",
            "customTypeLabel",
            "start",
            "end",
            "placeId",
            "grantedByPersonId",
            "notes",
            "sourceIds",
        ],
        Resource::Relationship => &[
            "fromPersonId",
            "toPersonId",
            "category",
            "type",
            "start",
            "end",
            "placeId",
            "notes",
            "sourceIds",
        ],
        Resource::Event => &[
            "type",
            "title",
            "date",
            "placeId",
            "participantIds",
            "participantRoles",
            "sourceIds",
            "notes",
        ],
        Resource::Place => &["name", "parentId", "aliases", "notes"],
        Resource::Source => &[
            "title",
            "type",
            "author",
            "repository",
            "url",
            "date",
            "referenceCode",
            "notes",
        ],
        Resource::Citation => &[
            "sourceId",
            "targetType",
            "targetId",
            "locator",
            "excerpt",
            "accessedAt",
            "notes",
        ],
        Resource::Attachment => &["name", "mimeType", "size", "contentHash", "missing"],
    }
}

pub fn prepare_create_input(resource: Resource, input: &Value) -> CoreResult<Value> {
    reject_system_fields(input)?;
    reject_unknown_fields(resource, input)?;
    let mut normalized = input.clone();
    match resource {
        Resource::Person => {
            let object = normalized.as_object_mut().ok_or_else(|| {
                CoreError::Validation("person input must be an object".to_owned())
            })?;
            object.entry("sex").or_insert(json!("unknown"));
            object.entry("status").or_insert(json!("unknown"));
            object.entry("biography").or_insert(json!(""));
            object.entry("notes").or_insert(json!(""));
            validate_person(&normalized)?;
        }
        Resource::Event => {
            let object = normalized
                .as_object_mut()
                .ok_or_else(|| CoreError::Validation("event input must be an object".to_owned()))?;
            object.entry("participantIds").or_insert(json!([]));
            object.entry("sourceIds").or_insert(json!([]));
            object.entry("notes").or_insert(json!(""));
            validate_event(&normalized)?;
        }
        Resource::Relationship => {
            let object = normalized.as_object_mut().ok_or_else(|| {
                CoreError::Validation("relationship input must be an object".to_owned())
            })?;
            object.entry("sourceIds").or_insert(json!([]));
            object.entry("notes").or_insert(json!(""));
            validate_relationship(&normalized)?;
        }
        Resource::Source => {
            let object = normalized.as_object_mut().ok_or_else(|| {
                CoreError::Validation("source input must be an object".to_owned())
            })?;
            object.entry("notes").or_insert(json!(""));
            validate_source(&normalized)?;
        }
        Resource::Citation => {
            let object = normalized.as_object_mut().ok_or_else(|| {
                CoreError::Validation("citation input must be an object".to_owned())
            })?;
            object.entry("notes").or_insert(json!(""));
            validate_citation(&normalized)?;
        }
        _ => {}
    }
    Ok(normalized)
}

pub fn validate_update_input(resource: Resource, input: &Value) -> CoreResult<()> {
    reject_system_fields(input)?;
    reject_unknown_fields(resource, input)
}

pub fn validate_record(resource: Resource, value: &Value) -> CoreResult<()> {
    match resource {
        Resource::Person => validate_person(value)?,
        Resource::Event => validate_event(value)?,
        Resource::Relationship => validate_relationship(value)?,
        Resource::Source => validate_source(value)?,
        Resource::Citation => validate_citation(value)?,
        _ => {}
    }
    Ok(())
}

fn reject_system_fields(input: &Value) -> CoreResult<()> {
    let object = input
        .as_object()
        .ok_or_else(|| CoreError::Validation("input must be an object".to_owned()))?;
    let forbidden = SYSTEM_FIELDS
        .iter()
        .filter(|field| object.contains_key(**field))
        .copied()
        .collect::<Vec<_>>();
    if forbidden.is_empty() {
        return Ok(());
    }
    Err(CoreError::Validation(format!(
        "system fields are controlled by Branchloom and cannot appear in input: {}",
        forbidden.join(", ")
    )))
}

fn reject_unknown_fields(resource: Resource, input: &Value) -> CoreResult<()> {
    let object = input
        .as_object()
        .ok_or_else(|| CoreError::Validation("input must be an object".to_owned()))?;
    let allowed = writable_fields(resource);
    let unknown = object
        .keys()
        .filter(|field| !allowed.contains(&field.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if unknown.is_empty() {
        return Ok(());
    }
    Err(CoreError::Validation(format!(
        "unknown {} fields: {}",
        resource.as_str(),
        unknown.join(", ")
    )))
}

fn validate_person(value: &Value) -> CoreResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::Validation("person must be an object".to_owned()))?;
    let names = object
        .get("names")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CoreError::Validation("person.names must be a non-empty array".to_owned())
        })?;
    if names.is_empty() {
        return Err(CoreError::Validation(
            "person.names must be a non-empty array".to_owned(),
        ));
    }
    let mut primary_count = 0;
    let mut normalized_values = HashSet::new();
    for (index, name) in names.iter().enumerate() {
        validate_name(name, index)?;
        let name = name.as_object().expect("validated name object");
        if name.get("primary").and_then(Value::as_bool) == Some(true) {
            primary_count += 1;
        }
        let value = name
            .get("value")
            .and_then(Value::as_str)
            .expect("validated name");
        let normalized = normalize_name(value);
        if !normalized_values.insert(normalized) {
            return Err(CoreError::Validation(format!(
                "person.names contains a duplicate value at index {index}"
            )));
        }
    }
    if primary_count != 1 {
        return Err(CoreError::Validation(format!(
            "person.names must contain exactly one primary name; found {primary_count}"
        )));
    }
    validate_enum(object, "sex", SEX_VALUES)?;
    validate_enum(object, "status", STATUS_VALUES)?;
    validate_optional_string(object, "biography")?;
    validate_optional_string(object, "notes")?;
    for field in ["birth", "death"] {
        if let Some(date) = object.get(field) {
            validate_date(date, &format!("person.{field}"))?;
        }
    }
    Ok(())
}

fn validate_event(value: &Value) -> CoreResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::Validation("event must be an object".to_owned()))?;
    validate_required_non_empty_string(object, "type", "event.type")?;
    validate_required_non_empty_string(object, "title", "event.title")?;
    let date = object
        .get("date")
        .ok_or_else(|| CoreError::Validation("event.date is required".to_owned()))?;
    validate_date(date, "event.date")?;
    validate_event_date(date)?;

    if object.contains_key("placeId") {
        validate_required_non_empty_string(object, "placeId", "event.placeId")?;
    }
    let participant_ids = validate_unique_string_array(object, "participantIds", "event")?;
    validate_unique_string_array(object, "sourceIds", "event")?;
    object
        .get("notes")
        .filter(|value| value.is_string())
        .ok_or_else(|| CoreError::Validation("event.notes must be a string".to_owned()))?;

    if let Some(roles) = object.get("participantRoles") {
        let roles = roles.as_object().ok_or_else(|| {
            CoreError::Validation("event.participantRoles must be an object".to_owned())
        })?;
        for (person_id, role) in roles {
            if person_id.trim().is_empty() {
                return Err(CoreError::Validation(
                    "event.participantRoles contains an empty person id".to_owned(),
                ));
            }
            if !participant_ids.contains(person_id.as_str()) {
                return Err(CoreError::Validation(format!(
                    "event.participantRoles references non-participant: {person_id}"
                )));
            }
            if !role
                .as_str()
                .map(str::trim)
                .is_some_and(|role| !role.is_empty())
            {
                return Err(CoreError::Validation(format!(
                    "event.participantRoles.{person_id} must be a non-empty string"
                )));
            }
        }
    }
    Ok(())
}

fn validate_relationship(value: &Value) -> CoreResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::Validation("relationship must be an object".to_owned()))?;
    validate_required_non_empty_string(object, "fromPersonId", "relationship.fromPersonId")?;
    validate_required_non_empty_string(object, "toPersonId", "relationship.toPersonId")?;
    validate_enum(object, "category", RELATIONSHIP_CATEGORIES)?;
    let category = object
        .get("category")
        .and_then(Value::as_str)
        .expect("relationship category validated");
    let allowed_types = if category == "parent" {
        PARENT_RELATIONSHIP_TYPES
    } else {
        PARTNER_RELATIONSHIP_TYPES
    };
    let relationship_type = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Validation("relationship.type must be a string".to_owned()))?;
    if !allowed_types.contains(&relationship_type) {
        return Err(CoreError::Validation(format!(
            "relationship.type must be one of {} when category is {category}",
            allowed_types.join(", ")
        )));
    }
    for field in ["start", "end"] {
        if let Some(date) = object.get(field) {
            validate_date(date, &format!("relationship.{field}"))?;
        }
    }
    if object.contains_key("placeId") {
        validate_required_non_empty_string(object, "placeId", "relationship.placeId")?;
    }
    validate_unique_string_array(object, "sourceIds", "relationship")?;
    object
        .get("notes")
        .filter(|value| value.is_string())
        .ok_or_else(|| CoreError::Validation("relationship.notes must be a string".to_owned()))?;
    Ok(())
}

fn validate_source(value: &Value) -> CoreResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::Validation("source must be an object".to_owned()))?;
    validate_required_non_empty_string(object, "title", "source.title")?;
    validate_enum(object, "type", SOURCE_TYPES)?;
    for field in ["author", "repository", "url", "referenceCode"] {
        validate_optional_string(object, field)?;
    }
    if let Some(date) = object.get("date") {
        validate_date(date, "source.date")?;
    }
    object
        .get("notes")
        .filter(|value| value.is_string())
        .ok_or_else(|| CoreError::Validation("source.notes must be a string".to_owned()))?;
    Ok(())
}

fn validate_citation(value: &Value) -> CoreResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::Validation("citation must be an object".to_owned()))?;
    validate_required_non_empty_string(object, "sourceId", "citation.sourceId")?;
    validate_enum(object, "targetType", CITATION_TARGET_TYPES)?;
    validate_required_non_empty_string(object, "targetId", "citation.targetId")?;
    for field in ["locator", "excerpt"] {
        validate_optional_string(object, field)?;
    }
    if let Some(date) = object.get("accessedAt") {
        validate_date(date, "citation.accessedAt")?;
    }
    object
        .get("notes")
        .filter(|value| value.is_string())
        .ok_or_else(|| CoreError::Validation("citation.notes must be a string".to_owned()))?;
    Ok(())
}

fn validate_event_date(value: &Value) -> CoreResult<()> {
    let object = value.as_object().expect("date shape validated");
    let precision = object
        .get("precision")
        .and_then(Value::as_str)
        .expect("date precision validated");
    let start = object.get("start").and_then(Value::as_str);
    let end = object.get("end").and_then(Value::as_str);
    let invalid = |message: &str| CoreError::Validation(format!("event.date {message}"));
    match precision {
        "unknown" if start.is_some() || end.is_some() => {
            return Err(invalid("cannot have boundaries when precision is unknown"));
        }
        "exact" | "about" if start.is_none() && end.is_none() => {
            return Err(invalid("requires a start or end boundary"));
        }
        "before" if end.is_none() => return Err(invalid("requires end for precision before")),
        "after" if start.is_none() => return Err(invalid("requires start for precision after")),
        "range" if start.is_none() || end.is_none() => {
            return Err(invalid("requires start and end for precision range"));
        }
        _ => {}
    }
    if precision == "exact" && start.is_some() && end.is_some() && start != end {
        return Err(invalid(
            "requires equal start and end boundaries for precision exact",
        ));
    }
    if precision == "range"
        && start
            .zip(end)
            .is_some_and(|(start, end)| iso_lower_bound(start) > iso_upper_bound(end))
    {
        return Err(invalid("start boundary must not be after end boundary"));
    }
    Ok(())
}

fn validate_name(value: &Value, index: usize) -> CoreResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::Validation(format!("person.names[{index}] must be an object")))?;
    let unknown = object
        .keys()
        .filter(|field| !NAME_FIELDS.contains(&field.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(CoreError::Validation(format!(
            "person.names[{index}] contains unknown fields: {}",
            unknown.join(", ")
        )));
    }
    let name = object
        .get("value")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CoreError::Validation(format!("person.names[{index}].value is required")))?;
    if name.is_empty() {
        return Err(CoreError::Validation(format!(
            "person.names[{index}].value is required"
        )));
    }
    validate_enum(object, "type", NAME_TYPES)?;
    if !object.get("primary").is_some_and(Value::is_boolean) {
        return Err(CoreError::Validation(format!(
            "person.names[{index}].primary must be a boolean"
        )));
    }
    let is_custom = object.get("type").and_then(Value::as_str) == Some("custom");
    let custom_label = object
        .get("customTypeLabel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if is_custom && custom_label.is_none() {
        return Err(CoreError::Validation(format!(
            "person.names[{index}].customTypeLabel is required for type custom"
        )));
    }
    if !is_custom && object.contains_key("customTypeLabel") {
        return Err(CoreError::Validation(format!(
            "person.names[{index}].customTypeLabel is only allowed for type custom"
        )));
    }
    for field in ["validFrom", "validTo"] {
        if let Some(date) = object.get(field) {
            validate_date(date, &format!("person.names[{index}].{field}"))?;
        }
    }
    Ok(())
}

fn validate_enum(object: &Map<String, Value>, field: &str, allowed: &[&str]) -> CoreResult<()> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Validation(format!("{field} must be a string")))?;
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(CoreError::Validation(format!(
            "{field} must be one of: {}",
            allowed.join(", ")
        )))
    }
}

fn validate_optional_string(object: &Map<String, Value>, field: &str) -> CoreResult<()> {
    if object.get(field).is_some_and(|value| !value.is_string()) {
        return Err(CoreError::Validation(format!("{field} must be a string")));
    }
    Ok(())
}

fn validate_required_non_empty_string(
    object: &Map<String, Value>,
    field: &str,
    path: &str,
) -> CoreResult<()> {
    if object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        Ok(())
    } else {
        Err(CoreError::Validation(format!(
            "{path} must be a non-empty string"
        )))
    }
}

fn validate_unique_string_array<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    path: &str,
) -> CoreResult<HashSet<&'a str>> {
    let values = object
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError::Validation(format!("{path}.{field} must be an array")))?;
    let mut unique = HashSet::new();
    for (index, value) in values.iter().enumerate() {
        let value = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                CoreError::Validation(format!(
                    "{path}.{field}[{index}] must be a non-empty string"
                ))
            })?;
        if !unique.insert(value) {
            return Err(CoreError::Validation(format!(
                "{path}.{field} contains duplicate value: {value}"
            )));
        }
    }
    Ok(unique)
}

fn validate_date(value: &Value, path: &str) -> CoreResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| CoreError::Validation(format!("{path} must be an object")))?;
    let allowed = ["display", "start", "end", "precision"];
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(CoreError::Validation(format!(
            "{path} contains unknown field: {field}"
        )));
    }
    let precision = object
        .get("precision")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Validation(format!("{path}.precision is required")))?;
    if !DATE_PRECISIONS.contains(&precision) {
        return Err(CoreError::Validation(format!(
            "{path}.precision is invalid"
        )));
    }
    for field in ["display", "start", "end"] {
        if object.get(field).is_some_and(|value| !value.is_string()) {
            return Err(CoreError::Validation(format!(
                "{path}.{field} must be a string"
            )));
        }
    }
    for field in ["start", "end"] {
        if let Some(boundary) = object.get(field).and_then(Value::as_str) {
            validate_iso_boundary(boundary, &format!("{path}.{field}"))?;
        }
    }
    Ok(())
}

fn validate_iso_boundary(value: &str, path: &str) -> CoreResult<()> {
    let parts = value.split('-').collect::<Vec<_>>();
    let valid_digits = |value: &str, width: usize| {
        value.len() == width && value.bytes().all(|byte| byte.is_ascii_digit())
    };
    let valid_year = !parts[0].is_empty()
        && parts[0].len() <= 4
        && parts[0].bytes().all(|byte| byte.is_ascii_digit())
        && parts[0].bytes().any(|byte| byte != b'0');
    if !(1..=3).contains(&parts.len()) || !valid_year {
        return Err(CoreError::Validation(format!(
            "{path} must use Y-YYYY, Y-YYYY-MM, or Y-YYYY-MM-DD"
        )));
    }
    let year = parts[0].parse::<u32>().expect("validated year digits");
    let month = if let Some(month) = parts.get(1) {
        if !valid_digits(month, 2) {
            return Err(CoreError::Validation(format!(
                "{path} has an invalid month"
            )));
        }
        let month = month.parse::<u32>().expect("two validated digits");
        if !(1..=12).contains(&month) {
            return Err(CoreError::Validation(format!(
                "{path} has an invalid month"
            )));
        }
        month
    } else {
        1
    };
    if let Some(day) = parts.get(2) {
        if !valid_digits(day, 2) {
            return Err(CoreError::Validation(format!("{path} has an invalid day")));
        }
        let day = day.parse::<u32>().expect("two validated digits");
        if day == 0 || day > days_in_month(year, month) {
            return Err(CoreError::Validation(format!("{path} has an invalid day")));
        }
    }
    Ok(())
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn iso_lower_bound(value: &str) -> String {
    let mut parts = value.split('-');
    let year = parts.next().expect("validated ISO year");
    let month = parts.next().unwrap_or("01");
    let day = parts.next().unwrap_or("01");
    format!(
        "{:04}-{month}-{day}",
        year.parse::<u32>().expect("validated ISO year")
    )
}

fn iso_upper_bound(value: &str) -> String {
    let mut parts = value.split('-');
    let year = parts.next().expect("validated ISO year");
    let month = parts.next();
    let day = parts.next();
    let padded_year = format!("{:04}", year.parse::<u32>().expect("validated ISO year"));
    match (month, day) {
        (None, _) => format!("{padded_year}-12-31"),
        (Some(month), None) => {
            let last_day = days_in_month(
                year.parse().expect("validated ISO year"),
                month.parse().expect("validated ISO month"),
            );
            format!("{padded_year}-{month}-{last_day:02}")
        }
        (Some(month), Some(day)) => format!("{padded_year}-{month}-{day}"),
    }
}

fn normalize_name(value: &str) -> String {
    value
        .nfc()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn person_input_rejects_system_fields() {
        let result = prepare_create_input(
            Resource::Person,
            &json!({
                "projectId": "wrong-project",
                "names": [{ "value": "赵匡胤", "type": "personal", "primary": true }]
            }),
        );
        assert!(
            matches!(result, Err(CoreError::Validation(message)) if message.contains("projectId"))
        );
    }

    #[test]
    fn person_input_normalizes_defaults_and_accepts_embedded_names_without_ids() {
        let result = prepare_create_input(
            Resource::Person,
            &json!({
                "names": [
                    { "value": "赵匡胤", "type": "personal", "primary": true },
                    { "value": "元朗", "type": "courtesy", "primary": false }
                ]
            }),
        )
        .expect("valid person");
        assert_eq!(result["sex"], "unknown");
        assert_eq!(result["status"], "unknown");
        assert!(result["names"][0].get("id").is_none());
    }

    #[test]
    fn person_input_rejects_duplicate_and_ambiguous_primary_names() {
        let duplicate = prepare_create_input(
            Resource::Person,
            &json!({
                "names": [
                    { "value": "  Zhao  Yun ", "type": "personal", "primary": true },
                    { "value": "zhao yun", "type": "alias", "primary": false }
                ]
            }),
        );
        assert!(
            matches!(duplicate, Err(CoreError::Validation(message)) if message.contains("duplicate"))
        );

        let primary = prepare_create_input(
            Resource::Person,
            &json!({
                "names": [{ "value": "赵匡胤", "type": "personal", "primary": false }]
            }),
        );
        assert!(
            matches!(primary, Err(CoreError::Validation(message)) if message.contains("exactly one"))
        );
    }

    #[test]
    fn person_input_rejects_removed_name_language_and_script_fields() {
        for field in ["language", "script"] {
            let result = prepare_create_input(
                Resource::Person,
                &json!({
                    "names": [{
                        "value": "赵匡胤",
                        "type": "personal",
                        "primary": true,
                        (field): "removed"
                    }]
                }),
            );
            assert!(
                matches!(result, Err(CoreError::Validation(message)) if message.contains(field))
            );
        }
    }

    #[test]
    fn event_describe_publishes_create_and_update_schemas() {
        let description = describe_resource(Resource::Event);
        assert_eq!(description["schemaStatus"], "published");
        assert_eq!(description["scope"]["project"]["allowedWithInput"], true);
        assert_eq!(
            description["writeSchemas"]["create"]["required"],
            json!(["type", "title", "date"])
        );
        assert_eq!(
            description["writeSchemas"]["create"]["properties"]["participantIds"]["uniqueItems"],
            true
        );
    }

    #[test]
    fn event_input_adds_safe_defaults_and_accepts_participant_roles() {
        let event = prepare_create_input(
            Resource::Event,
            &json!({
                "type": "accession",
                "title": "赵匡胤即皇帝位",
                "date": { "precision": "exact", "start": "0960-02-04" },
                "participantIds": ["person-taizu"],
                "participantRoles": { "person-taizu": "即位者" }
            }),
        )
        .expect("valid event");
        assert_eq!(event["sourceIds"], json!([]));
        assert_eq!(event["notes"], "");
        assert_eq!(event["participantRoles"]["person-taizu"], "即位者");
    }

    #[test]
    fn genealogy_dates_accept_years_before_one_thousand_and_compare_them_chronologically() {
        let event = prepare_create_input(
            Resource::Event,
            &json!({
                "type": "birth",
                "title": "赵匡胤出生",
                "date": { "precision": "exact", "start": "927-03-21" }
            }),
        )
        .expect("three-digit genealogy year");
        assert_eq!(event["date"]["start"], "927-03-21");

        let reversed = prepare_create_input(
            Resource::Event,
            &json!({
                "type": "other",
                "title": "倒置范围",
                "date": { "precision": "range", "start": "1000", "end": "927" }
            }),
        );
        assert!(
            matches!(reversed, Err(CoreError::Validation(message)) if message.contains("must not be after"))
        );
    }

    #[test]
    fn event_input_rejects_invalid_dates_duplicates_and_unbound_roles() {
        let invalid_date = prepare_create_input(
            Resource::Event,
            &json!({
                "type": "birth",
                "title": "无效日期",
                "date": { "precision": "exact", "start": "0960-02-30" }
            }),
        );
        assert!(
            matches!(invalid_date, Err(CoreError::Validation(message)) if message.contains("invalid day"))
        );

        let duplicate = prepare_create_input(
            Resource::Event,
            &json!({
                "type": "accession",
                "title": "重复参与者",
                "date": { "precision": "exact", "start": "0960" },
                "participantIds": ["person-taizu", "person-taizu"]
            }),
        );
        assert!(
            matches!(duplicate, Err(CoreError::Validation(message)) if message.contains("duplicate"))
        );

        let unbound_role = prepare_create_input(
            Resource::Event,
            &json!({
                "type": "accession",
                "title": "角色未绑定参与者",
                "date": { "precision": "exact", "start": "0960" },
                "participantRoles": { "person-other": "见证者" }
            }),
        );
        assert!(
            matches!(unbound_role, Err(CoreError::Validation(message)) if message.contains("non-participant"))
        );
    }

    #[test]
    fn relationship_source_and_citation_descriptions_publish_write_schemas() {
        let relationship = describe_resource(Resource::Relationship);
        assert_eq!(relationship["schemaStatus"], "published");
        assert_eq!(
            relationship["writeSchemas"]["add"]["required"],
            json!(["fromPersonId", "toPersonId", "category", "type"])
        );
        assert!(relationship["writeSchemas"].get("create").is_none());

        for resource in [Resource::Source, Resource::Citation] {
            let description = describe_resource(resource);
            assert_eq!(description["schemaStatus"], "published");
            assert_eq!(description["scope"]["project"]["allowedWithInput"], true);
            assert!(description["writeSchemas"]["create"].is_object());
            assert!(description["writeSchemas"]["update"].is_object());
        }
    }

    #[test]
    fn relationship_input_adds_defaults_and_enforces_category_specific_types() {
        let relationship = prepare_create_input(
            Resource::Relationship,
            &json!({
                "fromPersonId": "person-parent",
                "toPersonId": "person-child",
                "category": "parent",
                "type": "biological"
            }),
        )
        .expect("valid relationship");
        assert_eq!(relationship["sourceIds"], json!([]));
        assert_eq!(relationship["notes"], "");

        let invalid = prepare_create_input(
            Resource::Relationship,
            &json!({
                "fromPersonId": "person-one",
                "toPersonId": "person-two",
                "category": "parent",
                "type": "married"
            }),
        );
        assert!(
            matches!(invalid, Err(CoreError::Validation(message)) if message.contains("when category is parent"))
        );
    }

    #[test]
    fn source_and_citation_inputs_validate_enums_dates_and_defaults() {
        let source = prepare_create_input(
            Resource::Source,
            &json!({
                "title": "宋史",
                "type": "book",
                "date": { "precision": "about", "start": "1345" }
            }),
        )
        .expect("valid source");
        assert_eq!(source["notes"], "");

        let citation = prepare_create_input(
            Resource::Citation,
            &json!({
                "sourceId": "source-song-shi",
                "targetType": "person",
                "targetId": "person-taizu"
            }),
        )
        .expect("valid citation");
        assert_eq!(citation["notes"], "");

        let invalid_source = prepare_create_input(
            Resource::Source,
            &json!({ "title": "无效来源", "type": "database" }),
        );
        assert!(matches!(
            invalid_source,
            Err(CoreError::Validation(message)) if message.contains("book, archive, web, interview, other")
        ));

        let invalid_citation = prepare_create_input(
            Resource::Citation,
            &json!({
                "sourceId": "source-song-shi",
                "targetType": "place",
                "targetId": "place-kaifeng"
            }),
        );
        assert!(matches!(
            invalid_citation,
            Err(CoreError::Validation(message)) if message.contains("person, relationship, event, career")
        ));
    }
}
