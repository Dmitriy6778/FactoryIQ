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
    conn_str = get_conn_str()
    return pyodbc.connect(conn_str)


def _rows_to_dicts(cursor: pyodbc.Cursor) -> List[Dict[str, Any]]:
    """Конвертация результата pyodbc в list[dict]."""
    cols = [col[0] for col in cursor.description] if cursor.description else []
    return [dict(zip(cols, row)) for row in cursor.fetchall()]


def _exec_proc(
    proc_name: str,
    params: Optional[List[Any]] = None,
) -> List[Dict[str, Any]]:
    """
    Универсальный вызов хранимой процедуры c параметрами.

    Пример:
        _exec_proc("dbo.sp_Weighbridge_Sunflower_ByDay",
                   [date_from, date_to, material_name])
    """
    if params is None:
        params = []

    placeholders = ", ".join("?" for _ in params)
    sql = f"EXEC {proc_name} {placeholders}" if placeholders else f"EXEC {proc_name}"

    with _get_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql, params)
        return _rows_to_dicts(cur)


# ===================================================================
#  ЭНДПОИНТЫ: СПРАВОЧНИКИ / ФИЛЬТРЫ
# ===================================================================


@router.get("/materials")
def get_materials(
    date_from: Optional[datetime] = Query(
        None, description="Начало периода (включительно)"
    ),
    date_to: Optional[datetime] = Query(
        None, description="Конец периода (исключая)"
    ),
):
    """
    Список уникальных материалов (MaterialName) за период.
    Использует dbo.sp_Weighbridge_GetMaterials.
    """
    try:
        items = _exec_proc(
            "dbo.sp_Weighbridge_GetMaterials",
            [date_from, date_to],
        )
        return {"items": items}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===================================================================
#  ДЕТАЛЬНАЯ ВЫБОРКА ПО ПОДСОЛНЕЧНИКУ
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
    consignor: Optional[str] = Query(None, description="Грузоотправитель"),
    consignee: Optional[str] = Query(None, description="Грузополучатель"),
    car_number: Optional[str] = Query(None, description="Гос. номер машины"),
):
    """
    Детальная таблица по поставкам подсолнечника.
    Использует dbo.sp_Weighbridge_Sunflower_Detail.
    Фильтры: дата, материал, отправитель, получатель, номер машины.
    """
    try:
        rows = _exec_proc(
            "dbo.sp_Weighbridge_Sunflower_Detail",
            [date_from, date_to, material_name, consignor, consignee, car_number],
        )
        return {"items": rows}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===================================================================
#  АГРЕГАЦИИ: ДНИ / НЕДЕЛИ / МЕСЯЦЫ
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
        "подсолнечник",
        description="Материал (точное имя из MaterialName)",
    ),
):
    """
    Агрегация по дням:
        DayDate, NetKgTotal, TripsCount, AvgNetPerTrip
    Использует dbo.sp_Weighbridge_Sunflower_ByDay.
    """
    try:
        rows = _exec_proc(
            "dbo.sp_Weighbridge_Sunflower_ByDay",
            [date_from, date_to, material_name],
        )
        return {"items": rows}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sunflower/by-week")
def sunflower_by_week(
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
):
    """
    Агрегация по ISO-неделям:
        YearNum, IsoWeekNum, WeekStartDate, WeekEndDate,
        NetKgTotal, TripsCount, AvgNetPerTrip
    Использует dbo.sp_Weighbridge_Sunflower_ByWeek.
    """
    try:
        rows = _exec_proc(
            "dbo.sp_Weighbridge_Sunflower_ByWeek",
            [date_from, date_to, material_name],
        )
        return {"items": rows}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sunflower/by-month")
def sunflower_by_month(
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
):
    """
    Агрегация по месяцам:
        YearNum, MonthNum, MonthStartDate, MonthEndDate,
        NetKgTotal, TripsCount, AvgNetPerTrip
    Использует dbo.sp_Weighbridge_Sunflower_ByMonth.
    """
    try:
        rows = _exec_proc(
            "dbo.sp_Weighbridge_Sunflower_ByMonth",
            [date_from, date_to, material_name],
        )
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
        "подсолнечник",
        description="Материал (точное имя из MaterialName)",
    ),
):
    """
    Сводка по подсолнечнику за период:
        NetKgTotal, TripsCount, MinNetKg, MaxNetKg, AvgNetKg, FirstDate, LastDate
    Использует dbo.sp_Weighbridge_Sunflower_Summary.
    """
    try:
        rows = _exec_proc(
            "dbo.sp_Weighbridge_Sunflower_Summary",
            [date_from, date_to, material_name],
        )
        # процедура возвращает одну строку
        summary = rows[0] if rows else None
        return {"summary": summary}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


