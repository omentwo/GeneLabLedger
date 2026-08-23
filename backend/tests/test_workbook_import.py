from __future__ import annotations

import io
import zipfile

import pytest

from app.services.workbook_import import InvalidWorkbook, parse_xlsx
from app.services.workbooks import build_xlsx


def date_serial_workbook(serial: str, *, date_1904: bool) -> bytes:
    original = build_xlsx([("日期测试", ["日期"], [["SERIAL"]])])
    with zipfile.ZipFile(io.BytesIO(original), "r") as archive:
        members = {item.filename: archive.read(item.filename) for item in archive.infolist()}

    styles = members["xl/styles.xml"].decode("utf-8")
    styles = styles.replace('<cellXfs count="2">', '<cellXfs count="3">')
    styles = styles.replace(
        "</cellXfs>",
        '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        "</cellXfs>",
    )
    members["xl/styles.xml"] = styles.encode("utf-8")

    sheet = members["xl/worksheets/sheet1.xml"].decode("utf-8")
    sheet = sheet.replace(
        '<c r="A2" t="inlineStr"><is><t xml:space="preserve">SERIAL</t></is></c>',
        f'<c r="A2" s="2"><v>{serial}</v></c>',
    )
    members["xl/worksheets/sheet1.xml"] = sheet.encode("utf-8")

    if date_1904:
        workbook = members["xl/workbook.xml"].decode("utf-8")
        members["xl/workbook.xml"] = workbook.replace(
            "<sheets>",
            '<workbookPr date1904="1"/><sheets>',
        ).encode("utf-8")

    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return stream.getvalue()


def cell_reference_workbook(reference: str) -> bytes:
    original = build_xlsx([("坐标测试", ["表头"], [["值"]])])
    with zipfile.ZipFile(io.BytesIO(original), "r") as archive:
        members = {item.filename: archive.read(item.filename) for item in archive.infolist()}

    sheet = members["xl/worksheets/sheet1.xml"].decode("utf-8")
    assert 'r="A2"' in sheet
    members["xl/worksheets/sheet1.xml"] = sheet.replace(
        'r="A2"',
        f'r="{reference}"',
        1,
    ).encode("utf-8")

    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return stream.getvalue()


def test_date_styled_cells_support_both_excel_date_systems() -> None:
    standard = parse_xlsx(date_serial_workbook("1", date_1904=False))
    date_1904 = parse_xlsx(date_serial_workbook("0", date_1904=True))

    assert standard[0].rows == [["1900-01-01"]]
    assert date_1904[0].rows == [["1904-01-01"]]


def test_out_of_range_date_serial_remains_text_instead_of_crashing() -> None:
    parsed = parse_xlsx(date_serial_workbook("999999999999", date_1904=False))
    assert parsed[0].rows == [["999999999999"]]


def test_cell_beyond_workbook_column_limit_is_rejected_before_row_expansion() -> None:
    with pytest.raises(InvalidWorkbook, match="超过 200 列"):
        parse_xlsx(cell_reference_workbook("GS2"))


def test_oversized_cell_reference_is_rejected_as_invalid() -> None:
    with pytest.raises(InvalidWorkbook, match="无效的单元格坐标"):
        parse_xlsx(cell_reference_workbook(f"{'A' * 1_000}2"))
