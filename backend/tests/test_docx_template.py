from __future__ import annotations

import io
import zipfile
from pathlib import Path

from app.services.docx_template import extract_placeholders, render_docx


def split_placeholder_docx() -> bytes:
    xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p>
    <w:r><w:t>病理号：</w:t></w:r>
    <w:r><w:t>{{case</w:t></w:r>
    <w:r><w:t>_no}}</w:t></w:r>
  </w:p></w:body>
</w:document>"""
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", xml)
    return stream.getvalue()


def test_placeholder_across_word_runs(tmp_path: Path) -> None:
    content = split_placeholder_docx()
    assert extract_placeholders(content) == ["case_no"]
    source = tmp_path / "source.docx"
    output = tmp_path / "output.docx"
    source.write_bytes(content)
    render_docx(source, output, {"case_no": "26-00418"})
    with zipfile.ZipFile(output) as archive:
        xml = archive.read("word/document.xml").decode("utf-8")
    assert "{{case" not in xml
    assert "26-00418" in xml
