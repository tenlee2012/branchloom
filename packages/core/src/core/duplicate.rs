use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidate {
    pub left_person_id: String,
    pub right_person_id: String,
    pub score: i32,
    pub reasons: Vec<String>,
    pub conflicts: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum NameStrength {
    Honorific,
    Supporting,
    Identity,
}

#[derive(Clone, Debug)]
struct NameMatch {
    value: String,
    left_type: String,
    right_type: String,
    strength: NameStrength,
}

#[derive(Default)]
struct FamilySets {
    parents: BTreeSet<String>,
    partners: BTreeSet<String>,
    children: BTreeSet<String>,
}

pub fn score_duplicate_candidates(
    people: &[Value],
    relationships: &[Value],
    citations: &[Value],
    events: &[Value],
    places: &[Value],
    sources: &[Value],
) -> Vec<DuplicateCandidate> {
    let mut people = people
        .iter()
        .filter(|person| person.get("deletedAt").is_none_or(Value::is_null))
        .collect::<Vec<_>>();
    people.sort_by(|left, right| string(left, "id").cmp(&string(right, "id")));

    let person_names = people
        .iter()
        .filter_map(|person| Some((string(person, "id")?.to_owned(), primary_name(person))))
        .collect::<BTreeMap<_, _>>();
    let place_names = places
        .iter()
        .filter_map(|place| {
            Some((
                string(place, "id")?.to_owned(),
                string(place, "name")?.to_owned(),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    let source_names = sources
        .iter()
        .filter_map(|source| {
            Some((
                string(source, "id")?.to_owned(),
                string(source, "title")
                    .unwrap_or_else(|| string(source, "id").unwrap_or_default())
                    .to_owned(),
            ))
        })
        .collect::<BTreeMap<_, _>>();

    let mut candidates = Vec::new();
    for left_index in 0..people.len() {
        for right_index in (left_index + 1)..people.len() {
            let left = people[left_index];
            let right = people[right_index];
            if string(left, "projectId") != string(right, "projectId") {
                continue;
            }
            let (Some(left_id), Some(right_id)) = (string(left, "id"), string(right, "id")) else {
                continue;
            };

            let mut score = 0;
            let mut reasons = Vec::new();
            let mut conflicts = Vec::new();
            let mut has_identity_name = false;
            let mut has_supporting_name = false;
            let mut has_strong_corroboration = false;

            if let Some(name_match) = strongest_name_match(left, right) {
                match name_match.strength {
                    NameStrength::Identity => {
                        score += 30;
                        has_identity_name = true;
                        reasons.push(format!(
                            "{}：{}",
                            name_match_label(&name_match),
                            name_match.value
                        ));
                    }
                    NameStrength::Supporting => {
                        score += 12;
                        has_supporting_name = true;
                        reasons.push(format!(
                            "{}：{}",
                            name_match_label(&name_match),
                            name_match.value
                        ));
                    }
                    NameStrength::Honorific => {
                        // Reusable titles are observations, not identity evidence.
                    }
                }
            }

            compare_dates(
                left.get("birth"),
                right.get("birth"),
                "出生日期",
                14,
                20,
                &mut score,
                &mut reasons,
                &mut conflicts,
                &mut has_strong_corroboration,
            );
            compare_dates(
                left.get("death"),
                right.get("death"),
                "死亡日期",
                10,
                16,
                &mut score,
                &mut reasons,
                &mut conflicts,
                &mut has_strong_corroboration,
            );

            match (string(left, "sex"), string(right, "sex")) {
                (Some(left_sex), Some(right_sex))
                    if left_sex != "unknown" && left_sex == right_sex =>
                {
                    score += 6;
                    reasons.push(format!("性别相同：{left_sex}"));
                }
                (Some(left_sex), Some(right_sex))
                    if left_sex != "unknown" && right_sex != "unknown" && left_sex != right_sex =>
                {
                    score -= 12;
                    conflicts.push("性别记录不同".to_owned());
                }
                _ => {}
            }

            let left_family = family_sets(left_id, relationships);
            let right_family = family_sets(right_id, relationships);
            if equal_non_empty(&left_family.parents, &right_family.parents) {
                score += 12;
                has_strong_corroboration = true;
                reasons.push(format!(
                    "父母相同：{}",
                    evidence_names(&left_family.parents, &person_names)
                ));
            } else if disjoint_non_empty(&left_family.parents, &right_family.parents) {
                score -= 12;
                conflicts.push("已知父母记录不同".to_owned());
            }
            if equal_non_empty(&left_family.partners, &right_family.partners) {
                score += 8;
                has_strong_corroboration = true;
                reasons.push(format!(
                    "伴侣相同：{}",
                    evidence_names(&left_family.partners, &person_names)
                ));
            }
            if equal_non_empty(&left_family.children, &right_family.children) {
                score += 10;
                has_strong_corroboration = true;
                reasons.push(format!(
                    "子女相同：{}",
                    evidence_names(&left_family.children, &person_names)
                ));
            }

            let shared_citations = citation_keys(left_id, citations)
                .intersection(&citation_keys(right_id, citations))
                .cloned()
                .collect::<Vec<_>>();
            if !shared_citations.is_empty() {
                score += 6;
                reasons.push(format!(
                    "来源定位相同：{}",
                    shared_citations
                        .iter()
                        .map(|(source_id, locator)| format!(
                            "{}（{}）",
                            source_names
                                .get(source_id)
                                .map(String::as_str)
                                .unwrap_or(source_id),
                            locator
                        ))
                        .collect::<Vec<_>>()
                        .join("、")
                ));
            }

            let shared_events = events
                .iter()
                .filter(|event| {
                    strings(event, "participantIds").contains(left_id)
                        && strings(event, "participantIds").contains(right_id)
                })
                .collect::<Vec<_>>();
            if !shared_events.is_empty() {
                score += 8;
                reasons.push(format!(
                    "共同事件：{}",
                    shared_events
                        .iter()
                        .filter_map(|event| string(event, "title").or_else(|| string(event, "id")))
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect::<Vec<_>>()
                        .join("、")
                ));
            }

            let shared_places = person_places(left, left_id, events)
                .intersection(&person_places(right, right_id, events))
                .cloned()
                .collect::<Vec<_>>();
            if !shared_places.is_empty() {
                score += 8;
                reasons.push(format!(
                    "地点相同：{}",
                    shared_places
                        .iter()
                        .map(|id| place_names.get(id).map(String::as_str).unwrap_or(id))
                        .collect::<Vec<_>>()
                        .join("、")
                ));
            }

            score = score.max(0);
            let has_name_gate =
                has_identity_name || (has_supporting_name && has_strong_corroboration);
            if (has_name_gate && score >= 25) || (!has_name_gate && score >= 45) {
                candidates.push(DuplicateCandidate {
                    left_person_id: left_id.to_owned(),
                    right_person_id: right_id.to_owned(),
                    score,
                    reasons,
                    conflicts,
                });
            }
        }
    }

    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.left_person_id.cmp(&right.left_person_id))
            .then_with(|| left.right_person_id.cmp(&right.right_person_id))
    });
    candidates
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn strings<'a>(value: &'a Value, key: &str) -> BTreeSet<&'a str> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn primary_name(person: &Value) -> String {
    person
        .get("names")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|name| name.get("primary").and_then(Value::as_bool) == Some(true))
        .or_else(|| {
            person
                .get("names")
                .and_then(Value::as_array)
                .and_then(|names| names.first())
        })
        .and_then(|name| string(name, "value"))
        .unwrap_or_else(|| string(person, "id").unwrap_or_default())
        .to_owned()
}

