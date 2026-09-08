from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas import FieldCreate, FieldUpdate


def test_field_width_accepts_compact_columns() -> None:
    assert FieldCreate(label="短列", width=32).width == 32
    assert FieldUpdate(width=32).width == 32


@pytest.mark.parametrize("width", [31, 601])
def test_field_width_rejects_values_outside_supported_range(width: int) -> None:
    with pytest.raises(ValidationError):
        FieldCreate(label="列", width=width)
    with pytest.raises(ValidationError):
        FieldUpdate(width=width)
