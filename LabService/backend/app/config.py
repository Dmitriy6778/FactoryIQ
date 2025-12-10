import os
import pathlib
from dotenv import load_dotenv
from typing import Optional

# ---- Загрузка .env из корня проекта ----
_ENV_PATH = pathlib.Path(__file__).resolve().parents[1] / ".env"
load_dotenv(dotenv_path=_ENV_PATH)

def get_env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    return v if v not in (None, "") else default

def get_env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")

def get_conn_str(*, redact: bool = False) -> str:
    """
    Строка подключения pyodbc из переменных окружения.
    Полностью совместима с FactoryIQ.
    """
    driver = get_env("DB_DRIVER", "ODBC Driver 18 for SQL Server")
    server = get_env("DB_SERVER", "localhost")
    database = get_env("DB_NAME", "AltaiMaiLab")
    user = get_env("DB_USER", "")
    password = get_env("DB_PASS", "")

    encrypt = get_env_bool("DB_ENCRYPT", True)
    trust = get_env_bool("DB_TRUST_CERT", True)
    timeout = get_env("DB_TIMEOUT", "15")

    parts = [
        f"DRIVER={{{driver}}}",
        f"SERVER={server}",
        f"DATABASE={database}",
        f"Encrypt={'Yes' if encrypt else 'No'}",
        f"TrustServerCertificate={'Yes' if trust else 'No'}",
        f"LoginTimeout={timeout}",
        f"APP=LabService",
    ]

    if user and password:
        parts.append(f"UID={user}")
        parts.append(f"PWD={password}")
    else:
        parts.append("Trusted_Connection=Yes")

    conn_str = ";".join(parts) + ";"

    if redact and password:
        conn_str = conn_str.replace(password, "******")

    return conn_str
