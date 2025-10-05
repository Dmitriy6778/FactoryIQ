@echo off
setlocal EnableExtensions
pushd "%~dp0"
title FactoryIQ Toolbox
color 0A

REM Запуск PowerShell-меню
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0FactoryIQ-Setup.ps1"

popd
endlocal
