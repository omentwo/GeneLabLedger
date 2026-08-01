from __future__ import annotations

import io
import re
import zipfile
from html import escape
from pathlib import Path

INVALID_XML_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

WorkbookSheet = (
    tuple[str, list[str], list[list[object]]]
    | tuple[str, list[str], list[list[object]], list[int]]
)


def _column_name(column_index: int) -> str:
    result = ""
    value = column_index
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _sheet_name(value: str, used: set[str]) -> str:
    base = re.sub(r"[\\/*?:\[\]]", "_", value).strip()[:31] or "项目"
    candidate = base
    suffix = 2
    while candidate.casefold() in used:
        tail = f"_{suffix}"
        candidate = f"{base[: 31 - len(tail)]}{tail}"
        suffix += 1
    used.add(candidate.casefold())
    return candidate


def _xml_text(value: object) -> str:
    return escape(INVALID_XML_CHARS.sub("", str(value if value is not None else "")))


def _column_width(values: list[object]) -> float:
    longest = max((len(str(value if value is not None else "")) for value in values), default=0)
    return float(min(42, max(10, longest + 2)))


def _worksheet_xml(headers: list[str], rows: list[list[object]], hidden_columns: list[int]) -> str:
    width_count = max([len(headers), *(len(row) for row in rows)], default=0)
    columns = []
    for index in range(width_count):
        values = [
            headers[index] if index < len(headers) else "",
            *(row[index] if index < len(row) else "" for row in rows[:500]),
        ]
        hidden = ' hidden="1"' if index + 1 in hidden_columns else ""
        columns.append(
            f'<col min="{index + 1}" max="{index + 1}" '
            f'width="{_column_width(values):.1f}" customWidth="1"{hidden}/>'
        )

    def row_xml(values: list[object], row_number: int) -> str:
        cells = []
        for index in range(width_count):
            value = values[index] if index < len(values) else ""
            reference = f"{_column_name(index + 1)}{row_number}"
            style = ' s="1"' if row_number == 1 else ""
            cells.append(
                f'<c r="{reference}" t="inlineStr"{style}>'
                f'<is><t xml:space="preserve">{_xml_text(value)}</t></is></c>'
            )
        return f'<row r="{row_number}">{"".join(cells)}</row>'

    all_rows: list[list[object]] = [list(headers), *rows]
    body = "".join(row_xml(row, index) for index, row in enumerate(all_rows, start=1))
    last_column = _column_name(max(1, width_count))
    last_row = max(1, len(all_rows))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        "</sheetView></sheetViews>"
        '<sheetFormatPr defaultRowHeight="18"/>'
        f"<cols>{''.join(columns)}</cols>"
        f"<sheetData>{body}</sheetData>"
        f'<autoFilter ref="A1:{last_column}{last_row}"/>'
        "</worksheet>"
    )


def build_xlsx(sheets: list[WorkbookSheet]) -> bytes:
    if not sheets:
        raise ValueError("工作簿至少需要一个工作表")
    used_names: set[str] = set()
    normalized = []
    for sheet in sheets:
        name, headers, rows = sheet[:3]
        hidden_columns = sheet[3] if len(sheet) == 4 else []
        normalized.append(
            (_sheet_name(name, used_names), headers, rows, hidden_columns)
        )
    content_types = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        (
            '<Override PartName="/docProps/core.xml" '
            'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        ),
        (
            '<Override PartName="/docProps/app.xml" '
            "ContentType=\"application/vnd.openxmlformats-officedocument."
            'extended-properties+xml"/>'
        ),
        (
            '<Override PartName="/xl/workbook.xml" '
            "ContentType=\"application/vnd.openxmlformats-officedocument."
            'spreadsheetml.sheet.main+xml"/>'
        ),
        (
            '<Override PartName="/xl/styles.xml" '
            "ContentType=\"application/vnd.openxmlformats-officedocument."
            'spreadsheetml.styles+xml"/>'
        ),
    ]
    content_types.extend(
        f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for index in range(1, len(normalized) + 1)
    )
    content_types.append("</Types>")
    workbook_sheets = "".join(
        f'<sheet name="{escape(name, quote=True)}" sheetId="{index}" r:id="rId{index}"/>'
        for index, (name, _, _, _) in enumerate(normalized, start=1)
    )
    workbook_relationships = "".join(
        f'<Relationship Id="rId{index}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{index}.xml"/>'
        for index in range(1, len(normalized) + 1)
    )
    styles_relationship_id = len(normalized) + 1
    styles_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font>'
        '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/>'
        '<bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" '
        'applyNumberFormat="1"><alignment vertical="top" wrapText="1"/></xf>'
        '<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" '
        'applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "".join(content_types))
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/'
            'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/'
            "package/2006/relationships/metadata/core-properties\" "
            'Target="docProps/core.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/'
            "officeDocument/2006/relationships/extended-properties\" "
            'Target="docProps/app.xml"/>'
            "</Relationships>",
        )
        archive.writestr(
            "docProps/core.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/'
            'package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>基因检测台账</dc:creator>'
            "<cp:lastModifiedBy>基因检测台账</cp:lastModifiedBy></cp:coreProperties>",
        )
        archive.writestr(
            "docProps/app.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
            "<Application>基因检测台账</Application></Properties>",
        )
        archive.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets>{workbook_sheets}</sheets><calcPr calcId="0"/></workbook>',
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{workbook_relationships}"
            f'<Relationship Id="rId{styles_relationship_id}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
            'Target="styles.xml"/></Relationships>',
        )
        archive.writestr("xl/styles.xml", styles_xml)
        for index, (_, headers, rows, hidden_columns) in enumerate(normalized, start=1):
            archive.writestr(
                f"xl/worksheets/sheet{index}.xml",
                _worksheet_xml(headers, rows, hidden_columns),
            )
    return stream.getvalue()


def write_xlsx(path: Path, sheets: list[WorkbookSheet]) -> None:
    path.write_bytes(build_xlsx(sheets))
