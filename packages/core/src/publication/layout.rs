use super::{
    plan::{Chapter, Format, PublicationPlan},
    render::Assets,
    selection::{records, relation_label, string, Selection},
    typography::Typography,
    Job,
};
use crate::{core::error::CoreResult, project_format::ProjectData};
use std::collections::{BTreeMap, BTreeSet};

pub const MM: f32 = 72.0 / 25.4;

#[derive(Clone)]
pub enum Draw {
    ClipStart {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    },
    ClipEnd,
    Text {
        text: String,
        x: f32,
        y: f32,
        size: f32,
        vertical: bool,
        target: Option<String>,
    },
    Line {
        x: f32,
        y: f32,
        to_x: f32,
        to_y: f32,
        dash: usize,
    },
    Rect {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    },
    Image {
        id: String,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    },
    Pdf {
        id: String,
        index: usize,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
    },
}

#[derive(Clone)]
pub struct Sheet {
    pub width: f32,
    pub height: f32,
    pub heading: String,
    pub ops: Vec<Draw>,
    pub traditional: bool,
}

pub struct Layout<'a> {
    pub pages: Vec<Sheet>,
    pub anchors: BTreeMap<String, usize>,
    pub chapters: Vec<(String, String)>,
    pub plan: &'a PublicationPlan,
    pub font: &'a Typography,
    pub refs: &'a BTreeMap<String, usize>,
    pub heading: String,
    cursor: f32,
    continuation: String,
    record: Option<Vec<(String, f32, Option<String>)>>,
}

pub fn chapter_key(chapter: Chapter) -> String {
    format!("chapter:{chapter:?}")
}

