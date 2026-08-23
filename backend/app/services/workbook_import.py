from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from xml.etree import ElementTree

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CELL_REFERENCE = re.compile(r"([A-Z]{1,3})([1-9][0-9]*)")
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_MEMBER_BYTES = 50 * 1024 * 1024
MAX_WORKSHEET_COLUMNS = 200
MAX_WORKSHEET_ROWS = 10_000
BUILTIN_DATE_FORMAT_IDS = frozenset(
    {
        *range(14, 23),
        *range(27, 37),
        *range(45, 48),
        *range(50, 59),
    }
)


@dataclass(slots=True)
class ParsedSheet:
    name: str
    headers: list[str]
    rows: list[list[str]]


class InvalidWorkbook(ValueError):
    pass


def _column_index(reference: str) -> int:
    if len(reference) > 16:
        raise InvalidWorkbook("Excel 文件包含无效的单元格坐标")
    match = CELL_REFERENCE.fullmatch(reference.upper())
    if not match:
        raise InvalidWorkbook("Excel 文件包含无效的单元格坐标")
    result = 0
    for char in match.group(1):
        result = result * 26 + ord(char) - 64
    return result - 1


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [
        "".join(node.text or "" for node in item.findall(f".//{{{MAIN_NS}}}t"))
        for item in root.findall(f"{{{MAIN_NS}}}si")
    ]


def _looks_like_date_format(code: str) -> bool:
    cleaned = re.sub(r'"[^"]*"', "", code.lower())
    cleaned = re.sub(r"\\.", "", cleaned)
    cleaned = re.sub(r"\[[^]]*]", "", cleaned)
    return bool(re.search(r"[ydhs]", cleaned) or re.search(r"m{1,4}", cleaned))


def _date_styles(archive: zipfile.ZipFile) -> list[bool]:
    try:
        root = ElementTree.fromstring(archive.read("xl/styles.xml"))
    except (KeyError, ElementTree.ParseError):
        return []
    custom_formats = {
        int(node.attrib["numFmtId"]): node.attrib.get("formatCode", "")
        for node in root.findall(f".//{{{MAIN_NS}}}numFmts/{{{MAIN_NS}}}numFmt")
        if node.attrib.get("numFmtId", "").isdigit()
    }
    cell_xfs = root.find(f"{{{MAIN_NS}}}cellXfs")
    if cell_xfs is None:
        return []
    result: list[bool] = []
    for style in cell_xfs.findall(f"{{{MAIN_NS}}}xf"):
        try:
            format_id = int(style.attrib.get("numFmtId", "0"))
        except ValueError:
            result.append(False)
            continue
        result.append(
            format_id in BUILTIN_DATE_FORMAT_IDS
            or _looks_like_date_format(custom_formats.get(format_id, ""))
        )
    return result


def _excel_date(value: str, *, date_1904: bool) -> str | None:
    try:
        serial = Decimal(value)
    except InvalidOperation:
        return None
    if not serial.is_finite() or serial < 0:
        return None
    days = int(serial)
    try:
        if date_1904:
            parsed = date(1904, 1, 1) + timedelta(days=days)
        else:
            parsed = date(1899, 12, 31) + timedelta(days=days - (1 if days >= 60 else 0))
    except OverflowError:
        return None
    return parsed.isoformat()


def _cell_text(
    cell: ElementTree.Element,
    shared: list[str],
    date_styles: list[bool],
    *,
    date_1904: bool,
) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(f".//{{{MAIN_NS}}}t"))
    value = cell.findtext(f"{{{MAIN_NS}}}v", default="")
    if cell_type == "s":
        try:
            return shared[int(value)]
        except (IndexError, ValueError):
            return ""
    if cell_type == "b":
        return "是" if value == "1" else "否"
    try:
        style_index = int(cell.attrib.get("s", "0"))
    except ValueError:
        style_index = 0
    if cell_type in {None, "n"} and 0 <= style_index < len(date_styles):
        if date_styles[style_index]:
            parsed_date = _excel_date(value, date_1904=date_1904)
            if parsed_date:
                return parsed_date
    return value


