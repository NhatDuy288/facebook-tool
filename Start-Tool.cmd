@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Can cai Node.js 24 truoc khi chay tool.
  pause
  exit /b 1
)
node -e "if(process.versions.node.split('.')[0]!=='24')process.exit(1)"
if errorlevel 1 (
  echo Tool su dung Node.js 24. Hay chon dung runtime roi mo lai.
  pause
  exit /b 1
)
if not exist sources.local.json (
  echo Hay copy sources.example.json thanh sources.local.json va dien nguon cua ban truoc.
  pause
  exit /b 1
)
if not exist node_modules\playwright-core (
  call npm.cmd install --ignore-scripts
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm.cmd start
pause
