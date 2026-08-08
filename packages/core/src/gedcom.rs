use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::core::error::{CoreError, CoreResult};
use crate::project_format::{ProjectData, PROJECT_COLLECTIONS};

pub const GEDCOM_EXTENSION: &str = "ged";
const MAX_GEDCOM_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GedcomSummary {
    pub people: usize,
    pub relationships: usize,
    pub places: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GedcomImport {
    pub data: ProjectData,
    pub summary: GedcomSummary,
}

#[derive(Clone, Debug)]
struct GedcomNode {
    xref: Option<String>,
    tag: String,
    value: String,
    children: Vec<GedcomNode>,
}

#[derive(Clone, Debug)]
struct FlatLine {
    level: usize,
    xref: Option<String>,
    tag: String,
    value: String,
}

pub fn read_gedcom(path: &Path) -> CoreResult<GedcomImport> {
    validate_gedcom_path(path)?;
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(CoreError::Validation(
            "GEDCOM source must be a file".to_owned(),
        ));
    }
    if metadata.len() > MAX_GEDCOM_BYTES {
        return Err(CoreError::Validation(format!(
            "GEDCOM file exceeds the supported size of {} MiB",
            MAX_GEDCOM_BYTES / 1024 / 1024
        )));
    }
    let bytes = fs::read(path)?;
    let fallback_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("导入的家谱");
    parse_gedcom(&bytes, fallback_name)
}

