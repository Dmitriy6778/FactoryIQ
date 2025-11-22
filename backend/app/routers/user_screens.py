# backend/app/routers/user_screens.py

from typing import Any, Dict, List, Optional

import json
import logging
import time
import unicodedata

import pyodbc
from fastapi import APIRouter, Body, HTTPException, Query, status, Depends
from .auth import get_current_user

from datetime import datetime
from .db import _conn_for


logger = logging.getLogger(__name__)

# ---------- Роутеры ----------
router = APIRouter(prefix="/user-screens", tags=["user-screens"])
objects_router = APIRouter(prefix="/screen-objects", tags=["screen-objects"])


# ---------- DB helpers ----------

def _db() -> pyodbc.Connection:
    """Соединение с БД."""
    return _conn_for()

# Универсальный хелпер (оставляем)
def _as01(val: Any) -> int:
    """Приводит значение к 0/1."""
    if val is None:
        return 0
    if isinstance(val, bool):
        return 1 if val else 0
    if isinstance(val, (int, float)):
        return 1 if int(val) != 0 else 0
    if isinstance(val, str):
        return 1 if val.strip().lower() in ("1", "true", "t", "yes", "y", "on") else 0
    return 0

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


def execute_stored_procedure(proc_name: str, params: Optional[List[Any]] = None) -> List[Dict[str, Any]]:
    if params is None:
        params = []
    with _db() as conn:
        cur = conn.cursor()
        placeholders = ", ".join("?" for _ in params)
        sql = f"EXEC {proc_name} {placeholders}" if placeholders else f"EXEC {proc_name}"
        cur.execute(sql, params)
        if not cur.description:
            return []
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    return rows


# ====================== УТИЛИТЫ ======================

def _deadlock_retry(fn, attempts: int = 3, base_sleep: float = 0.25):
    last = None
    for i in range(attempts):
        try:
            return fn()
        except pyodbc.Error as e:
            msg = str(e)
            if ("1205" in msg) or ("40001" in msg) or ("deadlock" in msg.lower()) or ("timeout" in msg.lower()):
                time.sleep(base_sleep * (2 ** i))
                last = e
                continue
            raise
    raise last


def _coerce_bool(val):
    """Безопасно приводим вход к bool/None: понимает True/False, 0/1, '1','true','yes','on'."""
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return bool(int(val))
    if isinstance(val, str):
        return val.strip().lower() in ("1", "true", "t", "yes", "y", "on")
    return None


def _select_screen_props(screen_id: int):
    rows = execute_sql_query(
        """
        SELECT s.ScreenId, s.UserId, s.IsPublic, s.IsReadonly, s.AreaWidth, s.AreaHeight, s.BgColor
        FROM dbo.UserScreens s
        WHERE s.ScreenId = ?
        """,
        [screen_id],
    )
    return rows[0] if rows else None


def _update_screen_props_tx(
    screen_id: int,
    is_public=None,
    is_readonly=None,
    area_width=None,
    area_height=None,
    bg_color=None,
):
    """
    Обновляет свойства экрана (IsPublic/IsReadonly/AreaWidth/AreaHeight/BgColor) в одной транзакции.
    """
    meta = _select_screen_props(screen_id)
    if not meta:
        return {"error": "screen not found"}, status.HTTP_404_NOT_FOUND

    sets: List[str] = []
    params: List[Any] = []

    if is_public is not None:
        sets.append("IsPublic = ?")
        params.append(1 if is_public else 0)
    if is_readonly is not None:
        sets.append("IsReadonly = ?")
        params.append(1 if is_readonly else 0)
    if area_width is not None:
        try:
            aw = int(area_width)
            if aw > 0:
                sets.append("AreaWidth = ?")
                params.append(aw)
        except (TypeError, ValueError):
            pass
    if area_height is not None:
        try:
            ah = int(area_height)
            if ah > 0:
                sets.append("AreaHeight = ?")
                params.append(ah)
        except (TypeError, ValueError):
            pass
    if bg_color is not None:
        sets.append("BgColor = ?")
        params.append(str(bg_color))

    if not sets:
        return {
            "screen_id": screen_id,
            "is_public": bool(meta["IsPublic"]),
            "is_readonly": bool(meta["IsReadonly"]),
            "area_width": meta.get("AreaWidth"),
            "area_height": meta.get("AreaHeight"),
            "bg_color": meta.get("BgColor"),
        }, status.HTTP_200_OK

    sql = f"""
        UPDATE dbo.UserScreens
        SET {", ".join(sets)}, UpdatedAt = GETDATE()
        WHERE ScreenId = ?
    """
    params.append(screen_id)

    _deadlock_retry(lambda: execute_sql_query(sql, params))

    updated = _select_screen_props(screen_id)
    return {
        "screen_id": screen_id,
        "is_public": bool(updated["IsPublic"]),
        "is_readonly": bool(updated["IsReadonly"]),
        "area_width": updated.get("AreaWidth"),
        "area_height": updated.get("AreaHeight"),
        "bg_color": updated.get("BgColor"),
    }, status.HTTP_200_OK


