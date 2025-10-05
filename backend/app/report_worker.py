import time
import pyodbc
import requests
import os
from datetime import datetime, time as dt_time, timedelta
from config import get_conn_str

API_BASE = "http://localhost:8000"
TG_TOKEN = "7926783542:AAHojzvzVWrRXu53pMjHJ9kjwclz3iyqbYA"
EXPORT_DIR = os.path.join(os.path.dirname(__file__), "..", "report_exports")


def resolve_telegram_destination(target_value):
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        cur.execute("SELECT ChannelId, ThreadId FROM TelegramReportTarget WHERE Id = ?", target_value)
        row = cur.fetchone()
        if row:
            return str(row.ChannelId), row.ThreadId
        return None, None


def ensure_export_dir():
    if not os.path.exists(EXPORT_DIR):
        os.makedirs(EXPORT_DIR, exist_ok=True)


def get_active_schedules():
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        now = datetime.now()
        cur.execute("""
            SELECT Id, TemplateId, PeriodType, TimeOfDay, NextRun, LastRun, TargetType, TargetValue, AggregationType, SendFormat
            FROM ReportSchedule
            WHERE Active=1 AND NextRun <= ?
        """, now)
        return cur.fetchall()


# ------------ расписание ------------
def _parse_tod(time_of_day):
    """Возвращает кортеж (hh, mm, ss) из строки/времени."""
    if isinstance(time_of_day, str) and time_of_day:
        parts = time_of_day.split(":")
        try:
            hh = int(parts[0])
            mm = int(parts[1]) if len(parts) > 1 else 0
            ss = int(parts[2]) if len(parts) > 2 else 0
            return hh, mm, ss
        except Exception:
            pass
    if isinstance(time_of_day, (dt_time, datetime)):
        return time_of_day.hour, time_of_day.minute, time_of_day.second
    return 8, 0, 0  # дефолт


def _first_day_next_month(dt: datetime, hh: int, mm: int, ss: int) -> datetime:
    y, m = dt.year, dt.month
    if m == 12:
        y, m = y + 1, 1
    else:
        m += 1
    return datetime(y, m, 1, hh, mm, ss)


def compute_next_run(period_type: str, time_of_day, prev_run: datetime | None) -> datetime:
    """
    Возвращает NextRun, который ГАРАНТИРОВАННО > now.
    """
    now = datetime.now()
    hh, mm, ss = _parse_tod(time_of_day)

    # стартовая точка — отталкиваемся от prev_run, но если его нет, берём now
    candidate = prev_run or now

    if period_type == "hourly":
        # следующий «ровный» час относительно NOW
        return (now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1))

    if period_type in ("day", "daily"):
        # каждый день в указанное время
        candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        while candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    if period_type == "shift":
        # отдельные записи 08:00 и 20:00 → шаг 1 день, время фиксированное
        candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        while candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    if period_type == "weekly":
        # сохраняем время; шаг 7 дней до будущего
        candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=7)
        while candidate <= now:
            candidate += timedelta(days=7)
        return candidate

    if period_type == "monthly":
        # первый день следующего месяца в указанное время
        base = prev_run or now
        candidate = _first_day_next_month(base, hh, mm, ss)
        if candidate <= now:
            candidate = _first_day_next_month(now, hh, mm, ss)
            if candidate <= now:
                candidate = _first_day_next_month(candidate, hh, mm, ss)
        return candidate

    if period_type == "once":
        # всё равно ниже вы деактивируете; подстрахуем на далёкое будущее
        return now + timedelta(days=365 * 50)

    # дефолт как daily
    candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    while candidate <= now:
        candidate += timedelta(days=1)
    return candidate
# ------------------------------------


def save_report_file(report_data, file_name):
    ensure_export_dir()
    file_path = os.path.join(EXPORT_DIR, file_name)
    with open(file_path, "wb") as f:
        f.write(report_data)
    return file_path


def send_excel_to_telegram(channel_id, file_path, caption=None, thread_id=None):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendDocument"
    with open(file_path, "rb") as f:
        data = {"chat_id": channel_id, "caption": caption or "", "parse_mode": "HTML"}
        if thread_id:
            data["message_thread_id"] = thread_id
        resp = requests.post(url, data=data, files={"document": f})
    print(f"[TELEGRAM] Отправлен Excel: {file_path} -> {channel_id} (status {resp.status_code})")
    return resp.json()


def send_text_to_telegram(channel_id, text, thread_id=None):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    data = {"chat_id": channel_id, "text": text, "parse_mode": "HTML"}
    if thread_id:
        data["message_thread_id"] = thread_id
    resp = requests.post(url, data=data)
    print(f"[TELEGRAM] Отправлен текстовый отчёт в канал {channel_id}")
    return resp.json()


def send_photo_to_telegram(channel_id, image_bytes, caption="", thread_id=None):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendPhoto"
    files = {"photo": ("report.png", image_bytes)}
    data = {"chat_id": channel_id, "caption": caption or "", "parse_mode": "HTML"}
    if thread_id:
        data["message_thread_id"] = thread_id
    resp = requests.post(url, data=data, files=files)
    print(f"[TELEGRAM] Отправлено изображение в канал {channel_id}")
    return resp.json()


def is_number(val):
    try:
        float(val)
        return True
    except (ValueError, TypeError):
        return False