pub fn parse_gedcom(bytes: &[u8], fallback_name: &str) -> CoreResult<GedcomImport> {
    if bytes.len() as u64 > MAX_GEDCOM_BYTES {
        return Err(CoreError::Validation(format!(
            "GEDCOM file exceeds the supported size of {} MiB",
            MAX_GEDCOM_BYTES / 1024 / 1024
        )));
    }
    let text = decode_gedcom(bytes)?;
    let roots = parse_nodes(&text)?;
    let head = roots
        .iter()
        .find(|node| node.tag == "HEAD")
        .ok_or_else(|| CoreError::Validation("GEDCOM HEAD record is missing".to_owned()))?;
    validate_header(head)?;

    let external_project_id =
        child_value(head, "_BRANCHLOOM_PROJECT_ID").filter(|value| valid_identifier(value));
    let project_id = external_project_id
        .map(str::to_owned)
        .unwrap_or_else(|| deterministic_id("project", bytes));
    let project_name = imported_project_name(head, fallback_name);
    let timestamp = OffsetDateTime::now_utc().format(&Rfc3339)?;

    let individuals = roots
        .iter()
        .filter(|node| node.tag == "INDI")
        .collect::<Vec<_>>();
    if individuals.is_empty() {
        return Err(CoreError::Validation(
            "GEDCOM file does not contain any INDI records".to_owned(),
        ));
    }

    let mut warnings = Vec::new();
    let mut xref_to_person = BTreeMap::new();
    for individual in &individuals {
        let Some(xref) = individual.xref.as_deref() else {
            return Err(CoreError::Validation(
                "GEDCOM INDI record is missing an xref".to_owned(),
            ));
        };
        if xref_to_person.contains_key(xref) {
            return Err(CoreError::Validation(format!(
                "duplicate GEDCOM INDI xref: @{xref}@"
            )));
        }
        let branchloom_id = child_value(individual, "_BRANCHLOOM_ID")
            .filter(|value| valid_identifier(value))
            .map(str::to_owned)
            .unwrap_or_else(|| {
                deterministic_id("person", format!("{project_id}:{xref}").as_bytes())
            });
        xref_to_person.insert(xref.to_owned(), branchloom_id);
    }

    let mut places_by_name = BTreeMap::<String, String>::new();
    let mut people = Vec::new();
    let mut family_memberships = BTreeMap::<String, Vec<(String, String)>>::new();
    for individual in individuals {
        let xref = individual.xref.as_deref().expect("INDI xref validated");
        let person_id = xref_to_person
            .get(xref)
            .expect("person id assigned")
            .clone();
        let mut names = individual
            .children
            .iter()
            .filter(|node| node.tag == "NAME")
            .filter_map(parse_name)
            .collect::<Vec<_>>();
        if names.is_empty() {
            names.push(json!({
                "value": format!("未命名人物 {xref}"),
                "type": "personal",
                "primary": true,
                "notes": "原 GEDCOM 记录没有可读取的姓名"
            }));
            warnings.push(format!("人物 @{xref}@ 没有姓名，已使用占位名称"));
        } else {
            for (index, name) in names.iter_mut().enumerate() {
                name["primary"] = json!(index == 0);
            }
            deduplicate_names(&mut names);
        }

        let birth_node = child(individual, "BIRT");
        let death_node = child(individual, "DEAT");
        let mut person = Map::new();
        person.insert("id".to_owned(), json!(person_id));
        person.insert("projectId".to_owned(), json!(project_id));
        person.insert("names".to_owned(), Value::Array(names));
        person.insert(
            "sex".to_owned(),
            json!(parse_sex(child_value(individual, "SEX"))),
        );
        person.insert(
            "status".to_owned(),
            json!(if death_node.is_some() {
                "deceased"
            } else {
                "unknown"
            }),
        );
        person.insert("biography".to_owned(), json!(""));
        person.insert("notes".to_owned(), json!(collect_notes(individual)));
        person.insert("sourceIds".to_owned(), json!([]));
        person.insert("updatedAt".to_owned(), json!(timestamp));
        if let Some(date) = birth_node.and_then(event_date) {
            person.insert("birth".to_owned(), date);
        }
        if let Some(date) = death_node.and_then(event_date) {
            person.insert("death".to_owned(), date);
        }
        if let Some(place) = birth_node.and_then(event_place) {
            let id = place_id(&project_id, place, &mut places_by_name);
            person.insert("birthPlaceId".to_owned(), json!(id));
        }
        if let Some(place) = death_node.and_then(event_place) {
            let id = place_id(&project_id, place, &mut places_by_name);
            person.insert("deathPlaceId".to_owned(), json!(id));
        }
        for membership in individual.children.iter().filter(|node| node.tag == "FAMC") {
            if let Some(family_xref) = pointer(&membership.value) {
                let pedigree = child_value(membership, "PEDI")
                    .unwrap_or("birth")
                    .to_ascii_lowercase();
                family_memberships
                    .entry(family_xref.to_owned())
                    .or_default()
                    .push((person_id.clone(), pedigree));
            }
        }
        people.push(Value::Object(person));
    }

    let mut relationships = Vec::new();
    let mut seen_relationships = BTreeSet::new();
    for family in roots.iter().filter(|node| node.tag == "FAM") {
        let family_xref = family.xref.as_deref().unwrap_or("FAM");
        let parents = family
            .children
            .iter()
            .filter(|node| matches!(node.tag.as_str(), "HUSB" | "WIFE"))
            .filter_map(|node| pointer(&node.value))
            .filter_map(|xref| {
                let person = xref_to_person.get(xref);
                if person.is_none() {
                    warnings.push(format!("家庭 @{family_xref}@ 引用了不存在的人物 @{xref}@"));
                }
                person.cloned()
            })
            .collect::<Vec<_>>();
        let mut children = family
            .children
            .iter()
            .filter(|node| node.tag == "CHIL")
            .filter_map(|node| pointer(&node.value))
            .filter_map(|xref| xref_to_person.get(xref).cloned())
            .map(|person_id| (person_id, "birth".to_owned()))
            .collect::<Vec<_>>();
        if let Some(memberships) = family_memberships.get(family_xref) {
            for membership in memberships {
                if let Some(existing) = children.iter_mut().find(|item| item.0 == membership.0) {
                    existing.1 = membership.1.clone();
                } else {
                    children.push(membership.clone());
                }
            }
        }

        for parent_id in &parents {
            for (child_id, pedigree) in &children {
                let relationship_type = match pedigree.as_str() {
                    "adopted" | "adoptive" => "adoptive",
                    "foster" | "guardian" => "guardian",
                    "step" => "step",
                    _ => "biological",
                };
                let key = format!("parent:{parent_id}:{child_id}:{relationship_type}");
                if seen_relationships.insert(key.clone()) {
                    relationships.push(json!({
                        "id": deterministic_id("relationship", format!("{project_id}:{key}").as_bytes()),
                        "projectId": project_id,
                        "fromPersonId": parent_id,
                        "toPersonId": child_id,
                        "category": "parent",
                        "type": relationship_type,
                        "notes": "",
                        "sourceIds": []
                    }));
                }
            }
        }

        if parents.len() >= 2 {
            if parents.len() > 2 {
                warnings.push(format!(
                    "家庭 @{family_xref}@ 包含超过两位伴侣，首版仅导入前两位的伴侣关系"
                ));
            }
            let marriage = child(family, "MARR");
            let divorce = child(family, "DIV");
            let relationship_type = if divorce.is_some() {
                "divorced"
            } else if marriage.is_some() {
                "married"
            } else {
                "partner"
            };
            let mut relationship = Map::new();
            let key = format!("partner:{}:{}", parents[0], parents[1]);
            relationship.insert(
                "id".to_owned(),
                json!(deterministic_id(
                    "relationship",
                    format!("{project_id}:{key}").as_bytes()
                )),
            );
            relationship.insert("projectId".to_owned(), json!(project_id));
            relationship.insert("fromPersonId".to_owned(), json!(parents[0]));
            relationship.insert("toPersonId".to_owned(), json!(parents[1]));
            relationship.insert("category".to_owned(), json!("partner"));
            relationship.insert("type".to_owned(), json!(relationship_type));
            relationship.insert("notes".to_owned(), json!(collect_notes(family)));
            relationship.insert("sourceIds".to_owned(), json!([]));
            if let Some(date) = marriage.and_then(event_date) {
                relationship.insert("start".to_owned(), date);
            }
            if let Some(date) = divorce.and_then(event_date) {
                relationship.insert("end".to_owned(), date);
            }
            if let Some(place) = marriage.and_then(event_place) {
                let id = place_id(&project_id, place, &mut places_by_name);
                relationship.insert("placeId".to_owned(), json!(id));
            }
            relationships.push(Value::Object(relationship));
        }
    }

    let places = places_by_name
        .into_iter()
        .map(|(name, id)| {
            json!({
                "id": id,
                "projectId": project_id,
                "name": name,
                "aliases": [],
                "notes": ""
            })
        })
        .collect::<Vec<_>>();
    let mut collections = PROJECT_COLLECTIONS
        .iter()
        .map(|(collection, _, _)| ((*collection).to_owned(), Vec::new()))
        .collect::<BTreeMap<_, _>>();
    collections.insert("people".to_owned(), people);
    collections.insert("relationships".to_owned(), relationships);
    collections.insert("places".to_owned(), places);
    let data = ProjectData {
        project: json!({
            "id": project_id,
            "name": project_name,
            "description": "从 GEDCOM 文件导入",
            "createdAt": timestamp,
            "updatedAt": timestamp
        }),
        collections,
    };
    data.validate()?;
    let summary = GedcomSummary {
        people: data.collections["people"].len(),
        relationships: data.collections["relationships"].len(),
        places: data.collections["places"].len(),
        warnings,
    };
    Ok(GedcomImport { data, summary })
}

