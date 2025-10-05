# app/report_worker.py
import os
import time
import base64
import pyodbc
import requests
from datetime import datetime, time as dt_time, timedelta

# берем из app/config.py
from config import get_conn_str, get_env

# =========================
# НАСТРОЙКИ (через .env)
# =========================
# Пример .env:
#   API_BASE=http://localhost/api
#   TG_TOKEN=123456:ABC...
#   REQUEST_TIMEOUT=15
#   RETRY_SLEEP_ON_FAIL=10
API_BASE = get_env("API_BASE", "http://localhost/api")
TG_TOKEN = get_env("TG_TOKEN", "")
REQUEST_TIMEOUT = int(get_env("REQUEST_TIMEOUT", "15"))
RETRY_SLEEP_ON_FAIL = int(get_env("RETRY_SLEEP_ON_FAIL", "10"))

EXPORT_DIR = os.path.join(os.path.dirname(__file__), "..", "report_exports")


# =========================
# УТИЛИТЫ
# =========================
def ensure_export_dir():
    if not os.path.exists(EXPORT_DIR):
        os.makedirs(EXPORT_DIR, exist_ok=True)


def _http(method: str, url: str, **kwargs):
    # общий вызов с расширенным логированием
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    try:
        resp = requests.request(method.upper(), url, **kwargs)
        return resp
    except requests.RequestException as e:
        print(f"[HTTP] {method} {url} -> EXC: {repr(e)}")
        return None


def api_post(path: str, json: dict):
    """
    Безопасный POST к бэкенду с таймаутом и перехватом сетевых ошибок.
    path: '/telegram/preview', '/reports/build', и т.п.
    """
    url = f"{API_BASE}{path if path.startswith('/') else '/' + path}"
    resp = _http("POST", url, json=json)
    if resp is None:
        print(f"[WORKER] API POST failed {url}: no response (network error)")
    return resp


def api_options(path: str):
    url = f"{API_BASE}{path if path.startswith('/') else '/' + path}"
    return _http("OPTIONS", url)


def api_get_raw(full_url: str):
    return _http("GET", full_url)


def send_excel_to_telegram(channel_id, file_path, caption=None, thread_id=None):
    if not TG_TOKEN:
        print("[TELEGRAM] TG_TOKEN пустой — пропускаю отправку Excel.")
        return None
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendDocument"
    with open(file_path, "rb") as f:
        data = {"chat_id": channel_id, "caption": caption or "", "parse_mode": "HTML"}
        if thread_id:
            data["message_thread_id"] = thread_id
        resp = _http("POST", url, data=data, files={"document": f})
        if resp is not None:
            print(f"[TELEGRAM] Excel -> {channel_id} (status {resp.status_code})")
            return resp.json()
        return None


def send_text_to_telegram(channel_id, text, thread_id=None):
    if not TG_TOKEN:
        print("[TELEGRAM] TG_TOKEN пустой — пропускаю отправку текста.")
        return None
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    data = {"chat_id": channel_id, "text": text, "parse_mode": "HTML"}
    if thread_id:
        data["message_thread_id"] = thread_id
    resp = _http("POST", url, data=data)
    if resp is not None:
        print(f"[TELEGRAM] Text -> {channel_id} (status {resp.status_code})")
        return resp.json()
    return None


def send_photo_to_telegram(channel_id, image_bytes, caption="", thread_id=None):
    if not TG_TOKEN:
        print("[TELEGRAM] TG_TOKEN пустой — пропускаю отправку фото.")
        return None
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendPhoto"
    files = {"photo": ("report.png", image_bytes)}
    data = {"chat_id": channel_id, "caption": caption or "", "parse_mode": "HTML"}
    if thread_id:
        data["message_thread_id"] = thread_id
    resp = _http("POST", url, data=data, files=files)
    if resp is not None:
        print(f"[TELEGRAM] Photo -> {channel_id} (status {resp.status_code})")
        return resp.json()
    return None


def save_report_file(report_data, file_name):
    ensure_export_dir()
    file_path = os.path.join(EXPORT_DIR, file_name)
    with open(file_path, "wb") as f:
        f.write(report_data)
    return file_path


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


