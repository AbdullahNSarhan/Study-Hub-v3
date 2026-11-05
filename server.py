import sys
import os
import platform
import subprocess
import importlib
import importlib.util
import logging

sys.dont_write_bytecode = True
os.environ.setdefault("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--use-fake-ui-for-media-stream")

# --- Hide Console Window on Windows (Native App Mode) ---
if platform.system() == 'Windows' and '--debug' not in sys.argv:
    try:
        import ctypes
        hwnd = ctypes.windll.kernel32.GetConsoleWindow()
        if hwnd:
            ctypes.windll.user32.ShowWindow(hwnd, 0)  # SW_HIDE = 0
    except Exception:
        pass


def get_base_dirs():
    """Return (RESOURCE_DIR, DATA_DIR).
    - RESOURCE_DIR: where bundled read-only files (HTML, icon) live (_MEIPASS in PyInstaller --onefile).
    - DATA_DIR: writable folder for study_hub.db, StudyHub_Files, StudyHub_Backups, webview_data.
    """
    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(sys.executable)
        resource_dir = getattr(sys, '_MEIPASS', exe_dir)
        # Check if exe_dir is writable (portable mode); otherwise use %LOCALAPPDATA%\StudyHub
        test_path = os.path.join(exe_dir, '.write_test')
        try:
            with open(test_path, 'w') as f:
                f.write('ok')
            os.remove(test_path)
            data_dir = exe_dir
        except OSError:
            local_app = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
            data_dir = os.path.join(local_app, 'GraduationStudyHub')
            os.makedirs(data_dir, exist_ok=True)
    else:
        resource_dir = os.path.dirname(os.path.abspath(__file__))
        data_dir = resource_dir
    return resource_dir, data_dir


RESOURCE_DIR, BASE_DIR = get_base_dirs()

# Redirect stdout/stderr safely when running windowless (pythonw.exe or PyInstaller --noconsole)
if sys.stdout is None or sys.stderr is None:
    null_stream = open(os.devnull, 'w')
    if sys.stdout is None:
        sys.stdout = null_stream
    if sys.stderr is None:
        sys.stderr = null_stream

# --- Dependency Auto-Installer ---
REQUIRED_PACKAGES = {
    'flask': 'flask',
    'flask_sqlalchemy': 'flask-sqlalchemy',
    'webview': 'pywebview',
    'PIL': 'Pillow',
    'pymupdf': 'pymupdf',
    'docx': 'python-docx',
    'openpyxl': 'openpyxl',
    'pptx': 'python-pptx',
}
if platform.system() == 'Windows':
    REQUIRED_PACKAGES['clr'] = 'pythonnet'


def ensure_dependencies():
    if getattr(sys, 'frozen', False):
        return
    missing = [pip for mod, pip in REQUIRED_PACKAGES.items() if importlib.util.find_spec(mod) is None]
    if not missing:
        return
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", *missing],
            creationflags=subprocess.CREATE_NO_WINDOW if platform.system() == 'Windows' else 0
        )
        importlib.invalidate_caches()
    except subprocess.CalledProcessError as e:
        print(f"Failed to install packages automatically: {e}")
        sys.exit(1)


ensure_dependencies()

# --- Main Application Imports ---
import io
import re
import json
import time
import glob
import shutil
import socket
import tempfile
import threading
import webbrowser
import html as html_lib
from datetime import datetime
from urllib.parse import urlparse

import webview
import flask.cli
from flask import Flask, request, jsonify, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename

# Silence Flask / Werkzeug console banners & noisy logs
flask.cli.show_server_banner = lambda *args, **kwargs: None
logging.getLogger('werkzeug').setLevel(logging.ERROR)

HTML_FILE = 'graduation_study_hub.html'
DB_FILE = os.path.join(BASE_DIR, 'database.json')            # legacy JSON database
SQLITE_DB_PATH = os.path.join(BASE_DIR, 'study_hub.db')
PDF_DIR = os.path.join(BASE_DIR, 'StudyHub_Files')
BACKUP_DIR = os.path.join(BASE_DIR, 'StudyHub_Backups')
DEFAULT_EXPORT_DIR = os.path.join(BASE_DIR, 'StudyHub_Converted_PDFs')
SOUNDS_DIR = os.path.join(BASE_DIR, 'StudyHub_Sounds')
WEBVIEW_DATA_DIR = os.path.join(BASE_DIR, 'webview_data')
os.makedirs(PDF_DIR, exist_ok=True)
os.makedirs(BACKUP_DIR, exist_ok=True)
os.makedirs(DEFAULT_EXPORT_DIR, exist_ok=True)
os.makedirs(SOUNDS_DIR, exist_ok=True)

PREFERRED_PORT = 8765        # fixed port => the window's saved settings survive restarts
START_FULLSCREEN = False     # start as a maximized native desktop window with titlebar controls (F11 toggles fullscreen)
KEEP_BACKUPS = 14            # how many daily snapshots to keep
ALLOWED_EXT = {'.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv',
               '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.txt', '.md', '.zip',
               '.webm', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
               '.mp4', '.mkv', '.mov', '.avi', '.m4v', '.wmv'}
CONVERTIBLE_EXT = {'.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
                   '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.txt', '.md', '.csv'}
SOUND_EXT = {'.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm'}
ZEN_VIDEO_EXT = {'.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v', '.ogg', '.gif', '.webp'}
SAFE_ID = re.compile(r'^[A-Za-z0-9_\-]{1,100}$')

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{SQLITE_DB_PATH}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['MAX_CONTENT_LENGTH'] = 1024 * 1024 * 1024   # 1 GB per upload request

db = SQLAlchemy(app)

ALLOWED_ORIGINS = set()
is_fullscreen_state = START_FULLSCREEN


