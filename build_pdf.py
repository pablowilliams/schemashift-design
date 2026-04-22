"""Render report.md into a professional academic PDF using reportlab."""

from __future__ import annotations

import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
)

from figures import FIGURES

HERE = Path(__file__).resolve().parent
SRC = HERE / "report.md"
OUT = HERE / "SchemaShift_Design_Report.pdf"


def make_styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    styles: dict[str, ParagraphStyle] = {}

    styles["TitleMain"] = ParagraphStyle(
        name="TitleMain",
        parent=base["Title"],
        fontName="Times-Bold",
        fontSize=22,
        leading=28,
        alignment=TA_CENTER,
        spaceAfter=18,
        textColor=colors.HexColor("#0a1f44"),
    )
    styles["Subtitle"] = ParagraphStyle(
        name="Subtitle",
        parent=base["Normal"],
        fontName="Times-Italic",
        fontSize=13,
        leading=18,
        alignment=TA_CENTER,
        spaceAfter=28,
        textColor=colors.HexColor("#333333"),
    )
    styles["Meta"] = ParagraphStyle(
        name="Meta",
        parent=base["Normal"],
        fontName="Times-Roman",
        fontSize=11,
        leading=14,
        alignment=TA_CENTER,
        spaceAfter=4,
        textColor=colors.HexColor("#555555"),
    )
    styles["H1"] = ParagraphStyle(
        name="H1",
        parent=base["Heading1"],
        fontName="Times-Bold",
        fontSize=16,
        leading=20,
        spaceBefore=20,
        spaceAfter=10,
        textColor=colors.HexColor("#0a1f44"),
        keepWithNext=1,
    )
    styles["H2"] = ParagraphStyle(
        name="H2",
        parent=base["Heading2"],
        fontName="Times-Bold",
        fontSize=13,
        leading=17,
        spaceBefore=14,
        spaceAfter=6,
        textColor=colors.HexColor("#0a1f44"),
        keepWithNext=1,
    )
    styles["H3"] = ParagraphStyle(
        name="H3",
        parent=base["Heading3"],
        fontName="Times-BoldItalic",
        fontSize=11.5,
        leading=15,
        spaceBefore=10,
        spaceAfter=4,
        textColor=colors.HexColor("#333333"),
        keepWithNext=1,
    )
    styles["Body"] = ParagraphStyle(
        name="Body",
        parent=base["BodyText"],
        fontName="Times-Roman",
        fontSize=11,
        leading=15,
        alignment=TA_JUSTIFY,
        spaceAfter=8,
        firstLineIndent=0,
    )
    styles["Bullet"] = ParagraphStyle(
        name="Bullet",
        parent=base["BodyText"],
        fontName="Times-Roman",
        fontSize=11,
        leading=15,
        alignment=TA_LEFT,
        spaceAfter=4,
        leftIndent=18,
    )
    styles["AbstractHeading"] = ParagraphStyle(
        name="AbstractHeading",
        parent=styles["H2"],
        alignment=TA_CENTER,
        spaceBefore=6,
    )
    styles["AbstractBody"] = ParagraphStyle(
        name="AbstractBody",
        parent=styles["Body"],
        fontName="Times-Italic",
        leftIndent=24,
        rightIndent=24,
        spaceAfter=10,
    )
    styles["Code"] = ParagraphStyle(
        name="Code",
        parent=base["Code"],
        fontName="Courier",
        fontSize=9,
        leading=11.5,
        leftIndent=18,
        rightIndent=18,
        spaceBefore=4,
        spaceAfter=8,
        textColor=colors.HexColor("#1c2536"),
        backColor=colors.HexColor("#f4f6fb"),
        borderColor=colors.HexColor("#c7cfe0"),
        borderWidth=0.5,
        borderPadding=6,
    )
    return styles


def escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def render_inline(text: str) -> str:
    text = escape_xml(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)\*(?!\*)", r"<i>\1</i>", text)
    text = re.sub(r"`(.+?)`", r'<font face="Courier">\1</font>', text)
    text = re.sub(
        r"\[(.+?)\]\((https?://[^)]+)\)",
        r'<link href="\2"><font color="#0a1f44"><u>\1</u></font></link>',
        text,
    )
    text = re.sub(
        r"(?<![\"(>])(https?://[^\s<]+)",
        r'<link href="\1"><font color="#0a1f44"><u>\1</u></font></link>',
        text,
    )
    return text


def build_story(md_path: Path, styles: dict[str, ParagraphStyle]) -> list:
    lines = md_path.read_text(encoding="utf-8").splitlines()
    story: list = []

    idx = 0

    def skip_blank() -> None:
        nonlocal idx
        while idx < len(lines) and not lines[idx].strip():
            idx += 1

    skip_blank()
    title = ""
    if idx < len(lines) and lines[idx].startswith("# "):
        title = lines[idx][2:].strip()
        idx += 1
    skip_blank()

    subtitle = ""
    if idx < len(lines) and lines[idx].startswith("**") and lines[idx].endswith("**"):
        subtitle = lines[idx].strip("*").strip()
        idx += 1
    skip_blank()

    meta_lines: list[str] = []
    while idx < len(lines) and lines[idx].strip() not in ("---", ""):
        meta_lines.append(lines[idx].strip())
        idx += 1
    while idx < len(lines) and lines[idx].strip() in ("", "---"):
        idx += 1

    # --- Title page ---
    story.append(Spacer(1, 1.3 * inch))
    story.append(Paragraph(escape_xml(title), styles["TitleMain"]))
    if subtitle:
        story.append(Paragraph(escape_xml(subtitle), styles["Subtitle"]))
    story.append(Spacer(1, 0.4 * inch))
    for m in meta_lines:
        story.append(Paragraph(render_inline(m), styles["Meta"]))
    story.append(Spacer(1, 0.6 * inch))
    story.append(
        HRFlowable(width="50%", thickness=0.7, color=colors.HexColor("#888888"), hAlign="CENTER")
    )
    story.append(Spacer(1, 0.3 * inch))
    story.append(
        Paragraph(
            "A technical design and specification report for an ML-assisted database "
            "migration safety review system.",
            styles["Meta"],
        )
    )
    story.append(PageBreak())

    # --- Body ---
    paragraph_buffer: list[str] = []
    bullet_buffer: list[str] = []
    in_code = False
    code_buffer: list[str] = []

    def flush_paragraph() -> None:
        if paragraph_buffer:
            text = " ".join(paragraph_buffer).strip()
            if text:
                style = styles["Body"]
                if story and isinstance(story[-1], Paragraph) and story[-1].style.name == "AbstractHeading":
                    style = styles["AbstractBody"]
                story.append(Paragraph(render_inline(text), style))
            paragraph_buffer.clear()

    def flush_bullets() -> None:
        if bullet_buffer:
            items = [
                ListItem(
                    Paragraph(render_inline(b), styles["Bullet"]),
                    leftIndent=12,
                    bulletColor=colors.HexColor("#0a1f44"),
                )
                for b in bullet_buffer
            ]
            story.append(
                ListFlowable(
                    items,
                    bulletType="bullet",
                    start="•",
                    leftIndent=14,
                    bulletFontName="Times-Roman",
                )
            )
            story.append(Spacer(1, 4))
            bullet_buffer.clear()

    def flush_code() -> None:
        nonlocal in_code
        if code_buffer:
            story.append(Preformatted("\n".join(code_buffer), styles["Code"]))
            code_buffer.clear()
        in_code = False

    def emit_heading(level: int, text: str) -> None:
        flush_paragraph()
        flush_bullets()
        style_name = {1: "H1", 2: "H2", 3: "H3"}.get(level, "H3")
        is_abstract = text.strip().lower() == "abstract"
        if is_abstract:
            story.append(Paragraph(escape_xml(text), styles["AbstractHeading"]))
        else:
            p = Paragraph(escape_xml(text), styles[style_name])
            story.append(p)

    while idx < len(lines):
        line = lines[idx]
        stripped = line.strip()

        # Fenced code blocks
        if stripped.startswith("```"):
            if in_code:
                flush_code()
            else:
                flush_paragraph()
                flush_bullets()
                in_code = True
            idx += 1
            continue

        if in_code:
            code_buffer.append(line)
            idx += 1
            continue

        if stripped == "---":
            flush_paragraph()
            flush_bullets()
            story.append(Spacer(1, 6))
            story.append(HRFlowable(width="100%", thickness=0.4, color=colors.HexColor("#cccccc")))
            story.append(Spacer(1, 6))
            idx += 1
            continue

        if stripped.startswith("### "):
            emit_heading(3, stripped[4:].strip())
            idx += 1
            continue
        if stripped.startswith("## "):
            emit_heading(2, stripped[3:].strip())
            idx += 1
            continue
        if stripped.startswith("# "):
            emit_heading(1, stripped[2:].strip())
            idx += 1
            continue

        if stripped.startswith("[FIGURE:") and stripped.endswith("]"):
            flush_paragraph()
            flush_bullets()
            key = stripped[len("[FIGURE:") : -1].strip()
            factory = FIGURES.get(key)
            if factory is not None:
                drawing = factory()
                drawing.hAlign = "CENTER"
                story.append(Spacer(1, 8))
                story.append(KeepTogether(drawing))
                story.append(Spacer(1, 10))
            idx += 1
            continue

        if stripped.startswith("- "):
            flush_paragraph()
            bullet_buffer.append(stripped[2:].strip())
            idx += 1
            continue

        if not stripped:
            flush_paragraph()
            flush_bullets()
            idx += 1
            continue

        paragraph_buffer.append(stripped)
        idx += 1

    flush_paragraph()
    flush_bullets()
    flush_code()

    return story


