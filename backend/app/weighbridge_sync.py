# app/weighbridge_sync.py

import os
import time
import shutil
import logging
import sqlite3
import subprocess
from datetime import datetime, time as dt_time, timedelta
from typing import List, Tuple, Any

import pyodbc

try:
    from app.config import get_env, get_conn_str
except ImportError:
    from config import get_env, get_conn_str


# ================================================================
#  ЛОГИРОВАНИЕ
# ================================================================
LOG_DIR = get_env("WEIGHBRIDGE_LOG_DIR", "D:\\FactoryIQ\\logs")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    filename=os.path.join(LOG_DIR, "weighbridge_sync.log"),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)


def log(msg: str):
    """Печатает и пишет в лог."""
    print(msg)
    logging.info(msg)


# ================================================================
#  НАСТРОЙКИ
# ================================================================
SOURCE_DB_PATH = get_env("WEIGHBRIDGE_SOURCE")  # UNC
LOCAL_COPY_DIR = get_env("WEIGHBRIDGE_LOCAL_DIR")
LOCAL_COPY_NAME = get_env("WEIGHBRIDGE_LOCAL_COPY", "database.db3")
POLL_INTERVAL = int(get_env("WEIGHBRIDGE_POLL_INTERVAL", "0"))  # seconds

TARGET_TABLE = "dbo.WeighbridgeLog"

UNC_USER = get_env("WEIGHBRIDGE_USER", "scada")
UNC_PASS = get_env("WEIGHBRIDGE_PASS", "mnemic6778")

os.makedirs(LOCAL_COPY_DIR, exist_ok=True)