# --- Database Models ---
class AppState(db.Model):
    """The whole workspace (subjects, notes, tasks, flashcards, deadlines, links,
    whiteboards, activity, folders, ...) as one JSON document."""
    __tablename__ = 'app_state'

    id = db.Column(db.Integer, primary_key=True)
    data = db.Column(db.Text, nullable=False)
    updated_at = db.Column(db.String(40), nullable=False)


class Subject(db.Model):
    """Legacy table - only read once, to migrate old databases into AppState."""
    __tablename__ = 'subjects'

    id = db.Column(db.String(100), primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    code = db.Column(db.String(50), nullable=True)


class StudyFile(db.Model):
    """Registry of the physical files stored in StudyHub_Files."""
    __tablename__ = 'study_files'

    id = db.Column(db.Integer, primary_key=True)
    filename = db.Column(db.String(255), unique=True, nullable=False)
    original_name = db.Column(db.String(255), nullable=False)
    folder = db.Column(db.String(100), default='Lectures')
    subject_id = db.Column(db.String(100), nullable=False)

    def to_dict(self):
        return {
            "filename": self.filename,
            "original_name": self.original_name,
            "folder": self.folder,
            "subject_id": self.subject_id,
        }


# --- Helpers ---
def open_file_natively(filepath):
    """Cross-platform system file opener."""
    system_name = platform.system()
    if system_name == 'Windows':
        os.startfile(filepath)
    elif system_name == 'Darwin':
        subprocess.run(['open', filepath], check=True)
    else:
        subprocess.run(['xdg-open', filepath], check=True)


DEFAULT_FOLDERS = ["Lectures", "Tutorials", "Assignments", "Quizzes", "Labs", "References"]


def build_state_from_legacy():
    """Build a UI state from the old subjects/study_files tables (pre-fix databases)."""
    subjects = Subject.query.all()
    if not subjects:
        return None
    files = StudyFile.query.all()
    state = {"subjects": [], "pdfs": []}
    for s in subjects:
        folders = list(DEFAULT_FOLDERS)
        for f in files:
            if f.subject_id == s.id and f.folder and f.folder not in folders:
                folders.append(f.folder)
        state["subjects"].append({
            "id": s.id, "name": s.name, "icon": "fa-book-open",
            "color": "from-indigo-600 via-violet-600 to-purple-600", "folders": folders,
        })
    for f in files:
        state["pdfs"].append({
            "id": "file_" + f.filename, "subjectId": f.subject_id,
            "original_name": f.original_name, "filename": f.filename,
            "folder": f.folder or "Lectures",
        })
    return state


def snapshot_before_overwrite(old_json):
    """Keep one snapshot per day (the state at the start of that day) + prune old ones."""
    try:
        path = os.path.join(BACKUP_DIR, f"state_{datetime.now():%Y-%m-%d}.json")
        if not os.path.exists(path):
            with open(path, 'w', encoding='utf-8') as f:
                f.write(old_json)
        backups = sorted(glob.glob(os.path.join(BACKUP_DIR, 'state_*.json')))
        for old in backups[:-KEEP_BACKUPS]:
            os.remove(old)
    except Exception as e:
        print(f"Backup warning: {e}")


def initialize_database():
    """Create tables and migrate legacy data (database.json and the old subjects table)."""
    with app.app_context():
        db.create_all()

        # 1) legacy database.json -> legacy tables
        if os.path.exists(DB_FILE):
            try:
                with open(DB_FILE, 'r', encoding='utf-8') as f:
                    content = f.read().strip()
                if content:
                    data = json.loads(content)
                    for sub_data in data.get('subjects', []):
                        if db.session.get(Subject, sub_data['id']):
                            continue
                        db.session.add(Subject(
                            id=sub_data['id'],
                            name=sub_data.get('name', 'Unnamed Subject'),
                            code=sub_data.get('code', '')))
                        for file_info in sub_data.get('files', []):
                            if StudyFile.query.filter_by(filename=file_info['filename']).first():
                                continue
                            db.session.add(StudyFile(
                                filename=file_info['filename'],
                                original_name=file_info.get('original_name', file_info['filename']),
                                folder=file_info.get('folder', 'Lectures'),
                                subject_id=sub_data['id']))
                    db.session.commit()
                os.replace(DB_FILE, f"{DB_FILE}.bak")
            except Exception as e:
                db.session.rollback()
                print(f"Migration error: {e}")

        # 2) legacy tables -> AppState (only once)
        if db.session.get(AppState, 1) is None:
            legacy = build_state_from_legacy()
            if legacy:
                db.session.add(AppState(id=1, data=json.dumps(legacy, ensure_ascii=False),
                                        updated_at=datetime.now().isoformat()))
                db.session.commit()


# --- Security: only accept requests that come from our own page ---
@app.before_request
def check_origin():
    host = request.headers.get('Host', '')
    if ALLOWED_ORIGINS and f"http://{host}" not in ALLOWED_ORIGINS:
        return jsonify({"error": "Forbidden host"}), 403
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            return jsonify({"error": "Forbidden origin"}), 403


# --- API Endpoints ---
@app.route('/')
def index():
    # Prefer live disk HTML when running inside the project folder so UI updates take effect immediately,
    # otherwise serve the bundled HTML from RESOURCE_DIR (_MEIPASS) for standalone distribution.
    candidates = [
        BASE_DIR,
        os.path.dirname(BASE_DIR),
        RESOURCE_DIR,
    ]
    best_dir = RESOURCE_DIR
    best_mtime = -1
    for d in candidates:
        p = os.path.join(d, HTML_FILE)
        if os.path.isfile(p):
            mt = os.path.getmtime(p)
            if mt > best_mtime:
                best_mtime = mt
                best_dir = d
    return send_from_directory(best_dir, HTML_FILE, max_age=0)


@app.route('/vendor/<path:filename>')
def serve_vendor(filename):
    """Bundled offline copies of Tailwind / Font Awesome / fonts (optional)."""
    vendor_dir = os.path.join(RESOURCE_DIR, 'vendor')
    if not os.path.isfile(os.path.join(vendor_dir, filename)):
        return ('', 404)
    return send_from_directory(vendor_dir, filename, max_age=86400)


@app.route('/api/data', methods=['GET', 'POST'])
def manage_data():
    row = db.session.get(AppState, 1)

    if request.method == 'POST':
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or not isinstance(data.get('subjects'), list):
            return jsonify({"error": "Invalid data"}), 400

        if row is None:
            row = AppState(id=1, data='{}', updated_at='')
            db.session.add(row)
        elif row.data and row.data != '{}':
            snapshot_before_overwrite(row.data)

        row.data = json.dumps(data, ensure_ascii=False)
        row.updated_at = datetime.now().isoformat()
        db.session.commit()
        return jsonify({"status": "success"})

    if row is None:
        return jsonify({})
    try:
        return jsonify(json.loads(row.data))
    except (ValueError, TypeError):
        return jsonify({"error": "Stored data is damaged. Restore from StudyHub_Backups."}), 500


@app.route('/api/upload_file', methods=['POST'])
def upload_file():
    files = request.files.getlist('files[]')
    if not files:
        return jsonify({"error": "No files selected"}), 400

    subject_id = request.form.get('subject_id', '')
    folder_name = (request.form.get('folder') or 'Lectures')[:100]
    if not SAFE_ID.match(subject_id):
        return jsonify({"error": "Invalid subject"}), 400

    uploaded, skipped = [], []
    for file in files:
        if not file or not file.filename:
            continue
        stem, ext = os.path.splitext(file.filename)
        ext = ext.lower()
        if ext not in ALLOWED_EXT:
            skipped.append(file.filename)
            continue

        safe_stem = secure_filename(stem)[:60] or 'file'
        unique_filename = f"{subject_id}_{os.urandom(4).hex()}_{safe_stem}{ext}"
        file.save(os.path.join(PDF_DIR, unique_filename))

        record = StudyFile(filename=unique_filename, original_name=file.filename,
                           folder=folder_name, subject_id=subject_id)
        db.session.add(record)
        uploaded.append(record.to_dict())

    db.session.commit()
    if not uploaded and skipped:
        return jsonify({"error": f"Unsupported file type: {', '.join(skipped)}"}), 400
    return jsonify({"status": "success", "files": uploaded, "skipped": skipped})


@app.route('/files/<path:filename>')
def serve_file(filename):
    return send_from_directory(PDF_DIR, filename, conditional=True)


@app.route('/api/delete_file/<path:filename>', methods=['DELETE'])
def delete_file(filename):
    safe_name = secure_filename(filename)
    filepath = os.path.join(PDF_DIR, safe_name)

    record = StudyFile.query.filter_by(filename=safe_name).first()
    if record:
        db.session.delete(record)
        db.session.commit()

    if os.path.isfile(filepath):
        try:
            os.remove(filepath)
        except OSError as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"status": "success"})


