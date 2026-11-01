"""Build professional Word document for XuanHu Personal AI Commercial BP from Markdown source.

Requires python-docx.
"""
from __future__ import annotations

import re
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = Path(__file__).resolve().parents[2]
SOURCE_MD = ROOT / "docs" / "04-悬壶_面向AI智能体的可验证隐私数据底座_商业计划书(定稿版).md"
OUTPUT_DOCX = ROOT / "悬壶_面向AI智能体的可验证隐私数据底座_商业计划书(修订定稿版).docx"
OUTPUT_SECTION_DOCX = ROOT / "悬壶_PersonalAI_产品创新哲学与技术路径.docx"

NAVY = "183344"
TEAL = "136E6A"
GREY = "556670"
DARK = "222D33"


def east_asia_font(style, name="宋体"):
    style.font.name = name
    style.element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), name)


def set_cell_background(cell, color_hex):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), color_hex)
    tcPr.append(shd)


def inline(paragraph, text):
    pattern = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`|<br\s*/?>)")
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
        else:
            paragraph.add_run(part)


def add_table(document, rows):
    if not rows or not rows[0]:
        return
    table = document.add_table(rows=1, cols=len(rows[0]))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.style = "Table Grid"
    table.autofit = False

    cols_count = len(rows[0])
    widths = [16.5 / cols_count] * cols_count
    if cols_count == 3:
        widths = [3.5, 6.5, 6.5]
    elif cols_count == 4:
        widths = [3.2, 4.3, 4.5, 4.5]
    elif cols_count == 5:
        widths = [2.6, 2.9, 4.2, 2.8, 4.0]

    for index, values in enumerate(rows):
        cells = table.rows[0].cells if index == 0 else table.add_row().cells
        row = table.rows[index]
        no_split = OxmlElement("w:cantSplit")
        row._tr.get_or_add_trPr().append(no_split)
        if index == 0:
            repeat = OxmlElement("w:tblHeader")
            row._tr.get_or_add_trPr().append(repeat)

        for col_idx, text in enumerate(values):
            cell = cells[col_idx]
            cell.width = Cm(widths[col_idx])
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            p = cell.paragraphs[0]
            p.paragraph_format.space_before = Pt(3)
            p.paragraph_format.space_after = Pt(3)
            p.paragraph_format.line_spacing = 1.15
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT

            if index == 0:
                set_cell_background(cell, "EBF3F2")
                run = p.add_run(text)
                run.bold = True
                run.font.color.rgb = RGBColor.from_string(NAVY)
            else:
                if index % 2 == 1:
                    set_cell_background(cell, "FAFCFB")
                inline(p, text)

    p_after = document.add_paragraph()
    p_after.paragraph_format.space_before = Pt(0)
    p_after.paragraph_format.space_after = Pt(6)


def build_doc(source_lines, target_path, title="悬壶科技 商业计划书"):
    document = Document()
    sections = document.sections
    for section in sections:
        section.top_margin = Cm(2.54)
        section.bottom_margin = Cm(2.54)
        section.left_margin = Cm(2.54)
        section.right_margin = Cm(2.54)

    style_normal = document.styles["Normal"]
    style_normal.font.size = Pt(10.5)
    style_normal.font.color.rgb = RGBColor.from_string(DARK)
    east_asia_font(style_normal, "宋体")

    in_table = False
    table_rows = []
    in_code_block = False

    for line in source_lines:
        line_strip = line.strip()

        # Handle mermaid code block skip
        if line_strip.startswith("```"):
            in_code_block = not in_code_block
            continue
        if in_code_block:
            continue

        # Handle Markdown Tables
        if "|" in line_strip and line_strip.startswith("|") and line_strip.endswith("|"):
            cells = [c.strip() for c in line_strip.split("|")[1:-1]]
            if cells and all(re.match(r"^:?-+:?$", c) for c in cells):
                continue  # Divider line
            if not in_table:
                in_table = True
                table_rows = [cells]
            else:
                table_rows.append(cells)
            continue
        else:
            if in_table:
                add_table(document, table_rows)
                in_table = False
                table_rows = []

        if not line_strip:
            continue

        # Headings
        if line_strip.startswith("# "):
            p = document.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            p.paragraph_format.space_before = Pt(14)
            p.paragraph_format.space_after = Pt(6)
            run = p.add_run(line_strip[2:])
            run.bold = True
            run.font.size = Pt(20)
            run.font.color.rgb = RGBColor.from_string(NAVY)
            east_asia_font(p.style, "黑体")
        elif line_strip.startswith("## "):
            p = document.add_paragraph()
            p.paragraph_format.space_before = Pt(12)
            p.paragraph_format.space_after = Pt(4)
            run = p.add_run(line_strip[3:])
            run.bold = True
            run.font.size = Pt(15)
            run.font.color.rgb = RGBColor.from_string(NAVY)
            east_asia_font(p.style, "黑体")
        elif line_strip.startswith("### "):
            p = document.add_paragraph()
            p.paragraph_format.space_before = Pt(9)
            p.paragraph_format.space_after = Pt(3)
            run = p.add_run(line_strip[4:])
            run.bold = True
            run.font.size = Pt(12)
            run.font.color.rgb = RGBColor.from_string(TEAL)
            east_asia_font(p.style, "黑体")
        elif line_strip.startswith("#### "):
            p = document.add_paragraph()
            p.paragraph_format.space_before = Pt(6)
            p.paragraph_format.space_after = Pt(2)
            run = p.add_run(line_strip[5:])
            run.bold = True
            run.font.size = Pt(11)
            run.font.color.rgb = RGBColor.from_string(DARK)
            east_asia_font(p.style, "宋体")
        elif line_strip.startswith("- ") or line_strip.startswith("* "):
            p = document.add_paragraph(style="List Bullet")
            p.paragraph_format.space_before = Pt(1)
            p.paragraph_format.space_after = Pt(1)
            p.paragraph_format.line_spacing = 1.25
            inline(p, line_strip[2:])
        elif re.match(r"^\d+\.\s", line_strip):
            p = document.add_paragraph(style="List Number")
            p.paragraph_format.space_before = Pt(1)
            p.paragraph_format.space_after = Pt(1)
            p.paragraph_format.line_spacing = 1.25
            content = re.sub(r"^\d+\.\s", "", line_strip)
            inline(p, content)
        elif line_strip.startswith("---"):
            continue
        else:
            p = document.add_paragraph()
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.line_spacing = 1.3
            inline(p, line_strip)

    if in_table:
        add_table(document, table_rows)

    document.save(str(target_path))
    print(f"Generated docx: {target_path} (Paragraphs: {len(document.paragraphs)}, Tables: {len(document.tables)})")


def main():
    if not SOURCE_MD.exists():
        print(f"Source file not found: {SOURCE_MD}")
        return

    text = SOURCE_MD.read_text(encoding="utf-8")
    lines = text.splitlines()

    # 1. Full Commercial BP
    build_doc(lines, OUTPUT_DOCX, title="悬壶面向AI智能体的可验证隐私数据底座商业计划书")

    # 2. Extract Chapter 5 (Personal AI 哲学与技术路径)
    ch5_lines = []
    capture = False
    for line in lines:
        if line.strip().startswith("## 五、Personal AI 产品创新哲学与已实现技术路径"):
            capture = True
            ch5_lines.append("# Personal AI\n")
            ch5_lines.append("## 产品创新哲学与已实现技术路径\n")
            ch5_lines.append("悬壶（杭州）艺术科技有限公司 ｜ 商业计划书核心章节定稿\n")
            continue
        elif capture and line.strip().startswith("## 六、"):
            break
        elif capture:
            ch5_lines.append(line)

    if ch5_lines:
        build_doc(ch5_lines, OUTPUT_SECTION_DOCX, title="悬壶Personal AI产品创新哲学与技术路径")


if __name__ == "__main__":
    main()
