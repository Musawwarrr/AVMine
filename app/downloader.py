"""Download engine: a small single-worker queue on top of yt-dlp.

Jobs live in memory, completed downloads are appended to the on-disk history.
Only one download runs at a time so progress stays readable and bandwidth
isn't split unpredictably.
"""

from __future__ import annotations

import collections
import os
import threading
import time
import uuid
from pathlib import Path

import store

try:  # yt-dlp is installed as a Python package via requirements.txt
    import yt_dlp
    from yt_dlp.utils import DownloadCancelled
except Exception:  # pragma: no cover - handled with a friendly UI message
    yt_dlp = None

    class DownloadCancelled(Exception):  # type: ignore[no-redef]
        pass


ACTIVE_STATES = ("queued", "downloading", "processing")

ERROR_HINTS: list[tuple[str, str]] = [
    ("confirm you're not a bot",
     "YouTube wants a sign-in check. Open Settings → Cookies and pick the browser you use."),
    ("sign in to confirm",
     "YouTube wants a sign-in check. Open Settings → Cookies and pick the browser you use."),
    ("private video",
     "This video is private, so it can't be downloaded without an account."),
    ("video unavailable",
     "This video is unavailable, private, or region-locked."),
    ("members-only",
     "This video is members-only and needs an account with access."),
    ("age-restricted",
     "This video is age-restricted. Pick a browser in Settings → Cookies to authenticate."),
    ("unsupported url",
     "That link isn't supported. Paste a video page or a direct media URL."),
    ("is not a valid url",
     "That doesn't look like a valid link."),
    ("requested format is not available",
     "That quality isn't available for this item. Try 'Best available'."),
    ("ffmpeg",
     "ffmpeg wasn't found. Install it or set its path in Settings."),
    ("http error 403",
     "The site refused the download. Updating yt-dlp usually fixes this (Settings → Update)."),
    ("http error 429",
     "The site is rate-limiting requests. Wait a few minutes and try again."),
    ("unable to download webpage",
     "Couldn't reach the site. Check your internet connection or the link."),
    ("drm",
     "This item is DRM-protected and can't be downloaded."),
    ("no space left",
     "The disk is full. Free up space or choose another download folder."),
    ("permission denied",
     "Windows denied access to the download folder. Choose a different folder in Settings."),
    ("timed out",
     "The site took too long to respond. Try again in a moment."),
]


def friendly_error(message: str) -> str:
    lowered = (message or "").lower()
    for needle, hint in ERROR_HINTS:
        if needle in lowered:
            return hint
    return ""


def format_label(options: dict) -> str:
    if options["mode"] == "audio":
        fmt = options["audio_format"].upper()
        if fmt == "WAV":
            return "WAV · lossless"
        return f"{fmt} · {options['audio_quality']} kbps"
    quality = options["video_quality"]
    return f"MP4 · {'Best' if quality in ('best', '') else quality + 'p'}"


