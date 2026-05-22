#!/usr/bin/env python3
"""
Local worker — polls Render for pending jobs and resolves them using
local yt-dlp (Firefox cookies + Deno). Render never touches YouTube directly.

Usage:
    set RENDER_URL=https://your-app.onrender.com
    set WORKER_API_KEY=your-secret-key
    python worker/worker.py
"""

import os
import sys
import time
import json
import subprocess
import urllib.request
import urllib.error
import urllib.parse
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

RENDER_URL = os.environ.get("RENDER_URL", "").rstrip("/")
WORKER_API_KEY = os.environ.get("WORKER_API_KEY", "")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "2"))

if not RENDER_URL or not WORKER_API_KEY:
    print("ERROR: RENDER_URL and WORKER_API_KEY must be set as environment variables.")
    sys.exit(1)


def setup_deno():
    try:
        subprocess.run(["deno", "--version"], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        candidates = [
            os.path.expanduser("~\\.deno\\bin"),
            os.path.expanduser("~/.deno/bin"),
        ]
        for p in candidates:
            exe = os.path.join(p, "deno.exe" if os.name == "nt" else "deno")
            if os.path.exists(exe):
                os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")
                logger.info(f"Added Deno to PATH: {p}")
                return True
    logger.warning("Deno not found — some formats may be unavailable")
    return False


setup_deno()

from yt_dlp import YoutubeDL  # noqa: E402 (must come after deno setup)


def _base_ydl_opts():
    return {
        "quiet": True,
        "no_warnings": True,
        "cookiesfrombrowser": ("firefox",),
        "remote_components": ["ejs:github"],
        "extractor_args": {
            "youtube": {
                "remote_components": ["ejs:github"],
            }
        },
        "socket_timeout": 30,
        "retries": 2,
    }


def handle_info(url):
    """Fetch video metadata and return the same shape as /info."""
    opts = _base_ydl_opts()
    opts.update({
        "skip_download": True,
        "writethumbnail": False,
        "writeinfojson": False,
        "writesubtitles": False,
        "writeautomaticsub": False,
    })
    opts["extractor_args"]["youtube"]["skip_dash_manifest"] = True

    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)

    available_qualities = []
    resolution_filesizes = {}
    seen_heights = set()
    duration = info.get("duration") or 0

    video_formats = [f for f in info.get("formats", [])
                     if f.get("height") and f.get("vcodec") != "none"]

    for f in video_formats:
        height = f.get("height")
        vcodec = f.get("vcodec", "")
        filesize = f.get("filesize") or f.get("filesize_approx") or 0
        tbr = f.get("tbr") or 0
        vbr = f.get("vbr") or 0

        if not filesize and duration > 0:
            bitrate = tbr or vbr
            if bitrate:
                filesize = int(bitrate * 1000 / 8 * duration)

        if filesize and (height not in resolution_filesizes or filesize > resolution_filesizes[height]):
            resolution_filesizes[height] = filesize

        if height in seen_heights:
            continue
        seen_heights.add(height)

        codec_display = (
            "h264" if "avc" in vcodec.lower() else
            "h265" if "hevc" in vcodec.lower() or "hev" in vcodec.lower() else
            "vp9" if "vp9" in vcodec.lower() or "vp09" in vcodec.lower() else
            "av1" if "av01" in vcodec.lower() or "av1" in vcodec.lower() else
            "mp4"
        )

        available_qualities.append({
            "height": height,
            "label": f"{height}p",
            "codec": codec_display,
            "vcodec": vcodec,
        })

    audio_bytes = int(130 * 1000 / 8 * duration) if duration > 0 else 0
    for q in available_qualities:
        h = q["height"]
        if h in resolution_filesizes:
            q["filesize"] = resolution_filesizes[h] + audio_bytes

    available_qualities.sort(key=lambda x: x["height"], reverse=True)

    formats = [{
        "format_id": "best",
        "ext": "mp4",
        "resolution": f"{max(seen_heights) if seen_heights else 720}p",
        "height": max(seen_heights) if seen_heights else 720,
        "vcodec": "h264",
        "acodec": "aac",
    }] if seen_heights else []

    # Extract chapters
    chapters_raw = info.get("chapters") or []
    chapters = None
    if chapters_raw:
        video_duration = info.get("duration") or 0
        chapters = []
        for i, ch in enumerate(chapters_raw):
            start_time = ch.get("start_time") or 0
            end_time = ch.get("end_time") or 0
            if end_time <= start_time:
                if i + 1 < len(chapters_raw):
                    end_time = chapters_raw[i + 1].get("start_time") or 0
                else:
                    end_time = video_duration
            chapters.append({
                "index": i,
                "title": ch.get("title", f"Chapter {i + 1}"),
                "start_time": start_time,
                "end_time": end_time,
                "start_formatted": _fmt_ts(start_time),
                "end_formatted": _fmt_ts(end_time),
                "duration": end_time - start_time,
                "duration_formatted": _fmt_ts(end_time - start_time),
            })

    return {
        "success": True,
        "id": info.get("id"),
        "title": info.get("title"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "channel": info.get("channel"),
        "view_count": info.get("view_count"),
        "upload_date": info.get("upload_date"),
        "formats": formats,
        "available_qualities": available_qualities,
        "chapters": chapters,
    }


def handle_resolve(url, format_str):
    """
    Resolve direct googlevideo.com stream URL(s) for the requested format.
    Returns up to two URLs: [video_url] for pre-muxed, [video_url, audio_url] for DASH.
    """
    opts = _base_ydl_opts()
    opts.update({
        "format": format_str,
        "skip_download": True,
    })

    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)

    requested_formats = info.get("requested_formats")

    if requested_formats:
        # DASH: separate video and audio tracks
        stream_urls = [f["url"] for f in requested_formats if f.get("url")]
        height = next((f.get("height") for f in requested_formats if f.get("height")), None)
        vcodec = next(
            (f.get("vcodec", "") for f in requested_formats if f.get("vcodec") not in (None, "none")),
            ""
        )
        ext = "mp4"
    else:
        # Pre-muxed single stream
        raw_url = info.get("url")
        stream_urls = [raw_url] if raw_url else []
        height = info.get("height")
        vcodec = info.get("vcodec", "")
        ext = info.get("ext", "mp4")

    vcodec_display = (
        "h264" if "avc" in vcodec.lower() else
        "h265" if "hevc" in vcodec.lower() else
        "vp9" if "vp9" in vcodec.lower() else
        "av1" if "av01" in vcodec.lower() else
        vcodec.split(".")[0] if vcodec else ""
    )

    return {
        "stream_urls": stream_urls,
        "title": info.get("title"),
        "channel": info.get("channel"),
        "ext": ext,
        "height": height,
        "vcodec_display": vcodec_display,
    }


