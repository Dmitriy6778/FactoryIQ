@echo off
echo [1/4] Удаление старого окружения (если есть)...
rmdir /s /q venv

echo [2/4] Создание нового виртуального окружения...
python -m venv venv

echo [3/4] Активация окружения...
call venv\Scripts\activate.bat

echo [4/4] Установка зависимостей из requirements.txt...
pip install --upgrade pip
pip install -r requirements.txt

echo Готово!
pause
