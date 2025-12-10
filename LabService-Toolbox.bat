@echo off
setlocal EnableExtensions
pushd "%~dp0"

title LabService Toolbox
color 0B

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0LabService-Setup.ps1"

popd
endlocal