def _fmt_ts(seconds):
    if seconds is None:
        return "00:00"
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _api(method, path, body=None):
    url = f"{RENDER_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "X-Worker-Key": WORKER_API_KEY,
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def process_job(job):
    job_id = job["id"]
    job_type = job["type"]
    url = job.get("url", "")

    logger.info(f"Job {job_id[:8]} type={job_type} url={url}")

    try:
        if job_type == "info":
            result = handle_info(url)
            error = None
        elif job_type == "resolve":
            result = handle_resolve(url, job.get("format", "best"))
            error = None
        else:
            result = None
            error = f"Unknown job type: {job_type}"
    except Exception as exc:
        logger.error(f"Job {job_id[:8]} failed: {exc}")
        result = None
        error = str(exc)

    try:
        _api("POST", "/worker/result", {"job_id": job_id, "result": result, "error": error})
        logger.info(f"Job {job_id[:8]} result posted (error={error})")
    except Exception as exc:
        logger.error(f"Failed to post result for job {job_id[:8]}: {exc}")


def main():
    logger.info(f"Worker started — polling {RENDER_URL} every {POLL_INTERVAL}s")
    while True:
        try:
            data = _api("GET", "/worker/jobs")
            jobs = data.get("jobs", [])
            for job in jobs:
                process_job(job)
        except urllib.error.URLError as exc:
            logger.warning(f"Connection error: {exc}")
        except Exception as exc:
            logger.error(f"Unexpected poll error: {exc}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
