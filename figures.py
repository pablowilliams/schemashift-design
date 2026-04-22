"""Programmatic figures for the SchemaShift design report.

Each factory returns a reportlab Drawing that is embedded directly in the PDF.
Everything is vector; nothing is rasterised.
"""

from __future__ import annotations

from reportlab.graphics.shapes import (
    Drawing,
    Group,
    Line,
    Polygon,
    Rect,
    String,
)
from reportlab.lib import colors

# Palette -- same spine as PyOptimize (for visual family) but SchemaShift
# uses teal instead of gold for its continuous-deliverable accent, so the
# two projects are instantly recognisable side by side.
NAVY = colors.HexColor("#0a1f44")
STEEL = colors.HexColor("#2a3a5e")
INK = colors.HexColor("#1c2536")
MUTED = colors.HexColor("#5c6a82")
ACCENT = colors.HexColor("#0e7c86")
BG = colors.HexColor("#f4f6fb")
SOFT = colors.HexColor("#e4e8f1")
WHITE = colors.HexColor("#ffffff")
BORDER = colors.HexColor("#c7cfe0")


def _box(
    x: float,
    y: float,
    w: float,
    h: float,
    label: str,
    *,
    fill=WHITE,
    stroke=NAVY,
    text_color=INK,
    font_size: float = 9,
    bold: bool = False,
) -> Group:
    g = Group()
    g.add(Rect(x, y, w, h, fillColor=fill, strokeColor=stroke, strokeWidth=0.8, rx=3, ry=3))
    font = "Helvetica-Bold" if bold else "Helvetica"
    lines = label.split("\n")
    total_h = len(lines) * (font_size + 2)
    start_y = y + h / 2 + total_h / 2 - font_size
    for i, line in enumerate(lines):
        g.add(
            String(
                x + w / 2,
                start_y - i * (font_size + 2),
                line,
                fontName=font,
                fontSize=font_size,
                fillColor=text_color,
                textAnchor="middle",
            )
        )
    return g


def _arrow(x1: float, y1: float, x2: float, y2: float, color=STEEL) -> Group:
    g = Group()
    g.add(Line(x1, y1, x2, y2, strokeColor=color, strokeWidth=1.1))
    import math

    angle = math.atan2(y2 - y1, x2 - x1)
    ah = 5
    aw = 3
    tip_x, tip_y = x2, y2
    left_x = tip_x - ah * math.cos(angle) + aw * math.sin(angle)
    left_y = tip_y - ah * math.sin(angle) - aw * math.cos(angle)
    right_x = tip_x - ah * math.cos(angle) - aw * math.sin(angle)
    right_y = tip_y - ah * math.sin(angle) + aw * math.cos(angle)
    g.add(
        Polygon(
            points=[tip_x, tip_y, left_x, left_y, right_x, right_y],
            fillColor=color,
            strokeColor=color,
            strokeWidth=0.5,
        )
    )
    return g


