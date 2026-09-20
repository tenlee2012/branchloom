use super::*;
use crate::{
    application::ApplicationService,
    core::project::NewProject,
    project_format::{ProjectTree, PROJECT_COLLECTIONS},
};
use plan::{Appendix, Chapter, Chart, Format, Illustration, Paper, Scope, ScopeMode};
use sha2::{Digest, Sha256};

fn id(number: usize) -> String {
    Uuid::from_u128(number as u128 + 1).to_string()
}
fn plan(format: Format) -> PublicationPlan {
    PublicationPlan {id:id(900_001),name:"测试编印方案".into(),format,title:"林氏测试族谱".into(),subtitle:"虚构资料 · 排版验收".into(),editor:"测试编修组".into(),edition:"校对本".into(),date:"2026 年秋".into(),preface:"本谱全部使用虚构人物。编印校对：简繁汉字、标点（括号）、《书名》、English 2026。\n资料中的不确定日期与关系按原貌保留。".into(),
        scope:Scope{mode:ScopeMode::All,roots:vec![],generations:None,start_generation:1,partners:true,parent_types:vec!["biological".into(),"adoptive".into(),"step".into(),"guardian".into()],exclude:vec![]},
        chapters:vec![Chapter::Cover,Chapter::Preface,Chapter::Contents,Chapter::Tree,Chapter::Biographies,Chapter::Events,Chapter::Sources,Chapter::Appendices,Chapter::Index],
        fields:["names","status","dates","places","biography","relationships","careers","titles","photos","citations"].into_iter().map(String::from).collect(),
        paper:Paper{width_mm:210.0,height_mm:297.0,margin_mm:18.0,gutter_mm:8.0,font_size:if format==Format::Traditional{14.0}else{12.0},duplex:true},
        chart:Chart{tiled:true,font_size:10.0,overlap_mm:5.0},cover_attachment_id:None,images:vec![],appendices:vec![],
    }
}

fn fixture(count: usize) -> ProjectData {
    let project_id = id(900_000);
    let mut data = ProjectData {
        project: json!({"id":project_id,"name":"林氏测试项目","description":"仅包含虚构资料","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","backupSchedule":"off"}),
        collections: PROJECT_COLLECTIONS
            .iter()
            .map(|(name, _, _)| (name.to_string(), vec![]))
            .collect(),
    };
    for i in 0..count {
        data.collections.get_mut("people").unwrap().push(json!({"id":id(i),"projectId":project_id,"names":[{"value":format!("林测试{:05}",i),"type":"personal","primary":true},{"value":format!("思齐{:05}",i),"type":"courtesy","primary":false}],"sex":if i%2==0{"female"}else{"male"},"status":"unknown","birth":{"display":"约 1900 年","precision":"about","start":"1900-01-01"},"birthPlaceId":id(900_010),"biography":"此人为虚构的校对样本。曾从事地方教育与档案整理，资料中保留不同年代的称谓和模糊日期。姓名、照片、经历都用于检验分页，并非真实人物传记。\n繁體校對：家譜、親屬、傳記。混排 English 2026；标点《书名》（说明）。","notes":"不应默认入册的备注","updatedAt":"2026-01-01T00:00:00Z"}));
        if i > 0 && i + 1 < count {
            let parent = if count < 100 {
                (i - 1) / 3
            } else if i < count * 4 / 10 {
                0
            } else if i < count * 7 / 10 {
                i - 1
            } else {
                (i / 12) * 12
            };
            data.collections.get_mut("relationships").unwrap().push(json!({"id":id(100_000+i),"projectId":project_id,"category":"parent","type":(["biological","adoptive","step","guardian"][i%4]),"fromPersonId":id(parent),"toPersonId":id(i),"notes":"","sourceIds":[]}));
        }
        if i % 50 == 0 {
            data.collections.get_mut("careers").unwrap().push(json!({"id":id(200_000+i),"projectId":project_id,"personId":id(i),"category":"employment","positionTitle":"教师","organizationId":id(900_011),"status":"former","description":"地方教育与文献整理。","notes":"","sourceIds":[id(900_012)]}));
            data.collections.get_mut("citations").unwrap().push(json!({"id":id(300_000+i),"projectId":project_id,"sourceId":id(900_012),"targetType":"person","targetId":id(i),"locator":"原书第 12 页","excerpt":"据测试手稿记载。","notes":""}));
        }
        if i % 100 == 0 {
            data.collections.get_mut("events").unwrap().push(json!({"id":id(400_000+i),"projectId":project_id,"type":"other","title":"整理家族档案","date":{"display":"约 1950 年","start":"1950-01-01","precision":"about"},"participantIds":[id(i)],"sourceIds":[id(900_012)],"notes":"虚构事件，用于检验时间线分页。"}));
        }
    }
    data.collections.get_mut("places").unwrap().push(
        json!({"id":id(900_010),"projectId":project_id,"name":"测试村","aliases":[],"notes":""}),
    );
    data.collections.get_mut("organizations").unwrap().push(json!({"id":id(900_011),"projectId":project_id,"name":"测试学校","type":"education","aliases":[],"notes":"","sourceIds":[]}));
    data.collections.get_mut("sources").unwrap().push(json!({"id":id(900_012),"projectId":project_id,"title":"测试手稿","type":"book","author":"虚构编者","repository":"测试档案室","notes":"非真实史料"}));
    data
}