impl<'a> Layout<'a> {
    pub fn new(
        plan: &'a PublicationPlan,
        font: &'a Typography,
        refs: &'a BTreeMap<String, usize>,
    ) -> Self {
        Self {
            pages: Vec::new(),
            anchors: BTreeMap::new(),
            chapters: Vec::new(),
            plan,
            font,
            refs,
            heading: String::new(),
            cursor: 0.0,
            continuation: String::new(),
            record: None,
        }
    }
    pub fn vertical(&self) -> bool {
        self.plan.format == Format::Traditional
    }
    pub fn bounds(&self) -> (f32, f32, f32, f32) {
        let p = &self.plan.paper;
        let right = self.vertical() ^ (p.duplex && self.pages.len().is_multiple_of(2));
        let x = p.margin_mm * MM + if right { 0.0 } else { p.gutter_mm * MM };
        (
            x,
            p.margin_mm * MM + 24.0,
            (p.width_mm - 2.0 * p.margin_mm - p.gutter_mm) * MM,
            (p.height_mm - 2.0 * p.margin_mm) * MM - 48.0,
        )
    }
    pub fn new_page(&mut self) {
        self.pages.push(Sheet {
            width: self.plan.paper.width_mm * MM,
            height: self.plan.paper.height_mm * MM,
            heading: if self.continuation.is_empty() {
                self.heading.clone()
            } else {
                format!("{} · {}（续）", self.heading, self.continuation)
            },
            ops: Vec::new(),
            traditional: self.vertical(),
        });
        let (x, y, w, _) = self.bounds();
        self.cursor = if self.vertical() { x + w } else { y };
    }
    pub fn op(&mut self, op: Draw) {
        if let Some(page) = self.pages.last_mut() {
            page.ops.push(op);
        }
    }
    pub fn text_at(
        &mut self,
        text: impl Into<String>,
        x: f32,
        y: f32,
        size: f32,
        target: Option<String>,
    ) {
        self.op(Draw::Text {
            text: text.into(),
            x,
            y,
            size,
            vertical: false,
            target,
        });
    }
    pub fn chapter(&mut self, chapter: Chapter) {
        self.heading = chapter.label().into();
        self.continuation.clear();
        self.new_page();
        let key = chapter_key(chapter);
        self.anchors.insert(key.clone(), self.pages.len());
        self.chapters.push((key, chapter.label().into()));
        if !matches!(
            chapter,
            Chapter::Cover | Chapter::Tree | Chapter::Appendices
        ) {
            self.paragraph(chapter.label(), self.plan.paper.font_size * 1.5, None);
        }
    }
    pub fn reserve(&mut self, amount: f32) {
        let (x, y, _, h) = self.bounds();
        if (self.vertical() && self.cursor - amount < x)
            || (!self.vertical() && self.cursor + amount > y + h)
        {
            self.new_page();
        }
    }
    pub fn paragraph(&mut self, text: &str, size: f32, target: Option<String>) {
        if text.trim().is_empty() {
            return;
        }
        if let Some(record) = &mut self.record {
            record.push((text.into(), size, target));
            return;
        }
        let vertical = self.vertical();
        let (_, _, w, h) = self.bounds();
        let lines = self
            .font
            .lines(text, size, if vertical { h - size } else { w }, vertical);
        let step = size * 1.65;
        for line in lines {
            self.reserve(step);
            let (x, y, _, _) = self.bounds();
            if vertical {
                self.cursor -= step;
            } else {
                self.cursor += step;
            }
            self.op(Draw::Text {
                text: line,
                x: if vertical { self.cursor } else { x },
                y: if vertical {
                    y + size
                } else {
                    self.cursor - size * 0.3
                },
                size,
                vertical,
                target: target.clone(),
            });
        }
        if vertical {
            self.cursor -= size * 0.4;
        } else {
            self.cursor += size * 0.4;
        }
    }
    fn begin_record(&mut self) {
        self.record = Some(Vec::new());
    }
    fn end_record(&mut self, key: Option<String>, name: &str) {
        let paragraphs = self.record.take().unwrap_or_default();
        if self.vertical() && paragraphs.len() > 1 {
            self.vertical_record(paragraphs, key, name);
            return;
        }
        let (_, _, w, h) = self.bounds();
        let capacity = if self.vertical() { w } else { h };
        let extents: Vec<_> = paragraphs
            .iter()
            .map(|(text, size, _)| {
                self.font
                    .lines(
                        text,
                        *size,
                        if self.vertical() { h - size } else { w },
                        self.vertical(),
                    )
                    .len() as f32
                    * size
                    * 1.65
                    + size * 0.4
            })
            .collect();
        let total: f32 = extents.iter().sum();
        self.continuation.clear();
        // Keep a short record together; long records retain their title in continuation headers.
        self.reserve(if total <= capacity {
            total
        } else {
            extents.iter().take(2).sum::<f32>().min(capacity)
        });
        if let Some(key) = key {
            self.anchors.insert(key, self.pages.len());
        }
        self.continuation = name.into();
        for (text, size, target) in paragraphs {
            self.paragraph(&text, size, target);
        }
        self.continuation.clear();
    }
    fn vertical_record(
        &mut self,
        paragraphs: Vec<(String, f32, Option<String>)>,
        key: Option<String>,
        name: &str,
    ) {
        let size = self.plan.paper.font_size;
        let (_, _, w, h) = self.bounds();
        let (title, title_size, title_target) = &paragraphs[0];
        let mut characters = Vec::new();
        for (i, (text, _, target)) in paragraphs.iter().skip(1).enumerate() {
            if i > 0 {
                characters.push(('　', None));
            }
            characters.extend(
                text.chars()
                    .filter(|c| !c.is_control() || *c == '\n')
                    .map(|ch| (if ch == '\n' { '　' } else { ch }, target.clone())),
            );
        }
        let text: String = characters.iter().map(|(ch, _)| ch).collect();
        let lines = self.font.lines(&text, size, h - size, true);
        let title_extent = self
            .font
            .lines(title, *title_size, h - title_size, true)
            .len() as f32
            * title_size
            * 1.65
            + title_size * 0.4;
        let total = title_extent + lines.len() as f32 * size * 1.65 + size * 0.7;
        self.continuation.clear();
        self.reserve(if total <= w {
            total
        } else {
            (title_extent + size * 3.3).min(w)
        });
        if let Some(key) = key {
            self.anchors.insert(key, self.pages.len());
        }
        self.continuation = name.into();
        self.paragraph(title, *title_size, title_target.clone());
        let mut offset = 0;
        for line in lines {
            self.reserve(size * 1.65);
            self.cursor -= size * 1.65;
            let y = self.bounds().1 + size;
            let count = line.chars().count();
            let mut start = 0;
            // Keep links attached to their original record fragment while sharing a column.
            while start < count {
                let target = characters[offset + start].1.clone();
                let mut end = start + 1;
                while end < count && characters[offset + end].1 == target {
                    end += 1;
                }
                self.op(Draw::Text {
                    text: characters[offset + start..offset + end]
                        .iter()
                        .map(|(ch, _)| ch)
                        .collect(),
                    x: self.cursor,
                    y: y + start as f32 * size,
                    size,
                    vertical: true,
                    target,
                });
                start = end;
            }
            offset += count;
        }
        self.cursor -= size * 0.7;
        self.continuation.clear();
    }
    pub fn reference(&self, id: &str) -> String {
        self.refs
            .get(id)
            .map(|page| format!("第 {page} 页"))
            .unwrap_or_else(|| "本册未单列".into())
    }
    fn designed_cover(&mut self) -> bool {
        // Long custom titles and image covers use the normal flowing layout.
        if self.plan.cover_attachment_id.is_some() || self.plan.title.chars().count() > 40 {
            return false;
        }
        let (x, y, w, h) = self.bounds();
        let title_size = (self.plan.paper.font_size * 2.4).min(34.0);
        let meta: Vec<_> = [
            &self.plan.subtitle,
            &self.plan.editor,
            &self.plan.edition,
            &self.plan.date,
        ]
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
        if self.vertical() {
            let lines = self
                .font
                .lines(&self.plan.title, title_size, h * 0.65, true);
            let width = lines.len() as f32 * title_size * 1.5 + 32.0;
            if width + 26.0 * meta.len() as f32 + w * 0.08 > w
                || meta
                    .iter()
                    .any(|s| s.chars().count() as f32 * 12.0 > h * 0.75)
            {
                return false;
            }
            let left = x + w - width - w * 0.08;
            let top = y + h * 0.10;
            let height = lines.iter().map(|s| s.chars().count()).max().unwrap_or(1) as f32
                * title_size
                + 40.0;
            self.op(Draw::Rect {
                x: left,
                y: top,
                width,
                height,
            });
            for (i, text) in lines.into_iter().enumerate() {
                self.op(Draw::Text {
                    text,
                    x: left + width - 16.0 - title_size * (1.5 * i as f32 + 1.0),
                    y: top + 20.0 + title_size,
                    size: title_size,
                    vertical: true,
                    target: None,
                });
            }
            for (i, text) in meta.into_iter().enumerate() {
                self.op(Draw::Text {
                    text: text.clone(),
                    x: left - 26.0 * (i as f32 + 1.0),
                    y: top + 24.0,
                    size: 12.0,
                    vertical: true,
                    target: None,
                });
            }
        } else {
            let lines = self
                .font
                .lines(&self.plan.title, title_size, w * 0.9, false);
            if lines.len() > 3 || meta.iter().any(|s| self.font.width(s, 12.0) > w) {
                return false;
            }
            let mut baseline = y + h * 0.30;
            for text in lines {
                self.text_at(
                    &text,
                    x + (w - self.font.width(&text, title_size)) * 0.5,
                    baseline,
                    title_size,
                    None,
                );
                baseline += title_size * 1.7;
            }
            self.op(Draw::Line {
                x: x + w * 0.38,
                y: baseline,
                to_x: x + w * 0.62,
                to_y: baseline,
                dash: 0,
            });
            let start = (baseline + 45.0).min(y + h * 0.72);
            for (i, text) in meta.into_iter().enumerate() {
                self.text_at(
                    text,
                    x + (w - self.font.width(text, 12.0)) * 0.5,
                    start + i as f32 * 25.0,
                    12.0,
                    None,
                );
            }
        }
        true
    }
    fn illustration(&mut self, id: &str, caption: &str, assets: &Assets) {
        let Some((iw, ih)) = assets.image_sizes.get(id) else {
            return;
        };
        // A dedicated plate keeps images intact in both horizontal and vertical books.
        let caption = self.plate_caption(caption, "图片说明见前页");
        let (x, y, w, h) = self.bounds();
        let caption_lines = self.font.lines(&caption, 10.0, w, false);
        let available = h - caption_lines.len() as f32 * 16.0 - 12.0;
        let scale = (w / *iw).min(available / *ih);
        self.op(Draw::Image {
            id: id.into(),
            x: x + (w - iw * scale) / 2.0,
            y,
            width: iw * scale,
            height: ih * scale,
        });
        for (index, line) in caption_lines.into_iter().enumerate() {
            self.text_at(
                line,
                x,
                y + available + 18.0 + index as f32 * 16.0,
                10.0,
                None,
            );
        }
        let (_, y, w, h) = self.bounds();
        self.cursor = if self.vertical() { x } else { y + h + w };
    }

