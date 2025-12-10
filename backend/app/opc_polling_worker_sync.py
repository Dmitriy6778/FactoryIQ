# app/opc_polling_worker_sync.py
# -*- coding: utf-8 -*-
"""
OPC UA подписочный воркер с:
- конечными ретраями при подключении к БД (общий дедлайн);
- таймаутами ODBC на уровне соединения + SET LOCK_TIMEOUT;
- пачечной вставкой в БД с нарезкой на чанки;
- файловым спулом на случай недоступности БД (персистентный кэш);
- watchdog по тишине OPC UA потока с форс-реконнектом;
- мягким обращением с транзиентными ошибками SQL (shutdown/only admin/недоступен);
- heartbeat чтением системного узла OPC UA (ServerStatus.CurrentTime) для «разбудки» тишины.
- DEADMAN-контролем по отсутствию новых данных в течение DEADMAN_TIMEOUT_SEC:
  при превышении порога процесс завершает работу (os._exit),
  что позволяет службе Windows автоматически перезапустить его.

ВАЖНО:
- Кэш на случай потери связи с БД хранится в папке SPOOL_DIR (по умолчанию ./spool).
- В памяти хранятся SubBuffer (очередь на запись) и last_value_by_tid (анти-дубль).
"""

import os
import sys
import time
import json
import uuid
import random
import threading
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime, timezone
from typing import List, Dict, Tuple, Any, Optional

import pyodbc
from dotenv import load_dotenv
from cryptography.fernet import Fernet
from opcua import Client, ua

from config import get_conn_str, get_env
import socket
from urllib.parse import urlparse
from collections import deque
from threading import Lock
from pathlib import Path


load_dotenv()

# ========= Константы/настройки =========
DEFAULT_CERT_PATH = os.path.abspath("app/client.pem")
DEFAULT_KEY_PATH  = os.path.abspath("app/client_private.pem")
BASE_DIR = Path(__file__).resolve().parent

OPC_TIMEOUT_SEC            = int(get_env("OPC_TIMEOUT_SEC", "15"))
BATCH_SIZE                 = int(get_env("BATCH_SIZE", "500"))           # мягкий лимит пачки (RAM-буфер)
TAGMAP_REFRESH_SEC         = int(get_env("TAGMAP_REFRESH_SEC", "300"))   # как часто обновлять кэш/список тегов
LOG_DIR                    = get_env("LOG_DIR", "logs")
LOG_LEVEL                  = get_env("LOG_LEVEL", "INFO").upper()
FLUSH_MAX_SEC              = float(get_env("FLUSH_MAX_SEC", "2.0"))      # макс. задержка перед сбросом RAM-пачки
SUB_QUEUE_SIZE             = int(get_env("SUB_QUEUE_SIZE", "10"))        # глубина очереди на сервере

# LIVENESS (увеличено по умолчанию, можно вернуть 60)
LIVENESS_DEAD_SEC          = int(get_env("LIVENESS_DEAD_SEC", "120"))    # если нет событий > N с — реконнект

# анти-дубликатор
CHANGE_EPSILON_ABS         = float(get_env("CHANGE_EPSILON_ABS", "0"))
CHANGE_EPSILON_REL         = float(get_env("CHANGE_EPSILON_REL", "0"))
DISABLE_DEDUP              = get_env("DISABLE_DEDUP", "0").strip() in ("1", "true", "True")

# использовать «маршрутизаторный» коннектор (как в backend/app/routers/db.py) — не применяется тут, но оставлено
USE_DB_ROUTES_CONN         = get_env("USE_DB_ROUTES_CONN", "0").strip() in ("1", "true", "True")

# файловый спул (локальный персистентный буфер)
SPOOL_DIR = Path(get_env("SPOOL_DIR", str(BASE_DIR / "spool"))).resolve()
SPOOL_SYNC_INTERVAL_SEC    = int(get_env("SPOOL_SYNC_INTERVAL_SEC", "5"))  # период попытки реплея файлов (сек)
SPOOL_FILE_PREFIX          = "opc_spool"
SPOOL_FILE_SUFFIX          = ".ndjson"

# Таймауты БД (сек)
ODBC_LOGIN_TIMEOUT_SEC     = int(get_env("ODBC_LOGIN_TIMEOUT_SEC", "30"))   # логин-таймаут
ODBC_QUERY_TIMEOUT_SEC     = int(get_env("ODBC_QUERY_TIMEOUT_SEC", "5"))   # таймаут на execute/commit (на уровне conn)
DB_CONNECT_MAX_WAIT_SEC    = int(get_env("DB_CONNECT_MAX_WAIT_SEC", "20")) # общий дедлайн на попытки коннекта

# Вставка чанками в БД
DB_INSERT_CHUNK_SIZE       = int(get_env("DB_INSERT_CHUNK_SIZE", "1000"))

# Новые параметры управления частотой опросов и heartbeat
IS_ACTIVE_POLL_SEC           = float(get_env("IS_ACTIVE_POLL_SEC", "2"))
HEARTBEAT_PERIOD_SEC         = float(get_env("HEARTBEAT_PERIOD_SEC", "20"))
HEARTBEAT_NODE               = get_env("HEARTBEAT_NODE", "i=2258")  # ServerStatus.CurrentTime
HEARTBEAT_FAILS_FOR_RECONNECT= int(get_env("HEARTBEAT_FAILS_FOR_RECONNECT", "3"))

# DEADMAN-контроль: если нет "жизни данных" дольше DEADMAN_TIMEOUT_SEC — жёсткий выход процесса
DEADMAN_TIMEOUT_SEC          = int(get_env("DEADMAN_TIMEOUT_SEC", "300"))   # по умолчанию 5 минут
DEADMAN_CHECK_PERIOD_SEC     = int(get_env("DEADMAN_CHECK_PERIOD_SEC", "30"))

THREAD_REGISTRY = {}
THREAD_REGISTRY_LOCK = Lock()

FERNET_KEY = os.getenv("FERNET_KEY")
if not FERNET_KEY:
    raise RuntimeError("FERNET_KEY not set in environment!")
fernet = Fernet(FERNET_KEY.encode())

# Глобальные отметки активности по данным (для DEADMAN)
LAST_DATA_TS = time.time()
LAST_DATA_LOCK = Lock()


