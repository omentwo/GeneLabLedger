from __future__ import annotations

import io
import zipfile

from fastapi.testclient import TestClient


def minimal_docx() -> bytes:
    document_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>病理号：{{case_no}}</w:t></w:r></w:p>
    <w:p><w:r><w:t>实验编号：{{experiment_no}}</w:t></w:r></w:p>
  </w:body>
</w:document>"""
    content_types = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>"""
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("word/document.xml", document_xml)
    return stream.getvalue()


def test_seed_and_health(client: TestClient, seeded_projects: dict[str, dict]) -> None:
    assert set(seeded_projects) == {"TB", "BRAFV600E"}
    for project in seeded_projects.values():
        assert [field["label"] for field in project["fields"]] == [
            "日期",
            "病理号",
            "实验编号",
            "状态",
        ]
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["print_engines"][0] == {
        "key": "auto",
        "label": "自动",
        "available": True,
        "resolved_engine": "word",
    }


def test_frontend_and_json_settings_are_served(client: TestClient) -> None:
    frontend = client.get("/")
    assert frontend.status_code == 200
    assert "基因检测台账管理系统" in frontend.text
    assert client.get("/api/settings/queue_columns").json()["value"] is None
    payload = {"value": [{"key": "caseId", "name": "病理号", "export": True}]}
    saved = client.put("/api/settings/queue_columns", json=payload)
    assert saved.status_code == 200
    assert saved.json() == {"key": "queue_columns", **payload}
    assert client.get("/api/settings/queue_columns").json() == {
        "key": "queue_columns",
        **payload,
    }


def test_audit_logs_support_keyword_search(client: TestClient) -> None:
    created = client.post("/api/projects", json={"name": "日志检索项目"})
    assert created.status_code == 201

    by_action = client.get("/api/audit-logs?search=project.create&limit=100")
    assert by_action.status_code == 200
    assert any(log["entity_id"] == created.json()["id"] for log in by_action.json())
    by_chinese_action = client.get("/api/audit-logs?search=添加项目&limit=100")
    assert any(log["entity_id"] == created.json()["id"] for log in by_chinese_action.json())

    by_details = client.get("/api/audit-logs?search=日志检索项目&limit=100")
    assert any(log["entity_id"] == created.json()["id"] for log in by_details.json())
    assert client.get("/api/audit-logs?search=完全不存在的关键词&limit=100").json() == []