# ====================== ЭКРАНЫ: ЭНДПОИНТЫ ======================

@router.get("/all-tags", status_code=status.HTTP_200_OK)
def get_all_tags(
    server_id: Optional[int] = Query(None, description="Id OPC-сервера"),
    q: str = Query("", alias="q", description="Поиск по имени/описанию"),
    tagname: str = Query("", alias="tagname", description="Альтернативное имя параметра поиска"),
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
):
    """
    Пагинированный список OPC-тегов для сайдбара редактора экранов.
    """
    try:
        search = (q or tagname or "").strip().lower()

        conditions: List[str] = []
        params: List[Any] = []

        if server_id is not None:
            conditions.append("t.ServerId = ?")
            params.append(int(server_id))

        if search:
            conditions.append(
                "(LOWER(t.BrowseName) LIKE ? OR LOWER(ISNULL(t.Description, '')) LIKE ?)"
            )
            like = f"%{search}%"
            params.extend([like, like])

        base_where = """
            EXISTS (
                SELECT 1
                FROM dbo.PollingTaskTags AS ptt
                WHERE ptt.tag_id = t.Id
            )
        """

        if conditions:
            where_clause = base_where + " AND " + " AND ".join(conditions)
        else:
            where_clause = base_where

        query = f"""
            SELECT DISTINCT
                t.Id          AS id,
                t.BrowseName  AS TagName,
                t.Description AS description,
                t.Path        AS path
            FROM dbo.OpcTags AS t
            WHERE {where_clause}
            ORDER BY t.BrowseName
            OFFSET ? ROWS FETCH NEXT ? ROWS ONLY;
        """

        params.extend([offset, limit])

        rows = execute_sql_query(query, params)
        return rows

    except Exception as e:
        logger.exception(f"Ошибка получения всех тегов: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Не удалось получить теги"},
        )


@router.get("/{screen_id}/trends")
def get_screen_trends(
    screen_id: int,
    start_date: datetime = Query(..., alias="start_date"),
    end_date: datetime = Query(..., alias="end_date"),
    interval_ms: int = Query(60000, alias="interval_ms"),
):
    if start_date >= end_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "bad_range", "message": "Некорректный диапазон дат"},
        )

    sql = "EXEC dbo.sp_GetOpcTrendsForScreen @ScreenId=?, @StartDate=?, @EndDate=?, @IntervalMs=?"

    try:
        rows = execute_sql_query(sql, [screen_id, start_date, end_date, interval_ms])
    except Exception as ex:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "db_error", "details": str(ex)},
        )

    items = [
        {
            "screen_object_id": r.get("ScreenObjectId"),
            "tag_id": r.get("TagId"),
            "tag_name": r.get("TagName"),
            "timestamp": r.get("Timestamp"),
            "value": r.get("Value"),
        }
        for r in rows
    ]

    return {"ok": True, "items": items}