fn name_strength(name_type: &str) -> NameStrength {
    match name_type {
        "personal" | "former" | "alias" | "childhood" => NameStrength::Identity,
        "honorific" => NameStrength::Honorific,
        _ => NameStrength::Supporting,
    }
}

fn strongest_name_match(left: &Value, right: &Value) -> Option<NameMatch> {
    let left_names = left.get("names")?.as_array()?;
    let right_names = right.get("names")?.as_array()?;
    let mut matches = Vec::new();
    for left_name in left_names {
        let Some(value) = string(left_name, "value").filter(|value| !value.is_empty()) else {
            continue;
        };
        let left_type = string(left_name, "type").unwrap_or("custom");
        for right_name in right_names {
            if string(right_name, "value") != Some(value) {
                continue;
            }
            let right_type = string(right_name, "type").unwrap_or("custom");
            matches.push(NameMatch {
                value: value.to_owned(),
                left_type: left_type.to_owned(),
                right_type: right_type.to_owned(),
                strength: name_strength(left_type).min(name_strength(right_type)),
            });
        }
    }
    matches.into_iter().max_by(|left, right| {
        left.strength
            .cmp(&right.strength)
            .then_with(|| right.value.cmp(&left.value))
    })
}

fn name_match_label(name_match: &NameMatch) -> &'static str {
    let types = [
        name_match.left_type.as_str(),
        name_match.right_type.as_str(),
    ];
    if types.contains(&"personal") {
        "本名相同"
    } else if types.contains(&"former") {
        "旧名相同"
    } else if types.contains(&"alias") {
        "别名相同"
    } else if types.contains(&"childhood") {
        "幼名相同"
    } else if types.contains(&"courtesy") {
        "字相同"
    } else if types.contains(&"temple") {
        "庙号相同"
    } else if types.contains(&"posthumous") {
        "谥号相同"
    } else {
        "其他名称相同"
    }
}

