use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::required_record_string;
use crate::contract::normalize_name;
use crate::core::error::{CoreError, CoreResult};
use crate::storage::DesktopRecordChange;

#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PersonMergeInput {
    pub keep_person_id: String,
    pub remove_person_id: String,
    choices: MergeChoices,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Side {
    #[default]
    Auto,
    Keep,
    Remove,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct MergeChoices {
    sex: Side,
    status: Side,
    avatar_url: Side,
    birth: Side,
    death: Side,
    birth_place_id: Side,
    death_place_id: Side,
    biography: Side,
    notes: Side,
    retained_name_values: Option<HashSet<String>>,
    retained_source_ids: Option<HashSet<String>>,
    retained_relationship_ids: Option<HashSet<String>>,
    retained_event_ids: Option<HashSet<String>>,
    retained_citation_ids: Option<HashSet<String>>,
    retained_attachment_link_ids: Option<HashSet<String>>,
    relationship_conflict_choices: Vec<RelationshipChoice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelationshipChoice {
    relationship_ids: [String; 2],
    fields: HashMap<String, String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MergeSummary {
    removed_people: usize,
    rewired_relationships: usize,
    removed_relationships: usize,
    rewired_events: usize,
    rewired_citations: usize,
    rewired_attachment_links: usize,
}

pub(super) struct MergePlan {
    pub retained_person: Value,
    pub changes: Vec<DesktopRecordChange>,
    pub summary: MergeSummary,
}

#[derive(Clone, Copy)]
enum Target<'a> {
    Keep,
    Relationship(&'a str),
    Discard,
}

type RelationshipTargets<'a> = HashMap<&'a str, Option<Target<'a>>>;

struct Merge<'a> {
    input: &'a PersonMergeInput,
    project_id: &'a str,
    timestamp: &'a str,
    changes: Vec<DesktopRecordChange>,
    summary: MergeSummary,
}

pub(super) fn plan(
    state: &Value,
    keep: &Value,
    remove: &Value,
    input: &PersonMergeInput,
    timestamp: &str,
) -> CoreResult<MergePlan> {
    let mut merge = Merge {
        input,
        project_id: required_record_string(keep, "projectId")?,
        timestamp,
        changes: Vec::new(),
        summary: MergeSummary {
            removed_people: 1,
            ..Default::default()
        },
    };
    let retained_person = merged_person(keep, remove, &input.choices, timestamp)?;
    merge.change("people", keep, Some(retained_person.clone()))?;
    let relationship_targets = merge.relationships(record_list(state, "relationships")?)?;
    merge.events(record_list(state, "events")?)?;
    let related_citations =
        merge.citations(record_list(state, "citations")?, &relationship_targets)?;
    merge.attachment_links(
        record_list(state, "attachmentLinks")?,
        record_list(state, "attachments")?,
        &relationship_targets,
        &related_citations,
    )?;
    merge.issues(record_list(state, "issues")?, &relationship_targets)?;

    for (collection, fields) in [
        ("careers", ["personId", "appointedByPersonId"]),
        ("personTitles", ["personId", "grantedByPersonId"]),
    ] {
        for record in record_list(state, collection)? {
            let mut after = record.clone();
            for field in fields {
                merge.replace_person(&mut after, field);
            }
            merge.change(collection, record, Some(after))?;
        }
    }

    let project = record_list(state, "projects")?
        .first()
        .ok_or_else(|| CoreError::Validation("merge project is missing".to_owned()))?;
    let mut after = project.clone();
    merge.replace_person(&mut after, "defaultPersonId");
    merge.publication_references(&mut after);
    after["updatedAt"] = json!(timestamp);
    merge.change("projects", project, Some(after))?;
    merge.change("people", remove, None)?;
    Ok(MergePlan {
        retained_person,
        changes: merge.changes,
        summary: merge.summary,
    })
}

fn record_list<'a>(state: &'a Value, collection: &str) -> CoreResult<&'a [Value]> {
    state
        .get(collection)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| CoreError::Validation(format!("merge collection is missing: {collection}")))
}

