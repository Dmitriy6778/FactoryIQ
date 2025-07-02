#routers/db.py
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
import os
import pyodbc
import socket
import asyncio
import ipaddress
from dotenv import load_dotenv

router = APIRouter(prefix="/db", tags=["database"])

class DBConfig(BaseModel):
    server: str
    database: str
    user: str
    password: str
    driver: str = "ODBC Driver 18 for SQL Server"

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

def is_port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except:
        return False

@router.get("/sql-instances")
def get_sql_instances():
    try:
        hostname = socket.gethostname()
        local_ips = ["127.0.0.1", "localhost", hostname]
        servers = []

        for host in local_ips:
            if is_port_open(host, 1433):
                servers.append(host)

        # Можно добавить поиск через sqlcmd, если установлен
        try:
            import subprocess
            result = subprocess.run(["sqlcmd", "-L"], capture_output=True, text=True, timeout=5)
            for line in result.stdout.splitlines():
                if "\\" in line:
                    servers.append(line.strip())
        except Exception:
            pass

        servers = list(set(servers))
        return {"ok": True, "servers": servers}
    except Exception as ex:
        return {"ok": False, "servers": [], "message": str(ex)}

@router.get("/odbc-drivers")
def list_odbc_drivers():
    drivers = pyodbc.drivers()
    return {"drivers": drivers}

@router.post("/list-databases")
def list_databases(config: DBConnectionInfo):
    conn_str = (
        f"DRIVER={{{config.driver}}};"
        f"SERVER={config.server};"
        f"UID={config.user};"
        f"PWD={config.password};"
        f"TrustServerCertificate=yes;"
    )
    try:
        with pyodbc.connect(conn_str, timeout=3) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT name FROM sys.databases WHERE database_id > 4")
            dbs = [row[0] for row in cursor.fetchall()]
        return {"ok": True, "databases": dbs}
    except Exception as ex:
        return {"ok": False, "message": str(ex)}

@router.post("/config")
def save_config(cfg: DBConfig):
    # Путь на уровень выше папки с этим файлом
    env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
    env_path = os.path.abspath(env_path)
    with open(env_path, "w", encoding="utf-8") as f:
        f.write(f"DB_SERVER={cfg.server}\n")
        f.write(f"DB_NAME={cfg.database}\n")
        f.write(f"DB_USER={cfg.user}\n")
        f.write(f"DB_PASS={cfg.password}\n")
        f.write(f"DB_DRIVER={cfg.driver}\n")
    return {"ok": True}

@router.get("/check")
def check_connection():
    from ..config import get_conn_str
    try:
        conn = pyodbc.connect(get_conn_str(), timeout=3)
        conn.close()
        return {"ok": True, "message": "Соединение успешно!"}
    except Exception as ex:
        return {"ok": False, "message": str(ex)}
# Проверяем наличие .env и его содержимое для стартовой страницы
@router.get("/config")
def get_config():
    # Загружаем .env (если ещё не загружен где-то в старте)
    load_dotenv()  # Можно убрать, если делается в startup

    # Читаем переменные из окружения
    config = {
        "server": os.getenv("DB_SERVER", ""),
        "database": os.getenv("DB_NAME", ""),
        "user": os.getenv("DB_USER", ""),
        "password": os.getenv("DB_PASS", ""),
        "driver": os.getenv("DB_DRIVER", ""),
    }

    # Проверим, есть ли все ключевые параметры
    if all(config.values()):
        return {"ok": True, "config": config}
    else:
        return {"ok": False, "config": config, "message": "Не все параметры найдены в .env"}


