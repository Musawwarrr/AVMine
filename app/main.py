"""AVMine - video & audio downloader.

A tiny FastAPI app that serves the UI and wraps yt-dlp. Bound to 127.0.0.1
only; nothing is exposed to the network.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import downloader
import store

APP_NAME = "AVMine"
APP_VERSION = "1.0.0"

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

app = FastAPI(title=APP_NAME, version=APP_VERSION, docs_url=None, redoc_url=None)

_ffmpeg_cache: dict | None = None


# --------------------------------------------------------------------- models


class DownloadRequest(BaseModel):
    urls: list[str]
    mode: str = "video"
    video_quality: str = "1080"
    audio_format: str = "mp3"
    audio_quality: str = "320"
    playlist: bool = False
    sponsorblock: bool = False


class PathRequest(BaseModel):
    path: str = ""


# -------------------------------------------------------------------- helpers


def _ytdlp_version() -> str:
    version = getattr(getattr(downloader.yt_dlp, "version", None), "__version__", None)
    return version or "not installed"


def _ffmpeg_info(refresh: bool = False) -> dict:
    global _ffmpeg_cache
    if _ffmpeg_cache is not None and not refresh:
        return _ffmpeg_cache

    settings = store.load_settings()
    candidates = []
    if settings.get("ffmpeg_path"):
        candidates.append(settings["ffmpeg_path"])
    candidates.extend(["ffmpeg", "ffmpeg.exe"])

    for candidate in candidates:
        try:
            result = subprocess.run(
                [candidate, "-version"],
                capture_output=True, text=True, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if result.returncode == 0:
                first = (result.stdout or "").splitlines()[0] if result.stdout else "ffmpeg"
                _ffmpeg_cache = {"found": True, "version": first.strip(), "path": candidate}
                return _ffmpeg_cache
        except (OSError, subprocess.SubprocessError):
            continue

    _ffmpeg_cache = {"found": False, "version": "not found", "path": ""}
    return _ffmpeg_cache


def _is_http_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(value.strip())
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _clean_urls(urls: list[str]) -> list[str]:
    cleaned: list[str] = []
    for raw in urls:
        url = (raw or "").strip()
        if not url:
            continue
        if not _is_http_url(url):
            raise HTTPException(
                status_code=400,
                detail={"message": f"That doesn't look like a link: {url[:60]}",
                        "hint": "Links need to start with http:// or https://"},
            )
        if url not in cleaned:
            cleaned.append(url)
    if not cleaned:
        raise HTTPException(status_code=400, detail={"message": "Paste at least one link first."})
    if len(cleaned) > 50:
        raise HTTPException(status_code=400, detail={"message": "That's a lot at once - 50 links max."})
    return cleaned


def _best_thumbnail(info: dict | None) -> str:
    if not info:
        return ""
    thumb = info.get("thumbnail")
    if thumb:
        return str(thumb)
    thumbs = info.get("thumbnails") or []
    for item in reversed(thumbs):
        if isinstance(item, dict) and item.get("url"):
            return str(item["url"])
    for entry in (info.get("entries") or [])[:1]:
        if isinstance(entry, dict):
            return _best_thumbnail(entry)
    return ""


def _preview(url: str) -> dict:
    if downloader.yt_dlp is None:
        raise HTTPException(status_code=503, detail={
            "message": "yt-dlp is not installed.",
            "hint": "Close AVMine and run the launcher again to finish setup.",
        })

    settings = store.load_settings()
    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "noplaylist": False,
        "socket_timeout": 20,
        "cachedir": str(store.DATA_DIR / "cache"),
    }
    if settings.get("cookies_browser"):
        options["cookiesfrombrowser"] = (settings["cookies_browser"],)
    if settings.get("ffmpeg_path"):
        options["ffmpeg_location"] = settings["ffmpeg_path"]

    try:
        with downloader.yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        message = str(exc).strip() or exc.__class__.__name__
        raise HTTPException(status_code=422, detail={
            "message": message.splitlines()[0][:300],
            "hint": downloader.friendly_error(message),
        }) from exc

    if not info:
        raise HTTPException(status_code=422, detail={"message": "Nothing could be read from that link."})

    entries = info.get("entries") or []
    if not isinstance(entries, list):
        entries = list(entries)
    is_playlist = info.get("_type") == "playlist" or bool(entries)

    return {
        "type": "playlist" if is_playlist else "video",
        "title": info.get("title") or info.get("id") or "Untitled",
        "thumbnail": _best_thumbnail(info),
        "uploader": info.get("uploader") or info.get("channel") or "",
        "duration": info.get("duration"),
        "view_count": info.get("view_count"),
        "item_count": info.get("playlist_count") or (len(entries) if entries else None),
        "entries": [
            {
                "title": entry.get("title") or "",
                "duration": entry.get("duration"),
            }
            for entry in entries[:6] if isinstance(entry, dict)
        ],
        "webpage_url": info.get("webpage_url") or url,
    }


# ------------------------------------------------------------------ middleware


@app.middleware("http")
async def local_only(request: Request, call_next):
    # Block cross-site requests from random web pages to the local API (CSRF).
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("origin")
        if origin:
            host = urllib.parse.urlparse(origin).hostname
            if host not in ("127.0.0.1", "localhost", "::1"):
                return JSONResponse({"detail": "Forbidden"}, status_code=403)
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# ---------------------------------------------------------------------- routes


@app.get("/api/health")
def health() -> dict:
    settings = store.load_settings()
    folder = Path(settings["download_dir"])
    return {
        "ok": True,
        "app": APP_NAME,
        "version": APP_VERSION,
        "ytdlp": _ytdlp_version(),
        "ffmpeg": _ffmpeg_info(),
        "download_dir": str(folder),
        "download_dir_exists": folder.exists(),
        "data_dir": str(store.DATA_DIR),
        "platform": sys.platform,
    }


@app.get("/api/info")
def info(url: str) -> dict:
    if not _is_http_url(url):
        raise HTTPException(status_code=400, detail={"message": "That doesn't look like a valid link."})
    return _preview(url.strip())


@app.get("/api/settings")
def get_settings() -> dict:
    settings = store.load_settings()
    return {
        "settings": settings,
        "defaults": store.DEFAULTS,
        "ffmpeg": _ffmpeg_info(),
        "ytdlp": _ytdlp_version(),
    }


@app.post("/api/settings")
def update_settings(patch: dict = Body(...)) -> dict:
    global _ffmpeg_cache
    allowed = set(store.DEFAULTS)
    patch = {key: value for key, value in patch.items() if key in allowed}
    if "ffmpeg_path" in patch:
        _ffmpeg_cache = None

    folder = str(patch.get("download_dir", "")).strip()
    if folder:
        try:
            store.ensure_dir(folder)
        except OSError as exc:
            raise HTTPException(status_code=400, detail={
                "message": f"Can't use that folder: {exc.strerror or exc}",
                "hint": "Pick a folder you have permission to write to.",
            }) from exc
    else:
        patch.pop("download_dir", None)

    return {"settings": store.save_settings(patch)}


@app.get("/api/jobs")
def jobs() -> dict:
    items = downloader.manager.list_jobs()
    active = sum(1 for job in items if job["status"] in downloader.ACTIVE_STATES)
    return {"jobs": items, "active": active}


@app.post("/api/download")
def start_download(payload: DownloadRequest) -> dict:
    urls = _clean_urls(payload.urls)

    mode = payload.mode if payload.mode in ("video", "audio") else "video"
    audio_format = payload.audio_format if payload.audio_format in ("mp3", "m4a", "opus", "wav") else "mp3"
    audio_quality = payload.audio_quality if payload.audio_quality in ("320", "256", "192", "128") else "320"
    video_quality = payload.video_quality or "1080"

    if not _ffmpeg_info()["found"]:
        raise HTTPException(status_code=503, detail={
            "message": "ffmpeg wasn't found on this PC.",
            "hint": "Install ffmpeg and make sure it's on PATH, then restart AVMine.",
        })

    options = {
        "mode": mode,
        "video_quality": video_quality,
        "audio_format": audio_format,
        "audio_quality": audio_quality,
        "playlist": bool(payload.playlist),
        "sponsorblock": bool(payload.sponsorblock),
    }
    created = downloader.manager.create_jobs(urls, options)
    return {"jobs": created, "count": len(created)}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    if not downloader.manager.cancel(job_id):
        raise HTTPException(status_code=404, detail={"message": "That download is no longer running."})
    return {"ok": True}


# -------------------------------------------------------------------- history


@app.get("/api/history")
def history(q: str = "", mode: str = "") -> dict:
    items = store.load_history()
    query = q.strip().lower()
    if query:
        items = [item for item in items
                 if query in (item.get("title") or "").lower()
                 or query in (item.get("uploader") or "").lower()]
    if mode in ("video", "audio"):
        items = [item for item in items if item.get("mode") == mode]
    return {
        "items": items,
        "count": len(items),
        "total_size": sum(int(item.get("size") or 0) for item in items),
    }


@app.delete("/api/history/{entry_id}")
def delete_history(entry_id: str, delete_file: bool = False) -> dict:
    entry = store.remove_history(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail={"message": "History entry not found."})

    removed = 0
    if delete_file:
        for path in entry.get("files") or [entry.get("filepath")]:
            if not path:
                continue
            try:
                target = Path(path)
                if target.is_file():
                    target.unlink()
                    removed += 1
            except OSError:
                continue
    return {"ok": True, "removed_files": removed}


@app.post("/api/history/clear")
def clear_history(payload: dict = Body(default={})) -> dict:
    delete_files = bool(payload.get("delete_files")) if isinstance(payload, dict) else False
    entries = store.clear_history()
    removed = 0
    if delete_files:
        for entry in entries:
            for path in entry.get("files") or [entry.get("filepath")]:
                if not path:
                    continue
                try:
                    target = Path(path)
                    if target.is_file():
                        target.unlink()
                        removed += 1
                except OSError:
                    continue
    return {"ok": True, "cleared": len(entries), "removed_files": removed}


# --------------------------------------------------------------------- system


@app.post("/api/reveal")
def reveal(payload: PathRequest) -> dict:
    raw = (payload.path or "").strip()
    if not raw:
        raw = store.load_settings()["download_dir"]
    target = Path(raw).expanduser()

    if target.is_file():
        subprocess.Popen(["explorer", f"/select,{target}"],
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return {"ok": True}

    folder = target if target.is_dir() else target.parent
    try:
        store.ensure_dir(folder)
    except OSError as exc:
        raise HTTPException(status_code=404, detail={"message": f"Folder not found: {folder}"}) from exc
    subprocess.Popen(["explorer", str(folder)],
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return {"ok": True}


@app.post("/api/open")
def open_path(payload: PathRequest) -> dict:
    target = Path((payload.path or "").strip()).expanduser()
    if not target.is_file():
        raise HTTPException(status_code=404, detail={"message": "That file is no longer on disk."})
    try:
        if hasattr(os, "startfile"):
            os.startfile(str(target))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
    except OSError as exc:
        raise HTTPException(status_code=500, detail={"message": f"Couldn't open the file: {exc}"}) from exc
    return {"ok": True}


@app.post("/api/pick-folder")
def pick_folder() -> dict:
    """Open the native Windows folder picker and return the chosen path."""
    current = store.load_settings()["download_dir"].replace("'", "''")
    script = f"""
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose where AVMine saves files'
$dialog.SelectedPath = '{current}'
$dialog.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$result = $dialog.ShowDialog($owner)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $dialog.SelectedPath }}
$owner.Dispose()
"""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            capture_output=True, text=True, timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=500, detail={"message": "Couldn't open the folder picker."}) from exc

    path = (result.stdout or "").strip()
    return {"path": path, "canceled": not bool(path)}


@app.post("/api/update-ytdlp")
def update_ytdlp() -> dict:
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp"],
            capture_output=True, text=True, timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise HTTPException(status_code=500, detail={"message": f"Update failed: {exc}"}) from exc

    output = ((result.stdout or "") + "\n" + (result.stderr or "")).strip()
    installed = "unknown"
    try:
        check = subprocess.run(
            [sys.executable, "-c", "import yt_dlp; print(yt_dlp.version.__version__)"],
            capture_output=True, text=True, timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if check.returncode == 0:
            installed = (check.stdout or "").strip() or installed
    except (OSError, subprocess.SubprocessError):
        pass

    if result.returncode != 0:
        raise HTTPException(status_code=500, detail={
            "message": "yt-dlp update failed.",
            "hint": output[-600:] or "Check your internet connection and try again.",
        })

    return {
        "ok": True,
        "installed": installed,
        "running": _ytdlp_version(),
        "restart_required": installed != _ytdlp_version(),
        "output": output[-1200:],
    }


@app.get("/api/thumb")
def thumbnail(u: str) -> Response:
    if not _is_http_url(u):
        raise HTTPException(status_code=400, detail={"message": "Invalid image URL."})

    parsed = urllib.parse.urlparse(u)
    request = urllib.request.Request(u, headers={
        "User-Agent": USER_AGENT,
        "Accept": "image/avif,image/webp,image/*,*/*;q=0.8",
        "Referer": f"{parsed.scheme}://{parsed.netloc}/",
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            content_type = response.headers.get("Content-Type", "image/jpeg").split(";")[0]
            if not content_type.startswith("image/"):
                raise HTTPException(status_code=415, detail={"message": "Not an image."})
            data = response.read(8 * 1024 * 1024)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"message": "Couldn't load thumbnail."}) from exc

    return Response(content=data, media_type=content_type,
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/version")
def version() -> dict:
    return {"app": APP_VERSION, "ytdlp": _ytdlp_version()}


# ----------------------------------------------------------------------- static

if not STATIC_DIR.exists():
    STATIC_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


# ------------------------------------------------------------------------- main


def _find_port(start: int = 8765) -> int:
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port found between 8765 and 8804.")


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass

    store.ensure_dir(store.DATA_DIR)
    store.ensure_dir(store.load_settings()["download_dir"])

    port = _find_port()
    url = f"http://127.0.0.1:{port}"

    print("")
    print(f"  {APP_NAME} {APP_VERSION}")
    print(f"  yt-dlp  {_ytdlp_version()}")
    print(f"  ffmpeg  {_ffmpeg_info()['version']}")
    print(f"  folder  {store.load_settings()['download_dir']}")
    print("")
    print(f"  Open:   {url}")
    print("  Close this window (or press Ctrl+C) to quit.")
    print("")

    if not os.environ.get("AVMINE_NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()

    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
