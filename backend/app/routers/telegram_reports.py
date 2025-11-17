# backend/app/routers/telegram_reports.py
# Модуль для работы с отчётами в Telegram: создание, предпросмотр, расписания
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Tuple, Union
import json
# ВАЖНО: backend для matplotlib нужно выбирать ДО pyplot
import matplotlib
matplotlib.use("Agg")
import pyodbc
from ..config import get_conn_str, get_env
# вверху файла
from .telegram_simple import (
    _exec_proc as _exec_proc_simple,
    _build_series as _build_series_simple,
    _render_line as _render_line_simple,
    _render_bar as _render_bar_simple,
    _make_text_table as _make_text_table_simple,
)
from datetime import datetime, timedelta
from .telegram_simple import preview as _preview2, PreviewIn as _PreviewIn

import base64
import requests
from .telegram_simple import _soft_normalize as _soft_norm

TG_TOKEN = get_env("TG_TOKEN", "")

# --------------------------------------------------------------------------------------
# Router
# --------------------------------------------------------------------------------------
router = APIRouter(prefix="/telegram", tags=["telegram"])


# --------------------------------------------------------------------------------------
# Pydantic модели
# --------------------------------------------------------------------------------------
class ChannelCreate(BaseModel):
    channel_id: str
    channel_name: str
    thread_id: Optional[int] = None
    send_as_file: bool = True
    send_as_text: bool = False
    send_as_chart: bool = False
    active: bool = True


class ChannelUpdate(ChannelCreate):
    id: int


class ReportScheduleCreate(BaseModel):
    template_id: int
    period_type: str
    time_of_day: str
    target_type: str
    target_value: str
    aggregation_type: Optional[str] = None
    send_format: Optional[str] = None


class ReportTaskBase(BaseModel):
    template_id: int = Field(..., alias="template_id")
    period_type: str = Field(..., alias="period_type")  # every_5m|every_10m|every_30m|hourly|shift|daily|weekly|monthly|once
    time_of_day: Optional[str] = Field(None, alias="time_of_day")  # "HH:MM:SS" или None
    target_type: str = Field("telegram", alias="target_type")
    target_value: Union[str, int] = Field(..., alias="target_value")
    aggregation_type: Optional[str] = Field(None, alias="aggregation_type")  # "avg|min|max" или None
    send_format: Optional[str] = Field("chart", alias="send_format")         # chart|table|file|text
    window_minutes: Optional[int] = Field(None, alias="window_minutes")      # для every_*m
    avg_seconds: Optional[int] = Field(None, alias="avg_seconds")            # для every_*m
    style_id: Optional[int] = Field(None, alias="style_id")
    style_override: Optional[Union[str, Dict[str, Any]]] = Field(None, alias="style_override")

class ReportTaskCreate(ReportTaskBase):
    pass

class ReportTaskUpdate(ReportTaskBase):
    pass

# --- входная модель send (расширена стилями) ---
class SendIn(BaseModel):
    template_id: int
    format: str                   # chart|table|text|file
    period_type: str
    time_of_day: Optional[str] = None
    aggregation_type: Optional[str] = None
    window_minutes: Optional[int] = None
    avg_seconds: Optional[int] = None
    target_type: str = "telegram"
    target_value: Any

    # style overrides (пробрасываем в preview)
    text_template: Optional[str] = None
    chart_title: Optional[str] = None
    chart_kind: Optional[str] = None
    expand_weekly_shifts: Optional[bool] = None

# ---- Формат текстовой таблицы и sampling ----
class TextFormat(BaseModel):
    columns: Optional[List[str]] = None
    rename: Optional[Dict[str, str]] = None
    enabled: Optional[Dict[str, bool]] = None
    show_header: bool = True
    delimiter: str = " | "
    number_precision: int = 1
    thousand_sep: str = " "
    decimal_sep: str = ","
    date_format: str = "%Y-%m-%d %H:%M:%S"
    title: Optional[str] = None


class SamplingCfg(BaseModel):
    mode: Optional[str] = None            # "last_per_step"
    step_minutes: Optional[int] = None    # 1/2/5/10...



