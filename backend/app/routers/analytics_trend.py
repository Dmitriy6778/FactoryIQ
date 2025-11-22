# app/routers/analytics_trend.py

from typing import Any, Dict, List, Optional

import logging
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.routers.auth import get_current_user
from app.routers.user_screens import execute_stored_procedure  # тот же helper

logger = logging.getLogger(__name__)

router = APIRouter(tags=["analytics"])


@router.get("/sensor-trend-tech", status_code=status.HTTP_200_OK)
def get_sensor_trend_custom(
    tag_name: str,
    server_name: str,
    start_date: str,
    end_date: str,
    interval_ms: int = Query(180000, description="Интервал усреднения, мс (по умолчанию 3 мин)"),
    _user=Depends(get_current_user),
):
    """
    Тех. тренд для одного тега (sp_GetSensorTrend_Custom).
    Ничего не сохраняем, только читаем из процедуры.
    """
    try:
        if not tag_name or not server_name or not start_date or not end_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "Необходимо указать tag_name, server_name, start_date и end_date"},
            )

        logger.info(f"📡 Запрос тренда для {tag_name} ({server_name}) с {start_date} по {end_date}")

        results = execute_stored_procedure(
            "sp_GetSensorTrend_Custom",
            [tag_name, server_name, start_date, end_date, interval_ms],
        )

        if not results:
            return {
                "message": "Данные за указанный период отсутствуют",
                "data": [],
            }

        data = [
            {
                "tag_name": row["TagName"],
                "value": float(row["Value"]) if row["Value"] is not None else None,
                "timestamp": row["DateTime"].isoformat()
                if hasattr(row["DateTime"], "isoformat")
                else str(row["DateTime"]),
                "quality": row["Quality"],
            }
            for row in results
        ]

        return {
            "message": "Данные успешно получены",
            "data": data,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"🔥 Ошибка получения тренда: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": str(e)},
        )


@router.get("/trend", status_code=status.HTTP_200_OK)
def get_trend(
    tag_name: str,
    server_name: str,
    start_date: str,
    end_date: str,
    interval_ms: int = Query(180000, description="Интервал усреднения, мс"),
    since: Optional[str] = Query(None, description="Опционально: только новые точки после этого времени"),
    _user=Depends(get_current_user),
):
    """
    Общий тренд (dbo.api_GetOrLoad_Trend).
    Здесь API только читает; если процедура внутри что-то пишет в свои таблицы —
    это уже логика БД, не нашего сервиса.
    """
    try:
        if not tag_name or not server_name or not start_date or not end_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "Необходимо указать tag_name, server_name, start_date и end_date"},
            )

        params = [server_name, tag_name, start_date, end_date, interval_ms, since]
        rows = execute_stored_procedure("dbo.api_GetOrLoad_Trend", params) or []

        data: List[Dict[str, Any]] = []
        for r in rows:
            ts = r.get("DateTime")
            data.append(
                {
                    "tag_name": r.get("TagName"),
                    "value": float(r["Value"]) if r.get("Value") is not None else None,
                    "timestamp": ts.isoformat() if hasattr(ts, "isoformat") else str(ts),
                    "quality": r.get("Quality"),
                }
            )

        return {"message": "OK", "data": data}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Ошибка тренда")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Ошибка получения тренда"},
        )