@app.route('/api/open_file/<path:filename>', methods=['GET'])
def open_native_file(filename):
    safe_name = secure_filename(filename)
    filepath = os.path.join(PDF_DIR, safe_name)

    if os.path.isfile(filepath):
        try:
            open_file_natively(filepath)
            return jsonify({"status": "success"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "File not found"}), 404


@app.route('/api/open_url', methods=['GET'])
def open_url():
    """Open a saved link in the user's real browser."""
    url = request.args.get('url', '')
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return jsonify({"error": "Only http/https links are allowed"}), 400
    webbrowser.open(url)
    return jsonify({"status": "success"})


@app.route('/api/toggle_fullscreen', methods=['POST'])
def toggle_fullscreen():
    """Toggle native window fullscreen state."""
    global is_fullscreen_state
    try:
        if webview.windows:
            webview.windows[0].toggle_fullscreen()
            is_fullscreen_state = not is_fullscreen_state
        return jsonify({"status": "success", "fullscreen": is_fullscreen_state})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/window_mode', methods=['POST'])
def api_window_mode():
    """Set native window mode explicitly to 'fullscreen' or 'windowed'."""
    global is_fullscreen_state
    payload = request.get_json(silent=True) or {}
    target_mode = (payload.get('mode') or 'windowed').strip().lower()
    want_fullscreen = (target_mode == 'fullscreen')
    try:
        if webview.windows and (bool(is_fullscreen_state) != want_fullscreen):
            webview.windows[0].toggle_fullscreen()
            is_fullscreen_state = want_fullscreen
        return jsonify({
            "status": "success",
            "fullscreen": is_fullscreen_state,
            "mode": "fullscreen" if is_fullscreen_state else "windowed"
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/exit', methods=['POST'])
def exit_app():
    def _shutdown():
        try:
            for w in list(webview.windows):
                w.destroy()
        except Exception:
            pass
        time.sleep(0.8)
        os._exit(0)

    threading.Timer(0.2, _shutdown).start()
    return jsonify({"status": "exiting"})


# ==============================================================================
# MODULE 1, 2, 3, 4: CONVERTER, ZEN BACKDROPS, SOUND LIBRARY & SYSTEM SETTINGS
# ==============================================================================

def get_saved_settings():
    """Retrieve the user's saved settings dictionary from AppState."""
    try:
        row = db.session.get(AppState, 1)
        if row and row.data:
            parsed = json.loads(row.data)
            if isinstance(parsed, dict) and isinstance(parsed.get('settings'), dict):
                return parsed['settings']
    except Exception:
        pass
    return {}


def resolve_export_dir(override_dir=None):
    """Return a valid writable directory for converted PDFs and backups."""
    candidates = []
    if override_dir and str(override_dir).strip():
        candidates.append(str(override_dir).strip())
    saved = get_saved_settings().get('defaultSaveLocation', '').strip()
    if saved:
        candidates.append(saved)
    candidates.append(DEFAULT_EXPORT_DIR)

    for folder in candidates:
        try:
            os.makedirs(folder, exist_ok=True)
            test_file = os.path.join(folder, '.sh_write_test')
            with open(test_file, 'w', encoding='utf-8') as f:
                f.write('ok')
            os.remove(test_file)
            return os.path.abspath(folder)
        except Exception:
            continue
    return os.path.abspath(DEFAULT_EXPORT_DIR)


def _render_html_to_pdf(html_content, output_pdf_path, landscape=False):
    """Render styled HTML content into a paginated vector PDF using PyMuPDF Story."""
    import pymupdf
    mediabox = pymupdf.paper_rect('a4-l' if landscape else 'a4')
    margin = 36
    where = mediabox + (margin, margin, -margin, -margin)
    story = pymupdf.Story(html=html_content)
    writer = pymupdf.DocumentWriter(output_pdf_path)
    more = 1
    while more:
        device = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(device)
        writer.end_page()
    writer.close()
    del writer
    del story


def _convert_image_to_pdf(input_path, output_pdf_path):
    """Convert PNG, JPG, JPEG, WEBP, BMP, GIF images into a standardized PDF."""
    from PIL import Image, ImageOps
    import pymupdf

    doc = pymupdf.open()
    with Image.open(input_path) as img:
        n_frames = getattr(img, 'n_frames', 1)
        # For animated GIFs/WebPs limit to first 20 frames or single frame
        frames_to_render = min(n_frames, 1) if n_frames > 1 else 1
        for frame_idx in range(frames_to_render):
            if n_frames > 1:
                img.seek(frame_idx)
            frame = ImageOps.exif_transpose(img)
            if frame.mode in ('RGBA', 'LA') or (frame.mode == 'P' and 'transparency' in frame.info):
                rgba = frame.convert('RGBA')
                bg = Image.new('RGB', rgba.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.split()[3])
                rgb_img = bg
            else:
                rgb_img = frame.convert('RGB')

            buf = io.BytesIO()
            rgb_img.save(buf, format='JPEG', quality=94)
            img_bytes = buf.getvalue()

            w, h = rgb_img.size
            # Fit cleanly on A4 page (595 x 842 pt) or landscape A4 (842 x 595 pt) with 24pt margin
            if w > h * 1.15:
                pw, ph = 842.0, 595.0
            else:
                pw, ph = 595.0, 842.0
            margin = 24.0
            avail_w, avail_h = pw - 2 * margin, ph - 2 * margin
            scale = min(avail_w / max(w, 1), avail_h / max(h, 1))
            draw_w, draw_h = w * scale, h * scale
            x0 = (pw - draw_w) / 2.0
            y0 = (ph - draw_h) / 2.0

            page = doc.new_page(width=pw, height=ph)
            page.insert_image(pymupdf.Rect(x0, y0, x0 + draw_w, y0 + draw_h), stream=img_bytes)

    doc.save(output_pdf_path, garbage=4, deflate=True)
    doc.close()


def _convert_office_via_com(input_path, output_pdf_path, ext):
    """Attempt high-fidelity conversion using native Microsoft Office COM on Windows."""
    if platform.system() != 'Windows':
        return False
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        return False

    abs_in = os.path.abspath(input_path)
    abs_out = os.path.abspath(output_pdf_path)
    pythoncom.CoInitialize()
    app_com = None
    try:
        if ext in ('.doc', '.docx'):
            app_com = win32com.client.DispatchEx('Word.Application')
            app_com.Visible = False
            app_com.DisplayAlerts = 0
            doc = app_com.Documents.Open(abs_in, ReadOnly=True, Visible=False)
            try:
                doc.ExportAsFixedFormat(OutputFileName=abs_out, ExportFormat=17)
            finally:
                doc.Close(0)
        elif ext in ('.xls', '.xlsx'):
            app_com = win32com.client.DispatchEx('Excel.Application')
            app_com.Visible = False
            app_com.DisplayAlerts = False
            wb = app_com.Workbooks.Open(abs_in, ReadOnly=True)
            try:
                wb.ExportAsFixedFormat(0, abs_out)
            finally:
                wb.Close(False)
        elif ext in ('.ppt', '.pptx'):
            app_com = win32com.client.DispatchEx('PowerPoint.Application')
            pres = app_com.Presentations.Open(abs_in, ReadOnly=1, Untitled=0, WithWindow=0)
            try:
                pres.SaveAs(abs_out, 32)  # ppSaveAsPDF = 32
            finally:
                pres.Close()
        return os.path.isfile(abs_out) and os.path.getsize(abs_out) > 0
    except Exception:
        return False
    finally:
        if app_com is not None:
            try:
                app_com.Quit()
            except Exception:
                pass
        try:
            pythoncom.CoUninitialize()
        except Exception:
            pass


def _convert_docx_fallback(input_path, output_pdf_path, title):
    """Pure-Python fallback for .docx files using python-docx + PyMuPDF Story."""
    import docx
    d = docx.Document(input_path)
    parts = [
        '<html><head><style>',
        'body { font-family: sans-serif; font-size: 11pt; line-height: 1.5; color: #1e293b; }',
        'h1 { font-size: 20pt; color: #0f172a; margin-bottom: 8pt; border-bottom: 1pt solid #cbd5e1; padding-bottom: 4pt; }',
        'h2 { font-size: 15pt; color: #1e293b; margin-top: 12pt; margin-bottom: 6pt; }',
        'h3 { font-size: 12.5pt; color: #334155; margin-top: 10pt; margin-bottom: 4pt; }',
        'p { margin-top: 0; margin-bottom: 7pt; }',
        'table { width: 100%; border-collapse: collapse; margin: 10pt 0; font-size: 9.5pt; }',
        'th, td { border: 0.5pt solid #94a3b8; padding: 5pt 7pt; text-align: left; }',
        'th { background-color: #f1f5f9; font-weight: bold; }',
        '</style></head><body>',
        f'<h1>{html_lib.escape(title)}</h1>'
    ]
    for p in d.paragraphs:
        txt = p.text.strip()
        if not txt:
            continue
        style_name = (p.style.name if p.style else '').lower()
        if 'heading 1' in style_name or 'title' in style_name:
            parts.append(f'<h1>{html_lib.escape(txt)}</h1>')
        elif 'heading 2' in style_name:
            parts.append(f'<h2>{html_lib.escape(txt)}</h2>')
        elif 'heading' in style_name:
            parts.append(f'<h3>{html_lib.escape(txt)}</h3>')
        else:
            run_html = []
            for r in p.runs:
                rt = html_lib.escape(r.text)
                if not rt:
                    continue
                if r.bold:
                    rt = f'<b>{rt}</b>'
                if r.italic:
                    rt = f'<i>{rt}</i>'
                if r.underline:
                    rt = f'<u>{rt}</u>'
                run_html.append(rt)
            joined = ''.join(run_html) or html_lib.escape(txt)
            parts.append(f'<p>{joined}</p>')

    for tbl in d.tables:
        parts.append('<table>')
        for r_idx, row in enumerate(tbl.rows):
            parts.append('<tr>')
            tag = 'th' if r_idx == 0 else 'td'
            for cell in row.cells:
                parts.append(f'<{tag}>{html_lib.escape(cell.text.strip())}</{tag}>')
            parts.append('</tr>')
        parts.append('</table>')

    parts.append('</body></html>')
    _render_html_to_pdf('\n'.join(parts), output_pdf_path, landscape=False)


def _convert_doc_binary_fallback(input_path, output_pdf_path, title):
    """Fallback for legacy .doc files when MS Word is not installed."""
    with open(input_path, 'rb') as f:
        raw = f.read()
    # Extract readable text chunks (both UTF-16LE and ASCII/Latin runs)
    ascii_chunks = re.findall(rb'[\x20-\x7E\r\n\t]{12,}', raw)
    utf16_chunks = re.findall(rb'(?:[\x20-\x7E]\x00){12,}', raw)
    lines = []
    for c in utf16_chunks:
        try:
            lines.append(c.decode('utf-16le', errors='ignore').strip())
        except Exception:
            pass
    if not lines:
        for c in ascii_chunks:
            s = c.decode('latin-1', errors='ignore').strip()
            if not any(k in s for k in ('Word.Document', 'MSWordDoc', 'Normal.dot', 'Root Entry')):
                lines.append(s)
    body_html = ''.join(f'<p>{html_lib.escape(line)}</p>' for line in lines if line) or '<p>(Document converted)</p>'
    html_doc = f'<html><body style="font-family:sans-serif;font-size:11pt;line-height:1.5;"><h1>{html_lib.escape(title)}</h1>{body_html}</body></html>'
    _render_html_to_pdf(html_doc, output_pdf_path, landscape=False)


def _convert_excel_fallback(input_path, output_pdf_path, ext, title):
    """Pure-Python fallback for .xlsx and .xls spreadsheets."""
    parts = [
        '<html><head><style>',
        'body { font-family: sans-serif; font-size: 9pt; color: #0f172a; }',
        'h1 { font-size: 16pt; color: #1e293b; margin-bottom: 4pt; }',
        'h2 { font-size: 12pt; color: #4f46e5; margin-top: 12pt; margin-bottom: 5pt; }',
        'table { width: 100%; border-collapse: collapse; margin-bottom: 14pt; }',
        'th, td { border: 0.5pt solid #cbd5e1; padding: 4pt 6pt; text-align: left; }',
        'th { background-color: #eef2ff; font-weight: bold; color: #1e1b4b; }',
        '</style></head><body>',
        f'<h1>{html_lib.escape(title)}</h1>'
    ]
    if ext == '.xlsx':
        import openpyxl
        wb = openpyxl.load_workbook(input_path, data_only=True)
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            rows = list(ws.iter_rows(values_only=True))
            non_empty = [r for r in rows if any(c is not None and str(c).strip() != '' for c in r)]
            if not non_empty:
                continue
            parts.append(f'<h2>Sheet: {html_lib.escape(sheet_name)}</h2><table>')
            max_cols = max(len(r) for r in non_empty)
            for r_idx, row in enumerate(non_empty[:500]):
                parts.append('<tr>')
                tag = 'th' if r_idx == 0 else 'td'
                for c_idx in range(min(max_cols, 18)):
                    val = row[c_idx] if c_idx < len(row) else ''
                    txt = '' if val is None else str(val)
                    parts.append(f'<{tag}>{html_lib.escape(txt)}</{tag}>')
                parts.append('</tr>')
            parts.append('</table>')
        wb.close()
    else:
        import xlrd
        wb = xlrd.open_workbook(input_path)
        for sheet in wb.sheets():
            if sheet.nrows == 0:
                continue
            parts.append(f'<h2>Sheet: {html_lib.escape(sheet.name)}</h2><table>')
            for r_idx in range(min(sheet.nrows, 500)):
                parts.append('<tr>')
                tag = 'th' if r_idx == 0 else 'td'
                for c_idx in range(min(sheet.ncols, 18)):
                    val = sheet.cell_value(r_idx, c_idx)
                    parts.append(f'<{tag}>{html_lib.escape(str(val))}</{tag}>')
                parts.append('</tr>')
            parts.append('</table>')

    parts.append('</body></html>')
    _render_html_to_pdf('\n'.join(parts), output_pdf_path, landscape=True)


def _convert_pptx_fallback(input_path, output_pdf_path, title):
    """Pure-Python fallback for .pptx presentations using python-pptx + PyMuPDF."""
    from pptx import Presentation
    import pymupdf

    prs = Presentation(input_path)
    doc = pymupdf.open()
    pw, ph = 842.0, 474.0  # 16:9 widescreen PDF page

    if len(prs.slides) == 0:
        page = doc.new_page(width=pw, height=ph)
        page.insert_text((48, 80), title, fontsize=24)

    for idx, slide in enumerate(prs.slides, start=1):
        page = doc.new_page(width=pw, height=ph)
        # Subtle top accent bar & slide footer
        page.draw_rect(pymupdf.Rect(0, 0, pw, 8), color=(0.48, 0.36, 1.0), fill=(0.48, 0.36, 1.0))

        slide_title = ''
        if slide.shapes.title and slide.shapes.title.text:
            slide_title = slide.shapes.title.text.strip()

        bullets = []
        images = []
        for shape in slide.shapes:
            if shape == slide.shapes.title:
                continue
            if getattr(shape, 'has_text_frame', False):
                for para in shape.text_frame.paragraphs:
                    t = para.text.strip()
                    if t:
                        bullets.append((para.level or 0, t))
            if getattr(shape, 'has_table', False):
                for row in shape.table.rows:
                    row_txt = ' | '.join(c.text.strip() for c in row.cells if c.text.strip())
                    if row_txt:
                        bullets.append((0, row_txt))
            if shape.shape_type == 13:  # PICTURE
                try:
                    images.append(shape.image.blob)
                except Exception:
                    pass

        # Render text area via HTMLBox so Unicode / Arabic / styling wraps cleanly
        text_rect = pymupdf.Rect(44, 34, pw - (300 if images else 44), ph - 36)
        html_items = []
        if slide_title:
            html_items.append(f'<h1 style="font-family:sans-serif;font-size:21pt;color:#1e1b4b;margin:0 0 12pt 0;">{html_lib.escape(slide_title)}</h1>')
        for lvl, btxt in bullets:
            indent = lvl * 18
            html_items.append(f'<p style="font-family:sans-serif;font-size:12.5pt;color:#334155;margin:0 0 7pt {indent}pt;">• {html_lib.escape(btxt)}</p>')
        if html_items:
            page.insert_htmlbox(text_rect, '\n'.join(html_items))

        # Place embedded slide images on the right column
        if images:
            img_y = 48.0
            avail_h = (ph - 84.0) / max(len(images[:2]), 1)
            for img_blob in images[:2]:
                try:
                    img_rect = pymupdf.Rect(pw - 280, img_y, pw - 36, img_y + avail_h - 10)
                    page.insert_image(img_rect, stream=img_blob, keep_proportion=True)
                    img_y += avail_h
                except Exception:
                    pass

        page.insert_text((pw - 95, ph - 16), f"Slide {idx} / {len(prs.slides)}", fontsize=9, color=(0.55, 0.58, 0.68))

    doc.save(output_pdf_path, garbage=4, deflate=True)
    doc.close()


def convert_single_file_to_pdf(input_path, output_pdf_path, original_name):
    """Master dispatcher that converts any supported document/spreadsheet/presentation/image to PDF."""
    ext = os.path.splitext(original_name)[1].lower()
    stem = os.path.splitext(original_name)[0]

    if ext in ('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'):
        _convert_image_to_pdf(input_path, output_pdf_path)
        return

    if ext == '.docx':
        _convert_docx_fallback(input_path, output_pdf_path, stem)
        return

    if ext in ('.xlsx', '.xls'):
        _convert_excel_fallback(input_path, output_pdf_path, ext, stem)
        return

    if ext == '.pptx':
        _convert_pptx_fallback(input_path, output_pdf_path, stem)
        return

    if ext in ('.doc', '.ppt'):
        _convert_doc_binary_fallback(input_path, output_pdf_path, stem)
        return

    if ext in ('.txt', '.md', '.csv'):
        with open(input_path, 'r', encoding='utf-8', errors='replace') as f:
            text_data = f.read()
        escaped = '<br>'.join(html_lib.escape(line) for line in text_data.splitlines())
        html_doc = f'<html><body style="font-family:sans-serif;font-size:10.5pt;line-height:1.5;"><h1>{html_lib.escape(stem)}</h1><p>{escaped}</p></body></html>'
        _render_html_to_pdf(html_doc, output_pdf_path, landscape=(ext == '.csv'))
        return

    raise ValueError(f"Unsupported format: {ext}")


@app.route('/api/convert_to_pdf', methods=['POST'])
def api_convert_to_pdf():
    """Convert one or more uploaded documents/images into standardized PDFs in the configured save location."""
    files = request.files.getlist('files[]') or request.files.getlist('file')
    if not files:
        return jsonify({"error": "No files provided for conversion"}), 400

    override_dir = request.form.get('save_dir', '').strip()
    target_dir = resolve_export_dir(override_dir)
    attach_subject = request.form.get('subject_id', '').strip()
    attach_folder = (request.form.get('folder') or 'Lectures')[:100]

    results = []
    errors = []

    for f in files:
        if not f or not f.filename:
            continue
        orig_name = f.filename
        stem, ext = os.path.splitext(orig_name)
        ext = ext.lower()
        if ext not in CONVERTIBLE_EXT:
            errors.append({"file": orig_name, "error": f"Unsupported file extension ({ext})"})
            continue

        # Clean output filename while preserving readable Unicode characters (including Arabic)
        clean_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', stem).strip(' .') or 'Converted_Document'
        pdf_filename = f"{clean_stem}.pdf"
        out_path = os.path.join(target_dir, pdf_filename)
        counter = 2
        while os.path.exists(out_path):
            pdf_filename = f"{clean_stem}_{counter}.pdf"
            out_path = os.path.join(target_dir, pdf_filename)
            counter += 1

        tmp_fd, tmp_in = tempfile.mkstemp(suffix=ext)
        os.close(tmp_fd)
        try:
            f.save(tmp_in)
            convert_single_file_to_pdf(tmp_in, out_path, orig_name)
            size_bytes = os.path.getsize(out_path) if os.path.isfile(out_path) else 0

            subject_record = None
            if attach_subject and SAFE_ID.match(attach_subject):
                safe_stem = secure_filename(stem)[:60] or 'converted'
                hub_filename = f"{attach_subject}_{os.urandom(4).hex()}_{safe_stem}.pdf"
                shutil.copy2(out_path, os.path.join(PDF_DIR, hub_filename))
                rec = StudyFile(
                    filename=hub_filename,
                    original_name=pdf_filename,
                    folder=attach_folder,
                    subject_id=attach_subject
                )
                db.session.add(rec)
                db.session.commit()
                subject_record = rec.to_dict()

            results.append({
                "original_name": orig_name,
                "pdf_name": pdf_filename,
                "output_path": out_path,
                "output_dir": target_dir,
                "size_bytes": size_bytes,
                "subject_file": subject_record
            })
        except Exception as e:
            errors.append({"file": orig_name, "error": str(e)})
        finally:
            try:
                if os.path.exists(tmp_in):
                    os.remove(tmp_in)
            except Exception:
                pass

    return jsonify({
        "status": "success" if results else "error",
        "output_dir": target_dir,
        "results": results,
        "errors": errors
    }), (200 if results else 400)


@app.route('/api/pick_folder', methods=['POST'])
def api_pick_folder():
    """Open a native OS Folder Picker dialog and return the chosen directory path."""
    chosen = None
    try:
        if webview.windows:
            res = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
            if res:
                chosen = res[0] if isinstance(res, (list, tuple)) else str(res)
    except Exception:
        pass

    if not chosen and platform.system() == 'Windows':
        try:
            ps_cmd = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
                "$f.ShowNewFolderButton = $true; "
                "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }"
            )
            out = subprocess.check_output(
                ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps_cmd],
                creationflags=subprocess.CREATE_NO_WINDOW,
                text=True,
                timeout=120
            ).strip()
            if out:
                chosen = out
        except Exception:
            pass

    if chosen and os.path.isdir(chosen):
        return jsonify({"status": "success", "path": os.path.abspath(chosen)})
    return jsonify({"status": "cancelled", "path": None})


