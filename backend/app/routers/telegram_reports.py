from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
import pyodbc
from ..config import get_conn_str
import matplotlib.pyplot as plt
import io
import base64

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
    aggregation_type: Optional[str] = None  # "avg", "min", "max", "current", "delta", "alerts"
    send_format: Optional[str] = None       # "file", "table", "chart"

class PreviewRequest(BaseModel):
    template_id: int
    format: str  # "file", "table", "chart"
    period_type: Optional[str] = None


# Получить все каналы
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

# Обновить канал
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

# Удалить канал
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

# Добавить расписание
@router.post("/schedule")
def create_report_schedule(payload: ReportScheduleCreate):
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        
        # Проверяем, что хотя бы один идентификатор цели есть
        if not payload.target_value:
            raise HTTPException(status_code=400, detail="Не выбран канал или чат для отправки.")

        # Проверка уникальности по всем полям!
        cursor.execute("""
            SELECT 1 FROM ReportSchedule
            WHERE TemplateId = ?
              AND PeriodType = ?
              AND TimeOfDay = ?
              AND TargetType = ?
              AND TargetValue = ?
              AND ISNULL(AggregationType, '') = ISNULL(?, '')
              AND ISNULL(SendFormat, '') = ISNULL(?, '')
              AND Active = 1
        """, payload.template_id, payload.period_type, payload.time_of_day, payload.target_type, payload.target_value,
             payload.aggregation_type, payload.send_format)
        if cursor.fetchone():
            raise HTTPException(status_code=409, detail="Такое расписание уже существует.")

        # Вставка, если нет дубликата
        cursor.execute("""
            INSERT INTO ReportSchedule
                (TemplateId, PeriodType, TimeOfDay, TargetType, TargetValue, AggregationType, SendFormat, Active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        """, payload.template_id, payload.period_type, payload.time_of_day, payload.target_type, payload.target_value,
             payload.aggregation_type, payload.send_format)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))
    
def generate_telegram_shift_bar_chart(
    data, x_key="Дата", y_key="Прирост", description="", title="Сменный отчёт"
):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import io
    import base64

    print(f"[chart] Получено data (len={len(data)}):", data[:2])

    if not data:
        print("[chart] Нет данных для построения графика!")
        return None

    filtered = [row for row in data if row.get("Смена") in ("Дневная", "Ночная")]
    print(f"[chart] Отфильтровано сменных строк (len={len(filtered)}):", filtered[:2])
    if not filtered:
        filtered = data
        print("[chart] Нет сменных строк, используем все!")

    x = [
        f"{row.get(x_key, '')} {row.get('Смена', '')}"
        for row in filtered
    ]
    # Переводим кг в тонны
    y = [round((row.get(y_key, 0) or 0) / 1000, 1) for row in filtered]
    print(f"[chart] x: {x}")
    print(f"[chart] y (тонны): {y}")

    fig, ax = plt.subplots(figsize=(7, 4))
    bars = ax.bar(x, y, color="#7ccd6d", zorder=2)

    for idx, bar in enumerate(bars):
        height = bar.get_height()
        # Всегда 1 знак после точки, без тысячных/разделителей
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            height + (max(y) * 0.02 if max(y) else 0.1),
            f"{height:.1f}",
            ha="center", va="bottom", fontsize=12, color="#222"
        )

    main_title = f"{description}\n{title}" if description else title
    ax.set_title(main_title, fontsize=14)
    ax.set_xlabel("Дата и смена")
    ax.set_ylabel("Переработка, т")  # т = тонны
    ax.grid(axis="y", linestyle="--", alpha=0.4, zorder=1)
    plt.tight_layout()
    buf = io.BytesIO()
    plt.savefig(buf, format="png")
    plt.close(fig)
    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode("utf-8")
    print("[chart] base64 png size:", len(b64))
    return b64