fn normalized_label(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .filter(|character| {
            !character.is_whitespace()
                && !matches!(
                    character,
                    '·' | '・' | '.' | ',' | '，' | '。' | '\'' | '’' | '-'
                )
        })
        .collect()
}

fn date_key(date: Option<&Value>) -> Option<String> {
    let date = date?;
    let precision = string(date, "precision")?;
    let start = string(date, "start").unwrap_or_default();
    let end = string(date, "end").unwrap_or_default();
    let display = string(date, "display").unwrap_or_default();
    let normalized = normalized_label(display);
    if precision == "unknown"
        || (start.is_empty()
            && end.is_empty()
            && matches!(normalized.as_str(), "未知" | "年代不详" | "unknown"))
    {
        return None;
    }
    Some(format!("{precision}\0{start}\0{end}\0{normalized}"))
}

#[allow(clippy::too_many_arguments)]
fn compare_dates(
    left: Option<&Value>,
    right: Option<&Value>,
    label: &str,
    match_score: i32,
    conflict_score: i32,
    score: &mut i32,
    reasons: &mut Vec<String>,
    conflicts: &mut Vec<String>,
    has_strong_corroboration: &mut bool,
) {
    let (Some(left_key), Some(right_key)) = (date_key(left), date_key(right)) else {
        return;
    };
    match left_key.cmp(&right_key) {
        Ordering::Equal => {
            *score += match_score;
            *has_strong_corroboration = true;
            let display = left
                .and_then(|date| string(date, "display").or_else(|| string(date, "start")))
                .unwrap_or("未知");
            reasons.push(format!("{label}相同：{display}"));
        }
        Ordering::Less | Ordering::Greater
            if left.and_then(|date| string(date, "precision")) == Some("exact")
                && right.and_then(|date| string(date, "precision")) == Some("exact") =>
        {
            *score -= conflict_score;
            conflicts.push(format!("{label}记录不同"));
        }
        _ => {}
    }
}

fn family_sets(person_id: &str, relationships: &[Value]) -> FamilySets {
    let mut family = FamilySets::default();
    for relationship in relationships {
        let from = string(relationship, "fromPersonId");
        let to = string(relationship, "toPersonId");
        if string(relationship, "category") == Some("parent") {
            if to == Some(person_id) {
                if let Some(from) = from {
                    family.parents.insert(from.to_owned());
                }
            }
            if from == Some(person_id) {
                if let Some(to) = to {
                    family.children.insert(to.to_owned());
                }
            }
        } else if from == Some(person_id) {
            if let Some(to) = to {
                family.partners.insert(to.to_owned());
            }
        } else if to == Some(person_id) {
            if let Some(from) = from {
                family.partners.insert(from.to_owned());
            }
        }
    }
    family
}

