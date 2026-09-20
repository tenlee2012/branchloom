use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::core::error::{CoreError, CoreResult};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationPlan {
    pub id: String,
    pub name: String,
    pub format: Format,
    pub title: String,
    pub subtitle: String,
    pub editor: String,
    pub edition: String,
    pub date: String,
    pub preface: String,
    pub scope: Scope,
    pub chapters: Vec<Chapter>,
    pub fields: Vec<String>,
    pub paper: Paper,
    pub chart: Chart,
    pub cover_attachment_id: Option<String>,
    pub images: Vec<Illustration>,
    pub appendices: Vec<Appendix>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Modern,
    Traditional,
    Chart,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Chapter {
    Cover,
    Preface,
    Contents,
    Tree,
    Biographies,
    Events,
    Sources,
    Appendices,
    Index,
}

impl Chapter {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cover => "封面",
            Self::Preface => "谱序",
            Self::Contents => "目录",
            Self::Tree => "世系图",
            Self::Biographies => "人物传记",
            Self::Events => "家族大事记",
            Self::Sources => "史料来源",
            Self::Appendices => "史料附录",
            Self::Index => "姓名索引",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub mode: ScopeMode,
    pub roots: Vec<String>,
    /// None includes every reachable generation. A value of one includes the roots only.
    pub generations: Option<usize>,
    pub start_generation: i32,
    pub partners: bool,
    pub parent_types: Vec<String>,
    pub exclude: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ScopeMode {
    All,
    Branch,
    Ancestors,
    Descendants,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Paper {
    pub width_mm: f32,
    pub height_mm: f32,
    pub margin_mm: f32,
    pub gutter_mm: f32,
    pub font_size: f32,
    pub duplex: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chart {
    pub tiled: bool,
    pub font_size: f32,
    pub overlap_mm: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Illustration {
    pub attachment_id: String,
    pub person_id: Option<String>,
    pub caption: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Appendix {
    pub attachment_id: String,
    pub pages: String,
}

pub fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::Validation(message.into())
}

impl PublicationPlan {
    pub fn validate(&self) -> CoreResult<()> {
        uuid(&self.id)?;
        if self.name.trim().is_empty() || self.name.len() > 512 || self.title.trim().is_empty() {
            return Err(invalid("请填写方案名称和族谱标题（名称最多 128 个汉字）"));
        }
        if self.preface.len() > 2_000_000 || serde_json::to_vec(self)?.len() > 4_000_000 {
            return Err(invalid("编印方案过大，请缩短谱序或减少附件选项"));
        }
        let p = &self.paper;
        if ![
            p.width_mm,
            p.height_mm,
            p.margin_mm,
            p.gutter_mm,
            p.font_size,
            self.chart.font_size,
            self.chart.overlap_mm,
        ]
        .iter()
        .all(|v| v.is_finite())
            || !(100.0..=1200.0).contains(&p.width_mm)
            || !(100.0..=1200.0).contains(&p.height_mm)
            || !(8.0..=40.0).contains(&p.font_size)
            || !(10.0..=40.0).contains(&self.chart.font_size)
            || p.margin_mm < 8.0
            || p.gutter_mm < 0.0
            || p.gutter_mm > 50.0
            || p.width_mm - 2.0 * p.margin_mm - p.gutter_mm < 60.0
            || p.height_mm - 2.0 * p.margin_mm < 70.0
            || !(0.0..=20.0).contains(&self.chart.overlap_mm)
        {
            return Err(invalid("纸张、字号或页边距无效，版心至少需要 60 × 70 毫米"));
        }
        if self.chapters.is_empty()
            || self.chapters.iter().collect::<BTreeSet<_>>().len() != self.chapters.len()
        {
            return Err(invalid("请至少选择一个章节，章节不能重复"));
        }
        if self.scope.mode != ScopeMode::All && self.scope.roots.is_empty() {
            return Err(invalid("请为所选范围指定起始人物"));
        }
        if self.scope.generations == Some(0)
            || self.scope.start_generation.unsigned_abs() > 1_000_000
        {
            return Err(invalid("代数至少为 1，起始世数应在正负一百万以内"));
        }
        if self
            .scope
            .parent_types
            .iter()
            .any(|v| !["biological", "adoptive", "step", "guardian"].contains(&v.as_str()))
        {
            return Err(invalid("不支持的亲子关系类型"));
        }
        for id in self
            .scope
            .roots
            .iter()
            .chain(&self.scope.exclude)
            .chain(self.cover_attachment_id.iter())
        {
            reference_id(id)?;
        }
        for item in &self.images {
            reference_id(&item.attachment_id)?;
            if let Some(id) = &item.person_id {
                reference_id(id)?;
            }
        }
        for item in &self.appendices {
            reference_id(&item.attachment_id)?;
            parse_pages(&item.pages, usize::MAX)?;
        }
        for field in &self.fields {
            if ![
                "names",
                "status",
                "dates",
                "places",
                "biography",
                "notes",
                "relationships",
                "careers",
                "titles",
                "photos",
                "citations",
            ]
            .contains(&field.as_str())
            {
                return Err(invalid(format!("不支持的人物字段：{field}")));
            }
        }
        Ok(())
    }
    pub fn field(&self, name: &str) -> bool {
        self.fields.iter().any(|value| value == name)
    }
}

fn uuid(id: &str) -> CoreResult<()> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| invalid("方案引用必须是有效的项目记录 ID"))
}

// Historical imported records can have stable non-UUID identifiers. Resolve every reference
// against the same project during generation rather than rejecting those existing records.
fn reference_id(id: &str) -> CoreResult<()> {
    if id.is_empty()
        || id.len() > 256
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(invalid("方案引用必须是有效的项目记录 ID"));
    }
    Ok(())
}

pub fn validate_plans(value: Option<&Value>) -> CoreResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let plans: Vec<PublicationPlan> = serde_json::from_value(value.clone())?;
    if plans.len() > 100 {
        return Err(invalid("一个项目最多保存 100 套编印方案"));
    }
    let mut ids = BTreeSet::new();
    for plan in plans {
        plan.validate()?;
        if !ids.insert(plan.id) {
            return Err(invalid("编印方案 ID 重复"));
        }
    }
    Ok(())
}

/// One-based input, zero-based output. Preserve repetitions and user order.
pub fn parse_pages(input: &str, count: usize) -> CoreResult<Vec<usize>> {
    let mut pages = Vec::new();
    for part in input.split(',') {
        let parts: Vec<_> = part.trim().split('-').collect();
        let number = |s: &str| {
            s.trim()
                .parse::<usize>()
                .map_err(|_| invalid("页码格式应为 1-3,5"))
        };
        let start = number(parts[0])?;
        let end = match parts.len() {
            1 => start,
            2 => number(parts[1])?,
            _ => return Err(invalid("页码区间无效")),
        };
        if start == 0
            || start > end
            || end > count
            || end - start >= 10_000
            || pages.len() + (end - start + 1) > 10_000
        {
            return Err(invalid(format!(
                "页码超出范围或选页超过 10000 页（原文件 {count} 页）"
            )));
        }
        pages.extend(start - 1..end);
    }
    if pages.is_empty() {
        return Err(invalid("请至少选择一个 PDF 页面"));
    }
    Ok(pages)
}
