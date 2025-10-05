from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import pyodbc
from ..config import get_conn_str

router = APIRouter(prefix="/tg/channels", tags=["telegram-channels"])

# --------- Модели ---------
class ChannelIn(BaseModel):
    ChannelId: int                 # chat_id телеграма (может быть отрицательный для каналов)
    ChannelName: str
    Active: int = 1                # 0/1
    ThreadId: Optional[int] = None # опционально (форумный топик)

class ChannelOut(BaseModel):
    Id: int
    ChannelId: int
    ChannelName: str
    Active: int
    CreatedAt: Optional[str] = None
    ThreadId: Optional[int] = None

# --------- helpers ---------
def row_to_dict(cursor, row) -> Dict[str, Any]:
    cols = [c[0] for c in cursor.description]
    return dict(zip(cols, row))

def table_has_col(cur, table: str, col: str) -> bool:
    cur.execute("""
        SELECT 1
        FROM sys.columns
        WHERE object_id = OBJECT_ID(?)
          AND name = ?
    """, f"dbo.{table}", col)
    return cur.fetchone() is not None

def select_clause(has_thread: bool) -> str:
    base = """
        SELECT Id, ChannelId, ChannelName,
               CAST(Active AS INT) AS Active,
               CONVERT(VARCHAR(19), CreatedAt, 120) AS CreatedAt
    """
    return (base + ", ThreadId FROM dbo.TelegramReportTarget") if has_thread \
           else (base + " FROM dbo.TelegramReportTarget")

# --------- CRUD ---------
@router.get("", response_model=List[ChannelOut])
def list_channels():
    try:
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            has_thread = table_has_col(cur, "TelegramReportTarget", "ThreadId")
            cur.execute(select_clause(has_thread) + " ORDER BY Id")
            return [row_to_dict(cur, r) for r in cur.fetchall()]
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=f"DB error in list_channels: {e}")

@router.get("/{id}", response_model=ChannelOut)
def get_channel(id: int):
    try:
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            has_thread = table_has_col(cur, "TelegramReportTarget", "ThreadId")
            cur.execute(select_clause(has_thread) + " WHERE Id = ?", id)
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Channel not found")
            return row_to_dict(cur, row)
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=f"DB error in get_channel: {e}")

@router.post("", response_model=ChannelOut, status_code=201)
def create_channel(ch: ChannelIn):
    try:
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            has_thread = table_has_col(cur, "TelegramReportTarget", "ThreadId")

            if has_thread and ch.ThreadId is not None:
                cur.execute("""
                    INSERT INTO dbo.TelegramReportTarget (ChannelId, ChannelName, Active, ThreadId, CreatedAt)
                    OUTPUT INSERTED.Id
                    VALUES (?, ?, ?, ?, GETDATE())
                """, ch.ChannelId, ch.ChannelName, int(bool(ch.Active)), ch.ThreadId)
            else:
                cur.execute("""
                    INSERT INTO dbo.TelegramReportTarget (ChannelId, ChannelName, Active, CreatedAt)
                    OUTPUT INSERTED.Id
                    VALUES (?, ?, ?, GETDATE())
                """, ch.ChannelId, ch.ChannelName, int(bool(ch.Active)))
            new_id = cur.fetchone()[0]
            conn.commit()

            cur.execute(select_clause(has_thread) + " WHERE Id = ?", new_id)
            return row_to_dict(cur, cur.fetchone())
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=f"DB error in create_channel: {e}")

@router.put("/{id}", response_model=ChannelOut)
def update_channel(id: int, ch: ChannelIn):
    try:
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            has_thread = table_has_col(cur, "TelegramReportTarget", "ThreadId")

            if has_thread:
                cur.execute("""
                    UPDATE dbo.TelegramReportTarget
                    SET ChannelId = ?, ChannelName = ?, Active = ?, ThreadId = ?
                    WHERE Id = ?
                """, ch.ChannelId, ch.ChannelName, int(bool(ch.Active)), ch.ThreadId, id)
            else:
                cur.execute("""
                    UPDATE dbo.TelegramReportTarget
                    SET ChannelId = ?, ChannelName = ?, Active = ?
                    WHERE Id = ?
                """, ch.ChannelId, ch.ChannelName, int(bool(ch.Active)), id)

            if cur.rowcount == 0:
                raise HTTPException(404, "Channel not found")
            conn.commit()

            cur.execute(select_clause(has_thread) + " WHERE Id = ?", id)
            return row_to_dict(cur, cur.fetchone())
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=f"DB error in update_channel: {e}")

@router.delete("/{id}", status_code=204)
def delete_channel(id: int):
    try:
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM dbo.TelegramReportTarget WHERE Id = ?", id)
            if cur.rowcount == 0:
                raise HTTPException(404, "Channel not found")
            conn.commit()
            return
    except pyodbc.Error as e:
        raise HTTPException(status_code=500, detail=f"DB error in delete_channel: {e}")
