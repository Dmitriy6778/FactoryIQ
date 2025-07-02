import os
from dotenv import load_dotenv

def get_conn_str():
    # Всегда читаем .env
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
    load_dotenv(dotenv_path=env_path, override=True)

    # Просто берем значения (если нет — не подставляем дефолтные в коде)
    DB_SERVER = os.getenv("DB_SERVER")
    DB_NAME = os.getenv("DB_NAME")
    DB_USER = os.getenv("DB_USER")
    DB_PASS = os.getenv("DB_PASS")
    DB_DRIVER = os.getenv("DB_DRIVER")

    if not all([DB_SERVER, DB_NAME, DB_USER, DB_PASS, DB_DRIVER]):
        raise Exception("Не заданы параметры подключения к БД в .env")

    return (
        f"DRIVER={{{DB_DRIVER}}};"
        f"SERVER={DB_SERVER};"
        f"DATABASE={DB_NAME};"
        f"UID={DB_USER};"
        f"PWD={DB_PASS};"
        f"TrustServerCertificate=yes;"
    )
