# reports.py
# Модуль для работы с отчётами: создание, получение, построение и т.д.
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
    style_id: Optional[int] = None    

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
    style_id: Optional[int] = None    

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


class SetTemplateStyleDTO(BaseModel):
    style_id: int

class TemplateStyleSet(BaseModel):
    style_id: Optional[int]  # можно None, чтобы отвязать

# helpers
def _db():
    return pyodbc.connect(get_conn_str())


# ==== ЭНДПОИНТЫ ====

# 1. Создание шаблона отчёта
# reports.py

from .auth import get_current_user   # или твой провайдер юзера

@router.post("/templates/create")
def create_report_template(
    payload: ReportTemplateCreate,
    user = Depends(get_current_user)  # <-- берём текущего юзера из JWT
):
    """
    Создаёт шаблон отчёта и его теги от имени текущего пользователя.
    FK на Users не ломается, потому что пишем реальный user_id.
    """
    try:
        with _db() as conn:
            cur = conn.cursor()

            user_id = int(user["id"]) if user and user.get("id") else None  # если колонка UserId допускает NULL — тоже ок

            # ВАЖНО: используем OUTPUT INSERTED.Id вместо @@IDENTITY
            cur.execute(
                """
                INSERT INTO ReportTemplates
                (UserId, Name, Description, ReportType, PeriodType, IsShared, AutoSchedule, TargetChannel, StyleId)
                OUTPUT INSERTED.Id
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                user_id,
                payload.name,
                payload.description,
                payload.report_type,
                payload.period_type,
                int(payload.is_shared or 0),
                int(payload.auto_schedule or 0),
                payload.target_channel,
                payload.style_id,
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=500, detail="Insert ReportTemplates failed")
            template_id = int(row[0])

            # теги
            for idx, tag in enumerate(payload.tags):
                cur.execute(
                    """
                    INSERT INTO ReportTemplateTags
                    (TemplateId, TagId, TagType, Aggregate, IntervalMinutes, DisplayOrder)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    template_id,
                    tag.tag_id,
                    tag.tag_type,
                    (tag.aggregate or None),   # Aggregate может быть NULL
                    tag.interval_minutes,
                    idx,
                )

            conn.commit()
            return {"ok": True, "template_id": template_id}

    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))




