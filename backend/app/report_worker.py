# app/report_worker.py
import os
import time
import base64
import pyodbc
import requests
from datetime import datetime, time as dt_time, timedelta
from typing import Optional, Tuple, Dict, Any

# берем из app/config.py
try:
    from .config import get_conn_str, get_env
except ImportError:
    # fallback, если модуль запускается не как пакет (например, старые скрипты)
    from config import get_conn_str, get_env
# =========================
# НАСТРОЙКИ (через .env)
# =========================
API_BASE = get_env("API_BASE", "http://localhost/api")
TG_TOKEN = get_env("TG_TOKEN", "")
REQUEST_TIMEOUT = int(get_env("REQUEST_TIMEOUT", "15"))
RETRY_SLEEP_ON_FAIL = int(get_env("RETRY_SLEEP_ON_FAIL", "10"))

EXPORT_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "report_exports")
)

# =========================
# УТИЛИТЫ
# =========================
def ensure_export_dir():
    if not os.path.exists(EXPORT_DIR):
        os.makedirs(EXPORT_DIR, exist_ok=True)

def _http(method: str, url: str, **kwargs):
    kwargs.setdefault("timeout", REQUEST_TIMEOUT)
    try:
        return requests.request(method.upper(), url, **kwargs)
    except requests.RequestException as e:
        print(f"[HTTP] {method} {url} -> EXC: {repr(e)}")
        return None

def api_post(path: str, json: dict):
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
            try:
                return resp.json()
            except Exception:
                return None
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
        try:
            return resp.json()
        except Exception:
            return None
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
        try:
            return resp.json()
        except Exception:
            return None
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
def resolve_telegram_destination(target_value) -> Tuple[Optional[str], Optional[int]]:
    """
    Поддерживает два формата:
    1) target_value = Id из TelegramReportTarget (int)
    2) target_value = chat_id (строка/число/@username), возвращаем напрямую
    """
    if target_value is None:
        return None, None

    try:
        as_id = int(str(target_value).strip())
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT ChannelId, ThreadId FROM TelegramReportTarget WHERE Id = ?",
                as_id,
            )
            row = cur.fetchone()
            if row:
                return str(row.ChannelId), row.ThreadId
    except (ValueError, TypeError):
        pass

    # иначе считаем, что TargetValue = прямой chat_id / @username
    return str(target_value), None

