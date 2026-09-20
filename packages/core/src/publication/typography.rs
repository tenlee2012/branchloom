use super::plan::invalid;
use crate::core::error::CoreResult;
use krilla::{
    geom::Point,
    surface::Surface,
    text::{Font, GlyphId, KrillaGlyph},
};

static FONT_BYTES: &[u8] = include_bytes!("../../assets/fonts/NotoSerifCJKsc-Regular.otf");

pub struct Typography {
    pub font: Font,
    face: ttf_parser::Face<'static>,
}

impl Typography {
    pub fn new() -> CoreResult<Self> {
        Ok(Self {
            font: Font::new(FONT_BYTES.into(), 0).ok_or_else(|| invalid("内置中文字体不可用"))?,
            face: ttf_parser::Face::parse(FONT_BYTES, 0)
                .map_err(|_| invalid("内置中文字体不可用"))?,
        })
    }

    pub fn width(&self, text: &str, size: f32) -> f32 {
        text.chars().map(|ch| self.advance(ch) * size).sum()
    }
    fn advance(&self, ch: char) -> f32 {
        self.face
            .glyph_index(ch)
            .and_then(|id| self.face.glyph_hor_advance(id))
            .map(|w| w as f32 / self.face.units_per_em() as f32)
            .unwrap_or(1.0)
    }

    pub fn lines(&self, text: &str, size: f32, width: f32, vertical: bool) -> Vec<String> {
        let mut lines = Vec::new();
        for paragraph in text.split('\n') {
            let mut line = String::new();
            let mut used = 0.0;
            for ch in paragraph.chars().filter(|ch| !ch.is_control()) {
                let advance = if vertical {
                    size
                } else {
                    self.advance(ch) * size
                };
                if used + advance > width && !line.is_empty() {
                    let mut carry = String::new();
                    if line.chars().count() > 1 {
                        let opening = line
                            .chars()
                            .last()
                            .is_some_and(|c| "（《「『【〈(\"".contains(c));
                        let closing = "，。！？；：、）》」』】〉,.!?;:)".contains(ch);
                        if opening || closing {
                            if let Some(last) = line.pop() {
                                carry.push(last);
                            }
                        }
                    }
                    // Keep ordinary Latin words together when they fit on one line.
                    if !vertical && ch.is_ascii_alphanumeric() {
                        let tail = line
                            .chars()
                            .rev()
                            .take_while(|c| c.is_ascii_alphanumeric())
                            .count();
                        if tail > 0 && tail < line.len() {
                            let split = line.len() - tail;
                            let word = line[split..].to_owned();
                            if self.width(&word, size) + advance < width {
                                line.truncate(split);
                                carry = word + &carry;
                            }
                        }
                    }
                    lines.push(std::mem::take(&mut line));
                    line = carry;
                    used = if vertical {
                        line.chars().count() as f32 * size
                    } else {
                        self.width(&line, size)
                    };
                }
                line.push(ch);
                used += advance;
            }
            lines.push(line);
        }
        lines
    }

    pub fn draw(
        &self,
        surface: &mut Surface<'_>,
        text: &str,
        x: f32,
        y: f32,
        size: f32,
        vertical: bool,
    ) -> CoreResult<()> {
        let resolved = text
            .char_indices()
            .map(|(index, ch)| {
                let display = if vertical { vertical_form(ch) } else { ch };
                self.face
                    .glyph_index(display)
                    .or_else(|| self.face.glyph_index(ch))
                    .map(|id| (index, ch, id))
                    .ok_or_else(|| {
                        invalid(format!(
                            "内置字体缺少字符「{ch}」（U+{:04X}），相关文字：{}",
                            ch as u32,
                            text.chars().take(60).collect::<String>()
                        ))
                    })
            })
            .collect::<CoreResult<Vec<_>>>()?;
        if vertical {
            surface.start_tagged(krilla::tagging::ContentTag::Span(
                krilla::tagging::SpanTag::empty().with_actual_text(Some(text)),
            ));
        }
        let mut glyphs = Vec::with_capacity(resolved.len());
        for (index, ch, id) in resolved {
            if vertical {
                let original = ch.to_string();
                let glyph = KrillaGlyph {
                    glyph_id: GlyphId::new(id.0 as u32),
                    text_range: 0..original.len(),
                    x_advance: 1.0,
                    x_offset: 0.0,
                    y_offset: 0.0,
                    y_advance: 0.0,
                    location: None,
                };
                let advance = self
                    .face
                    .glyph_hor_advance(id)
                    .unwrap_or(self.face.units_per_em()) as f32
                    / self.face.units_per_em() as f32;
                surface.draw_glyphs(
                    Point::from_xy(
                        x + (1.0 - advance) * size * 0.5,
                        y + glyphs.len() as f32 * size,
                    ),
                    std::slice::from_ref(&glyph),
                    self.font.clone(),
                    &original,
                    size,
                    false,
                );
                glyphs.push(glyph);
            } else {
                glyphs.push(KrillaGlyph {
                    glyph_id: GlyphId::new(id.0 as u32),
                    text_range: index..index + ch.len_utf8(),
                    x_advance: self.advance(ch),
                    x_offset: 0.0,
                    y_offset: 0.0,
                    y_advance: 0.0,
                    location: None,
                });
            }
        }
        if vertical {
            surface.end_tagged();
        }
        if !vertical {
            surface.draw_glyphs(
                Point::from_xy(x, y),
                &glyphs,
                self.font.clone(),
                text,
                size,
                false,
            );
        }
        Ok(())
    }
}

// Digits and Latin letters remain upright in individual cells. Presentation glyphs preserve
// the original Unicode text through KrillaGlyph's text range and the PDF ToUnicode mapping.
fn vertical_form(ch: char) -> char {
    match ch {
        '，' => '\u{fe10}',
        '、' => '\u{fe11}',
        '。' => '\u{fe12}',
        '：' => '\u{fe13}',
        '；' => '\u{fe14}',
        '！' => '\u{fe15}',
        '？' => '\u{fe16}',
        '（' => '\u{fe35}',
        '）' => '\u{fe36}',
        '《' => '\u{fe3d}',
        '》' => '\u{fe3e}',
        '「' => '\u{fe41}',
        '」' => '\u{fe42}',
        '『' => '\u{fe43}',
        '』' => '\u{fe44}',
        '【' => '\u{fe3b}',
        '】' => '\u{fe3c}',
        '…' => '\u{fe19}',
        _ => ch,
    }
}
