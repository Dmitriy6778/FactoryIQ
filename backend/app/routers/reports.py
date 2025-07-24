from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel, Field
from typing import List, Optional
import pyodbc
from ..config import get_conn_str

router = APIRouter(prefix="/reports", tags=["reports"])

# ==== МОДЕЛИ ====

class TagConfig(BaseModel):
    tag_id: int
    tag_type: str
    aggregate: Optional[str] = None  # <--- обязательно Optional!
    interval_minutes: int
    display_order: Optional[int] = 0


class ReportTemplateCreate(BaseModel):
    name: str
    description: Optional[str] = None
    report_type: Optional[str] = None
    period_type: Optional[str] = None
    tags: List[TagConfig]
    is_shared: Optional[bool] = False
    auto_schedule: Optional[bool] = False
    target_channel: Optional[str] = None

class ReportTemplate(BaseModel):
    id: int
    name: str
    description: Optional[str]
    report_type: Optional[str]
    period_type: Optional[str]
    tags: List[TagConfig]
    is_shared: bool
    auto_schedule: bool
    target_channel: Optional[str]

class ReportBuildRequest(BaseModel):
    template_id: Optional[int] = None
    tags: Optional[List[TagConfig]] = None
    date_from: str
    date_to: str
    export_format: Optional[str] = "table"

class CustomTagConfig(BaseModel):
    tag_id: int
    aggregate: Optional[str] = None
    interval_minutes: int

class CustomReportBuildRequest(BaseModel):
    tags: List[CustomTagConfig]
    date_from: str
    date_to: str

# ==== ЭНДПОИНТЫ ====

# 1. Создание шаблона отчёта
@router.post("/templates/create")
def create_report_template(payload: ReportTemplateCreate):
    """
    Создать шаблон отчёта с тегами и настройками.
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        # Вставляем шаблон
        cursor.execute("""
            INSERT INTO ReportTemplates (UserId, Name, Description, ReportType, PeriodType, IsShared, AutoSchedule, TargetChannel)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, 1, payload.name, payload.description, payload.report_type, payload.period_type, int(payload.is_shared), int(payload.auto_schedule), payload.target_channel)
        template_id = cursor.execute("SELECT @@IDENTITY").fetchval()

        # Вставляем теги для шаблона
        for idx, tag in enumerate(payload.tags):
            cursor.execute("""
                INSERT INTO ReportTemplateTags (TemplateId, TagId, TagType, Aggregate, IntervalMinutes, DisplayOrder)
                VALUES (?, ?, ?, ?, ?, ?)
            """, template_id, tag.tag_id, tag.tag_type, tag.aggregate, tag.interval_minutes, idx)

        conn.commit()
        return {"ok": True, "template_id": template_id}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# 2. Получение всех шаблонов
@router.get("/templates")
def get_report_templates():
    """
    Получить все шаблоны отчётов.
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("SELECT Id, Name, Description, ReportType, PeriodType, IsShared, AutoSchedule, TargetChannel FROM ReportTemplates")
        templates = []
        for row in cursor.fetchall():
            templates.append({
                "id": row.Id,
                "name": row.Name,
                "description": row.Description,
                "report_type": row.ReportType,
                "period_type": row.PeriodType,
                "is_shared": bool(row.IsShared),
                "auto_schedule": bool(row.AutoSchedule),
                "target_channel": row.TargetChannel,
            })
        return {"ok": True, "templates": templates}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# 3. Получение шаблона с тегами
@router.get("/templates/{template_id}")
def get_report_template(template_id: int):
    """
    Получить шаблон по ID со всеми тегами.
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM ReportTemplates WHERE Id = ?", template_id)
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Template not found")
        cursor.execute("SELECT TagId, TagType, Aggregate, IntervalMinutes, DisplayOrder FROM ReportTemplateTags WHERE TemplateId = ?", template_id)
        tags = []
        for t in cursor.fetchall():
            tags.append({
                "tag_id": t.TagId,
                "tag_type": t.TagType,
                "aggregate": t.Aggregate,
                "interval_minutes": t.IntervalMinutes,
                "display_order": t.DisplayOrder
            })
        return {
            "ok": True,
            "template": {
                "id": row.Id,
                "name": row.Name,
                "description": row.Description,
                "report_type": row.ReportType,
                "period_type": row.PeriodType,
                "is_shared": bool(row.IsShared),
                "auto_schedule": bool(row.AutoSchedule),
                "target_channel": row.TargetChannel,
                "tags": tags,
            }
        }
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# 4. Удаление шаблона
@router.delete("/templates/{template_id}")
def delete_report_template(template_id: int):
    """
    Удалить шаблон отчёта и все его связи.
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("DELETE FROM ReportTemplateTags WHERE TemplateId = ?", template_id)
        cursor.execute("DELETE FROM ReportTemplates WHERE Id = ?", template_id)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


# 7. Получить историю построенных отчётов
@router.get("/history")
def get_reports_history(limit: int = 50):
    """
    Получить последние N построенных отчётов (историю).
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            SELECT TOP (?) r.Id, r.TemplateId, r.UserId, r.DateFrom, r.DateTo, r.DateCreated, r.Status, r.ExportedFile, r.ExportFormat
            FROM Reports r
            ORDER BY r.DateCreated DESC
        """, limit)
        result = []
        for row in cursor.fetchall():
            result.append({
                "id": row.Id,
                "template_id": row.TemplateId,
                "user_id": row.UserId,
                "date_from": row.DateFrom,
                "date_to": row.DateTo,
                "date_created": row.DateCreated,
                "status": row.Status,
                "exported_file": row.ExportedFile,
                "export_format": row.ExportFormat
            })
        return {"ok": True, "reports": result}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# 5. Построение отчёта "Баланс" (Реальная логика)
@router.post("/build")
def build_report(payload: ReportBuildRequest):
    """
    Балансовый отчет по тегам-счетчикам: данные по сменам и суткам
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()

        tag_ids = []
        if payload.tags:
            tag_ids = [t.tag_id for t in payload.tags]
        elif payload.template_id:
            cursor.execute("SELECT TagId FROM ReportTemplateTags WHERE TemplateId = ?", payload.template_id)
            tag_ids = [row.TagId for row in cursor.fetchall()]
        else:
            raise HTTPException(status_code=400, detail="Не заданы теги для отчёта")

        if not tag_ids:
            raise HTTPException(status_code=400, detail="Пустой список тегов")

        tag_ids_str = ",".join(str(tag_id) for tag_id in tag_ids)   # <-- исправил здесь
        cursor.execute("EXEC sp_GetBalanceReport ?, ?, ?", payload.date_from, payload.date_to, tag_ids_str)

        columns = [column[0] for column in cursor.description]
        rows = cursor.fetchall()

        data = [dict(zip(columns, row)) for row in rows]

        return {
            "ok": True,
            "data": data,
            "columns": columns,
        }

    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.post("/build_custom")
def build_custom_report(payload: CustomReportBuildRequest):
    """
    Универсальный кастомный отчет по тегам с любой агрегацией.
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()

        import json
        tags_json = json.dumps([{
            "tag_id": t.tag_id,
            "aggregate": t.aggregate or "",
            "interval_minutes": t.interval_minutes
        } for t in payload.tags])

        cursor.execute(
            "EXEC sp_GetCustomReport ?, ?, ?",
            payload.date_from,
            payload.date_to,
            tags_json
        )
        columns = [column[0] for column in cursor.description]
        rows = cursor.fetchall()
        data = [dict(zip(columns, row)) for row in rows]

        return {
            "ok": True,
            "data": data,
            "columns": columns
        }

    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