fn merged_person(
    keep: &Value,
    remove: &Value,
    choices: &MergeChoices,
    timestamp: &str,
) -> CoreResult<Value> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for name in record_list(keep, "names")?
        .iter()
        .chain(record_list(remove, "names")?)
    {
        let value = required_record_string(name, "value")?;
        if selected(&choices.retained_name_values, value) && seen.insert(normalize_name(value)) {
            names.push(name.clone());
        }
    }
    if names.is_empty() {
        return Err(CoreError::Validation(
            "Person merge must retain at least one name".to_owned(),
        ));
    }
    let primary = names
        .iter()
        .position(|name| name["primary"] == true)
        .unwrap_or(0);
    for (index, name) in names.iter_mut().enumerate() {
        name["primary"] = json!(index == primary);
    }

    let mut after = keep.clone();
    let object = after
        .as_object_mut()
        .ok_or_else(|| CoreError::Validation("person must be an object".to_owned()))?;
    for (field, side) in [
        ("sex", choices.sex),
        ("status", choices.status),
        ("birth", choices.birth),
        ("death", choices.death),
        ("birthPlaceId", choices.birth_place_id),
        ("deathPlaceId", choices.death_place_id),
        ("biography", choices.biography),
        ("notes", choices.notes),
    ] {
        let left = meaningful_person_value(keep, field);
        let right = meaningful_person_value(remove, field);
        let value = match side {
            Side::Keep => keep.get(field),
            Side::Remove => remove.get(field),
            Side::Auto => {
                if left
                    .zip(right)
                    .is_some_and(|(left, right)| values_conflict(left, right))
                {
                    return Err(CoreError::Validation(format!(
                        "Person merge requires an explicit choice for conflicting field: {field}"
                    )));
                }
                left.or(right)
                    .or_else(|| keep.get(field))
                    .or_else(|| remove.get(field))
            }
        };
        if let Some(value) = value.filter(|value| !value.is_null()) {
            object.insert(field.to_owned(), value.clone());
        } else {
            object.remove(field);
        }
    }
    super::strip_runtime_media_record(super::Resource::Person, &mut after);
    after["names"] = json!(names);
    after["sourceIds"] = json!(source_ids(keep, remove, &choices.retained_source_ids)?);
    after["updatedAt"] = json!(timestamp);
    Ok(after)
}

fn meaningful_person_value<'a>(record: &'a Value, field: &str) -> Option<&'a Value> {
    record.get(field).filter(|value| {
        !value.is_null()
            && !value.as_str().is_some_and(|text| text.trim().is_empty())
            && !(matches!(field, "status" | "sex") && *value == "unknown")
            && !(matches!(field, "birth" | "death") && value["precision"] == "unknown")
    })
}

fn values_conflict(left: &Value, right: &Value) -> bool {
    if let (Some(left), Some(right)) = (left.as_object(), right.as_object()) {
        // The UI can synthesize a display string for dates entered through the CLI.
        if !left.contains_key("display") || !right.contains_key("display") {
            let fields = |object: &serde_json::Map<String, Value>| {
                object
                    .keys()
                    .filter(|key| key.as_str() != "display")
                    .count()
            };
            return fields(left) != fields(right)
                || left
                    .iter()
                    .any(|(key, value)| key != "display" && right.get(key) != Some(value));
        }
    }
    left != right
}

fn selected(ids: &Option<HashSet<String>>, id: &str) -> bool {
    ids.as_ref().is_none_or(|ids| ids.contains(id))
}

