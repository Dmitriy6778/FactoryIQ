# app/routers/polling_router.py
from fastapi import APIRouter
from pydantic import BaseModel
import pyodbc
from typing import Optional, List
from datetime import datetime

router = APIRouter(prefix="/polling", tags=["polling"])


# ---------------------------- МОДЕЛИ ----------------------------
class PollingTask(BaseModel):
    id: Optional[int] = None
    server_url: str
    interval_id: int
    is_active: bool = True
    started_at: Optional[str] = None


class TagToPoll(BaseModel):
    node_id: str
    browse_name: Optional[str] = ""
    data_type: Optional[str] = ""
    description: Optional[str] = ""


class StartSelectedPollingRequest(BaseModel):
    server_id: int
    endpoint_url: str
    tags: List[TagToPoll]
    interval_id: int


class TaskIdRequest(BaseModel):
    task_id: int


class StartTaskRequest(BaseModel):
    task_id: int


# ---------------------------- РОУТЫ ----------------------------
@router.get("/polling-intervals")
def get_polling_intervals():
    """Возвращает все доступные интервалы опроса."""
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str()) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT Id, Name, IntervalSeconds FROM PollingIntervals ORDER BY IntervalSeconds")
        items = [
            {"id": row[0], "name": row[1], "intervalSeconds": row[2]}
            for row in cursor.fetchall()
        ]
    return {"ok": True, "items": items}


@router.get("/polling-tasks")
def get_polling_tasks():
    """Возвращает список всех задач polling с привязанными тегами."""
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str()) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT t.id, t.server_url, t.interval_id, t.is_active, t.started_at,
                   i.Name, i.IntervalSeconds, i.Type
            FROM PollingTasks t
            LEFT JOIN PollingIntervals i ON t.interval_id = i.Id
            ORDER BY t.id DESC
        """)
        rows = cursor.fetchall()
        tasks = []
        for row in rows:
            task_id = row[0]
            cursor.execute("""
                SELECT ot.Id, ot.BrowseName, ot.NodeId, ot.DataType
                FROM PollingTaskTags ptt
                JOIN OpcTags ot ON ptt.tag_id = ot.Id
                WHERE ptt.polling_task_id = ?
            """, task_id)
            tags = [
                {
                    "id": tag_row[0],
                    "browse_name": tag_row[1],
                    "node_id": tag_row[2],
                    "data_type": tag_row[3],
                }
                for tag_row in cursor.fetchall()
            ]
            tasks.append({
                "id": row[0],
                "server_url": row[1],
                "interval_id": row[2],
                "interval_name": row[5],
                "interval_seconds": row[6],
                "is_active": bool(row[3]),
                "started_at": row[4].isoformat() if row[4] else None,
                "tags": tags,
            })
    return {"ok": True, "tasks": tasks}


@router.post("/polling-tasks/start")
def start_polling_task(task: PollingTask):
    """Создает новую задачу polling."""
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO PollingTasks (server_url, interval_id, is_active, started_at)
            VALUES (?, ?, ?, GETDATE())
        """, task.server_url, task.interval_id, task.is_active)
        task_id = cursor.execute("SELECT @@IDENTITY").fetchval()
    return {"ok": True, "task_id": task_id}


@router.post("/polling-tasks/start-by-id")
def start_existing_task(req: StartTaskRequest):
    """Активирует уже существующую задачу по id."""
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE PollingTasks SET is_active=1, started_at=GETDATE() WHERE id=?", req.task_id)
    return {"ok": True, "message": f"Задача #{req.task_id} активирована"}


@router.post("/polling-tasks/stop")
def stop_polling_task(req: TaskIdRequest):
    """Останавливает задачу по id."""
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE PollingTasks SET is_active=0 WHERE id=?", req.task_id)
    return {"ok": True, "message": f"Задача #{req.task_id} остановлена"}


@router.post("/stop_all")
def stop_all_tasks():
    """Останавливает все активные polling-задачи."""
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE PollingTasks SET is_active = 0")
    return {"ok": True, "message": "Все задачи остановлены"}