pub fn export_gedcom(data: &ProjectData) -> CoreResult<String> {
    data.validate()?;
    let project_id = data.project_id()?;
    let project_name = data.project["name"]
        .as_str()
        .unwrap_or("Branchloom Project");
    let people = &data.collections["people"];
    let relationships = &data.collections["relationships"];
    let places = data.collections["places"]
        .iter()
        .filter_map(|place| {
            Some((
                place["id"].as_str()?.to_owned(),
                place["name"].as_str()?.to_owned(),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    let person_xrefs = people
        .iter()
        .enumerate()
        .filter_map(|(index, person)| {
            Some((person["id"].as_str()?.to_owned(), format!("I{}", index + 1)))
        })
        .collect::<BTreeMap<_, _>>();
    let mut lines = vec![
        "0 HEAD".to_owned(),
        "1 SOUR BRANCHLOOM".to_owned(),
        format!("2 NAME {}", escape_text(project_name)),
        "1 GEDC".to_owned(),
        "2 VERS 5.5.1".to_owned(),
        "2 FORM LINEAGE-LINKED".to_owned(),
        "1 CHAR UTF-8".to_owned(),
        format!("1 _BRANCHLOOM_PROJECT_ID {project_id}"),
    ];

    let family_records = export_families(relationships, &person_xrefs, &places)?;
    let person_families = family_records.person_families;
    for person in people {
        let person_id = required_string(person, "id")?;
        let Some(xref) = person_xrefs.get(person_id) else {
            continue;
        };
        lines.push(format!("0 @{xref}@ INDI"));
        lines.push(format!("1 _BRANCHLOOM_ID {person_id}"));
        let names = person["names"].as_array().cloned().unwrap_or_default();
        if names.is_empty() {
            lines.push("1 NAME 未命名人物".to_owned());
        }
        for name in names {
            let value = name["value"].as_str().unwrap_or("未命名人物");
            let given = name["givenName"].as_str();
            let family = name["familyName"].as_str();
            let gedcom_name = match (given, family) {
                (Some(given), Some(family)) => {
                    format!("{} /{}/", escape_text(given), escape_text(family))
                }
                (None, Some(family)) => format!("/{}/", escape_text(family)),
                _ => escape_text(value),
            };
            lines.push(format!("1 NAME {gedcom_name}"));
            if let Some(given) = given {
                lines.push(format!("2 GIVN {}", escape_text(given)));
            }
            if let Some(family) = family {
                lines.push(format!("2 SURN {}", escape_text(family)));
            }
            if let Some(name_type) = name["type"].as_str() {
                lines.push(format!("2 TYPE {}", gedcom_name_type(name_type)));
            }
        }
        lines.push(format!("1 SEX {}", export_sex(person["sex"].as_str())));
        append_event(
            &mut lines,
            "BIRT",
            person.get("birth"),
            person.get("birthPlaceId").and_then(Value::as_str),
            &places,
        );
        append_event(
            &mut lines,
            "DEAT",
            person.get("death"),
            person.get("deathPlaceId").and_then(Value::as_str),
            &places,
        );
        append_note(&mut lines, 1, person["notes"].as_str().unwrap_or(""));
        if let Some(families) = person_families.get(person_id) {
            for (role, family_xref, pedigree) in families {
                lines.push(format!("1 {role} @{family_xref}@"));
                if role == "FAMC" && pedigree != "birth" {
                    lines.push(format!("2 PEDI {pedigree}"));
                }
            }
        }
    }
    lines.extend(family_records.lines);
    lines.push("0 TRLR".to_owned());
    Ok(format!("{}\r\n", lines.join("\r\n")))
}

struct ExportFamilies {
    lines: Vec<String>,
    person_families: BTreeMap<String, Vec<(String, String, String)>>,
}

fn export_families(
    relationships: &[Value],
    person_xrefs: &BTreeMap<String, String>,
    places: &BTreeMap<String, String>,
) -> CoreResult<ExportFamilies> {
    let partner_relationships = relationships
        .iter()
        .filter(|relationship| relationship["category"] == "partner")
        .collect::<Vec<_>>();
    let mut partner_pairs = Vec::new();
    for partner in &partner_relationships {
        let mut pair = vec![
            required_string(partner, "fromPersonId")?.to_owned(),
            required_string(partner, "toPersonId")?.to_owned(),
        ];
        pair.sort();
        partner_pairs.push(pair);
    }
    partner_pairs.sort();
    partner_pairs.dedup();

    let mut parent_relationships = BTreeMap::<String, Vec<&Value>>::new();
    for relationship in relationships
        .iter()
        .filter(|relationship| relationship["category"] == "parent")
    {
        parent_relationships
            .entry(required_string(relationship, "toPersonId")?.to_owned())
            .or_default()
            .push(relationship);
    }
    let mut parent_groups = partner_pairs
        .iter()
        .cloned()
        .map(|pair| (pair, Vec::new()))
        .collect::<BTreeMap<Vec<String>, Vec<(&Value, String)>>>();
    for (child, child_relationships) in parent_relationships {
        let mut parents = child_relationships
            .iter()
            .filter_map(|relationship| relationship["fromPersonId"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        parents.sort();
        parents.dedup();
        let mut remaining = parents.iter().cloned().collect::<BTreeSet<_>>();
        let matching_pairs = partner_pairs
            .iter()
            .filter(|pair| pair.iter().all(|parent| remaining.contains(parent)))
            .cloned()
            .collect::<Vec<_>>();
        if matching_pairs.is_empty() && parents.len() == 2 {
            let representative = child_relationships
                .iter()
                .find(|relationship| relationship["type"] != "biological")
                .copied()
                .unwrap_or(child_relationships[0]);
            parent_groups
                .entry(parents.clone())
                .or_default()
                .push((representative, child.clone()));
            remaining.clear();
        } else {
            for pair in matching_pairs {
                let representative = child_relationships
                    .iter()
                    .find(|relationship| {
                        relationship["fromPersonId"]
                            .as_str()
                            .is_some_and(|parent| pair.iter().any(|id| id == parent))
                            && relationship["type"] != "biological"
                    })
                    .or_else(|| {
                        child_relationships.iter().find(|relationship| {
                            relationship["fromPersonId"]
                                .as_str()
                                .is_some_and(|parent| pair.iter().any(|id| id == parent))
                        })
                    })
                    .copied()
                    .expect("matching parent relationship exists");
                for parent in &pair {
                    remaining.remove(parent);
                }
                parent_groups
                    .entry(pair)
                    .or_default()
                    .push((representative, child.clone()));
            }
        }
        for parent in remaining {
            let representative = child_relationships
                .iter()
                .find(|relationship| relationship["fromPersonId"] == parent)
                .copied()
                .expect("remaining parent relationship exists");
            parent_groups
                .entry(vec![parent])
                .or_default()
                .push((representative, child.clone()));
        }
    }

    let mut lines = Vec::new();
    let mut person_families = BTreeMap::<String, Vec<(String, String, String)>>::new();
    let mut emitted_children = BTreeSet::new();
    let mut family_index = 0;
    for (parents, children) in parent_groups {
        if parents.iter().any(|id| !person_xrefs.contains_key(id)) {
            continue;
        }
        family_index += 1;
        let family_xref = format!("F{family_index}");
        lines.push(format!("0 @{family_xref}@ FAM"));
        for (index, parent) in parents.iter().take(2).enumerate() {
            let role = if index == 0 { "HUSB" } else { "WIFE" };
            lines.push(format!("1 {role} @{}@", person_xrefs[parent]));
            person_families.entry(parent.clone()).or_default().push((
                "FAMS".to_owned(),
                family_xref.clone(),
                "birth".to_owned(),
            ));
        }
        if parents.len() == 2 {
            if let Some(partner) = partner_relationships.iter().find(|relationship| {
                let from = relationship["fromPersonId"].as_str();
                let to = relationship["toPersonId"].as_str();
                from.is_some_and(|id| parents.contains(&id.to_owned()))
                    && to.is_some_and(|id| parents.contains(&id.to_owned()))
            }) {
                let relationship_type = partner["type"].as_str().unwrap_or("partner");
                if matches!(relationship_type, "married" | "divorced" | "separated") {
                    append_event(
                        &mut lines,
                        "MARR",
                        partner.get("start"),
                        partner.get("placeId").and_then(Value::as_str),
                        places,
                    );
                }
                if relationship_type == "divorced" {
                    append_event(&mut lines, "DIV", partner.get("end"), None, places);
                }
                append_note(&mut lines, 1, partner["notes"].as_str().unwrap_or(""));
            }
        }
        for (relationship, child) in children {
            if !person_xrefs.contains_key(&child)
                || !emitted_children.insert((family_xref.clone(), child.clone()))
            {
                continue;
            }
            lines.push(format!("1 CHIL @{}@", person_xrefs[&child]));
            let pedigree = match relationship["type"].as_str().unwrap_or("biological") {
                "adoptive" => "adopted",
                "guardian" => "foster",
                "step" => "step",
                _ => "birth",
            };
            person_families.entry(child).or_default().push((
                "FAMC".to_owned(),
                family_xref.clone(),
                pedigree.to_owned(),
            ));
        }
    }
    Ok(ExportFamilies {
        lines,
        person_families,
    })
}

fn parse_nodes(text: &str) -> CoreResult<Vec<GedcomNode>> {
    let mut lines = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let raw = raw.trim_end_matches('\r');
        if raw.trim().is_empty() {
            continue;
        }
        lines.push(parse_line(raw, index + 1)?);
    }
    if lines.is_empty() {
        return Err(CoreError::Validation("GEDCOM file is empty".to_owned()));
    }
    let mut index = 0;
    let mut roots = Vec::new();
    while index < lines.len() {
        if lines[index].level != 0 {
            return Err(CoreError::Validation(format!(
                "GEDCOM line must begin a level-0 record near {}",
                index + 1
            )));
        }
        roots.push(build_node(&lines, &mut index)?);
    }
    Ok(roots)
}

fn parse_line(raw: &str, line_number: usize) -> CoreResult<FlatLine> {
    let mut parts = raw.splitn(2, char::is_whitespace);
    let level = parts
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|level| *level <= 99)
        .ok_or_else(|| {
            CoreError::Validation(format!("invalid GEDCOM level at line {line_number}"))
        })?;
    let remainder = parts
        .next()
        .map(str::trim_start)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CoreError::Validation(format!("missing GEDCOM tag at line {line_number}"))
        })?;
    let tokens = remainder.splitn(3, char::is_whitespace).collect::<Vec<_>>();
    let (xref, tag, value) = if tokens[0].starts_with('@') && tokens[0].ends_with('@') {
        if tokens.len() < 2 {
            return Err(CoreError::Validation(format!(
                "missing GEDCOM tag at line {line_number}"
            )));
        }
        (
            Some(tokens[0].trim_matches('@').to_owned()),
            tokens[1].to_ascii_uppercase(),
            tokens.get(2).copied().unwrap_or("").to_owned(),
        )
    } else {
        (
            None,
            tokens[0].to_ascii_uppercase(),
            tokens
                .get(1)
                .map(|_| remainder[tokens[0].len()..].trim_start())
                .unwrap_or("")
                .to_owned(),
        )
    };
    Ok(FlatLine {
        level,
        xref,
        tag,
        value,
    })
}

fn build_node(lines: &[FlatLine], index: &mut usize) -> CoreResult<GedcomNode> {
    let line = lines[*index].clone();
    *index += 1;
    let mut children = Vec::new();
    while *index < lines.len() && lines[*index].level > line.level {
        if lines[*index].level != line.level + 1 {
            return Err(CoreError::Validation(format!(
                "GEDCOM level jumps from {} to {}",
                line.level, lines[*index].level
            )));
        }
        children.push(build_node(lines, index)?);
    }
    Ok(GedcomNode {
        xref: line.xref,
        tag: line.tag,
        value: line.value,
        children,
    })
}

fn validate_header(head: &GedcomNode) -> CoreResult<()> {
    let version = child(head, "GEDC").and_then(|gedc| child_value(gedc, "VERS"));
    if let Some(version) = version {
        if !matches!(version.trim(), "5.5" | "5.5.1" | "7.0") {
            return Err(CoreError::Validation(format!(
                "unsupported GEDCOM version: {version}; supported versions are 5.5, 5.5.1, and 7.0"
            )));
        }
    }
    if child_value(head, "CHAR").is_some_and(|encoding| encoding.eq_ignore_ascii_case("ANSEL")) {
        return Err(CoreError::Validation(
            "GEDCOM ANSEL encoding is not supported; export the file as UTF-8 or UTF-16".to_owned(),
        ));
    }
    Ok(())
}

fn decode_gedcom(bytes: &[u8]) -> CoreResult<String> {
    if bytes.starts_with(&[0xff, 0xfe]) {
        return decode_utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return decode_utf16(&bytes[2..], false);
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        CoreError::Validation(
            "GEDCOM text must use UTF-8 or UTF-16 encoding; ANSEL is not supported".to_owned(),
        )
    })
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> CoreResult<String> {
    if !bytes.len().is_multiple_of(2) {
        return Err(CoreError::Validation(
            "invalid UTF-16 GEDCOM byte length".to_owned(),
        ));
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| {
            if little_endian {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect::<Vec<_>>();
    String::from_utf16(&units)
        .map_err(|_| CoreError::Validation("invalid UTF-16 GEDCOM text".to_owned()))
}

fn imported_project_name(head: &GedcomNode, fallback: &str) -> String {
    let name = child(head, "SOUR")
        .and_then(|source| child_value(source, "NAME"))
        .or_else(|| child_value(head, "FILE"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.trim());
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".gedcom") {
        name[..name.len() - 7].to_owned()
    } else if lower.ends_with(".ged") {
        name[..name.len() - 4].to_owned()
    } else {
        name.to_owned()
    }
}

fn parse_name(node: &GedcomNode) -> Option<Value> {
    let (value_given, value_family) = split_gedcom_name(&node.value);
    let given = child_value(node, "GIVN").or(value_given.as_deref());
    let family = child_value(node, "SURN").or(value_family.as_deref());
    let value = if !node.value.trim().is_empty() {
        node.value
            .replace('/', "")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        [family, given]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("")
    };
    if value.trim().is_empty() {
        return None;
    }
    let mut name = Map::new();
    name.insert("value".to_owned(), json!(value.trim()));
    name.insert(
        "type".to_owned(),
        json!(import_name_type(child_value(node, "TYPE"))),
    );
    name.insert("primary".to_owned(), json!(false));
    if let Some(given) = given.filter(|value| !value.trim().is_empty()) {
        name.insert("givenName".to_owned(), json!(given.trim()));
    }
    if let Some(family) = family.filter(|value| !value.trim().is_empty()) {
        name.insert("familyName".to_owned(), json!(family.trim()));
    }
    Some(Value::Object(name))
}

fn split_gedcom_name(value: &str) -> (Option<String>, Option<String>) {
    let Some(first) = value.find('/') else {
        return (None, None);
    };
    let Some(second_offset) = value[first + 1..].find('/') else {
        return (None, None);
    };
    let second = first + 1 + second_offset;
    let given = value[..first].trim();
    let family = value[first + 1..second].trim();
    (
        (!given.is_empty()).then(|| given.to_owned()),
        (!family.is_empty()).then(|| family.to_owned()),
    )
}

fn deduplicate_names(names: &mut Vec<Value>) {
    let mut values = BTreeSet::new();
    names.retain(|name| {
        name["value"]
            .as_str()
            .is_some_and(|value| values.insert(value.trim().to_lowercase()))
    });
    for (index, name) in names.iter_mut().enumerate() {
        name["primary"] = json!(index == 0);
    }
}

fn import_name_type(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").to_ascii_lowercase().as_str() {
        "aka" | "alias" | "nickname" => "alias",
        "birth" | "maiden" => "former",
        "religious" => "religious",
        _ => "personal",
    }
}

fn gedcom_name_type(value: &str) -> &'static str {
    match value {
        "alias" | "childhood" => "aka",
        "former" => "birth",
        "religious" => "religious",
        _ => "birth",
    }
}

fn parse_sex(value: Option<&str>) -> &'static str {
    match value.unwrap_or("").trim().to_ascii_uppercase().as_str() {
        "M" => "male",
        "F" => "female",
        "X" | "N" => "nonbinary",
        _ => "unknown",
    }
}

fn export_sex(value: Option<&str>) -> &'static str {
    match value.unwrap_or("unknown") {
        "male" => "M",
        "female" => "F",
        "nonbinary" => "X",
        _ => "U",
    }
}

fn event_date(node: &GedcomNode) -> Option<Value> {
    child_value(node, "DATE").map(parse_date)
}

fn event_place(node: &GedcomNode) -> Option<&str> {
    child_value(node, "PLAC")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn parse_date(value: &str) -> Value {
    let original = value.trim();
    let upper = original.to_ascii_uppercase();
    let (precision, body) = if let Some(body) = upper
        .strip_prefix("ABT ")
        .or_else(|| upper.strip_prefix("CAL "))
        .or_else(|| upper.strip_prefix("EST "))
    {
        ("about", body)
    } else if let Some(body) = upper.strip_prefix("BEF ") {
        ("before", body)
    } else if let Some(body) = upper.strip_prefix("AFT ") {
        ("after", body)
    } else {
        ("exact", upper.as_str())
    };
    let mut date = Map::new();
    date.insert("display".to_owned(), json!(original));
    if let Some((left, right)) = body
        .strip_prefix("BET ")
        .and_then(|body| body.split_once(" AND "))
        .or_else(|| {
            body.strip_prefix("FROM ")
                .and_then(|body| body.split_once(" TO "))
        })
    {
        if let (Some(start), Some(end)) = (parse_simple_date(left), parse_simple_date(right)) {
            date.insert("start".to_owned(), json!(start));
            date.insert("end".to_owned(), json!(end));
            date.insert("precision".to_owned(), json!("range"));
            return Value::Object(date);
        }
    }
    if let Some(boundary) = parse_simple_date(body) {
        match precision {
            "before" => {
                date.insert("end".to_owned(), json!(boundary));
            }
            "after" => {
                date.insert("start".to_owned(), json!(boundary));
            }
            _ => {
                date.insert("start".to_owned(), json!(boundary));
                if precision == "exact" {
                    date.insert("end".to_owned(), json!(boundary));
                }
            }
        }
        date.insert("precision".to_owned(), json!(precision));
    } else {
        date.insert("precision".to_owned(), json!("unknown"));
    }
    Value::Object(date)
}

fn parse_simple_date(value: &str) -> Option<String> {
    let parts = value.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        [year] if valid_year(year) => Some((*year).to_owned()),
        [month, year] if month_number(month).is_some() && valid_year(year) => {
            Some(format!("{}-{}", year, month_number(month)?))
        }
        [day, month, year]
            if day
                .parse::<u8>()
                .ok()
                .is_some_and(|day| (1..=31).contains(&day))
                && month_number(month).is_some()
                && valid_year(year) =>
        {
            Some(format!(
                "{}-{}-{:02}",
                year,
                month_number(month)?,
                day.parse::<u8>().ok()?
            ))
        }
        _ => None,
    }
}

fn valid_year(value: &str) -> bool {
    (1..=4).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn month_number(value: &str) -> Option<&'static str> {
    match value {
        "JAN" => Some("01"),
        "FEB" => Some("02"),
        "MAR" => Some("03"),
        "APR" => Some("04"),
        "MAY" => Some("05"),
        "JUN" => Some("06"),
        "JUL" => Some("07"),
        "AUG" => Some("08"),
        "SEP" => Some("09"),
        "OCT" => Some("10"),
        "NOV" => Some("11"),
        "DEC" => Some("12"),
        _ => None,
    }
}

fn append_event(
    lines: &mut Vec<String>,
    tag: &str,
    date: Option<&Value>,
    place_id: Option<&str>,
    places: &BTreeMap<String, String>,
) {
    if date.is_none() && place_id.is_none() {
        return;
    }
    lines.push(format!("1 {tag}"));
    if let Some(date) = date.and_then(export_date) {
        lines.push(format!("2 DATE {date}"));
    }
    if let Some(place) = place_id.and_then(|id| places.get(id)) {
        lines.push(format!("2 PLAC {}", escape_text(place)));
    }
}

fn export_date(value: &Value) -> Option<String> {
    let precision = value["precision"].as_str().unwrap_or("unknown");
    let start = value["start"].as_str();
    let end = value["end"].as_str();
    match precision {
        "before" => end
            .and_then(iso_to_gedcom)
            .map(|date| format!("BEF {date}")),
        "after" => start
            .and_then(iso_to_gedcom)
            .map(|date| format!("AFT {date}")),
        "about" => start
            .or(end)
            .and_then(iso_to_gedcom)
            .map(|date| format!("ABT {date}")),
        "range" => Some(format!(
            "BET {} AND {}",
            iso_to_gedcom(start?)?,
            iso_to_gedcom(end?)?
        )),
        "exact" => start.or(end).and_then(iso_to_gedcom),
        _ => None,
    }
}

fn iso_to_gedcom(value: &str) -> Option<String> {
    let parts = value.split('-').collect::<Vec<_>>();
    match parts.as_slice() {
        [year] if valid_year(year) => Some((*year).to_owned()),
        [year, month] if valid_year(year) => Some(format!("{} {}", gedcom_month(month)?, year)),
        [year, month, day] if valid_year(year) => Some(format!(
            "{} {} {}",
            day.trim_start_matches('0'),
            gedcom_month(month)?,
            year
        )),
        _ => None,
    }
}

fn gedcom_month(value: &str) -> Option<&'static str> {
    match value {
        "01" => Some("JAN"),
        "02" => Some("FEB"),
        "03" => Some("MAR"),
        "04" => Some("APR"),
        "05" => Some("MAY"),
        "06" => Some("JUN"),
        "07" => Some("JUL"),
        "08" => Some("AUG"),
        "09" => Some("SEP"),
        "10" => Some("OCT"),
        "11" => Some("NOV"),
        "12" => Some("DEC"),
        _ => None,
    }
}

