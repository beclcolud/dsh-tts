import pathlib
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.oxml.ns import qn

import os
from pathlib import Path

HOME = Path(os.environ.get('DSH_TTS_HOME') or Path(__file__).resolve().parents[2])
SRC = pathlib.Path(str(HOME) + r"/dsh-tts/HANDOVER.md")
OUT = pathlib.Path(str(HOME) + r"/dsh-tts/HANDOVER.docx")
src = SRC.read_text(encoding='utf-8').splitlines()
doc = Document()
sec = doc.sections[0]
sec.left_margin = Cm(2.2); sec.right_margin = Cm(2.2)
sec.top_margin = Cm(2.2); sec.bottom_margin = Cm(2.2)

def cn(run, size=10.5, bold=False, mono=False, color=None):
    run.font.name = 'Consolas' if mono else '宋体'
    run.font.size = Pt(size)
    run.font.bold = bold
    run._element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'), '宋体')
    if color: run.font.color.rgb = color

def plain(t):
    t = t.replace('**', '').replace('`', '')
    return t

i, n = 0, len(src)
while i < n:
    raw = src[i]
    s = raw.strip()
    if s == '':
        i += 1
        continue
    if s.startswith('`' * 3):
        i += 1
        block = []
        while i < n and not src[i].strip().startswith('`' * 3):
            block.append(src[i]); i += 1
        i += 1
        for b in block:
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.left_indent = Cm(0.6)
            cn(p.add_run(b if b.strip() else ' '), 9, mono=True)
        doc.add_paragraph()
        continue
    def is_sep(row_text):
        cells = [c.strip() for c in row_text.strip().strip('|').split('|')]
        return len(cells) > 0 and all(len(c) > 0 and set(c) <= set('-: ') for c in cells)

    if s.startswith('|') and i + 1 < n and is_sep(src[i + 1]):
        rows = []
        while i < n and src[i].strip().startswith('|'):
            row = [c.strip() for c in src[i].strip().strip('|').split('|')]
            if not all(set(c) <= set('-: ') for c in row):
                rows.append(row)
            i += 1
        cols = max(len(r) for r in rows)
        tbl = doc.add_table(rows=0, cols=cols)
        tbl.style = 'Table Grid'
        for ri, row in enumerate(rows):
            cells = tbl.add_row().cells
            for ci in range(cols):
                txt = plain(row[ci]) if ci < len(row) else ''
                cells[ci].text = ''
                cn(cells[ci].paragraphs[0].add_run(txt), 9, bold=(ri == 0))
        doc.add_paragraph()
        continue
    if s.startswith('### '):
        p = doc.add_paragraph(); cn(p.add_run(plain(s[4:])), 12, bold=True)
        i += 1; continue
    if s.startswith('## '):
        p = doc.add_paragraph(); p.paragraph_format.space_before = Pt(10)
        cn(p.add_run(plain(s[3:])), 14, bold=True)
        i += 1; continue
    if s.startswith('# '):
        p = doc.add_paragraph(); cn(p.add_run(plain(s[2:])), 18, bold=True)
        i += 1; continue
    if s.startswith('>'):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.5)
        cn(p.add_run(plain(s.lstrip('> ').strip())), 9.5, color=RGBColor(0x55, 0x55, 0x55))
        i += 1; continue
    if s.startswith('---'):
        doc.add_paragraph(); i += 1; continue
    stripped = raw.lstrip()
    if stripped[:2] in ('- ', '* '):
        depth = (len(raw) - len(stripped)) // 2
        p = doc.add_paragraph(style='List Bullet')
        p.paragraph_format.left_indent = Cm(0.75 + depth * 0.6)
        cn(p.add_run(plain(stripped[2:])), 10)
        i += 1; continue
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(3)
    cn(p.add_run(plain(s)), 10)
    i += 1

doc.save(OUT)
print('saved')