# backend/app/routers/db.py
from fastapi import APIRouter, HTTPException, Body, Depends
from pydantic import BaseModel
from dotenv import dotenv_values
from typing import Dict, List, Optional, Tuple
import logging
import traceback
import contextlib
import socket
import pyodbc
import os
import re
import time
import subprocess

# =============================================================================
# Логирование и пошаговый debug
# =============================================================================
DEBUG_MODE = True  # или os.getenv("DEBUG", "0") == "1"

logger = logging.getLogger("factoryiq")
if not logger.handlers:
    logging.basicConfig(
        level=logging.DEBUG if DEBUG_MODE else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

class StepLog(list):
    @contextlib.contextmanager
    def step(self, name: str, **extra):
        t0 = time.perf_counter()
        try:
            self.append({"step": name, "status": "start", "extra": extra})
            yield
            self.append({"step": name, "status": "ok", "ms": int((time.perf_counter() - t0) * 1000)})
        except Exception as ex:
            tb = traceback.format_exc()
            self.append({
                "step": name, "status": "error", "ms": int((time.perf_counter() - t0) * 1000),
                "error": str(ex), "trace": tb
            })
            logger.exception("Step failed: %s", name)
            raise

def get_step_log() -> StepLog:
    return StepLog()

# =============================================================================
# Роутеры
# =============================================================================
router = APIRouter(prefix="/db", tags=["database"])
opc_router = APIRouter(prefix="/opcua", tags=["opcua"])

# =============================================================================
# Модели
# =============================================================================
class DBConnectionInfo(BaseModel):
    server: str
    user: str
    password: str
    driver: str = "ODBC Driver 18 for SQL Server"

class InitDBRequest(BaseModel):
    server: str
    database: str
    new_user: str
    new_password: str
    driver: str = "ODBC Driver 18 for SQL Server"

class DBConfig(BaseModel):
    server: str
    database: str
    user: str
    password: str
    driver: str = "ODBC Driver 18 for SQL Server"

class InitOptions(BaseModel):
    database: str
    create_if_missing: bool = True
    dry_run: bool = False

class FullInitRequest(BaseModel):
    database: str
    with_procs: bool = True
    create_if_missing: bool = True
    dry_run: bool = False
    elevate_with_windows_auth: bool = False

class VerifyRequest(BaseModel):
    database: str
    deep: bool = False

# =============================================================================
# Пути и загрузка SQL
# =============================================================================
def _project_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def _env_path() -> str:
    return os.path.join(_project_root(), ".env")

def _atomic_write(path: str, content: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    os.replace(tmp, path)

def _resolve_sql_path(filename: str) -> str:
    root = _project_root()
    candidates = [
        os.path.join(root, filename),
        os.path.join(root, "sql", filename),
        os.path.join(root, "backend", "sql", filename),
        os.path.join(os.path.dirname(__file__), "..", "sql", filename),
    ]
    for p in map(os.path.abspath, candidates):
        if os.path.exists(p):
            return p
    raise FileNotFoundError(f"{filename} не найден (искали в: {candidates})")

def _split_go(script: str) -> List[str]:
    parts = re.split(r"(?im)^\s*GO\s*;?\s*$", script)
    return [p.strip() for p in parts if p and p.strip()]

def _load_sql_text(filename: str) -> str:
    path = _resolve_sql_path(filename)
    logger.debug("Reading SQL: %s", path)
    with open(path, "r", encoding="utf-8") as f:
        txt = f.read()

    # BOM на старте
    if txt and txt[0] == "\ufeff":
        txt = txt[1:]

    # нормализуем переводы строк
    txt = txt.replace("\r\n", "\n").replace("\r", "\n")

    # 3) Жёсткая нормализация «кавычек» и мусорных символов
    trans = {
        # smart single quotes / primes / акценты / backtick
        0x2018: ord("'"), 0x2019: ord("'"), 0x201A: ord("'"), 0x201B: ord("'"),
        0x2032: ord("'"), 0x2035: ord("'"), 0x02BC: ord("'"), 0x00B4: ord("'"),
        0x0060: ord("'"), 0x0092: ord("'"),
        # smart double quotes / double primes
        0x201C: ord('"'), 0x201D: ord('"'), 0x201E: ord('"'), 0x201F: ord('"'),
        0x2033: ord('"'), 0x2036: ord('"'),
        # тире и пр.
        0x2013: ord('-'), 0x2014: ord('-'),
        # пробелы и сепараторы
        0x00A0: ord(' '), 0x202F: ord(' '),
        0x2028: ord('\n'), 0x2029: ord('\n'),
        # нулевые/невидимые и bidi-маркеры — выкидываем
        0x00AD: None, 0x200B: None, 0x200C: None, 0x200D: None, 0x2060: None,
        0x200E: None, 0x200F: None, 0x061C: None, 0xFEFF: None,
    }
    txt = txt.translate(trans)

    # 4) Убрать любые USE [xxx]
    txt = re.sub(r"(?im)^\s*USE\s+\[[^\]]+\]\s*;?\s*$", "", txt)

    # 5) Убрать любые SET LANGUAGE (на всякий)
    txt = re.sub(r"(?im)^\s*SET\s+LANGUAGE\b.*$", "", txt)

    return txt.strip()


# =============================================================================
# Соединения с SQL Server
# =============================================================================
def _conn_sqlauth_master() -> pyodbc.Connection:
    server = os.getenv("DB_SERVER") or "localhost"
    driver = os.getenv("DB_DRIVER") or "ODBC Driver 18 for SQL Server"
    user   = os.getenv("DB_USER") or ""
    pwd    = os.getenv("DB_PASS") or ""
    conn_str = (
        f"DRIVER={{{driver}}};SERVER={server};DATABASE=master;"
        f"UID={user};PWD={pwd};TrustServerCertificate=yes;"
    )
    return pyodbc.connect(conn_str, autocommit=True)

def _conn_trusted_master() -> pyodbc.Connection:
    server = os.getenv("DB_SERVER") or "localhost"
    driver = os.getenv("DB_DRIVER") or "ODBC Driver 18 for SQL Server"
    conn_str = (
        f"DRIVER={{{driver}}};SERVER={server};DATABASE=master;"
        f"Trusted_Connection=yes;TrustServerCertificate=yes;"
    )
    return pyodbc.connect(conn_str, autocommit=True)

def _conn_to_db(db: str, *, trusted: bool = False) -> pyodbc.Connection:
    """
    Открывает соединение ровно в указанную БД, без зависимостей от get_conn_str().
    """
    server = os.getenv("DB_SERVER") or "localhost"
    driver = os.getenv("DB_DRIVER") or "ODBC Driver 18 for SQL Server"

    if trusted:
        conn_str = (
            f"DRIVER={{{driver}}};"
            f"SERVER={server};"
            f"DATABASE={db};"
            f"Trusted_Connection=yes;"
            f"TrustServerCertificate=yes;"
        )
    else:
        user = os.getenv("DB_USER") or ""
        pwd  = os.getenv("DB_PASS") or ""
        conn_str = (
            f"DRIVER={{{driver}}};"
            f"SERVER={server};"
            f"DATABASE={db};"
            f"UID={user};PWD={pwd};"
            f"TrustServerCertificate=yes;"
        )
    return pyodbc.connect(conn_str, autocommit=True)


def _conn_for(db: Optional[str] = None) -> pyodbc.Connection:
    from ..config import get_conn_str
    base = (get_conn_str() or "").strip().rstrip(";")

    # распарсим в dict
    kv: Dict[str, str] = {}
    for part in base.split(";"):
        if not part.strip() or "=" not in part:
            continue
        k, v = part.split("=", 1)
        kv[k.strip().lower()] = v.strip()

    if db:
        kv["database"] = db
        kv["initial catalog"] = db

    trusted = kv.get("trusted_connection", "").lower() in ("yes", "true", "sspi")
    if trusted:
        for k in ("uid", "user id", "pwd", "password"):
            kv.pop(k, None)
    else:
        kv.pop("trusted_connection", None)

    kv.setdefault("trustservercertificate", "yes")

    # пересоберём без дублей, сохраняя порядок известных ключей
    seen = set()
    ordered: List[str] = []
    for part in base.split(";"):
        if not part.strip() or "=" not in part:
            continue
        k = part.split("=", 1)[0].strip()
        kl = k.lower()
        if kl in seen:
            continue
        seen.add(kl)
        if kl in kv:
            ordered.append(f"{k}={kv[kl]}")
    for k in ("database", "initial catalog", "trustservercertificate",
              "trusted_connection", "uid", "user id", "pwd", "password"):
        if k in kv and k not in seen:
            ordered.append(f"{k.title() if ' ' not in k else k}={kv[k]}")

    conn_str = ";".join(ordered) + ";"
    return pyodbc.connect(conn_str, autocommit=True)


# =============================================================================
# Выполнение SQL скриптов (без динамического EXEC)
# =============================================================================


def _strip_sql_comments(s: str) -> str:
    # удаляем /* ... */ и -- до конца строки
    s = re.sub(r"(?s)/\*.*?\*/", "", s)
    s = re.sub(r"(?m)--.*?$", "", s)
    return s

def _exec_sql_script(conn: pyodbc.Connection, script: str) -> None:
    cur = conn.cursor()
    for i, stmt in enumerate(_split_go(script), 1):
        if not stmt.strip():
            continue
        logger.debug("Executing batch %s (len=%s)", i, len(stmt))

        # предохранитель: проверяем кавычки после удаления комментариев
        check = _strip_sql_comments(stmt)
        if check.count("'") % 2 == 1:
            dump_dir = os.path.join(_project_root(), "sql", "_failed")
            os.makedirs(dump_dir, exist_ok=True)
            with open(os.path.join(dump_dir, f"batch_{i:03}_odd_quotes.sql"),
                      "w", encoding="utf-8", newline="\n") as f:
                f.write(stmt)
            logger.error("Batch %s looks like it has unbalanced single quotes (after stripping comments).", i)

        try:
            cur.execute(stmt)
        except Exception:
            dump_dir = os.path.join(_project_root(), "sql", "_failed")
            os.makedirs(dump_dir, exist_ok=True)
            with open(os.path.join(dump_dir, f"batch_{i:03}.sql"),
                      "w", encoding="utf-8", newline="\n") as f:
                f.write(stmt)
            logger.exception("Batch %s failed. Preview(raw): %r", i, stmt[:800])
            raise

# =============================================================================
# Логин/пользователь/права и создание БД
# =============================================================================
def _ensure_login_and_db_user(database: str, elevate_with_windows_auth: bool = False):
    """
    - Создать LOGIN (DB_USER/DB_PASS), если нет
    - Создать БД, если нет
    - Создать/ремапнуть USER в БД, выдать CONNECT и db_owner
    - Поставить DEFAULT_DATABASE для логина
    Всё через master: Trusted (если elevate=True) иначе SQL Auth.
    """
    db_user = os.getenv("DB_USER") or ""
    db_pass = os.getenv("DB_PASS") or ""
    if not db_user:
        return

    master_conn = _conn_trusted_master() if elevate_with_windows_auth else _conn_sqlauth_master()
    with master_conn as conn:
        cur = conn.cursor()

        # LOGIN
        cur.execute("""
            IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = ?)
            BEGIN
                DECLARE @sql nvarchar(max) =
                    N'CREATE LOGIN [' + ? + N'] WITH PASSWORD = ''' + ? + N''';';
                EXEC(@sql);
            END
        """, (db_user, db_user, db_pass))

        # CREATE DATABASE (если нет)
        cur.execute("IF DB_ID(?) IS NULL EXEC(N'CREATE DATABASE [' + ? + N']')", (database, database))

        # USER + CONNECT + db_owner в целевой БД
        cur.execute("""
            DECLARE @db sysname = ?;
            DECLARE @usr sysname = ?;
            DECLARE @sql nvarchar(max) = N'
                USE [' + @db + N'];
                IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N''' + @usr + N''')
                BEGIN
                    CREATE USER [' + @usr + N'] FOR LOGIN [' + @usr + N'] WITH DEFAULT_SCHEMA=[dbo];
                END
                ELSE
                BEGIN
                    ALTER USER [' + @usr + N'] WITH LOGIN = [' + @usr + N'];
                END;
                GRANT CONNECT TO [' + @usr + N'];
                IF NOT EXISTS (
                    SELECT 1
                    FROM sys.database_role_members rm
                    JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id AND r.name = N''db_owner''
                    JOIN sys.database_principals u ON rm.member_principal_id = u.principal_id AND u.name = N''' + @usr + N'''
                )
                BEGIN
                    ALTER ROLE db_owner ADD MEMBER [' + @usr + N'];
                END;';
            EXEC(@sql);
        """, (database, db_user))

        # DEFAULT DATABASE для логина
        cur.execute("""
            DECLARE @usr sysname = ?;
            DECLARE @db  sysname = ?;
            DECLARE @sql nvarchar(max) =
                N'ALTER LOGIN [' + @usr + N'] WITH DEFAULT_DATABASE = [' + @db + N']';
            EXEC(@sql);
        """, (db_user, database))

# =============================================================================
# Конфиг .env
# =============================================================================
@router.get("/_debug-sql-paths")
def debug_sql_paths():
    tried = []
    for name in ("init-db.sql", "init-procs.sql"):
        try:
            p = _resolve_sql_path(name)
            tried.append({"file": name, "path": p, "exists": True})
        except Exception as ex:
            tried.append({"file": name, "exists": False, "error": str(ex)})
    return {"paths": tried}

@router.post("/config")
def save_config(cfg: DBConfig):
    env_path = _env_path()
    existing = dotenv_values(env_path) or {} if os.path.exists(env_path) else {}

    try:
        from cryptography.fernet import Fernet  # type: ignore
        default_key = Fernet.generate_key().decode("utf-8")
    except Exception:
        import base64
        default_key = base64.b64encode(os.urandom(32)).decode("utf-8")

    merged = dict(existing)
    merged.update({
        "DB_SERVER": cfg.server,
        "DB_NAME": cfg.database,
        "DB_USER": cfg.user,
        "DB_PASS": cfg.password,
        "DB_DRIVER": cfg.driver,
        "FERNET_KEY": existing.get("FERNET_KEY") or os.getenv("FERNET_KEY") or default_key,
    })

    lines = [f"{k}={v}" for k, v in merged.items() if v is not None]
    _atomic_write(env_path, "\n".join(lines) + "\n")

    return {"ok": True, "message": "Конфигурация сохранена. FERNET_KEY сохранён/установлен."}

@router.get("/config")
def get_config():
    env_path = _env_path()
    data = dotenv_values(env_path) or {} if os.path.exists(env_path) else {}
    cfg = {
        "server": data.get("DB_SERVER", ""),
        "database": data.get("DB_NAME", ""),
        "user": data.get("DB_USER", ""),
        "password": data.get("DB_PASS", ""),
        "driver": data.get("DB_DRIVER", ""),
    }
    ok = all(cfg.values())
    return {"ok": ok, "config": cfg, "message": "" if ok else "Не все параметры DB_* найдены в .env"}

# =============================================================================
# Служебные ручки
# =============================================================================
def _is_port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except Exception:
        return False

@router.get("/sql-instances")
def get_sql_instances():
    try:
        hostname = socket.gethostname()
        local_ips = ["127.0.0.1", "localhost", hostname]
        servers = [h for h in local_ips if _is_port_open(h, 1433)]
        try:
            result = subprocess.run(["sqlcmd", "-L"], capture_output=True, text=True, timeout=5)
            for line in result.stdout.splitlines():
                line = line.strip()
                if "\\" in line:
                    servers.append(line)
        except Exception:
            pass
        servers = sorted(set(servers))
        return {"ok": True, "servers": servers}
    except Exception as ex:
        return {"ok": False, "servers": [], "message": str(ex)}

@router.get("/odbc-drivers")
def list_odbc_drivers():
    return {"drivers": pyodbc.drivers()}

@router.post("/list-databases")
def list_databases(config: DBConnectionInfo):
    conn_str = (
        f"DRIVER={{{config.driver}}};SERVER={config.server};"
        f"UID={config.user};PWD={config.password};TrustServerCertificate=yes;"
    )
    try:
        with pyodbc.connect(conn_str, autocommit=True, timeout=3) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sys.databases WHERE database_id > 4")
            dbs = [row[0] for row in cursor.fetchall()]
        return {"ok": True, "databases": dbs}
    except Exception as ex:
        return {"ok": False, "message": str(ex)}

@router.get("/check")
def check_connection():
    from ..config import get_conn_str
    try:
        conn = pyodbc.connect(get_conn_str(), timeout=3)
        conn.close()
        return {"ok": True, "message": "Соединение успешно!"}
    except Exception as ex1:
        try:
            _conn_trusted_master().close()
            return {"ok": True, "message": "Соединение по Windows Auth к master есть (конфиг SQL-логина проверить)."}
        except Exception:
            return {"ok": False, "message": str(ex1)}

# =============================================================================
# Инициализация
# =============================================================================
@router.post("/init")
def init_db(opts: InitOptions = Body(...)):
    if opts.create_if_missing:
        with _conn_sqlauth_master() as c:
            c.cursor().execute(
                "IF DB_ID(?) IS NULL EXEC(N'CREATE DATABASE [' + ? + N']')",
                (opts.database, opts.database),
            )

    script = _load_sql_text("init-db.sql")
    if opts.dry_run:
        return {"ok": True, "message": f"dry_run: батчей {len(_split_go(script))}"}

    try:
        with _conn_to_db(opts.database, trusted=False) as db_conn:
            _exec_sql_script(db_conn, script)
        return {"ok": True, "message": f"init-db.sql выполнен в [{opts.database}]"}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Ошибка выполнения init-db.sql: {ex}")

@router.post("/init-procs")
def init_procs(opts: InitOptions = Body(...)):
    with _conn_sqlauth_master() as c:
        if not _fetchall(c, "SELECT 1 WHERE DB_ID(?) IS NOT NULL", (opts.database,)):
            raise HTTPException(status_code=400, detail=f"База [{opts.database}] не существует")

    script = _load_sql_text("init-procs.sql")
    if opts.dry_run:
        return {"ok": True, "message": f"dry_run: батчей {len(_split_go(script))}"}

    try:
        with _conn_to_db(opts.database, trusted=False) as db_conn:
            _exec_sql_script(db_conn, script)
        return {"ok": True, "message": f"init-procs.sql выполнен в [{opts.database}]"}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Ошибка выполнения init-procs.sql: {ex}")

@router.post("/init-full")
def init_full(req: FullInitRequest, dbg: StepLog = Depends(get_step_log)):
    try:
        with dbg.step("ensure_login_and_user", db=req.database, elevate=req.elevate_with_windows_auth):
            _ensure_login_and_db_user(req.database, elevate_with_windows_auth=req.elevate_with_windows_auth)

        if req.dry_run:
            with dbg.step("load_init_db_sql"):
                init_sql = _load_sql_text("init-db.sql")
                dbg.append({"step": "init-db.sql_batches", "count": len(_split_go(init_sql))})
            if req.with_procs:
                with dbg.step("load_init_procs_sql"):
                    procs_sql = _load_sql_text("init-procs.sql")
                    dbg.append({"step": "init-procs.sql_batches", "count": len(_split_go(procs_sql))})
            return {"ok": True, "message": "dry_run ok", "debug": list(dbg)}

        with dbg.step("apply_sql"):
            with dbg.step("load_init_db_sql"):
                init_sql = _load_sql_text("init-db.sql")

            with dbg.step("open_conn_to_target_db", trusted=req.elevate_with_windows_auth):
                conn = _conn_to_db(req.database, trusted=req.elevate_with_windows_auth)

            try:
                with dbg.step("exec_init_db_sql"):
                    _exec_sql_script(conn, init_sql)

                if req.with_procs:
                    with dbg.step("load_init_procs_sql"):
                        procs_sql = _load_sql_text("init-procs.sql")
                    with dbg.step("exec_init_procs_sql"):
                        _exec_sql_script(conn, procs_sql)
            finally:
                try:
                    conn.close()
                except Exception:
                    pass

        return {"ok": True, "message": f"Инициализация завершена для [{req.database}]", "debug": list(dbg)}
    except HTTPException as he:
        raise HTTPException(status_code=he.status_code, detail={"error": he.detail, "debug": list(dbg)})
    except Exception as ex:
        raise HTTPException(status_code=500, detail={"error": str(ex), "debug": list(dbg), "trace": traceback.format_exc()})

# =============================================================================
# Проверка структуры
# =============================================================================
_RE_OBJ = re.compile(
    r"(?im)^\s*CREATE\s+(?:OR\s+ALTER\s+)?(TABLE|VIEW|PROCEDURE|PROC|FUNCTION)\s+"
    r"(?:\[\s*(?P<schema1>[^\]\s]+)\s*\]\.)?"
    r"(?:\[\s*(?P<name1>[^\]\s]+)\s*\]|(?P<name2>[^\s\(\[]+))"
)

def _parse_expected_objects(sql_text: str) -> Dict[str, Dict[str, str]]:
    results: Dict[str, Dict[str, str]] = {"TABLE": {}, "VIEW": {}, "PROCEDURE": {}, "FUNCTION": {}}
    for chunk in _split_go(sql_text):
        m = _RE_OBJ.search(chunk)
        if not m:
            continue
        typ = m.group(1).upper()
        if typ == "PROC":
            typ = "PROCEDURE"
        schema_ = m.group("schema1") or "dbo"
        name_ = m.group("name1") or m.group("name2")
        full = f"{schema_}.{name_}"
        if typ in results:
            results[typ][full] = chunk
    return results

def _fetchall(conn: pyodbc.Connection, query: str, params: Tuple = ()) -> List[Tuple]:
    cur = conn.cursor()
    cur.execute(query, params)
    return cur.fetchall()

def _list_existing_objects(conn: pyodbc.Connection) -> Dict[str, set]:
    cur = conn.cursor()
    cur.execute("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'")
    tables = {f"{r[0]}.{r[1]}" for r in cur.fetchall()}

    cur.execute("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS")
    views = {f"{r[0]}.{r[1]}" for r in cur.fetchall()}

    cur.execute("SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_TYPE='PROCEDURE'")
    procs = {f"{r[0]}.{r[1]}" for r in cur.fetchall()}

    cur.execute("SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_TYPE='FUNCTION'")
    funcs = {f"{r[0]}.{r[1]}" for r in cur.fetchall()}

    return {"TABLE": tables, "VIEW": views, "PROCEDURE": procs, "FUNCTION": funcs}

def _list_columns(conn: pyodbc.Connection, full_name: str) -> List[Tuple[str, str, int]]:
    schema, name = full_name.split(".", 1)
    rows = _fetchall(
        conn,
        """
        SELECT COLUMN_NAME, DATA_TYPE, CASE WHEN IS_NULLABLE='YES' THEN 1 ELSE 0 END AS IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=? AND TABLE_NAME=?
        ORDER BY ORDINAL_POSITION
        """,
        (schema, name),
    )
    return [(r[0], r[1], r[2]) for r in rows]

@router.post("/verify-structure")
def verify_structure(req: VerifyRequest, dbg: StepLog = Depends(get_step_log)):
    try:
        with dbg.step("load_init_db_sql"):
            init_db_sql = _load_sql_text("init-db.sql")
        try:
            with dbg.step("load_init_procs_sql"):
                init_sp_sql = _load_sql_text("init-procs.sql")
        except Exception as ex:
            init_sp_sql = ""
            dbg.append({"step": "load_init_procs_sql", "status": "skip", "reason": str(ex)})

        with dbg.step("parse_expected_objects"):
            expected = _parse_expected_objects(init_db_sql + ("\nGO\n" + init_sp_sql if init_sp_sql else ""))

        with dbg.step("open_connection", db=req.database):
            try:
                conn = _conn_to_db(req.database, trusted=False)  # сначала SQL-логин
            except pyodbc.Error as e1:
                # если логин не мапнут в нужной БД — создадим/ремапнем через Windows и попробуем снова
                dbg.append({"step": "open_connection_retry", "mode": "ensure_and_trusted", "error": str(e1)})
                try:
                    _ensure_login_and_db_user(req.database, elevate_with_windows_auth=True)
                except Exception as e2:
                    dbg.append({"step": "ensure_login_and_user_failed", "error": str(e2)})
                conn = _conn_to_db(req.database, trusted=True)  # Trusted retry

        try:
            with dbg.step("list_existing_objects"):
                existing = _list_existing_objects(conn)

            missing, extra, migrations = [], [], []
            for typ in ("TABLE", "VIEW", "PROCEDURE", "FUNCTION"):
                exp = set(expected.get(typ, {}).keys())
                exi = set(existing.get(typ, set()))
                for name in sorted(exp - exi):
                    missing.append(f"{typ}:{name}")
                    if name in expected[typ]:
                        migrations.append(expected[typ][name])
                for name in sorted(exi - exp):
                    extra.append(f"{typ}:{name}")

            details: Dict[str, object] = {
                "expected_counts": {k: len(v) for k, v in expected.items()},
                "existing_counts": {k: len(v) for k, v in existing.items()},
            }

            if req.deep:
                with dbg.step("deep_columns_diff"):
                    column_diff = {}
                    for tbl in expected.get("TABLE", {}):
                        if tbl not in existing.get("TABLE", set()):
                            continue
                        cols = _list_columns(conn, tbl)
                        cols_db = [c[0] for c in cols]
                        create_txt = expected["TABLE"][tbl]
                        body = create_txt[create_txt.find("(") + 1:create_txt.rfind(")")]
                        wanted = []
                        for ln in body.splitlines():
                            ln = ln.strip().strip(",")
                            if not ln or re.match(r"(?i)^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|INDEX)\b", ln):
                                continue
                            m = re.match(r"(?i)^\[?([A-Za-z0-9_]+)\]?\s+", ln)
                            if m:
                                wanted.append(m.group(1))
                        miss = [c for c in wanted if c not in cols_db]
                        ext = [c for c in cols_db if c not in wanted]
                        if miss or ext:
                            column_diff[tbl] = {"missing": miss, "extra": ext}
                    details["column_diff"] = column_diff

            ok = (not missing) and (not details.get("column_diff"))
            msg = "Структура БД соответствует эталону" if ok else "Обнаружены расхождения структуры"

            return {
                "ok": ok,
                "message": msg,
                "missing": missing,
                "extra": extra,
                "migrations": migrations,
                "details": details,
                "debug": list(dbg),
            }
        finally:
            with dbg.step("close_connection"):
                try:
                    conn.close()
                except Exception:
                    pass
    except HTTPException as he:
        raise HTTPException(status_code=he.status_code, detail={"error": he.detail, "debug": list(dbg)})
    except Exception as ex:
        raise HTTPException(status_code=500, detail={"error": str(ex), "debug": list(dbg), "trace": traceback.format_exc()})

# =============================================================================
# OPC UA заглушка
# =============================================================================
@opc_router.post("/gen-client-cert")
def gen_client_cert_debug():
    return {"ok": False, "message": "Not implemented yet"}

# =============================================================================
# Создание логина/БД через Windows Auth (ручка)
# =============================================================================
@router.post("/init-full-windows-auth")
def init_with_windows_auth(payload: InitDBRequest):
    try:
        conn_str = (
            f"DRIVER={{{payload.driver}}};SERVER={payload.server};DATABASE=master;"
            f"Trusted_Connection=yes;TrustServerCertificate=yes;"
        )
        with pyodbc.connect(conn_str, autocommit=True) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                IF NOT EXISTS (SELECT * FROM sys.sql_logins WHERE name = ?)
                BEGIN
                    DECLARE @sql nvarchar(max) =
                        N'CREATE LOGIN [' + ? + N'] WITH PASSWORD = ''' + ? + N''';';
                    EXEC(@sql);
                END
            """, (payload.new_user, payload.new_user, payload.new_password))

            cursor.execute("""
                IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = ?)
                BEGIN
                    DECLARE @sql nvarchar(max) = N'CREATE DATABASE [' + ? + N']';
                    EXEC(@sql);
                END
            """, (payload.database, payload.database))

            cursor.execute("""
                DECLARE @db sysname = ?;
                DECLARE @usr sysname = ?;
                DECLARE @sql nvarchar(max) = N'
                    USE [' + @db + N'];
                    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N''' + @usr + N''')
                    BEGIN
                        CREATE USER [' + @usr + N'] FOR LOGIN [' + @usr + N'] WITH DEFAULT_SCHEMA=[dbo];
                    END
                    ELSE
                    BEGIN
                        ALTER USER [' + @usr + N'] WITH LOGIN = [' + @usr + N'];
                    END;
                    GRANT CONNECT TO [' + @usr + N'];
                    IF NOT EXISTS (
                        SELECT 1
                        FROM sys.database_role_members rm
                        JOIN sys.database_principals r ON rm.role_principal_id = r.principal_id AND r.name = N''db_owner''
                        JOIN sys.database_principals u ON rm.member_principal_id = u.principal_id AND u.name = N''' + @usr + N'''
                    )
                    BEGIN
                        ALTER ROLE db_owner ADD MEMBER [' + @usr + N'];
                    END;';
                EXEC(@sql);
            """, (payload.database, payload.new_user))

        return {"ok": True, "message": f"Пользователь `{payload.new_user}` и база `{payload.database}` созданы"}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Ошибка: {str(ex)}")
