import time
import pyodbc
import requests
import os
from datetime import datetime, timedelta
from config import get_conn_str

API_BASE = "http://localhost:8000"
TG_TOKEN = "7926783542:AAHojzvzVWrRXu53pMjHJ9kjwclz3iyqbYA"
EXPORT_DIR = r"D:\My_Business\AltaiMai\FactoryIQ\backend\report_exports"

def ensure_export_dir():
    if not os.path.exists(EXPORT_DIR):
        os.makedirs(EXPORT_DIR, exist_ok=True)

def get_active_schedules():
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        now = datetime.now()
        cur.execute("""
            SELECT Id, TemplateId, PeriodType, TimeOfDay, NextRun, LastRun, TargetType, TargetValue
            FROM ReportSchedule
            WHERE Active=1 AND NextRun <= ?
        """, now)
        return cur.fetchall()

def get_telegram_target(channel_id):
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT ChannelId, ChannelName, SendAsFile
            FROM TelegramReportTarget WHERE ChannelId = ?
        """, channel_id)
        return cur.fetchone()

def compute_next_run(period_type, time_of_day, prev_run):
    hh, mm = map(int, (time_of_day or "08:00").split(":"))
    dt = prev_run or datetime.now()
    if period_type == "day":
        dt = (dt + timedelta(days=1)).replace(hour=hh, minute=mm, second=0, microsecond=0)
    elif period_type == "shift":
        dt = (dt + timedelta(hours=12)).replace(minute=mm, second=0, microsecond=0)
    else:
        dt = (dt + timedelta(days=1)).replace(hour=hh, minute=mm, second=0, microsecond=0)
    return dt

def save_report_file(report_data, file_name):
    ensure_export_dir()
    file_path = os.path.join(EXPORT_DIR, file_name)
    with open(file_path, "wb") as f:
        f.write(report_data)
    return file_path

def send_excel_to_telegram(channel_id, file_path, caption=None, thread_id=None):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendDocument"
    with open(file_path, "rb") as f:
        data = {
            "chat_id": channel_id,
            "caption": caption or "",
            "parse_mode": "HTML"
        }
        if thread_id:
            data["message_thread_id"] = thread_id
        resp = requests.post(url, data=data, files={"document": f})
    print(f"[TELEGRAM] Отправлен Excel: {file_path} -> {channel_id} (status {resp.status_code})")
    return resp.json()

def send_text_to_telegram(channel_id, text, thread_id=None):
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    data = {
        "chat_id": channel_id,
        "text": text,
        "parse_mode": "HTML"
    }
    if thread_id:
        data["message_thread_id"] = thread_id
    resp = requests.post(url, data=data)
    print(f"[TELEGRAM] Отправлен текстовый отчёт в канал {channel_id}")
    return resp.json()

def run_report_schedule():
    print("[REPORT WORKER] Автоотчёты + отправка в Telegram...")
    while True:
        schedules = get_active_schedules()
        for row in schedules:
            (sched_id, template_id, period_type, time_of_day,
             next_run, last_run, target_type, target_value) = row

            # 1. Определить период
            date_to = (datetime.now() - timedelta(seconds=1)).strftime('%Y-%m-%d %H:%M:%S')
            if period_type == "day":
                date_from = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S')
            elif period_type == "shift":
                date_from = (datetime.now() - timedelta(hours=12)).strftime('%Y-%m-%d %H:%M:%S')
            else:
                date_from = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d %H:%M:%S')

            # 2. Генерируем отчёт через API (лучше добавить эндпоинт для возврата excel-файла)
            resp = requests.post(
                f"{API_BASE}/reports/build",
                json={
                    "template_id": template_id,
                    "date_from": date_from,
                    "date_to": date_to,
                    "export_format": "excel"
                }
            )

            if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("application/vnd.openxmlformats"):
                file_name = f"report_{sched_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
                file_path = save_report_file(resp.content, file_name)
                print(f"[REPORT WORKER] Excel сохранён: {file_path}")

                # 3. Определяем канал, отправляем
                thread_id = None
                channel_id = target_value
                telegram = get_telegram_target(channel_id)
                if telegram:
                    channel_id = telegram.ChannelId
                # Можно расширить: брать thread_id из таблицы, если есть

                send_excel_to_telegram(channel_id, file_path, caption="📝 Автоматический отчёт", thread_id=thread_id)

            else:
                # Можно отправлять как текст или просто логировать ошибку
                print(f"[REPORT WORKER] Ошибка генерации файла: {resp.status_code}, {resp.text}")

            # 4. Обновляем расписание
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