# --------------------------------------------------------------------------------------
# Утилиты БД/дат
# --------------------------------------------------------------------------------------
def _db() -> pyodbc.Connection:
    """Подключение к БД (autocommit выключен)."""
    return pyodbc.connect(get_conn_str())


def _window_by_period(p: Optional[str]) -> Optional[int]:
    return 5 if p == "every_5m" else 10 if p == "every_10m" else 30 if p == "every_30m" else None


def _rows_to_dicts(cursor: pyodbc.Cursor) -> Tuple[List[str], List[Dict[str, Any]]]:
    cols = [col[0] for col in cursor.description]
    data = [dict(zip(cols, row)) for row in cursor.fetchall()]
    return cols, data

# --------------------------------------------------------------------------------------
# Каналы Telegram
# --------------------------------------------------------------------------------------
@router.get("/channels")
def get_channels():
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT Id, ChannelId, ChannelName, ThreadId,
                       SendAsFile, SendAsText, SendAsChart, Active
                FROM TelegramReportTarget
                WHERE Active = 1
            """)
            channels: List[Dict[str, Any]] = []
            for row in cur.fetchall():
                channels.append({
                    "id": row.Id,
                    "channel_id": row.ChannelId,
                    "channel_name": row.ChannelName,
                    "thread_id": row.ThreadId,
                    "send_as_file": bool(row.SendAsFile),
                    "send_as_text": bool(row.SendAsText),
                    "send_as_chart": bool(row.SendAsChart),
                    "active": bool(row.Active),
                })
            return {"ok": True, "channels": channels}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.post("/channels")
def add_channel(channel: ChannelCreate):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO TelegramReportTarget
                    (ChannelId, ChannelName, ThreadId, SendAsFile, SendAsText, SendAsChart, Active)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, channel.channel_id, channel.channel_name, channel.thread_id,
                         int(channel.send_as_file), int(channel.send_as_text),
                         int(channel.send_as_chart), int(channel.active))
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.put("/channels/{id}")
def update_channel(id: int, channel: ChannelUpdate):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE TelegramReportTarget
                SET ChannelId=?, ChannelName=?, ThreadId=?,
                    SendAsFile=?, SendAsText=?, SendAsChart=?, Active=?
                WHERE Id=?
            """, channel.channel_id, channel.channel_name, channel.thread_id,
                         int(channel.send_as_file), int(channel.send_as_text),
                         int(channel.send_as_chart), int(channel.active), id)
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.delete("/channels/{id}")
def delete_channel(id: int):
    """
    Физическое удаление канала. Блокируем удаление, если используется в расписаниях.
    """
    try:
        with _db() as conn:
            cur = conn.cursor()

            cur.execute("""
                SELECT COUNT(*)
                FROM ReportSchedule
                WHERE TargetType = 'telegram' AND TRY_CAST(TargetValue AS INT) = ?
            """, id)
            in_use = cur.fetchone()[0] or 0
            if in_use > 0:
                raise HTTPException(
                    status_code=409,
                    detail="Канал используется в заданиях, сперва удалите/обновите связанные задания"
                )

            cur.execute("DELETE FROM TelegramReportTarget WHERE Id = ?", id)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Канал не найден")
            conn.commit()
            return {"ok": True, "deleted": id}
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


# --------------------------------------------------------------------------------------
# Вспомогательные функции отчётов
# --------------------------------------------------------------------------------------
def get_tag_ids_for_template(template_id: int, *, as_list: bool = False):
    with _db() as conn:
        cur = conn.cursor()
        cur.execute("SELECT TagId FROM ReportTemplateTags WHERE TemplateId=?", template_id)
        ids = [row[0] for row in cur.fetchall()]
        return ids if as_list else (",".join(str(x) for x in ids) if ids else None)


# === Helpers ===


def _parse_tod(tod: Optional[str]):
    if not tod:
        return None
    try:
        hh, mm, ss = (tod.split(":") + ["0", "0"])[:3]
        return int(hh), int(mm), int(ss)
    except Exception:
        return None

