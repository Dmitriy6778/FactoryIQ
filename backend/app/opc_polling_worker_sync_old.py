# app/opc_polling_worker_sync.py
import os
import sys
import time
import json
import uuid
import threading
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime, timezone
from typing import List, Dict, Tuple, Any

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

OPC_TIMEOUT_SEC        = int(get_env("OPC_TIMEOUT_SEC", "15"))
BATCH_SIZE             = int(get_env("BATCH_SIZE", "500"))           # мягкий лимит пачки (RAM-буфер)
TAGMAP_REFRESH_SEC     = int(get_env("TAGMAP_REFRESH_SEC", "300"))   # как часто обновлять кэш/список тегов
LOG_DIR                = get_env("LOG_DIR", "logs")
LOG_LEVEL              = get_env("LOG_LEVEL", "INFO").upper()
FLUSH_MAX_SEC          = float(get_env("FLUSH_MAX_SEC", "2.0"))      # макс. задержка перед сбросом RAM-пачки
SUB_QUEUE_SIZE         = int(get_env("SUB_QUEUE_SIZE", "10"))        # глубина очереди на сервере
LIVENESS_DEAD_SEC      = int(get_env("LIVENESS_DEAD_SEC", "60"))     # если нет событий > N с — реконнект

# анти-дубликатор
CHANGE_EPSILON_ABS     = float(get_env("CHANGE_EPSILON_ABS", "0"))
CHANGE_EPSILON_REL     = float(get_env("CHANGE_EPSILON_REL", "0"))
DISABLE_DEDUP          = get_env("DISABLE_DEDUP", "0").strip() in ("1", "true", "True")

# использовать «маршрутизаторный» коннектор (как в backend/app/routers/db.py)
USE_DB_ROUTES_CONN     = get_env("USE_DB_ROUTES_CONN", "0").strip() in ("1", "true", "True")

# файловый спул (локальный персистентный буфер)
SPOOL_DIR              = Path(get_env("SPOOL_DIR", "spool"))
SPOOL_SYNC_INTERVAL_SEC= int(get_env("SPOOL_SYNC_INTERVAL_SEC", "5"))  # период попытки реплея файлов (сек)
SPOOL_FILE_PREFIX      = "opc_spool"
SPOOL_FILE_SUFFIX      = ".ndjson"

FERNET_KEY = os.getenv("FERNET_KEY")
if not FERNET_KEY:
    raise RuntimeError("FERNET_KEY not set in environment!")
fernet = Fernet(FERNET_KEY.encode())

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

