# app/routers/tag_settings.py

from typing import Any, Dict, List, Optional

import logging
from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from app.routers.auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tag-settings"])




def execute_sql_query(sql: str, params: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
    """Выполняет запрос и возвращает list[dict]."""
    if params is None:
        params = []
    with _db() as conn:
        cur = conn.cursor()
        cur.execute(sql, params)
        if not cur.description:
            return []
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    return rows


# ---------- /api/screen-objects/rename (PUT) ----------
@router.put("/screen-objects/rename", status_code=status.HTTP_200_OK)
def rename_screen_object(
    payload: Dict[str, Any] = Body(...),
    _user=Depends(get_current_user),
):
    """Переименование метки (Label) на SCADA-экране."""
    try:
        data = payload or {}
        object_name = data.get("object_name")
        new_label = data.get("new_label")
        server_id = data.get("server_id")
        screen_name = data.get("screen_name")

        if not object_name:
            raise HTTPException(status_code=400, detail={"error": "`object_name` отсутствует"})
        if not new_label or new_label.strip() == "":
            raise HTTPException(status_code=400, detail={"error": "`new_label` пустое"})
        if not server_id:
            raise HTTPException(status_code=400, detail={"error": "`server_id` отсутствует"})
        if not screen_name:
            raise HTTPException(status_code=400, detail={"error": "`screen_name` отсутствует"})

        sql = """
            UPDATE ScreenObjects
            SET Label = ?
            WHERE ServerId = ? AND ObjectName = ? AND ScreenName = ?
        """

        execute_sql_query(sql, [new_label, server_id, object_name, screen_name])

        return {"message": "Метка успешно переименована"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ошибка rename_screen_object: {e}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


# ---------- /api/screen-objects/{screen_name}/{object_name} (DELETE) ----------
@router.delete("/screen-objects/{screen_name}/{object_name}", status_code=status.HTTP_200_OK)
def delete_screen_object(
    screen_name: str,
    object_name: str,
    server_id: Optional[int] = Query(None),
    _user=Depends(get_current_user),
):
    """Удаление метки на SCADA-экране."""
    try:
        if server_id is None:
            raise HTTPException(
                status_code=400, detail={"error": "`server_id` обязателен после обновления схемы"}
            )

        execute_sql_query(
            "DELETE FROM ScreenObjects WHERE ObjectName=? AND ScreenName=? AND ServerId=?",
            [object_name, screen_name, server_id],
        )

        return {"message": f"Метка '{object_name}' успешно удалена"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ошибка delete_screen_object: {e}")
        raise HTTPException(status_code=500, detail={"error": "Не удалось удалить метку"})
