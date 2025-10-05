@echo off
REM Получить абсолютный путь к корню проекта (где лежит этот bat-файл)
set "ROOT=%~dp0"
cd /d "%ROOT%"

REM --- АКТИВАЦИЯ PYTHON ОКРУЖЕНИЯ ---
call backend\venv\Scripts\activate.bat

REM --- ЗАПУСК FASTAPI (бэкенд) ---
start "FastAPI" cmd /k cd /d "%ROOT%backend" ^&^& uvicorn app.main:app --host 0.0.0.0 --port 8000