def format_report_table(columns, data, period=None):
    if not columns or not data:
        return "Нет данных для отчёта."
    col_widths = []
    for col in columns:
        max_len = len(str(col))
        for row in data:
            val = row.get(col, "")
            s = f"{float(val):.1f}" if is_number(val) else str(val)
            max_len = max(max_len, len(s))
        col_widths.append(max_len)
    header = " | ".join([str(col).ljust(col_widths[i]) for i, col in enumerate(columns)])
    separator = "-+-".join(['-' * col_widths[i] for i in range(len(columns))])
    lines = [header, separator]
    for row in data:
        cells = []
        for i, col in enumerate(columns):
            val = row.get(col, "")
            s = f"{float(val):.1f}" if is_number(val) else str(val)
            cells.append(s.ljust(col_widths[i]))
        lines.append(" | ".join(cells))
    if period:
        lines.append("")
        lines.append(period)
    return "\n".join(lines)


def get_tag_ids_for_template(template_id):
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        cur.execute("SELECT tag_id FROM ReportTemplateTags WHERE template_id=?", template_id)
        tag_ids = [str(row[0]) for row in cur.fetchall()]
        return ",".join(tag_ids)


def run_report_schedule():
    print("[REPORT WORKER] Автоотчёты + отправка в Telegram...")
    while True:
        schedules = get_active_schedules()
        print(f"[DEBUG] Получено заданий к запуску: {len(schedules)}")

        for row in schedules:
            (sched_id, template_id, period_type, time_of_day,
             next_run, last_run, target_type, target_value,
             aggregation_type, send_format) = row

            # нормализуем время
            if isinstance(time_of_day, dt_time):
                time_of_day_str = time_of_day.strftime("%H:%M:%S")
            elif isinstance(time_of_day, datetime):
                time_of_day_str = time_of_day.strftime("%H:%M:%S")
            else:
                time_of_day_str = time_of_day or ""

            channel_id, thread_id = resolve_telegram_destination(target_value)
            if not channel_id:
                print(f"[WORKER] Не найден канал для TargetValue={target_value}")
                continue

            # --- всегда просим бэкенд собрать превью
            if send_format in ("chart", "table", "text", "file"):
                payload = {
                    "template_id": template_id,
                    "format": send_format,
                    "period_type": period_type,
                    "time_of_day": time_of_day_str,
                    "aggregation_type": aggregation_type,
                }
                print("[DEBUG] Payload для /telegram/preview:", payload)
                resp = requests.post(f"{API_BASE}/telegram/preview", json=payload)

                if not resp.ok:
                    print("[WORKER] Ошибка /telegram/preview:", resp.status_code, resp.text)
                    # даже при ошибке двигаем NextRun вперёд, чтобы не спамить
                else:
                    result = resp.json()
                    period = result.get("period", {})
                    period_caption = ""
                    if period and period.get("date_from") and period.get("date_to"):
                        period_caption = f"Период: {period['date_from']} — {period['date_to']}"

                    if send_format == "chart":
                        png_base64 = result.get("chart_png")
                        if png_base64:
                            import base64
                            image_bytes = base64.b64decode(png_base64)
                            send_photo_to_telegram(channel_id, image_bytes, period_caption, thread_id)
                        else:
                            print("[WORKER] Нет графика для отправки.")

                    elif send_format in ("table", "text"):
                        import base64
                        table_pngs = result.get("table_pngs") or []
                        if table_pngs:
                            for i, b64 in enumerate(table_pngs):
                                caption = period_caption if i == 0 else ""
                                send_photo_to_telegram(channel_id, base64.b64decode(b64), caption, thread_id)
                        else:
                            text_table = result.get("text_table")
                            if text_table:
                                msg = f"<b>Автоотчёт</b>\n<pre>{text_table}</pre>"
                                if period_caption:
                                    msg += f"\n{period_caption}"
                                send_text_to_telegram(channel_id, msg, thread_id)
                            else:
                                columns = result.get("columns") or []
                                data = result.get("data") or []
                                table_text = format_report_table(columns, data, period_caption)
                                send_text_to_telegram(channel_id, f"<b>Автоотчёт</b>\n<pre>{table_text}</pre>", thread_id)

                    elif send_format == "file":
                        columns = result.get("columns") or []
                        data = result.get("data") or []
                        table_text = format_report_table(columns, data, period_caption)
                        send_text_to_telegram(channel_id, f"<b>Автоотчёт</b>\n<pre>{table_text}</pre>", thread_id)

            else:
                # резерв: excel
                resp = requests.post(
                    f"{API_BASE}/reports/build",
                    json={"template_id": template_id, "export_format": "excel"}
                )
                if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("application/vnd.openxmlformats"):
                    file_name = f"report_{sched_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
                    file_path = save_report_file(resp.content, file_name)
                    send_excel_to_telegram(channel_id, file_path, caption="📝 Автоматический отчёт", thread_id=thread_id)
                else:
                    try:
                        result = resp.json()
                        columns = result.get("columns")
                        data = result.get("data")
                        if columns and data:
                            table_text = format_report_table(columns, data)
                            send_text_to_telegram(channel_id, f"<b>Автоотчёт</b>\n<pre>{table_text}</pre>", thread_id)
                        else:
                            print("[WORKER] Нет данных для отчёта.")
                    except Exception as ex:
                        print(f"[WORKER] Ошибка разбора ответа: {ex} {resp.text}")

            # --- обновляем расписание
            if period_type == "once":
                with pyodbc.connect(get_conn_str()) as conn:
                    cur = conn.cursor()
                    cur.execute("UPDATE ReportSchedule SET Active=0 WHERE Id=?", sched_id)
                    conn.commit()
            else:
                new_next_run = compute_next_run(period_type, time_of_day, next_run)
                with pyodbc.connect(get_conn_str()) as conn:
                    cur = conn.cursor()
                    cur.execute(
                        "UPDATE ReportSchedule SET LastRun=?, NextRun=? WHERE Id=?",
                        datetime.now(), new_next_run, sched_id
                    )
                    conn.commit()

        time.sleep(60)


if __name__ == "__main__":
    run_report_schedule()