fn append_note(lines: &mut Vec<String>, level: usize, value: &str) {
    let mut values = value.lines();
    let Some(first) = values.next().filter(|line| !line.trim().is_empty()) else {
        return;
    };
    lines.push(format!("{level} NOTE {}", escape_text(first)));
    for line in values {
        lines.push(format!("{} CONT {}", level + 1, escape_text(line)));
    }
}

fn collect_notes(node: &GedcomNode) -> String {
    node.children
        .iter()
        .filter(|child| child.tag == "NOTE")
        .map(|note| {
            let mut value = note.value.clone();
            for continuation in &note.children {
                match continuation.tag.as_str() {
                    "CONT" => {
                        value.push('\n');
                        value.push_str(&continuation.value);
                    }
                    "CONC" => value.push_str(&continuation.value),
                    _ => {}
                }
            }
            value
        })
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn place_id(project_id: &str, name: &str, places: &mut BTreeMap<String, String>) -> String {
    places
        .entry(name.trim().to_owned())
        .or_insert_with(|| {
            deterministic_id("place", format!("{project_id}:{}", name.trim()).as_bytes())
        })
        .clone()
}

fn child<'a>(node: &'a GedcomNode, tag: &str) -> Option<&'a GedcomNode> {
    node.children.iter().find(|child| child.tag == tag)
}

