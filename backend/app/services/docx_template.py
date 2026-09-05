from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path

from lxml import etree

WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"
WORD_PART_PATTERN = re.compile(
    r"^word/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$",
    re.IGNORECASE,
)
PLACEHOLDER_PATTERN = re.compile(r"{{\s*([^{}]+?)\s*}}")
NS = {"w": WORD_NAMESPACE}


class InvalidDocxTemplate(ValueError):
    pass


def _word_xml_parts(archive: zipfile.ZipFile) -> list[str]:
    return [name for name in archive.namelist() if WORD_PART_PATTERN.match(name)]


def _parse_xml(content: bytes) -> etree._Element:
    parser = etree.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)
    return etree.fromstring(content, parser=parser)


def _paragraph_text_nodes(paragraph: etree._Element) -> list[etree._Element]:
    return list(paragraph.xpath(".//w:t", namespaces=NS))


def _read_placeholders_from_xml(content: bytes) -> list[str]:
    root = _parse_xml(content)
    found: list[str] = []
    for paragraph in root.xpath(".//w:p", namespaces=NS):
        joined = "".join(node.text or "" for node in _paragraph_text_nodes(paragraph))
        for match in PLACEHOLDER_PATTERN.finditer(joined):
            placeholder = match.group(1).strip()
            if placeholder and placeholder not in found:
                found.append(placeholder)
    return found


def extract_placeholders(source: bytes | Path) -> list[str]:
    stream = io.BytesIO(source) if isinstance(source, bytes) else source
    try:
        with zipfile.ZipFile(stream, "r") as archive:
            if "[Content_Types].xml" not in archive.namelist():
                raise InvalidDocxTemplate("文件不是有效的 DOCX")
            found: list[str] = []
            for part_name in _word_xml_parts(archive):
                for placeholder in _read_placeholders_from_xml(archive.read(part_name)):
                    if placeholder not in found:
                        found.append(placeholder)
            return found
    except zipfile.BadZipFile as error:
        raise InvalidDocxTemplate("文件不是有效的 DOCX") from error


def _set_text(node: etree._Element, value: str) -> None:
    node.text = value
    xml_space = f"{{{XML_NAMESPACE}}}space"
    if value.startswith(" ") or value.endswith(" "):
        node.set(xml_space, "preserve")
    elif xml_space in node.attrib:
        del node.attrib[xml_space]


def _replace_paragraph(paragraph: etree._Element, replacements: dict[str, str]) -> None:
    nodes = _paragraph_text_nodes(paragraph)
    if not nodes:
        return
    texts = [node.text or "" for node in nodes]
    joined = "".join(texts)
    matches = [
        match for match in PLACEHOLDER_PATTERN.finditer(joined) if match.group(1).strip() in replacements
    ]
    if not matches:
        return

    starts: list[int] = []
    cursor = 0
    for text in texts:
        starts.append(cursor)
        cursor += len(text)

    def node_index_for(position: int, *, end: bool = False) -> int:
        if end and position > 0:
            position -= 1
        for index, start in enumerate(starts):
            node_end = start + len(texts[index])
            if start <= position < node_end:
                return index
        return max(0, len(nodes) - 1)

    for match in reversed(matches):
        placeholder = match.group(1).strip()
        replacement = str(replacements.get(placeholder, ""))
        start_index = node_index_for(match.start())
        end_index = node_index_for(match.end(), end=True)
        start_offset = match.start() - starts[start_index]
        end_offset = match.end() - starts[end_index]
        if start_index == end_index:
            current = nodes[start_index].text or ""
            _set_text(
                nodes[start_index],
                current[:start_offset] + replacement + current[end_offset:],
            )
            continue

        start_text = nodes[start_index].text or ""
        end_text = nodes[end_index].text or ""
        _set_text(nodes[start_index], start_text[:start_offset] + replacement)
        for index in range(start_index + 1, end_index):
            _set_text(nodes[index], "")
        _set_text(nodes[end_index], end_text[end_offset:])


def _replace_xml(content: bytes, replacements: dict[str, str]) -> bytes:
    root = _parse_xml(content)
    for paragraph in root.xpath(".//w:p", namespaces=NS):
        _replace_paragraph(paragraph, replacements)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def render_docx(template_path: Path, output_path: Path, replacements: dict[str, str]) -> None:
    if template_path.resolve() == output_path.resolve():
        raise InvalidDocxTemplate("输出路径不能与模板路径相同")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(template_path, "r") as source_archive:
            with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as target_archive:
                word_parts = set(_word_xml_parts(source_archive))
                for item in source_archive.infolist():
                    content = source_archive.read(item.filename)
                    if item.filename in word_parts:
                        content = _replace_xml(content, replacements)
                    target_archive.writestr(item, content)
    except zipfile.BadZipFile as error:
        raise InvalidDocxTemplate("保存的 Word 模板已损坏") from error