    // Keep unusually long descriptions complete, on flowing text pages before the plate.
    // This also guarantees positive image/PDF dimensions on small custom paper.
    fn plate_caption(&mut self, caption: &str, short: &str) -> String {
        if self.pages.last().is_none_or(|page| !page.ops.is_empty()) {
            self.new_page();
        }
        let (_, _, w, h) = self.bounds();
        if self.font.lines(caption, 10.0, w, false).len() as f32 * 16.0 > h * 0.25 {
            self.paragraph(caption, self.plan.paper.font_size, None);
            self.new_page();
            short.into()
        } else {
            caption.into()
        }
    }
}

fn date(value: &serde_json::Value, key: &str) -> String {
    string(&value[key], "display").to_owned()
}

fn period(value: &serde_json::Value) -> String {
    let start = date(value, "start");
    let end = date(value, "end");
    match (start.is_empty(), end.is_empty()) {
        (false, false) => format!("起：{start}；止：{end}"),
        (false, true) => format!("起：{start}"),
        (true, false) => format!("止：{end}"),
        (true, true) => String::new(),
    }
}

fn citation_text(source: &serde_json::Value, citation: &serde_json::Value) -> String {
    let mut text = format!("据《{}》", string(source, "title"));
    if !string(citation, "locator").is_empty() {
        text.push_str(&format!("；原资料定位：{}", string(citation, "locator")));
    }
    text.push('。');
    text.push_str(string(citation, "excerpt"));
    text
}