@router.post("/init")
def init_db():
    from ..config import get_conn_str
    CREATE_TABLES = """
    -- === ПОЛЬЗОВАТЕЛИ ===
    IF OBJECT_ID(N'Users', N'U') IS NULL
    CREATE TABLE Users (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Username NVARCHAR(100) NOT NULL,
        Email NVARCHAR(255) NULL,
        TelegramId NVARCHAR(50) NULL,
        Role NVARCHAR(50) NULL,
        CreatedAt DATETIME DEFAULT GETDATE()
    );

    -- === СЕРВЕРА ===
    IF OBJECT_ID(N'OpcServers', N'U') IS NULL
    CREATE TABLE OpcServers (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Name NVARCHAR(100) NOT NULL,
        EndpointUrl NVARCHAR(250) NOT NULL,
        Description NVARCHAR(255) NULL,
        CONSTRAINT UQ_OpcServers_EndpointUrl UNIQUE (EndpointUrl)
    );

    -- === ИНТЕРВАЛЫ ОПРОСА ===
    IF OBJECT_ID(N'PollingIntervals', N'U') IS NULL
    CREATE TABLE PollingIntervals (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Name NVARCHAR(50) NOT NULL,
        IntervalSeconds INT NOT NULL,
        Type NVARCHAR(20) NULL
    );

    -- === ТЕГИ ===
    IF OBJECT_ID(N'OpcTags', N'U') IS NULL
    CREATE TABLE OpcTags (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        ServerId INT NOT NULL,
        BrowseName NVARCHAR(200) NOT NULL,
        NodeId NVARCHAR(500) NOT NULL,
        DataType NVARCHAR(100) NOT NULL DEFAULT 'Float',
        Description NVARCHAR(255) NULL,
        UNIQUE (ServerId, BrowseName),
        UNIQUE (ServerId, NodeId),
        FOREIGN KEY (ServerId) REFERENCES OpcServers(Id)
    );

    -- === ДАННЫЕ ===
    IF OBJECT_ID(N'OpcData', N'U') IS NULL
    CREATE TABLE OpcData (
        Id BIGINT IDENTITY(1,1) PRIMARY KEY,
        TagId INT NOT NULL,
        Value FLOAT NOT NULL,
        Timestamp DATETIME NOT NULL,
        Status NVARCHAR(50) NOT NULL DEFAULT 'Good',
        FOREIGN KEY (TagId) REFERENCES OpcTags(Id)
    );

    -- === ЗАДАЧИ ОПРОСА ===
    IF OBJECT_ID(N'PollingTasks', N'U') IS NULL
    CREATE TABLE PollingTasks (
        id INT IDENTITY(1,1) PRIMARY KEY,
        server_url NVARCHAR(255) NOT NULL,
        is_active BIT NOT NULL DEFAULT 1,
        started_at DATETIME NULL,
        interval_id INT NOT NULL,
        FOREIGN KEY (interval_id) REFERENCES PollingIntervals(Id)
    );

    -- === СВЯЗКА ЗАДАЧА-ТЕГ ===
    IF OBJECT_ID(N'PollingTaskTags', N'U') IS NULL
    CREATE TABLE PollingTaskTags (
        id INT IDENTITY(1,1) PRIMARY KEY,
        polling_task_id INT NOT NULL,
        tag_id INT NOT NULL,
        FOREIGN KEY (polling_task_id) REFERENCES PollingTasks(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES OpcTags(Id) ON DELETE CASCADE,
        CONSTRAINT UQ_PollingTaskTag UNIQUE (polling_task_id, tag_id)
    );

    -- === ШАБЛОНЫ ОТЧЁТОВ ===
    IF OBJECT_ID(N'ReportTemplates', N'U') IS NULL
    CREATE TABLE ReportTemplates (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        UserId INT NOT NULL,
        Name NVARCHAR(255) NOT NULL,
        Description NVARCHAR(500) NULL,
        DateCreated DATETIME DEFAULT GETDATE(),
        DateUpdated DATETIME DEFAULT GETDATE(),
        IsShared BIT DEFAULT 0,
        ShareHash VARCHAR(64) NULL,
        ReportType NVARCHAR(50) NULL,
        PeriodType NVARCHAR(20) NULL,
        AutoSchedule BIT DEFAULT 0,
        TargetChannel NVARCHAR(128) NULL,
        FOREIGN KEY (UserId) REFERENCES Users(Id)
    );

    -- === ТЕГИ В ШАБЛОНЕ ===
    IF OBJECT_ID(N'ReportTemplateTags', N'U') IS NULL
    CREATE TABLE ReportTemplateTags (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        TemplateId INT NOT NULL,
        TagId INT NOT NULL,
        TagType NVARCHAR(20) NOT NULL,
        Aggregate VARCHAR(16) NULL,
        IntervalMinutes INT NOT NULL,
        DisplayOrder INT DEFAULT 0,
        FOREIGN KEY (TemplateId) REFERENCES ReportTemplates(Id),
        FOREIGN KEY (TagId) REFERENCES OpcTags(Id)
    );

    -- === ИСТОРИЯ ОТЧЁТОВ ===
    IF OBJECT_ID(N'Reports', N'U') IS NULL
    CREATE TABLE Reports (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        TemplateId INT NOT NULL,
        UserId INT NOT NULL,
        DateFrom DATETIME NOT NULL,
        DateTo DATETIME NOT NULL,
        DateCreated DATETIME DEFAULT GETDATE(),
        Status NVARCHAR(20) NOT NULL DEFAULT 'complete',
        ExportedFile NVARCHAR(255) NULL,
        ExportFormat NVARCHAR(10) NULL,
        SentTo NVARCHAR(255) NULL,
        Comment NVARCHAR(255) NULL,
        FOREIGN KEY (TemplateId) REFERENCES ReportTemplates(Id),
        FOREIGN KEY (UserId) REFERENCES Users(Id)
    );

    -- === РАСПИСАНИЕ ОТЧЁТОВ ===
    IF OBJECT_ID(N'ReportSchedule', N'U') IS NULL
    CREATE TABLE ReportSchedule (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        TemplateId INT NOT NULL,
        PeriodType NVARCHAR(20) NOT NULL,
        TimeOfDay TIME NOT NULL,
        NextRun DATETIME NULL,
        LastRun DATETIME NULL,
        Active BIT NOT NULL DEFAULT 1,
        TargetType NVARCHAR(20) NOT NULL,
        TargetValue NVARCHAR(255) NOT NULL,
        FOREIGN KEY (TemplateId) REFERENCES ReportTemplates(Id)
    );

    -- === ЛОГИ ОТПРАВКИ ===
    IF OBJECT_ID(N'ReportDeliveryLog', N'U') IS NULL
    CREATE TABLE ReportDeliveryLog (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        ReportId INT NOT NULL,
        TargetType NVARCHAR(20) NOT NULL,
        TargetValue NVARCHAR(255) NOT NULL,
        SentAt DATETIME DEFAULT GETDATE(),
        DeliveryStatus NVARCHAR(20) NOT NULL,
        ErrorMessage NVARCHAR(255) NULL,
        FOREIGN KEY (ReportId) REFERENCES Reports(Id)
    );

    -- === КАНАЛЫ TELEGRAM ДЛЯ ОТЧЁТОВ ===
    IF OBJECT_ID(N'TelegramReportTarget', N'U') IS NULL
    CREATE TABLE TelegramReportTarget (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        ChannelId BIGINT NOT NULL,
        ChannelName NVARCHAR(128) NOT NULL,
        ThreadId INT NULL,
        SendAsFile BIT DEFAULT 1,
        SendAsText BIT DEFAULT 1,
        SendAsChart BIT DEFAULT 0,
        Active BIT DEFAULT 1,
        CreatedAt DATETIME DEFAULT GETDATE()
    );
    """

    try:
        with pyodbc.connect(get_conn_str(), autocommit=True) as conn:
            cursor = conn.cursor()
            for stmt in CREATE_TABLES.strip().split(";"):
                if stmt.strip():
                    cursor.execute(stmt)

            # Заполнение справочника интервалов
            cursor.execute("SELECT COUNT(*) FROM PollingIntervals")
            if cursor.fetchone()[0] == 0:
                cursor.execute("""
                INSERT INTO PollingIntervals (Name, IntervalSeconds, Type) VALUES
                ('1 сек', 1, 'cyclic'),
                ('3 сек', 3, 'cyclic'),
                ('5 сек', 5, 'cyclic'),
                ('10 сек', 10, 'cyclic'),
                ('30 сек', 30, 'cyclic'),
                ('1 мин', 60, 'cyclic'),
                ('По изменению', 0, 'onchange');
                """)

        return {"ok": True, "message": "Таблицы созданы и интервалы заполнены!"}
    except Exception as ex:
        raise HTTPException(status_code=500, detail=str(ex))