@router.get("", status_code=status.HTTP_200_OK)
def get_user_screens():
    """
    Список всех экранов (и личных, и публичных).
    """
    sql = """
        SELECT 
          s.ScreenId,
          s.ScreenName,
          s.Title,
          s.Description,
          s.IsPublic,
          s.IsReadonly,
          s.CreatedAt,
          s.BgColor,
          s.AreaWidth,
          s.AreaHeight,
          s.UserId,
          s.ServerId,
          srv.Name AS ServerName,
          u.Username AS OwnerUsername
        FROM dbo.UserScreens AS s
        LEFT JOIN dbo.OpcServers AS srv ON s.ServerId = srv.Id
        LEFT JOIN dbo.Users      AS u   ON s.UserId   = u.Id
        ORDER BY s.IsPublic DESC, s.Title
    """
    rows = execute_sql_query(sql)
    screens: List[Dict[str, Any]] = []
    for row in rows:
        screens.append(
            {
                "ScreenId": row["ScreenId"],
                "ScreenName": row.get("ScreenName", f"user_screen_{row['ScreenId']}"),
                "Title": row["Title"],
                "Description": row["Description"],
                "IsPublic": bool(row["IsPublic"]),
                "IsReadonly": bool(row["IsReadonly"]),
                "CreatedAt": row["CreatedAt"],
                "BgColor": row["BgColor"],
                "AreaWidth": row.get("AreaWidth"),
                "AreaHeight": row.get("AreaHeight"),
                "UserId": row["UserId"],
                "ServerId": row.get("ServerId"),
                "ServerName": row.get("ServerName", ""),
                "OwnerUsername": row.get("OwnerUsername", ""),
            }
        )
    return screens


@router.get("/{screen_id}", status_code=status.HTTP_200_OK)
def get_screen(screen_id: int):
    """Получить один экран (метаданные)."""
    sql = """
        SELECT 
          s.ScreenId,
          s.ScreenName,
          s.Title,
          s.Description,
          s.IsPublic,
          s.IsReadonly,
          s.CreatedAt,
          s.BgColor,
          s.AreaWidth,
          s.AreaHeight,
          s.UserId,
          u.Username AS OwnerUsername,
          s.ServerId,
          srv.Name AS ServerName
        FROM dbo.UserScreens AS s
        LEFT JOIN dbo.Users      AS u   ON s.UserId   = u.Id
        LEFT JOIN dbo.OpcServers AS srv ON s.ServerId = srv.Id
        WHERE s.ScreenId = ?
    """
    rows = execute_sql_query(sql, [screen_id])
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    row = rows[0]

    return {
        "screen_id": row["ScreenId"],
        "screen_name": row.get("ScreenName", f"user_screen_{row['ScreenId']}"),
        "title": row["Title"],
        "description": row["Description"],
        "bg_color": row["BgColor"],
        "area_width": row.get("AreaWidth"),
        "area_height": row.get("AreaHeight"),
        "is_public": bool(row["IsPublic"]),
        "is_readonly": bool(row["IsReadonly"]),
        "created_at": row["CreatedAt"],
        "user_id": row["UserId"],
        "owner_username": row.get("OwnerUsername", ""),
        "server_id": row.get("ServerId"),
        "server_name": row.get("ServerName", ""),
    }


@router.post("", status_code=status.HTTP_201_CREATED)
def create_screen(
    payload: Dict[str, Any] = Body(...),
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    data = payload or {}

    try:
        user_id = int(
            data.get("user_id")
            or data.get("userId")
            or current_user.get("user_id")
            or current_user.get("id")
        )
    except Exception:
        logger.error("create_screen: user_id not found in token/payload")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Не удалось определить пользователя",
        )

    title = data.get("title") or "Без имени"
    description = data.get("description") or ""
    bg_color = data.get("bgColor") or "#ffffff"

    is_public = 1 if bool(data.get("isPublic")) else 0
    is_readonly = 1 if bool(data.get("isReadonly")) else 0

    server_id_raw = data.get("serverId")
    try:
        server_id = int(server_id_raw) if server_id_raw is not None else None
    except Exception:
        server_id = None

    if server_id is None:
        server_id = 1

    safe_title = str(title).strip().replace(" ", "_")
    if len(safe_title) > 50:
        safe_title = safe_title[:50]
    screen_name = data.get("screenName") or f"user_screen_{safe_title}_{user_id}"

    try:
        area_width = int(data.get("areaWidth") or data.get("area_width") or 1500)
    except Exception:
        area_width = 1500

    try:
        area_height = int(data.get("areaHeight") or data.get("area_height") or 800)
    except Exception:
        area_height = 800

    sql = """
        INSERT INTO dbo.UserScreens
          (UserId, ServerId, ScreenName, Title, Description,
           IsPublic, IsReadonly, CreatedAt, BgColor, AreaWidth, AreaHeight)
        OUTPUT INSERTED.ScreenId,
               INSERTED.ScreenName,
               INSERTED.Title,
               INSERTED.Description,
               INSERTED.IsPublic,
               INSERTED.IsReadonly,
               INSERTED.BgColor,
               INSERTED.UserId,
               INSERTED.ServerId,
               INSERTED.AreaWidth,
               INSERTED.AreaHeight
        VALUES (?, ?, ?, ?, ?, ?, ?, GETDATE(), ?, ?, ?)
    """

    try:
        res = execute_sql_query(
            sql,
            [
                user_id,
                server_id,
                screen_name,
                title,
                description,
                is_public,
                is_readonly,
                bg_color,
                area_width,
                area_height,
            ],
        )
    except Exception as ex:
        logger.exception("create_screen: DB error")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"DB error: {ex}",
        )

    if not res:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Insert failed")

    return res[0]