fn references<'a>(
    book: &mut Layout<'_>,
    targets: impl Iterator<Item = &'a serde_json::Value>,
    sources: &BTreeMap<&str, &serde_json::Value>,
    citations: &BTreeMap<&str, Vec<&serde_json::Value>>,
    size: f32,
) {
    let mut referenced = BTreeSet::new();
    let mut direct = BTreeSet::new();
    let mut printed = BTreeSet::new();
    for target in targets {
        direct.extend(
            target["sourceIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(serde_json::Value::as_str),
        );
        for citation in citations.get(string(target, "id")).into_iter().flatten() {
            let id = string(citation, "sourceId");
            if let Some(source) = sources.get(id) {
                if printed.insert(string(citation, "id")) {
                    book.paragraph(
                        &citation_text(source, citation),
                        size,
                        Some(format!("source:{id}")),
                    );
                }
                referenced.insert(id);
            }
        }
    }
    for id in direct.difference(&referenced) {
        if let Some(source) = sources.get(id) {
            book.paragraph(
                &format!("来源：《{}》", string(source, "title")),
                size,
                Some(format!("source:{id}")),
            );
        }
    }
}

fn event_date_key(event: &serde_json::Value) -> &str {
    let value = &event["date"];
    let start = string(value, "start");
    if start.is_empty() {
        string(value, "end")
    } else {
        start
    }
}

pub fn book<'a>(
    data: &ProjectData,
    plan: &'a PublicationPlan,
    selection: &Selection,
    assets: &Assets,
    font: &'a Typography,
    refs: &'a BTreeMap<String, usize>,
    job: &Job,
) -> CoreResult<Layout<'a>> {
    let mut book = Layout::new(plan, font, refs);
    let people: BTreeMap<_, _> = records(data, "people")
        .iter()
        .map(|v| (string(v, "id"), v))
        .collect();
    let entries: BTreeMap<_, _> = selection
        .entries
        .iter()
        .map(|v| (v.id.as_str(), v))
        .collect();
    let places: BTreeMap<_, _> = records(data, "places")
        .iter()
        .map(|v| (string(v, "id"), string(v, "name")))
        .collect();
    let organizations: BTreeMap<_, _> = records(data, "organizations")
        .iter()
        .map(|v| (string(v, "id"), string(v, "name")))
        .collect();
    let sources: BTreeMap<_, _> = records(data, "sources")
        .iter()
        .map(|v| (string(v, "id"), v))
        .collect();
    let mut related: BTreeMap<&str, Vec<&serde_json::Value>> = BTreeMap::new();
    for r in records(data, "relationships") {
        if string(r, "category") == "parent"
            && !plan
                .scope
                .parent_types
                .iter()
                .any(|kind| kind == string(r, "type"))
        {
            continue;
        }
        related
            .entry(string(r, "fromPersonId"))
            .or_default()
            .push(r);
        if r["fromPersonId"] != r["toPersonId"] {
            related.entry(string(r, "toPersonId")).or_default().push(r);
        }
    }
    let mut careers: BTreeMap<&str, Vec<&serde_json::Value>> = BTreeMap::new();
    let mut titles: BTreeMap<&str, Vec<&serde_json::Value>> = BTreeMap::new();
    let mut citations: BTreeMap<&str, Vec<&serde_json::Value>> = BTreeMap::new();
    for v in records(data, "careers") {
        careers.entry(string(v, "personId")).or_default().push(v);
    }
    for v in records(data, "personTitles") {
        titles.entry(string(v, "personId")).or_default().push(v);
    }
    for v in records(data, "citations") {
        citations.entry(string(v, "targetId")).or_default().push(v);
    }
    for index in [&mut related, &mut careers, &mut titles, &mut citations] {
        for values in index.values_mut() {
            values.sort_by_key(|value| string(value, "id"));
        }
    }
    let mut included_targets: BTreeSet<&str> = entries.keys().copied().collect();
    for r in &selection.relationships {
        included_targets.insert(string(r, "id"));
    }
    for values in careers.values() {
        for career in values {
            if entries.contains_key(string(career, "personId")) {
                included_targets.insert(string(career, "id"));
            }
        }
    }
    for values in titles.values() {
        for title in values {
            if entries.contains_key(string(title, "personId")) {
                included_targets.insert(string(title, "id"));
            }
        }
    }
    let mut events: Vec<_> = records(data, "events")
        .iter()
        .filter(|e| {
            e["participantIds"].as_array().is_some_and(|ids| {
                ids.iter()
                    .any(|id| id.as_str().is_some_and(|id| entries.contains_key(id)))
            })
        })
        .collect();
    events.sort_by(|a, b| {
        (
            event_date_key(a).is_empty(),
            event_date_key(a),
            string(a, "id"),
        )
            .cmp(&(
                event_date_key(b).is_empty(),
                event_date_key(b),
                string(b, "id"),
            ))
    });
    for event in &events {
        included_targets.insert(string(event, "id"));
    }
    let used_sources: BTreeSet<_> = records(data, "citations")
        .iter()
        .filter(|c| included_targets.contains(string(c, "targetId")))
        .map(|c| string(c, "sourceId"))
        .chain(
            selection
                .relationships
                .iter()
                .chain(events.iter().copied())
                .chain(
                    careers
                        .values()
                        .flatten()
                        .copied()
                        .filter(|v| entries.contains_key(string(v, "personId"))),
                )
                .chain(
                    people
                        .values()
                        .copied()
                        .filter(|v| entries.contains_key(string(v, "id"))),
                )
                .chain(
                    titles
                        .values()
                        .flatten()
                        .copied()
                        .filter(|v| entries.contains_key(string(v, "personId"))),
                )
                .flat_map(|v| {
                    v["sourceIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(serde_json::Value::as_str)
                }),
        )
        .collect();
    let size = plan.paper.font_size;
    let chapters: Vec<_> = plan
        .chapters
        .iter()
        .copied()
        .filter(|chapter| match chapter {
            Chapter::Preface => !plan.preface.trim().is_empty(),
            Chapter::Events => !events.is_empty(),
            Chapter::Sources => !used_sources.is_empty(),
            Chapter::Appendices => !assets.plates.is_empty() || !plan.appendices.is_empty(),
            _ => true,
        })
        .collect();
    for chapter in &chapters {
        job.checkpoint("分页", book.pages.len(), 0)?;
        book.chapter(*chapter);
        match chapter {
            Chapter::Cover => {
                if book.designed_cover() {
                    continue;
                }
                book.paragraph(&plan.title, size * 2.0, None);
                for line in [&plan.subtitle, &plan.editor, &plan.edition, &plan.date] {
                    if !line.is_empty() {
                        book.paragraph(line, size, None);
                    }
                }
                if let Some(id) = &plan.cover_attachment_id {
                    if let Some((iw, ih)) = assets.image_sizes.get(id) {
                        book.reserve(100.0);
                        let (x, y, w, h) = book.bounds();
                        let (area_x, area_y, area_w, area_h) = if book.vertical() {
                            (x, y, book.cursor - x - 12.0, h)
                        } else {
                            (x, book.cursor + 12.0, w, y + h - book.cursor - 12.0)
                        };
                        let scale = (area_w / iw).min(area_h / ih);
                        book.op(Draw::Image {
                            id: id.clone(),
                            x: area_x + (area_w - iw * scale) / 2.0,
                            y: area_y + (area_h - ih * scale) / 2.0,
                            width: iw * scale,
                            height: ih * scale,
                        });
                    }
                }
            }
            Chapter::Preface => book.paragraph(&plan.preface, size, None),
            Chapter::Contents => {
                for next in &chapters {
                    if *next == Chapter::Cover || *next == Chapter::Contents {
                        continue;
                    }
                    let key = chapter_key(*next);
                    book.paragraph(
                        &format!("{}　{}", next.label(), book.reference(&key)),
                        size,
                        Some(key),
                    );
                }
            }
            Chapter::Tree => super::charts::draw(&mut book, selection, job, false)?,
            Chapter::Biographies => {
                for (index, entry) in selection.entries.iter().enumerate() {
                    job.checkpoint("人物传记", index, selection.entries.len())?;
                    let p = people[entry.id.as_str()];
                    book.begin_record();
                    book.paragraph(
                        &format!("【{}】{}", entry.number, entry.name),
                        size * 1.25,
                        None,
                    );
                    book.paragraph(
                        &format!(
                            "分支 {} · {}",
                            entry.branch,
                            entry
                                .generation
                                .map(|v| format!("第 {v} 世"))
                                .unwrap_or_else(|| "世代未定".into())
                        ),
                        size,
                        None,
                    );
                    let mut facts = Vec::new();
                    if plan.field("names") {
                        for n in p["names"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|n| n["primary"] != true)
                        {
                            let label = match string(n, "type") {
                                "courtesy" => "字",
                                "art" => "号",
                                "genealogy" => "谱名",
                                "generation" => "辈字",
                                "childhood" => "乳名",
                                "former" => "曾用名",
                                "pen" => "笔名",
                                "religious" => "法名",
                                "posthumous" => "谥号",
                                "temple" => "庙号",
                                "honorific" => "尊称",
                                "custom" => string(n, "customTypeLabel"),
                                "personal" => "姓名",
                                _ => "别名",
                            };
                            facts.push(format!("{label}：{}", string(n, "value")));
                        }
                    }
                    if plan.field("status") {
                        facts.push(
                            match string(p, "status") {
                                "living" => "状态：在世",
                                "deceased" => "状态：已故",
                                _ => "状态：未知",
                            }
                            .into(),
                        );
                    }
                    if plan.field("dates") {
                        for (key, label) in [("birth", "生"), ("death", "卒")] {
                            let d = date(p, key);
                            if key == "death" && string(p, "status") == "living" && d.is_empty() {
                                continue;
                            }
                            facts.push(format!(
                                "{label}：{}",
                                if d.is_empty() { "未知" } else { &d }
                            ));
                        }
                    }
                    if plan.field("places") {
                        for (key, label) in [("birthPlaceId", "出生地"), ("deathPlaceId", "去世地")]
                        {
                            if let Some(place) = places.get(string(p, key)) {
                                facts.push(format!("{label}：{place}"));
                            }
                        }
                    }
                    book.paragraph(&facts.join("；"), size, None);
                    for (field, label) in [("biography", "生平"), ("notes", "备注")] {
                        if plan.field(field) && !string(p, field).is_empty() {
                            book.paragraph(&format!("{label}：{}", string(p, field)), size, None);
                        }
                    }
                    if plan.field("relationships") {
                        for r in related.get(entry.id.as_str()).into_iter().flatten() {
                            let outgoing = string(r, "fromPersonId") == entry.id;
                            let other = string(
                                r,
                                if outgoing {
                                    "toPersonId"
                                } else {
                                    "fromPersonId"
                                },
                            );
                            let direction = if string(r, "category") == "partner" {
                                "与"
                            } else if outgoing {
                                "对子女／受监护人"
                            } else {
                                "与父母／监护人"
                            };
                            let Some(other) = entries.get(other) else {
                                book.paragraph(
                                    &format!(
                                        "{}：{direction}范围外人物（未收录详情）",
                                        relation_label(r)
                                    ),
                                    size,
                                    None,
                                );
                                continue;
                            };
                            book.paragraph(
                                &format!(
                                    "{}：{direction}【{}】{}，{}{}",
                                    relation_label(r),
                                    other.number,
                                    other.name,
                                    book.reference(&other.id),
                                    if period(r).is_empty() {
                                        String::new()
                                    } else {
                                        format!("；{}", period(r))
                                    }
                                ),
                                size,
                                Some(other.id.clone()),
                            );
                        }
                    }
                    if plan.field("careers") {
                        for career in careers.get(entry.id.as_str()).into_iter().flatten() {
                            book.paragraph(
                                &format!(
                                    "履历：{} {} {} {} {} {}",
                                    organizations
                                        .get(string(career, "organizationId"))
                                        .unwrap_or(&""),
                                    string(career, "positionTitle"),
                                    string(career, "department"),
                                    string(career, "regime"),
                                    string(career, "rankOrGrade"),
                                    period(career)
                                ),
                                size,
                                None,
                            );
                            if !string(career, "description").is_empty() {
                                book.paragraph(string(career, "description"), size, None);
                            }
                            if !string(career, "appointmentType").is_empty() {
                                book.paragraph(
                                    &format!("任职方式：{}", string(career, "appointmentType")),
                                    size,
                                    None,
                                );
                            }
                            if let Some(place) = places.get(string(career, "jurisdictionPlaceId")) {
                                book.paragraph(&format!("辖地：{place}"), size, None);
                            }
                            if !string(career, "appointedByPersonId").is_empty() {
                                let appointing = entries.get(string(career, "appointedByPersonId"));
                                book.paragraph(
                                    &format!(
                                        "任命者：{}",
                                        appointing
                                            .map(|e| format!(
                                                "【{}】{}，{}",
                                                e.number,
                                                e.name,
                                                book.reference(&e.id)
                                            ))
                                            .unwrap_or_else(|| "范围外人物（未收录详情）".into())
                                    ),
                                    size,
                                    appointing.map(|e| e.id.clone()),
                                );
                            }
                            book.paragraph(
                                match string(career, "status") {
                                    "current" => "任职状态：现任",
                                    "former" => "任职状态：曾任",
                                    _ => "任职状态：未知",
                                },
                                size,
                                None,
                            );
                            if plan.field("notes") && !string(career, "notes").is_empty() {
                                book.paragraph(string(career, "notes"), size, None);
                            }
                        }
                    }
                    if plan.field("titles") {
                        for title in titles.get(entry.id.as_str()).into_iter().flatten() {
                            book.paragraph(
                                &format!("称谓：{} {}", string(title, "value"), period(title)),
                                size,
                                None,
                            );
                            if let Some(place) = places.get(string(title, "placeId")) {
                                book.paragraph(&format!("封地／地点：{place}"), size, None);
                            }
                            if !string(title, "grantedByPersonId").is_empty() {
                                let granting = entries.get(string(title, "grantedByPersonId"));
                                book.paragraph(
                                    &format!(
                                        "授予者：{}",
                                        granting
                                            .map(|e| format!(
                                                "【{}】{}，{}",
                                                e.number,
                                                e.name,
                                                book.reference(&e.id)
                                            ))
                                            .unwrap_or_else(|| "范围外人物（未收录详情）".into())
                                    ),
                                    size,
                                    granting.map(|e| e.id.clone()),
                                );
                            }
                            if plan.field("notes") && !string(title, "notes").is_empty() {
                                book.paragraph(string(title, "notes"), size, None);
                            }
                        }
                    }
                    if plan.field("citations") {
                        let targets = std::iter::once(p)
                            .chain(
                                related
                                    .get(entry.id.as_str())
                                    .into_iter()
                                    .flatten()
                                    .copied()
                                    .filter(|v| included_targets.contains(string(v, "id"))),
                            )
                            .chain(
                                careers
                                    .get(entry.id.as_str())
                                    .into_iter()
                                    .flatten()
                                    .copied()
                                    .filter(|_| plan.field("careers")),
                            )
                            .chain(
                                titles
                                    .get(entry.id.as_str())
                                    .into_iter()
                                    .flatten()
                                    .copied()
                                    .filter(|_| plan.field("titles")),
                            );
                        references(&mut book, targets, &sources, &citations, size);
                    }
                    book.end_record(Some(entry.id.clone()), &entry.name);
                    for (id, caption) in assets.person_images.get(&entry.id).into_iter().flatten() {
                        book.illustration(id, caption, assets);
                    }
                }
            }
            Chapter::Events => {
                book.paragraph("按已记录日期的起点排序；仅有上界时取上界。约、之前、之后与区间均保留原文，不代表确切日期。", size, None);
                let mut undated = false;
                for event in &events {
                    if event_date_key(event).is_empty() && !undated {
                        book.reserve(size * 5.0);
                        book.paragraph("日期未定的事件", size * 1.2, None);
                        undated = true;
                    }
                    book.begin_record();
                    let when = date(event, "date");
                    book.paragraph(
                        &format!(
                            "{}　{}",
                            if when.is_empty() {
                                "日期未定"
                            } else {
                                &when
                            },
                            string(event, "title")
                        ),
                        size * 1.1,
                        None,
                    );
                    if let Some(place) = places.get(string(event, "placeId")) {
                        book.paragraph(place, size, None);
                    }
                    for id in event["participantIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(serde_json::Value::as_str)
                    {
                        if let Some(e) = entries.get(id) {
                            book.paragraph(
                                &format!("【{}】{}，{}", e.number, e.name, book.reference(id)),
                                size,
                                Some(id.into()),
                            );
                        }
                    }
                    book.paragraph(string(event, "notes"), size, None);
                    if plan.field("citations") {
                        references(
                            &mut book,
                            std::iter::once(*event),
                            &sources,
                            &citations,
                            size,
                        );
                    }
                    book.end_record(None, string(event, "title"));
                }
            }
            Chapter::Sources => {
                for id in &used_sources {
                    if let Some(source) = sources.get(id) {
                        book.begin_record();
                        book.paragraph(
                            &format!("《{}》", string(source, "title")),
                            size * 1.1,
                            None,
                        );
                        let mut details = Vec::new();
                        for (key, label) in [
                            ("author", "作者"),
                            ("repository", "藏所"),
                            ("referenceCode", "编号"),
                            ("url", "网址"),
                            ("notes", "说明"),
                        ] {
                            if !string(source, key).is_empty() {
                                details.push(format!("{label}：{}", string(source, key)));
                            }
                        }
                        let d = date(source, "date");
                        if !d.is_empty() {
                            details.push(format!("日期：{d}"));
                        }
                        book.paragraph(&details.join("；"), size, None);
                        book.end_record(Some(format!("source:{id}")), string(source, "title"));
                    }
                }
            }
            Chapter::Appendices => {
                for (id, caption) in &assets.plates {
                    book.illustration(id, caption, assets);
                }
                for appendix in &plan.appendices {
                    let pdf = &assets.pdfs[&appendix.attachment_id];
                    for index in super::plan::parse_pages(&appendix.pages, pdf.dimensions.len())? {
                        let (iw, ih) = pdf.dimensions[index];
                        let caption = format!("{} · 原文件第 {} 页", pdf.name, index + 1);
                        let caption = book.plate_caption(
                            &caption,
                            &format!("原文件第 {} 页 · 完整文件名见前页", index + 1),
                        );
                        let (x, y, w, h) = book.bounds();
                        let lines = font.lines(&caption, 10.0, w, false);
                        let available = h - lines.len() as f32 * 16.0 - 12.0;
                        let scale = (w / iw).min(available / ih);
                        book.op(Draw::Pdf {
                            id: appendix.attachment_id.clone(),
                            index,
                            x: x + (w - iw * scale) * 0.5,
                            y,
                            width: iw * scale,
                            height: ih * scale,
                        });
                        for (i, line) in lines.into_iter().enumerate() {
                            book.text_at(
                                line,
                                x,
                                y + available + 18.0 + i as f32 * 16.0,
                                10.0,
                                None,
                            );
                        }
                    }
                }
            }
            Chapter::Index => {
                let mut sorted: Vec<_> = selection.entries.iter().collect();
                sorted.sort_by(|a, b| (&a.name, &a.id).cmp(&(&b.name, &b.id)));
                for entry in sorted {
                    book.paragraph(
                        &format!(
                            "{}　【{}】　{}",
                            entry.name,
                            entry.number,
                            book.reference(&entry.id)
                        ),
                        size,
                        Some(entry.id.clone()),
                    );
                }
            }
        }
    }
    if book.pages.is_empty() {
        return Err(super::plan::invalid(
            "所选章节没有可编印内容，请填写谱序或选择其他章节",
        ));
    }
    Ok(book)
}
