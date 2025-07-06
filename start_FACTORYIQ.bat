@echo off
REM Перейти в папку backend (корень проекта)
cd D:\My_Business\AltaiMai\FactoryIQ\backend

REM --- АКТИВАЦИЯ PYTHON ОКРУЖЕНИЯ ---
call venv\Scripts\activate.bat

REM --- ЗАПУСК FASTAPI (бэкенд) ---
start "FastAPI" cmd /k uvicorn app.main:app --host 0.0.0.0 --port 8000

REM --- ЗАДЕРЖКА 2 секунды ---
timeout /t 2

REM --- ЗАПУСК ФРОНТА (Vite/React) ---
REM Переходим к frontend/FactoryIQ-UI
cd ..\frontend\FactoryIQ-UI

REM Если не установлен node_modules, раскомментируй строку ниже (удалить REM):
REM call npm install

REM Запуск фронта
start "Frontend" cmd /k npm run dev

REM Вернуться обратно в backend (если потребуется)
cd ..\..

echo === ВСЕ ПРОЦЕССЫ ЗАПУЩЕНЫ ===
pause