@app.route('/api/open_path', methods=['POST'])
def api_open_path():
    """Open a local directory or converted PDF file in the native OS file manager / viewer."""
    payload = request.get_json(silent=True) or {}
    target = (payload.get('path') or '').strip()
    if not target:
        target = resolve_export_dir()
    if os.path.exists(target):
        try:
            open_file_natively(os.path.abspath(target))
            return jsonify({"status": "success", "path": os.path.abspath(target)})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"error": "Path does not exist"}), 404


@app.route('/api/zen_videos', methods=['GET'])
def api_zen_videos():
    """Inspect the configured custom Zen video folder and return available video files or fallback status."""
    folder = (request.args.get('folder') or '').strip()
    if not folder:
        folder = get_saved_settings().get('zenVideoFolder', '').strip()

    if not folder or not os.path.isdir(folder):
        return jsonify({
            "configured": bool(folder),
            "valid_folder": False,
            "empty": True,
            "fallback": True,
            "folder": folder,
            "videos": []
        })

    videos = []
    try:
        for entry in sorted(os.listdir(folder)):
            full = os.path.join(folder, entry)
            ext = os.path.splitext(entry)[1].lower()
            if os.path.isfile(full) and ext in ZEN_VIDEO_EXT and os.path.getsize(full) > 0:
                videos.append({
                    "name": entry,
                    "ext": ext,
                    "size": os.path.getsize(full),
                    "url": f"/api/zen_video_stream?folder={ urllib.parse.quote(folder) }&name={ urllib.parse.quote(entry) }"
                })
    except Exception:
        pass

    return jsonify({
        "configured": True,
        "valid_folder": True,
        "empty": len(videos) == 0,
        "fallback": len(videos) == 0,
        "folder": os.path.abspath(folder),
        "videos": videos
    })


