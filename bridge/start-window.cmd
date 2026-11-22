@echo off
cd /d "%~dp0"
start "WoWGPT bridge" cmd /k node supervisor.js