def _worksheet(
    archive: zipfile.ZipFile,
    path: str,
    shared: list[str],
    date_styles: list[bool],
    date_1904: bool,
    name: str,
) -> ParsedSheet:
    try:
        root = ElementTree.fromstring(archive.read(path))
    except KeyError as error:
        raise InvalidWorkbook(f"工作表文件缺失：{name}") from error
    parsed_rows: list[list[str]] = []
    for row in root.findall(f".//{{{MAIN_NS}}}sheetData/{{{MAIN_NS}}}row"):
        values: list[str] = []
        for cell in row.findall(f"{{{MAIN_NS}}}c"):
            index = _column_index(cell.attrib.get("r", ""))
            if index >= MAX_WORKSHEET_COLUMNS:
                raise InvalidWorkbook(f"工作表 {name} 超过 {MAX_WORKSHEET_COLUMNS} 列")
            while len(values) <= index:
                values.append("")
            values[index] = _cell_text(
                cell,
                shared,
                date_styles,
                date_1904=date_1904,
            ).strip()
        parsed_rows.append(values)
        if len(parsed_rows) > MAX_WORKSHEET_ROWS + 1:
            raise InvalidWorkbook(f"工作表 {name} 超过 {MAX_WORKSHEET_ROWS} 行")
    if not parsed_rows:
        return ParsedSheet(name=name, headers=[], rows=[])
    headers = parsed_rows[0]
    if len(headers) > MAX_WORKSHEET_COLUMNS:
        raise InvalidWorkbook(f"工作表 {name} 超过 {MAX_WORKSHEET_COLUMNS} 列")
    rows = [(row + [""] * len(headers))[: len(headers)] for row in parsed_rows[1:]]
    return ParsedSheet(name=name, headers=headers, rows=rows)


def parse_xlsx(content: bytes) -> list[ParsedSheet]:
    try:
        with zipfile.ZipFile(io.BytesIO(content), "r") as archive:
            members = archive.infolist()
            if any(member.file_size > MAX_MEMBER_BYTES for member in members):
                raise InvalidWorkbook("Excel 文件包含过大的内部文件")
            if sum(member.file_size for member in members) > MAX_UNCOMPRESSED_BYTES:
                raise InvalidWorkbook("Excel 文件解压后过大")
            workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
            relationships = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
            targets = {
                item.attrib["Id"]: item.attrib["Target"]
                for item in relationships.findall(f"{{{PACKAGE_REL_NS}}}Relationship")
            }
            shared = _shared_strings(archive)
            date_styles = _date_styles(archive)
            workbook_properties = workbook.find(f"{{{MAIN_NS}}}workbookPr")
            date_1904 = bool(
                workbook_properties is not None
                and workbook_properties.attrib.get("date1904", "0").lower()
                in {"1", "true"}
            )
            result: list[ParsedSheet] = []
            for sheet in workbook.findall(f".//{{{MAIN_NS}}}sheet"):
                name = sheet.attrib.get("name", "工作表")
                relation_id = sheet.attrib.get(f"{{{REL_NS}}}id")
                target = targets.get(relation_id or "")
                if not target:
                    continue
                path = target.lstrip("/")
                if not path.startswith("xl/"):
                    path = f"xl/{path}"
                result.append(
                    _worksheet(
                        archive,
                        path,
                        shared,
                        date_styles,
                        date_1904,
                        name,
                    )
                )
            if not result:
                raise InvalidWorkbook("Excel 文件中没有可读取的工作表")
            return result
    except (ElementTree.ParseError, KeyError, zipfile.BadZipFile) as error:
        raise InvalidWorkbook("文件不是有效的 XLSX 工作簿") from error