def mark_data_activity() -> None:
    """
    Отмечает факт "живой" активности по данным:
    - пришло новое значение по подписке (попало в RAM-буфер);
    - успешно записали пачку в БД (db_exec_batch / SPOOL replay).
    DEADMAN смотрит только на этот таймштамп.
    """
    global LAST_DATA_TS
    with LAST_DATA_LOCK:
        LAST_DATA_TS = time.time()


# ========= Логирование =========
def init_logger() -> logging.Logger:
    os.makedirs(LOG_DIR, exist_ok=True)
    logger = logging.getLogger("opc_worker")
    logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

    fmt = logging.Formatter(
        fmt="%(asctime)s | %(levelname)s | %(threadName)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )

    fh = RotatingFileHandler(os.path.join(LOG_DIR, "opc_worker.log"),
                             maxBytes=10 * 1024 * 1024, backupCount=10, encoding="utf-8")
    fh.setFormatter(fmt)
    fh.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
    logger.addHandler(fh)

    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    ch.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
    logger.addHandler(ch)

    logger.propagate = False
    return logger

log = init_logger()
log.info("SPOOL_DIR resolved to: %s", SPOOL_DIR)

# (не обязательно, но можно снизить шум от внутренних логов библиотеки)
logging.getLogger("opcua").setLevel(logging.ERROR)

# ========= DEADMAN loop =========
def deadman_loop(stop_event: threading.Event):
    """
    Расширенный DEADMAN:
    1) Контролирует отсутствие data-активности (как раньше).
    2) Дополнительно следит за смертью SUB-потоков.
    При любом сбое выполняет os._exit(), чтобы Windows Service перезапустил процесс.
    """

    threading.current_thread().name = "deadman"
    log.info(
        "DEADMAN: enabled (timeout=%ss, check_period=%ss)",
        DEADMAN_TIMEOUT_SEC, DEADMAN_CHECK_PERIOD_SEC
    )

    while not stop_event.is_set():
        try:
            now = time.time()

            # === 1. Проверка активности данных ===
            with LAST_DATA_LOCK:
                diff = now - LAST_DATA_TS

            if diff > DEADMAN_TIMEOUT_SEC:
                log.critical(
                    "DEADMAN: no data activity for %.1f seconds (> %s) -> hard exit for service restart",
                    diff, DEADMAN_TIMEOUT_SEC
                )
                os._exit(2)

            # === 2. Проверка состояния потоков подписки ===
            with THREAD_REGISTRY_LOCK:
                dead_threads = [
                    tid for tid, th in THREAD_REGISTRY.items()
                    if not th.is_alive()
                ]

            if dead_threads:
                log.critical(
                    "DEADMAN: detected dead OPC SUB threads: %s -> hard exit",
                    dead_threads
                )
                os._exit(3)

        except Exception as ex:
            log.error("DEADMAN loop error: %r", ex, exc_info=True)

        time.sleep(DEADMAN_CHECK_PERIOD_SEC)



# ========= Утилиты диагностики БД =========
def is_transient_db_down(ex: Exception) -> bool:
    """Ожидаемые состояния при рестарте/остановке SQL Server."""
    s = str(ex).lower()
    needles = [
        "(6005)",           # shutdown in progress
        "(596)",            # session is ending
        "(18451)",          # only admin connections allowed
        "only administrators",
        "только администраторы",
        "named pipes provider",
        "сервер не найден",
        "время ожидания входа",
        "server was not found",
        "could not open a connection",
    ]
    return any(n in s for n in needles)

# ========= Файловый спул =========
class FileSpool:
    """
    Персистентный буфер (кэш на диске) для неуспешных вставок в БД.
    Усиленный:
    - гарантированное создание каталога на каждом вызове;
    - автоматическое восстановление каталога при удалении или блокировке;
    - повторная попытка записи;
    - безопасная обработка ошибок, чтобы не "убить" поток SUB.
    """

    def __init__(self, base_dir: Path):
        self.dir = base_dir
        self.lock = Lock()
        self._ensure_dir()

    def _ensure_dir(self):
        """Гарантирует существование каталога."""
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
        except Exception as ex:
            log.critical("SPOOL: cannot create directory %s: %r", self.dir, ex)

    def _safe_open(self, fpath: Path):
        """Пытается открыть файл безопасно, с восстановлением каталога."""
        try:
            return open(fpath, "w", encoding="utf-8")
        except FileNotFoundError:
            log.error("SPOOL: directory missing, recreating...")
            self._ensure_dir()
            return open(fpath, "w", encoding="utf-8")

    def dump_batch(self, task_id: int, rows: List[Tuple[int, float, datetime, str]]) -> Optional[Path]:
        if not rows:
            return None

        self._ensure_dir()

        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
        fname = f"{SPOOL_FILE_PREFIX}_task{task_id}_{ts}_{uuid.uuid4().hex}{SPOOL_FILE_SUFFIX}"
        fpath = self.dir / fname

        payload = []
        for tid, val, dt, st in rows:
            iso = dt.isoformat() if isinstance(dt, datetime) else str(dt)
            payload.append(json.dumps(
                {"TagId": int(tid), "Value": float(val), "Timestamp": iso, "Status": str(st)},
                ensure_ascii=False
            ))

        try:
            with self.lock:
                with self._safe_open(fpath) as f:
                    f.write("\n".join(payload))

            log.warning("SPOOL: batch persisted -> %s (rows=%d)", fpath.name, len(rows))
            return fpath

        except Exception as ex:
            log.critical("SPOOL: FAILED to write batch even after recovery: %r", ex, exc_info=True)
            return None

    def list_ready_files(self) -> List[Path]:
        self._ensure_dir()
        with self.lock:
            return sorted(self.dir.glob(f"{SPOOL_FILE_PREFIX}_*{SPOOL_FILE_SUFFIX}"))
    def read_file_rows(self, fpath: Path) -> List[Tuple[int, float, datetime, str]]:
        """
        Читает .ndjson файл спула и возвращает список кортежей:
        (TagId, Value, Timestamp, Status).
        """
        rows: List[Tuple[int, float, datetime, str]] = []

        try:
            with self.lock:
                with open(fpath, "r", encoding="utf-8") as f:
                    for line in f:
                        if not line.strip():
                            continue
                        try:
                            obj = json.loads(line)
                            tid = int(obj["TagId"])
                            val = float(obj["Value"])
                            ts  = obj["Timestamp"]
                            # timestamp может быть строкой — конвертим:
                            if isinstance(ts, str):
                                try:
                                    ts = datetime.fromisoformat(ts)
                                except Exception:
                                    ts = datetime.utcnow()
                            status = str(obj.get("Status", "Good"))
                            rows.append((tid, val, ts, status))
                        except Exception as ex:
                            log.error("SPOOL: bad line in %s -> %r", fpath.name, ex)
                            continue
        except Exception as ex:
            log.error("SPOOL: read_file_rows error: %r", ex, exc_info=True)

        return rows


SPOOL = FileSpool(SPOOL_DIR)

def sanitize_spool_directory():
    """Удаляет битые, пустые и устаревшие spool-файлы."""
    try:
        SPOOL._ensure_dir()
        now = time.time()
        bad_dir = SPOOL.dir / "bad"
        bad_dir.mkdir(exist_ok=True)

        for f in SPOOL.dir.glob("*.ndjson"):
            # Skip folders
            if not f.is_file():
                continue

            # Удаляем пустые файлы
            if f.stat().st_size == 0:
                log.warning("SPOOL SANITIZE: removing empty file %s", f)
                f.unlink(missing_ok=True)
                continue

            # Удаляем слишком старые файлы (например > 24ч)
            if now - f.stat().st_mtime > 24*3600:
                log.warning("SPOOL SANITIZE: moving stale file to bad/: %s", f.name)
                f.rename(bad_dir / f.name)
                continue

            # Проверка JSON-валидности первых строк
            try:
                with open(f, "r", encoding="utf-8") as ff:
                    for i in range(5):  # проверяем первые 5 записей
                        line = ff.readline()
                        if not line:
                            break
                        json.loads(line)
            except Exception:
                log.error("SPOOL SANITIZE: corrupted file -> moving to bad/: %s", f.name)
                f.rename(bad_dir / f.name)

    except Exception as ex:
        log.error("SPOOL SANITIZE error: %r", ex, exc_info=True)


def reconnect(conn_ref: list) -> bool:
    try:
        if conn_ref[0]:
            try:
                conn_ref[0].close()
            except Exception:
                pass
        conn_ref[0] = db_connect(max_wait_sec=DB_CONNECT_MAX_WAIT_SEC, autocommit=False)
        log.warning("DB: reconnected")
        return True
    except Exception as ex:
        if is_transient_db_down(ex):
            log.warning("DB: reconnect postponed (transient): %s", ex)
        else:
            log.error("DB: reconnect failed (non-transient): %r", ex, exc_info=True)
        return False

def spool_replay_loop(stop_event: threading.Event):
    """Фоновый реплей спула. Используем конечный db_connect(...), чтобы не зависнуть навсегда."""
    threading.current_thread().name = "spool-replay"
    while not stop_event.is_set():
        try:
            files = SPOOL.list_ready_files()
            if not files:
                time.sleep(SPOOL_SYNC_INTERVAL_SEC)
                continue

            try:
                conn = db_connect(max_wait_sec=DB_CONNECT_MAX_WAIT_SEC, autocommit=False)
            except Exception as ex:
                if is_transient_db_down(ex):
                    log.warning("SPOOL: DB down — postpone replay")
                else:
                    log.error("SPOOL: DB connect failed (non-transient): %r", ex, exc_info=True)
                time.sleep(SPOOL_SYNC_INTERVAL_SEC)
                continue

            for f in files:
                rows = SPOOL.read_file_rows(f)
                if not rows:
                    try: f.unlink(missing_ok=True)
                    except Exception: pass
                    continue
                try:
                    db_exec_batch(conn, rows)
                    # успешная запись старых данных в БД — тоже "жизнь"
                    mark_data_activity()
                    try: f.unlink(missing_ok=True)
                    except Exception: pass
                    log.info("SPOOL: replay OK -> %s (rows=%d)", f.name, len(rows))
                except Exception as ex:
                    if is_transient_db_down(ex):
                        log.warning("SPOOL: DB transient during replay -> will retry later")
                    else:
                        log.error("SPOOL: replay failed for %s: %r", f.name, ex, exc_info=True)
                    break
            try: conn.close()
            except Exception: pass
        except Exception as loop_ex:
            log.error("SPOOL: loop error: %r", loop_ex, exc_info=True)
        time.sleep(SPOOL_SYNC_INTERVAL_SEC)

# ========= Утилиты =========
def _parse_host_port(opc_url: str) -> tuple[str, int]:
    try:
        u = urlparse(opc_url)
        host = u.hostname or ""
        port = u.port or 4840
        if not host:
            s = opc_url.split("://", 1)[-1]
            if ":" in s:
                host, p = s.rsplit(":", 1)
                port = int(p)
            else:
                host = s
        return host, int(port)
    except Exception:
        return ("", 4840)

def _tcp_probe(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception as e:
        log.error("TCP probe failed: %s:%s -> %r", host, port, e)
        return False

def safe_float(val: Any) -> Optional[float]:
    try:
        if val is None:
            return None
        if isinstance(val, bool):
            return 1.0 if val else 0.0
        if isinstance(val, (int, float)):
            return float(val)
        s = str(val).strip()
        if s == "" or s.lower() in ("nan", "inf", "-inf", "none", "null"):
            return None
        s = s.replace(" ", "").replace("\u00A0", "").replace(",", ".")
        return float(s)
    except Exception:
        return None

def extract_numeric_from_datavalue(dv: ua.DataValue) -> Optional[float]:
    try:
        raw = getattr(dv, "Value", None)
        if hasattr(raw, "Value"):
            raw = raw.Value
        if isinstance(raw, (list, tuple, bytes, bytearray, dict)):
            return None
        return safe_float(raw)
    except Exception:
        return None

def norm_policy(name: Optional[str]) -> str:
    if not name:
        return "None"
    n = name.strip().lower()
    if n in ("", "none"):
        return "None"
    if n in ("basic256sha256", "basic256_sha256", "basic256-sha256"):
        return "Basic256Sha256"
    if n == "basic256":
        return "Basic256"
    if n in ("basic128rsa15", "basic128_rsa15"):
        return "Basic128Rsa15"
    if n in ("aes128_sha256_rsaoaep", "aes128"):
        return "Aes128_Sha256_RsaOaep"
    if n in ("aes256_sha256_rsapss", "aes256"):
        return "Aes256_Sha256_RsaPss"
    return "None"

def norm_mode(name: Optional[str]) -> str:
    if not name:
        return "None"
    n = name.strip().lower()
    if n == "sign":
        return "Sign"
    if n in ("signandencrypt", "sign_and_encrypt"):
        return "SignAndEncrypt"
    return "None"

# рядом с has_changed
def _quantize(x: float, q: float) -> float:
    return round(x / q) * q if q > 0 else x

def has_changed(prev: Optional[float], new: float) -> bool:
    if DISABLE_DEDUP:
        return True
    if prev is None:
        return True

    # сглаживаем дребезг плавающей точки перед сравнением
    q = CHANGE_EPSILON_ABS if CHANGE_EPSILON_ABS > 0 else 0.0
    if q > 0:
        prev_cmp = _quantize(prev, q)
        new_cmp  = _quantize(new,  q)
        diff = abs(new_cmp - prev_cmp)
    else:
        diff = abs(new - prev)

    if CHANGE_EPSILON_ABS > 0 and diff <= CHANGE_EPSILON_ABS:
        return False
    if CHANGE_EPSILON_REL > 0 and abs(prev) > 0:
        if diff <= abs(prev) * CHANGE_EPSILON_REL:
            return False
    return diff > 0


def ensure_login_timeout(cs: str, login_timeout: int) -> str:
    """
    Вставляет 'Login Timeout=<sec>' в строку подключения, если его там нет.
    Также добавляем TrustServerCertificate=yes, Encrypt=no (если не задано).
    """
    low = cs.lower()
    parts = cs.rstrip(";")
    if "login timeout=" not in low:
        parts += f";Login Timeout={login_timeout}"
    if "trustservercertificate=" not in low:
        parts += ";TrustServerCertificate=yes"
    if "encrypt=" not in low:
        parts += ";Encrypt=no"
    return parts

def _mask_conn_str(cs: str) -> str:
    parts = []
    for part in cs.split(";"):
        if not part:
            continue
        k, *rest = part.split("=", 1)
        if not rest:
            parts.append(part)
            continue
        v = rest[0]
        kl = k.strip().lower()
        if kl in ("pwd", "password"):
            v = "***"
        parts.append(f"{k}={v}")
    return ";".join(parts)

# ========= Работа с БД =========
def _apply_session_settings(conn: pyodbc.Connection):
    try:
        cur = conn.cursor()
        # принудительный USE нужной БД
        must_db = os.getenv("FORCE_DATABASE")
        if must_db:
            cur.execute(f"USE [{must_db}]")
        # таймаут блокировок
        cur.execute(f"SET LOCK_TIMEOUT {int(ODBC_QUERY_TIMEOUT_SEC) * 1000};")
        # для @@ROWCOUNT и предсказуемости
        cur.execute("SET NOCOUNT OFF; SET XACT_ABORT ON;")
    except Exception as ex:
        log.warning("DB: failed to apply session settings: %r", ex)


def db_connect(max_wait_sec: int = DB_CONNECT_MAX_WAIT_SEC, autocommit: bool = False) -> pyodbc.Connection:
    """
    Конечные ретраи подключения к БД с общим дедлайном, чтобы не зависнуть навсегда.
    Используем conn.timeout + SET LOCK_TIMEOUT (без cursor.timeout).
    """
    deadline = time.time() + max_wait_sec
    backoff = 2
    last_ex = None
    while time.time() < deadline:
        try:
            cs = get_conn_str()
            cs = ensure_login_timeout(cs, ODBC_LOGIN_TIMEOUT_SEC)
            log.debug("DB conn(get_conn_str): %s", _mask_conn_str(cs))
            conn = pyodbc.connect(cs)               # login timeout из cs
            conn.autocommit = autocommit
            conn.timeout = ODBC_QUERY_TIMEOUT_SEC    # таймаут для всех execute/commit в этой сессии

            _apply_session_settings(conn)

            cur = conn.cursor()
            log.debug("DB exec: SELECT DB_NAME() start")
            cur.execute("SELECT DB_NAME()")
            active = cur.fetchone()[0]
            log.info("DB: active database: [%s]", active)
            return conn
        except Exception as ex:
            last_ex = ex
            if is_transient_db_down(ex):
                log.warning("DB connect() transient: %s (retry in %ss)", ex, backoff)
            else:
                log.error("DB connect() failed (retry in %ss): %r", backoff, ex)
            time.sleep(backoff + random.uniform(0, 0.75))
            backoff = min(backoff * 2, 10)
    raise RuntimeError(f"DB connect timeout after {max_wait_sec}s: {last_ex!r}")

def get_task_tags(conn: pyodbc.Connection, polling_task_id: int):
    sql = """
        SELECT t.Id,
               LTRIM(RTRIM(t.NodeId))    AS NodeId,
               t.BrowseName,
               t.DataType
        FROM dbo.PollingTaskTags pt
        JOIN dbo.OpcTags t
          ON pt.tag_id = t.Id
        WHERE pt.polling_task_id = ?
    """
    cur = conn.cursor()
    log.debug("DB exec: get_task_tags start (task_id=%s)", polling_task_id)
    cur.execute(sql, polling_task_id)
    rows = cur.fetchall()
    log.debug("DB exec: get_task_tags done (rows=%s)", len(rows))
    return rows

def load_last_values(conn: pyodbc.Connection, tag_ids: List[int]) -> Dict[int, float]:
    if not tag_ids:
        return {}
    chunk = 900
    result: Dict[int, float] = {}
    for i in range(0, len(tag_ids), chunk):
        part = tag_ids[i:i+chunk]
        placeholders = ",".join("?" for _ in part)
        sql = f"""
        ;WITH x AS (
            SELECT TagId, Value, [Timestamp],
                   ROW_NUMBER() OVER (PARTITION BY TagId ORDER BY [Timestamp] DESC) rn
            FROM dbo.OpcData
            WHERE TagId IN ({placeholders})
        )
        SELECT TagId, Value FROM x WHERE rn = 1
        """
        cur = conn.cursor()
        log.debug("DB exec: load_last_values chunk start (%s ids)", len(part))
        cur.execute(sql, part)
        for tid, val in cur.fetchall():
            f = safe_float(val)
            if f is not None:
                result[int(tid)] = f
        log.debug("DB exec: load_last_values chunk done")
    return result

def db_exec_batch(conn: pyodbc.Connection, rows: List[Tuple[int, float, datetime, str]]):
    if not rows:
        return

    verify_mode = (os.getenv("VERIFY_WRITES", "count") or "count").lower()  # off|count|strict
    verify_cap  = int(os.getenv("VERIFY_MAX_ROWS", "5000"))

    cur = conn.cursor()
    # Базовые сессионные настройки для предсказуемого @@ROWCOUNT
    try:
        cur.execute("SET XACT_ABORT ON; SET NOCOUNT OFF;")
    except Exception:
        pass

    # Лёгкая телеметрия
    preview = rows[:3]
    dbname = "<unknown>"
    try:
        cur.execute("SELECT DB_NAME()")
        dbname = cur.fetchone()[0]
    except Exception:
        pass

    log.info("DB: executemany INSERT %d rows (db=%s, preview=%s)",
             len(rows), dbname,
             [(r[0], r[1], r[2].isoformat() if isinstance(r[2], datetime) else r[2], r[3]) for r in preview])

    total_inserted = 0
    try:
        cur = conn.cursor()

        # Режем на чанки и считаем фактические вставки через @@ROWCOUNT
        for i in range(0, len(rows), DB_INSERT_CHUNK_SIZE):
            part = rows[i:i+DB_INSERT_CHUNK_SIZE]
            cur.fast_executemany = True
            retry = 0
            max_retry = 3

            while True:
                try:
                    cur.fast_executemany = True
                    
                    break  # success

                except pyodbc.OperationalError as ex:
                    if retry < max_retry:
                        log.warning("DB INSERT retry %d/%d due to %r", retry+1, max_retry, ex)
                        retry += 1
                        time.sleep(0.2 * retry)
                        continue
                    raise ex
            cur.executemany(
                "INSERT INTO dbo.OpcData (TagId, Value, [Timestamp], [Status]) VALUES (?, ?, ?, ?)",
                part
            )
            # Сразу считаем, сколько реально попало в таблицу
            cur.execute("SELECT @@ROWCOUNT")
            chunk_count = int(cur.fetchone()[0] or 0)
            total_inserted += chunk_count

        conn.commit()
        log.info("DB: commit OK, inserted_rows_reported=%d, expected=%d",
                 total_inserted, len(rows))

        # успешная запись — явно помечаем активность данных
        if total_inserted > 0:
            mark_data_activity()

        # Быстрый “count-check”
        if verify_mode in ("count", "strict") and total_inserted < len(rows):
            log.error("DB VERIFY(count): mismatch inserted=%d < expected=%d",
                      total_inserted, len(rows))

        # Строгая проверка: находим недописанные строки (в пределах VERIFY_MAX_ROWS)
        if verify_mode == "strict":
            sample = rows if len(rows) <= verify_cap else rows[-verify_cap:]
            # создаём temp-таблицу и сравниваем
            cur.execute("""
                IF OBJECT_ID('tempdb..#tmp_opc') IS NOT NULL DROP TABLE #tmp_opc;
                CREATE TABLE #tmp_opc (
                    TagId INT NOT NULL,
                    Value FLOAT NULL,
                    [Timestamp] DATETIME NOT NULL,
                    [Status] NVARCHAR(64) NULL
                );
            """)
            cur.fast_executemany = True
            cur.executemany("INSERT INTO #tmp_opc(TagId, Value, [Timestamp], [Status]) VALUES (?, ?, ?, ?)", sample)

            # Ищем строки из #tmp_opc, которых нет в целевой таблице (по точному совпадению ключевых полей)
            cur.execute("""
                SELECT t.TagId, t.[Timestamp], t.Value
                FROM #tmp_opc t
                EXCEPT
                SELECT d.TagId, d.[Timestamp], d.Value
                FROM dbo.OpcData d
            """)
            missing = cur.fetchall()
            if missing:
                log.critical("DB VERIFY(strict): %d rows from sample not found in dbo.OpcData (showing up to 5): %s",
                             len(missing), [(m[0], m[1], m[2]) for m in missing[:5]])
                # Сохраним “недошедшие” в спул для повторной попытки
                SPOOL.dump_batch(task_id=0, rows=sample)  # task_id=0 как общий канал
        return

    except Exception as ex:
        # Откат и стандартная логика повтора уже реализованы выше, оставим как есть
        try: conn.rollback()
        except Exception: pass
        raise


# ========= OPC UA: утилиты NodeId =========
def clean_nodeid(n: Optional[str]) -> str:
    if not n:
        return ""
    s = str(n)
    s = ''.join(ch for ch in s if ord(ch) >= 32).replace('\u00A0', ' ').strip()
    trans = {
        ord('“'): ord('"'), ord('”'): ord('"'), ord('‟'): ord('"'),
        ord('′'): ord("'"), ord('’'): ord("'"), ord('‚'): ord("'"),
        ord('‛'): ord("'"), ord('`'): ord("'"), ord('´'): ord("'"),
        ord('ˮ'): ord('"'), ord('ʼ'): ord("'"),
    }
    s = s.translate(trans).strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        s = s[1:-1].strip()
    return s.strip()

class SubBuffer:
    """Памятная очередь неизданных строк перед сбросом в БД (RAM-кэш)."""
    def __init__(self, batch_size: int):
        self.batch_size = batch_size
        self.q: deque[Tuple[int, float, datetime, str]] = deque()
        self.lock = Lock()
        self.last_flush = time.time()

    def push(self, row: Tuple[int, float, datetime, str]) -> int:
        with self.lock:
            self.q.append(row)
            return len(self.q)

    def need_flush(self) -> bool:
        with self.lock:
            return len(self.q) >= self.batch_size or (time.time() - self.last_flush) >= FLUSH_MAX_SEC

    def drain(self) -> List[Tuple[int, float, datetime, str]]:
        with self.lock:
            rows = list(self.q)
            self.q.clear()
            self.last_flush = time.time()
            return rows

# ========= Handler подписки =========
class SubHandler(object):
    """Обработчик входящих событий OPC UA."""
    def __init__(self, tag_id_map: Dict[str, int], last_value_by_tid: Dict[int, float], buf: SubBuffer):
        self.tag_id_map = tag_id_map
        self.last_value_by_tid = last_value_by_tid
        self.buf = buf
        self.last_event_ts = time.time()

    def datachange_notification(self, node, val, data):
        try:
            # Определяем NodeId и TagId
            try:
                nid = node.nodeid.to_string()
            except Exception:
                nid = str(getattr(node, "nodeid", ""))
            tid = self.tag_id_map.get(nid)
            if not tid:
                return

            # Приводим к числу
            fval = safe_float(val)
            if fval is None:
                return

            # Квантование по абсолютному эпсилону (если задан)
            qval = _quantize(fval, CHANGE_EPSILON_ABS) if CHANGE_EPSILON_ABS > 0 else fval

            # Антидубль: сравнение с предыдущим уже в том же масштабе
            prev = self.last_value_by_tid.get(tid)
            if not has_changed(prev, qval):
                return

            # Статус best-effort
            status = "Good"
            try:
                mi = getattr(data, "monitored_item", None)
                if mi is not None and hasattr(mi, "Value"):
                    status = str(mi.Value.StatusCode)
            except Exception:
                pass

            # Локальное время (Астана +5) без tzinfo
            try:
                tz_offset = timezone(datetime.now().astimezone().utcoffset())
            except Exception:
                tz_offset = timezone.utc
            ts = datetime.now(tz_offset).replace(tzinfo=None)

            # Обновляем кэш и добавляем строку в буфер
            self.last_value_by_tid[tid] = qval
            n = self.buf.push((tid, qval, ts, "Good" if "Good" in status else status))
            self.last_event_ts = time.time()

            # Любое новое значение — считаем живой активностью по данным
            mark_data_activity()

            if n % 2000 == 0:
                log.info("SubBuffer size=%d (task stream)", n)

        except Exception as ex:
            log.error("SubHandler error: %r", ex, exc_info=True)

    # Если библиотека шлёт статусные keepalive — учитываем как активность
    def status_change_notification(self, status):
        self.last_event_ts = time.time()


def subscribe_data_change_compat(sub, nodes, si_ms: float, qsize: int):
    """Совместимый со старыми/новыми версиями python-opcua вызов subscribe_data_change."""
    try:
        return sub.subscribe_data_change(
            nodes, attr=ua.AttributeIds.Value,
            queuesize=qsize, monitoring=ua.MonitoringMode.Reporting,
            sampling_interval=si_ms
        )
    except TypeError:
        pass
    try:
        return sub.subscribe_data_change(
            nodes, attr=ua.AttributeIds.Value,
            queuesize=qsize, sampling_interval=si_ms
        )
    except TypeError:
        pass
    try:
        return sub.subscribe_data_change(
            nodes, attr=ua.AttributeIds.Value,
            queue_size=qsize, sampling_interval=si_ms
        )
    except TypeError:
        pass
    try:
        return sub.subscribe_data_change(nodes, attr=ua.AttributeIds.Value)
    except TypeError:
        return sub.subscribe_data_change(nodes)

# ========= Подписочный воркер для одной задачи =========
def poll_task_sub(task_id: int,
                  server_url: str,
                  tag_nodeids: List[str],
                  interval_seconds: int,
                  stop_event: threading.Event,
                  username: str,
                  password: str,
                  security_policy: str,
                  security_mode: str):

    threading.current_thread().name = f"opc-sub-{task_id}"
    backoff = 5
    notified_stop = False

    client_cert_path = os.getenv("OPC_CLIENT_CERT", DEFAULT_CERT_PATH)
    client_key_path  = os.getenv("OPC_CLIENT_KEY",  DEFAULT_KEY_PATH)

    # БД
    conn_ref = [ db_connect(max_wait_sec=DB_CONNECT_MAX_WAIT_SEC, autocommit=False) ]
    conn = conn_ref[0]

    # текущее состояние
    tag_id_map: Dict[str, int] = {}
    last_value_by_tid: Dict[int, float] = {}
    node_handle_by_id: Dict[str, int] = {}  # NodeId -> handle
    subscribed_nodeids: set[str] = set()

    # буфер вставки
    buf = SubBuffer(BATCH_SIZE)

    log.info("Task #%s -> SUBSCRIBE %s (policy=%s, mode=%s, user=%s)",
             task_id, server_url, security_policy, security_mode, "<set>" if username else "anonymous")

    def refresh_map_and_sub(client: Client, sub, handler: SubHandler) -> None:
        """Подтягиваем актуальный список тегов из БД и обновляем подписку (добавления/удаления)."""
        nonlocal tag_id_map, last_value_by_tid, subscribed_nodeids, node_handle_by_id, conn

        fresh_rows = []
        try:
            fresh_rows = get_task_tags(conn, task_id)
        except Exception as ex:
            if is_transient_db_down(ex):
                log.warning("Task #%s: DB down on get_task_tags -> reconnect later", task_id)
                if reconnect(conn_ref):
                    conn = conn_ref[0]
                return
            else:
                log.error("Task #%s: get_task_tags failed: %r", task_id, ex, exc_info=True)
                if reconnect(conn_ref):
                    conn = conn_ref[0]
                return

        new_map: Dict[str, int] = {}
        fresh_nodeids: List[str] = []
        bad_local = 0

        for tid, nodeid, *_ in fresh_rows:
            nid = clean_nodeid(nodeid)
            try:
                _ = ua.NodeId.from_string(nid)
                new_map[nid] = int(tid)
                fresh_nodeids.append(nid)
            except Exception:
                bad_local += 1

        # добавления/удаления
        to_add = [nid for nid in fresh_nodeids if nid not in subscribed_nodeids]
        to_del = [nid for nid in list(subscribed_nodeids) if nid not in new_map]

        # подпишем новые
        if to_add:
            valid_nids = []
            nodes = []
            for nid in to_add:
                try:
                    node = client.get_node(nid)
                    node.get_data_type()
                    nodes.append(node)
                    valid_nids.append(nid)
                except Exception:
                    log.error("Task #%s: invalid NodeId removed: %s", task_id, nid)

            if nodes:
                try:
                    si = max(100.0, float(interval_seconds) * 1000.0)
                    handles = subscribe_data_change_compat(sub, nodes, si_ms=si, qsize=SUB_QUEUE_SIZE)
                    for nid, h in zip(valid_nids, handles):
                        node_handle_by_id[nid] = h
                        subscribed_nodeids.add(nid)
                except Exception as ex:
                    log.error("Task #%s: subscribe_data_change failed: %r", task_id, ex, exc_info=True)


        # отпишем удалённые
        if to_del:
            try:
                handles = [node_handle_by_id.get(nid) for nid in to_del if node_handle_by_id.get(nid)]
                if handles:
                    sub.unsubscribe(handles)
                for nid in to_del:
                    subscribed_nodeids.discard(nid)
                    node_handle_by_id.pop(nid, None)
            except Exception as ex:
                log.error("Task #%s: unsubscribe failed: %r", task_id, ex, exc_info=True)

        # обновим карту
        tag_id_map.clear()
        tag_id_map.update(new_map)
        handler.tag_id_map = tag_id_map

        # первичная инициализация last_value_by_tid
        if not last_value_by_tid and tag_id_map:
            try:
                last_value_by_tid.update(load_last_values(conn, list(tag_id_map.values())))
            except Exception as ex:
                if is_transient_db_down(ex):
                    log.warning("Task #%s: DB down on load_last_values -> postpone", task_id)
                    if reconnect(conn_ref):
                        conn = conn_ref[0]
                else:
                    log.error("Task #%s: load_last_values failed: %r", task_id, ex, exc_info=True)
                    if reconnect(conn_ref):
                        conn = conn_ref[0]

        log.info("Task #%s: tags refreshed: %d valid of %d total; subscribed=%d (added=%d; removed=%d; filtered=%d)",
                 task_id, len(fresh_nodeids), len(fresh_rows), len(subscribed_nodeids),
                 len(to_add), len(to_del), bad_local)

    while not stop_event.is_set():
        client = None
        sub = None
        try:
            host, port = _parse_host_port(server_url)
            if not host or not _tcp_probe(host, port, timeout=max(1.0, float(OPC_TIMEOUT_SEC) / 5)):
                log.error("Task #%s: OPC endpoint unreachable (host=%s, port=%s). Will retry.", task_id, host, port)
                time.sleep(backoff + random.uniform(0, 0.75))
                backoff = min(backoff * 2, 60)
                continue

            client = Client(server_url, timeout=OPC_TIMEOUT_SEC)

            pol = norm_policy(security_policy)
            mode = norm_mode(security_mode)
            if pol == "None" or mode == "None":
                sec_str = "None,None,,"
            else:
                if not (os.path.isfile(client_cert_path) and os.path.isfile(client_key_path)):
                    raise RuntimeError(
                        f"Security requires PEM keys: cert={client_cert_path}, key={client_key_path}"
                    )
                sec_str = f"{pol},{mode},{client_cert_path},{client_key_path}"
            client.set_security_string(sec_str)

            if username:
                client.set_user(username)
                if password:
                    client.set_password(password)

            client.connect()
            try:
                client.set_keepalive(10)
            except Exception:
                pass

            log.info("Task #%s: connected to %s", task_id, server_url)
            backoff = 5

            # создаём Subscription (пытаемся с keepalive_count/lifetime_count)
            pub_ms = max(100.0, float(interval_seconds) * 1000.0)
            handler = SubHandler(tag_id_map, last_value_by_tid, buf)
            try:
                sub = client.create_subscription(pub_ms, handler, keepalive_count=10, lifetime_count=60)
            except TypeError:
                sub = client.create_subscription(pub_ms, handler)

            # первичная подписка
            refresh_map_and_sub(client, sub, handler)
            last_refresh = time.time()

            # служебные таймеры
            last_is_active_check = 0.0
            last_hb_check = 0.0
            hb_fail_streak = 0

            # основной цикл
            while not stop_event.is_set():
                now = time.time()

                # флаг активности задачи — опрашиваем не чаще, чем раз в IS_ACTIVE_POLL_SEC
                if now - last_is_active_check >= IS_ACTIVE_POLL_SEC:
                    last_is_active_check = now
                    try:
                        cur = conn.cursor()
                        log.debug("DB exec: check is_active (task_id=%s)", task_id)
                        cur.execute("SELECT is_active FROM dbo.PollingTasks WHERE id=?", task_id)
                        row = cur.fetchone()
                        if not row or not bool(row[0]):
                            if not notified_stop:
                                log.warning("Task #%s stopped by flag in DB", task_id)
                                notified_stop = True
                            stop_event.set()
                            break
                    except Exception as ex:
                        if is_transient_db_down(ex):
                            log.warning("Task #%s: DB is down (is_active) -> reconnect", task_id)
                        else:
                            log.error("Task #%s: DB is_active check error: %r -> reconnect", task_id, ex, exc_info=True)
                        if reconnect(conn_ref):
                            conn = conn_ref[0]
                        else:
                            time.sleep(0.5)
                            continue

                # периодический refresh набора тегов
                if now - last_refresh > TAGMAP_REFRESH_SEC:
                    refresh_map_and_sub(client, sub, handler)
                    last_refresh = now

                # сброс RAM-буфера в БД
                if buf.need_flush():
                    rows = buf.drain()
                    if rows:
                        try:
                            db_exec_batch(conn, rows)
                            log.info("Task #%s: SUB flush -> inserted_rows=%d", task_id, len(rows))
                        except Exception as ex:
                            if is_transient_db_down(ex):
                                log.warning("Task #%s: SUB flush transient -> spool", task_id)
                            else:
                                log.error("Task #%s: SUB flush error: %r (to SPOOL)", task_id, ex, exc_info=True)
                            SPOOL.dump_batch(task_id, rows)

                # --- HEARTBEAT OPC UA: читаем системный узел с периодом ---
                if now - last_hb_check >= HEARTBEAT_PERIOD_SEC:
                    last_hb_check = now
                    try:
                        hb_node = client.get_node(HEARTBEAT_NODE if isinstance(HEARTBEAT_NODE, str)
                                                  else ua.NodeId(2258, 0))
                        _ = hb_node.get_value()   # лёгкое чтение
                        # сервер жив — считаем активностью
                        handler.last_event_ts = time.time()
                        if hb_fail_streak:
                            log.info("Task #%s: heartbeat OK after %d fails", task_id, hb_fail_streak)
                        hb_fail_streak = 0
                    except Exception as hb_ex:
                        hb_fail_streak += 1
                        log.warning("Task #%s: heartbeat fail #%d: %r", task_id, hb_fail_streak, hb_ex)

                # watchdog: если тишина дольше LIVENESS_DEAD_SEC И подряд упало несколько heartbeat — реконнект
                silent_sec = time.time() - handler.last_event_ts

            # режим подмёрзшей подписки: heartbeat есть, а datachange нет
                subscription_frozen = (
                    silent_sec > LIVENESS_DEAD_SEC and
                    hb_fail_streak == 0  # сервер отвечает, но подписка молчит
                )

                if subscription_frozen:
                    log.error(
                        "Task #%s: subscription freeze detected (silent=%ss, heartbeat OK). "
                        "Performing soft-reconnect...",
                        task_id, int(silent_sec)
                    )
                    raise RuntimeError("Subscription freeze -> reconnect")

                # режим повреждения OPC-сессии
                if silent_sec > LIVENESS_DEAD_SEC and hb_fail_streak >= HEARTBEAT_FAILS_FOR_RECONNECT:
                    log.error(
                        "Task #%s: Watchdog: silent %ss and heartbeat fails x%d -> force full reconnect",
                        task_id, int(silent_sec), hb_fail_streak
                    )
                    raise RuntimeError("No data/keepalive -> reconnect")

        except Exception as e:
            if is_transient_db_down(e):
                log.warning("Task #%s: top-level transient error: %s", task_id, e)
            else:
                log.error("Task #%s: top-level error: %r", task_id, e, exc_info=True)
            time.sleep(backoff + random.uniform(0, 0.75))
            backoff = min(backoff * 2, 60)
        finally:
            try:
                if sub is not None:
                    try: sub.delete()
                    except Exception: pass
                if client is not None:
                    try: client.disconnect()
                    except AttributeError: pass
            except Exception as disc_ex:
                log.warning("Task #%s: disconnect() error: %r", task_id, disc_ex)

    # финальный слив RAM-буфера (если что-то осталось)
    try:
        rows = buf.drain()
        if rows:
            try:
                db_exec_batch(conn, rows)
                log.info("Task #%s: final SUB flush -> inserted_rows=%d", task_id, len(rows))
            except Exception as ex:
                if is_transient_db_down(ex):
                    log.warning("Task #%s: final flush transient -> spool", task_id)
                else:
                    log.error("Task #%s: final flush error: %r (to SPOOL)", task_id, ex, exc_info=True)
                SPOOL.dump_batch(task_id, rows)
    except Exception as ex:
        log.error("Task #%s: final drain error: %r", task_id, ex, exc_info=True)

    try:
        conn.close()
    except Exception:
        pass
    log.info("Task #%s finished (SUB).", task_id)

# ========= Диспетчер потоков =========
def polling_worker():
    log.info("=== POLL WORKER: start ===")
    running: Dict[int, Dict[str, object]] = {}
    missing: Dict[int, int] = {}

    # общий stop-флаг для фоновых потоков
    stop_replay = threading.Event()
    sanitize_spool_directory()
    # запускаем фоновый поток спул-реплея
    threading.Thread(
        target=spool_replay_loop,
        args=(stop_replay,),
        daemon=True,
        name="spool-replay"
    ).start()

    # DEADMAN по данным
    threading.Thread(
        target=deadman_loop,
        args=(stop_replay,),
        daemon=True,
        name="deadman"
    ).start()

    while True:
        active_ids = set()
        try:
            # читаем задачи через конечный db_connect, чтобы не зависнуть на чтении
            conn = None
            try:
                conn = db_connect(max_wait_sec=DB_CONNECT_MAX_WAIT_SEC, autocommit=True)
            except Exception as ex:
                if is_transient_db_down(ex):
                    log.warning("DB down (polling_worker): %s — retry later", ex)
                    time.sleep(5 + random.uniform(0, 0.75))
                    continue
                log.error("load tasks unexpected error (non-transient): %r", ex, exc_info=True)
                time.sleep(5 + random.uniform(0, 0.75))
                continue

            with conn:
                cur = conn.cursor()
                log.debug("DB exec: load tasks start")
                cur.execute("""
                    SELECT t.id, t.server_url, i.IntervalSeconds,
                           s.OpcUsername, s.OpcPassword, s.SecurityPolicy, s.SecurityMode
                    FROM dbo.PollingTasks t
                    JOIN dbo.PollingIntervals i ON t.interval_id = i.Id
                    JOIN dbo.OpcServers s ON t.server_url = s.EndpointUrl
                    WHERE t.is_active = 1
                """)
                rows = cur.fetchall()
                log.debug("DB exec: load tasks done (rows=%s)", len(rows))

                for (task_id, server_url, interval_sec,
                     username, enc_password, sec_pol, sec_mode) in rows:

                    active_ids.add(task_id)
                    missing[task_id] = 0

                    # первичный набор тегов (диагностика)
                    tag_rows = []
                    try:
                        tag_rows = get_task_tags(conn, task_id)
                    except Exception as ex:
                        if is_transient_db_down(ex):
                            log.warning("Task #%s: DB down on initial get_task_tags", task_id)
                        else:
                            log.error("Task #%s: get_task_tags failed: %r", task_id, ex, exc_info=True)
                    tag_nodeids = [r[1] for r in tag_rows]

                    # расшифровка пароля
                    password = ""
                    if enc_password:
                        try:
                            password = fernet.decrypt(enc_password.encode()).decode()
                        except Exception as ex:
                            log.error("Task #%s: FERNET decrypt error: %r", task_id, ex, exc_info=True)

                    need_start = (
                        task_id not in running
                        or not running[task_id]["thread"].is_alive()
                    )
                    if need_start:
                        stop_event = threading.Event()
                        th = threading.Thread(
                            target=poll_task_sub,
                            args=(
                                task_id, server_url, tag_nodeids, int(interval_sec), stop_event,
                                (username or "").strip(),
                                (password or "").strip(),
                                (sec_pol or "None").strip(),
                                (sec_mode or "None").strip(),
                            ),
                            daemon=True,
                            name=f"opc-sub-{task_id}",
                        )

                        th.start()
                        with THREAD_REGISTRY_LOCK:
                            THREAD_REGISTRY[task_id] = th

                        running[task_id] = {"thread": th, "stop_event": stop_event}
                        log.info("Started task #%s (%s, interval=%ss, tags=%s)",
                                task_id, server_url, interval_sec, len(tag_nodeids))
                        running[task_id] = {"thread": th, "stop_event": stop_event}
                        log.info("Started task #%s (%s, interval=%ss, tags=%s)",
                                 task_id, server_url, interval_sec, len(tag_nodeids))

        except pyodbc.Error as db_err:
            if is_transient_db_down(db_err):
                log.warning("load tasks transient DB error: %s", db_err)
            else:
                log.error("load tasks error: %r", db_err, exc_info=True)
        except Exception as ex:
            if is_transient_db_down(ex):
                log.warning("load tasks transient error: %s", ex)
            else:
                log.error("load tasks unexpected error: %r", ex, exc_info=True)

        # подчистка исчезнувших задач
        for old_id in list(running.keys()):
            if old_id not in active_ids:
                missing[old_id] = missing.get(old_id, 0) + 1
                if missing[old_id] >= 3:
                    log.info("Stopping obsolete task #%s", old_id)
                    running[old_id]["stop_event"].set()
                    running[old_id]["thread"].join(timeout=2)
                    del running[old_id]
                    missing.pop(old_id, None)

        time.sleep(5 + random.uniform(0, 0.75))

if __name__ == "__main__":
    polling_worker()