def compute_initial_nextrun(period_type: str, time_of_day: Optional[str]):
    from datetime import datetime, timedelta
    now = datetime.now()
    pt = (period_type or "").lower()

    if pt in ("every_5m", "every_10m", "every_30m"):
        wm = _window_by_period(pt) or 5
        minutes = ((now.minute // wm) + 1) * wm
        delta_minutes = minutes - now.minute
        if delta_minutes <= 0:
            delta_minutes += wm
        return now.replace(second=0, microsecond=0) + timedelta(minutes=delta_minutes)

    if pt == "hourly":
        return now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)

    hhmmss = _parse_tod(time_of_day)
    if hhmmss:
        hh, mm, ss = hhmmss
    else:
        hh, mm, ss = 8, 0, 0  # дефолт 08:00

    base = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)

    if pt in ("daily", "shift", "once"):
        return base if base > now else (base + timedelta(days=1))

    if pt == "weekly":
        # Тикаем два раза в сутки: в time_of_day и через +12 часов
        first = base
        second = base + timedelta(hours=12)

        if now < first:
            return first
        if now < second:
            return second
        # оба слота прошли — на следующий день в time_of_day
        return first + timedelta(days=1)

    if pt == "monthly":
        year = now.year
        month = now.month
        cand = base
        if cand <= now:
            if month == 12:
                month = 1
                year += 1
            else:
                month += 1
            import calendar
            last_day = calendar.monthrange(year, month)[1]
            day = min(now.day, last_day)
            cand = cand.replace(year=year, month=month, day=day)
        return cand

    return now + timedelta(hours=1)

def _row_to_task_dict(r) -> Dict[str, Any]:
    # TimeOfDay может прийти как time/datetime/str — нормализуем в "HH:MM:SS"
    def _fmt_tod(v):
        try:
            return v.strftime("%H:%M:%S") if v else None
        except Exception:
            return str(v) if v else None

    def _fmt_dt(v):
        try:
            return v.isoformat(sep=" ")
        except Exception:
            return str(v) if v is not None else None

    return {
        "id": r.Id,
        "template_id": r.TemplateId,
        "period_type": r.PeriodType,
        "time_of_day": _fmt_tod(getattr(r, "TimeOfDay", None)),
        "next_run": _fmt_dt(getattr(r, "NextRun", None)),
        "last_run": _fmt_dt(getattr(r, "LastRun", None)),
        "active": bool(getattr(r, "Active", 1)),
        "target_type": getattr(r, "TargetType", None),
        "target_value": str(getattr(r, "TargetValue", "")) if getattr(r, "TargetValue", None) is not None else None,
        "aggregation_type": getattr(r, "AggregationType", None),
        "send_format": getattr(r, "SendFormat", None),
        "window_minutes": getattr(r, "WindowMinutes", None),
        "avg_seconds": getattr(r, "AvgSeconds", None),
        "style_id": getattr(r, "StyleId", None),
        "style_override": getattr(r, "StyleOverride", None),
    }