@router.post("/preview")
def preview_report(payload: PreviewRequest):
    """
    Предпросмотр отчёта — строит live-отчёт за последние сутки,
    начиная от самой свежей записи в OpcData (по убыванию до 7 дней).
    Если format == 'chart', отдаёт base64 PNG-график для Telegram-style предпросмотра.
    """
    try:
        import matplotlib
        matplotlib.use('Agg')  # <--- должен идти до pyplot!
        import matplotlib.pyplot as plt
        import datetime
        import json
        import io
        import base64

        # --- Остальной твой код БЕЗ ИЗМЕНЕНИЙ ---

        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()

        # 1. Определяем тип отчёта по template_id
        cursor.execute("""
            SELECT ReportType FROM [OpcUaSystem].[dbo].[ReportTemplates] WHERE Id = ?
        """, payload.template_id)
        row = cursor.fetchone()
        if not row:
            return {"ok": False, "detail": "Не найден шаблон отчёта."}
        report_type = row.ReportType

        # 2. Получаем список тегов из шаблона
        cursor.execute("""
            SELECT TagId, Aggregate, IntervalMinutes FROM [OpcUaSystem].[dbo].[ReportTemplateTags]
            WHERE TemplateId = ?
            ORDER BY DisplayOrder
        """, payload.template_id)
        tags = cursor.fetchall()
        if not tags:
            return {"ok": False, "detail": "В шаблоне нет тегов."}
        tag_ids = [t.TagId for t in tags]
        tag_ids_str = ",".join(str(tid) for tid in tag_ids)

        tags_json = json.dumps([
            {
                "tag_id": t.TagId,
                "aggregate": t.Aggregate or "",
                "interval_minutes": t.IntervalMinutes
            }
            for t in tags
        ])

        # 3. Получаем description если тег один (для подписи)
        tag_description = ""
        if len(tag_ids) == 1:
            cursor.execute("""
                SELECT Description FROM [OpcUaSystem].[dbo].[OpcTags]
                WHERE Id = ?
            """, tag_ids[0])
            desc_row = cursor.fetchone()
            tag_description = desc_row.Description if desc_row and desc_row.Description else ""

        # 4. Находим дату самой свежей записи в OpcData по этим тегам
        cursor.execute(f"""
            SELECT MAX([Timestamp]) FROM [OpcUaSystem].[dbo].[OpcData]
            WHERE TagId IN ({tag_ids_str}) AND [Status] = 'Good'
        """)
        max_date_row = cursor.fetchone()
        max_date = max_date_row[0]
        if not max_date:
            return {"ok": False, "detail": "Нет данных для предпросмотра (база пуста)."}

        # 5. Перебираем до 7 последних суток от этой даты — ищем первый непустой отчёт
        found = False
        preview_data, columns, preview_from, preview_to = None, None, None, None

        for i in range(7):
            date_to = max_date - datetime.timedelta(days=i)
            date_from = date_to - datetime.timedelta(days=1)

            # Есть ли данные хотя бы по одному тегу в этот период?
            cursor.execute(f"""
                SELECT COUNT(1) FROM [OpcUaSystem].[dbo].[OpcData]
                WHERE TagId IN ({tag_ids_str})
                  AND [Timestamp] >= ? AND [Timestamp] < ?
                  AND [Status] = 'Good'
            """, date_from, date_to)
            row_count = cursor.fetchone()[0]

            if row_count > 0:
                # Есть данные — строим предпросмотр
                if report_type == "balance":
                    cursor.execute("EXEC sp_GetBalanceReport ?, ?, ?", date_from, date_to, tag_ids_str)
                else:
                    cursor.execute("EXEC sp_GetCustomReport ?, ?, ?", date_from, date_to, tags_json)
                columns = [col[0] for col in cursor.description]
                rows = cursor.fetchall()
                data = [dict(zip(columns, row)) for row in rows]
                preview_data, preview_from, preview_to = data, date_from, date_to
                found = True
                break

        if not found:
            return {"ok": False, "detail": "Нет данных для предпросмотра за последние 7 дней."}

        # === Генерация PNG для предпросмотра (если format == "chart") ===
        chart_png = None
        if getattr(payload, "format", None) == "chart" and preview_data and columns:
            print("[preview] Вызываем generate_telegram_shift_bar_chart...")
            chart_png = generate_telegram_shift_bar_chart(
                preview_data,
                x_key=columns[0],   # обычно "Дата"
                y_key=columns[-1],  # обычно "Прирост"
                description=tag_description,
                title="Сменный отчёт"
            )
            print("[preview] chart_png first 50:", chart_png[:50] if chart_png else "None")

        return {
            "ok": True,
            "data": preview_data,
            "columns": columns,
            "period": {
                "date_from": preview_from.strftime("%Y-%m-%d %H:%M"),
                "date_to": preview_to.strftime("%Y-%m-%d %H:%M"),
            },
            "chart_png": chart_png
        }
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))