def _caption(d: Drawing, text: str) -> None:
    d.add(
        String(
            d.width / 2,
            6,
            text,
            fontName="Helvetica-Oblique",
            fontSize=8.5,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )


# ---------------------------------------------------------------------------
# Figure 1 -- SchemaShift seven-stage pipeline
# ---------------------------------------------------------------------------
def figure_pipeline() -> Drawing:
    d = Drawing(460, 260)
    d.add(Rect(0, 0, 460, 260, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Row of inputs on the left
    d.add(_box(15, 200, 80, 30, "Migration\nfile(s)", fill=SOFT, bold=True))
    d.add(_box(15, 160, 80, 30, "Schema\ndump", fill=SOFT))
    d.add(_box(15, 120, 80, 30, "Metadata\nbundle", fill=SOFT))
    d.add(_box(15, 80, 80, 30, "Application\nrepo", fill=SOFT))

    # Stage column 1 -- analyser + context + scanner
    d.add(_box(115, 200, 90, 30, "Static\nAnalyser", fill=WHITE))
    d.add(_box(115, 160, 90, 30, "Context\nGatherer", fill=WHITE))
    d.add(_box(115, 120, 90, 30, "Call-site\nScanner", fill=WHITE))

    # Ingestion passthrough
    d.add(_box(115, 80, 90, 30, "Ingestion\nnormaliser", fill=WHITE))

    # Signal fusion
    d.add(_box(225, 150, 90, 40, "Signal\nFusion", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))

    # Reasoner + rewrite engine
    d.add(_box(335, 190, 110, 35, "LLM Reasoner +\nRewrite Engine", fill=WHITE))

    # Verifier gate
    d.add(_box(335, 135, 110, 35, "Verifier gate", fill=WHITE))

    # Reporting
    d.add(_box(225, 70, 90, 40, "Reporting", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))

    # Outputs
    d.add(_box(335, 70, 110, 30, "PDF review", fill=SOFT))
    d.add(_box(335, 30, 110, 30, "Dashboard", fill=SOFT))

    # Arrows from inputs into stage column 1
    d.add(_arrow(95, 215, 115, 215))
    d.add(_arrow(95, 175, 115, 175))
    d.add(_arrow(95, 135, 115, 135))
    d.add(_arrow(95, 95, 115, 95))

    # Arrows from stage column 1 into signal fusion
    d.add(_arrow(205, 215, 225, 185))
    d.add(_arrow(205, 175, 225, 175))
    d.add(_arrow(205, 135, 225, 165))
    d.add(_arrow(205, 95, 225, 155))

    # Fusion -> reasoner
    d.add(_arrow(315, 180, 335, 207))
    # Reasoner -> verifier
    d.add(_arrow(390, 190, 390, 170))
    # Verifier -> reporting
    d.add(_arrow(335, 150, 315, 110))
    # Reporting -> outputs
    d.add(_arrow(315, 95, 335, 85))
    d.add(_arrow(315, 85, 335, 45))

    _caption(d, "Figure 1. SchemaShift seven-stage pipeline. Four inputs feed three analyser stages; fusion drives a verifier-gated rewrite chain.")
    return d


# ---------------------------------------------------------------------------
# Figure 2 -- Risk score components
# ---------------------------------------------------------------------------
def figure_risk_score() -> Drawing:
    d = Drawing(460, 170)
    d.add(Rect(0, 0, 460, 170, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Four input factors
    d.add(_box(20, 130, 100, 28, "Rule severity", fill=WHITE))
    d.add(_box(20, 95, 100, 28, "Context\namplifier", fill=WHITE))
    d.add(_box(20, 60, 100, 28, "Call-site count", fill=WHITE))
    d.add(_box(20, 25, 100, 28, "Recoverability\npenalty", fill=WHITE))

    # Combine node
    d.add(_box(180, 75, 85, 45, "Σ", fill=NAVY, text_color=WHITE, stroke=NAVY, font_size=18, bold=True))

    # Output tuple
    d.add(_box(305, 75, 130, 45, "risk score\n(grade A–F)", fill=SOFT, bold=True))

    # Arrows
    d.add(_arrow(120, 144, 180, 115))
    d.add(_arrow(120, 109, 180, 103))
    d.add(_arrow(120, 74, 180, 93))
    d.add(_arrow(120, 39, 180, 82))
    d.add(_arrow(265, 97, 305, 97))

    # Note
    d.add(
        String(
            230,
            15,
            "Rewrites are attempted only for operations whose score clears the review threshold.",
            fontName="Helvetica-Oblique",
            fontSize=8,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )

    _caption(d, "Figure 2. Risk score composition. Four deterministic factors produce a per-operation score and a per-migration grade.")
    return d


# ---------------------------------------------------------------------------
# Figure 3 -- Verifier decision gate
# ---------------------------------------------------------------------------
def figure_verifier() -> Drawing:
    d = Drawing(460, 320)
    d.add(Rect(0, 0, 460, 320, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    d.add(_box(160, 275, 140, 28, "Candidate rewrite", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))

    # Step 1 -- parse
    d.add(_box(160, 215, 140, 34, "Parses cleanly?", fill=WHITE))
    d.add(_box(320, 215, 125, 34, "Reject\n(syntax)", fill=SOFT, text_color=INK))
    d.add(_arrow(230, 275, 230, 249))
    d.add(_arrow(300, 232, 320, 232))
    d.add(String(312, 237, "No", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))

    # Step 2 -- span check
    d.add(_box(160, 150, 140, 34, "Spans match\ninput scope?", fill=WHITE))
    d.add(_box(320, 150, 125, 34, "Reject\n(out-of-scope)", fill=SOFT, text_color=INK))
    d.add(_arrow(230, 215, 230, 184))
    d.add(_arrow(300, 167, 320, 167))
    d.add(String(312, 172, "No", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))
    d.add(String(238, 204, "Yes", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))

    # Step 3 -- schema equivalence
    d.add(_box(160, 85, 140, 34, "End-state\nequivalent?", fill=WHITE))
    d.add(_box(320, 85, 125, 34, "Reject\n(non-equivalent)", fill=SOFT, text_color=INK))
    d.add(_arrow(230, 150, 230, 119))
    d.add(_arrow(300, 102, 320, 102))
    d.add(String(312, 107, "No", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))
    d.add(String(238, 139, "Yes", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))

    # Accept
    d.add(_box(160, 30, 140, 34, "Accept rewrite", fill=NAVY, text_color=WHITE, stroke=NAVY, bold=True))
    d.add(_arrow(230, 85, 230, 64))
    d.add(String(238, 74, "Yes", fontName="Helvetica-Oblique", fontSize=8, fillColor=MUTED))

    _caption(d, "Figure 3. Verifier decision gate. A rewrite reaches the dashboard only if it parses, stays in scope, and reaches an equivalent end-state.")
    return d


# ---------------------------------------------------------------------------
# Figure 4 -- Dashboard wireframe
# ---------------------------------------------------------------------------
def figure_dashboard() -> Drawing:
    d = Drawing(460, 270)
    d.add(Rect(0, 0, 460, 270, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    # Browser chrome
    d.add(Rect(15, 15, 430, 235, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.8, rx=3, ry=3))
    d.add(Rect(15, 225, 430, 25, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.6, rx=3, ry=3))
    for i, col in enumerate([colors.HexColor("#d97757"), colors.HexColor("#d7b56d"), colors.HexColor("#6ea97a")]):
        d.add(Rect(25 + i * 12, 234, 7, 7, fillColor=col, strokeColor=col, rx=3.5, ry=3.5))
    d.add(
        String(
            85,
            234,
            "schemashift.local / Overview",
            fontName="Helvetica",
            fontSize=8,
            fillColor=MUTED,
        )
    )

    # Sidebar
    d.add(Rect(25, 30, 80, 185, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.5))
    for i, item in enumerate(["Overview", "Migrations", "Operation", "Rewrites", "History"]):
        fill = NAVY if i == 0 else SOFT
        text = WHITE if i == 0 else INK
        d.add(Rect(30, 195 - i * 26, 70, 20, fillColor=fill, strokeColor=BORDER, strokeWidth=0.3, rx=2, ry=2))
        d.add(
            String(
                65,
                200 - i * 26,
                item,
                fontName="Helvetica-Bold" if i == 0 else "Helvetica",
                fontSize=8,
                fillColor=text,
                textAnchor="middle",
            )
        )

    # Metric cards
    labels = [
        ("Grade", "B"),
        ("Ops", "14"),
        ("Risky", "3"),
        ("Rewrites", "11"),
    ]
    for i, (label, value) in enumerate(labels):
        x = 115 + i * 82
        d.add(Rect(x, 170, 72, 45, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.5, rx=2, ry=2))
        d.add(String(x + 36, 200, value, fontName="Helvetica-Bold", fontSize=12, fillColor=NAVY, textAnchor="middle"))
        d.add(String(x + 36, 180, label, fontName="Helvetica", fontSize=7.5, fillColor=MUTED, textAnchor="middle"))

    # Risk bars by class
    d.add(Rect(115, 80, 320, 80, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.5, rx=2, ry=2))
    d.add(String(125, 148, "Findings by risk class", fontName="Helvetica-Bold", fontSize=8, fillColor=INK))
    heights = [48, 30, 22, 18, 12]
    cls_labels = ["BLOCK", "UNSAFE", "REPL", "PERF", "RECOV"]
    for i, (h, lab) in enumerate(zip(heights, cls_labels)):
        x = 135 + i * 55
        d.add(Rect(x, 90, 36, h, fillColor=NAVY, strokeColor=NAVY))
        d.add(String(x + 18, 83, lab, fontName="Helvetica", fontSize=7, fillColor=MUTED, textAnchor="middle"))

    # Top operations list
    d.add(Rect(115, 30, 320, 42, fillColor=WHITE, strokeColor=BORDER, strokeWidth=0.5, rx=2, ry=2))
    d.add(String(125, 62, "Top risky operations", fontName="Helvetica-Bold", fontSize=8, fillColor=INK))
    for i in range(2):
        d.add(Rect(125, 44 - i * 10, 300, 7, fillColor=SOFT, strokeColor=BORDER, strokeWidth=0.3, rx=1, ry=1))

    _caption(d, "Figure 4. Dashboard Overview wireframe -- sidebar, grade card, risk-class histogram, and top-risky-operation list.")
    return d


# ---------------------------------------------------------------------------
# Figure 5 -- Roadmap
# ---------------------------------------------------------------------------
def figure_roadmap() -> Drawing:
    d = Drawing(460, 210)
    d.add(Rect(0, 0, 460, 210, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    axis_y = 30
    d.add(Line(70, axis_y, 440, axis_y, strokeColor=MUTED, strokeWidth=0.6))
    for i, label in enumerate(["Week 1", "Week 2", "Week 3", "Week 4"]):
        x = 70 + i * 92.5 + 46
        d.add(Line(70 + i * 92.5, axis_y - 3, 70 + i * 92.5, axis_y + 3, strokeColor=MUTED, strokeWidth=0.6))
        d.add(String(x, axis_y - 14, label, fontName="Helvetica-Bold", fontSize=9, fillColor=INK, textAnchor="middle"))
    d.add(Line(440, axis_y - 3, 440, axis_y + 3, strokeColor=MUTED, strokeWidth=0.6))

    rows = [
        ("Scaffolding + static analyser", 0, 1, NAVY),
        ("Context + call-site scanner", 1, 1, STEEL),
        ("LLM reasoner + verifier", 2, 1, NAVY),
        ("Dashboard (Next.js + 5 views)", 3, 1, STEEL),
        ("Evaluation harness + CI", 0, 4, ACCENT),
    ]
    for i, (label, start, span, col) in enumerate(rows):
        y = 170 - i * 25
        x = 70 + start * 92.5 + 4
        w = span * 92.5 - 8
        d.add(Rect(x, y, w, 16, fillColor=col, strokeColor=col, rx=2, ry=2))
        d.add(
            String(
                65,
                y + 4,
                label,
                fontName="Helvetica",
                fontSize=8,
                fillColor=INK,
                textAnchor="end",
            )
        )

    d.add(
        String(
            230,
            15,
            "Continuous deliverable shown in teal runs for the full project duration.",
            fontName="Helvetica-Oblique",
            fontSize=8,
            fillColor=MUTED,
            textAnchor="middle",
        )
    )

    _caption(d, "Figure 5. Implementation roadmap. Core pipeline built week by week; evaluation and CI run alongside throughout.")
    return d


# ---------------------------------------------------------------------------
# Figure 6 -- Data model
# ---------------------------------------------------------------------------
def figure_data_model() -> Drawing:
    d = Drawing(460, 220)
    d.add(Rect(0, 0, 460, 220, fillColor=BG, strokeColor=BORDER, strokeWidth=0.5, rx=4, ry=4))

    def entity(x: float, y: float, title: str, fields: list[str]):
        g = Group()
        h = 24 + len(fields) * 13
        g.add(Rect(x, y, 100, h, fillColor=WHITE, strokeColor=NAVY, strokeWidth=0.8, rx=2, ry=2))
        g.add(Rect(x, y + h - 20, 100, 20, fillColor=NAVY, strokeColor=NAVY, rx=2, ry=2))
        g.add(
            String(
                x + 50,
                y + h - 14,
                title,
                fontName="Helvetica-Bold",
                fontSize=9,
                fillColor=WHITE,
                textAnchor="middle",
            )
        )
        for i, f in enumerate(fields):
            g.add(
                String(
                    x + 6,
                    y + h - 34 - i * 13,
                    f,
                    fontName="Helvetica",
                    fontSize=7.5,
                    fillColor=INK,
                )
            )
        return g, h

    op, op_h = entity(20, 110, "DDLOperation", ["id", "kind", "schema", "table", "column"])
    rh, rh_h = entity(140, 110, "RuleHit", ["id", "rule_id", "severity", "operation_id"])
    fs, fs_h = entity(260, 110, "FusedSignal", ["id", "operation_id", "score", "grade"])
    rw, rw_h = entity(380, 110, "Rewrite", ["id", "signal_id", "phases", "verified"])
    ctx, ctx_h = entity(80, 30, "ContextBundle", ["table_size", "indexes", "replica"])
    cs, cs_h = entity(260, 30, "CallSite", ["path", "line", "symbol", "confidence"])

    for ent in (op, rh, fs, rw, ctx, cs):
        d.add(ent)

    d.add(Line(120, 110 + op_h / 2, 140, 110 + rh_h / 2, strokeColor=STEEL, strokeWidth=0.8))
    d.add(Line(240, 110 + rh_h / 2, 260, 110 + fs_h / 2, strokeColor=STEEL, strokeWidth=0.8))
    d.add(Line(360, 110 + fs_h / 2, 380, 110 + rw_h / 2, strokeColor=STEEL, strokeWidth=0.8))
    d.add(Line(130, 110, 130, 30 + ctx_h, strokeColor=STEEL, strokeWidth=0.8))
    d.add(Line(310, 110, 310, 30 + cs_h, strokeColor=STEEL, strokeWidth=0.8))

    d.add(String(130, 122, "1..N", fontName="Helvetica-Oblique", fontSize=7, fillColor=MUTED, textAnchor="middle"))
    d.add(String(250, 122, "1..N", fontName="Helvetica-Oblique", fontSize=7, fillColor=MUTED, textAnchor="middle"))
    d.add(String(370, 122, "1..1", fontName="Helvetica-Oblique", fontSize=7, fillColor=MUTED, textAnchor="middle"))

    _caption(d, "Figure 6. Data model. Operations carry rule hits and context, fuse into signals, and spawn at most one verified rewrite each.")
    return d


# ---------------------------------------------------------------------------
# Registry used by the markdown renderer
# ---------------------------------------------------------------------------
FIGURES = {
    "pipeline": figure_pipeline,
    "data_model": figure_data_model,
    "risk_score": figure_risk_score,
    "verifier": figure_verifier,
    "dashboard": figure_dashboard,
    "roadmap": figure_roadmap,
}