# ======== CRUD для задач расписания (ReportSchedule) ========
@router.get("/schedule")
def list_schedules():
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT Id, TemplateId, PeriodType, TimeOfDay,
                       NextRun, LastRun, Active,
                       TargetType, TargetValue,
                       AggregationType, SendFormat,
                       WindowMinutes, AvgSeconds,
                       StyleId, StyleOverride
                FROM ReportSchedule
                ORDER BY Id DESC
            """)
            rows = cur.fetchall()
            return {"ok": True, "items": [_row_to_task_dict(r) for r in rows]}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.post("/schedule")
def create_schedule(task: ReportTaskCreate):
    try:
        wm = task.window_minutes if task.window_minutes is not None else _window_by_period(task.period_type)
        av = task.avg_seconds if task.avg_seconds is not None else (10 if wm else None)
        nxt = compute_initial_nextrun(task.period_type, task.time_of_day)

        # StyleOverride: храним как NVARCHAR(MAX); если dict — сериализуем
        style_override = task.style_override
        if isinstance(style_override, dict):
            style_override = json.dumps(style_override, ensure_ascii=False)

        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO ReportSchedule
                    (TemplateId, PeriodType, TimeOfDay,
                     NextRun, LastRun, Active,
                     TargetType, TargetValue,
                     AggregationType, SendFormat,
                     WindowMinutes, AvgSeconds,
                     StyleId, StyleOverride)
                VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                task.template_id, task.period_type, task.time_of_day,
                nxt,
                task.target_type, str(task.target_value),
                task.aggregation_type, task.send_format,
                wm, av,
                task.style_id, style_override
            )
            conn.commit()
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.put("/schedule/{id}")
def update_schedule(id: int, task: ReportTaskUpdate):
    try:
        wm = task.window_minutes if task.window_minutes is not None else _window_by_period(task.period_type)
        av = task.avg_seconds if task.avg_seconds is not None else (10 if wm else None)
        nxt = compute_initial_nextrun(task.period_type, task.time_of_day)

        style_override = task.style_override
        if isinstance(style_override, dict):
            style_override = json.dumps(style_override, ensure_ascii=False)

        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE ReportSchedule
                SET TemplateId=?,
                    PeriodType=?,
                    TimeOfDay=?,
                    NextRun=?,
                    TargetType=?,
                    TargetValue=?,
                    AggregationType=?,
                    SendFormat=?,
                    WindowMinutes=?,
                    AvgSeconds=?,
                    StyleId=?,
                    StyleOverride=?
                WHERE Id=?
            """,
                task.template_id, task.period_type, task.time_of_day, nxt,
                task.target_type, str(task.target_value),
                task.aggregation_type, task.send_format,
                wm, av,
                task.style_id, style_override,
                id
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Задание не найдено")
            conn.commit()
            return {"ok": True}
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.patch("/schedule/{id}/toggle")
def toggle_schedule(id: int, is_active: bool = Body(..., embed=True)):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("UPDATE ReportSchedule SET Active=? WHERE Id=?", int(bool(is_active)), id)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Задание не найдено")
            conn.commit()
            return {"ok": True, "id": id, "is_active": bool(is_active)}
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.delete("/schedule/{id}")
def delete_schedule(id: int):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM ReportSchedule WHERE Id=?", id)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Задание не найдено")
            conn.commit()
            return {"ok": True, "deleted": id}
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# ======== Ручной запуск задачи (run-now) ========
def _send_to_telegram(cur, target_type: str, target_value: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    result = {"delivered": False, "mode": None}
    if (target_type or "").lower() == "telegram":
        try:
            target_id = int(target_value)
        except Exception:
            target_id = None
        try:
            cur.execute("""
                IF OBJECT_ID('dbo.ReportExports') IS NOT NULL
                INSERT INTO ReportExports(ExportedAt, TargetType, TargetId, PayloadJson)
                VALUES (GETDATE(), ?, ?, ?)
            """, target_type, target_id, json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass
        result["delivered"] = True
        result["mode"] = "telegram"
    return result


@router.post("/schedule/compute-nextrun")
def compute_nextrun(payload: ReportTaskBase):
    try:
        nxt = compute_initial_nextrun(payload.period_type, payload.time_of_day)
        return {"ok": True, "next_run": nxt.isoformat(sep=" ")}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.get("/templates/{template_id}/preview-meta")
def template_preview_meta(template_id: int):
    """
    Возвращает мета для превью шаблона.
    По умолчанию рисуем тренд через dbo.sp_Telegram_CurrentValues.
    """
    try:
        tag_ids = get_tag_ids_for_template(template_id) or "0"
        return {
            "ok": True,
            # чем рисовать
            "proc": "dbo.sp_Telegram_CurrentValues",
            # маппинг колонок результата хранимки
            "map_x": "Timestamp",
            "map_y": "Value",
            "map_series": "TagName",
            "unit": None,
            # дефолтные параметры EXEC
            "params": {"@TagIds": tag_ids},
            # можно добавить любые расширения в будущем
        }
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# backend/app/routers/telegram_reports.py

@router.post("/preview")
def preview_legacy(payload: Dict[str, Any] = Body(...)):
    try:
        if not isinstance(payload, dict):
            try:
                payload = payload.dict()
            except Exception:
                payload = dict(payload or {})
        # 1) Валидация
        template_id = int(payload.get("template_id") or 0)
        if not template_id:
            raise HTTPException(status_code=422, detail="template_id is required")

        # 2) meta из шаблона (proc/map/params/unit)
        meta = template_preview_meta(template_id)
        if meta.get("ok"):
            meta = {k: v for k, v in meta.items() if k != "ok"}

        # 3) style_override из payload (как dict)
        style = payload.get("style_override") or {}
        if isinstance(style, str):
            try:
                style = json.loads(style)
            except Exception:
                style = {}

        is_text = (payload.get("format") or "chart").lower() == "text"
        period  = (payload.get("period_type") or "").lower()

        chart_kind = style.get("chart_kind") or (
            "bar" if period in ("shift", "daily", "weekly", "monthly") else "line"
        )

        # 4) Выбор хранимки ИСКЛЮЧИТЕЛЬНО на бэке
        expand_weekly = bool(style.get("expand_weekly_shifts"))
        if period == "weekly":
            now = datetime.now()
            week_monday = payload.get("week_monday") or (now - timedelta(days=now.weekday())).date().isoformat()

            meta_params = (meta.get("params") or {})
            # соберём tag_ids из любых ключей
            tag_ids = (
                payload.get("tag_ids")
                or payload.get("@tag_ids")
                or payload.get("TagIds")
                or payload.get("@TagIds")
                or meta_params.get("@tag_ids")
                or meta_params.get("@TagIds")
                or meta_params.get("TagIds")
                or meta_params.get("tag_ids")
            )
            if not tag_ids:
                raise HTTPException(status_code=422, detail="weekly: не передан список тегов (@tag_ids)")

            proc_name   = "dbo.sp_Telegram_WeeklyShiftCumulative"
            proc_params = _soft_norm({"@week_monday": week_monday, "@tag_ids": tag_ids})

            map_x, map_y, map_series, unit = "Period", "CumValue", "TagName", None
            chart_kind = "bar"
        else:
            proc_name   = meta["proc"]
            proc_params = _soft_norm(meta.get("params") or {})
            map_x       = meta.get("map_x") or "Timestamp"
            map_y       = meta.get("map_y") or "Value"
            map_series  = meta.get("map_series")
            unit        = meta.get("unit")

        text_template = style.get("text_template") or payload.get("text_template")

        # 5) Проксируем в новый движок предпросмотра (строго через модель)
        body = {
            "proc": proc_name,
            "params": proc_params,
            "mode": "text" if is_text else "chart",
            "chart": chart_kind,
            "map_x": map_x,
            "map_y": map_y,
            "map_series": map_series,
            "unit": unit,
            "title": style.get("chart_title") or "",
            "text_template": text_template,
            # НЕ передаём expand_weekly_shifts — weekly целиком решается в самой хранимке
        }
        return _preview2(_PreviewIn(**body))  # type: ignore

    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.get("/styles")
def list_styles():
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT Id, Name, ChartStyle, IsDefault, UserId, CreatedAt, UpdatedAt
                FROM ReportStyles
                ORDER BY Id DESC
            """)
            out = []
            for r in cur.fetchall():
                try:
                    chart = json.loads(r.ChartStyle) if r.ChartStyle else {}
                except Exception:
                    chart = {}
                out.append({
                    "id": r.Id,
                    "name": r.Name,
                    "style": chart,
                    "is_default": bool(getattr(r, "IsDefault", 0)),
                    "user_id": getattr(r, "UserId", None),
                    "created_at": str(getattr(r, "CreatedAt", "")),
                    "updated_at": str(getattr(r, "UpdatedAt", "")),
                })
            return {"ok": True, "items": out}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


class StyleIn(BaseModel):
    name: str
    style: Dict[str, Any] = Field(default_factory=dict)

@router.post("/styles")
def create_style(req: StyleIn):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO ReportStyles(Name, ChartStyle, CreatedAt, UpdatedAt)
                VALUES (?, ?, GETDATE(), GETDATE())
            """, req.name, json.dumps(req.style, ensure_ascii=False))
            conn.commit()
            cur.execute("SELECT SCOPE_IDENTITY()")
            new_id = int(cur.fetchone()[0])
            return {"ok": True, "id": new_id}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.put("/styles/{id}")
def update_style(id: int, req: StyleIn):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute("""
                UPDATE ReportStyles
                SET Name=?, ChartStyle=?, UpdatedAt=GETDATE()
                WHERE Id=?
            """, req.name, json.dumps(req.style, ensure_ascii=False), id)
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Стиль не найден")
            conn.commit()
            return {"ok": True}
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


def _http(method, url, **kwargs):
    try:
        return requests.request(method.upper(), url, timeout=15, **kwargs)
    except requests.RequestException:
        return None

def send_text_to_telegram(chat_id, text, thread_id=None):
    if not TG_TOKEN: return None
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    data = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if thread_id: data["message_thread_id"] = thread_id
    return _http("POST", url, data=data)

def send_photo_to_telegram(chat_id, image_bytes, caption="", thread_id=None):
    if not TG_TOKEN: return None
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendPhoto"
    files = {"photo": ("report.png", image_bytes)}
    data = {"chat_id": chat_id, "caption": caption or "", "parse_mode": "HTML"}
    if thread_id: data["message_thread_id"] = thread_id
    return _http("POST", url, data=data, files=files)

def resolve_telegram_destination(target_value):
    # 1) Id в TelegramReportTarget
    try:
        as_id = int(str(target_value).strip())
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            cur.execute("SELECT ChannelId, ThreadId FROM TelegramReportTarget WHERE Id=?", as_id)
            row = cur.fetchone()
            if row:
                return str(row.ChannelId), row.ThreadId
    except Exception:
        pass
    # 2) иначе считаем, что это прямой chat_id / @username
    return str(target_value), None



@router.post("/send")
def send(payload: SendIn = Body(...)):
    # 1) собираем payload для preview (включая стили)
    preview_req: Dict[str, Any] = {
        "template_id": payload.template_id,
        "format": payload.format,
        "period_type": payload.period_type,
        "time_of_day": payload.time_of_day,
        "aggregation_type": payload.aggregation_type,
        "window_minutes": payload.window_minutes,
        "avg_seconds": payload.avg_seconds,
    }
    if payload.text_template is not None:
        preview_req["text_template"] = payload.text_template
    if payload.chart_title is not None:
        preview_req["title"] = payload.chart_title
    if payload.chart_kind is not None:
        preview_req["chart"] = payload.chart_kind
    if payload.expand_weekly_shifts:
        preview_req["expand_weekly_shifts"] = True

    # 2) получаем результат как в предпросмотре
    res = preview_legacy(preview_req)   # <- ваш текущий handler preview

    # 3) отправляем В ТОЧНОМ соответствии с результатом preview
    chat_id, thread_id = resolve_telegram_destination(payload.target_value)
    if not chat_id:
        return {"ok": False, "detail": "channel not resolved"}

    title = (res.get("title") or "").strip()
    period = res.get("period") or {}
    period_caption = ""
    if period.get("date_from") and period.get("date_to"):
        period_caption = f"Период: {period['date_from']} — {period['date_to']}"

    # A) график (chart_png или data_url)
    chart_b64 = res.get("chart_png") or res.get("image_base64")
    data_url = res.get("data_url")
    if payload.format == "chart" and (chart_b64 or data_url):
        img = base64.b64decode(chart_b64) if chart_b64 and not data_url else None
        cap = title or period_caption
        if data_url:
            # data_url -> скачивать не нужно: backend должен давать chart_png; но на всякий пожарный:
            # лучше верните chart_png из preview
            pass
        else:
            send_photo_to_telegram(chat_id, img, cap, thread_id)
        return {"ok": True, "delivered": True, "preview": res}

    # B) текст (используем ИМЕННО text / text_table из preview)
    text = res.get("text") or res.get("text_table")
    if payload.format == "text" and text:
        msg = (f"<b>{title}</b>\n" if title else "") + f"<pre>{text}</pre>"
        if period_caption:
            msg += f"\n{period_caption}"
        send_text_to_telegram(chat_id, msg, thread_id)
        return {"ok": True, "delivered": True, "preview": res}

    # C) таблица-как-текст, если пришли columns+data
    columns = res.get("columns") or []
    data = res.get("data") or []
    if columns and data:
        # тот же формат, что в воркере (красиво моноширинно)
        from app.report_worker import format_report_table
        table_text = format_report_table(columns, data, period_caption)
        msg = (f"<b>{title}</b>\n" if title else "") + f"<pre>{table_text}</pre>"
        send_text_to_telegram(chat_id, msg, thread_id)
        return {"ok": True, "delivered": True, "preview": res}

    # иначе просто ничего
    return {"ok": True, "delivered": False, "preview": res}