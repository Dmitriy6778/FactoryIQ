from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import pyodbc
from ..config import get_conn_str

router = APIRouter(prefix="/telegram", tags=["telegram"])

class ChannelCreate(BaseModel):
    channel_id: str
    channel_name: str
    thread_id: Optional[int] = None
    send_as_file: bool = True
    send_as_text: bool = False
    send_as_chart: bool = False
    active: bool = True

class ChannelUpdate(ChannelCreate):
    id: int

class ReportScheduleCreate(BaseModel):
    template_id: int
    period_type: str
    time_of_day: str
    target_type: str
    target_value: str

# Получить все каналы (используется фронтом для выбора)
@router.get("/channels")
def get_channels():
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            SELECT Id, ChannelId, ChannelName, ThreadId, SendAsFile, SendAsText, SendAsChart, Active
            FROM TelegramReportTarget
            WHERE Active = 1
        """)
        channels = []
        for row in cursor.fetchall():
            channels.append({
                "id": row.Id,
                "channel_id": row.ChannelId,
                "channel_name": row.ChannelName,
                "thread_id": row.ThreadId,
                "send_as_file": bool(row.SendAsFile),
                "send_as_text": bool(row.SendAsText),
                "send_as_chart": bool(row.SendAsChart),
                "active": bool(row.Active),
            })
        return {"ok": True, "channels": channels}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# Добавить канал
@router.post("/channels")
def add_channel(channel: ChannelCreate):
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO TelegramReportTarget
            (ChannelId, ChannelName, ThreadId, SendAsFile, SendAsText, SendAsChart, Active)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, channel.channel_id, channel.channel_name, channel.thread_id,
             int(channel.send_as_file), int(channel.send_as_text), int(channel.send_as_chart), int(channel.active))
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# Обновить канал (например, изменить название, способы отправки)
@router.put("/channels/{id}")
def update_channel(id: int, channel: ChannelUpdate):
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE TelegramReportTarget
            SET ChannelId=?, ChannelName=?, ThreadId=?, SendAsFile=?, SendAsText=?, SendAsChart=?, Active=?
            WHERE Id=?
        """, channel.channel_id, channel.channel_name, channel.thread_id,
             int(channel.send_as_file), int(channel.send_as_text), int(channel.send_as_chart), int(channel.active), id)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# Деактивировать (или удалить) канал
@router.delete("/channels/{id}")
def delete_channel(id: int):
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("UPDATE TelegramReportTarget SET Active=0 WHERE Id=?", id)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

# 6. Запланировать автоотчёт (расписание)
@router.post("/schedule")
def create_report_schedule(payload: ReportScheduleCreate):
    """
    Создать расписание автосоздания/рассылки отчёта.
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO ReportSchedule (TemplateId, PeriodType, TimeOfDay, TargetType, TargetValue, Active)
            VALUES (?, ?, ?, ?, ?, 1)
        """, payload.template_id, payload.period_type, payload.time_of_day, payload.target_type, payload.target_value)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))
