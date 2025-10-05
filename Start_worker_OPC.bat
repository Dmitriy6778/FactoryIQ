@echo off
REM Переходим в папку backend из корня проекта
cd /d "%~dp0backend"

REM Активируем виртуальное окружение
call venv\Scripts\activate.bat

REM Устанавливаем переменную окружения для ключа FERNET (если требуется)
set FERNET_KEY=Z3Vls19NlJWSwECAQF7vxEBStOvACn97aPS9fjPileQ=

REM Запускаем Polling Worker
start "PollingWorker" cmd /k python app\polling_worker.py

echo === Worker Запущен ===
pause
