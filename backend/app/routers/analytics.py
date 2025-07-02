from fastapi import APIRouter, Query
from typing import Optional, List
from ..db import get_db_connection  # Функция возвращает pyodbc connect

router = APIRouter(prefix="/analytics", tags=["analytics"])

# 1. Тренд по тегу (сырые значения)
@router.get("/trend")
def get_tag_trend(
    tag_id: int = Query(...),
    date_from: str = Query(...),
    date_to: str = Query(...)
):
    items = []
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("EXEC sp_GetTagTrend ?, ?, ?", tag_id, date_from, date_to)
        for row in cursor.fetchall():
            items.append({"timestamp": row[0], "value": row[1]})
    return {"ok": True, "items": items}

# 2. Суточные приросты по счётчикам
@router.get("/daily-delta")
def get_daily_delta(
    tag_id: int = Query(...),
    date_from: str = Query(...),
    date_to: str = Query(...)
):
    items = []
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("EXEC sp_GetDailyDelta ?, ?, ?", tag_id, date_from, date_to)
        for row in cursor.fetchall():
            items.append({
                "day": row[0],
                "first_value": row[1],
                "last_value": row[2],
                "delta": row[3]
            })
    return {"ok": True, "items": items}

# 3. Прирост по сменам (08:00-20:00, 20:00-08:00)
@router.get("/shift-delta")
def get_shift_delta(
    tag_id: int = Query(...),
    date_from: str = Query(...),
    date_to: str = Query(...)
):
    items = []
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("EXEC sp_GetShiftDelta ?, ?, ?", tag_id, date_from, date_to)
        for row in cursor.fetchall():
            items.append({
                "shift_start": row[0],
                "shift_no": row[1],
                "first_value": row[2],
                "last_value": row[3],
                "delta": row[4]
            })
    return {"ok": True, "items": items}

# 4. Универсальная агрегация по тегу или группе
@router.get("/aggregate")
def get_aggregated_stats(
    agg_type: str = Query("SUM", description="SUM|AVG|MIN|MAX"),
    tag_id: Optional[int] = Query(None),
    group_id: Optional[int] = Query(None),
    date_from: str = Query(...),
    date_to: str = Query(...)
):
    results = []
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("EXEC sp_GetAggregatedStats ?, ?, ?, ?, ?", tag_id, group_id, date_from, date_to, agg_type)
        for row in cursor.fetchall():
            results.append({
                "agg_type": row[0],
                "tag_id": row[1],
                "result": row[2]
            })
    return {"ok": True, "items": results}

