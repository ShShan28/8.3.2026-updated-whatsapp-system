@echo off
title WhatsApp Sender Enterprise - Server Logs
color 0A

echo ===================================================
echo      WHATSAPP SENDER ENTERPRISE - STARTUP
echo ===================================================
echo.

:: Step 1: Open XAMPP Control Panel
echo [1] Opening XAMPP Control Panel...
start "" "C:\xampp\xampp-control.exe"

:: Step 2: Start Apache Server
echo [2] Starting Apache Server...
start /MIN "" "C:\xampp\apache\bin\httpd.exe"

:: Wait 3 seconds to let Apache initialize
timeout /t 3 /nobreak >nul

:: NEW Step 3: Open the Website in Google Chrome
echo [3] Launching Web Interface in Chrome...
start chrome "http://localhost/WA-PDF-Sender/"

:: Step 4: Run Python Watermark Server
echo [4] Starting Python Watermark Server...
echo.
echo ================= WATERMARK LOGS ==================

:: IMPORTANT: Change this path to where your server.py file is located!
cd "C:\xampp\htdocs\WA-PDF-Sender" 

:: Run the python script. This window will stay open to show logs.
python server.py

:: If the server crashes or is closed, pause so you can read the error
pause