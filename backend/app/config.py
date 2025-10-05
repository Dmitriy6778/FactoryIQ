# app/config.py
import os
import pathlib
from dotenv import load_dotenv
from typing import Optional

# ---- Загрузка .env из корня проекта ----
# структура: app/config.py -> вверх на один уровень -> .env
_ENV_PATH = pathlib.Path(__file__).resolve().parents[1] / ".env"
load_dotenv(dotenv_path=_ENV_PATH)

def get_env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    return v if (v is not None and v != "") else default

def get_env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")

def get_conn_str(*, redact: bool = False) -> str:
    """
    Собирает строку подключения для pyodbc по переменным окружения (.env).

    Поддерживаемые переменные:
      DB_DRIVER   = ODBC Driver 18 for SQL Server       (по умолчанию)
      DB_SERVER   = host[,port] или host\INSTANCE
      DB_NAME     = имя базы
      DB_USER     = логин SQL (если пусто -> Windows Auth)
      DB_PASS     = пароль SQL
      DB_ENCRYPT  = 1/0 (по умолчанию 1 для Driver 18)
      DB_TRUST_CERT = 1/0 (по умолчанию 1 в локальных сетях)
      DB_TIMEOUT  = seconds (LoginTimeout)
      DB_APPNAME  = произвольная метка приложения

    ЛОГИКА ВЫБОРА АУТЕНТИФИКАЦИИ:
      - если заданы DB_USER и DB_PASS -> SQL Auth (UID/PWD)
      - иначе -> Windows Auth (Trusted_Connection=Yes)
    """
    driver    = get_env("DB_DRIVER", "ODBC Driver 18 for SQL Server")
    server    = get_env("DB_SERVER", "localhost")
    database  = get_env("DB_NAME", "master")
    user      = (get_env("DB_USER", "") or "").strip()
    password  = (get_env("DB_PASS", "") or "").strip()
    encrypt   = get_env_bool("DB_ENCRYPT", True)            # Driver 18 подразумевает Encrypt=yes
    trust_cert= get_env_bool("DB_TRUST_CERT", True)         # удобно в корпоративной сети
    timeout   = get_env("DB_TIMEOUT", "15")                 # LoginTimeout
    appname   = get_env("DB_APPNAME", "FactoryIQ")

    if not server:
        raise ValueError("DB_SERVER is empty")
    if not database:
        raise ValueError("DB_NAME is empty")

    parts = [
        f"DRIVER={{{driver}}}",
        f"SERVER={server}",
        f"DATABASE={database}",
        f"Encrypt={'Yes' if encrypt else 'No'}",
        f"TrustServerCertificate={'Yes' if trust_cert else 'No'}",
        f"LoginTimeout={timeout}",
        f"APP={appname}",
    ]

    # Выбор аутентификации
    if user and password:
        # SQL Authentication
        parts.append(f"UID={user}")
        parts.append(f"PWD={password}")
    else:
        # Windows Authentication (Integrated / Trusted)
        parts.append("Trusted_Connection=Yes")

    conn_str = ";".join(parts) + ";"

    if redact:
        # скрыть пароль для логов
        return conn_str.replace(password, "******") if password else conn_str
    return conn_str