@router.put("/{screen_id}", status_code=status.HTTP_200_OK)
def update_screen(screen_id: int, payload: Dict[str, Any] = Body(...)):
    """Переименовать/обновить экран (заголовок/описание/цвет)."""
    data = payload or {}
    title = data.get("title")
    description = data.get("description")
    bg_color = data.get("bgColor")
    sql = """
        UPDATE dbo.UserScreens
        SET Title = ?, Description = ?, BgColor = ?, UpdatedAt = GETDATE()
        WHERE ScreenId = ?
    """
    execute_sql_query(sql, [title, description, bg_color, screen_id])
    return {"message": "Экран обновлён"}


@router.delete("/{screen_id}", status_code=status.HTTP_200_OK)
def delete_screen(screen_id: int):
    """Удалить экран."""
    sql = "DELETE FROM UserScreens WHERE ScreenId = ?"
    execute_sql_query(sql, [screen_id])
    return {"message": "Экран удалён"}


@router.post("/{screen_id}/clone", status_code=status.HTTP_201_CREATED)
def clone_screen(screen_id: int):
    """Клонировать экран."""
    screen = execute_sql_query(
        "SELECT ScreenName, Title, Description, BgColor, ServerId, AreaWidth, AreaHeight, UserId FROM UserScreens WHERE ScreenId = ?",
        [screen_id],
    )
    if not screen:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "Экран не найден"})
    meta = screen[0]
    user_id = meta.get("UserId") or 1
    new_name = f"{meta['ScreenName']}_clone_{user_id}"
    sql = """
        INSERT INTO UserScreens 
          (UserId, ServerId, ScreenName, Title, Description, IsPublic, IsReadonly, CreatedAt, BgColor, AreaWidth, AreaHeight)
        OUTPUT INSERTED.ScreenId
        VALUES (?, ?, ?, ?, ?, 0, 0, GETDATE(), ?, ?, ?)
    """
    res = execute_sql_query(
        sql,
        [
            user_id,
            meta.get("ServerId"),
            new_name,
            meta["Title"] + " (Копия)",
            meta["Description"],
            meta["BgColor"],
            meta.get("AreaWidth"),
            meta.get("AreaHeight"),
        ],
    )
    new_screen_id = res[0]["ScreenId"]
    return {"message": "Экран склонирован", "ScreenId": new_screen_id}


@router.put("/{screen_id}/bg-color", status_code=status.HTTP_200_OK)
def update_bg_color(screen_id: int, payload: Dict[str, Any] = Body(...)):
    """Обновить цвет фона экрана."""
    data = payload or {}
    bg_color = data.get("bg_color")
    if not bg_color:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"error": "Нет цвета"})
    sql = "UPDATE dbo.UserScreens SET BgColor = ?, UpdatedAt = GETDATE() WHERE ScreenId = ?"
    execute_sql_query(sql, [bg_color, screen_id])
    return {"success": True}


# ---------- BULK-СОХРАНЕНИЕ ОБЪЕКТОВ ЭКРАНА ----------