class JobManager:
    def __init__(self) -> None:
        self._jobs: dict[str, dict] = {}
        self._order: list[str] = []
        self._queue: collections.deque[str] = collections.deque()
        self._lock = threading.RLock()
        self._worker: threading.Thread | None = None

    # ---------------------------------------------------------------- public

    def create_jobs(self, urls: list[str], options: dict) -> list[dict]:
        settings = store.load_settings()
        download_dir = store.ensure_dir(settings["download_dir"])
        created: list[dict] = []

        for url in urls:
            job = {
                "id": uuid.uuid4().hex[:12],
                "url": url,
                "title": "",
                "uploader": "",
                "thumbnail": "",
                "duration": None,
                "mode": options["mode"],
                "quality": options.get("video_quality", settings["video_quality"]),
                "format_label": format_label({**settings, **options}),
                "status": "queued",
                "percent": 0.0,
                "downloaded_bytes": 0,
                "total_bytes": 0,
                "speed": None,
                "eta": None,
                "item_index": None,
                "item_total": None,
                "files": [],
                "filepath": "",
                "size": 0,
                "error": "",
                "error_hint": "",
                "created_at": time.time(),
                "started_at": None,
                "finished_at": None,
                # private
                "_cancel": threading.Event(),
                "_download_dir": str(download_dir),
                "_settings": settings,
                "_options": options,
            }
            with self._lock:
                self._jobs[job["id"]] = job
                self._order.append(job["id"])
                self._queue.append(job["id"])
                self._prune_locked()
                self._ensure_worker_locked()
            created.append(self.public(job))

        return created

    def public(self, job: dict) -> dict:
        payload = {key: value for key, value in job.items() if not key.startswith("_")}
        payload["files"] = list(job.get("files") or [])
        return payload

    def list_jobs(self) -> list[dict]:
        with self._lock:
            return [self.public(self._jobs[jid]) for jid in self._order if jid in self._jobs]

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            if job["status"] == "queued":
                job["status"] = "canceled"
                job["finished_at"] = time.time()
                job["error"] = "Canceled"
                return True
            if job["status"] in ("downloading", "processing"):
                job["_cancel"].set()
                return True
            return False

    # --------------------------------------------------------------- internals

    def _ensure_worker_locked(self) -> None:
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._worker_loop, daemon=True,
                                            name="downlink-worker")
            self._worker.start()

    def _prune_locked(self) -> None:
        # Keep the in-memory list bounded; history is the long-term record.
        if len(self._order) <= 80:
            return
        keep: list[str] = []
        cutoff = time.time() - 600
        for jid in self._order:
            job = self._jobs.get(jid)
            if job is None:
                continue
            if job["status"] in ACTIVE_STATES or (job.get("finished_at") or 0) > cutoff:
                keep.append(jid)
            else:
                self._jobs.pop(jid, None)
        self._order = keep

    def _worker_loop(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    self._worker = None
                    return
                job_id = self._queue.popleft()
                job = self._jobs.get(job_id)
                if job is None or job["status"] != "queued":
                    continue
            self._run(job)

    # ------------------------------------------------------------------ run

    def _run(self, job: dict) -> None:
        job["status"] = "downloading"
        job["started_at"] = time.time()
        start = time.time()

        if yt_dlp is None:
            self._fail(job, "yt-dlp is not installed. Run the launcher again to install it.")
            return

        try:
            store.ensure_dir(job["_download_dir"])
            options = self._build_options(job)
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(job["url"], download=True)
            self._complete(job, info, start)
        except DownloadCancelled:
            self._canceled(job, start)
        except Exception as exc:  # noqa: BLE001 - surfaced in the UI
            message = str(exc).strip() or exc.__class__.__name__
            if job["_cancel"].is_set():
                self._canceled(job, start)
            else:
                self._fail(job, message, start)

    def _build_options(self, job: dict) -> dict:
        settings = job["_settings"]
        options = job["_options"]
        mode = job["mode"]

        # Cover art belongs in audio files; adding it to video creates an extra
        # attached-picture stream that some editors treat as a second video track.
        embed_thumb = bool(settings["embed_thumbnail"]) and mode == "audio"
        embed_meta = bool(settings["embed_metadata"])

        pps: list[dict] = []
        if options.get("sponsorblock"):
            segments = ["sponsor"]
            pps.append({"key": "SponsorBlock", "categories": segments})
            pps.append({"key": "ModifyChapters", "remove_sponsor_segments": segments})

        if mode == "audio":
            pps.append({
                "key": "FFmpegExtractAudio",
                "preferredcodec": options.get("audio_format", "mp3"),
                "preferredquality": str(options.get("audio_quality", "320")),
            })
        if embed_thumb:
            pps.append({"key": "EmbedThumbnail"})
        if embed_meta:
            pps.append({"key": "FFmpegMetadata", "add_metadata": True})

        if mode == "audio":
            fmt = "bestaudio/best"
        else:
            quality = str(options.get("video_quality") or "best")
            if quality in ("best", ""):
                fmt = ("bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba/b")
            else:
                fmt = (
                    f"bv*[height<={quality}][vcodec^=avc1]+ba[ext=m4a]"
                    f"/bv*[height<={quality}]+ba/b[height<={quality}]/b"
                )

        ydl_opts: dict = {
            "format": fmt,
            "paths": {"home": job["_download_dir"]},
            "outtmpl": {"default": settings["filename_template"] or store.DEFAULT_TEMPLATE},
            "noplaylist": not bool(options.get("playlist", True)),
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "no_color": True,
            "windowsfilenames": True,
            "overwrites": True,
            "continuedl": True,
            "retries": 5,
            "fragment_retries": 5,
            "socket_timeout": 25,
            "concurrent_fragment_downloads": 4,
            "ignoreerrors": False,
            "writethumbnail": embed_thumb,
            "postprocessors": pps,
            "progress_hooks": [lambda d: self._on_progress(job, d)],
            "postprocessor_hooks": [lambda d: self._on_postprocess(job, d)],
        }
        if mode == "video":
            ydl_opts["merge_output_format"] = "mp4"
        if settings.get("cookies_browser"):
            ydl_opts["cookiesfrombrowser"] = (settings["cookies_browser"],)
        if settings.get("ffmpeg_path"):
            ydl_opts["ffmpeg_location"] = settings["ffmpeg_path"]
        return ydl_opts

    # ---------------------------------------------------------------- hooks

    def _on_progress(self, job: dict, d: dict) -> None:
        if job["_cancel"].is_set():
            raise DownloadCancelled("Canceled by user")

        status = d.get("status")
        info = d.get("info_dict") or {}

        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total:
                percent = done / total * 100.0
            else:
                percent = _parse_percent(d.get("_percent_str"))

            index = info.get("playlist_index") or job.get("_item_index")
            item_total = info.get("n_entries") or info.get("playlist_count")
            overall = percent
            if index and item_total:
                overall = ((index - 1) + percent / 100.0) / item_total * 100.0

            with self._lock:
                job["percent"] = max(0.0, min(overall, 99.9))
                job["downloaded_bytes"] = done
                job["total_bytes"] = total
                job["speed"] = d.get("speed")
                job["eta"] = d.get("eta")
                if index:
                    job["item_index"] = index
                if item_total:
                    job["item_total"] = item_total
                if not job["title"]:
                    job["title"] = info.get("title") or ""
                if not job["thumbnail"]:
                    job["thumbnail"] = info.get("thumbnail") or ""
                if job["duration"] is None:
                    job["duration"] = info.get("duration")
                if not job["uploader"]:
                    job["uploader"] = info.get("uploader") or info.get("channel") or ""

        elif status == "finished":
            with self._lock:
                job["status"] = "processing"
                job["percent"] = max(job["percent"], 99.0)
                job["speed"] = None
                job["eta"] = 0
            self._remember_file(job, info.get("filepath") or d.get("filename"))

        elif status == "error":
            with self._lock:
                job["error"] = "The download failed."

    def _on_postprocess(self, job: dict, d: dict) -> None:
        status = d.get("status")
        info = d.get("info_dict") or {}
        if status in ("started", "processing"):
            with self._lock:
                if job["status"] != "canceled":
                    job["status"] = "processing"
            self._remember_file(job, info.get("filepath") or info.get("_filename"))
        elif status == "finished":
            self._remember_file(job, info.get("filepath") or info.get("_filename"))

    def _remember_file(self, job: dict, path) -> None:
        if not path:
            return
        try:
            resolved = str(Path(path))
        except (OSError, ValueError):
            return
        with self._lock:
            if resolved not in job["files"]:
                job["files"].append(resolved)

    # ------------------------------------------------------------- terminal

    def _complete(self, job: dict, info: dict | None, start: float) -> None:
        files: list[str] = []
        for path in list(job.get("files") or []):
            if Path(path).exists():
                files.append(path)
        for path in _files_from_info(info):
            if path not in files and Path(path).exists():
                files.append(path)

        if not files:
            files = _scan_recent(job["_download_dir"], start)
        files = [f for f in files if Path(f).exists()]

        with self._lock:
            if info:
                if info.get("title"):
                    job["title"] = info.get("title") or job["title"]
                if info.get("uploader") or info.get("channel"):
                    job["uploader"] = info.get("uploader") or info.get("channel")
                if info.get("duration") and not job["duration"]:
                    job["duration"] = info.get("duration")
                if not job["thumbnail"]:
                    job["thumbnail"] = info.get("thumbnail") or ""

            job["status"] = "complete"
            job["percent"] = 100.0
            job["speed"] = None
            job["eta"] = 0
            job["finished_at"] = time.time()
            job["files"] = files
            job["filepath"] = files[0] if files else ""
            job["size"] = _total_size(files)

        if not files:
            self._fail(job, "The download finished but no output file was found. "
                            "Check the filename template in Settings.")
            return

        store.add_history({
            "id": job["id"],
            "url": job["url"],
            "title": job["title"] or Path(files[0]).stem,
            "uploader": job["uploader"],
            "mode": job["mode"],
            "format_label": job["format_label"],
            "thumbnail": job["thumbnail"],
            "duration": job["duration"],
            "filepath": job["filepath"],
            "files": files,
            "size": job["size"],
            "completed_at": job["finished_at"],
            "options": dict(job["_options"]),
        })

    def _fail(self, job: dict, message: str, start: float | None = None) -> None:
        with self._lock:
            job["status"] = "error"
            job["error"] = message
            job["error_hint"] = friendly_error(message)
            job["speed"] = None
            job["eta"] = None
            job["finished_at"] = time.time()
        if start:
            _remove_partials(job["_download_dir"], start)

    def _canceled(self, job: dict, start: float) -> None:
        with self._lock:
            job["status"] = "canceled"
            job["error"] = "Canceled"
            job["error_hint"] = ""
            job["speed"] = None
            job["eta"] = None
            job["finished_at"] = time.time()
        _remove_partials(job["_download_dir"], start)


# ------------------------------------------------------------------ helpers


def _parse_percent(text) -> float:
    try:
        return float(str(text).strip().replace("%", ""))
    except (TypeError, ValueError):
        return 0.0


def _files_from_info(info: dict | None) -> list[str]:
    found: list[str] = []

    def add(path) -> None:
        if path and str(path) not in found:
            found.append(str(path))

    def walk(node) -> None:
        if not node:
            return
        entries = node.get("entries")
        if entries:
            for entry in entries:
                walk(entry)
            return
        for item in node.get("requested_downloads") or []:
            add(item.get("filepath"))
        add(node.get("filepath"))
        add(node.get("_filename"))

    walk(info)
    return found


def _scan_recent(directory: str, since: float) -> list[str]:
    found: list[str] = []
    try:
        for path in Path(directory).rglob("*"):
            if not path.is_file():
                continue
            if path.name.endswith((".part", ".ytdl", ".temp", ".tmp")):
                continue
            try:
                if path.stat().st_mtime >= since - 5:
                    found.append(str(path))
            except OSError:
                continue
    except OSError:
        return []
    found.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return found


def _total_size(files: list[str]) -> int:
    total = 0
    for path in files:
        try:
            total += os.path.getsize(path)
        except OSError:
            pass
    return total


def _remove_partials(directory: str, since: float) -> None:
    try:
        for path in Path(directory).glob("*.part"):
            try:
                if path.stat().st_mtime >= since - 5:
                    path.unlink(missing_ok=True)
            except OSError:
                continue
    except OSError:
        return


manager = JobManager()