def get_active_schedules():
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT Id, TemplateId, PeriodType, TimeOfDay, NextRun, LastRun,
                   TargetType, TargetValue, AggregationType, SendFormat,
                   WindowMinutes, AvgSeconds,
                   StyleId, StyleOverride
            FROM ReportSchedule
            WHERE Active=1 AND (NextRun IS NULL OR NextRun <= ?)
            """,
            datetime.now(),
        )
        return cur.fetchall()

def get_tag_ids_for_template(template_id):
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        cur.execute("SELECT tag_id FROM ReportTemplateTags WHERE template_id=?", template_id)
        return ",".join([str(row[0]) for row in cur.fetchall()])

def _fetch_style(style_id: Optional[int]) -> Dict[str, Any]:
    """Читает ChartStyle из ReportStyles (JSON) по style_id."""
    if not style_id:
        return {}
    try:
        with pyodbc.connect(get_conn_str()) as conn:
            cur = conn.cursor()
            cur.execute("SELECT ChartStyle FROM ReportStyles WHERE Id=?", int(style_id))
            row = cur.fetchone()
            if not row or not row[0]:
                return {}
            import json
            try:
                return json.loads(row[0])
            except Exception:
                return {}
    except Exception as e:
        print(f"[STYLE] fetch error: {e}")
        return {}

def _merge_style(base: Dict[str, Any], override: Any) -> Dict[str, Any]:
    """Сливает два словаря стилей. override может быть строкой JSON."""
    import json
    result = dict(base or {})
    try:
        if isinstance(override, str) and override:
            override = json.loads(override)
    except Exception:
        override = {}
    if isinstance(override, dict):
        result.update({k: v for k, v in override.items() if v is not None})
    return result

# =========================
# ВЫЧИСЛЕНИЕ РАСПИСАНИЯ
# =========================
def is_minute_period(p: str) -> bool:
    return p in ("every_5m", "every_10m", "every_30m")

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

def _minute_step(period_type: str) -> int:
    if period_type == "every_5m":
        return 5
    if period_type == "every_10m":
        return 10
    if period_type == "every_30m":
        return 30
    return 5

def compute_next_run(period_type: str, time_of_day, prev_run: Optional[datetime]) -> datetime:
    now = datetime.now()
    hh, mm, ss = _parse_tod(time_of_day)

    if period_type in ("every_5m", "every_10m", "every_30m"):
        step = 5 if period_type == "every_5m" else 10 if period_type == "every_10m" else 30
        base = now.replace(second=0, microsecond=0)
        minutes = ((base.minute // step) + 1) * step
        delta_min = minutes - base.minute
        return base + timedelta(minutes=delta_min)

    if period_type == "hourly":
        return now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)

    # для остальных опираемся на prev_run, но не раньше now
    candidate = (prev_run or now)

    if period_type in ("day", "daily"):
        candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    if period_type == "shift":
        candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate

    # 🔹 НОВАЯ логика weekly — как “сменный” режим: 08:00 и 20:00 КАЖДЫЙ день
    if period_type == "weekly":
        base = now.replace(hour=hh, minute=mm, second=ss, microsecond=0)
        first  = base                 # первая смена (обычно 08:00)
        second = base + timedelta(hours=12)  # вторая смена (20:00)

        if now < first:
            return first
        if now < second:
            return second
        # обе смены на сегодня прошли — следующий день в hh:mm
        return first + timedelta(days=1)

    if period_type == "monthly":
        base = prev_run or now
        candidate = _first_day_next_month(base, hh, mm, ss)
        if candidate <= now:
            candidate = _first_day_next_month(now, hh, mm, ss)
            if candidate <= now:
                candidate = _first_day_next_month(candidate, hh, mm, ss)
        return candidate

    if period_type == "once":
        return now + timedelta(days=365 * 50)

    # дефолт — как daily
    candidate = candidate.replace(hour=hh, minute=mm, second=ss, microsecond=0)
    if candidate <= now:
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
      3) порт 8000 (http://localhost:8000)
    Проверяем реальный эндпоинт /telegram/preview методом OPTIONS/GET.
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

        probe = _http("OPTIONS", f"{cand}/telegram/preview")
        if probe and (probe.ok or probe.status_code in (200, 204, 405)):
            print(f"[CHECK] OK: {cand}/telegram/preview OPTIONS -> {probe.status_code}")
            return cand

        root = _http("GET", cand + "/")
        if root and root.ok:
            print(f"[CHECK] OK: {cand}/ -> {root.status_code}")
            return cand

        print(f"[CHECK] FAIL base {cand}")

    print(f"[WARN] Не удалось подтвердить доступность API. Использую исходный API_BASE={API_BASE}")
    return API_BASE.rstrip("/")

# =========================
# BOOTSTRAP NextRun для NULL
# =========================
def _bootstrap_next_run_for_nulls():
    with pyodbc.connect(get_conn_str()) as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT Id, PeriodType, TimeOfDay, NextRun
            FROM ReportSchedule
            WHERE Active=1 AND NextRun IS NULL
        """)
        rows = cur.fetchall()
        for (sid, ptype, tod, nextrun) in rows:
            try:
                new_next = compute_next_run(ptype, tod, None)
                cur2 = conn.cursor()
                cur2.execute(
                    "UPDATE ReportSchedule SET NextRun=? WHERE Id=?",
                    new_next, sid
                )
                conn.commit()
                print(f"[BOOTSTRAP] NextRun инициализирован для Id={sid}: {new_next}")
            except Exception as e:
                print(f"[BOOTSTRAP] Ошибка init NextRun(Id={sid}): {e}")

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

    # первичная инициализация NextRun для новых задач
    _bootstrap_next_run_for_nulls()

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
            try:
                (sched_id, template_id, period_type, time_of_day,
                 next_run, last_run, target_type, target_value,
                 aggregation_type, send_format,
                 window_minutes_db, avg_seconds_db,
                 style_id, style_override_db) = row

                # нормализуем время для payload
                if isinstance(time_of_day, dt_time):
                    time_of_day_str = time_of_day.strftime("%H:%M:%S")
                elif isinstance(time_of_day, datetime):
                    time_of_day_str = time_of_day.strftime("%H:%M:%S")
                else:
                    time_of_day_str = time_of_day or ""

                # для минутных и почасового время не передаём (важно!)
                if is_minute_period(period_type) or period_type == "hourly":
                    time_of_day_str = None

                # окно/усреднение
                def _default_window(p: str) -> int:
                    return 5 if p == "every_5m" else 10 if p == "every_10m" else 30

                if is_minute_period(period_type):
                    window_minutes = int(window_minutes_db or _default_window(period_type))
                    avg_seconds = int(avg_seconds_db or 10)
                else:
                    window_minutes = None
                    avg_seconds = None

                # стиль: base(from style_id) + override(from schedule)
                base_style = _fetch_style(style_id)
                style_override = _merge_style(base_style, style_override_db)

                # канал
                channel_id, thread_id = resolve_telegram_destination(target_value)
                if not channel_id:
                    print(f"[WORKER] Не найден канал для TargetValue={target_value}")
                    new_next_run = compute_next_run(period_type, time_of_day, next_run)
                    with pyodbc.connect(get_conn_str()) as conn:
                        cur = conn.cursor()
                        cur.execute(
                            "UPDATE ReportSchedule SET LastRun=?, NextRun=? WHERE Id=?",
                            datetime.now(), new_next_run, sched_id
                        )
                        conn.commit()
                    continue

                # --- всегда просим бэкенд собрать превью (с пробросом style_override)
                if send_format in ("chart", "table", "text", "file"):
                    payload = {
                        "template_id": template_id,
                        "format": send_format,
                        "period_type": period_type,
                        "time_of_day": time_of_day_str,
                        "aggregation_type": aggregation_type,
                        "window_minutes": window_minutes,
                        "avg_seconds": avg_seconds,
                        "style_override": style_override or {},
                    }
                    print("[DEBUG] Payload для /telegram/preview:", payload)

                    resp = api_post("/telegram/preview", payload)

                    if not resp:
                        print("[WORKER] Ошибка /telegram/preview: None (network or timeout)")
                    elif not resp.ok:
                        body = resp.text[:500]
                        print(f"[WORKER] Ошибка /telegram/preview: {resp.status_code} {body}")
                    else:
                        result: Dict[str, Any] = {}
                        try:
                            result = resp.json()
                        except Exception as je:
                            print(f"[WORKER] JSON decode error /telegram/preview: {je}, text={resp.text[:500]}")

                        title = (result.get("title") or "").strip()
                        period = result.get("period", {})
                        period_caption = ""
                        if period and period.get("date_from") and period.get("date_to"):
                            period_caption = f"Период: {period['date_from']} — {period['date_to']}"

                        sent_anything = False

                        if send_format == "chart":
                            png_base64 = result.get("chart_png") or result.get("image_base64")
                            if png_base64:
                                image_bytes = base64.b64decode(png_base64) if not png_base64.startswith("data:") else base64.b64decode(png_base64.split(",")[1])
                                caption = title or period_caption
                                send_photo_to_telegram(channel_id, image_bytes, caption, thread_id)
                                sent_anything = True
                            else:
                                # fallback: таблица как текст
                                columns = result.get("columns") or []
                                data = result.get("data") or []
                                if columns and data:
                                    table_text = format_report_table(columns, data, period_caption)
                                    msg = (f"<b>{title}</b>\n" if title else "") + f"<pre>{table_text}</pre>"
                                    send_text_to_telegram(channel_id, msg, thread_id)
                                    sent_anything = True

                        elif send_format in ("table", "text"):
                            table_pngs = result.get("table_pngs") or []
                            if table_pngs:
                                for i, b64 in enumerate(table_pngs):
                                    caption = (title or period_caption) if i == 0 else ""
                                    img_bytes = base64.b64decode(b64) if not b64.startswith("data:") else base64.b64decode(b64.split(",")[1])
                                    send_photo_to_telegram(channel_id, img_bytes, caption, thread_id)
                                sent_anything = True
                            else:
                                text_or_table = result.get("text") or result.get("text_table")
                                if text_or_table:
                                    msg = (f"<b>{title}</b>\n" if title else "") + f"<pre>{text_or_table}</pre>"
                                    if period_caption:
                                        msg += f"\n{period_caption}"
                                    send_text_to_telegram(channel_id, msg, thread_id)
                                    sent_anything = True
                                else:
                                    columns = result.get("columns") or []
                                    data = result.get("data") or []
                                    if columns and data:
                                        table_text = format_report_table(columns, data, period_caption)
                                        msg = (f"<b>{title}</b>\n" if title else "") + f"<pre>{table_text}</pre>"
                                        send_text_to_telegram(channel_id, msg, thread_id)
                                        sent_anything = True

                        elif send_format == "file":
                            # пока отправляем как текст-таблица (Excel ветку можно включить при необходимости)
                            columns = result.get("columns") or []
                            data = result.get("data") or []
                            if columns and data:
                                table_text = format_report_table(columns, data, period_caption)
                                msg = (f"<b>{title}</b>\n" if title else "") + f"<pre>{table_text}</pre>"
                                send_text_to_telegram(channel_id, msg, thread_id)
                                sent_anything = True

                        if not sent_anything:
                            print(f"[WORKER] Предпросмотр вернулся без данных, отправка пропущена (Id={sched_id}).")

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
                            result = (resp.json() if resp else {})
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
                print(f"[WORKER] Ошибка обработки задания (Id={row[0]}): {job_ex}")
                try:
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
