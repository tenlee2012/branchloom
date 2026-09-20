use super::{
    inspect_pdf,
    layout::{self, Draw, Layout, MM},
    plan::{invalid, Chapter, Format, PublicationPlan},
    read_asset,
    selection::{self, records, string, Selection},
    typography::Typography,
    Job, Report,
};
use crate::{core::error::CoreResult, project_format::ProjectData};
use image::ImageDecoder;
use krilla::{
    annotation::{Annotation, LinkAnnotation, Target},
    configure::{ConfigurationBuilder, PdfVersion},
    destination::XyzDestination,
    geom::{PathBuilder, Point, Rect, Size, Transform},
    image::Image,
    metadata::Metadata,
    outline::{Outline, OutlineNode},
    page::PageSettings,
    paint::{Fill, FillRule, Stroke, StrokeDash},
    pdf::PdfDocument,
    Document, SerializeSettings,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Cursor,
    path::PathBuf,
};

pub struct PdfAsset {
    pub document: PdfDocument,
    pub dimensions: Vec<(f32, f32)>,
    pub name: String,
}
#[derive(Default)]
pub struct Assets {
    pub images: BTreeMap<String, Image>,
    pub image_sizes: BTreeMap<String, (f32, f32)>,
    pub pdfs: BTreeMap<String, PdfAsset>,
    pub person_images: BTreeMap<String, Vec<(String, String)>>,
    pub plates: Vec<(String, String)>,
}