@router.post("/init-full-windows-auth")
def init_with_windows_auth(payload: InitDBRequest):
    """
    Создание SQL login, базы и пользователя через Trusted_Connection,
    параметры (server, database, new_user, new_password, driver) приходят с фронта.
    """
    try:
        conn_str = (
            f"DRIVER={{{payload.driver}}};"
            f"SERVER={payload.server};"
            f"DATABASE=master;"
            f"Trusted_Connection=yes;"
            f"TrustServerCertificate=yes;"
        )
        with pyodbc.connect(conn_str, autocommit=True) as conn:
            cursor = conn.cursor()

            # 1. Создать login
            cursor.execute(f"""
                IF NOT EXISTS (SELECT * FROM sys.sql_logins WHERE name = '{payload.new_user}')
                BEGIN
                    CREATE LOGIN [{payload.new_user}] WITH PASSWORD = '{payload.new_password}';
                END
            """)

            # 2. Создать базу данных
            cursor.execute(f"""
                IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = '{payload.database}')
                BEGIN
                    CREATE DATABASE [{payload.database}];
                END
            """)

            # 3. Создать пользователя в БД и выдать права
            cursor.execute(f"""
                USE [{payload.database}];
                IF NOT EXISTS (SELECT * FROM sys.database_principals WHERE name = '{payload.new_user}')
                BEGIN
                    CREATE USER [{payload.new_user}] FOR LOGIN [{payload.new_user}];
                    ALTER ROLE db_owner ADD MEMBER [{payload.new_user}];
                END
            """)

        return {
            "ok": True,
            "message": f"Пользователь `{payload.new_user}` и база `{payload.database}` успешно созданы через Windows Auth"
        }
    except Exception as ex:
        raise HTTPException(status_code=500, detail=f"Ошибка: {str(ex)}")

