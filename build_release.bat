@echo off
title Study Hub - Release Builder (.EXE)
cd /d "%~dp0"

echo ========================================================
echo   Building Standalone StudyHub.exe for Distribution
echo ========================================================
echo.

echo [1/4] Checking build tools...
python -m pip install --quiet --upgrade pyinstaller flask flask-sqlalchemy pywebview pythonnet Pillow pymupdf python-docx openpyxl python-pptx xlrd
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Could not install build tools. Check your internet connection.
    pause
    exit /b 1
)

echo [2/4] Downloading offline UI libraries (Tailwind, icons, fonts)...
python download_vendor.py

echo [3/4] Generating app icon...
python generate_icon.py

echo [4/4] Packaging StudyHub.exe (no console, single file)...
taskkill /F /IM StudyHub.exe >nul 2>&1
python -m PyInstaller --noconfirm --clean --noconsole --onefile ^
    --name "StudyHub" ^
    --icon "app_icon.ico" ^
    --add-data "graduation_study_hub.html;." ^
    --add-data "vendor;vendor" ^
    --add-data "generate_icon.py;." ^
    --collect-all webview ^
    --hidden-import "clr" ^
    --hidden-import "PIL" ^
    --hidden-import "pymupdf" ^
    --hidden-import "docx" ^
    --hidden-import "openpyxl" ^
    --hidden-import "pptx" ^
    --hidden-import "xlrd" ^
    --hidden-import "sqlalchemy.sql.default_comparator" ^
    --exclude-module "torch" ^
    --exclude-module "torchvision" ^
    --exclude-module "torchaudio" ^
    --exclude-module "tensorflow" ^
    --exclude-module "cv2" ^
    --exclude-module "scipy" ^
    --exclude-module "matplotlib" ^
    --exclude-module "pandas" ^
    --exclude-module "IPython" ^
    --exclude-module "notebook" ^
    --exclude-module "pytest" ^
    server.py

echo.
if exist "build" rmdir /s /q "build"
if exist "StudyHub.spec" del /f /q "StudyHub.spec"

if exist "dist\StudyHub.exe" (
    echo ========================================================
    echo   SUCCESS! Your app is ready:
    echo   %~dp0dist\StudyHub.exe
    echo.
    echo   Share this single file with anyone - no Python needed.
    echo   User data is stored next to the exe, or in
    echo   %%LOCALAPPDATA%%\GraduationStudyHub if that folder is read-only.
    echo ========================================================
) else (
    echo [ERROR] Build failed. Check the output above.
)
pause
