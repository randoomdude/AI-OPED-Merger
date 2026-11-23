"""Windows desktop host for AI OP/ED Merger. Run with Python 3.11."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import winreg
from tempfile import TemporaryDirectory, gettempdir
from threading import Lock, Thread
from urllib.parse import urldefrag

import webview

from lyric_pages import find_lyric_page

DOCS = Path(__file__).resolve().parent / "docs"
PREVIEW_CACHE = Path(gettempdir()) / "AI OP-ED Merger" / "previews-v1"


def preview_cache_path(source):
    info = source.stat()
    identity = json.dumps([os.path.normcase(str(source.resolve())), info.st_size, info.st_mtime_ns])
    return PREVIEW_CACHE / (hashlib.sha256(identity.encode()).hexdigest() + ".mp4")


def remember_preview(output, cached):
    # Linking a finished file publishes it atomically. Playback also works without a cache.
    try:
        cached.parent.mkdir(parents=True, exist_ok=True)
        if not cached.exists():
            os.link(output, cached)
        os.utime(cached)
        entries = (p for p in cached.parent.glob("*.mp4") if re.fullmatch(r"[0-9a-f]{64}", p.stem))
        count = size = 0
        for entry in sorted(entries, key=lambda p: p.stat().st_mtime_ns, reverse=True):
            length = entry.stat().st_size
            if count >= 2 or size + length > 512 * 1024**2:
                entry.unlink(missing_ok=True)
            else:
                count += 1
                size += length
    except OSError:
        pass


def whisper_python():
    if os.environ.get("AI_OPED_PYTHON"):
        return Path(os.environ["AI_OPED_PYTHON"])
    if not getattr(sys, "frozen", False):
        return Path(sys.executable).with_name("python.exe")
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, r"Software\Python\PythonCore\3.11\InstallPath") as key:
                return Path(winreg.QueryValueEx(key, "ExecutablePath")[0])
        except OSError:
            continue
    if path := shutil.which("python"):
        return Path(path)
    raise ValueError("Install Python with OpenAI Whisper, or set AI_OPED_PYTHON to its python.exe.")


class Desktop:
    def __init__(self):
        self._selected = None
        self._job = Lock()
        self._process_lock = Lock()
        self._process = None
        self._closed = False

    def prepare_preview(self, token):
        source = self._episode(token)
        ffmpeg = shutil.which("ffmpeg") or "C:/ffmpeg/bin/ffmpeg.exe"
        with self._preview_lock:
            runner = self._preview_runner
            self._episode(token)
            output = self._preview_folder / (token + ".mp4")
            cached = preview_cache_path(source)
            if not output.exists():
                try:
                    os.link(cached, output)
                except OSError:
                    pass
            if not output.exists():
                if not Path(ffmpeg).is_file():
                    raise ValueError("Install FFmpeg to prepare a compatible video preview.")
                try:
                    runner._run([ffmpeg, "-nostdin", "-v", "error", "-i", str(source),
                        "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:480,format=yuv420p",
                        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-c:a", "aac",
                        "-movflags", "+faststart", str(output)])
                    self._episode(token)
                except Exception:
                    output.unlink(missing_ok=True)
                    raise
            remember_preview(output, cached)
            return self._preview_folder.name + "/" + output.name

    def _attach(self, window):
        self._window = window
        view = window.native.webview
        page = window.real_url

        def navigation(sender, event):
            if urldefrag(str(event.Uri)).url != page:
                event.Cancel = True

        from System import Action

        def reply(data):
            if not view.IsDisposed:
                view.Invoke(Action(lambda: view.CoreWebView2.PostWebMessageAsJson(json.dumps(data))))

        def run_job(message):
            request = message.get("id")
            try:
                methods = {"time_song": self.time_song, "save_mkv": self.save_mkv, "prepare_preview": self.prepare_preview,
                           "find_lyric_page": find_lyric_page}
                result = methods[message["action"]](*message["args"])
                response = {"id": request, "value": result}
            except Exception as error:
                response = {"id": request, "error": str(error)}
            if not self._closed:
                reply(response)

        def message(sender, event):
            if str(event.Source) != page:
                return
            data = json.loads(str(event.WebMessageAsJson))
            if not isinstance(data, dict):
                return
            action = data.get("action")
            if action == "oped_ready":
                sender.CoreWebView2.PostWebMessageAsJson('{"opedDesktop":true}')
            elif action == "episode":
                self._preview_runner._close()
                self._preview_runner = Desktop()
                self._selected = None
                token = data.get("id", "")
                files = list(event.AdditionalObjects or ())
                if re.fullmatch(r"[0-9a-f-]{36}", token) and len(files) == 1 and hasattr(files[0], "Path"):
                    path = Path(str(files[0].Path))
                    if path.is_file() and path.suffix.lower() == ".mkv":
                        self._selected = (token, path, path.stat())
            elif action in ("time_song", "save_mkv", "prepare_preview", "find_lyric_page"):
                Thread(target=run_job, args=(data,)).start()

        view.NavigationStarting += navigation
        view.WebMessageReceived -= window.native.browser.on_script_notify
        view.WebMessageReceived += message

    def _episode(self, token):
        selected = self._selected
        if not selected or token != selected[0]:
            raise ValueError("Choose the episode MKV again.")
        _, path, previous = selected
        current = path.stat()
        if (previous.st_size, previous.st_mtime_ns) != (current.st_size, current.st_mtime_ns):
            raise ValueError("The episode changed on disk. Open it again.")
        return path

    def _run(self, command, *, warnings=False):
        with self._process_lock:
            if self._closed:
                raise ValueError("The app is closing.")
            bundle = getattr(sys, "_MEIPASS", None)
            try:
                if bundle:
                    ctypes.windll.kernel32.SetDllDirectoryW(None)
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace",
                        creationflags=subprocess.CREATE_NO_WINDOW, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
            finally:
                if bundle:
                    ctypes.windll.kernel32.SetDllDirectoryW(bundle)
            self._process = process
        try:
            output = process.communicate()[0]
        finally:
            with self._process_lock:
                self._process = None
        if process.returncode and not (warnings and process.returncode == 1):
            detail = next((line.strip() for line in reversed(output.splitlines()) if line.strip()), "")
            raise ValueError(detail or "The media tool stopped before finishing.")
        return [line.strip() for line in output.splitlines() if line.startswith("Warning:")]

    def _close(self):
        with self._process_lock:
            self._closed = True
            if self._process and self._process.poll() is None:
                self._process.terminate()

    def time_song(self, token, slot, start_ms, end_ms, hint=""):
        path = self._episode(token)
        if slot not in ("OP", "ED") or not all(type(n) in (int, float) for n in (start_ms, end_ms)) or not 0 <= start_ms < end_ms:
            raise ValueError("Choose a song and enter a valid episode start and end.")
        if not self._job.acquire(False):
            raise ValueError("Wait for the current media job to finish.")
        try:
            with TemporaryDirectory(prefix="oped-whisper-") as work:
                result = Path(work) / "timing.json"
                python = whisper_python()
                self._run([str(python), str(DOCS / "whisper-helper.py"), str(path), "--slot", slot,
                           "--start", str(start_ms / 1000), "--end", str(end_ms / 1000), "--output", str(result), "--spelling-hint=" + hint[:160]])
                self._episode(token)
                return json.loads(result.read_text(encoding="utf-8"))
        finally:
            self._job.release()

    def save_mkv(self, token, ass, language):
        source = self._episode(token)
        tool = shutil.which("mkvmerge") or Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "MKVToolNix/mkvmerge.exe"
        if not Path(tool).is_file():
            raise ValueError("Install MKVToolNix for Windows to save a merged MKV.")
        if not self._job.acquire(False):
            raise ValueError("Wait for the current media job to finish.")
        try:
            from System import Action
            choice = None

            proposed = source.with_suffix(".oped.mkv")
            number = 2
            while proposed.exists():
                proposed = source.with_suffix(f".oped ({number}).mkv")
                number += 1

            def choose_destination():
                nonlocal choice
                choice = self._window.create_file_dialog(webview.FileDialog.SAVE, directory=str(source.parent),
                        save_filename=proposed.name, file_types=("Matroska video (*.mkv)",))

            self._window.native.Invoke(Action(choose_destination))
            if not choice:
                return None
            target = Path(choice[0])
            if target.suffix.lower() != ".mkv" or target.exists():
                raise ValueError("Choose a new .mkv filename. That path is in use or has a different extension.")
            # Keep incomplete output private. On Windows rename fails if anything took the chosen name.
            with TemporaryDirectory(prefix=".oped-", dir=target.parent) as work:
                track = Path(work) / "lyrics.ass"
                output = Path(work) / "episode.mkv"
                track.write_text(ass, encoding="utf-8-sig")
                warnings = self._run([str(tool), "--ui-language", "en", "-o", str(output), str(source),
                    "--language", "0:" + (language or "und"), "--track-name", "0:Episode + OP/ED",
                    "--default-track-flag", "0:no", "--forced-display-flag", "0:no", str(track)], warnings=True)
                self._episode(token)
                output.rename(target)
            return {"path": str(target), "warnings": warnings}
        finally:
            self._job.release()


def main():
    api = Desktop()
    webview.settings["ALLOW_DOWNLOADS"] = True
    window = webview.create_window("AI OP/ED Merger", str(DOCS / "index.html"),
                                   width=1100, height=820, min_size=(640, 480))
    window.events.before_show += api._attach
    window.events.closed += api._close
    api._preview_lock = Lock()
    api._preview_runner = Desktop()
    with TemporaryDirectory(prefix="preview-", dir=DOCS, ignore_cleanup_errors=True) as folder:
        api._preview_folder = Path(folder)
        try:
            webview.start(gui="edgechromium")
        finally:
            api._preview_runner._close()
            with api._preview_lock:
                pass


if __name__ == "__main__":
    main()
