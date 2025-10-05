@echo off
REM Получить абсолютный путь к корню проекта (где лежит этот батник)
set "ROOT=%~dp0"
cd /d "%ROOT%"

REM --- АКТИВАЦИЯ PYTHON ОКРУЖЕНИЯ ---
call backend\venv\Scripts\activate.bat

REM --- ЗАПУСК FASTAPI (бэкенд) ---
start "FastAPI" cmd /k cd /d "%ROOT%backend" ^&^& uvicorn app.main:app --host 0.0.0.0 --port 8000

REM --- ЗАДЕРЖКА 2 секунды ---
timeout /t 2

REM --- ЗАПУСК POLLING WORKER ---
start "PollingWorker" cmd /k cd /d "%ROOT%backend" ^&^& python app\polling_worker.py

REM --- ЗАПУСК ФРОНТА (Vite/React) ---
start "Frontend" cmd /k cd /d "%ROOT%frontend\FactoryIQ-UI" ^&^& npm run dev

echo === ВСЕ ПРОЦЕССЫ ЗАПУЩЕНЫ ===
pause
