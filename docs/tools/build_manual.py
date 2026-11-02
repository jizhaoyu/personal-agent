"""Build professional Word manuals for Looma (灵犀胶囊) from Markdown sources.

Generates:
1. Looma(灵犀胶囊)_软件操作与使用说明书.docx
2. Looma(灵犀胶囊)_产品需求规格说明书.docx
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = Path(__file__).resolve().parents[2]
DOCS_DIR = ROOT / "docs"

NAVY = "183344"
TEAL = "136E6A"
GREY = "60717A"
LIGHT_BG = "F4F8F8"
HEADER_BG = "E4F0ED"


def east_asia_font(style, name="宋体"):
    style.font.name = name
    style.element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), name)


def set_cell_background(cell, color_hex):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), color_hex)
    tcPr.append(shd)


def inline(paragraph, text):
    pattern = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^\)]+\)|<br\s*/?>)")
    for part in pattern.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            paragraph.add_run(part[2:-2]).bold = True
        elif part.startswith("`") and part.endswith("`"):
            run = paragraph.add_run(part[1:-1])
            run.font.name = "Consolas"
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor.from_string(TEAL)
        elif re.match(r"<br\s*/?>", part):
            paragraph.add_run("\n")
        elif part.startswith("["):
            match = re.fullmatch(r"\[([^\]]+)\]\((.+)\)", part)
            if match:
                hyperlink = OxmlElement("w:hyperlink")
                rel = paragraph.part.relate_to(
                    match[2],
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                    is_external=True,
                )
                hyperlink.set(qn("r:id"), rel)
                run = OxmlElement("w:r")
                props = OxmlElement("w:rPr")
                colour = OxmlElement("w:color")
                colour.set(qn("w:val"), TEAL)
                props.append(colour)
                run.append(props)
                value = OxmlElement("w:t")
                value.text = match[1]
                run.append(value)
                hyperlink.append(run)
                paragraph._p.append(hyperlink)
            else:
                paragraph.add_run(part)
        else:
            paragraph.add_run(part)


def add_table(document, rows):
    if not rows or not rows[0]:
        return
    cols = len(rows[0])
    table = document.add_table(rows=1, cols=cols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.style = "Table Grid"
    table.autofit = False

    total_width = 16.6
    widths = [total_width / cols] * cols
    if cols == 2:
        widths = [4.5, 12.1]
    elif cols == 3:
        widths = [3.5, 6.5, 6.6]
    elif cols == 4:
        widths = [3.2, 4.3, 4.6, 4.5]

    for index, values in enumerate(rows):
        cells = table.rows[0].cells if index == 0 else table.add_row().cells
        row = table.rows[index]
        no_split = OxmlElement("w:cantSplit")
        row._tr.get_or_add_trPr().append(no_split)
        if index == 0:
            repeat = OxmlElement("w:tblHeader")
            row._tr.get_or_add_trPr().append(repeat)

        for col, value in enumerate(values):
            if col >= len(cells):
                continue
            cell = cells[col]
            cell.width = Cm(widths[col])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            p = cell.paragraphs[0]
            p.paragraph_format.space_before = Pt(4)
            p.paragraph_format.space_after = Pt(4)
            p.paragraph_format.line_spacing = 1.15
            p.paragraph_format.keep_with_next = index == 0

            inline(p, value)
            for r in p.runs:
                r.font.size = Pt(9)
                if index == 0:
                    r.bold = True
                    r.font.color.rgb = RGBColor.from_string(NAVY)

            if index == 0:
                set_cell_background(cell, HEADER_BG)

    document.add_paragraph().paragraph_format.space_after = Pt(2)


def add_markdown_content(document, md_path: Path):
    lines = md_path.read_text(encoding="utf-8").splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if not line:
            index += 1
            continue
        if line.startswith("# "):
            index += 1
            continue
        if line.startswith("---"):
            index += 1
            continue

        if line.startswith("```"):
            language = line[3:].strip()
            index += 1
            block = []
            while index < len(lines) and not lines[index].strip().startswith("```"):
                block.append(lines[index])
                index += 1
            for code_line in block:
                p = document.add_paragraph(style="Code")
                p.add_run(code_line)
            index += 1
            continue

        if line.startswith("|"):
            rows = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                cells = [c.strip() for c in lines[index].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", c) for c in cells):
                    rows.append(cells)
                index += 1
            if rows:
                add_table(document, rows)
            continue

        h2 = re.match(r"^##\s+(.+)$", line)
        if h2:
            document.add_heading(h2[1], level=1)
            index += 1
            continue

        h3 = re.match(r"^###\s+(.+)$", line)
        if h3:
            document.add_heading(h3[1], level=2)
            index += 1
            continue

        h4 = re.match(r"^####\s+(.+)$", line)
        if h4:
            document.add_heading(h4[1], level=3)
            index += 1
            continue

        if line.startswith("- "):
            p = document.add_paragraph(style="List Bullet")
            inline(p, line[2:])
            index += 1
            continue

        num_match = re.match(r"^(\d+)\.\s+(.+)$", line)
        if num_match:
            p = document.add_paragraph(style="List Number")
            inline(p, num_match[2])
            index += 1
            continue

        p = document.add_paragraph()
        inline(p, line)
        index += 1


def create_manual_document(doc_title: str, sub_title: str, source_md: Path, output_docx: Path, version: str = "v5.1"):
    doc = Document()
    sec = doc.sections[0]
    sec.page_width = Cm(21)
    sec.page_height = Cm(29.7)
    sec.top_margin = Cm(2.0)
    sec.bottom_margin = Cm(2.0)
    sec.left_margin = Cm(2.2)
    sec.right_margin = Cm(2.2)
    sec.header_distance = Cm(0.8)
    sec.footer_distance = Cm(0.8)

    normal = doc.styles["Normal"]
    east_asia_font(normal, "宋体")
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(NAVY)
    normal.paragraph_format.line_spacing = 1.25
    normal.paragraph_format.space_after = Pt(5)
    normal.paragraph_format.widow_control = True

    for name in ["Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3"]:
        east_asia_font(doc.styles[name], "微软雅黑")
        doc.styles[name].font.color.rgb = RGBColor.from_string(NAVY)

    doc.styles["Title"].font.size = Pt(22)
    doc.styles["Title"].font.bold = True
    doc.styles["Title"].paragraph_format.space_before = Pt(24)
    doc.styles["Title"].paragraph_format.space_after = Pt(12)

    doc.styles["Subtitle"].font.size = Pt(12)
    doc.styles["Subtitle"].font.color.rgb = RGBColor.from_string(TEAL)
    doc.styles["Subtitle"].paragraph_format.space_after = Pt(8)

    doc.styles["Heading 1"].font.size = Pt(14)
    doc.styles["Heading 1"].paragraph_format.space_before = Pt(12)
    doc.styles["Heading 1"].paragraph_format.space_after = Pt(6)
    doc.styles["Heading 1"].paragraph_format.keep_with_next = True

    doc.styles["Heading 2"].font.size = Pt(12)
    doc.styles["Heading 2"].paragraph_format.space_before = Pt(9)
    doc.styles["Heading 2"].paragraph_format.space_after = Pt(4)
    doc.styles["Heading 2"].paragraph_format.keep_with_next = True

    doc.styles["Heading 3"].font.size = Pt(10.5)
    doc.styles["Heading 3"].paragraph_format.space_before = Pt(6)
    doc.styles["Heading 3"].paragraph_format.space_after = Pt(2)
    doc.styles["Heading 3"].paragraph_format.keep_with_next = True

    for name in ["List Bullet", "List Number"]:
        east_asia_font(doc.styles[name], "宋体")
        doc.styles[name].font.size = Pt(10.5)
        doc.styles[name].paragraph_format.space_after = Pt(4)

    if "Code" not in doc.styles:
        code = doc.styles.add_style("Code", 1)
        east_asia_font(code, "Consolas")
        code.font.name = "Consolas"
        code.font.size = Pt(9)
        code.paragraph_format.line_spacing = 1.1
        code.paragraph_format.space_after = Pt(2)

    header = sec.header.paragraphs[0]
    hrun = header.add_run(f"LOOMA / 灵犀胶囊 · {doc_title}")
    hrun.font.size = Pt(8.5)
    hrun.font.color.rgb = RGBColor.from_string(GREY)

    footer = sec.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    frun = footer.add_run(f"{version} · 2026-11-02  |  第 ")
    frun.font.size = Pt(8.5)
    frun.font.color.rgb = RGBColor.from_string(GREY)
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    footer._p.append(field)
    frun2 = footer.add_run(" 页")
    frun2.font.size = Pt(8.5)
    frun2.font.color.rgb = RGBColor.from_string(GREY)

    doc.core_properties.title = f"Looma {doc_title}"
    doc.core_properties.subject = sub_title
    doc.core_properties.author = "Looma Team"

    # Cover Header
    sub = doc.add_paragraph("LOOMA · 本地优先客户跟进与生活伴侣", style="Subtitle")
    t = doc.add_paragraph(doc_title, style="Title")
    t.runs[0].bold = True
    doc.add_paragraph(sub_title, style="Subtitle")
    doc.add_paragraph(f"系统版本：{version}  |  编制日期：2026-11-02  |  环境：Windows x64 / Web / Android")
    
    meta_table = [
        ["项目", "规格与说明"],
        ["软件名称", "Looma（灵犀胶囊）本地优先客户跟进伴侣"],
        ["版本标识", f"{version}（演练沙箱、双态隔离与本地优先收尾）"],
        ["技术体系", "Electron 34 + React 19 + TypeScript 5.7 + SQLite / IndexedDB"],
        ["交付形态", "免安装独立便携版 / 桌面客户端 / 浏览器本地体验端"],
        ["安全规范", "Windows DPAPI 系统底层加密、零云端泄露、逻辑物理分区"],
    ]
    add_table(doc, meta_table)
    doc.add_page_break()

    add_markdown_content(doc, source_md)

    doc.save(output_docx)
    print(f"Generated: {output_docx} ({output_docx.stat().st_size} bytes, {len(doc.paragraphs)} paragraphs)")


def main():
    manual_md = DOCS_DIR / "05-软件操作与使用说明书(User_Manual).md"
    manual_docx = ROOT / "Looma(灵犀胶囊)_软件操作与使用说明书.docx"
    create_manual_document(
        doc_title="软件操作与使用说明书",
        sub_title="客户端部署、核心工作流操作指引与维护手册",
        source_md=manual_md,
        output_docx=manual_docx,
        version="v5.1"
    )

    prd_md = DOCS_DIR / "02-产品需求规格说明书(PRD_and_UX_Spec).md"
    prd_docx = ROOT / "Looma(灵犀胶囊)_产品需求规格说明书.docx"
    create_manual_document(
        doc_title="产品需求规格说明书",
        sub_title="交互规范、状态流转与系统边界需求说明",
        source_md=prd_md,
        output_docx=prd_docx,
        version="v5.0"
    )


if __name__ == "__main__":
    main()
