@echo off
REM Переходим в папку backend (где лежит venv и report_worker.py)
cd /d "%~dp0backend"

REM Активируем виртуальное окружение
call venv\Scripts\activate.bat

REM Запускаем воркер
python app\report_worker.py

REM Пауза чтобы окно не закрылось сразу (если запускать вручную)
pause
