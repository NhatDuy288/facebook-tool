@echo off
setlocal
set "FACEBOOK_TOOL_ACTION_TABS=3"
call "%~dp0Start-Tool.cmd"
exit /b %errorlevel%
