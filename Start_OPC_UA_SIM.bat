@echo off
REM Получить абсолютный путь к корню проекта (где лежит этот bat-файл)
set "ROOT=%~dp0"
cd /d "%ROOT%"

REM --- АКТИВАЦИЯ PYTHON ОКРУЖЕНИЯ ---
call backend\venv\Scripts\activate.bat

REM --- ЗАПУСК OPC SIM ---
start "OPC_SIM" cmd /k cd /d "%ROOT%backend" ^&^& python app\opc_sim_server.py

echo === Simulator OPC-UA Запущен ===
pause