import urllib.parse


@app.route('/api/zen_video_stream', methods=['GET'])
def api_zen_video_stream():
    """Stream a video file from the user's custom Zen Video folder with range support."""
    folder = (request.args.get('folder') or '').strip() or get_saved_settings().get('zenVideoFolder', '').strip()
    name = (request.args.get('name') or '').strip()
    if not folder or not name or not os.path.isdir(folder):
        return jsonify({"error": "Folder not available"}), 404
    base_folder = os.path.abspath(folder)
    target_file = os.path.abspath(os.path.join(base_folder, os.path.basename(name)))
    if not target_file.startswith(base_folder) or not os.path.isfile(target_file):
        return jsonify({"error": "Video file not found"}), 404
    return send_from_directory(base_folder, os.path.basename(name), conditional=True)


@app.route('/api/sounds/upload', methods=['POST'])
def api_upload_sound():
    """Upload custom white noise / ambient audio files (.mp3, .wav, .ogg)."""
    files = request.files.getlist('files[]') or request.files.getlist('file')
    if not files:
        return jsonify({"error": "No audio files selected"}), 400

    uploaded = []
    skipped = []
    for f in files:
        if not f or not f.filename:
            continue
        stem, ext = os.path.splitext(f.filename)
        ext = ext.lower()
        if ext not in SOUND_EXT:
            skipped.append(f.filename)
            continue
        safe_stem = secure_filename(stem)[:50] or 'sound'
        unique_name = f"snd_{os.urandom(4).hex()}_{safe_stem}{ext}"
        f.save(os.path.join(SOUNDS_DIR, unique_name))
        uploaded.append({
            "id": f"custom_{os.urandom(4).hex()}",
            "name": stem.replace('_', ' ').strip() or 'Custom Sound',
            "filename": unique_name,
            "original_name": f.filename,
            "url": f"/sounds/{unique_name}",
            "addedAt": datetime.now().isoformat()
        })

    if not uploaded and skipped:
        return jsonify({"error": f"Unsupported audio format: {', '.join(skipped)}"}), 400
    return jsonify({"status": "success", "sounds": uploaded, "skipped": skipped})