# =========================
# БД-ФУНКЦИИ
# =========================
def resolve_telegram_destination(target_value):
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT ChannelId, ThreadId FROM TelegramReportTarget WHERE Id = ?",
            target_value,
        )
        row = cur.fetchone()
        if row:
            return str(row.ChannelId), row.ThreadId
        return None, None


def get_active_schedules():
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        now = datetime.now()
        cur.execute(
            """
            SELECT Id, TemplateId, PeriodType, TimeOfDay, NextRun, LastRun,
                   TargetType, TargetValue, AggregationType, SendFormat
            FROM ReportSchedule
            WHERE Active=1 AND NextRun <= ?
            """,
            now,
        )
        return cur.fetchall()


def get_tag_ids_for_template(template_id):
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT tag_id FROM ReportTemplateTags WHERE template_id=?",
            template_id,
        )
        tag_ids = [str(row[0]) for row in cur.fetchall()]
        return ",".join(tag_ids)


# =========================
# ВЫЧИСЛЕНИЕ РАСПИСАНИЯ
# =========================
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
        # 08:00 и/или 20:00 — шаг 1 день
        candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        while candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    if period_type == "weekly":
        # сохраняем время; шаг 7 дней
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
        # на будущее — далеко, но ниже Active=0
        return now + timedelta(days=365 * 50)

    # дефолт — как daily
    candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    while candidate <= now:
        candidate += timedelta(days=1)
    return candidate


# =========================
# АВТОДЕТЕКТ API_BASE
# =========================
def _detect_api_base():
    """
    Проверяет актуальный API_BASE. Возвращает фактический base URL.
    Пробуем:
      1) как есть (например, http://localhost/api)
      2) без /api (http://localhost)
      3) порт 8000 без прокси (http://localhost:8000)
    """
    candidates = []

    base = API_BASE.rstrip("/")
    candidates.append(base)

    if base.endswith("/api"):
        candidates.append(base.removesuffix("/api"))
    else:
        candidates.append(base + "/api")

    candidates.append("http://localhost:8000")

    tried = set()
    for cand in candidates:
        cand = cand.rstrip("/")
        if cand in tried:
            continue
        tried.add(cand)

        openapi_url = f"{cand}/openapi.json"
        resp = api_get_raw(openapi_url)
        if resp and resp.ok:
            print(f"[CHECK] OK: {openapi_url} -> {resp.status_code}")
            # quick check for /telegram/preview OPTIONS (некоторые прокси требуют method allow)
            prev = _http("OPTIONS", f"{cand}/telegram/preview")
            if prev is None:
                print(f"[CHECK] OPTIONS failed for {cand}/telegram/preview (not fatal).")
            else:
                print(f"[CHECK] OPTIONS {cand}/telegram/preview -> {prev.status_code}")
            return cand
        else:
            code = None if not resp else resp.status_code
            print(f"[CHECK] FAIL: {openapi_url} -> {code}")

    # если ничего не завелось — вернем исходный, но предупредим
    print(f"[WARN] Не удалось подтвердить доступность API. Использую исходный API_BASE={API_BASE}")
    return API_BASE.rstrip("/")


