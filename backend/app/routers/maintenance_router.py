# backend/app/routers/maintenance_router.py
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, Any, List, Tuple
from datetime import datetime
import pyodbc

from ..config import get_conn_str

router = APIRouter(prefix="/maintenance", tags=["maintenance"])

# ----------------------------- БД утилиты ---------------------------------
def _db() -> pyodbc.Connection:
    # включаем autocommit, чтобы SCOPE_IDENTITY() внутри хранимки жил своей жизнью
    return pyodbc.connect(get_conn_str(), autocommit=True)

def _rows_to_dicts(cur: pyodbc.Cursor) -> Tuple[List[str], List[dict]]:
    cols = [c[0] for c in cur.description]
    return cols, [dict(zip(cols, r)) for r in cur.fetchall()]

def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        s = s.replace("Z", "").replace("z", "")
        return datetime.fromisoformat(s)
    except Exception:
        return None

# ------------------------------ Модели ------------------------------------
class AddLog(BaseModel):
    tag_name: str
    action: str                   # Осмотр/Ремонт/Замена/Прочее
    status: Optional[str] = None  # Открыто/В работе/Закрыто
    comment: Optional[str] = None
    author: Optional[str] = None  # по умолчанию wincc

# ------------------------------ Эндпоинты ---------------------------------

@router.post("/logs")
def add_log(payload: AddLog):
    """
    Добавляет запись в журнал через sp_AddMaintenanceLog.
    """
    try:
        with _db() as conn:
            cur = conn.cursor()
            # Вариант с EXEC + параметрами (без именованных параметров — это pyodbc)
            cur.execute(
                "EXEC dbo.sp_AddMaintenanceLog ?, ?, ?, ?, ?",
                payload.tag_name,
                payload.author or "wincc",
                payload.action,
                payload.status,
                payload.comment,
            )
            # autocommit=True — отдельного commit не нужно
            return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.get("/logs")
def get_logs(
    tag: str = Query(..., description="TagName оборудования"),
    from_utc: Optional[str] = Query(None),
    to_utc:   Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """
    Возвращает записи журнала через sp_GetMaintenanceLogsByTag.
    """
    try:
        dt_from = _parse_dt(from_utc)
        dt_to   = _parse_dt(to_utc)

        with _db() as conn:
            cur = conn.cursor()
            # Порядок параметров должен ровно соответствовать сигнатуре хранимки
            cur.execute(
                "EXEC dbo.sp_GetMaintenanceLogsByTag ?, ?, ?, ?, ?",
                tag, dt_from, dt_to, limit, offset
            )
            _, rows = _rows_to_dicts(cur)
            return {"ok": True, "count": len(rows), "rows": rows}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.get("/equipment/recent")
def get_recent_equipment(limit: int = Query(50, ge=1, le=200)):
    try:
        with _db() as conn:
            cur = conn.cursor()
            cur.execute(f"""
                SELECT TOP ({limit})
                    e.EquipmentId, e.TagName, e.Name,
                    MAX(l.LoggedAt) AS LastLog
                FROM dbo.Equipment e
                LEFT JOIN dbo.MaintenanceLog l ON l.EquipmentId = e.EquipmentId
                GROUP BY e.EquipmentId, e.TagName, e.Name
                ORDER BY LastLog DESC
            """)
            _, rows = _rows_to_dicts(cur)
            return {"ok": True, "rows": rows}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))
