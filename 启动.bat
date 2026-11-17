@echo off
rem This file is UTF-8 (no BOM) + CRLF. cmd decodes a batch file with the console
rem code page, and switching it mid-file misaligns later lines. So if the console
rem is not already UTF-8 (65001), switch it and re-run this file in a fresh cmd
rem that parses everything as UTF-8 from the first line. Keep this header ASCII.
for /f "tokens=*" %%a in ('chcp') do for %%b in (%%a) do set "_GCAM_OLDCP=%%b"
if "%_GCAM_OLDCP%"=="65001" goto utf8_ready
chcp 65001 >nul
"%ComSpec%" /d /s /c ""%~f0" %*"
set "_GCAM_RC=%errorlevel%"
chcp %_GCAM_OLDCP% >nul
exit /b %_GCAM_RC%
:utf8_ready
rem 以下内容按 UTF-8 解析，可以放中文。
setlocal EnableExtensions
cd /d "%~dp0"
title GCAM-China Studio

if not exist "frontend\dist\index.html" goto build_web
:web_ready

echo [环境] 正在检查 Python 运行环境...
rem 1) 优先使用 runtime\venv。
call :try_py "runtime\venv\Scripts\python.exe" && goto run
rem 2) 其次使用之前在本机配置好的 runtime\venv-local。
call :try_py "runtime\venv-local\Scripts\python.exe" && goto run

echo [环境] 本机还没有配置运行环境，开始自动配置，只需一次。
call :find_base_python
if not defined BASEPY goto no_python
echo [环境] 使用本机 Python：%BASEPY%

rem 3) 本机是 Python 3.13：让 runtime\venv 改用本机解释器，直接复用里面的依赖包。
"%BASEPY%" -c "import sys; sys.exit(sys.version_info[:2] != (3, 13))" >nul 2>&1
if errorlevel 1 goto rebuild
echo [环境] 版本为 3.13，复用 runtime\venv 中的依赖包，无需联网
"%BASEPY%" -c "import os, sys; open(r'runtime\venv\pyvenv.cfg', 'w', encoding='utf-8').write('home = %%s\ninclude-system-site-packages = false\nversion = %%s\nexecutable = %%s\n' %% (os.path.dirname(sys.executable), sys.version.split()[0], sys.executable))"
call :try_py "runtime\venv\Scripts\python.exe" && goto run
echo [环境] 复用失败，改为新建独立环境。

:rebuild
rem 4) 其他版本：新建 runtime\venv-local 并联网安装依赖。
echo [环境] 正在创建 runtime\venv-local 并安装依赖，需要联网，约 3-10 分钟
"%BASEPY%" -m venv "runtime\venv-local"
if errorlevel 1 goto venv_failed
set "LPY=runtime\venv-local\Scripts\python.exe"
set "HTTP_PROXY=http://127.0.0.1:1080"
set "HTTPS_PROXY=http://127.0.0.1:1080"
set "ALL_PROXY=http://127.0.0.1:1080"
set "NO_PROXY=127.0.0.1,localhost"
for /l %%A in (1,1,3) do (
  echo [网络] 本地代理下载尝试 %%A/3
  "%LPY%" -m pip install --retries 0 --timeout 20 --disable-pip-version-check -r backend\requirements.txt
  if not errorlevel 1 goto pip_done
)
echo [网络] 本地代理连续失败三次，改为直连下载。
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
"%LPY%" -m pip install --retries 0 --timeout 20 --disable-pip-version-check -r backend\requirements.txt
if not errorlevel 1 goto pip_done
echo [环境] 默认源下载失败，切换到清华镜像重试
"%LPY%" -m pip install --disable-pip-version-check -r backend\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
if not errorlevel 1 goto pip_done
echo [环境] 清华镜像下载失败，切换到阿里云镜像重试
"%LPY%" -m pip install --disable-pip-version-check -r backend\requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com
if errorlevel 1 goto pip_failed
:pip_done
call :try_py "%LPY%" && goto run
goto import_failed

:run
echo [启动] Python：%PY%
echo.
"%PY%" backend\run_server.py --host 0.0.0.0 --port 8765
echo.
echo [停止] 服务已停止。
pause
exit /b 0

rem ---------------------------------------------------------------------------
:try_py
if not exist "%~1" exit /b 1
"%~1" -c "import uvicorn, fastapi, pandas, lxml, openpyxl" >nul 2>&1
if errorlevel 1 exit /b 1
set "PY=%~1"
exit /b 0

:find_base_python
set "BASEPY="
rem 优先 3.13：与 runtime\venv 版本一致，不需要下载依赖。
for %%P in ("%LOCALAPPDATA%\Programs\Python\Python313\python.exe" "%ProgramFiles%\Python313\python.exe") do (
  if not defined BASEPY if exist "%%~P" set "BASEPY=%%~P"
)
for %%V in (3.13 3.12 3.14 3.11) do (
  if not defined BASEPY for /f "delims=" %%P in ('py -%%V -c "import sys; print(sys.executable)" 2^>nul') do set "BASEPY=%%P"
)
if not defined BASEPY for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)" 2^>nul') do set "BASEPY=%%P"
exit /b 0

:build_web
echo [前端] 未找到构建产物，正在执行 npm run build:web 
call npm run build:web
if errorlevel 1 goto web_failed
goto web_ready

:web_failed
echo [错误] 前端构建失败，请查看上面的 npm 输出。
pause
exit /b 1

:no_python
echo.
echo [错误] 本机没有找到可用的 Python。可以任选一种方式解决：
echo   1. 安装 Python 3.13：https://www.python.org/downloads/
echo      安装时勾选 "Add python.exe to PATH"，装好后重新运行本脚本。
echo   2. 使用免安装版：解压免安装包，运行 win-unpacked\GCAM-China Studio.exe，
echo      不需要 Python。
pause
exit /b 1

:venv_failed
echo.
echo [错误] 用 %BASEPY% 创建 runtime\venv-local 失败。
pause
exit /b 1

:pip_failed
echo.
echo [错误] 三个下载源都无法安装依赖，通常是网络访问不了 pip 源，例如被公司代理拦截。
echo        请确认网络后重新运行本脚本；仍然失败的话，把这个窗口截图发给我。
pause
exit /b 1

:import_failed
echo.
echo [错误] 依赖已安装，但 Python 无法导入。具体报错：
echo ---------------------------------------------------------------
"%LPY%" -c "import sys; print(sys.version); import uvicorn, fastapi, pandas, lxml, openpyxl"
echo ---------------------------------------------------------------
echo 如果报错中有 "DLL load failed" 或 "Application Control policy has blocked"，
echo 说明 Windows 应用控制策略（Smart App Control / WDAC / AppLocker）拦截了
echo 依赖中的 .pyd 文件，需要 IT 把本目录加入允许规则。
pause
exit /b 1