@router.get("/tasks")
def get_report_tasks():
    """
    Получить все задания для отправки отчетов в Telegram (join с шаблонами)
    """
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                rs.Id,
                rs.TemplateId,
                t.Name as TemplateName,
                rs.PeriodType,
                rs.TimeOfDay,
                rs.NextRun,
                rs.LastRun,
                rs.Active,
                rs.TargetType,
                rs.TargetValue,
                rs.AggregationType,
                rs.SendFormat
            FROM OpcUaSystem.dbo.ReportSchedule rs
            LEFT JOIN OpcUaSystem.dbo.ReportTemplates t ON rs.TemplateId = t.Id
            ORDER BY rs.Id DESC
        """)
        tasks = []
        for row in cursor.fetchall():
            tasks.append({
                "id": row.Id,
                "template_id": row.TemplateId,
                "template_name": row.TemplateName,
                "period_type": row.PeriodType,
                "time_of_day": str(row.TimeOfDay) if row.TimeOfDay else None,
                "next_run": str(row.NextRun) if row.NextRun else None,
                "last_run": str(row.LastRun) if row.LastRun else None,
                "active": bool(row.Active),
                "target_type": row.TargetType,
                "target_value": row.TargetValue,
                "aggregation_type": row.AggregationType,
                "send_format": row.SendFormat,
            })
        return {"ok": True, "tasks": tasks}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


class ReportTaskCreate(BaseModel):
    template_id: int
    period_type: str
    time_of_day: str
    target_type: str
    target_value: str
    aggregation_type: Optional[str] = None
    send_format: Optional[str] = None

@router.post("/tasks")
def create_report_task(payload: ReportTaskCreate):
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO ReportSchedule
                (TemplateId, PeriodType, TimeOfDay, TargetType, TargetValue, AggregationType, SendFormat, Active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        """, payload.template_id, payload.period_type, payload.time_of_day, payload.target_type, payload.target_value, payload.aggregation_type, payload.send_format)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


class ReportTaskUpdate(ReportTaskCreate):
    id: int

@router.put("/tasks/{id}")
def update_report_task(id: int, payload: ReportTaskUpdate):
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE ReportSchedule
            SET TemplateId=?, PeriodType=?, TimeOfDay=?, TargetType=?, TargetValue=?, AggregationType=?, SendFormat=?
            WHERE Id=? AND Active=1
        """, payload.template_id, payload.period_type, payload.time_of_day, payload.target_type, payload.target_value, payload.aggregation_type, payload.send_format, id)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.delete("/tasks/{id}")
def delete_report_task(id: int):
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("UPDATE ReportSchedule SET Active=0 WHERE Id=?", id)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))

@router.post("/tasks/{id}/activate")
def activate_report_task(id: int):
    try:
        conn = pyodbc.connect(get_conn_str())
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE ReportSchedule SET Active=1 WHERE Id=?
        """, id)
        conn.commit()
        return {"ok": True}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))
