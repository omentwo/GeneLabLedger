from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from xml.etree import ElementTree

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CELL_REFERENCE = re.compile(r"([A-Z]+)")
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_MEMBER_BYTES = 50 * 1024 * 1024


@dataclass(slots=True)
class ParsedSheet:
    name: str
    headers: list[str]
    rows: list[list[str]]


class InvalidWorkbook(ValueError):
    pass


def _column_index(reference: str) -> int:
    match = CELL_REFERENCE.match(reference.upper())
    if not match:
        return 0
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


def _cell_text(cell: ElementTree.Element, shared: list[str]) -> str:
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
    return value


def _worksheet(archive: zipfile.ZipFile, path: str, shared: list[str], name: str) -> ParsedSheet:
    try:
        root = ElementTree.fromstring(archive.read(path))
    except KeyError as error:
        raise InvalidWorkbook(f"工作表文件缺失：{name}") from error
    parsed_rows: list[list[str]] = []
    for row in root.findall(f".//{{{MAIN_NS}}}sheetData/{{{MAIN_NS}}}row"):
        values: list[str] = []
        for cell in row.findall(f"{{{MAIN_NS}}}c"):
            index = _column_index(cell.attrib.get("r", ""))
            while len(values) <= index:
                values.append("")
            values[index] = _cell_text(cell, shared).strip()
        parsed_rows.append(values)
        if len(parsed_rows) > 10001:
            raise InvalidWorkbook(f"工作表 {name} 超过 10000 行")
    if not parsed_rows:
        return ParsedSheet(name=name, headers=[], rows=[])
    headers = parsed_rows[0]
    if len(headers) > 200:
        raise InvalidWorkbook(f"工作表 {name} 超过 200 列")
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
                result.append(_worksheet(archive, path, shared, name))
            if not result:
                raise InvalidWorkbook("Excel 文件中没有可读取的工作表")
            return result
    except (ElementTree.ParseError, KeyError, zipfile.BadZipFile) as error:
        raise InvalidWorkbook("文件不是有效的 XLSX 工作簿") from error