@app.route('/sounds/<path:filename>')
def serve_sound(filename):
    safe_name = secure_filename(filename)
    return send_from_directory(SOUNDS_DIR, safe_name, conditional=True)


@app.route('/api/sounds/<path:filename>', methods=['DELETE'])
def api_delete_sound(filename):
    safe_name = secure_filename(filename)
    path = os.path.join(SOUNDS_DIR, safe_name)
    if os.path.isfile(path):
        try:
            os.remove(path)
        except OSError as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"status": "success"})


def _get_windows_startup_status():
    if platform.system() != 'Windows':
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_READ) as key:
            val, _ = winreg.QueryValueEx(key, "GraduationStudyHub")
            return bool(val)
    except Exception:
        return False


def _set_windows_startup(enabled):
    if platform.system() != 'Windows':
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                if getattr(sys, 'frozen', False):
                    cmd = f'"{sys.executable}"'
                else:
                    vbs_path = os.path.join(RESOURCE_DIR, 'StudyHub.vbs')
                    if os.path.isfile(vbs_path):
                        cmd = f'wscript.exe "{vbs_path}"'
                    else:
                        cmd = f'"{sys.executable}" "{os.path.abspath(__file__)}"'
                winreg.SetValueEx(key, "GraduationStudyHub", 0, winreg.REG_SZ, cmd)
            else:
                try:
                    winreg.DeleteValue(key, "GraduationStudyHub")
                except FileNotFoundError:
                    pass
        return True
    except Exception:
        return False


