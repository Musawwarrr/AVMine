# AVMine

A video & audio downloader for Windows.

It uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) and
[ffmpeg](https://ffmpeg.org/). The interface is a tiny local web app that opens in
your browser and talks to a Python server running only on `127.0.0.1`.

I have themed it with Avatar the Last Airbender's color palette just cause I love the show. 

---

## Quick start

1. Double-click **`run.bat`**.
2. The first run creates an isolated environment in `.venv` and installs the
   dependencies (about a minute).
3. Your browser opens **http://127.0.0.1:8765** automatically.

Keep the console window open while you use AVMine. Closing it stops the app.
If you'd rather not see the console, double-click **`AVMine.vbs`** instead
(it launches hidden; stop it from Task Manager).

**Requirements:** Windows 10/11, Python 3.10+, and ffmpeg on your `PATH`.

---

## What you can do

- **Video** — MP4 up to 4K, or let it pick the best available.
- **Audio only** — MP3, M4A, Opus, or WAV, with 128–320 kbps quality.
- **Playlists** — toggle "Whole playlist" to grab an entire list, or turn it off
  for just the linked item.
- **Batch** — paste several links at once (one per line or space-separated).
- **Live progress** — percentage, size, speed, and ETA for every job, with a queue
  and cancel buttons.
- **Preview** — title, channel, duration, and thumbnail appear before you download.
- **Library** — every completed download is listed with open / reveal / copy path /
  re-download / delete actions.
- **SponsorBlock** — optional; cuts sponsored segments out of the file.
- **Metadata & cover art** — embedded automatically (configurable).
- **Browser cookies** — needed for private, age-restricted, or members-only videos.
- **One-click yt-dlp updates** — sites change constantly; update from Settings.


---

## Where things live

| What | Where |
| --- | --- |
| Downloaded files | `C:\Users\<you>\Downloads\AVMine` (change in Settings) |
| Settings | `data\settings.json` |
| History | `data\history.json` |
| Cache | `data\cache` |
| App code | `app\` |

The download folder is created automatically. Settings and history are plain JSON,
so they're easy to inspect or back up.

---

## Settings worth knowing

**Filename template** — uses yt-dlp's template tokens. Default is
`%(title)s.%(ext)s`. You can add the uploader, ID, or upload date, for example:

```
%(uploader)s - %(title)s [%(id)s].%(ext)s
```

**Cookies from browser** — if YouTube says *"Sign in to confirm you're not a bot"*,
open Settings → Cookies from browser and choose the browser where you're signed in.
Close that browser first if Windows has the cookie database locked.

**ffmpeg path** — only needed if ffmpeg isn't on `PATH`. Point it at the folder
containing `ffmpeg.exe`, or at the executable itself.

**Updating yt-dlp** — sites break extractors regularly. Use
Settings → Update, then close and reopen AVMine so the new version loads.
YouTube issues are almost always fixed by an update.


