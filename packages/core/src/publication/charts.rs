use super::{
    layout::{Draw, Layout, Sheet, MM},
    plan::invalid,
    selection::{relation_label, string, Selection},
    Job,
};
use crate::core::error::CoreResult;
use std::collections::BTreeMap;

struct Node {
    id: String,
    number: usize,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    lines: Vec<(String, Option<String>)>,
    band: usize,
}

fn fit_y(y: f32, height: f32, step: f32, overlap: f32) -> f32 {
    let row = (y / step).floor();
    let top = y.max(row * step + if row > 0.0 { overlap + 1.0 } else { 0.0 });
    if top + height <= (row + 1.0) * step - 1.0 {
        top
    } else {
        (row + 1.0) * step + overlap + 1.0
    }
}

pub fn draw(
    book: &mut Layout<'_>,
    selection: &Selection,
    job: &Job,
    standalone: bool,
) -> CoreResult<()> {
    let size = book.plan.chart.font_size;
    let tiled = !standalone || book.plan.chart.tiled;
    let (_, _, content_width, content_height) = book.bounds();
    let overlap = if tiled {
        book.plan.chart.overlap_mm * MM
    } else {
        0.0
    };
    let view_height = content_height - 30.0;
    let step_y = view_height - overlap;
    let width = if tiled {
        (size * 13.0).min(content_width)
    } else {
        size * 13.0
    };
    let max_lines = if tiled {
        ((step_y - overlap - 18.0) / (size * 1.5)).floor() as usize
    } else {
        usize::MAX
    };
    if max_lines < 4 {
        return Err(invalid(
            "纸张版心无法容纳当前挂图字号，请增大纸张或减小字号",
        ));
    }
    let gap = size * 4.0;
    let entries: BTreeMap<_, _> = selection
        .entries
        .iter()
        .map(|e| (e.id.as_str(), e))
        .collect();
    let mut incoming: BTreeMap<&str, Vec<&serde_json::Value>> = BTreeMap::new();
    for relationship in &selection.relationships {
        let a = string(relationship, "fromPersonId");
        let b = string(relationship, "toPersonId");
        incoming.entry(a).or_default().push(relationship);
        if a != b {
            incoming.entry(b).or_default().push(relationship);
        }
    }
    let mut grouped: BTreeMap<usize, BTreeMap<Option<i32>, Vec<_>>> = BTreeMap::new();
    for entry in &selection.entries {
        grouped
            .entry(entry.branch)
            .or_default()
            .entry(entry.generation)
            .or_default()
            .push(entry);
    }
    let mut nodes = Vec::new();
    let mut labels = Vec::new();
    let mut base_y = 0.0;
    for (branch, layers) in grouped {
        let mut layers: Vec<_> = layers.into_iter().collect();
        layers.sort_by_key(|(generation, _)| (generation.is_none(), *generation));
        let columns_per_band = if !standalone || book.plan.chart.tiled {
            ((book.bounds().2 + gap) / (width + gap)).floor().max(1.0) as usize
        } else {
            4
        };
        for band in layers.chunks(columns_per_band) {
            if tiled {
                // A label and at least one complete card must remain together.
                base_y = fit_y(base_y, size * 18.0, step_y, overlap);
            }
            labels.push((
                format!(
                    "分支 {branch} · {}",
                    band.first()
                        .and_then(|(g, _)| *g)
                        .map(|g| format!("第 {g} 世起"))
                        .unwrap_or_else(|| "世代未定".into())
                ),
                base_y,
            ));
            let mut bottom = base_y + size * 3.0;
            for (column, (_, members)) in band.iter().enumerate() {
                let mut y = base_y + size * 3.0;
                for entry in members {
                    let mut lines: Vec<(String, Option<String>)> = book
                        .font
                        .lines(
                            &format!("【{}】{}", entry.number, entry.name),
                            size,
                            width - 16.0,
                            false,
                        )
                        .into_iter()
                        .map(|v| (v, Some(entry.id.clone())))
                        .collect();
                    lines.push((
                        entry
                            .generation
                            .map(|g| format!("第 {g} 世"))
                            .unwrap_or_else(|| "世代未定".into()),
                        None,
                    ));
                    lines.push((
                        format!("本册位置：{}", book.reference(&entry.id)),
                        Some(entry.id.clone()),
                    ));
                    for r in incoming.get(entry.id.as_str()).into_iter().flatten() {
                        let a = string(r, "fromPersonId");
                        let b = string(r, "toPersonId");
                        let other = if a == entry.id { b } else { a };
                        let target = format!("chart:{other}");
                        let prefix = if string(r, "category") == "parent" && a == entry.id {
                            "子女／受监护"
                        } else if string(r, "category") == "parent" {
                            "父母／监护"
                        } else {
                            "伴侣"
                        };
                        let line = format!(
                            "{prefix}：{}【{}】{}",
                            relation_label(r),
                            entries[other].number,
                            book.reference(&target)
                        );
                        lines.extend(
                            book.font
                                .lines(&line, size, width - 16.0, false)
                                .into_iter()
                                .map(|line| (line, Some(target.clone()))),
                        );
                    }
                    let mut remaining = lines.into_iter().peekable();
                    let mut continuation = false;
                    while remaining.peek().is_some() {
                        let mut lines = Vec::new();
                        if continuation {
                            lines.extend(
                                book.font
                                    .lines(
                                        &format!("续【{}】", entry.number),
                                        size,
                                        width - 16.0,
                                        false,
                                    )
                                    .into_iter()
                                    .map(|line| (line, Some(entry.id.clone()))),
                            );
                        }
                        lines.extend(remaining.by_ref().take(max_lines - lines.len()));
                        let height = lines.len() as f32 * size * 1.5 + 18.0;
                        if tiled {
                            y = fit_y(y, height, step_y, overlap);
                        }
                        nodes.push(Node {
                            id: entry.id.clone(),
                            number: entry.number,
                            x: column as f32 * (width + gap),
                            y,
                            width,
                            height,
                            lines,
                            band: labels.len(),
                        });
                        y += height + size * 3.0;
                        continuation = true;
                    }
                }
                bottom = bottom.max(y);
            }
            base_y = bottom + size * 4.0;
        }
    }
    let total_width = nodes.iter().map(|n| n.x + n.width).fold(1.0, f32::max);
    let total_height = nodes.iter().map(|n| n.y + n.height).fold(1.0, f32::max);
    let legend =
        "实线：生育；长虚线：收养；短虚线：继亲；点线：监护；双线：伴侣。关系详情见人物框。";
    let legend_lines = book.font.lines(legend, 10.0, total_width, false);
    let single_height = total_height + 170.0 + legend_lines.len() as f32 * 16.0;
    if !tiled && (total_width + 100.0 > 14_400.0 || single_height > 14_400.0) {
        return Err(invalid(
            "单页挂图超过 5.08 米的安全纸张尺寸，请选择普通纸张分幅；字号不会自动缩小",
        ));
    }
    let view_width = if tiled { content_width } else { total_width };
    let view_height = if tiled { view_height } else { total_height };
    let step_x = view_width - overlap;
    let step_y = view_height - overlap;
    let columns = if tiled {
        ((total_width - overlap) / step_x).ceil().max(1.0) as usize
    } else {
        1
    };
    let rows = if tiled {
        ((total_height - overlap) / step_y).ceil().max(1.0) as usize
    } else {
        1
    };
    let count = columns
        .checked_mul(rows)
        .ok_or_else(|| invalid("挂图页数过多"))?;
    if count > 20_000 {
        return Err(invalid("挂图超过 20000 幅，请减少范围或增大纸张"));
    }
    if tiled {
        book.paragraph(&book.plan.title.clone(), 18.0, None);
        book.paragraph("世系图 · 分幅总览", 14.0, None);
        book.paragraph(
            &format!(
                "{} 人 · {} 条关系 · {rows} 行 × {columns} 列",
                selection.entries.len(),
                selection.relationships.len()
            ),
            11.0,
            None,
        );
        book.paragraph(
            &format!("按行从左到右拼接；重叠区 {:.0} mm。", overlap / MM),
            10.0,
            None,
        );
        book.paragraph(legend, 10.0, None);
        book.paragraph(
            "人物框完整保留；跨幅关系按人物编号与页码续接。世代未定不按伴侣推定。打印选择实际大小（100%），双面打印请关闭自动缩放。",
            10.0,
            None,
        );
        let group = (rows as f32 / 20.0).ceil().max(1.0) as usize;
        for row in (0..rows).step_by(group) {
            let end = (row + group).min(rows);
            let first = format!("tile:{}", row * columns);
            let last = format!("tile:{}", end * columns - 1);
            book.paragraph(
                &format!(
                    "行 {}-{}，列 1-{columns}，{} 至 {}",
                    row + 1,
                    end,
                    book.reference(&first),
                    book.reference(&last)
                ),
                10.0,
                Some(first),
            );
        }
    } else {
        book.pages.pop();
    }
    let start_page = book.pages.len() + 1;
    let tile_for = |node: &Node| -> usize {
        (node.y / step_y).floor() as usize * columns + (node.x / step_x).floor() as usize
    };
    for node in &nodes {
        let page = start_page + tile_for(node);
        book.anchors
            .entry(format!("chart:{}", node.id))
            .or_insert(page);
        book.anchors.entry(node.id.clone()).or_insert(page);
    }
    let mut indexed = BTreeMap::new();
    for node in &nodes {
        indexed.entry(node.id.as_str()).or_insert(node);
    }
    for row in 0..rows {
        for column in 0..columns {
            let index = row * columns + column;
            book.anchors
                .insert(format!("tile:{index}"), start_page + index);
            job.checkpoint("绘制世系图", index, count)?;
            if tiled {
                book.new_page();
            } else {
                book.pages.push(Sheet {
                    width: total_width + 100.0,
                    height: single_height,
                    heading: book.plan.title.clone(),
                    ops: Vec::new(),
                    traditional: false,
                });
            }
            let (x, y, _, _) = if tiled {
                book.bounds()
            } else {
                (50.0, 60.0, total_width, total_height)
            };
            let left = column as f32 * step_x;
            let upper = row as f32 * step_y;
            let continued = nodes
                .iter()
                .filter(|node| {
                    node.y < upper
                        && node.y + node.height > upper
                        && node.x < left + view_width
                        && node.x + node.width > left
                })
                .map(|node| format!("【{}】", node.number))
                .collect::<Vec<_>>()
                .join("");
            book.text_at(
                format!(
                    "拼接 {}/{} · 行 {} 列 {}{}",
                    index + 1,
                    count,
                    row + 1,
                    column + 1,
                    if continued.is_empty() {
                        String::new()
                    } else {
                        format!(" · 续{continued}")
                    }
                ),
                x,
                y + 12.0,
                10.0,
                None,
            );
            let top = y + 30.0;
            book.op(Draw::ClipStart {
                x,
                y: top,
                width: view_width,
                height: view_height,
            });
            for r in &selection.relationships {
                let a = indexed[string(r, "fromPersonId")];
                let b = indexed[string(r, "toPersonId")];
                // Only route edges within a generation band. Every other edge has explicit,
                // clickable continuation references in the receiving person card.
                if a.band != b.band
                    || (tiled && tile_for(a) != tile_for(b))
                    || (a.y - b.y).abs() > view_height * 1.5
                    || (a.x == b.x && (a.y - b.y).abs() > size * 20.0)
                {
                    continue;
                }
                let ax = a.x + a.width;
                let ay = a.y + size;
                let bx = b.x;
                let by = b.y + size;
                if ax.min(bx) > left + view_width
                    || ax.max(bx) < left
                    || ay.min(by) > upper + view_height
                    || ay.max(by) < upper
                {
                    continue;
                }
                let dash = match string(r, "type") {
                    "adoptive" => 1,
                    "step" => 2,
                    "guardian" => 3,
                    _ => 0,
                };
                let mid = if a.id == b.id {
                    ax + gap * 0.6
                } else {
                    (ax + bx) * 0.5
                };
                for delta in if string(r, "category") == "partner" {
                    vec![0.0, 3.0]
                } else {
                    vec![0.0]
                } {
                    for (sx, sy, tx, ty) in [
                        (ax, ay, mid, ay),
                        (mid, ay, mid, by + delta),
                        (mid, by + delta, bx, by + delta),
                    ] {
                        book.op(Draw::Line {
                            x: x + sx - left,
                            y: top + sy - upper,
                            to_x: x + tx - left,
                            to_y: top + ty - upper,
                            dash,
                        });
                    }
                }
            }
            for (label, ly) in &labels {
                if *ly >= upper && *ly < upper + view_height {
                    book.text_at(label, x - left, top + ly - upper + size, size, None);
                }
            }
            for node in &nodes {
                if node.x > left + view_width
                    || node.x + node.width < left
                    || node.y > upper + view_height
                    || node.y + node.height < upper
                {
                    continue;
                }
                let nx = x + node.x - left;
                let ny = top + node.y - upper;
                book.op(Draw::Rect {
                    x: nx,
                    y: ny,
                    width: node.width,
                    height: node.height,
                });
                for (i, (line, target)) in node.lines.iter().enumerate() {
                    book.text_at(
                        line,
                        nx + 8.0,
                        ny + size * 1.35 + i as f32 * size * 1.5,
                        size,
                        target.clone(),
                    );
                }
            }
            book.op(Draw::ClipEnd);
            if !tiled {
                for (line, text) in legend_lines.iter().enumerate() {
                    book.text_at(
                        text,
                        x,
                        top + total_height + 16.0 + line as f32 * 16.0,
                        10.0,
                        None,
                    );
                }
            }
        }
    }
    Ok(())
}