fn source_ids<'a>(
    keep: &'a Value,
    remove: &'a Value,
    retained: &Option<HashSet<String>>,
) -> CoreResult<Vec<&'a str>> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for id in [keep, remove].into_iter().flat_map(|record| {
        record
            .get("sourceIds")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
    }) {
        let id = id
            .as_str()
            .ok_or_else(|| CoreError::Validation("sourceIds values must be strings".to_owned()))?;
        if selected(retained, id) && seen.insert(id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn relationship_key(record: &Value) -> CoreResult<(&str, &str, &str, &str)> {
    let category = required_record_string(record, "category")?;
    let kind = required_record_string(record, "type")?;
    let mut from = required_record_string(record, "fromPersonId")?;
    let mut to = required_record_string(record, "toPersonId")?;
    if category == "partner" && from > to {
        std::mem::swap(&mut from, &mut to);
    }
    Ok((category, kind, from, to))
}

fn creates_self_relationship(before: &Value, after: &Value) -> bool {
    before["fromPersonId"] != before["toPersonId"] && after["fromPersonId"] == after["toPersonId"]
}

fn avatar_links<'a>(links: &'a [Value], person: &'a str) -> impl Iterator<Item = &'a Value> {
    links.iter().filter(move |link| {
        link["targetType"] == "person" && link["targetId"] == person && link["role"] == "avatar"
    })
}

fn attachment_target(link: &Value) -> [Option<&str>; 3] {
    ["attachmentId", "targetType", "targetId"].map(|field| link[field].as_str())
}

fn combine_relationship(
    keep: &mut Value,
    remove: &Value,
    choices: &[RelationshipChoice],
) -> CoreResult<()> {
    let keep_id = required_record_string(keep, "id")?;
    let remove_id = required_record_string(remove, "id")?;
    let resolution = choices.iter().find(|choice| {
        choice.relationship_ids == [keep_id, remove_id]
            || choice.relationship_ids == [remove_id, keep_id]
    });
    let mut fields = Vec::new();
    for field in ["start", "end", "placeId", "notes"] {
        let left = keep
            .get(field)
            .filter(|value| !value.is_null() && *value != "");
        let Some(right) = remove
            .get(field)
            .filter(|value| !value.is_null() && *value != "")
        else {
            continue;
        };
        match left {
            None => fields.push((field, right.clone())),
            Some(left) if values_conflict(left, right) => {
                match resolution.and_then(|choice| choice.fields.get(field)).map(String::as_str) {
                    Some(id) if id == keep_id => {},
                    Some(id) if id == remove_id => fields.push((field, right.clone())),
                    _ => return Err(CoreError::Validation(format!(
                        "Relationship merge requires explicit choices for {keep_id} / {remove_id}: {field}"
                    ))),
                }
            }
            _ => {}
        }
    }
    let sources = json!(source_ids(keep, remove, &None)?);
    for (field, value) in fields {
        keep[field] = value;
    }
    keep["sourceIds"] = sources;
    Ok(())
}

impl Merge<'_> {
    fn change(
        &mut self,
        collection: &'static str,
        before: &Value,
        mut after: Option<Value>,
    ) -> CoreResult<()> {
        if after.as_ref() == Some(before) {
            return Ok(());
        }
        let id = required_record_string(before, "id")?.to_owned();
        if let Some(after) = &mut after {
            after["updatedAt"] = json!(self.timestamp);
        }
        self.changes.push(DesktopRecordChange {
            collection,
            id,
            project_id: self.project_id.to_owned(),
            after,
        });
        Ok(())
    }

    fn replace_person(&self, record: &mut Value, field: &str) {
        if record[field] == self.input.remove_person_id {
            record[field] = json!(self.input.keep_person_id);
        }
    }

    fn chooses_person(&self, id: &Value) -> bool {
        *id == self.input.keep_person_id || *id == self.input.remove_person_id
    }

    fn relationships<'a>(&mut self, records: &'a [Value]) -> CoreResult<RelationshipTargets<'a>> {
        let mut relationships = Vec::new();
        let mut targets = HashMap::new();
        for before in records.iter().filter(|record| {
            self.chooses_person(&record["fromPersonId"])
                || self.chooses_person(&record["toPersonId"])
        }) {
            let id = required_record_string(before, "id")?;
            let mut after = before.clone();
            self.replace_person(&mut after, "fromPersonId");
            self.replace_person(&mut after, "toPersonId");
            let retained = selected(&self.input.choices.retained_relationship_ids, id);
            if creates_self_relationship(before, &after) {
                targets.insert(
                    id,
                    Some(if retained {
                        Target::Keep
                    } else {
                        Target::Discard
                    }),
                );
            } else {
                targets.insert(id, None);
                relationships.push((id, before, after, retained));
            }
        }

        // Process in the same order as the preview. Only coalesce relationships that
        // become equivalent through the merge; pre-existing duplicates are left alone.
        let mut groups: HashMap<_, usize> = HashMap::new();
        let mut kept: Vec<(&str, &Value, Value, bool)> = Vec::new();
        for (id, before, after, _) in relationships.iter().filter(|(_, _, _, retained)| *retained) {
            let rewired = *before != after;
            self.summary.rewired_relationships += usize::from(rewired);
            let key = relationship_key(after)?;
            if let Some(&index) = groups.get(&key) {
                let (prior_id, _, prior, prior_rewired) = &mut kept[index];
                if rewired || *prior_rewired {
                    combine_relationship(
                        prior,
                        after,
                        &self.input.choices.relationship_conflict_choices,
                    )?;
                    *prior_rewired = true;
                    targets.insert(*id, Some(Target::Relationship(*prior_id)));
                    continue;
                }
            }
            groups.entry(key).or_insert(kept.len());
            kept.push((*id, *before, after.clone(), rewired));
        }
        for (id, _, after, _) in relationships.iter().filter(|(_, _, _, retained)| !retained) {
            let replacement = groups
                .get(&relationship_key(after)?)
                .map(|index| kept[*index].0);
            targets.insert(
                *id,
                Some(replacement.map_or(Target::Discard, Target::Relationship)),
            );
        }
        for (_, before, after, _) in kept {
            self.change("relationships", before, Some(after))?;
        }
        for before in records {
            if targets
                .get(required_record_string(before, "id")?)
                .is_some_and(Option::is_some)
            {
                self.change("relationships", before, None)?;
            }
        }
        self.summary.removed_relationships =
            targets.values().filter(|target| target.is_some()).count();
        Ok(targets)
    }

    fn events(&mut self, records: &[Value]) -> CoreResult<()> {
        for before in records {
            let participants = record_list(before, "participantIds")?;
            if !participants.iter().any(|id| self.chooses_person(id)) {
                continue;
            }
            let id = required_record_string(before, "id")?;
            let retained = selected(&self.input.choices.retained_event_ids, id);
            let mut after = before.clone();
            if retained {
                let mut seen = HashSet::new();
                let mut ids = Vec::new();
                for id in participants {
                    let id = id.as_str().ok_or_else(|| {
                        CoreError::Validation("event participant ID must be a string".to_owned())
                    })?;
                    let id = if id == self.input.remove_person_id {
                        self.input.keep_person_id.as_str()
                    } else {
                        id
                    };
                    if seen.insert(id) {
                        ids.push(id);
                    }
                }
                after["participantIds"] = json!(ids);
                self.summary.rewired_events += usize::from(
                    participants
                        .iter()
                        .any(|id| *id == self.input.remove_person_id),
                );
            } else {
                after["participantIds"] = json!(participants
                    .iter()
                    .filter(|id| !self.chooses_person(id))
                    .collect::<Vec<_>>());
            }
            if let Some(roles) = after
                .get_mut("participantRoles")
                .and_then(Value::as_object_mut)
            {
                let removed_role = roles.remove(&self.input.remove_person_id);
                if retained {
                    if let Some(role) = removed_role {
                        roles.entry(&self.input.keep_person_id).or_insert(role);
                    }
                } else {
                    roles.remove(&self.input.keep_person_id);
                }
            }
            self.change("events", before, Some(after))?;
        }
        Ok(())
    }

    fn target<'a>(
        &self,
        record: &Value,
        relationships: &RelationshipTargets<'a>,
    ) -> Option<Target<'a>> {
        match record["targetType"].as_str() {
            Some("person") if record["targetId"] == self.input.remove_person_id => {
                Some(Target::Keep)
            }
            Some("relationship") => relationships
                .get(record["targetId"].as_str()?)
                .copied()
                .flatten(),
            _ => None,
        }
    }

    fn retarget(&self, record: &Value, target: Option<Target<'_>>) -> Option<Value> {
        let mut after = record.clone();
        match target {
            Some(Target::Discard) => return None,
            Some(Target::Keep) => {
                after["targetType"] = json!("person");
                after["targetId"] = json!(self.input.keep_person_id);
            }
            Some(Target::Relationship(id)) => after["targetId"] = json!(id),
            None => {}
        }
        Some(after)
    }

    fn related_target(&self, record: &Value, relationships: &RelationshipTargets<'_>) -> bool {
        match record["targetType"].as_str() {
            Some("person") => self.chooses_person(&record["targetId"]),
            Some("relationship") => record["targetId"]
                .as_str()
                .is_some_and(|id| relationships.contains_key(id)),
            _ => false,
        }
    }

    fn citations<'a>(
        &mut self,
        records: &'a [Value],
        targets: &RelationshipTargets<'_>,
    ) -> CoreResult<HashMap<&'a str, bool>> {
        let mut related = HashMap::new();
        for before in records {
            let target = self.target(before, targets);
            let id = required_record_string(before, "id")?;
            if !self.related_target(before, targets) {
                continue;
            }
            let after = if selected(&self.input.choices.retained_citation_ids, id) {
                self.retarget(before, target)
            } else {
                None
            };
            related.insert(id, after.is_some());
            self.summary.rewired_citations +=
                usize::from(after.as_ref().is_some_and(|after| after != before));
            self.change("citations", before, after)?;
        }
        Ok(related)
    }

    fn attachment_links(
        &mut self,
        records: &[Value],
        attachments: &[Value],
        targets: &RelationshipTargets<'_>,
        related_citations: &HashMap<&str, bool>,
    ) -> CoreResult<()> {
        let choices = &self.input.choices;
        let avatar_key = |link: &Value| {
            attachments
                .iter()
                .find(|attachment| attachment["id"] == link["attachmentId"])
                .and_then(|attachment| attachment["contentHash"].as_str())
                .map(str::to_owned)
                .or_else(|| link["attachmentId"].as_str().map(str::to_owned))
        };
        let keep_avatar = avatar_links(records, &self.input.keep_person_id)
            .next()
            .and_then(avatar_key);
        let remove_avatar = avatar_links(records, &self.input.remove_person_id)
            .next()
            .and_then(avatar_key);
        if matches!(choices.avatar_url, Side::Auto)
            && keep_avatar
                .zip(remove_avatar)
                .is_some_and(|(left, right)| left != right)
        {
            return Err(CoreError::Validation(
                "Person merge requires an explicit choice for conflicting field: avatarUrl"
                    .to_owned(),
            ));
        }
        let selected_avatar = |person| {
            avatar_links(records, person)
                .filter_map(|link| link["id"].as_str())
                .find(|id| selected(&choices.retained_attachment_link_ids, id))
        };
        let keep_id = selected_avatar(&self.input.keep_person_id);
        let remove_id = selected_avatar(&self.input.remove_person_id);
        let avatar = match choices.avatar_url {
            Side::Remove => remove_id.or(keep_id),
            _ => keep_id.or(remove_id),
        };

        let mut planned_links = Vec::new();
        for before in records {
            let target = self.target(before, targets);
            let citation = if before["targetType"] == "citation" {
                before["targetId"]
                    .as_str()
                    .and_then(|id| related_citations.get(id))
            } else {
                None
            };
            let direct =
                before["targetType"] == "person" && self.chooses_person(&before["targetId"]);
            if !self.related_target(before, targets) && citation.is_none() {
                continue;
            }
            let id = required_record_string(before, "id")?;
            let after = if citation != Some(&false)
                && selected(&choices.retained_attachment_link_ids, id)
                && (!direct || before["role"] != "avatar" || avatar == Some(id))
            {
                self.retarget(before, target)
            } else {
                None
            };
            planned_links.push((before, after));
        }

        // Keep one link when rerouting would associate the same file twice. The
        // selected avatar takes precedence, then an existing link to that target.
        let mut preferred = HashMap::new();
        for (index, (before, after)) in planned_links.iter().enumerate() {
            if let Some(link) = after {
                let preference = (link["role"] == "avatar", *before == link);
                let best = preferred
                    .entry(attachment_target(link))
                    .or_insert((index, preference));
                if preference > best.1 {
                    *best = (index, preference);
                }
            }
        }
        for (index, (before, after)) in planned_links.iter().enumerate() {
            let after = after.as_ref().filter(|link| {
                preferred
                    .get(&attachment_target(link))
                    .is_some_and(|(winner, (_, existing))| {
                        *winner == index || (*existing && *before == *link)
                    })
            });
            self.summary.rewired_attachment_links +=
                usize::from(after.is_some_and(|after| after != *before));
            self.change("attachmentLinks", before, after.cloned())?;
        }
        Ok(())
    }

    fn issues(&mut self, records: &[Value], targets: &RelationshipTargets<'_>) -> CoreResult<()> {
        for before in records {
            let Some(target) = self.target(before, targets) else {
                continue;
            };
            let after = if before["origin"] == "manual" {
                self.retarget(before, Some(target)).map(|mut after| {
                    after["projectId"] = json!(self.project_id);
                    after
                })
            } else {
                None
            };
            self.change("issues", before, after)?;
        }
        Ok(())
    }

    fn publication_references(&self, project: &mut Value) {
        for plan in project
            .get_mut("publicationPlans")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            for field in ["roots", "exclude"] {
                if let Some(ids) = plan
                    .get_mut("scope")
                    .and_then(|scope| scope.get_mut(field))
                    .and_then(Value::as_array_mut)
                {
                    if ids.iter().any(|id| *id == self.input.remove_person_id) {
                        let mut kept = false;
                        ids.retain_mut(|id| {
                            if *id == self.input.remove_person_id {
                                *id = json!(self.input.keep_person_id);
                            }
                            *id != self.input.keep_person_id || !std::mem::replace(&mut kept, true)
                        });
                    }
                }
            }
            for image in plan
                .get_mut("images")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                self.replace_person(image, "personId");
            }
        }
    }
}
