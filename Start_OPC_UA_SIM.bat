@echo off
REM Перейти в папку backend (корень проекта)
cd D:\My_Business\AltaiMai\FactoryIQ\backend

REM --- АКТИВАЦИЯ PYTHON ОКРУЖЕНИЯ ---
call venv\Scripts\activate.bat

REM --- ЗАПУСК OPC SIM ---
start "OPC_SIM" cmd /k python app\opc_sim_server.py

echo === Simulator OPC-UA Запущен ===
pause