# ================================================================
#  UNC CONNECT / DISCONNECT
# ================================================================
def connect_unc(path: str):
    """Подключение к сетевой папке с логином/паролем."""
    unc_root = "\\".join(path.split("\\")[:3])

    log(f"Подключение к UNC: {unc_root}")

    try:
        subprocess.run(
            ["net", "use", unc_root, UNC_PASS, f"/user:{UNC_USER}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            shell=True
        )
        log("UNC подключение успешно.")
    except Exception as e:
        log(f"Ошибка UNC connect: {e}")
        raise


def disconnect_unc(path: str):
    """Отключение UNC."""
    unc_root = "\\".join(path.split("\\")[:3])

    log(f"Отключение UNC: {unc_root}")

    try:
        subprocess.run(
            ["net", "use", unc_root, "/delete", "/yes"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            shell=True
        )
        log("UNC отключение выполнено.")
    except Exception as e:
        log(f"Ошибка UNC disconnect: {e}")

def is_work_time() -> bool:
    """Возвращает True, если текущее локальное время в окне 08:00–20:00."""
    now = datetime.now().time()
    start = dt_time(8, 0)
    end = dt_time(21, 0)
    return start <= now < end


def seconds_until_next_work_window() -> int:
    """Сколько секунд спать до следующего окна 08:00–20:00."""
    now = datetime.now()
    today_start = now.replace(hour=8, minute=0, second=0, microsecond=0)
    today_end = now.replace(hour=21, minute=0, second=0, microsecond=0)

    if now < today_start:
        # Ещё не 8 утра — спим до сегодняшних 8:00
        return int((today_start - now).total_seconds())

    if now >= today_end:
        # Уже после 20:00 — спим до завтрашних 8:00
        next_start = today_start + timedelta(days=1)
        return int((next_start - now).total_seconds())

    # В рабочем окне — не должно сюда попадать при нормальном вызове
    return 0


# ================================================================
#  SQL CONNECT
# ================================================================
def sql_conn() -> pyodbc.Connection:
    return pyodbc.connect(get_conn_str())


# ================================================================
#  КОПИРОВАНИЕ SQLITE
# ================================================================
def copy_sqlite_file() -> str:
    """Копирует SQLite файл. Если UNC недоступен — использует локальный fallback."""
    dst = os.path.join(LOCAL_COPY_DIR, LOCAL_COPY_NAME)

    # БЕЗ юникод-стрелки
    log(f"Копирую SQLite: {SOURCE_DB_PATH} -> {dst}")

    try:
        # Первая попытка — UNC
        connect_unc(SOURCE_DB_PATH)
        shutil.copy2(SOURCE_DB_PATH, dst)
        log("SQLite файл успешно скопирован с UNC.")
    except Exception as e:
        log(f"Ошибка копирования через UNC: {e}")

        # Проверяем локальный fallback
        if os.path.exists(dst):
            log(f"Использую локальную копию SQLite (fallback): {dst}")
            return dst
        else:
            log("Локальной копии нет — нечего синхронизировать.")
            raise
    finally:
        # Всё равно попробуем отключиться
        try:
            disconnect_unc(SOURCE_DB_PATH)
        except:
            pass

    return dst



# ================================================================
#  SQLite ЧТЕНИЕ
# ================================================================
def get_last_external_id(conn: pyodbc.Connection) -> int:
    cur = conn.cursor()
    cur.execute(f"SELECT ISNULL(MAX(ExternalId), 0) FROM {TARGET_TABLE};")
    row = cur.fetchone()
    return int(row[0]) if row else 0


def fetch_sqlite_rows(sqlite_path: str, last_id: int) -> List[sqlite3.Row]:
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row

    q = """
        SELECT *
        FROM Weighings
        WHERE id > ?
        ORDER BY id;
    """

    cur = conn.cursor()
    cur.execute(q, (last_id,))
    rows = cur.fetchall()
    conn.close()

    log(f"Найдено новых записей: {len(rows)}")
    return rows


# ================================================================
#  ПРЕОБРАЗОВАНИЕ ДАТЫ
# ================================================================
def parse_date(raw: Any):
    if raw is None:
        return None
    s = str(raw).strip()
    try:
        dt = datetime.fromisoformat(s)
        return dt.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    except:
        return s


# ================================================================
#  МАППИНГ СТРОКИ
# ================================================================
def map_row(r: sqlite3.Row, source_path: str) -> Tuple:
    return (
        r["id"],
        parse_date(r["dateWeight"]),
        r["carNumber"],
        r["carMark"],
        None,
        r["material"],
        r["operationType"],
        r["point1"],
        r["point2"],
        r["consignee"],
        r["consignor"],
        r["brutto"],
        r["carWeight"],
        r["docWeight"],
        r["price"],
        r["adjustment"],
        r["description"],
        r["invoiceNum"],
        r["invoiceNum2"],
        r["talonNum"],
        None,
        None,
        None,
        1 if str(r["edited"]).strip() not in ("0", "", None) else 0,
        r["redactor"],
        r["taraScale"],
        r["fullWeightScale"],
        1 if r["video"] else 0,
        None,
        source_path,
    )


# ================================================================
#  SQL ВСТАВКА
# ================================================================
def bulk_insert(conn: pyodbc.Connection, rows: List[Tuple]):
    if not rows:
        log("Нет строк для вставки в SQL.")
        return

    sql = f"""
        INSERT INTO {TARGET_TABLE} (
            ExternalId, DateWeight, CarNumber, CarMark, ClientName,
            MaterialName, OperationType, PointFrom, PointTo,
            Consignee, Consignor, BruttoKg, TaraKg, DocWeightKg,
            PricePerTon, Adjustment, Comment, InvoiceNum, InvoiceNum2,
            TalonNum, CarrierName, StorageName, UserName, Edited,
            RedactorName, TaraScaleName, FullScaleName, HasVideo,
            VideoInfo, SourceFilePath
        )
        VALUES (
            ?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?
        )
    """

    cur = conn.cursor()
    try:
        cur.executemany(sql, rows)
        conn.commit()
        log(f"Вставлено в SQL: {len(rows)} записей")
    except pyodbc.ProgrammingError as e:
        conn.rollback()
        log(f"Ошибка executemany: {e}. Пробую вставить по одной строке...")
        ok, fail = 0, 0
        for r in rows:
            try:
                cur.execute(sql, r)
                ok += 1
            except pyodbc.ProgrammingError as e_row:
                fail += 1
                logging.error("Проблемная строка: %r; ошибка: %s", r, e_row)
        conn.commit()
        log(f"Поодиночной вставкой: ok={ok}, fail={fail}")
    finally:
        cur.close()

    # отдельный курсор под очистку
    try:
        cur2 = conn.cursor()
        cur2.execute("EXEC dbo.CleanWeighbridgeLog;")
        conn.commit()
        log("Очистка данных (CleanWeighbridgeLog) выполнена.")
    except Exception as e:
        log(f"Ошибка очистки данных: {e}")
    finally:
        try:
            cur2.close()
        except Exception:
            pass


# ================================================================
#  ОСНОВНОЙ ПРОЦЕСС
# ================================================================
def sync_once():
    log("=== Воркер весовой запущен ===")

    # 1. Копирование SQLite с UNC
    try:
        sqlite_copy = copy_sqlite_file()
    except Exception as e:
        # Весовая/сеть недоступна — просто логируем и выходим из этой итерации
        log(f"Синхронизация прервана: не удалось скопировать SQLite: {e}")
        return

    # 2. Работа с SQL
    conn = sql_conn()
    try:
        last_id = get_last_external_id(conn)
        log(f"Последний ExternalId в SQL: {last_id}")

        rows = fetch_sqlite_rows(sqlite_copy, last_id)
        mapped = [map_row(r, SOURCE_DB_PATH) for r in rows]

        bulk_insert(conn, mapped)

    finally:
        conn.close()

    log("=== Синхронизация успешно завершена ===")


def run_service_mode():
    log(f"Сервисный режим: интервал {POLL_INTERVAL} сек, рабочее окно 08:00–20:00")
    while True:
        if is_work_time():
            try:
                sync_once()
            except Exception as e:
                # Любая ошибка внутри — логируем и продолжаем, но воркер живой
                log(f"Ошибка в sync_once (игнорирую, повторю позже): {e}")
            # обычный интервал между попытками в рабочее время
            time.sleep(POLL_INTERVAL)
        else:
            # Вне рабочего времени — спим до следующего окна
            sleep_sec = seconds_until_next_work_window()
            log(f"Сейчас вне рабочего окна (08:00–20:00). Спим {sleep_sec} сек до следующей попытки...")
            time.sleep(sleep_sec)


if __name__ == "__main__":
    log("Воркер весовой стартует...")
    if POLL_INTERVAL > 0:
        run_service_mode()
    else:
        sync_once()