@router.post("/start_all")
def start_all_tasks():
    """Запускает все задачи polling."""
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE PollingTasks SET is_active = 1, started_at=GETDATE()")
    return {"ok": True, "message": "Все задачи запущены"}


@router.post("/polling-tasks/delete")
def delete_polling_task(req: TaskIdRequest):
    """Удаляет задачу и все связанные теги."""
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM PollingTaskTags WHERE polling_task_id=?", req.task_id)
        cursor.execute("DELETE FROM PollingTasks WHERE id=?", req.task_id)
    return {"ok": True, "message": f"Задача #{req.task_id} удалена"}


@router.post("/start_selected_polling")
def start_selected_polling(req: StartSelectedPollingRequest):
    """
    Создает новую задачу опроса или добавляет теги в существующую.
    Если активная задача для сервера + интервала уже есть — добавляем в нее новые теги.
    """
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str()) as conn:
        cursor = conn.cursor()
        tag_ids = []

        # --- Добавляем / находим теги ---
        for tag in req.tags:
            tag_dict = tag.dict() if hasattr(tag, "dict") else tag
            node_id = tag_dict["node_id"]
            browse_name = tag_dict.get("browse_name", "")
            data_type = tag_dict.get("data_type", "")
            description = tag_dict.get("description", "")
            cursor.execute(
                "SELECT Id FROM OpcTags WHERE ServerId=? AND NodeId=?",
                req.server_id, node_id
            )
            row = cursor.fetchone()
            if row:
                tag_id = row[0]
            else:
                cursor.execute("""
                    INSERT INTO OpcTags (ServerId, BrowseName, NodeId, DataType, Description)
                    OUTPUT INSERTED.Id VALUES (?, ?, ?, ?, ?)
                """, req.server_id, browse_name, node_id, data_type, description)
                tag_id = cursor.fetchone()[0]
            tag_ids.append(tag_id)

        conn.commit()

        if not tag_ids:
            return {"ok": False, "message": "Не выбрано ни одного тега для создания задачи опроса."}

        # --- Проверяем, есть ли уже активная задача для данного сервера и интервала ---
        cursor.execute("""
            SELECT id FROM PollingTasks
            WHERE server_url = ? AND interval_id = ? AND is_active = 1
        """, req.endpoint_url, req.interval_id)
        row = cursor.fetchone()

        if row:
            # Добавляем теги в существующую задачу
            polling_task_id = row[0]
            cursor.execute("SELECT tag_id FROM PollingTaskTags WHERE polling_task_id = ?", polling_task_id)
            existing_tag_ids = {r[0] for r in cursor.fetchall()}
            new_tag_ids = [tid for tid in tag_ids if tid not in existing_tag_ids]

            if not new_tag_ids:
                return {"ok": False, "message": f"Все выбранные теги уже есть в задаче (task_id={polling_task_id})"}

            rows = [(polling_task_id, tid) for tid in new_tag_ids]
            cursor.fast_executemany = True
            cursor.executemany(
                "INSERT INTO PollingTaskTags (polling_task_id, tag_id) VALUES (?, ?)",
                rows
            )
            conn.commit()

            return {
                "ok": True,
                "task_id": polling_task_id,
                "added_tags": new_tag_ids,
                "message": f"Добавлены {len(new_tag_ids)} тег(ов) в существующую задачу #{polling_task_id}"
            }

        # --- Создаем новую задачу ---
        cursor.execute("""
            INSERT INTO PollingTasks (server_url, interval_id, is_active, started_at)
            VALUES (?, ?, 1, GETDATE())
        """, req.endpoint_url, req.interval_id)
        polling_task_id = cursor.execute("SELECT @@IDENTITY").fetchval()
        conn.commit()

        rows = [(polling_task_id, tid) for tid in tag_ids]
        cursor.fast_executemany = True
        cursor.executemany(
            "INSERT INTO PollingTaskTags (polling_task_id, tag_id) VALUES (?, ?)", rows
        )
        conn.commit()

        return {
            "ok": True,
            "task_id": polling_task_id,
            "added_tags": tag_ids,
            "message": f"Создана новая задача #{polling_task_id} для {req.endpoint_url}"
        }