# ===================================================================
#  ДОП. ВАРИАНТЫ АНАЛИТИКИ БЕЗ ОТДЕЛЬНЫХ ХРАНИМОК
# ===================================================================

# 1) Топ N поставщиков (Consignor) по нетто за период
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
    top_n: int = Query(10, ge=1, le=100, description="Сколько позиций вернуть"),
):
    """
    ТОП-N поставщиков по общему нетто (NetKg) за период.
    Реализовано простым SELECT'ом (можно потом вынести в хранимку).
    """
    sql = """
        SELECT TOP (@TopN)
            ISNULL(Consignor, N'Не указан') AS Consignor,
            SUM(NetKg)                      AS NetKgTotal,
            COUNT(*)                        AS TripsCount,
            AVG(NetKg)                      AS AvgNetPerTrip
        FROM dbo.WeighbridgeLog
        WHERE OperationType = N'Поставка'
          AND NetKg IS NOT NULL
          AND NetKg > 0
          AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
          AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
          AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
        GROUP BY ISNULL(Consignor, N'Не указан')
        ORDER BY NetKgTotal DESC;
    """

    params: List[Tuple[str, Any]] = [
        ("@TopN", top_n),
        ("@MaterialName", material_name),
        ("@DateFrom", date_from),
        ("@DateTo", date_to),
    ]

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            # pyodbc не поддерживает именованные параметры, но мы можем
            # задать их в SQL как переменные
            cur.execute(
                "DECLARE @TopN int = ?, @MaterialName nvarchar(255) = ?, "
                "@DateFrom datetime2(0) = ?, @DateTo datetime2(0) = ?; "
                + sql,
                [p[1] for p in params],
            )
            items = _rows_to_dicts(cur)
            return {"items": items}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


# 2) Топ N машин по нетто за период
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
    top_n: int = Query(10, ge=1, le=100, description="Сколько позиций вернуть"),
):
    """
    ТОП-N машин по общему нетто за период.
    Удобно для анализа загрузки транспорта.
    """
    sql = """
        SELECT TOP (@TopN)
            ISNULL(CarNumber, N'Не указан') AS CarNumber,
            SUM(NetKg)                       AS NetKgTotal,
            COUNT(*)                         AS TripsCount,
            AVG(NetKg)                       AS AvgNetPerTrip
        FROM dbo.WeighbridgeLog
        WHERE OperationType = N'Поставка'
          AND NetKg IS NOT NULL
          AND NetKg > 0
          AND (@MaterialName IS NULL OR MaterialName = @MaterialName)
          AND (@DateFrom IS NULL OR DateWeight >= @DateFrom)
          AND (@DateTo   IS NULL OR DateWeight <  @DateTo)
        GROUP BY ISNULL(CarNumber, N'Не указан')
        ORDER BY NetKgTotal DESC;
    """

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "DECLARE @TopN int = ?, @MaterialName nvarchar(255) = ?, "
                "@DateFrom datetime2(0) = ?, @DateTo datetime2(0) = ?; "
                + sql,
                [top_n, material_name, date_from, date_to],
            )
            items = _rows_to_dicts(cur)
            return {"items": items}
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))


# 3) Комплексный "дашборд" за период
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
):
    """
    Комплексный дашборд:
      - summary по периоду
      - помесячная агрегация
      - топ-5 поставщиков
      - топ-5 машин
    Чтобы фронт за один запрос мог нарисовать всю страницу.
    """
    try:
        summary = _exec_proc(
            "dbo.sp_Weighbridge_Sunflower_Summary",
            [date_from, date_to, material_name],
        )
        by_month = _exec_proc(
            "dbo.sp_Weighbridge_Sunflower_ByMonth",
            [date_from, date_to, material_name],
        )

        # Топ-5 поставщиков и машин — переиспользуем вышеописанные функции
        top_cons = sunflower_top_consignors(
            date_from=date_from,
            date_to=date_to,
            material_name=material_name,
            top_n=5,
        )
        top_cars = sunflower_top_cars(
            date_from=date_from,
            date_to=date_to,
            material_name=material_name,
            top_n=5,
        )

        return {
            "summary": summary[0] if summary else None,
            "by_month": by_month,
            "top_consignors": top_cons["items"],
            "top_cars": top_cars["items"],
        }
    except HTTPException:
        # пробрасываем как есть
        raise
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=str(e))