fn equal_non_empty(left: &BTreeSet<String>, right: &BTreeSet<String>) -> bool {
    !left.is_empty() && left == right
}

fn disjoint_non_empty(left: &BTreeSet<String>, right: &BTreeSet<String>) -> bool {
    !left.is_empty() && !right.is_empty() && left.is_disjoint(right)
}

fn evidence_names(ids: &BTreeSet<String>, names: &BTreeMap<String, String>) -> String {
    ids.iter()
        .map(|id| names.get(id).map(String::as_str).unwrap_or(id))
        .collect::<Vec<_>>()
        .join("、")
}

fn citation_keys(person_id: &str, citations: &[Value]) -> BTreeSet<(String, String)> {
    citations
        .iter()
        .filter(|citation| {
            string(citation, "targetType") == Some("person")
                && string(citation, "targetId") == Some(person_id)
        })
        .filter_map(|citation| {
            let source_id = string(citation, "sourceId")?;
            let locator = string(citation, "locator")?.trim();
            (!locator.is_empty()).then(|| (source_id.to_owned(), locator.to_owned()))
        })
        .collect()
}

fn person_places(person: &Value, person_id: &str, events: &[Value]) -> BTreeSet<String> {
    let mut places = [
        string(person, "birthPlaceId"),
        string(person, "deathPlaceId"),
    ]
    .into_iter()
    .flatten()
    .map(str::to_owned)
    .collect::<BTreeSet<_>>();
    for event in events {
        if strings(event, "participantIds").contains(person_id) {
            if let Some(place_id) = string(event, "placeId") {
                places.insert(place_id.to_owned());
            }
        }
    }
    places
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn person(id: &str, name: &str, name_type: &str) -> Value {
        json!({
            "id": id,
            "projectId": "project-test",
            "names": [{ "value": name, "type": name_type, "primary": true }],
            "sex": "male",
            "status": "deceased"
        })
    }

    #[test]
    fn reusable_honorifics_never_create_candidates() {
        let mut kai = person("zhao-kai", "赵楷", "personal");
        kai["names"].as_array_mut().unwrap().push(json!({
            "value": "郓王", "type": "honorific", "primary": false
        }));
        let mut gong = person("zhao-gong", "赵栱", "personal");
        gong["names"].as_array_mut().unwrap().push(json!({
            "value": "郓王", "type": "honorific", "primary": false
        }));
        let parent = person("zhao-ji", "赵佶", "personal");
        let mut mao = person("zhao-mao", "赵茂", "personal");
        mao["names"].as_array_mut().unwrap().push(json!({
            "value": "越王", "type": "honorific", "primary": false
        }));
        let mut si = person("zhao-si", "赵偲", "personal");
        si["names"].as_array_mut().unwrap().push(json!({
            "value": "越王", "type": "honorific", "primary": false
        }));
        let mut wei = person("zhao-wei", "赵伟", "personal");
        wei["names"].as_array_mut().unwrap().push(json!({
            "value": "仪王", "type": "honorific", "primary": false
        }));
        let mut pu = person("zhao-pu", "赵朴", "personal");
        pu["names"].as_array_mut().unwrap().push(json!({
            "value": "仪王", "type": "honorific", "primary": false
        }));
        let relationships = vec![
            json!({ "category": "parent", "fromPersonId": "zhao-ji", "toPersonId": "zhao-kai" }),
            json!({ "category": "parent", "fromPersonId": "zhao-ji", "toPersonId": "zhao-gong" }),
        ];
        let citations = vec![
            json!({ "targetType": "person", "targetId": "zhao-mao", "sourceId": "song-history", "locator": "" }),
            json!({ "targetType": "person", "targetId": "zhao-si", "sourceId": "song-history", "locator": "" }),
        ];

        assert!(score_duplicate_candidates(
            &[kai, gong, parent, mao, si, wei, pu],
            &relationships,
            &citations,
            &[],
            &[],
            &[],
        )
        .is_empty());
    }

    #[test]
    fn identity_name_and_independent_evidence_create_an_explainable_candidate() {
        let mut left = person("person-a", "林晨", "personal");
        let mut right = person("person-b", "林晨", "personal");
        left["birth"] =
            json!({ "display": "1988-04-12", "precision": "exact", "start": "1988-04-12" });
        right["birth"] = left["birth"].clone();
        let parent = person("parent", "林海", "personal");
        let relationships = vec![
            json!({ "category": "parent", "fromPersonId": "parent", "toPersonId": "person-a" }),
            json!({ "category": "parent", "fromPersonId": "parent", "toPersonId": "person-b" }),
        ];

        let candidates =
            score_duplicate_candidates(&[left, right, parent], &relationships, &[], &[], &[], &[]);

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].score, 62);
        assert_eq!(
            candidates[0].reasons,
            [
                "本名相同：林晨",
                "出生日期相同：1988-04-12",
                "性别相同：male",
                "父母相同：林海",
            ]
        );
        assert!(candidates[0].conflicts.is_empty());
    }

    #[test]
    fn shared_source_requires_the_same_non_empty_locator() {
        let people = vec![
            person("person-a", "林晨", "personal"),
            person("person-b", "林晨", "personal"),
        ];
        let source = json!({ "id": "source-book", "title": "族谱" });
        let different_locations = vec![
            json!({ "targetType": "person", "targetId": "person-a", "sourceId": "source-book", "locator": "卷一" }),
            json!({ "targetType": "person", "targetId": "person-b", "sourceId": "source-book", "locator": "卷二" }),
        ];
        let same_locations = vec![
            json!({ "targetType": "person", "targetId": "person-a", "sourceId": "source-book", "locator": "卷一" }),
            json!({ "targetType": "person", "targetId": "person-b", "sourceId": "source-book", "locator": "卷一" }),
        ];

        let without_locator_match = score_duplicate_candidates(
            &people,
            &[],
            &different_locations,
            &[],
            &[],
            std::slice::from_ref(&source),
        );
        let with_locator_match =
            score_duplicate_candidates(&people, &[], &same_locations, &[], &[], &[source]);

        assert_eq!(without_locator_match[0].score, 36);
        assert_eq!(with_locator_match[0].score, 42);
        assert!(with_locator_match[0]
            .reasons
            .contains(&"来源定位相同：族谱（卷一）".to_owned()));
    }

    #[test]
    fn exact_date_and_parent_conflicts_reduce_false_matches() {
        let mut left = person("person-a", "同名", "personal");
        let mut right = person("person-b", "同名", "personal");
        left["birth"] = json!({ "display": "1900", "precision": "exact", "start": "1900" });
        right["birth"] = json!({ "display": "1910", "precision": "exact", "start": "1910" });
        let parent_a = person("parent-a", "甲父", "personal");
        let parent_b = person("parent-b", "乙父", "personal");
        let relationships = vec![
            json!({ "category": "parent", "fromPersonId": "parent-a", "toPersonId": "person-a" }),
            json!({ "category": "parent", "fromPersonId": "parent-b", "toPersonId": "person-b" }),
        ];

        assert!(score_duplicate_candidates(
            &[left, right, parent_a, parent_b],
            &relationships,
            &[],
            &[],
            &[],
            &[],
        )
        .is_empty());
    }

    #[test]
    fn supporting_names_need_strong_corroboration() {
        let temple_only = vec![
            person("person-a", "宋太祖", "temple"),
            person("person-b", "宋太祖", "temple"),
        ];
        assert!(score_duplicate_candidates(&temple_only, &[], &[], &[], &[], &[]).is_empty());

        let mut left = temple_only[0].clone();
        let mut right = temple_only[1].clone();
        left["birth"] = json!({ "display": "927", "precision": "exact", "start": "927" });
        right["birth"] = left["birth"].clone();
        assert_eq!(
            score_duplicate_candidates(&[left, right], &[], &[], &[], &[], &[]).len(),
            1
        );
    }
}
