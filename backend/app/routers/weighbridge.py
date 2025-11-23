# app/routers/weighbridge.py
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import pyodbc
from fastapi import APIRouter, HTTPException, Query

from app.config import get_conn_str

router = APIRouter(prefix="/weighbridge", tags=["weighbridge"])


# ===================================================================
#  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ РАБОТЫ С БД
# ===================================================================


def _get_conn() -> pyodbc.Connection:
    """Создаёт подключение к SQL Server по общему конфигу FactoryIQ."""
    return pyodbc.connect(get_conn_str())


def _rows_to_dicts(cursor: pyodbc.Cursor) -> List[Dict[str, Any]]:
    """Конвертация результата pyodbc в list[dict]."""
    cols = [col[0] for col in cursor.description] if cursor.description else []
    return [dict(zip(cols, row)) for row in cursor.fetchall()]


def _normalize_direction(direction: Optional[str]) -> str:
    """
    direction: 'in' / 'out' / 'all'
    in  – ввоз (OperationType = 'Поставка')
    out – вывоз (всё, что не 'Поставка')
    all – без фильтра по направлению
    """
    d = (direction or "in").lower()
    if d not in ("in", "out", "all"):
        raise HTTPException(status_code=400, detail="Invalid direction (in|out|all)")
    return d

def _exec_proc(
    proc_name: str,
    params: Optional[List[Any]] = None,
) -> List[Dict[str, Any]]:
    """Удобный вызов хранимой процедуры."""
    if params is None:
        params = []
    placeholders = ", ".join("?" for _ in params)
    sql = f"EXEC {proc_name} {placeholders}" if placeholders else f"EXEC {proc_name}"
    with _get_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql, params)
        return _rows_to_dicts(cur)


# ===================================================================
#  СПРАВОЧНИКИ / ФИЛЬТРЫ
# ===================================================================