pub(super) fn prepare(
    data: &ProjectData,
    plan: &PublicationPlan,
    selection: &Selection,
    paths: &BTreeMap<String, PathBuf>,
    job: &Job,
) -> CoreResult<Assets> {
    let mut assets = Assets::default();
    if plan.format == Format::Chart {
        return Ok(assets);
    }
    let mut image_ids = BTreeSet::new();
    let selected: BTreeMap<_, _> = selection
        .entries
        .iter()
        .map(|e| (e.id.as_str(), e))
        .collect();
    let attachments: BTreeMap<_, _> = records(data, "attachments")
        .iter()
        .map(|v| (string(v, "id"), v))
        .collect();
    if plan.chapters.contains(&Chapter::Cover) {
        if let Some(id) = &plan.cover_attachment_id {
            image_ids.insert(id.clone());
        }
    }
    if plan.field("photos") && plan.chapters.contains(&Chapter::Biographies) {
        for link in records(data, "attachmentLinks") {
            if string(link, "targetType") == "person"
                && string(link, "role") == "avatar"
                && selected.contains_key(string(link, "targetId"))
            {
                let id = string(link, "attachmentId");
                image_ids.insert(id.into());
                assets
                    .person_images
                    .entry(string(link, "targetId").into())
                    .or_default()
                    .push((
                        id.into(),
                        format!(
                            "【{}】{}",
                            selected[string(link, "targetId")].number,
                            selected[string(link, "targetId")].name
                        ),
                    ));
            }
        }
    }
    for image in &plan.images {
        if let Some(person) = &image.person_id {
            if selected.contains_key(person.as_str())
                && plan.chapters.contains(&Chapter::Biographies)
            {
                image_ids.insert(image.attachment_id.clone());
                assets
                    .person_images
                    .entry(person.clone())
                    .or_default()
                    .push((image.attachment_id.clone(), image.caption.clone()));
            }
        } else if plan.chapters.contains(&Chapter::Appendices) {
            image_ids.insert(image.attachment_id.clone());
            assets
                .plates
                .push((image.attachment_id.clone(), image.caption.clone()));
        }
    }
    let bytes_for = |id: &str| -> CoreResult<Vec<u8>> {
        let attachment = attachments
            .get(id)
            .ok_or_else(|| invalid(format!("所选附件已不存在：{id}，请从方案中移除或重新选择")))?;
        if attachment["missing"] == true {
            return Err(invalid(format!(
                "附件缺失：{}，请在资料来源中重新定位后再编印",
                string(attachment, "name")
            )));
        }
        let path = paths.get(id).ok_or_else(|| invalid("附件存储位置不可用"))?;
        read_asset(path, string(attachment, "contentHash")).map_err(|_| {
            invalid(format!(
                "无法读取附件「{}」，请重新定位原文件后重试",
                string(attachment, "name")
            ))
        })
    };
    let mut retained = 0usize;
    for (index, id) in image_ids.iter().enumerate() {
        job.checkpoint("整理图片", index, image_ids.len())?;
        let bytes = bytes_for(id)?;
        let mut reader = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| invalid(e.to_string()))?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(64 * 1024 * 1024);
        limits.max_image_width = Some(16_000);
        limits.max_image_height = Some(16_000);
        let jpeg = reader.format() == Some(image::ImageFormat::Jpeg);
        let image_error = |_| {
            invalid(format!(
                "图片「{}」已损坏、格式不受支持或解码超过 64 MiB，请使用缩小后的图片",
                string(attachments[id.as_str()], "name")
            ))
        };
        reader.limits(limits.clone());
        let mut decoder = reader.into_decoder().map_err(image_error)?;
        limits.reserve(decoder.total_bytes()).map_err(image_error)?;
        decoder.set_limits(limits).map_err(image_error)?;
        let orientation = decoder.orientation().map_err(image_error)?;
        let mut decoded = image::DynamicImage::from_decoder(decoder).map_err(image_error)?;
        decoded.apply_orientation(orientation);
        let print_edge = (plan.paper.width_mm.max(plan.paper.height_mm) / 25.4 * 300.0)
            .ceil()
            .clamp(1.0, 6000.0) as u32;
        let resized = if decoded.width() <= print_edge && decoded.height() <= print_edge {
            decoded
        } else {
            decoded.thumbnail(print_edge, print_edge)
        };
        let (width, height) = (resized.width(), resized.height());
        let mut compressed = Vec::new();
        if jpeg {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut compressed, 90)
                .encode_image(&resized.to_rgb8())
                .map_err(image_error)?;
        } else {
            resized
                .write_to(&mut Cursor::new(&mut compressed), image::ImageFormat::Png)
                .map_err(image_error)?;
        }
        retained += compressed.len();
        if retained > 128 * 1024 * 1024 {
            return Err(invalid(
                "图片和 PDF 合计超过 128 MiB 的编印资源预算，请减少范围或压缩史料",
            ));
        }
        assets.images.insert(
            id.clone(),
            if jpeg {
                Image::from_jpeg(compressed.into(), true)
            } else {
                Image::from_png(compressed.into(), true)
            }
            .map_err(invalid)?,
        );
        assets
            .image_sizes
            .insert(id.clone(), (width as f32, height as f32));
    }
    if plan.chapters.contains(&Chapter::Appendices) {
        for (index, appendix) in plan.appendices.iter().enumerate() {
            job.checkpoint("检查 PDF 史料", index, plan.appendices.len())?;
            if assets.pdfs.contains_key(&appendix.attachment_id) {
                continue;
            }
            let bytes = bytes_for(&appendix.attachment_id)?;
            retained += bytes.len();
            if retained > 128 * 1024 * 1024 {
                return Err(invalid(
                    "图片和 PDF 超过 128 MiB 的编印资源预算，请减少范围或压缩史料",
                ));
            }
            let pdf = inspect_pdf(bytes)?;
            let dimensions = pdf
                .pages()
                .iter()
                .map(|p| p.render_dimensions())
                .collect::<Vec<_>>();
            if dimensions.iter().any(|(w, h)| {
                !w.is_finite()
                    || !h.is_finite()
                    || *w <= 0.0
                    || *h <= 0.0
                    || *w > 14_400.0
                    || *h > 14_400.0
            }) {
                return Err(invalid("PDF 原页尺寸异常，请更换该史料"));
            }
            assets.pdfs.insert(
                appendix.attachment_id.clone(),
                PdfAsset {
                    document: PdfDocument::new(pdf),
                    dimensions,
                    name: string(attachments[appendix.attachment_id.as_str()], "name").into(),
                },
            );
        }
    }
    Ok(assets)
}

