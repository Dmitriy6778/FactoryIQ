@echo off
cd D:\My_Business\AltaiMai\FactoryIQ\backend
call venv\Scripts\activate.bat

set FERNET_KEY=Z3Vls19NlJWSwECAQF7vxEBStOvACn97aPS9fjPileQ=
start "PollingWorker" cmd /k python app\polling_worker.py

echo === Worker Запущен ===
pause