def _safe_json(v):
    if v is None:
        return None
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v, ensure_ascii=False)
    except Exception:
        return None


def _normalize_item(it: Dict[str, Any]) -> Dict[str, Any]:
    """
    Приводим item из фронта к единому формату для MERGE в ScreenObjects.
    """
    cfg = it.get("chartConfig") or it.get("ChartConfig") or {}
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:
            cfg = {}

    chart_json = _safe_json(cfg)
    obj_id = str(it.get("id") or "")

    return {
        "id": obj_id,
        "label": it.get("label") or obj_id,
        "x": int(it.get("x") or 0),
        "y": int(it.get("y") or 0),
        "width": int(it.get("width") or 180),
        "height": int(it.get("height") or 68),
        "type": it.get("type") or "tag",
        "chart_json": chart_json,
        "settings": it.get("settings") or {},
    }


@objects_router.post("/bulk", status_code=status.HTTP_200_OK)
def save_screen_objects_bulk(
    payload: Dict[str, Any] = Body(...),
    user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Массовое сохранение объектов пользовательского экрана.
    Теперь настройки видимости (ShowLabel / ShowTagName) хранятся
    напрямую в таблице ScreenObjects.
    """
    data = payload or {}
    try:
        screen_id = int(data.get("screen_id") or 0)
        items: List[Dict[str, Any]] = list(data.get("items") or [])
        delete_missing: bool = bool(data.get("delete_missing"))
        user_id = int(user["id"])

        if not screen_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "screen_id обязателен"},
            )

        # 1) берём ServerId и ScreenName из UserScreens
        q_info = """
            SELECT TOP 1 ServerId, ScreenName
            FROM UserScreens
            WHERE ScreenId = ?
        """
        rows = execute_sql_query(q_info, [screen_id])
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": f"Экран с id={screen_id} не найден"},
            )

        server_id = int(rows[0]["ServerId"])
        screen_name = str(rows[0]["ScreenName"] or "").strip()

        # 2) MERGE для ScreenObjects с ShowLabel / ShowTagName
        merge_objects_sql = """
        MERGE dbo.ScreenObjects AS tgt
        USING (
            SELECT CAST(? AS INT)           AS ServerId,
                   CAST(? AS NVARCHAR(255)) AS ScreenName,
                   CAST(? AS NVARCHAR(255)) AS ObjectName
        ) AS src
        ON (tgt.ServerId = src.ServerId AND
            tgt.ScreenName = src.ScreenName AND
            tgt.ObjectName = src.ObjectName)
        WHEN MATCHED THEN
            UPDATE SET
                Type        = ?,
                X           = ?,
                Y           = ?,
                Width       = ?,
                Height      = ?,
                Label       = ?,
                ChartConfig = ?,
                ShowLabel   = ?,
                ShowTagName = ?,
                User_id     = ?,
                DateCreated = tgt.DateCreated
        WHEN NOT MATCHED THEN
            INSERT (ServerId, ScreenName, ObjectName,
                    Type, X, Y, Width, Height,
                    Label, ChartConfig,
                    ShowLabel, ShowTagName,
                    User_id, DateCreated)
            VALUES (src.ServerId, src.ScreenName, src.ObjectName,
                    ?, ?, ?, ?, ?,
                    ?, ?,
                    ?, ?,
                    ?, GETDATE());
        """

        payload_ids: List[str] = []

        # 3) сохраняем все объекты
        for it in items:
            obj_id = str(it.get("id") or "").strip()
            if not obj_id:
                continue

            payload_ids.append(obj_id)

            obj_type = (it.get("type") or "tag").strip()
            x = int(round(it.get("x") or 0))
            y = int(round(it.get("y") or 0))
            width = int(round(it.get("width") or (180 if obj_type == "tag" else 320)))
            height = int(round(it.get("height") or (68 if obj_type == "tag" else 200)))
            label = str(it.get("label") or obj_id)

            raw_cfg = it.get("chartConfig") or {}
            try:
                chart_json = json.dumps(raw_cfg, ensure_ascii=False)
            except Exception:
                chart_json = "{}"

            settings = it.get("settings") or {}
            show_label = _as01(settings.get("showLabel") or settings.get("ShowLabel"))
            show_tagname = _as01(settings.get("showTagName") or settings.get("ShowTagName"))

            params_obj = [
                # src
                server_id,
                screen_name,
                obj_id,
                # UPDATE
                obj_type,
                x,
                y,
                width,
                height,
                label,
                chart_json,
                show_label,
                show_tagname,
                user_id,
                # INSERT
                obj_type,
                x,
                y,
                width,
                height,
                label,
                chart_json,
                show_label,
                show_tagname,
                user_id,
            ]
            execute_sql_query(merge_objects_sql, params_obj)

        # 4) Удаляем лишние объекты, если delete_missing = True
        if delete_missing:
            q_existing = """
                SELECT ObjectName
                FROM dbo.ScreenObjects
                WHERE ServerId = ? AND ScreenName = ?
            """
            rows_existing = execute_sql_query(q_existing, [server_id, screen_name])

            payload_set = set(payload_ids)
            to_delete = [r["ObjectName"] for r in rows_existing if r["ObjectName"] not in payload_set]

            if to_delete:
                placeholders = ",".join(["?"] * len(to_delete))

                sql_del_objects = f"""
                    DELETE FROM dbo.ScreenObjects
                    WHERE ServerId = ? AND ScreenName = ? AND ObjectName IN ({placeholders})
                """
                execute_sql_query(sql_del_objects, [server_id, screen_name, *to_delete])

        return {"ok": True}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("save_screen_objects_bulk failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": str(e)},
        )


# ---------- /props, /share, /readonly ----------

@router.put("/{screen_id}/props", status_code=status.HTTP_200_OK)
def update_screen_props(screen_id: int, payload: Dict[str, Any] = Body(...)):
    """Единый эндпоинт для обновления свойств экрана."""
    data = payload or {}

    is_public = _coerce_bool(data.get("is_public"))
    if is_public is None and "isPublic" in data:
        is_public = _coerce_bool(data.get("isPublic"))

    is_readonly = _coerce_bool(data.get("is_readonly"))
    if is_readonly is None and "isReadonly" in data:
        is_readonly = _coerce_bool(data.get("isReadonly"))

    area_width = data.get("area_width", data.get("areaWidth"))
    area_height = data.get("area_height", data.get("areaHeight"))
    bg_color = data.get("bg_color", data.get("bgColor"))

    payload_resp, code = _update_screen_props_tx(
        screen_id,
        is_public=is_public,
        is_readonly=is_readonly,
        area_width=area_width,
        area_height=area_height,
        bg_color=bg_color,
    )
    if isinstance(payload_resp, dict) and "error" in payload_resp:
        raise HTTPException(status_code=code, detail=payload_resp)
    return payload_resp


@router.post("/{screen_id}/share", status_code=status.HTTP_200_OK)
def share_screen(screen_id: int, payload: Dict[str, Any] = Body(...)):
    """Установить/снять публичность экрана."""
    raw = payload or {}
    is_public = _coerce_bool(raw.get("isPublic", raw.get("is_public", 1)))
    payload_resp, code = _update_screen_props_tx(screen_id, is_public=is_public)
    if isinstance(payload_resp, dict) and "error" in payload_resp:
        raise HTTPException(status_code=code, detail={**payload_resp})
    return {"message": "Публичность экрана изменена", **payload_resp}


@router.post("/{screen_id}/readonly", status_code=status.HTTP_200_OK)
def set_readonly(screen_id: int, payload: Dict[str, Any] = Body(...)):
    """Установить/снять режим только чтение."""
    raw = payload or {}
    is_readonly = _coerce_bool(raw.get("isReadonly", raw.get("is_readonly", 1)))
    payload_resp, code = _update_screen_props_tx(screen_id, is_readonly=is_readonly)
    if isinstance(payload_resp, dict) and "error" in payload_resp:
        raise HTTPException(status_code=code, detail=payload_resp)
    return {"message": "Режим 'только чтение' изменён", **payload_resp}


# ---------- ВЫДАЧА ОБЪЕКТОВ ЭКРАНА ----------

@objects_router.get("/{server_id}/{screen_name:path}", status_code=status.HTTP_200_OK)
def get_screen_objects_by_name(server_id: int, screen_name: str):
    """
    Выдаёт объекты экрана по ServerId + ScreenName.
    """
    screen_name = (screen_name or "").strip()
    if not screen_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"error": "screen_name required"})

    screen_name = unicodedata.normalize("NFC", screen_name)

    meta_rows = execute_sql_query(
        """
        SELECT ScreenId
        FROM dbo.UserScreens
        WHERE ServerId = ? AND ScreenName = ?
        """,
        [server_id, screen_name],
    )
    if not meta_rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "screen not found"})

    rows = execute_sql_query(
        """
        SELECT
          ServerId,
          ObjectName,
          Label,
          X,
          Y,
          DateCreated,
          User_id,
          ScreenName,
          Type,
          ChartConfig,
          Width,
          Height,
          ShowLabel,
          ShowTagName
        FROM dbo.ScreenObjects
        WHERE ServerId = ? AND ScreenName = ?
        ORDER BY Id
        """,
        [server_id, screen_name],
    )

    for r in rows:
        v = r.get("ChartConfig")
        if isinstance(v, (bytes, bytearray)):
            r["ChartConfig"] = v.decode("utf-8", errors="ignore")

    return rows


@router.delete("/{screen_id}/objects/{object_name}", status_code=status.HTTP_200_OK)
def delete_user_screen_object(screen_id: int, object_name: str):
    """Удаляет объект пользовательского экрана по его ID и имени объекта."""
    try:
        q_info = """
          SELECT TOP 1 ServerId, ScreenName
          FROM UserScreens
          WHERE ScreenId = ?
        """
        rows = execute_sql_query(q_info, [screen_id])
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": f"Экран с id={screen_id} не найден"},
            )

        row = rows[0]
        server_id = row["ServerId"]
        screen_name = row["ScreenName"]

        q_del_obj = """
          DELETE FROM ScreenObjects
          WHERE ObjectName = ? AND ScreenName = ? AND ServerId = ?
        """
        execute_sql_query(q_del_obj, [object_name, screen_name, server_id])

        return {"message": f"Объект '{object_name}' удалён c экрана id={screen_id}"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ошибка при удалении (user-screens) '{object_name}': {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "Не удалось удалить объект"},
        )


@router.get("/{screen_id}/live-data", status_code=status.HTTP_200_OK)
def get_live_data_by_screen(screen_id: int):
    """
    Живые данные по экрану (через sp_GetLiveDataByScreenId).
    """
    try:
        meta = execute_sql_query(
            """
            SELECT ScreenName, ServerId
            FROM dbo.UserScreens
            WHERE ScreenId = ?
            """,
            [screen_id],
        )
        if not meta:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "screen not found"},
            )

        screen_name = meta[0]["ScreenName"]
        server_id = meta[0]["ServerId"]

        rows = execute_stored_procedure(
            "sp_GetLiveDataByScreenId",
            [screen_name, server_id],
        )
        return rows
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("get_live_data_by_screen failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": str(e)},
        )


@router.get("/{screen_id}/objects", status_code=status.HTTP_200_OK)
def get_screen_objects_by_id(screen_id: int):
    """
    Объекты экрана по ScreenId (используем ScreenName из UserScreens).
    """
    meta = execute_sql_query(
        """
        SELECT ScreenId, ServerId, ScreenName
        FROM dbo.UserScreens
        WHERE ScreenId = ?
        """,
        [screen_id],
    )
    if not meta:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"error": "screen not found"})

    m = meta[0]

    rows = execute_sql_query(
        """
        SELECT
          ServerId,
          ObjectName,
          Label,
          X,
          Y,
          DateCreated,
          User_id,
          ScreenName,
          Type,
          ChartConfig,
          Width,
          Height,
          ShowLabel,
          ShowTagName
        FROM dbo.ScreenObjects
        WHERE ServerId = ? AND ScreenName = ?
        ORDER BY Id
        """,
        [m["ServerId"], m["ScreenName"]],
    )

    for r in rows:
        v = r.get("ChartConfig")
        if isinstance(v, (bytes, bytearray)):
            r["ChartConfig"] = v.decode("utf-8", errors="ignore")

    return rows