@app.route('/api/system_info', methods=['GET'])
def api_system_info():
    """Return system defaults, resolved paths, window state, and OS startup registration status."""
    saved_cfg = get_saved_settings()
    return jsonify({
        "defaultExportDir": os.path.abspath(DEFAULT_EXPORT_DIR),
        "resolvedExportDir": resolve_export_dir(),
        "soundsDir": os.path.abspath(SOUNDS_DIR),
        "startupEnabled": _get_windows_startup_status(),
        "fullscreen": bool(is_fullscreen_state),
        "launchWindowMode": saved_cfg.get('launchWindowMode', 'windowed'),
        "platform": platform.system()
    })


@app.route('/api/startup', methods=['GET', 'POST'])
def api_startup():
    """Get or update automatic launch on operating system boot."""
    if request.method == 'POST':
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get('enabled', False))
        ok = _set_windows_startup(enabled)
        return jsonify({"status": "success" if ok else "error", "enabled": _get_windows_startup_status()})
    return jsonify({"enabled": _get_windows_startup_status()})


@app.route('/api/backup_export', methods=['POST'])
def api_backup_export():
    """Save a full JSON backup directly to the configured Default Save Location."""
    payload = request.get_json(silent=True) or {}
    state_data = payload.get('state')
    if not isinstance(state_data, dict):
        row = db.session.get(AppState, 1)
        state_data = json.loads(row.data) if (row and row.data) else {}

    target_dir = resolve_export_dir(payload.get('save_dir'))
    stamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
    filename = f"StudyHub_Backup_{stamp}.json"
    out_path = os.path.join(target_dir, filename)
    try:
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(state_data, f, ensure_ascii=False, indent=2)
        return jsonify({
            "status": "success",
            "filename": filename,
            "path": out_path,
            "dir": target_dir
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/factory_reset', methods=['POST'])
def api_factory_reset():
    """Full factory reset: wipe database records, physical study files, and custom sounds."""
    try:
        row = db.session.get(AppState, 1)
        if row and row.data and row.data != '{}':
            snapshot_before_overwrite(row.data)

        StudyFile.query.delete()
        AppState.query.delete()
        db.session.commit()

        for folder in (PDF_DIR, SOUNDS_DIR):
            if os.path.isdir(folder):
                for entry in os.listdir(folder):
                    fpath = os.path.join(folder, entry)
                    if os.path.isfile(fpath):
                        try:
                            os.remove(fpath)
                        except OSError:
                            pass

        _set_windows_startup(False)
        return jsonify({"status": "success"})
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": str(e)}), 500


# --- Server / Window startup ---
def is_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


def pick_port():
    for port in (PREFERRED_PORT, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("No free port available")


def wait_for_server(port, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.08)
    return False


if __name__ == '__main__':
    icon_path = os.path.join(BASE_DIR, 'app_icon.ico')
    if not os.path.exists(icon_path):
        try:
            from generate_icon import create_app_icon
            create_app_icon(icon_path)
        except Exception:
            pass

    initialize_database()

    with app.app_context():
        saved_launch_mode = get_saved_settings().get('launchWindowMode', 'windowed')
    start_fs = (str(saved_launch_mode).strip().lower() == 'fullscreen')
    is_fullscreen_state = start_fs

    port = pick_port()
    ALLOWED_ORIGINS.update({f"http://127.0.0.1:{port}", f"http://localhost:{port}"})

    threading.Thread(
        target=lambda: app.run(host='127.0.0.1', port=port, threaded=True, use_reloader=False),
        daemon=True).start()

    if not wait_for_server(port):
        sys.exit(1)

    try:
        webview.settings['ALLOW_DOWNLOADS'] = True
    except Exception:
        pass

    window = webview.create_window(
        title='Study Hub',
        url=f'http://127.0.0.1:{port}/',
        width=1380,
        height=860,
        min_size=(960, 620),
        maximized=not start_fs,
        fullscreen=start_fs,
        confirm_close=False,
        text_select=True,
    )
    webview.start(private_mode=False, storage_path=WEBVIEW_DATA_DIR)
