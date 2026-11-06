@echo off
setlocal
cd /d "%~dp0"
title Downlink

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Python 3 was not found.
  echo   Install it from https://www.python.org/downloads/ and make sure
  echo   "Add python.exe to PATH" is checked during setup.
  echo.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo   First run - setting up Downlink, this takes about a minute...
  echo.
  python -m venv .venv
  if errorlevel 1 goto :fail
  ".venv\Scripts\python.exe" -m pip install --upgrade pip --disable-pip-version-check --quiet
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt --disable-pip-version-check
  if errorlevel 1 goto :fail
  echo.
  echo   Setup complete.
)

".venv\Scripts\python.exe" app\main.py
if errorlevel 1 (
  echo.
  echo   Downlink stopped with an error. See the messages above.
  pause
)
exit /b 0

:fail
echo.
echo   Setup failed. Check your internet connection and try again.
pause
exit /b 1