class TocDocTemplate(SimpleDocTemplate):
    """Auto-registers H2/H3 paragraphs into the PDF sidebar outline."""

    _counter: int = 0

    def afterFlowable(self, flowable) -> None:  # type: ignore[override]
        if not isinstance(flowable, Paragraph):
            return
        style_name = flowable.style.name
        if style_name not in ("H2", "H3"):
            return
        text = flowable.getPlainText()
        level = 0 if style_name == "H2" else 1
        self._counter += 1
        key = f"toc_{self._counter}"
        self.canv.bookmarkPage(key)
        try:
            self.canv.addOutlineEntry(text, key, level, 0)
        except ValueError:
            pass


def on_page(canvas, doc) -> None:
    canvas.saveState()
    canvas.setFont("Times-Roman", 9)
    canvas.setFillColor(colors.HexColor("#666666"))
    canvas.drawCentredString(LETTER[0] / 2, 0.5 * inch, f"{doc.page}")
    if doc.page > 1:
        canvas.setFont("Times-Italic", 9)
        canvas.setFillColor(colors.HexColor("#888888"))
        canvas.drawString(
            0.9 * inch,
            LETTER[1] - 0.55 * inch,
            "SchemaShift — Technical Design and Specification Report",
        )
        canvas.line(
            0.9 * inch,
            LETTER[1] - 0.62 * inch,
            LETTER[0] - 0.9 * inch,
            LETTER[1] - 0.62 * inch,
        )
    canvas.restoreState()


def build() -> Path:
    styles = make_styles()
    doc = TocDocTemplate(
        str(OUT),
        pagesize=LETTER,
        leftMargin=0.9 * inch,
        rightMargin=0.9 * inch,
        topMargin=0.9 * inch,
        bottomMargin=0.9 * inch,
        title="SchemaShift: A Technical Design and Specification Report",
        author="Project Proposal",
        subject="Machine-learning-assisted database migration safety review",
    )
    story = build_story(SRC, styles)
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return OUT


if __name__ == "__main__":
    out = build()
    print(f"Wrote {out} ({out.stat().st_size / 1024:.1f} KB)")