pub fn generate(
    data: &ProjectData,
    plan: &PublicationPlan,
    paths: &BTreeMap<String, PathBuf>,
    job: &Job,
) -> CoreResult<(Vec<u8>, Report)> {
    plan.validate()?;
    job.checkpoint("整理资料", 0, 0)?;
    let mut selection = selection::select(data, plan)?;
    let assets = prepare(data, plan, &selection, paths, job)?;
    let font = Typography::new()?;
    let mut refs = BTreeMap::new();
    let mut final_pages = None;
    // Page references affect line wrapping; paginate until the complete anchor map is stable.
    for _ in 0..12 {
        let mut book = if plan.format == Format::Chart {
            let mut book = Layout::new(plan, &font, &refs);
            book.chapter(Chapter::Tree);
            book.heading = plan.title.clone();
            super::charts::draw(&mut book, &selection, job, true)?;
            book
        } else {
            layout::book(data, plan, &selection, &assets, &font, &refs, job)?
        };
        if book.pages.len() > 20_000 {
            return Err(invalid("成品超过 20000 页，请减少编印范围"));
        }
        if book.anchors == refs {
            final_pages = Some((
                std::mem::take(&mut book.pages),
                std::mem::take(&mut book.chapters),
            ));
            break;
        }
        let next = book.anchors.clone();
        drop(book);
        refs = next;
    }
    let (pages, chapters) =
        final_pages.ok_or_else(|| invalid("交叉引用分页未能收敛，请调整纸张或字号后重试"))?;
    let mut document = Document::new_with(SerializeSettings {
        configuration: ConfigurationBuilder::new()
            .with_version(PdfVersion::Pdf20)
            .finish()
            .map_err(|e| invalid(format!("PDF 配置无效：{e:?}")))?,
        ..Default::default()
    });
    document.set_metadata(
        Metadata::new()
            .title(plan.title.clone())
            .authors(vec![plan.editor.clone()])
            .creator("有谱 Branchloom".into())
            .language("zh-CN".into()),
    );
    let mut outline = Outline::new();
    for (key, title) in chapters {
        if let Some(page) = refs.get(&key) {
            outline.push_child(OutlineNode::new(
                title,
                XyzDestination::new(page - 1, Point::from_xy(0.0, 0.0)),
            ));
        }
    }
    document.set_outline(outline);
    for (index, sheet) in pages.iter().enumerate() {
        job.checkpoint("生成 PDF", index, pages.len())?;
        let mut page = document.start_page_with(
            PageSettings::from_wh(sheet.width, sheet.height)
                .ok_or_else(|| invalid("PDF 纸张尺寸无效"))?,
        );
        let mut links = Vec::new();
        {
            let mut surface = page.surface();
            surface.set_fill(Some(Fill::default()));
            let margin = plan.paper.margin_mm * MM;
            let header = font
                .lines(&sheet.heading, 9.0, sheet.width - 2.0 * margin, false)
                .into_iter()
                .next()
                .unwrap_or_default();
            if sheet.heading != Chapter::Cover.label() {
                font.draw(&mut surface, &header, margin, margin - 6.0, 9.0, false)?;
                font.draw(
                    &mut surface,
                    &format!("{} / {}", index + 1, pages.len()),
                    sheet.width * 0.5 - 18.0,
                    sheet.height - margin + 15.0,
                    9.0,
                    false,
                )?;
            }
            if sheet.traditional {
                for delta in [0.0, 3.0] {
                    rectangle(
                        &mut surface,
                        margin - delta,
                        margin - delta,
                        sheet.width - 2.0 * margin + delta * 2.0,
                        sheet.height - 2.0 * margin + delta * 2.0,
                        false,
                    );
                }
            }
            let mut clipping = None;
            for op in &sheet.ops {
                match op {
                    Draw::ClipStart {
                        x,
                        y,
                        width,
                        height,
                    } => {
                        let rect = Rect::from_xywh(*x, *y, *width, *height)
                            .ok_or_else(|| invalid("挂图裁切尺寸无效"))?;
                        let mut builder = PathBuilder::new();
                        builder.push_rect(rect);
                        surface.push_clip_path(
                            &builder
                                .finish()
                                .ok_or_else(|| invalid("挂图裁切区域无效"))?,
                            &FillRule::NonZero,
                        );
                        clipping = Some((*x, *y, *width, *height));
                    }
                    Draw::ClipEnd => {
                        surface.pop();
                        clipping = None;
                    }
                    Draw::Text {
                        text,
                        x,
                        y,
                        size,
                        vertical,
                        target,
                    } => {
                        surface.set_stroke(None);
                        surface.set_fill(Some(Fill::default()));
                        font.draw(&mut surface, text, *x, *y, *size, *vertical)?;
                        if let Some(destination) = target.as_ref().and_then(|id| refs.get(id)) {
                            let (mut rx, mut ry, mut rw, mut rh) = if *vertical {
                                (*x, *y - *size, *size, text.chars().count() as f32 * size)
                            } else {
                                (*x, *y - *size, font.width(text, *size), size * 1.3)
                            };
                            if let Some((cx, cy, cw, ch)) = clipping {
                                let right = (rx + rw).min(cx + cw);
                                let bottom = (ry + rh).min(cy + ch);
                                rx = rx.max(cx);
                                ry = ry.max(cy);
                                rw = right - rx;
                                rh = bottom - ry;
                            }
                            if let Some(rect) = Rect::from_xywh(rx, ry, rw, rh) {
                                links.push((rect, *destination));
                            }
                        }
                    }
                    Draw::Line {
                        x,
                        y,
                        to_x,
                        to_y,
                        dash,
                    } => {
                        let mut path = PathBuilder::new();
                        path.move_to(*x, *y);
                        path.line_to(*to_x, *to_y);
                        surface.set_fill(None);
                        surface.set_stroke(Some(Stroke {
                            width: 0.7,
                            dash: match dash {
                                1 => Some(StrokeDash {
                                    array: vec![7.0, 3.0],
                                    offset: 0.0,
                                }),
                                2 => Some(StrokeDash {
                                    array: vec![3.0, 3.0],
                                    offset: 0.0,
                                }),
                                3 => Some(StrokeDash {
                                    array: vec![1.0, 3.0],
                                    offset: 0.0,
                                }),
                                _ => None,
                            },
                            ..Default::default()
                        }));
                        if let Some(path) = path.finish() {
                            surface.draw_path(&path);
                        }
                    }
                    Draw::Rect {
                        x,
                        y,
                        width,
                        height,
                    } => rectangle(&mut surface, *x, *y, *width, *height, true),
                    Draw::Image {
                        id,
                        x,
                        y,
                        width,
                        height,
                    } => {
                        surface.push_transform(&Transform::from_translate(*x, *y));
                        surface.draw_image(
                            assets.images[id].clone(),
                            Size::from_wh(*width, *height)
                                .ok_or_else(|| invalid("图片尺寸无效"))?,
                        );
                        surface.pop();
                    }
                    Draw::Pdf {
                        id,
                        index,
                        x,
                        y,
                        width,
                        height,
                    } => {
                        surface.push_transform(&Transform::from_translate(*x, *y));
                        surface.draw_pdf_page(
                            &assets.pdfs[id].document,
                            Size::from_wh(*width, *height)
                                .ok_or_else(|| invalid("附录尺寸无效"))?,
                            *index,
                        );
                        surface.pop();
                    }
                }
            }
            surface.finish();
        }
        for (rect, target) in links {
            page.add_annotation(Annotation::new_link(
                LinkAnnotation::new(
                    rect,
                    Target::Destination(
                        XyzDestination::new(target - 1, Point::from_xy(0.0, 0.0)).into(),
                    ),
                ),
                None,
            ));
        }
        page.finish();
    }
    job.checkpoint("嵌入字体并封装", pages.len(), pages.len())?;
    let bytes = document
        .finish()
        .map_err(|e| invalid(format!("PDF 生成失败，请检查字体或附录：{e:?}")))?;
    job.checkpoint("完成", pages.len(), pages.len())?;
    for entry in &mut selection.entries {
        entry.page = refs.get(&entry.id).copied();
    }
    let report = Report {
        people: selection.entries.len(),
        relationships: selection.relationships.len(),
        branches: selection.branches,
        pages: pages.len(),
        entries: selection.entries,
        excluded: selection.excluded,
        issues: selection.issues,
        ..Default::default()
    };
    Ok((bytes, report))
}

fn rectangle(
    surface: &mut krilla::surface::Surface<'_>,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    white: bool,
) {
    if let Some(rect) = Rect::from_xywh(x, y, width, height) {
        surface.set_fill(if white {
            Some(Fill {
                paint: krilla::color::rgb::Color::new(255, 255, 255).into(),
                ..Default::default()
            })
        } else {
            None
        });
        surface.set_stroke(Some(Stroke {
            width: 0.6,
            ..Default::default()
        }));
        let mut builder = PathBuilder::new();
        builder.push_rect(rect);
        if let Some(path) = builder.finish() {
            surface.draw_path(&path);
        }
    }
}
