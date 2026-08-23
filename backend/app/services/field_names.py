from __future__ import annotations

from app.models import FieldDefinition

RESERVED_WORKBOOK_HEADERS = frozenset({"_record_id", "_project_id"})


def field_import_identifiers(field: FieldDefinition) -> tuple[str, ...]:
    """Return every workbook header that can identify one field."""

    identifiers = (
        field.label.strip(),
        field.key.strip(),
        field.system_key.strip() if field.system_key else "",
    )
    return tuple(dict.fromkeys(identifier for identifier in identifiers if identifier))