fn job() -> Job {
    Job {
        project_id: id(900_000),
        cancel: AtomicBool::new(false),
        status: Mutex::new(Status {
            state: "running".into(),
            stage: "".into(),
            completed: 0,
            total: 0,
            revision: 1,
            pages: 0,
            bytes: 0,
            error: None,
        }),
        report: Mutex::new(None),
        directory: tempfile::tempdir().unwrap(),
    }
}

// A real two-page source with rotated/differently sized pages and a document-level action.
// Import must preserve the pages' appearance without carrying over the action.
fn source_pdf() -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R /OpenAction 8 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>".to_string(),
        pdf_stream("BT /F1 20 Tf 20 150 Td (Source page ONE) Tj ET"),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Rotate 90 /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>".to_string(),
        pdf_stream("BT /F1 20 Tf 20 90 Td (Source page TWO) Tj ET"),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        r"<< /S /JavaScript /JS (app.alert\(test\)) >>".to_string(),
    ];
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = vec![0];
    for (i, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
    }
    let start = bytes.len();
    bytes.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets.into_iter().skip(1) {
        bytes.extend(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    bytes
}
fn pdf_stream(value: &str) -> String {
    format!("<< /Length {} >>\nstream\n{value}\nendstream", value.len())
}

fn add_asset(
    data: &mut ProjectData,
    paths: &mut BTreeMap<String, PathBuf>,
    directory: &Path,
    number: usize,
    name: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> String {
    let id = id(number);
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let path = directory.join(&hash);
    fs::write(&path, &bytes).unwrap();
    paths.insert(id.clone(), path);
    data.collections.get_mut("attachments").unwrap().push(json!({"id":id,"projectId":data.project["id"],"name":name,"mimeType":mime,"size":bytes.len(),"contentHash":hash,"missing":false}));
    id
}

fn media(
    data: &mut ProjectData,
    plan: &mut PublicationPlan,
    directory: &Path,
) -> BTreeMap<String, PathBuf> {
    let mut paths = BTreeMap::new();
    let mut bytes = std::io::Cursor::new(Vec::new());
    let photo = image::RgbImage::from_fn(320, 480, |x, y| {
        image::Rgb([(x % 255) as u8, (y % 255) as u8, 180])
    });
    image::DynamicImage::ImageRgb8(photo)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let image = add_asset(
        data,
        &mut paths,
        directory,
        900_030,
        "比例测试图片.png",
        "image/png",
        bytes.into_inner(),
    );
    plan.cover_attachment_id = Some(image.clone());
    let photo_people: Vec<_> = data.collections["people"]
        .iter()
        .step_by(100)
        .map(|person| person["id"].as_str().unwrap().to_owned())
        .collect();
    let distinct_photos = photo_people.len() > 1;
    for (index, person_id) in photo_people.into_iter().enumerate() {
        let photo_id = if distinct_photos {
            let texture = image::RgbImage::from_fn(600, 900, |x, y| {
                image::Rgb([
                    ((x + index as u32 * 17) % 255) as u8,
                    ((y + index as u32 * 31) % 255) as u8,
                    ((x / 7 + y / 5 + index as u32 * 13) % 255) as u8,
                ])
            });
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(texture)
                .write_to(&mut bytes, image::ImageFormat::Jpeg)
                .unwrap();
            add_asset(
                data,
                &mut paths,
                directory,
                910_000 + index,
                &format!("虚构照片{index}.jpg"),
                "image/jpeg",
                bytes.into_inner(),
            )
        } else {
            image.clone()
        };
        plan.images.push(Illustration {
            attachment_id: photo_id,
            person_id: Some(person_id),
            caption: "竖幅图片应保持 2:3 比例。".into(),
        });
    }
    let pdf = add_asset(
        data,
        &mut paths,
        directory,
        900_031,
        "附录测试.pdf",
        "application/pdf",
        source_pdf(),
    );
    plan.appendices = vec![Appendix {
        attachment_id: pdf,
        pages: "2,1,2".into(),
    }];
    paths
}

#[test]
fn pages_preserve_order_and_reject_invalid_or_excessive_ranges() {
    assert_eq!(plan::parse_pages("3,1-2,3", 3).unwrap(), vec![2, 0, 1, 2]);
    for text in [
        "",
        "0",
        "3-2",
        "1-",
        "1,",
        "1-10001",
        "999999999999999999999",
    ] {
        assert!(plan::parse_pages(text, 3).is_err(), "{text}");
    }
}

#[test]
fn photo_orientation_is_applied_and_jpeg_stays_compressed() {
    let directory = tempfile::tempdir().unwrap();
    let mut data = fixture(3);
    let mut plan = plan(Format::Modern);
    let mut paths = BTreeMap::new();
    let image = add_asset(
        &mut data,
        &mut paths,
        directory.path(),
        900_030,
        "旋转照片.jpg",
        "image/jpeg",
        include_bytes!("fixtures/orientation-6.jpg").to_vec(),
    );
    plan.cover_attachment_id = Some(image.clone());
    let selection = selection::select(&data, &plan).unwrap();
    let assets = render::prepare(&data, &plan, &selection, &paths, &job()).unwrap();
    assert_eq!(assets.image_sizes[&image], (90.0, 60.0));
    let (bytes, _) = render::generate(&data, &plan, &paths, &job()).unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("/DCTDecode"));
}

#[test]
fn selection_is_complete_deterministic_and_handles_cycles_and_direct_partners() {
    let mut data = fixture(20);
    let p = plan(Format::Modern);
    data.collections.get_mut("relationships").unwrap().extend([
        json!({"id":id(500_000),"fromPersonId":id(0),"toPersonId":id(0),"category":"parent","type":"guardian"}),
        json!({"id":id(500_001),"fromPersonId":id(0),"toPersonId":id(18),"category":"partner","type":"married"}),
        json!({"id":id(500_002),"fromPersonId":id(18),"toPersonId":id(19),"category":"partner","type":"divorced"}),
    ]);
    let all = selection::select(&data, &p).unwrap();
    assert_eq!(all.entries.len(), 20);
    assert!(!all.issues.is_empty());
    let mut p = p;
    p.scope.mode = ScopeMode::Descendants;
    p.scope.roots = vec![id(0)];
    p.scope.generations = Some(1);
    let selected = selection::select(&data, &p).unwrap();
    assert_eq!(selected.entries.len(), 2);
    assert!(selected.entries.iter().all(|p| p.id != id(19)));
    p.scope.exclude = vec![id(18)];
    assert_eq!(selection::select(&data, &p).unwrap().entries.len(), 1);
    let mut reversed = data.clone();
    for values in reversed.collections.values_mut() {
        values.reverse();
    }
    assert_eq!(
        serde_json::to_value(selection::select(&data, &p).unwrap().entries).unwrap(),
        serde_json::to_value(selection::select(&reversed, &p).unwrap().entries).unwrap()
    );
    p.scope.mode = ScopeMode::All;
    p.scope.exclude.clear();
    assert_eq!(
        selection::select(&data, &p).unwrap().relationships,
        selection::select(&reversed, &p).unwrap().relationships
    );
}

#[test]
fn actual_pdfs_cover_all_formats_media_links_and_appendix_order() {
    for format in [Format::Modern, Format::Traditional, Format::Chart] {
        let directory = tempfile::tempdir().unwrap();
        let mut data = fixture(18);
        let mut plan = plan(format);
        let assets = media(&mut data, &mut plan, directory.path());
        let before = data.clone();
        let (bytes, report) = render::generate(&data, &plan, &assets, &job()).unwrap();
        assert_eq!(data, before);
        assert_eq!(report.people, 18);
        assert!(report.entries.iter().all(|entry| entry.page.is_some()));
        let pdf = inspect_pdf(bytes.clone()).unwrap();
        assert_eq!(pdf.pages().len(), report.pages);
        assert!(report.pages > 3);
        let raw = String::from_utf8_lossy(&bytes);
        assert!(raw.contains("/ToUnicode"));
        assert!(raw.contains("/FontFile3"));
        assert!(raw.contains("/Subtype /Link") || raw.contains("/Subtype/Link"));
        assert!(!raw.contains("/JavaScript"));
        assert!(!raw.contains("/OpenAction"));
        let (_, again) = render::generate(&data, &plan, &assets, &job()).unwrap();
        assert_eq!(report.pages, again.pages);
        assert_eq!(
            serde_json::to_value(&report.entries).unwrap(),
            serde_json::to_value(&again.entries).unwrap()
        );
        if let Ok(output) = std::env::var("BRANCHLOOM_PUBLICATION_SAMPLES_DIR") {
            let output = Path::new(&output);
            assert!(output.is_absolute());
            fs::create_dir_all(output).unwrap();
            fs::write(output.join(format!("{format:?}.pdf")), bytes).unwrap();
            fs::write(
                output.join(format!("{format:?}.json")),
                serde_json::to_vec_pretty(&report).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn isolated_people_do_not_inherit_a_generation_from_a_partner() {
    let mut data = fixture(5);
    data.collections.get_mut("relationships").unwrap().push(json!({"id":id(800_000),"fromPersonId":id(2),"toPersonId":id(4),"category":"partner","type":"married"}));
    let mut p = plan(Format::Modern);
    let selection = selection::select(&data, &p).unwrap();
    assert_eq!(
        selection
            .entries
            .iter()
            .find(|e| e.id == id(4))
            .unwrap()
            .generation,
        None
    );
    assert!(selection
        .issues
        .iter()
        .any(|issue| issue.target_id == id(4) && issue.code == "generation-unknown"));
    p.scope.roots = vec![id(4)];
    p.scope.start_generation = 9;
    assert_eq!(
        selection::select(&data, &p)
            .unwrap()
            .entries
            .iter()
            .find(|e| e.id == id(4))
            .unwrap()
            .generation,
        Some(9)
    );
}

#[test]
fn appendix_chapter_starts_on_an_imported_page_without_a_blank_title_sheet() {
    let font = typography::Typography::new().unwrap();
    let refs = BTreeMap::new();
    for format in [Format::Modern, Format::Traditional] {
        let directory = tempfile::tempdir().unwrap();
        let mut data = fixture(3);
        let mut p = plan(format);
        let paths = media(&mut data, &mut p, directory.path());
        p.chapters = vec![Chapter::Appendices];
        let selection = selection::select(&data, &p).unwrap();
        let work = job();
        let assets = render::prepare(&data, &p, &selection, &paths, &work).unwrap();
        let book = layout::book(&data, &p, &selection, &assets, &font, &refs, &work).unwrap();
        assert_eq!(book.pages.len(), 3);
        assert_eq!(book.anchors[&layout::chapter_key(Chapter::Appendices)], 1);
        for (page, index) in book.pages.iter().zip([1, 0, 1]) {
            assert!(page
                .ops
                .iter()
                .any(|op| matches!(op,layout::Draw::Pdf{index:i,..} if *i==index)));
        }
    }
}

#[test]
fn printed_records_omit_empty_chapters_keep_context_and_sort_bounded_dates() {
    use layout::Draw;
    let mut data = fixture(5);
    data.collections.get_mut("events").unwrap().clear();
    for (i, display, start, end) in [
        (0, "2015年", "2015", "2015"),
        (1, "2012年以前", "", "2012"),
        (2, "日期待考", "", ""),
    ] {
        data.collections.get_mut("events").unwrap().push(json!({"id":id(810_000+i),"title":format!("校对事件{i}"),"date":{"display":display,"start":start,"end":end},"participantIds":[id(0)],"sourceIds":[id(900_012)],"notes":format!("事件正文{i}")}));
    }
    let font = typography::Typography::new().unwrap();
    let assets = render::Assets::default();
    let refs = BTreeMap::new();
    for format in [Format::Modern, Format::Traditional] {
        let mut p = plan(format);
        p.preface.clear();
        p.paper.height_mm = 180.0;
        let selection = selection::select(&data, &p).unwrap();
        let work = job();
        let book = layout::book(&data, &p, &selection, &assets, &font, &refs, &work).unwrap();
        assert!(!book
            .anchors
            .contains_key(&layout::chapter_key(Chapter::Preface)));
        assert!(!book
            .anchors
            .contains_key(&layout::chapter_key(Chapter::Appendices)));
        let texts: Vec<String> = book
            .pages
            .iter()
            .map(|p| {
                p.ops
                    .iter()
                    .filter_map(|op| match op {
                        Draw::Text { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .collect();
        let all = texts.join("");
        assert!(all.find("校对事件1").unwrap() < all.find("校对事件0").unwrap());
        assert!(all.find("校对事件0").unwrap() < all.find("校对事件2").unwrap());
        for i in 0..3 {
            let page = texts
                .iter()
                .find(|s| s.contains(&format!("校对事件{i}")))
                .unwrap();
            assert!(
                page.contains(&format!("事件正文{i}")),
                "short events must remain intact"
            );
        }
        assert!(all.contains("来源：《测试手稿》"));
        for entry in selection.entries {
            assert!(texts[book.anchors[&entry.id] - 1]
                .contains(&format!("【{}】{}", entry.number, entry.name)));
        }
        p.chapters = vec![Chapter::Preface, Chapter::Appendices];
        assert!(layout::book(
            &data,
            &p,
            &selection::select(&data, &p).unwrap(),
            &assets,
            &font,
            &refs,
            &work
        )
        .is_err());
    }
}

#[test]
fn tiled_charts_never_cut_person_cards_at_page_boundaries() {
    use layout::Draw;
    let mut data = fixture(70);
    // More relationships than a single card can hold must flow into labelled continuation cards.
    for i in 1..50 {
        data.collections.get_mut("relationships").unwrap().push(json!({"id":id(820_000+i),"fromPersonId":id(i),"toPersonId":id(69),"category":"parent","type":"guardian"}));
    }
    let font = typography::Typography::new().unwrap();
    let mut p = plan(Format::Chart);
    p.paper.width_mm = 160.0;
    p.paper.height_mm = 220.0;
    let selection = selection::select(&data, &p).unwrap();
    let refs = BTreeMap::new();
    let mut book = layout::Layout::new(&p, &font, &refs);
    book.chapter(Chapter::Tree);
    charts::draw(&mut book, &selection, &job(), true).unwrap();
    let mut cards = 0;
    for sheet in book.pages {
        let mut clip = None;
        for op in sheet.ops {
            match op {
                Draw::ClipStart {
                    x,
                    y,
                    width,
                    height,
                } => clip = Some((x, y, width, height)),
                Draw::Rect {
                    x,
                    y,
                    width,
                    height,
                } => {
                    let (cx, cy, cw, ch) = clip.unwrap();
                    assert!(
                        x >= cx - 0.01
                            && y >= cy - 0.01
                            && x + width <= cx + cw + 0.01
                            && y + height <= cy + ch + 0.01,
                        "card must fit entirely within its sheet"
                    );
                    cards += 1;
                }
                _ => {}
            }
        }
    }
    assert!(
        cards > selection.entries.len(),
        "long cards are continued with context"
    );
}

#[test]
fn missing_glyph_assets_cancellation_and_oversized_single_chart_fail_explicitly() {
    let mut data = fixture(4);
    let plan = plan(Format::Modern);
    data.collections.get_mut("people").unwrap()[0]["biography"] = json!("缺字检验\u{10ffff}");
    assert!(render::generate(&data, &plan, &BTreeMap::new(), &job())
        .unwrap_err()
        .to_string()
        .contains("缺少字符"));
    let data = fixture(4);
    let cancelled = job();
    cancelled.cancel.store(true, Ordering::Relaxed);
    assert!(render::generate(&data, &plan, &BTreeMap::new(), &cancelled).is_err());
    let mut plan = plan;
    plan.cover_attachment_id = Some(id(4444));
    assert!(render::generate(&data, &plan, &BTreeMap::new(), &job()).is_err());
    assert!(inspect_pdf(b"not a pdf".to_vec()).is_err());
    for encrypted in [
        include_bytes!("fixtures/encrypted-password.pdf").as_slice(),
        include_bytes!("fixtures/encrypted-empty.pdf").as_slice(),
    ] {
        assert!(inspect_pdf(encrypted.to_vec())
            .err()
            .unwrap()
            .to_string()
            .contains("加密"));
    }
    plan.format = Format::Chart;
    plan.chart.tiled = false;
    let (_, report) = render::generate(&data, &plan, &BTreeMap::new(), &job()).unwrap();
    assert_eq!(report.pages, 1);
    assert!(
        render::generate(&fixture(1000), &plan, &BTreeMap::new(), &job())
            .unwrap_err()
            .to_string()
            .contains("单页挂图超过")
    );
}

#[test]
fn long_cover_caption_and_small_paper_keep_text_and_media_inside_pages() {
    use layout::Draw;
    let data = fixture(3);
    let font = typography::Typography::new().unwrap();
    for format in [Format::Modern, Format::Traditional] {
        let mut plan = plan(format);
        plan.paper.width_mm = 120.0;
        plan.paper.height_mm = 180.0;
        plan.title = "长标题测试".repeat(70);
        plan.cover_attachment_id = Some(id(900_030));
        plan.chapters = vec![Chapter::Cover, Chapter::Biographies, Chapter::Appendices];
        let mut assets = render::Assets::default();
        assets.image_sizes.insert(id(900_030), (320.0, 480.0));
        let caption = "完整图注需要分页而不能被图片遮住。".repeat(100);
        assets.plates.push((id(900_030), caption.clone()));
        let selection = selection::select(&data, &plan).unwrap();
        let refs = BTreeMap::new();
        let job = job();
        let book = layout::book(&data, &plan, &selection, &assets, &font, &refs, &job).unwrap();
        let mut all_text = String::new();
        for sheet in &book.pages {
            for op in &sheet.ops {
                match op {
                    Draw::Image {
                        x,
                        y,
                        width,
                        height,
                        ..
                    }
                    | Draw::Pdf {
                        x,
                        y,
                        width,
                        height,
                        ..
                    } => {
                        assert!(*width > 0.0 && *height > 0.0);
                        assert!(
                            *x >= 0.0
                                && *y >= 0.0
                                && x + width <= sheet.width
                                && y + height <= sheet.height
                        );
                    }
                    Draw::Text {
                        text,
                        x,
                        y,
                        size,
                        vertical,
                        ..
                    } => {
                        all_text.push_str(text);
                        assert!(*x >= 0.0 && *y >= *size, "{text}");
                        let (width, height) = if *vertical {
                            (
                                *size,
                                (text.chars().count().saturating_sub(1)) as f32 * size,
                            )
                        } else {
                            (font.width(text, *size), 0.0)
                        };
                        assert!(
                            x + width <= sheet.width && y + height <= sheet.height,
                            "{text}"
                        );
                    }
                    _ => {}
                }
            }
        }
        assert!(all_text.contains(&caption));
        assert!(all_text.contains(&plan.title));
    }
}

#[test]
fn plans_survive_upgrade_archive_roundtrip_and_revision_conflicts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("test.sqlite3");
    let mut service = ApplicationService::open(&path).unwrap();
    let project_id = id(900_000);
    service
        .create_project_with_id(
            project_id.clone(),
            NewProject {
                name: "测试项目".into(),
                description: String::new(),
            },
        )
        .unwrap();
    let revision = service.data_revision().unwrap();
    let plan = plan(Format::Traditional);
    service.publication_request(serde_json::from_value(json!({"operation":"savePlan","projectId":project_id,"plan":plan,"expectedRevision":revision})).unwrap()).unwrap();
    let conflict=service.publication_request(serde_json::from_value(json!({"operation":"deletePlan","projectId":project_id,"planId":plan.id,"expectedRevision":revision})).unwrap());
    assert!(conflict.is_err());
    assert_eq!(
        service
            .get_project(&project_id)
            .unwrap()
            .publication_plans
            .len(),
        1
    );
    let tree = service.export_project_tree(&project_id).unwrap();
    let exported = tree.parse_project_data().unwrap();
    assert_eq!(exported.project["publicationPlans"][0]["id"], plan.id);
    let archive = directory.path().join("with-plans.blp");
    service
        .export_project_archive(&project_id, &archive)
        .unwrap();
    let mut imported = ApplicationService::open(directory.path().join("imported.sqlite3")).unwrap();
    imported.import_project_archive(&archive, false).unwrap();
    assert_eq!(
        imported.get_project(&project_id).unwrap().publication_plans,
        service.get_project(&project_id).unwrap().publication_plans
    );
    drop(service);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 5).unwrap();
    drop(connection);
    let service = ApplicationService::open(&path).unwrap();
    assert_eq!(service.schema_version().unwrap(), 6);
    assert_eq!(
        service
            .get_project(&project_id)
            .unwrap()
            .publication_plans
            .len(),
        1
    );
    let tree = ProjectTree::new(tree.into_files()).unwrap();
    assert_eq!(tree.parse_project_data().unwrap(), exported);
}

#[test]
fn jobs_enforce_project_revision_ranges_and_preserve_existing_files() {
    let mut manager = Publications::default();
    let result = manager
        .start(
            id(900_000),
            9,
            plan(Format::Modern),
            fixture(4),
            BTreeMap::new(),
        )
        .unwrap();
    let job_id = result["jobId"].as_str().unwrap();
    let request = |operation: &str| {
        serde_json::from_value::<Request>(
            json!({"operation":operation,"projectId":id(900_000),"jobId":job_id}),
        )
        .unwrap()
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let status = manager.request(&request("status"), 9).unwrap();
        if status["state"] != "running" {
            assert_eq!(status["state"], "ready", "{status}");
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let mut wrong = request("status");
    wrong.project_id = id(900_099);
    assert!(manager.request(&wrong, 9).is_err());
    assert!(manager.request(&request("report"), 10).is_err());
    let mut read = request("read");
    read.offset = Some(0);
    read.length = Some(1_048_577);
    assert!(manager.request(&read, 9).is_err());
    read.length = Some(64);
    assert!(manager.request(&read, 9).unwrap()["data"]
        .as_str()
        .unwrap()
        .starts_with("JVBER"));
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("result.pdf");
    manager.save(&id(900_000), job_id, 9, &output).unwrap();
    let before = fs::read(&output).unwrap();
    assert!(manager.save(&id(900_000), job_id, 9, &output).is_err());
    assert_eq!(fs::read(&output).unwrap(), before);
    manager.invalidate(10);
    assert!(!manager.job(&id(900_000), job_id).unwrap().output().exists());
    let temporary = manager
        .job(&id(900_000), job_id)
        .unwrap()
        .directory
        .path()
        .to_owned();
    manager.request(&request("release"), 9).unwrap();
    assert!(!temporary.exists());
}

#[test]
fn releasing_a_running_job_cancels_and_removes_its_temporary_directory() {
    let mut manager = Publications::default();
    let result = manager
        .start(
            id(900_000),
            1,
            plan(Format::Traditional),
            fixture(10_000),
            BTreeMap::new(),
        )
        .unwrap();
    let id = result["jobId"].as_str().unwrap();
    let directory = manager
        .job(&self::id(900_000), id)
        .unwrap()
        .directory
        .path()
        .to_owned();
    let request = serde_json::from_value(
        json!({"operation":"release","projectId":self::id(900_000),"jobId":id}),
    )
    .unwrap();
    manager.request(&request, 1).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while directory.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "cancelled worker kept its temporary directory"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
#[ignore = "explicit 10000-person publication benchmark; writes only to an explicit temporary output directory"]
fn ten_thousand_people_complete_books_media_and_tiled_chart() {
    for (format, with_media) in [
        (Format::Modern, false),
        (Format::Modern, true),
        (Format::Traditional, false),
        (Format::Chart, false),
    ] {
        if std::env::var("BRANCHLOOM_PUBLICATION_BENCHMARK")
            .is_ok_and(|filter| filter != format!("{format:?}-{with_media}"))
        {
            continue;
        }
        let directory = tempfile::tempdir().unwrap();
        let mut data = fixture(10_000);
        let mut plan = plan(format);
        let assets = if with_media {
            media(&mut data, &mut plan, directory.path())
        } else {
            BTreeMap::new()
        };
        let start = std::time::Instant::now();
        let (bytes, report) = render::generate(&data, &plan, &assets, &job()).unwrap();
        assert_eq!(report.people, 10_000);
        assert_eq!(
            report
                .entries
                .iter()
                .map(|entry| &entry.id)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            10_000
        );
        assert_eq!(report.relationships, 9_998);
        assert_eq!(
            inspect_pdf(bytes.clone()).unwrap().pages().len(),
            report.pages
        );
        eprintln!("publication-benchmark format={format:?} media={with_media} people={} relationships={} pages={} elapsed_ms={} bytes={}",report.people,report.relationships,report.pages,start.elapsed().as_millis(),bytes.len());
        if let Ok(output) = std::env::var("BRANCHLOOM_PUBLICATION_SAMPLES_DIR") {
            let output = Path::new(&output);
            assert!(output.is_absolute());
            fs::create_dir_all(output).unwrap();
            fs::write(
                output.join(format!("10000-{format:?}-{with_media}.pdf")),
                bytes,
            )
            .unwrap();
        }
    }
}
