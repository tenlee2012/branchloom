use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::Serialize;
use serde_json::Value;

use super::plan::{invalid, PublicationPlan, ScopeMode};
use crate::{core::error::CoreResult, project_format::ProjectData};

pub fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn records<'a>(data: &'a ProjectData, collection: &str) -> &'a [Value] {
    data.collections
        .get(collection)
        .map(Vec::as_slice)
        .unwrap_or_default()
}
pub fn name(person: &Value) -> String {
    let names = person.get("names").and_then(Value::as_array);
    names
        .and_then(|names| {
            names
                .iter()
                .find(|v| v["primary"] == true)
                .or_else(|| names.first())
        })
        .map(|v| string(v, "value"))
        .filter(|s| !s.is_empty())
        .unwrap_or("未命名人物")
        .to_owned()
}
pub fn relation_label(value: &Value) -> &'static str {
    match string(value, "type") {
        "biological" => "生育",
        "adoptive" => "收养",
        "step" => "继亲",
        "guardian" => "监护",
        "engaged" => "订婚",
        "married" => "婚姻",
        "partner" => "伴侣",
        "separated" => "分居",
        "divorced" => "离异",
        _ => "关系未明",
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub number: usize,
    pub generation: Option<i32>,
    pub branch: usize,
    pub page: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: String,
    pub message: String,
    pub target_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusion {
    pub id: String,
    pub reason: String,
}

pub struct Selection {
    pub entries: Vec<Entry>,
    pub excluded: Vec<Exclusion>,
    pub issues: Vec<Issue>,
    pub relationships: Vec<Value>,
    pub branches: usize,
}

pub fn select(data: &ProjectData, plan: &PublicationPlan) -> CoreResult<Selection> {
    let people: BTreeMap<_, _> = records(data, "people")
        .iter()
        .map(|p| (string(p, "id").to_owned(), p))
        .collect();
    for id in plan.scope.roots.iter().chain(&plan.scope.exclude) {
        if !people.contains_key(id) {
            return Err(invalid(format!("方案中的人物已不存在，请重新选择：{id}")));
        }
    }
    let relationships: Vec<_> = records(data, "relationships")
        .iter()
        .filter(|r| {
            string(r, "category") == "partner"
                || plan
                    .scope
                    .parent_types
                    .iter()
                    .any(|t| t == string(r, "type"))
        })
        .collect();
    let mut parents: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut children: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut partners: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in &relationships {
        let a = string(r, "fromPersonId").to_owned();
        let b = string(r, "toPersonId").to_owned();
        if !people.contains_key(&a) || !people.contains_key(&b) {
            return Err(invalid("关系引用了不存在的人物，请先检查资料"));
        }
        if string(r, "category") == "parent" {
            children.entry(a.clone()).or_default().push(b.clone());
            parents.entry(b).or_default().push(a);
        } else {
            partners.entry(a.clone()).or_default().push(b.clone());
            partners.entry(b).or_default().push(a);
        }
    }
    let mut selected = BTreeSet::new();
    let mut queue = VecDeque::new();
    if plan.scope.mode == ScopeMode::All {
        selected.extend(people.keys().cloned());
    } else {
        for id in &plan.scope.roots {
            if selected.insert(id.clone()) {
                queue.push_back((id.clone(), 1usize));
            }
        }
        let edges = if plan.scope.mode == ScopeMode::Ancestors {
            &parents
        } else {
            &children
        };
        while let Some((id, depth)) = queue.pop_front() {
            if plan.scope.generations.is_some_and(|max| depth >= max) {
                continue;
            }
            for next in edges.get(&id).into_iter().flatten() {
                if selected.insert(next.clone()) {
                    queue.push_back((next.clone(), depth + 1));
                }
            }
        }
        if plan.scope.partners {
            let direct: Vec<_> = selected
                .iter()
                .flat_map(|id| partners.get(id).into_iter().flatten())
                .cloned()
                .collect();
            selected.extend(direct);
        }
    }
    for id in &plan.scope.exclude {
        selected.remove(id);
    }
    if selected.is_empty() {
        return Err(invalid("所选范围没有人物，请调整范围或排除名单"));
    }
    let mut relationships: Vec<Value> = relationships
        .into_iter()
        .filter(|r| {
            selected.contains(string(r, "fromPersonId"))
                && selected.contains(string(r, "toPersonId"))
        })
        .cloned()
        .collect();
    relationships.sort_by(|a, b| string(a, "id").cmp(string(b, "id")));
    let mut adjacent: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in &relationships {
        let a = string(r, "fromPersonId").to_owned();
        let b = string(r, "toPersonId").to_owned();
        adjacent.entry(a.clone()).or_default().push(b.clone());
        adjacent.entry(b).or_default().push(a);
    }
    let mut branches = 0;
    let mut branch = BTreeMap::new();
    for id in &selected {
        if branch.contains_key(id) {
            continue;
        }
        branches += 1;
        branch.insert(id.clone(), branches);
        let mut pending = VecDeque::from([id.clone()]);
        while let Some(current) = pending.pop_front() {
            for next in adjacent.get(&current).into_iter().flatten() {
                if !branch.contains_key(next) {
                    branch.insert(next.clone(), branches);
                    pending.push_back(next.clone());
                }
            }
        }
    }
    // Determine relative generations without recursive traversal. A contradictory edge is retained,
    // but its component has no reliable absolute generation and is explicitly marked unknown.
    let mut constraints: BTreeMap<String, Vec<(String, i32)>> = BTreeMap::new();
    for r in &relationships {
        if string(r, "category") != "parent" {
            continue;
        }
        let a = string(r, "fromPersonId").to_owned();
        let b = string(r, "toPersonId").to_owned();
        constraints
            .entry(a.clone())
            .or_default()
            .push((b.clone(), 1));
        constraints.entry(b).or_default().push((a, -1));
    }
    let mut levels: BTreeMap<String, i32> = BTreeMap::new();
    let mut unreliable = BTreeSet::new();
    let mut issues = Vec::new();
    for seed in plan.scope.roots.iter().chain(selected.iter()) {
        if !selected.contains(seed) || levels.contains_key(seed) {
            continue;
        }
        let mut members = vec![seed.clone()];
        levels.insert(seed.clone(), 0);
        let mut pending = VecDeque::from([seed.clone()]);
        let mut conflict = false;
        while let Some(id) = pending.pop_front() {
            let current = levels[&id];
            for (next, delta) in constraints.get(&id).into_iter().flatten() {
                let expected = current + delta;
                if let Some(existing) = levels.get(next) {
                    conflict |= *existing != expected;
                } else {
                    levels.insert(next.clone(), expected);
                    members.push(next.clone());
                    pending.push_back(next.clone());
                }
            }
        }
        let offset = if plan.scope.roots.contains(seed) {
            plan.scope.start_generation
        } else {
            plan.scope.start_generation - members.iter().map(|id| levels[id]).min().unwrap_or(0)
        };
        for id in &members {
            *levels.get_mut(id).expect("visited member") += offset;
        }
        if conflict {
            unreliable.extend(members);
            issues.push(Issue {
                code: "generation-conflict".into(),
                message: "世代存在冲突、自关系或环，相关人物标为世代未定，保留全部关系供校对"
                    .into(),
                target_id: seed.clone(),
            });
        } else if members.len() == 1
            && !plan.scope.roots.contains(seed)
            && !constraints.contains_key(seed)
        {
            unreliable.insert(seed.clone());
            issues.push(Issue {
                code: "generation-unknown".into(),
                message: "没有可推导世代的亲子关系，标为世代未定；伴侣关系不作为同世依据".into(),
                target_id: seed.clone(),
            });
        }
    }
    let mut entries: Vec<_> = selected
        .iter()
        .map(|id| Entry {
            id: id.clone(),
            name: name(people[id]),
            number: 0,
            generation: if unreliable.contains(id) {
                None
            } else {
                levels.get(id).copied()
            },
            branch: branch[id],
            page: None,
        })
        .collect();
    entries.sort_by(|a, b| {
        (
            a.branch,
            a.generation.is_none(),
            a.generation,
            &a.name,
            &a.id,
        )
            .cmp(&(
                b.branch,
                b.generation.is_none(),
                b.generation,
                &b.name,
                &b.id,
            ))
    });
    for (i, entry) in entries.iter_mut().enumerate() {
        entry.number = i + 1;
    }
    let excluded = people
        .keys()
        .filter(|id| !selected.contains(*id))
        .map(|id| Exclusion {
            id: id.clone(),
            reason: if plan.scope.exclude.contains(id) {
                "明确排除"
            } else {
                "不在所选范围"
            }
            .into(),
        })
        .collect();
    Ok(Selection {
        entries,
        excluded,
        issues,
        relationships,
        branches,
    })
}