# 2. Получение всех шаблонов
@router.get("/templates")
def get_report_templates():
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT Id, Name, Description, ReportType, PeriodType, IsShared, AutoSchedule, TargetChannel, StyleId
                FROM ReportTemplates
            """)
            templates = []
            for row in cur.fetchall():
                templates.append({
                    "id": row.Id,
                    "name": row.Name,
                    "description": row.Description,
                    "report_type": row.ReportType,
                    "period_type": row.PeriodType,
                    "is_shared": bool(row.IsShared),
                    "auto_schedule": bool(row.AutoSchedule),
                    "target_channel": row.TargetChannel,
                    "style_id": getattr(row, "StyleId", None),
                })
            return {"ok": True, "templates": templates}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# app/routers/reports.py
@router.get("/templates/{template_id}")
def get_report_template(template_id: int):
    try:
        with _db() as conn:
            cur = conn.cursor()

            cur.execute("SELECT * FROM ReportTemplates WHERE Id = ?", template_id)
            tpl = cur.fetchone()
            if not tpl:
                raise HTTPException(status_code=404, detail="Template not found")

            # ВАЖНО: в OpcTags НЕТ столбца Name — используем BrowseName
            cur.execute("""
                SELECT
                    t.TagId            AS TagId,
                    t.TagType          AS TagType,
                    t.Aggregate        AS Aggregate,
                    t.IntervalMinutes  AS IntervalMinutes,
                    t.DisplayOrder     AS DisplayOrder,
                    ot.BrowseName      AS BrowseName,
                    ot.BrowseName      AS Name,        -- совместимость с фронтом
                    ot.Description     AS Description
                FROM ReportTemplateTags t
                LEFT JOIN OpcTags ot ON ot.Id = t.TagId
                WHERE t.TemplateId = ?
                ORDER BY t.DisplayOrder
            """, template_id)

            cols = [c[0] for c in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]

            tags = [{
                "tag_id": r["TagId"],
                "tag_type": r["TagType"],
                "aggregate": r["Aggregate"],
                "interval_minutes": r["IntervalMinutes"],
                "display_order": r["DisplayOrder"],
                "browse_name": r.get("BrowseName"),
                "name": r.get("Name"),                # = BrowseName
                "description": r.get("Description"),
            } for r in rows]

            return {"ok": True, "template": {
                "id": tpl.Id,
                "name": tpl.Name,
                "description": tpl.Description,
                "report_type": tpl.ReportType,
                "period_type": tpl.PeriodType,
                "is_shared": bool(tpl.IsShared),
                "auto_schedule": bool(tpl.AutoSchedule),
                "target_channel": tpl.TargetChannel,
                "style_id": getattr(tpl, "StyleId", None),
                "tags": tags,
            }}
    except HTTPException:
        raise
    except Exception as ex:
        import traceback; traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(ex))


# 4. Удаление шаблона
@router.delete("/templates/{template_id}")
def delete_report_template(template_id: int):
    """
    Удалить шаблон отчёта и все его связи.
    """
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM ReportTemplateTags WHERE TemplateId = ?", template_id)
            cur.execute("DELETE FROM ReportTemplates WHERE Id = ?", template_id)
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.put("/templates/{template_id}/style")
def set_template_style(template_id: int, body: TemplateStyleSet):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("UPDATE ReportTemplates SET StyleId=? WHERE Id=?", body.style_id, template_id)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Template not found")
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
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT TOP (?) r.Id, r.TemplateId, r.UserId, r.DateFrom, r.DateTo, r.DateCreated, r.Status, r.ExportedFile, r.ExportFormat
                FROM Reports r
                ORDER BY r.DateCreated DESC
            """, limit)
            result = []
            for row in cur.fetchall():
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
        with _db() as conn:
            cur = conn.cursor()
            tag_ids = []
            if payload.tags:
                tag_ids = [t.tag_id for t in payload.tags]
            elif payload.template_id:
                cur.execute("SELECT TagId FROM ReportTemplateTags WHERE TemplateId = ?", payload.template_id)
                tag_ids = [row.TagId for row in cur.fetchall()]
            else:
                raise HTTPException(status_code=400, detail="Не заданы теги для отчёта")

            if not tag_ids:
                raise HTTPException(status_code=400, detail="Пустой список тегов")

            tag_ids_str = ",".join(str(tag_id) for tag_id in tag_ids)   # <-- исправил здесь
            cur.execute("EXEC sp_GetBalanceReport ?, ?, ?", payload.date_from, payload.date_to, tag_ids_str)

            columns = [column[0] for column in cur.description]
            rows = cur.fetchall()

            data = [dict(zip(columns, row)) for row in rows]

            return {
                "ok": True,
                "data": data,
                "columns": columns,
            }

    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))
    
# Построение остальных видов отчётов где переменная не является счётчиком как в баллансе
@router.post("/build_custom")
def build_custom_report(payload: CustomReportBuildRequest):
    """
    Универсальный кастомный отчет по тегам с любой агрегацией.
    """
    try:
        with _db() as conn:
            cur = conn.cursor()
            import json
            tags_json = json.dumps([{
                "tag_id": t.tag_id,
                "aggregate": t.aggregate or "",
                "interval_minutes": t.interval_minutes
            } for t in payload.tags])

            cur.execute(
                "EXEC sp_GetCustomReport ?, ?, ?",
                payload.date_from,
                payload.date_to,
                tags_json
            )
            columns = [column[0] for column in cur.description]
            rows = cur.fetchall()
            data = [dict(zip(columns, row)) for row in rows]

            return {
                "ok": True,
                "data": data,
                "columns": columns
            }

    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