# ========= Файловый спул (на случай проблем с БД) =========
class FileSpool:
    """
    Пишем каждую НЕвставленную в БД пачку в отдельный .ndjson файл.
    Формат строки: {"TagId": int, "Value": float, "Timestamp": "ISO", "Status": "str"}
    Реплей-поток периодически пытается залить файлы в БД и удаляет их после успеха.
    """
    def __init__(self, base_dir: Path):
        self.dir = base_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = Lock()

    def dump_batch(self, task_id: int, rows: List[Tuple[int, float, datetime, str]]) -> Path:
        """
        Сохраняем пачку в новый файл. Имя уникально — конфликтов не будет.
        """
        if not rows:
            return None
        ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S_%f")
        fname = f"{SPOOL_FILE_PREFIX}_task{task_id}_{ts}_{uuid.uuid4().hex}{SPOOL_FILE_SUFFIX}"
        fpath = self.dir / fname
        payload = []
        for tid, val, dt, st in rows:
            iso = dt.isoformat() if isinstance(dt, datetime) else str(dt)
            payload.append(json.dumps({"TagId": int(tid), "Value": float(val), "Timestamp": iso, "Status": str(st)}, ensure_ascii=False))

        with self.lock:
            with open(fpath, "w", encoding="utf-8") as f:
                f.write("\n".join(payload))
        log.warning("SPOOL: batch persisted -> %s (rows=%d)", fpath.name, len(rows))
        return fpath

    def list_ready_files(self) -> List[Path]:
        with self.lock:
            return sorted(self.dir.glob(f"{SPOOL_FILE_PREFIX}_*{SPOOL_FILE_SUFFIX}"))

    def read_file_rows(self, fpath: Path) -> List[Tuple[int, float, datetime, str]]:
        rows: List[Tuple[int, float, datetime, str]] = []
        with open(fpath, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                    tid = int(obj["TagId"])
                    val = float(obj["Value"])
                    ts  = obj["Timestamp"]
                    if isinstance(ts, str):
                        # переносим в naive UTC datetime
                        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                        if d.tzinfo is not None:
                            d = d.astimezone(timezone.utc).replace(tzinfo=None)
                        ts = d
                    st  = str(obj.get("Status", "Good"))
                    rows.append((tid, val, ts, st))
                except Exception as ex:
                    log.error("SPOOL: bad line in %s: %r", fpath.name, ex, exc_info=True)
        return rows

SPOOL = FileSpool(SPOOL_DIR)

def spool_replay_loop(stop_event: threading.Event):
    """
    Фоновый реплей спула — пока БД недоступна, файлы копятся.
    Как только БД «оживает», пачки заливаются и файлы удаляются.
    """
    threading.current_thread().name = "spool-replay"
    while not stop_event.is_set():
        try:
            files = SPOOL.list_ready_files()
            if not files:
                time.sleep(SPOOL_SYNC_INTERVAL_SEC)
                continue

            conn = None
            try:
                conn = db_connect()
            except Exception as ex:
                log.error("SPOOL: DB connect failed: %r", ex, exc_info=True)
                time.sleep(SPOOL_SYNC_INTERVAL_SEC)
                continue

            for f in files:
                rows = SPOOL.read_file_rows(f)
                if not rows:
                    try:
                        f.unlink(missing_ok=True)
                    except Exception:
                        pass
                    continue
                try:
                    db_exec_batch(conn, rows)
                    try:
                        f.unlink(missing_ok=True)
                    except Exception:
                        pass
                    log.info("SPOOL: replay OK -> %s (rows=%d)", f.name, len(rows))
                except Exception as ex:
                    log.error("SPOOL: replay failed for %s: %r", f.name, ex, exc_info=True)
                    # прервёмся, попробуем позже (чтобы не циклить ошибку)
                    break
            try:
                conn.close()
            except Exception:
                pass
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

def safe_float(val: Any) -> float | None:
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

def extract_numeric_from_datavalue(dv: ua.DataValue) -> float | None:
    try:
        raw = getattr(dv, "Value", None)
        if hasattr(raw, "Value"):
            raw = raw.Value
        if isinstance(raw, (list, tuple, bytes, bytearray, dict)):
            return None
        return safe_float(raw)
    except Exception:
        return None

def norm_policy(name: str | None) -> str:
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

def norm_mode(name: str | None) -> str:
    if not name:
        return "None"
    n = name.strip().lower()
    if n == "sign":
        return "Sign"
    if n in ("signandencrypt", "sign_and_encrypt"):
        return "SignAndEncrypt"
    return "None"

def has_changed(prev: float | None, new: float) -> bool:
    if DISABLE_DEDUP:
        return True
    if prev is None:
        return True
    diff = abs(new - prev)
    if CHANGE_EPSILON_ABS > 0 and diff <= CHANGE_EPSILON_ABS:
        return False
    if CHANGE_EPSILON_REL > 0 and abs(prev) > 0:
        if diff <= abs(prev) * CHANGE_EPSILON_REL:
            return False
    return diff > 0

def load_last_values(conn, tag_ids: List[int]) -> Dict[int, float]:
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
        cur.execute(sql, part)
        for tid, val in cur.fetchall():
            f = safe_float(val)
            if f is not None:
                result[int(tid)] = f
    return result

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
def get_task_tags(conn, polling_task_id):
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
    cur.execute(sql, polling_task_id)
    return cur.fetchall()

def _conn_from_routes_db() -> pyodbc.Connection:
    cs = get_conn_str()
    log.debug("DB conn(get_conn_str): %s", _mask_conn_str(cs))
    c = pyodbc.connect(cs)
    c.autocommit = False
    cur = c.cursor()
    cur.execute("SELECT DB_NAME()")
    active = cur.fetchone()[0]
    log.info("DB: active database: [%s]", active)
    return c

def db_connect():
    backoff = 2
    while True:
        try:
            if USE_DB_ROUTES_CONN:
                conn = _conn_from_routes_db()
            else:
                cs = get_conn_str()
                log.debug("DB conn(get_conn_str): %s", _mask_conn_str(cs))
                conn = pyodbc.connect(cs)
                conn.autocommit = False
                cur = conn.cursor()
                cur.execute("SELECT DB_NAME()")
                active = cur.fetchone()[0]
                log.info("DB: active database: [%s]", active)
            return conn
        except Exception as ex:
            log.error("DB connect() failed: %r", ex, exc_info=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)

def db_exec_batch(conn, rows: List[Tuple[int, float, datetime, str]]):
    if not rows:
        return
    preview = rows[:3]
    try:
        cur = conn.cursor()
        cur.execute("SELECT DB_NAME()")
        active = cur.fetchone()[0]
    except Exception:
        active = "<unknown>"

    log.info(
        "DB: executemany INSERT %d rows (db=%s, preview=%s)",
        len(rows),
        active,
        [(r[0], r[1], r[2].isoformat() if isinstance(r[2], datetime) else r[2], r[3]) for r in preview]
    )

    for attempt in range(2):  # один повтор
        try:
            cur = conn.cursor()
            cur.fast_executemany = True
            cur.executemany(
                "INSERT INTO dbo.OpcData (TagId, Value, [Timestamp], [Status]) VALUES (?, ?, ?, ?)",
                rows
            )
            conn.commit()
            log.info("DB: commit OK, inserted_rows=%d", len(rows))
            return
        except Exception as ex:
            log.error("DB batch insert failed (attempt %d): %r", attempt + 1, ex, exc_info=True)
            try:
                conn.rollback()
            except Exception:
                pass
            if attempt == 0:
                try:
                    conn.close()
                except Exception:
                    pass
                conn = db_connect()
            else:
                # Диагностика одиночными вставками (первые 3 строки)
                try:
                    cur = conn.cursor()
                    for i, r in enumerate(preview, 1):
                        try:
                            cur.execute("INSERT INTO dbo.OpcData (TagId, Value, [Timestamp], [Status]) VALUES (?, ?, ?, ?)", r)
                            conn.commit()
                            log.warning("DB: single-row fallback OK for preview row #%d: %s", i, r)
                        except Exception as ex2:
                            log.error("DB: single-row fallback FAILED for preview row #%d: %r; row=%s", i, ex2, r, exc_info=True)
                except Exception:
                    pass
                raise

# ========= OPC UA: утилиты NodeId =========
def clean_nodeid(n: str | None) -> str:
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
    def __init__(self, batch_size: int):
        self.batch_size = batch_size
        self.q: deque[Tuple[int, float, datetime, str]] = deque()
        self.lock = Lock()
        self.last_flush = time.time()

    def push(self, row: Tuple[int, float, datetime, str]) -> int:
        with self.lock:
            self.q.append(row)
            n = len(self.q)
            return n

    def need_flush(self) -> bool:
        with self.lock:
            return len(self.q) >= self.batch_size or (time.time() - self.last_flush) >= FLUSH_MAX_SEC

    def drain(self) -> list[Tuple[int, float, datetime, str]]:
        with self.lock:
            rows = list(self.q)
            self.q.clear()
            self.last_flush = time.time()
            return rows

# ========= Handler подписки =========
class SubHandler(object):
    def __init__(self, tag_id_map: Dict[str, int], last_value_by_tid: Dict[int, float], buf: SubBuffer):
        self.tag_id_map = tag_id_map
        self.last_value_by_tid = last_value_by_tid
        self.buf = buf
        self.last_event_ts = time.time()

    def datachange_notification(self, node, val, data):
        try:
            try:
                nid = node.nodeid.to_string()
            except Exception:
                nid = str(getattr(node, "nodeid", ""))
            tid = self.tag_id_map.get(nid)
            if not tid:
                return
            fval = safe_float(val)
            if fval is None:
                return
            prev = self.last_value_by_tid.get(tid)
            if not has_changed(prev, fval):
                return
     
            status = "Good"
            ts = None
            try:
                dv = getattr(data, "monitored_item", None)
                if dv is not None:
                    status = str(dv.Value.StatusCode)
                    ts = getattr(dv.Value, "SourceTimestamp", None) or getattr(dv.Value, "ServerTimestamp", None)
            except Exception:
                pass

            # --- ВРЕМЯ ЗАПИСИ: всегда текущее локальное (Астана +5) ---
            tz_offset = timezone.utc
            try:
                tz_offset = timezone(datetime.now().astimezone().utcoffset())
            except Exception:
                tz_offset = timezone.utc
            ts = datetime.now(tz_offset).replace(tzinfo=None)


            self.last_value_by_tid[tid] = fval
            n = self.buf.push((tid, fval, ts, "Good" if "Good" in status else status))
            self.last_event_ts = time.time()
            if n % 2000 == 0:
                log.info("SubBuffer size=%d (task stream)", n)
        except Exception as ex:
            log.error("SubHandler error: %r", ex, exc_info=True)

def subscribe_data_change_compat(sub, nodes, si_ms: float, qsize: int):
    """
    Совместимый со старыми/новыми версиями python-opcua вызов subscribe_data_change.
    Пытаемся с аргументом 'monitoring', если не поддерживается — убираем.
    Так же пробуем 'queuesize' и 'queue_size'.
    Возвращаем список хэндлов.
    """
    # 1) полный современный вариант
    try:
        return sub.subscribe_data_change(
            nodes,
            attr=ua.AttributeIds.Value,
            queuesize=qsize,                  # вариант 1
            monitoring=ua.MonitoringMode.Reporting,
            sampling_interval=si_ms
        )
    except TypeError:
        pass

    # 2) без monitoring
    try:
        return sub.subscribe_data_change(
            nodes,
            attr=ua.AttributeIds.Value,
            queuesize=qsize,
            sampling_interval=si_ms
        )
    except TypeError:
        pass

    # 3) c queue_size вместо queuesize
    try:
        return sub.subscribe_data_change(
            nodes,
            attr=ua.AttributeIds.Value,
            queue_size=qsize,                 # вариант 2
            sampling_interval=si_ms
        )
    except TypeError:
        pass

    # 4) минимальный (на некоторых старых версиях)
    try:
        return sub.subscribe_data_change(nodes, attr=ua.AttributeIds.Value)
    except TypeError:
        # самый простой, если и attr не принимает
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
    conn = db_connect()

    # текущее состояние
    tag_id_map: Dict[str, int] = {}
    last_value_by_tid: Dict[int, float] = {}
    node_handle_by_id: Dict[str, int] = {}  # NodeId -> handle
    subscribed_nodeids: set[str] = set()

    # буфер вставки
    buf = SubBuffer(BATCH_SIZE)

    log.info("Task #%s -> SUBSCRIBE %s (policy=%s, mode=%s, user=%s)",
             task_id, server_url, security_policy, security_mode, "<set>" if username else "anonymous")

    # helper для refresh из БД
    def refresh_map_and_sub(client: Client, sub, handler: SubHandler) -> None:
        nonlocal tag_id_map, last_value_by_tid, subscribed_nodeids, node_handle_by_id

        fresh_rows = []
        try:
            fresh_rows = get_task_tags(conn, task_id)  # [(Id, NodeId, ...)]
        except Exception as ex:
            log.error("Task #%s: get_task_tags failed: %r", task_id, ex, exc_info=True)

        new_map: Dict[str, int] = {}
        fresh_nodeids: list[str] = []
        bad_local = 0

        for tid, nodeid, *_ in fresh_rows:
            nid = clean_nodeid(nodeid)
            try:
                _ = ua.NodeId.from_string(nid)
                new_map[nid] = int(tid)
                fresh_nodeids.append(nid)
            except Exception:
                bad_local += 1

        # добавления
        to_add = [nid for nid in fresh_nodeids if nid not in subscribed_nodeids]
        # удаления
        to_del = [nid for nid in list(subscribed_nodeids) if nid not in new_map]

        # подпишем новые
    
        if to_add:
            nodes = [client.get_node(nid) for nid in to_add]
            try:
                # sampling interval в мс
                si = max(100.0, float(interval_seconds) * 1000.0)
                # Универсальный совместимый вызов (под любую версию python-opcua)
                handles = subscribe_data_change_compat(sub, nodes, si_ms=si, qsize=SUB_QUEUE_SIZE)

                # python-opcua возвращает список хэндлов в той же последовательности
                for nid, h in zip(to_add, handles):
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
                log.error("Task #%s: load_last_values failed: %r", task_id, ex, exc_info=True)

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
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)
                continue

            client = Client(server_url, timeout=OPC_TIMEOUT_SEC)

            pol = norm_policy(security_policy)
            mode = norm_mode(security_mode)
            if pol == "None" or mode == "None":
                sec_str = "None,None,,"  # без шифрования
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

            # connect
            client.connect()
            # не у всех версий есть keepalive — не критично
            try:
                client.set_keepalive(10)
            except Exception:
                pass

            log.info("Task #%s: connected to %s", task_id, server_url)

            backoff = 5

            # создаём Subscription
            pub_ms = max(100.0, float(interval_seconds) * 1000.0)
            handler = SubHandler(tag_id_map, last_value_by_tid, buf)
            sub = client.create_subscription(pub_ms, handler)

            # первичная подписка
            refresh_map_and_sub(client, sub, handler)
            last_refresh = time.time()

            # основной цикл: контроль флагов, refresh, флеш буфера
            while not stop_event.is_set():
                # флаг активности задачи
                try:
                    cur = conn.cursor()
                    cur.execute("SELECT is_active FROM dbo.PollingTasks WHERE id=?", task_id)
                    row = cur.fetchone()
                    if not row or not bool(row[0]):
                        if not notified_stop:
                            log.warning("Task #%s stopped by flag in DB", task_id)
                            notified_stop = True
                        stop_event.set()
                        break
                except Exception as ex:
                    log.error("Task #%s: DB is_active check error: %r", task_id, ex, exc_info=True)

                # периодический refresh набора тегов (динамическое добавление/удаление)
                now = time.time()
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
                            log.error("Task #%s: SUB flush error: %r (to SPOOL)", task_id, ex, exc_info=True)
                            # сохраняем пачку в файл
                            SPOOL.dump_batch(task_id, rows)

                # watchdog «тишины»: если нет событий слишком долго — реконнект
                if time.time() - handler.last_event_ts > LIVENESS_DEAD_SEC:
                    raise RuntimeError(f"No data/keepalive > {LIVENESS_DEAD_SEC}s -> force reconnect")

                time.sleep(0.1)  # лёгкий тик

        except Exception as e:
            log.error("Task #%s: top-level error: %r", task_id, e, exc_info=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
        finally:
            try:
                if sub is not None:
                    try:
                        sub.delete()
                    except Exception:
                        pass
                if client is not None:
                    try:
                        client.disconnect()
                    except AttributeError:
                        pass
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
                log.error("Task #%s: final flush error: %r (to SPOOL)", task_id, ex, exc_info=True)
                SPOOL.dump_batch(task_id, rows)
    except Exception as ex:
        log.error("Task #%s: final drain error: %r", task_id, ex, exc_info=True)

    try:
        conn.close()
    except Exception:
        pass
    log.info("Task #%s finished (SUB).", task_id)

# ========= (Опционально) Синхронный опрос — оставлен как альтернативный режим =========
# ... твой poll_task_sync можно сохранить параллельно, при необходимости.

# ========= Диспетчер потоков =========
def polling_worker():
    log.info("=== POLL WORKER: start ===")
    running: Dict[int, Dict[str, object]] = {}
    missing: Dict[int, int] = {}

    # запускаем фоновый поток спул-реплея
    stop_replay = threading.Event()
    threading.Thread(target=spool_replay_loop, args=(stop_replay,), daemon=True, name="spool-replay").start()

    while True:
        active_ids = set()
        try:
            with pyodbc.connect(get_conn_str()) as conn:
                cur = conn.cursor()
                cur.execute("""
                    SELECT t.id, t.server_url, i.IntervalSeconds,
                           s.OpcUsername, s.OpcPassword, s.SecurityPolicy, s.SecurityMode
                    FROM dbo.PollingTasks t
                    JOIN dbo.PollingIntervals i ON t.interval_id = i.Id
                    JOIN dbo.OpcServers s ON t.server_url = s.EndpointUrl
                    WHERE t.is_active = 1
                """)
                rows = cur.fetchall()

                for (task_id, server_url, interval_sec,
                     username, enc_password, sec_pol, sec_mode) in rows:

                    active_ids.add(task_id)
                    missing[task_id] = 0

                    # первичный набор тегов (для логов/диагностики)
                    try:
                        tag_rows = get_task_tags(conn, task_id)
                    except Exception as ex:
                        log.error("Task #%s: get_task_tags failed: %r", task_id, ex, exc_info=True)
                        tag_rows = []
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
                        running[task_id] = {"thread": th, "stop_event": stop_event}
                        log.info("Started task #%s (%s, interval=%ss, tags=%s)",
                                 task_id, server_url, interval_sec, len(tag_nodeids))

        except pyodbc.Error as db_err:
            log.error("load tasks error: %r", db_err, exc_info=True)

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

        time.sleep(5)

if __name__ == "__main__":
    polling_worker()
