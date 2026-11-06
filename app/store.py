"""Settings and history persistence for AVMine.

Everything is stored as plain JSON next to the app so it is easy to inspect,
back up, or delete. Writes are atomic to survive a hard shutdown mid-save.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
SETTINGS_FILE = DATA_DIR / "settings.json"
HISTORY_FILE = DATA_DIR / "history.json"

DEFAULT_TEMPLATE = "%(title)s.%(ext)s"
DEFAULT_DOWNLOAD_DIR = Path.home() / "Downloads" / "AVMine"

DEFAULTS: dict = {
    "download_dir": str(DEFAULT_DOWNLOAD_DIR),
    "default_mode": "video",
    "video_quality": "1080",
    "audio_format": "mp3",
    "audio_quality": "320",
    "filename_template": DEFAULT_TEMPLATE,
    "embed_thumbnail": True,
    "embed_metadata": True,
    "playlist": True,
    "sponsorblock": False,
    "cookies_browser": "",
    "ffmpeg_path": "",
}

_lock = threading.RLock()


def ensure_dir(path: str | Path) -> Path:
    p = Path(path).expanduser()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _read_json(path: Path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return fallback


def _write_json(path: Path, value) -> None:
    ensure_dir(path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with _lock:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(value, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)


def load_settings() -> dict:
    raw = _read_json(SETTINGS_FILE, {})
    settings = dict(DEFAULTS)
    if isinstance(raw, dict):
        for key in DEFAULTS:
            if key in raw:
                settings[key] = raw[key]
    return settings


def save_settings(patch: dict) -> dict:
    settings = load_settings()
    for key in DEFAULTS:
        if key in patch:
            settings[key] = patch[key]

    # Keep types predictable no matter what the client sent.
    for key in ("embed_thumbnail", "embed_metadata", "playlist", "sponsorblock"):
        settings[key] = bool(settings[key])
    for key in ("download_dir", "video_quality", "audio_format", "audio_quality",
                "filename_template", "cookies_browser", "ffmpeg_path", "default_mode"):
        settings[key] = str(settings[key] or "")

    if not settings["filename_template"].strip():
        settings["filename_template"] = DEFAULT_TEMPLATE
    if not settings["download_dir"].strip():
        settings["download_dir"] = str(DEFAULT_DOWNLOAD_DIR)

    _write_json(SETTINGS_FILE, settings)
    return settings


def load_history() -> list[dict]:
    raw = _read_json(HISTORY_FILE, [])
    if not isinstance(raw, list):
        return []
    return [entry for entry in raw if isinstance(entry, dict) and entry.get("id")]


def save_history(entries: list[dict]) -> None:
    _write_json(HISTORY_FILE, entries[:1000])


def add_history(entry: dict) -> None:
    with _lock:
        entries = load_history()
        new_files = set(entry.get("files") or [])
        new_path = entry.get("filepath")

        def superseded(existing: dict) -> bool:
            # Re-downloading a file replaces its old entry instead of adding a
            # duplicate row to the library.
            if set(existing.get("files") or []) & new_files:
                return True
            return bool(new_path) and existing.get("filepath") == new_path

        entries = [e for e in entries
                   if e.get("id") != entry.get("id") and not superseded(e)]
        entries.insert(0, entry)
        save_history(entries)


def remove_history(entry_id: str) -> dict | None:
    with _lock:
        entries = load_history()
        found = next((e for e in entries if e.get("id") == entry_id), None)
        if found is not None:
            save_history([e for e in entries if e.get("id") != entry_id])
        return found


def clear_history() -> list[dict]:
    with _lock:
        entries = load_history()
        save_history([])
        return entries