fn child_value<'a>(node: &'a GedcomNode, tag: &str) -> Option<&'a str> {
    child(node, tag).map(|child| child.value.as_str())
}

fn pointer(value: &str) -> Option<&str> {
    value.strip_prefix('@')?.strip_suffix('@')
}

fn validate_gedcom_path(path: &Path) -> CoreResult<()> {
    if !path.is_absolute() {
        return Err(CoreError::Validation(
            "GEDCOM path must be absolute".to_owned(),
        ));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !matches!(extension.to_ascii_lowercase().as_str(), "ged" | "gedcom") {
        return Err(CoreError::Validation(
            "GEDCOM file must use .ged or .gedcom".to_owned(),
        ));
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn deterministic_id(prefix: &str, bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}-{hex}")
}

fn required_string<'a>(value: &'a Value, key: &str) -> CoreResult<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| CoreError::Validation(format!("{key} must be a string")))
}

fn escape_text(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAMILY: &str = "0 HEAD\n1 SOUR Family Tree\n2 NAME 示例家谱\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @I1@ INDI\n1 NAME Ming /Li/\n2 GIVN Ming\n2 SURN Li\n1 SEX M\n1 BIRT\n2 DATE 3 FEB 1950\n2 PLAC Beijing\n0 @I2@ INDI\n1 NAME Hua /Wang/\n1 SEX F\n0 @I3@ INDI\n1 NAME Xia /Li/\n1 FAMC @F1@\n2 PEDI adopted\n0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n1 MARR\n2 DATE ABT 1975\n2 PLAC Shanghai\n0 TRLR\n";

    #[test]
    fn imports_common_people_dates_places_and_family_links() {
        let imported = parse_gedcom(FAMILY.as_bytes(), "fallback").expect("parse GEDCOM");
        assert_eq!(imported.data.project["name"], "示例家谱");
        assert_eq!(imported.summary.people, 3);
        assert_eq!(imported.summary.relationships, 3);
        assert_eq!(imported.summary.places, 2);
        let people = &imported.data.collections["people"];
        assert_eq!(people[0]["names"][0]["value"], "Ming Li");
        assert_eq!(people[0]["birth"]["start"], "1950-02-03");
        let relationships = &imported.data.collections["relationships"];
        assert!(relationships
            .iter()
            .any(|item| item["category"] == "parent" && item["type"] == "adoptive"));
        assert!(relationships
            .iter()
            .any(|item| item["category"] == "partner" && item["type"] == "married"));
    }

    #[test]
    fn export_can_be_imported_with_stable_branchloom_ids() {
        let imported = parse_gedcom(FAMILY.as_bytes(), "fallback").expect("parse GEDCOM");
        let project_id = imported.data.project_id().expect("project id").to_owned();
        let person_ids = imported.data.collections["people"]
            .iter()
            .map(|person| person["id"].as_str().unwrap().to_owned())
            .collect::<BTreeSet<_>>();
        let encoded = export_gedcom(&imported.data).expect("export GEDCOM");
        assert_eq!(
            encoded
                .lines()
                .filter(|line| line.ends_with(" FAM"))
                .count(),
            1,
            "parents and their shared child should use one family record"
        );
        let decoded = parse_gedcom(encoded.as_bytes(), "round trip").expect("reimport GEDCOM");
        assert_eq!(decoded.data.project_id().unwrap(), project_id);
        assert_eq!(
            decoded.summary.relationships,
            imported.summary.relationships
        );
        assert_eq!(
            decoded.data.collections["people"]
                .iter()
                .map(|person| person["id"].as_str().unwrap().to_owned())
                .collect::<BTreeSet<_>>(),
            person_ids
        );
    }

    #[test]
    fn export_preserves_additional_parent_relationships_in_separate_families() {
        let mut imported = parse_gedcom(FAMILY.as_bytes(), "fallback").expect("parse GEDCOM");
        let project_id = imported.data.project_id().expect("project id").to_owned();
        let child_id = imported.data.collections["people"][2]["id"]
            .as_str()
            .expect("child id")
            .to_owned();
        imported
            .data
            .collections
            .get_mut("people")
            .expect("people collection")
            .push(json!({
            "id": "person-guardian",
            "projectId": project_id,
            "names": [{ "value": "Guardian", "type": "personal", "primary": true }],
            "sex": "unknown",
            "status": "unknown",
            "biography": "",
            "notes": "",
            "sourceIds": []
            }));
        imported
            .data
            .collections
            .get_mut("relationships")
            .expect("relationships collection")
            .push(json!({
            "id": "relationship-guardian",
            "projectId": project_id,
            "fromPersonId": "person-guardian",
            "toPersonId": child_id,
            "category": "parent",
            "type": "guardian",
            "notes": "",
            "sourceIds": []
            }));

        let encoded = export_gedcom(&imported.data).expect("export GEDCOM");
        let decoded = parse_gedcom(encoded.as_bytes(), "round trip").expect("reimport GEDCOM");
        assert_eq!(
            decoded.data.collections["relationships"]
                .iter()
                .filter(|relationship| relationship["category"] == "parent")
                .count(),
            3
        );
        assert!(decoded.data.collections["relationships"]
            .iter()
            .any(|relationship| relationship["type"] == "guardian"));
    }

    #[test]
    fn rejects_ansel_with_an_actionable_message() {
        let input = FAMILY.replace("1 CHAR UTF-8", "1 CHAR ANSEL");
        let error = parse_gedcom(input.as_bytes(), "family").expect_err("reject ANSEL");
        assert!(error.to_string().contains("ANSEL"));
    }

    #[test]
    fn parses_supported_date_qualifiers() {
        assert_eq!(parse_date("BEF 1900")["end"], "1900");
        assert_eq!(parse_date("AFT JAN 1900")["start"], "1900-01");
        assert_eq!(parse_date("BET 1900 AND 1902")["precision"], "range");
        assert_eq!(parse_date("民国三年")["precision"], "unknown");
    }
}
