from fastapi import APIRouter
from pydantic import BaseModel
import pyodbc
from typing import Optional, List
from datetime import datetime


router = APIRouter(prefix="/polling", tags=["polling"])

class PollingTask(BaseModel):
    id: int = None
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
    
@router.get("/polling-intervals")
def get_polling_intervals():
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str()) as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT Id, Name, IntervalSeconds FROM PollingIntervals")
        items = [{"id": row[0], "name": row[1], "intervalSeconds": row[2]} for row in cursor.fetchall()]
    return {"ok": True, "items": items}


@router.get("/polling-tasks")
def get_polling_tasks():
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str()) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT t.id, t.server_url, t.interval_id, t.is_active, t.started_at,
                   i.Name, i.IntervalSeconds, i.Type
            FROM PollingTasks t
            LEFT JOIN PollingIntervals i ON t.interval_id = i.Id
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
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO PollingTasks (server_url, interval_id, is_active)
            VALUES (?, ?, ?)
        """, task.server_url, task.interval_id, task.is_active)
        task_id = cursor.execute("SELECT @@IDENTITY").fetchval()
    return {"ok": True, "task_id": task_id}

@router.post("/polling-tasks/start-by-id")
def start_existing_task(req: StartTaskRequest):
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE PollingTasks SET is_active=1 WHERE id=?", req.task_id)
    return {"ok": True}

@router.post("/polling-tasks/stop")
def stop_polling_task(req: TaskIdRequest):
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE PollingTasks SET is_active=0 WHERE id=?", req.task_id)
    return {"ok": True}

@router.post("/stop_all")
def stop_all_tasks():
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE PollingTasks SET is_active = 0")
    return {"ok": True, "message": "Все задачи остановлены"}


@router.post("/start_all")
def start_all_tasks():
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE PollingTasks SET is_active = 1")
    return {"ok": True, "message": "Все задачи запущены"}


@router.post("/polling-tasks/delete")
def delete_polling_task(req: TaskIdRequest):
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
        cursor = conn.cursor()
        cursor.execute("DELETE FROM PollingTasks WHERE id=?", req.task_id)
        cursor.execute("DELETE FROM PollingTaskTags WHERE polling_task_id=?", req.task_id)
    return {"ok": True}


@router.post("/start_selected_polling")
def start_selected_polling(req: StartSelectedPollingRequest):
    from ..config import get_conn_str
    with pyodbc.connect(get_conn_str()) as conn:
        cursor = conn.cursor()
        tag_ids = []
        for tag in req.tags:
            if hasattr(tag, "dict"):
                tag = tag.dict()
            node_id = tag["node_id"]
            browse_name = tag.get("browse_name", "")
            data_type = tag.get("data_type", "")
            description = tag.get("description", "")
            cursor.execute(
                "SELECT Id FROM OpcTags WHERE ServerId=? AND NodeId=?", req.server_id, node_id
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
            return {
                "ok": False,
                "message": "Не выбрано ни одного тега для создания задачи опроса."
            }

        # Проверка на дубликаты (как было)
        cursor.execute("""
            SELECT id FROM PollingTasks
            WHERE server_url = ? AND interval_id = ? AND is_active = 1
        """, req.endpoint_url, req.interval_id)
        candidate_tasks = [row[0] for row in cursor.fetchall()]

        tag_ids_set = set(tag_ids)
        for task_id in candidate_tasks:
            cursor.execute("SELECT tag_id FROM PollingTaskTags WHERE polling_task_id = ?", task_id)
            task_tag_ids = set(row[0] for row in cursor.fetchall())
            if tag_ids_set == task_tag_ids:
                return {
                    "ok": False,
                    "message": f"Уже существует задача с такими тегами (task_id={task_id})"
                }

        # Если дубля нет — создаём задачу
        cursor.execute("""
            INSERT INTO PollingTasks (server_url, interval_id, is_active)
            VALUES (?, ?, 1)
        """, req.endpoint_url, req.interval_id)
        polling_task_id = cursor.execute("SELECT @@IDENTITY").fetchval()
        conn.commit()

        rows = [(polling_task_id, tid) for tid in tag_ids]
        if not rows:
            return {
                "ok": False,
                "message": "Вы не выбрали ни одного нового тега для опроса."
            }

        cursor.fast_executemany = True
        cursor.executemany(
            "INSERT INTO PollingTaskTags (polling_task_id, tag_id) VALUES (?, ?)", rows
        )
        conn.commit()

    return {"ok": True, "task_id": polling_task_id, "added_tags": tag_ids}