# =========================
# ОСНОВНАЯ ЛОГИКА
# =========================
def run_report_schedule():
    global API_BASE
    print("[REPORT WORKER] Автоотчёты + отправка в Telegram...")
    print(f"[BOOT] API_BASE(.env) = {API_BASE}")
    print(f"[BOOT] TG_TOKEN set: {'YES' if TG_TOKEN else 'NO'}")

    # автоопределение рабочей базы
    API_BASE = _detect_api_base()
    print(f"[BOOT] API_BASE(actual) = {API_BASE}")

    if not TG_TOKEN:
        print("[WARN] TG_TOKEN пустой — отправка в Telegram невозможна.")

    while True:
        try:
            schedules = get_active_schedules()
        except Exception as e:
            print(f"[WORKER] Ошибка выборки расписаний: {e}")
            time.sleep(RETRY_SLEEP_ON_FAIL)
            continue

        print(f"[DEBUG] Получено заданий к запуску: {len(schedules)}")

        for row in schedules:
            # Каждый job оборачиваем, чтобы один сбой не валил весь цикл
            try:
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
                    # все равно обновим NextRun, чтобы не зациклиться
                    new_next_run = compute_next_run(period_type, time_of_day, next_run)
                    with pyodbc.connect(get_conn_str()) as conn:
                        cur = conn.cursor()
                        cur.execute(
                            "UPDATE ReportSchedule SET LastRun=?, NextRun=? WHERE Id=?",
                            datetime.now(), new_next_run, sched_id
                        )
                        conn.commit()
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

                    resp = api_post("/telegram/preview", payload)

                    if not resp:
                        print("[WORKER] Ошибка /telegram/preview: None (network or timeout)")
                    elif not resp.ok:
                        body = resp.text[:500]
                        print(f"[WORKER] Ошибка /telegram/preview: {resp.status_code} {body}")
                    else:
                        result = {}
                        try:
                            result = resp.json()
                        except Exception as je:
                            print(f"[WORKER] JSON decode error /telegram/preview: {je}, text={resp.text[:500]}")

                        period = result.get("period", {})
                        period_caption = ""
                        if period and period.get("date_from") and period.get("date_to"):
                            period_caption = f"Период: {period['date_from']} — {period['date_to']}"

                        if send_format == "chart":
                            png_base64 = result.get("chart_png")
                            if png_base64:
                                image_bytes = base64.b64decode(png_base64)
                                send_photo_to_telegram(channel_id, image_bytes, period_caption, thread_id)
                            else:
                                print("[WORKER] Нет графика для отправки.")

                        elif send_format in ("table", "text"):
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
                                    send_text_to_telegram(
                                        channel_id,
                                        f"<b>Автоотчёт</b>\n<pre>{table_text}</pre>",
                                        thread_id,
                                    )

                        elif send_format == "file":
                            # пока поведение как у text/table
                            columns = result.get("columns") or []
                            data = result.get("data") or []
                            table_text = format_report_table(columns, data, period_caption)
                            send_text_to_telegram(
                                channel_id,
                                f"<b>Автоотчёт</b>\n<pre>{table_text}</pre>",
                                thread_id,
                            )

                else:
                    # резерв: excel напрямую
                    resp = api_post("/reports/build", {
                        "template_id": template_id,
                        "export_format": "excel"
                    })

                    if resp and resp.status_code == 200 and resp.headers.get(
                        "content-type", ""
                    ).startswith("application/vnd.openxmlformats"):
                        file_name = f"report_{sched_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
                        file_path = save_report_file(resp.content, file_name)
                        send_excel_to_telegram(
                            channel_id,
                            file_path,
                            caption="📝 Автоматический отчёт",
                            thread_id=thread_id,
                        )
                    else:
                        try:
                            result = (resp.json() if resp else {})  # может быть None
                            columns = result.get("columns")
                            data = result.get("data")
                            if columns and data:
                                table_text = format_report_table(columns, data)
                                send_text_to_telegram(
                                    channel_id,
                                    f"<b>Автоотчёт</b>\n<pre>{table_text}</pre>",
                                    thread_id,
                                )
                            else:
                                print("[WORKER] Нет данных для отчёта (excel-ветка).")
                        except Exception as ex:
                            txt = resp.text if resp else "<no response>"
                            print(f"[WORKER] Ошибка разбора ответа (excel-ветка): {ex} {txt[:500]}")

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

            except Exception as job_ex:
                # Логируем и двигаем дальше, чтобы цикл не умирал
                print(f"[WORKER] Ошибка обработки задания (Id={row[0]}): {job_ex}")
                try:
                    # на всякий случай тоже двинем NextRun, чтобы не зациклиться на одном проблемном job
                    sched_id = row[0]
                    period_type = row[2]
                    time_of_day = row[3]
                    next_run = row[4]
                    new_next_run = compute_next_run(period_type, time_of_day, next_run)
                    with pyodbc.connect(get_conn_str()) as conn:
                        cur = conn.cursor()
                        cur.execute(
                            "UPDATE ReportSchedule SET LastRun=?, NextRun=? WHERE Id=?",
                            datetime.now(), new_next_run, sched_id
                        )
                        conn.commit()
                except Exception as ex2:
                    print(f"[WORKER] Доп. ошибка при обновлении NextRun: {ex2}")
                continue

        time.sleep(60)


if __name__ == "__main__":
    run_report_schedule()