def test_unique_case_can_join_many_projects_and_repeat(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb_id = seeded_projects["TB"]["id"]
    braf_id = seeded_projects["BRAFV600E"]["id"]
    created = client.post(
        "/api/records",
        json={"project_id": tb_id, "pathology_number": "26-00001"},
    )
    assert created.status_code == 201
    tb_record = created.json()

    assigned = client.post(
        f"/api/records/{tb_record['id']}/assign-project",
        json={"target_project_id": braf_id},
    )
    assert assigned.status_code == 200
    braf_record = assigned.json()
    assert braf_record["case_id"] == tb_record["case_id"]
    assert braf_record["pathology_number"] == "26-00001"

    duplicate = client.post(
        "/api/records",
        json={"project_id": tb_id, "pathology_number": "26-00001"},
    )
    assert duplicate.status_code == 409

    repeat = client.post(
        f"/api/records/{braf_record['id']}/repeat",
        json={"experiment_date": "2026-07-29"},
    )
    assert repeat.status_code == 200
    assert repeat.json()["is_repeat"] is True

    second_repeat = client.post(
        f"/api/records/{braf_record['id']}/repeat",
        json={"experiment_date": "2026-07-29"},
    )
    assert second_repeat.status_code == 200
    batch = client.get("/api/experiments/batches/2026-07-29").json()
    assert len(batch["runs"]) == 2
    assert [run["experiment_number"] for run in batch["runs"]] == [
        "20260729-01",
        "20260729-02",
    ]


def test_adding_experiment_run_never_creates_another_project_record(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    braf_id = seeded_projects["BRAFV600E"]["id"]
    record = client.post(
        "/api/records",
        json={"project_id": braf_id, "pathology_number": "BRAF-ONLY-001"},
    ).json()

    added = client.post(
        "/api/experiments/batches/2026-07-30/runs",
        json={"record_id": record["id"], "allow_repeat": False},
    )
    assert added.status_code == 201
    assert added.json()["project_id"] == braf_id
    assert added.json()["project_name"] == "BRAFV600E"

    all_records = client.get("/api/records?limit=1000").json()["items"]
    assert [(item["project_name"], item["pathology_number"]) for item in all_records] == [
        ("BRAFV600E", "BRAF-ONLY-001")
    ]

    removed = client.delete(f"/api/experiments/runs/{added.json()['id']}")
    assert removed.status_code == 204
    assert client.get("/api/experiments/batches/2026-07-30").json()["runs"] == []

    records_after_removal = client.get("/api/records?limit=1000").json()["items"]
    assert [
        (item["project_name"], item["pathology_number"]) for item in records_after_removal
    ] == [("BRAFV600E", "BRAF-ONLY-001")]
    assert records_after_removal[0]["experiment_date"] is None


def test_records_are_listed_oldest_first_so_new_rows_append_at_bottom(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb_id = seeded_projects["TB"]["id"]
    first = client.post(
        "/api/records",
        json={"project_id": tb_id, "pathology_number": "ORDER-001"},
    ).json()
    second = client.post(
        "/api/records",
        json={"project_id": tb_id, "pathology_number": "ORDER-002"},
    ).json()

    listed = client.get(f"/api/records?project_id={tb_id}&limit=1000").json()["items"]
    assert [item["id"] for item in listed] == [first["id"], second["id"]]


def test_custom_field_hard_delete_removes_values(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    core_field = next(field for field in tb["fields"] if field["system_key"] == "pathology_number")
    assert client.delete(f"/api/projects/fields/{core_field['id']}").status_code == 409

    custom = client.post(
        f"/api/projects/{tb['id']}/fields",
        json={"label": "DNA浓度", "data_type": "text"},
    ).json()
    created = client.post(
        "/api/records",
        json={
            "project_id": tb["id"],
            "pathology_number": "26-00002",
            "values": {custom["id"]: "100ng"},
        },
    ).json()
    assert created["values"][custom["id"]] == "100ng"
    assert client.delete(f"/api/projects/fields/{custom['id']}").status_code == 204
    refreshed = client.get(f"/api/records/{created['id']}").json()
    assert custom["id"] not in refreshed["values"]


def test_new_custom_value_is_returned_immediately_after_update(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    custom = client.post(
        f"/api/projects/{tb['id']}/fields",
        json={"label": "DNA", "data_type": "text"},
    ).json()
    created = client.post(
        "/api/records",
        json={"project_id": tb["id"], "pathology_number": "26-00004"},
    ).json()

    updated = client.patch(
        f"/api/records/{created['id']}",
        json={"values": {custom["id"]: "150"}},
    )

    assert updated.status_code == 200
    assert updated.json()["values"][custom["id"]] == "150"


def test_template_mapping_and_word_document_generation(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    pathology_field = next(field for field in tb["fields"] if field["system_key"] == "pathology_number")
    record = client.post(
        "/api/records",
        json={"project_id": tb["id"], "pathology_number": "26-00003"},
    ).json()
    run = client.post(
        f"/api/records/{record['id']}/repeat",
        json={"experiment_date": "2026-07-29"},
    ).json()

    uploaded = client.post(
        "/api/report-templates",
        data={"project_id": tb["id"], "name": "TB报告"},
        files={
            "file": (
                "tb.docx",
                minimal_docx(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    )
    assert uploaded.status_code == 201
    version = uploaded.json()["versions"][0]
    mapped = client.put(
        f"/api/report-template-versions/{version['id']}/mappings",
        json={
            "mappings": [
                {
                    "placeholder": "case_no",
                    "source_type": "field",
                    "field_id": pathology_field["id"],
                },
                {
                    "placeholder": "experiment_no",
                    "source_type": "experiment_number",
                },
            ]
        },
    )
    assert mapped.status_code == 200

    generated = client.post(
        "/api/reports/documents",
        json={
            "template_version_id": version["id"],
            "items": [
                {
                    "project_record_id": record["id"],
                    "experiment_run_id": run["id"],
                }
            ],
        },
    )
    assert generated.status_code == 200
    assert generated.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    with zipfile.ZipFile(io.BytesIO(generated.content)) as archive:
        document_xml = archive.read("word/document.xml").decode("utf-8")
    assert "26-00003" in document_xml
    assert run["experiment_number"] in document_xml

    second_record = client.post(
        "/api/records",
        json={"project_id": tb["id"], "pathology_number": "26-00004"},
    ).json()
    batch = client.post(
        "/api/reports/documents",
        json={
            "template_version_id": version["id"],
            "items": [
                {"project_record_id": record["id"], "experiment_run_id": run["id"]},
                {
                    "project_record_id": second_record["id"],
                    "experiment_run_id": None,
                },
            ],
        },
    )
    assert batch.status_code == 200
    assert batch.headers["content-type"].startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(batch.content)) as archive:
        assert len([name for name in archive.namelist() if name.endswith(".docx")]) == 2


def test_experiment_commit_overwrites_exact_project_record(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    braf = seeded_projects["BRAFV600E"]
    tb_record = client.post(
        "/api/records",
        json={
            "project_id": tb["id"],
            "pathology_number": "25-99999",
            "experiment_number": "OLD-TB",
        },
    ).json()
    braf_record = client.post(
        "/api/records",
        json={
            "project_id": braf["id"],
            "pathology_number": "25-99999",
            "experiment_number": "OLD-BRAF",
        },
    ).json()

    run = client.post(
        "/api/experiments/batches/2026-07-30/runs",
        json={"record_id": tb_record["id"], "allow_repeat": False},
    ).json()
    committed = client.post("/api/experiments/batches/2026-07-30/commit")
    assert committed.status_code == 200
    assert committed.json()["updated_records"] == 1

    refreshed_tb = client.get(f"/api/records/{tb_record['id']}").json()
    refreshed_braf = client.get(f"/api/records/{braf_record['id']}").json()
    assert refreshed_tb["experiment_number"] == run["experiment_number"]
    assert refreshed_braf["experiment_number"] == "OLD-BRAF"

    manual = client.patch(
        f"/api/records/{tb_record['id']}",
        json={"experiment_number": "MANUAL-001"},
    )
    assert manual.status_code == 200
    assert manual.json()["experiment_number"] == "MANUAL-001"


def test_hidden_fields_project_eligibility_and_report_status(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    experiment_field = next(
        field for field in tb["fields"] if field["system_key"] == "experiment_number"
    )
    hidden = client.patch(
        f"/api/projects/fields/{experiment_field['id']}",
        json={"hidden": True},
    )
    assert hidden.status_code == 200
    assert hidden.json()["hidden"] is True
    assert client.delete(f"/api/projects/fields/{experiment_field['id']}").status_code == 409

    eligibility = client.patch(
        f"/api/projects/{tb['id']}",
        json={"experiment_enabled": False},
    )
    assert eligibility.status_code == 200
    assert eligibility.json()["experiment_enabled"] is False

    first = client.post(
        "/api/records",
        json={"project_id": tb["id"], "pathology_number": "26-01001"},
    ).json()
    second = client.post(
        "/api/records",
        json={"project_id": tb["id"], "pathology_number": "26-01002"},
    ).json()
    marked = client.put(
        "/api/records/report-status",
        json={"record_ids": [first["id"]], "report_generated": True},
    )
    assert marked.status_code == 200
    assert marked.json()[0]["report_generated"] is True
    pending_reports = client.get(
        f"/api/records?project_id={tb['id']}&report_generated=false&limit=1000"
    ).json()["items"]
    assert [record["id"] for record in pending_reports] == [second["id"]]


def test_workbook_export_is_a_real_xlsx_archive(client: TestClient) -> None:
    exported = client.post(
        "/api/exports/workbook",
        json={
            "filename": "TB 台账",
            "sheets": [
                {
                    "name": "TB",
                    "headers": ["病理号", "实验编号"],
                    "rows": [["25-99999", "20260730-01"], ["26-00001", "20260730-02"]],
                }
            ],
        },
    )
    assert exported.status_code == 200
    assert exported.content.startswith(b"PK")
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        names = set(archive.namelist())
        assert {
            "[Content_Types].xml",
            "xl/workbook.xml",
            "xl/styles.xml",
            "xl/worksheets/sheet1.xml",
        }.issubset(names)
        assert "25-99999" in archive.read("xl/worksheets/sheet1.xml").decode("utf-8")


def test_direct_print_submits_multiple_reports_once(
    client: TestClient,
    seeded_projects: dict[str, dict],
) -> None:
    tb = seeded_projects["TB"]
    records = [
        client.post(
            "/api/records",
            json={"project_id": tb["id"], "pathology_number": pathology_number},
        ).json()
        for pathology_number in ("26-02001", "26-02002")
    ]
    uploaded = client.post(
        "/api/report-templates",
        data={"project_id": tb["id"], "name": "批量打印模板"},
        files={
            "file": (
                "tb.docx",
                minimal_docx(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        },
    ).json()
    version = uploaded["versions"][0]
    mapped = client.put(
        f"/api/report-template-versions/{version['id']}/mappings",
        json={
            "mappings": [
                {
                    "placeholder": placeholder,
                    "source_type": "blank",
                    "field_id": None,
                    "fixed_value": None,
                }
                for placeholder in version["placeholders"]
            ]
        },
    )
    assert mapped.status_code == 200
    printers = client.get("/api/printers")
    assert printers.json() == [{"name": "测试打印机", "is_default": True}]
    engines = client.get("/api/print-engines")
    assert engines.status_code == 200
    assert engines.json()[0]["resolved_engine"] == "word"
    printed = client.post(
        "/api/reports/print",
        json={
            "template_version_id": version["id"],
            "printer_name": "测试打印机",
            "items": [
                {"project_record_id": record["id"], "experiment_run_id": None}
                for record in records
            ],
            "print_engine": "auto",
        },
    )
    assert printed.status_code == 200
    assert printed.json() == {
        "printer_name": "测试打印机",
        "printed_count": 2,
        "print_engine": "word",
    }
