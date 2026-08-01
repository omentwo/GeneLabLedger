from __future__ import annotations

from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_ROOT / ".env",
        env_prefix="GENE_LEDGER_",
        extra="ignore",
    )

    app_name: str = "基因检测台账后端"
    host: str = "127.0.0.1"
    port: int = 8000
    data_dir: Path = BACKEND_ROOT / "data"
    database_url: str | None = None
    auto_create_schema: bool = False
    max_template_size_mb: int = 20
    audit_log_max_rows: int = Field(default=100_000, ge=1_000, le=1_000_000)
    audit_log_retention_days: int = Field(default=365, ge=30, le=3_650)

    @model_validator(mode="after")
    def fill_computed_defaults(self) -> Settings:
        self.data_dir = self.data_dir.resolve()
        if not self.database_url:
            database_path = (self.data_dir / "ledger.db").resolve()
            self.database_url = f"sqlite:///{database_path.as_posix()}"
        return self

    @property
    def template_dir(self) -> Path:
        return self.data_dir / "templates"

    @property
    def report_work_dir(self) -> Path:
        return self.data_dir / "temp" / "reports"

    @property
    def auto_export_dir(self) -> Path:
        return self.data_dir / "exports"

    def ensure_directories(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.template_dir.mkdir(parents=True, exist_ok=True)
        self.report_work_dir.mkdir(parents=True, exist_ok=True)
        self.auto_export_dir.mkdir(parents=True, exist_ok=True)
