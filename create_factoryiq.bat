@echo off
REM Создание структуры FactoryIQ (backend + frontend)
REM -----------------------------------------------

REM Создание backend структуры
mkdir FactoryIQ\backend\app\routers
mkdir FactoryIQ\backend\app\utils

REM Основные файлы backend
echo import os>FactoryIQ\backend\app\config.py
echo from dotenv import load_dotenv>>FactoryIQ\backend\app\config.py
echo.>>FactoryIQ\backend\app\config.py
echo load_dotenv()>>FactoryIQ\backend\app\config.py
echo DB_SERVER = os.getenv("DB_SERVER", "localhost\\HISTORIAN")>>FactoryIQ\backend\app\config.py
echo DB_NAME = os.getenv("DB_NAME", "OpcUaSystem")>>FactoryIQ\backend\app\config.py
echo DB_USER = os.getenv("DB_USER", "sa")>>FactoryIQ\backend\app\config.py
echo DB_PASS = os.getenv("DB_PASS", "password")>>FactoryIQ\backend\app\config.py
echo DB_DRIVER = os.getenv("DB_DRIVER", "ODBC Driver 18 for SQL Server")>>FactoryIQ\backend\app\config.py
echo.>>FactoryIQ\backend\app\config.py
echo def get_conn_str():>>FactoryIQ\backend\app\config.py
echo ^>^>^>    return (>>FactoryIQ\backend\app\config.py
echo         f"DRIVER={{{DB_DRIVER}}};"^>^>^>    >>FactoryIQ\backend\app\config.py
echo         f"SERVER={DB_SERVER};"^>^>^>    >>FactoryIQ\backend\app\config.py
echo         f"DATABASE={DB_NAME};"^>^>^>    >>FactoryIQ\backend\app\config.py
echo         f"UID={DB_USER};"^>^>^>    >>FactoryIQ\backend\app\config.py
echo         f"PWD={DB_PASS};"^>^>^>    >>FactoryIQ\backend\app\config.py
echo         f"TrustServerCertificate=yes;"^>^>^>    >>FactoryIQ\backend\app\config.py

echo import pyodbc>FactoryIQ\backend\app\db.py
echo from .config import get_conn_str>>FactoryIQ\backend\app\db.py
echo.>>FactoryIQ\backend\app\db.py
echo def get_db_connection():>>FactoryIQ\backend\app\db.py
echo     return pyodbc.connect(get_conn_str())>>FactoryIQ\backend\app\db.py

echo from pydantic import BaseModel>FactoryIQ\backend\app\models.py
echo.>>FactoryIQ\backend\app\models.py
echo class OpcServer(BaseModel):>>FactoryIQ\backend\app\models.py
echo     id: int>>FactoryIQ\backend\app\models.py
echo     name: str>>FactoryIQ\backend\app\models.py
echo     endpoint_url: str>>FactoryIQ\backend\app\models.py
echo     description: str ^| None = None>>FactoryIQ\backend\app\models.py
echo.>>FactoryIQ\backend\app\models.py
echo class OpcTag(BaseModel):>>FactoryIQ\backend\app\models.py
echo     id: int>>FactoryIQ\backend\app\models.py
echo     server_id: int>>FactoryIQ\backend\app\models.py
echo     browse_name: str>>FactoryIQ\backend\app\models.py
echo     node_id: str>>FactoryIQ\backend\app\models.py
echo     data_type: str>>FactoryIQ\backend\app\models.py
echo     description: str ^| None = None>>FactoryIQ\backend\app\models.py
echo     polling_interval: int ^| None = 10>>FactoryIQ\backend\app\models.py
echo.>>FactoryIQ\backend\app\models.py
echo class OpcData(BaseModel):>>FactoryIQ\backend\app\models.py
echo     id: int>>FactoryIQ\backend\app\models.py
echo     tag_id: int>>FactoryIQ\backend\app\models.py
echo     value: float>>FactoryIQ\backend\app\models.py
echo     timestamp: str>>FactoryIQ\backend\app\models.py
echo     status: str>>FactoryIQ\backend\app\models.py
echo.>>FactoryIQ\backend\app\models.py
echo class User(BaseModel):>>FactoryIQ\backend\app\models.py
echo     id: int>>FactoryIQ\backend\app\models.py
echo     username: str>>FactoryIQ\backend\app\models.py
echo     email: str>>FactoryIQ\backend\app\models.py
echo     role: str>>FactoryIQ\backend\app\models.py

REM Routers
echo from fastapi import APIRouter>FactoryIQ\backend\app\routers\servers.py
echo from ..models import OpcServer>>FactoryIQ\backend\app\routers\servers.py
echo.>>FactoryIQ\backend\app\routers\servers.py
echo router = APIRouter(prefix="/servers", tags=["servers"])>>FactoryIQ\backend\app\routers\servers.py
echo.>>FactoryIQ\backend\app\routers\servers.py
echo @router.get("/", response_model=list[OpcServer])>>FactoryIQ\backend\app\routers\servers.py
echo def list_servers():>>FactoryIQ\backend\app\routers\servers.py
echo     return []>>FactoryIQ\backend\app\routers\servers.py
echo.>>FactoryIQ\backend\app\routers\servers.py
echo @router.post("/", response_model=OpcServer)>>FactoryIQ\backend\app\routers\servers.py
echo def create_server(server: OpcServer):>>FactoryIQ\backend\app\routers\servers.py
echo     return server>>FactoryIQ\backend\app\routers\servers.py

REM Main app
echo from fastapi import FastAPI>FactoryIQ\backend\app\main.py
echo from .routers import servers>>FactoryIQ\backend\app\main.py
echo.>>FactoryIQ\backend\app\main.py
echo app = FastAPI(^>>FactoryIQ\backend\app\main.py
echo     title="FactoryIQ API",^>>FactoryIQ\backend\app\main.py
echo     description="OPC-UA Historian Backend for FactoryIQ",^>>FactoryIQ\backend\app\main.py
echo     version="0.1.0"^>>FactoryIQ\backend\app\main.py
echo )>>FactoryIQ\backend\app\main.py
echo.>>FactoryIQ\backend\app\main.py
echo app.include_router(servers.router)>>FactoryIQ\backend\app\main.py
echo.>>FactoryIQ\backend\app\main.py
echo @app.get("/")>>FactoryIQ\backend\app\main.py
echo def root():>>FactoryIQ\backend\app\main.py
echo     return {"msg": "FactoryIQ backend is running!"}>>FactoryIQ\backend\app\main.py

REM requirements.txt
echo fastapi>FactoryIQ\backend\requirements.txt
echo uvicorn[standard]>>FactoryIQ\backend\requirements.txt
echo python-dotenv>>FactoryIQ\backend\requirements.txt
echo pyodbc>>FactoryIQ\backend\requirements.txt
echo pydantic>>FactoryIQ\backend\requirements.txt

REM .env.example
echo DB_SERVER=localhost\HISTORIAN>FactoryIQ\backend\.env.example
echo DB_NAME=OpcUaSystem>>FactoryIQ\backend\.env.example
echo DB_USER=sa>>FactoryIQ\backend\.env.example
echo DB_PASS=password>>FactoryIQ\backend\.env.example
echo DB_DRIVER=ODBC Driver 18 for SQL Server>>FactoryIQ\backend\.env.example

REM Папки фронта и структура
mkdir FactoryIQ\frontend\src\api
mkdir FactoryIQ\frontend\src\pages
mkdir FactoryIQ\frontend\public

REM README.md
echo # FactoryIQ>FactoryIQ\README.md
echo.>>FactoryIQ\README.md
echo ## Backend>>FactoryIQ\README.md
echo cd backend>>FactoryIQ\README.md
echo python -m venv venv>>FactoryIQ\README.md
echo venv\Scripts\activate>>FactoryIQ\README.md
echo pip install -r requirements.txt>>FactoryIQ\README.md
echo uvicorn app.main:app --reload>>FactoryIQ\README.md
echo.>>FactoryIQ\README.md
echo ## Frontend>>FactoryIQ\README.md
echo cd frontend>>FactoryIQ\README.md
echo npm install>>FactoryIQ\README.md
echo npm run dev>>FactoryIQ\README.md

echo Готово!
pause