@router.get("/materials")
def get_materials(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    direction: Optional[str] = Query(
        None,
        description="Направление: in (ввоз), out (вывоз), all (всё). "
        "По умолчанию не фильтруется.",
    ),
):
    """
    Список уникальных материалов (MaterialName) за период и, при желании, по направлению.
    """
    d = _normalize_direction(direction) if direction else None

    sql = """
    DECLARE
        @DateFrom   datetime2(0) = ?,
        @DateTo     datetime2(0) = ?,
        @Direction  nvarchar(10) = ?;

    SELECT DISTINCT
        MaterialName
    FROM dbo.WeighbridgeLog
    WHERE MaterialName IS NOT NULL AND LTRIM(RTRIM(MaterialName)) <> N''
      AND NetKg IS NOT NULL AND NetKg > 0
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction IS NULL OR @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      )
    ORDER BY MaterialName;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [date_from, date_to, d])
            items = _rows_to_dicts(cur)
            return {"items": items}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===================================================================
#  ДЕТАЛЬНАЯ ВЫБОРКА (DETAIL)
# ===================================================================


@router.get("/sunflower/detail")
def sunflower_detail(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        "подсолнечник",
        description="Материал (точное имя из MaterialName, по умолчанию 'подсолнечник')",
    ),
    direction: Optional[str] = Query(
        "in",
        description="Направление: in (ввоз), out (вывоз), all (всё)",
    ),
    consignor: Optional[str] = Query(None, description="Грузоотправитель"),
    consignee: Optional[str] = Query(None, description="Грузополучатель"),
    car_number: Optional[str] = Query(None, description="Гос. номер машины"),
):
    """
    Детальная таблица по рейсам.
    Фильтры:
      - период
      - материал
      - направление (ввоз/вывоз/всё)
      - отправитель, получатель, гос. номер (на уровне SQL + Python)
    """
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @DateFrom      datetime2(0) = ?,
        @DateTo        datetime2(0) = ?,
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        Id,
        DateWeight,
        CarNumber,
        MaterialName,
        Consignor,
        Consignee,
        NetKg,
        PointFrom,
        PointTo,
        OperationType
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      )
    ORDER BY DateWeight;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [date_from, date_to, material_name, d])
            rows = _rows_to_dicts(cur)
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Доп. фильтры по строковым полям
    def _match(r: Dict[str, Any]) -> bool:
        if consignor and (r.get("Consignor") or "") != consignor:
            return False
        if consignee and (r.get("Consignee") or "") != consignee:
            return False
        if car_number and (r.get("CarNumber") or "") != car_number:
            return False
        return True

    filtered = [r for r in rows if _match(r)]
    return {"items": filtered}


# ===================================================================
#  АГРЕГАЦИИ: ДНИ
# ===================================================================


@router.get("/sunflower/by-day")
def sunflower_by_day(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        "подсолнечник", description="Материал (точное имя из MaterialName)"
    ),
    direction: Optional[str] = Query(
        "in",
        description="Направление: in (ввоз), out (вывоз), all (всё)",
    ),
):
    """
    Агрегация по дням:
        DayDate, NetKgTotal, TripsCount
    """
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @DateFrom      datetime2(0) = ?,
        @DateTo        datetime2(0) = ?,
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        CAST(DateWeight AS date)           AS DayDate,
        SUM(NetKg)                         AS NetKgTotal,
        COUNT(*)                           AS TripsCount
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      )
    GROUP BY CAST(DateWeight AS date)
    ORDER BY DayDate;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [date_from, date_to, material_name, d])
            rows = _rows_to_dicts(cur)
            return {"items": rows}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===================================================================
#  SUMMARY ПО ПЕРИОДУ
# ===================================================================


@router.get("/sunflower/summary")
def sunflower_summary(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        "подсолнечник", description="Материал (точное имя из MaterialName)"
    ),
    direction: Optional[str] = Query(
        "in",
        description="Направление: in (ввоз), out (вывоз), all (всё)",
    ),
):
    """
    Сводка по материалу за период:
        NetKgTotal, TripsCount, MinNetKg, MaxNetKg, AvgNetKg, FirstDate, LastDate
    Если date_from/date_to не заданы — summary по всему историческому периоду.
    """
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @DateFrom      datetime2(0) = ?,
        @DateTo        datetime2(0) = ?,
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        SUM(NetKg)           AS NetKgTotal,
        COUNT(*)             AS TripsCount,
        MIN(NetKg)           AS MinNetKg,
        MAX(NetKg)           AS MaxNetKg,
        AVG(NetKg)           AS AvgNetKg,
        MIN(DateWeight)      AS FirstDate,
        MAX(DateWeight)      AS LastDate
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      );
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [date_from, date_to, material_name, d])
            rows = _rows_to_dicts(cur)
            summary = rows[0] if rows else None
            return {"summary": summary}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===================================================================
#  ТОПЫ И ДАШБОРД (оставил, но добавил direction)
# ===================================================================


@router.get("/sunflower/top-consignors")
def sunflower_top_consignors(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        "подсолнечник",
        description="Материал (точное имя из MaterialName)",
    ),
    direction: Optional[str] = Query(
        "in", description="Направление: in (ввоз), out (вывоз), all (всё)"
    ),
    top_n: int = Query(10, ge=1, le=100, description="Сколько позиций вернуть"),
):
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @TopN         int           = ?,
        @MaterialName nvarchar(255) = ?,
        @DateFrom     datetime2(0)  = ?,
        @DateTo       datetime2(0)  = ?,
        @Direction    nvarchar(10)  = ?;

    SELECT TOP (@TopN)
        ISNULL(Consignor, N'Не указан') AS Consignor,
        SUM(NetKg)                      AS NetKgTotal,
        COUNT(*)                        AS TripsCount,
        AVG(NetKg)                      AS AvgNetPerTrip
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND OperationType IS NOT NULL
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      )
    GROUP BY ISNULL(Consignor, N'Не указан')
    ORDER BY NetKgTotal DESC;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [top_n, material_name, date_from, date_to, d])
            items = _rows_to_dicts(cur)
            return {"items": items}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sunflower/top-cars")
def sunflower_top_cars(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        "подсолнечник",
        description="Материал (точное имя из MaterialName)",
    ),
    direction: Optional[str] = Query(
        "in", description="Направление: in (ввоз), out (вывоз), all (всё)"
    ),
    top_n: int = Query(10, ge=1, le=100, description="Сколько позиций вернуть"),
):
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @TopN         int           = ?,
        @MaterialName nvarchar(255) = ?,
        @DateFrom     datetime2(0)  = ?,
        @DateTo       datetime2(0)  = ?,
        @Direction    nvarchar(10)  = ?;

    SELECT TOP (@TopN)
        ISNULL(CarNumber, N'Не указан') AS CarNumber,
        SUM(NetKg)                       AS NetKgTotal,
        COUNT(*)                         AS TripsCount,
        AVG(NetKg)                       AS AvgNetPerTrip
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND OperationType IS NOT NULL
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      )
    GROUP BY ISNULL(CarNumber, N'Не указан')
    ORDER BY NetKgTotal DESC;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [top_n, material_name, date_from, date_to, d])
            items = _rows_to_dicts(cur)
            return {"items": items}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sunflower/dashboard")
def sunflower_dashboard(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        "подсолнечник",
        description="Материал (точное имя из MaterialName)",
    ),
    direction: Optional[str] = Query(
        "in", description="Направление: in (ввоз), out (вывоз), all (всё)"
    ),
):
    d = _normalize_direction(direction)

    try:
        summary_rows = sunflower_summary(
            date_from=date_from,
            date_to=date_to,
            material_name=material_name,
            direction=d,
        )["summary"]

        by_month = []  # пока не переделывали агрегацию по месяцам

        top_cons = sunflower_top_consignors(
            date_from=date_from,
            date_to=date_to,
            material_name=material_name,
            direction=d,
            top_n=5,
        )
        top_cars = sunflower_top_cars(
            date_from=date_from,
            date_to=date_to,
            material_name=material_name,
            direction=d,
            top_n=5,
        )

        return {
            "summary": summary_rows,
            "by_month": by_month,
            "top_consignors": top_cons["items"],
            "top_cars": top_cars["items"],
        }
    except HTTPException:
        raise
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/v2/directions")
def get_directions_v2():
    """
    Справочник направлений: ввоз / вывоз / всё.
    """
    items = [
        {"value": "all", "label": "Все (ввоз + вывоз)"},
        {"value": "in", "label": "Поставка (ввоз)"},
        {"value": "out", "label": "Сбыт (вывоз)"},
    ]
    return {"items": items}


@router.get("/v2/materials")
def get_materials_v2(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    direction: Optional[str] = Query(
        None,
        description="Направление: in (ввоз), out (вывоз), all (всё). "
        "По умолчанию не фильтруется.",
    ),
):
    """
    Алиас для /weighbridge/materials, чтобы фронт мог вызывать /v2/materials.
    """
    return get_materials(date_from=date_from, date_to=date_to, direction=direction)

# ===================================================================
#  V2: ОБЩИЕ МАРШРУТЫ ДЛЯ ЛЮБЫХ МАТЕРИАЛОВ
# ===================================================================


@router.get("/v2/detail")
def weighbridge_detail_v2(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        None,
        description="Материал (точное имя из MaterialName, NULL = все материалы)",
    ),
    direction: Optional[str] = Query(
        "all",
        description="Направление: in (ввоз), out (вывоз), all (всё)",
    ),
):
    """
    Детальная таблица по рейсам для любых материалов.
    Поля:
      Id, DateWeight, CarNumber, CarMark, MaterialName,
      OperationType, PointFrom, PointTo, Consignor, Consignee, NetKg
    """
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @DateFrom      datetime2(0) = ?,
        @DateTo        datetime2(0) = ?,
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        Id,
        DateWeight,
        CarNumber,
        CarMark,
        MaterialName,
        OperationType,
        PointFrom,
        PointTo,
        Consignor,
        Consignee,
        NetKg
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      )
    ORDER BY DateWeight;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [date_from, date_to, material_name, d])
            rows = _rows_to_dicts(cur)
            return {"items": rows}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/v2/by-day")
def weighbridge_by_day_v2(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        None, description="Материал (точное имя из MaterialName, NULL = все)"
    ),
    direction: Optional[str] = Query(
        "all",
        description="Направление: in (ввоз), out (вывоз), all (всё)",
    ),
):
    """
    Агрегация по дням для любых материалов.
    DayDate, NetKgTotal, TripsCount
    """
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @DateFrom      datetime2(0) = ?,
        @DateTo        datetime2(0) = ?,
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        CAST(DateWeight AS date)           AS DayDate,
        SUM(NetKg)                         AS NetKgTotal,
        COUNT(*)                           AS TripsCount
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      )
    GROUP BY CAST(DateWeight AS date)
    ORDER BY DayDate;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [date_from, date_to, material_name, d])
            rows = _rows_to_dicts(cur)
            return {"items": rows}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/v2/summary")
def weighbridge_summary_v2(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
    material_name: Optional[str] = Query(
        None,
        description="Материал (точное имя из MaterialName, NULL = все материалы)",
    ),
    direction: Optional[str] = Query(
        "all",
        description="Направление: in (ввоз), out (вывоз), all (всё)",
    ),
):
    """
    Сводка по материалу:
      - period: за выбранный период
      - overall: за весь исторический период (по тем же фильтрам материала/направления)
    """
    d = _normalize_direction(direction)

    sql_period = """
    DECLARE
        @DateFrom      datetime2(0) = ?,
        @DateTo        datetime2(0) = ?,
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        SUM(NetKg)           AS NetKgTotal,
        COUNT(*)             AS TripsCount,
        MIN(NetKg)           AS MinNetKg,
        MAX(NetKg)           AS MaxNetKg,
        AVG(NetKg)           AS AvgNetKg,
        MIN(DateWeight)      AS FirstDate,
        MAX(DateWeight)      AS LastDate
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NOT NULL AND DateWeight >= @DateFrom)
      AND (@DateTo   IS NOT NULL AND DateWeight <  @DateTo)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      );
    """

    sql_overall = """
    DECLARE
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        SUM(NetKg)           AS NetKgTotal,
        COUNT(*)             AS TripsCount,
        MIN(NetKg)           AS MinNetKg,
        MAX(NetKg)           AS MaxNetKg,
        AVG(NetKg)           AS AvgNetKg,
        MIN(DateWeight)      AS FirstDate,
        MAX(DateWeight)      AS LastDate
    FROM dbo.WeighbridgeLog
    WHERE NetKg IS NOT NULL AND NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (
            @Direction = N'all'
         OR (@Direction = N'in'  AND OperationType = N'Поставка')
         OR (@Direction = N'out' AND OperationType <> N'Поставка')
      );
    """

    try:
      with _get_conn() as conn:
          cur = conn.cursor()
          # период
          if date_from is not None and date_to is not None:
              cur.execute(sql_period, [date_from, date_to, material_name, d])
              period_rows = _rows_to_dicts(cur)
              period = period_rows[0] if period_rows else None
          else:
              period = None

          # общий
          cur2 = conn.cursor()
          cur2.execute(sql_overall, [material_name, d])
          overall_rows = _rows_to_dicts(cur2)
          overall = overall_rows[0] if overall_rows else None

      return {"period": period, "overall": overall}
    except pyodbc.Error as e:
      raise HTTPException(status_code=500, detail=str(e))

@router.get("/sunflower/by-week")
def sunflower_by_week(
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    material_name: Optional[str] = Query("подсолнечник"),
    direction: Optional[str] = Query("in"),
):
    """
    Агрегация по ISO-неделям:
        YearNum, IsoWeekNum, WeekStartDate, WeekEndDate,
        NetKgTotal, TripsCount, AvgNetPerTrip
    """
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @DateFrom      datetime2(0) = ?,
        @DateTo        datetime2(0) = ?,
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        DATEPART(YEAR, DATEADD(day, -DATEPART(WEEKDAY, DateWeight)+1, DateWeight)) AS YearNum,
        DATEPART(ISO_WEEK, DateWeight) AS IsoWeekNum,
        MIN(DATEADD(day, -DATEPART(WEEKDAY, DateWeight)+1, DateWeight)) AS WeekStartDate,
        MAX(DATEADD(day, -DATEPART(WEEKDAY, DateWeight)+7, DateWeight)) AS WeekEndDate,
        SUM(NetKg) AS NetKgTotal,
        COUNT(*) AS TripsCount,
        AVG(NetKg) AS AvgNetPerTrip
    FROM dbo.WeighbridgeLog
    WHERE NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = 'all'
         OR (@Direction = 'in'  AND OperationType = N'Поставка')
         OR (@Direction = 'out' AND OperationType <> N'Поставка')
      )
    GROUP BY 
        DATEPART(YEAR, DATEADD(day, -DATEPART(WEEKDAY, DateWeight)+1, DateWeight)),
        DATEPART(ISO_WEEK, DateWeight)
    ORDER BY YearNum, IsoWeekNum;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [date_from, date_to, material_name, d])
            rows = _rows_to_dicts(cur)
            return {"items": rows}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sunflower/by-month")
def sunflower_by_month(
    date_from: Optional[datetime] = Query(None),
    date_to: Optional[datetime] = Query(None),
    material_name: Optional[str] = Query("подсолнечник"),
    direction: Optional[str] = Query("in"),
):
    """
    Агрегация по месяцам:
        YearNum, MonthNum, MonthStartDate, MonthEndDate,
        NetKgTotal, TripsCount, AvgNetPerTrip
    """
    d = _normalize_direction(direction)

    sql = """
    DECLARE
        @DateFrom      datetime2(0) = ?,
        @DateTo        datetime2(0) = ?,
        @MaterialName  nvarchar(255) = ?,
        @Direction     nvarchar(10)  = ?;

    SELECT
        YEAR(DateWeight) AS YearNum,
        MONTH(DateWeight) AS MonthNum,
        MIN(DATEFROMPARTS(YEAR(DateWeight), MONTH(DateWeight), 1)) AS MonthStartDate,
        MAX(EOMONTH(DateWeight)) AS MonthEndDate,
        SUM(NetKg) AS NetKgTotal,
        COUNT(*) AS TripsCount,
        AVG(NetKg) AS AvgNetPerTrip
    FROM dbo.WeighbridgeLog
    WHERE NetKg > 0
      AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
      AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
      AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
      AND (
            @Direction = 'all'
         OR (@Direction = 'in'  AND OperationType = N'Поставка')
         OR (@Direction = 'out' AND OperationType <> N'Поставка')
      )
    GROUP BY YEAR(DateWeight), MONTH(DateWeight)
    ORDER BY YearNum, MonthNum;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(sql, [date_from, date_to, material_name, d])
            rows = _rows_to_dicts(cur)
            return {"items": rows}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))
