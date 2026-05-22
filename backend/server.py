import sys
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)

from flask import Flask, jsonify, request, Response, stream_with_context
from flask_cors import CORS
from rate_limiter import limiter, init_limiter, RATE_LIMITS
from yt_dlp import YoutubeDL
import os
import tempfile
import subprocess
import logging
import shutil
import urllib.parse
import urllib.request
import zipfile
import uuid
import json
import re
import random
from concurrent.futures import ThreadPoolExecutor, as_completed

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

init_limiter(app)

# Deployment config — Render injects PORT and RENDER=true automatically
PORT = int(os.environ.get("PORT", 5000))
HOST = "0.0.0.0"
DEBUG = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
ON_RENDER = bool(os.environ.get("RENDER"))
RENDER_MODE = os.environ.get("RENDER_MODE", "0") == "1"
WORKER_API_KEY = os.environ.get("WORKER_API_KEY", "")

# Write YouTube cookies from env var to a temp file (set via upload_cookies.py)
COOKIES_FILE = None
if ON_RENDER:
    import base64
    cookies_b64 = os.environ.get("YOUTUBE_COOKIES")
    if cookies_b64:
        try:
            COOKIES_FILE = "/tmp/yt_cookies.txt"
            with open(COOKIES_FILE, "w") as f:
                f.write(base64.b64decode(cookies_b64).decode("utf-8"))
            print("✓ YouTube cookies loaded")
        except Exception as e:
            print(f"⚠ Failed to load cookies: {e}")


# Server-side cache for video info (reduces repeated yt-dlp calls)
from functools import lru_cache, wraps
from threading import Lock, Event
import time

# Simple in-memory cache with TTL
class VideoInfoCache:
    def __init__(self, ttl=180):  # Reduced to 3 minutes for faster updates during development
        self.cache = {}
        self.ttl = ttl
        self.lock = Lock()
    
    def get(self, video_id):
        with self.lock:
            if video_id in self.cache:
                entry = self.cache[video_id]
                if time.time() - entry['timestamp'] < self.ttl:
                    logger.info(f"Cache hit for video: {video_id}")
                    return entry['data']
                else:
                    del self.cache[video_id]
        return None
    
    def set(self, video_id, data):
        with self.lock:
            self.cache[video_id] = {
                'data': data,
                'timestamp': time.time()
            }
            # Limit cache size to 50 entries for faster access
            if len(self.cache) > 50:
                oldest_key = min(self.cache.keys(), key=lambda k: self.cache[k]['timestamp'])
                del self.cache[oldest_key]

video_cache = VideoInfoCache()


class JobQueue:
    """Thread-safe queue for delegating work to the local worker process."""

    def __init__(self):
        self._pending = {}
        self._results = {}
        self._events = {}
        self._lock = Lock()

    def create(self, job_type, **kwargs):
        job_id = str(uuid.uuid4())
        ev = Event()
        with self._lock:
            self._pending[job_id] = {"id": job_id, "type": job_type, **kwargs}
            self._events[job_id] = ev
        return job_id, ev

    def take_pending(self):
        with self._lock:
            jobs = list(self._pending.values())
            self._pending.clear()
        return jobs

    def set_result(self, job_id, result, error=None):
        with self._lock:
            self._results[job_id] = {"result": result, "error": error}
            ev = self._events.get(job_id)
        if ev:
            ev.set()

    def pop_result(self, job_id):
        with self._lock:
            self._events.pop(job_id, None)
            return self._results.pop(job_id, None)


job_queue = JobQueue()


def require_worker_key(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not WORKER_API_KEY or request.headers.get("X-Worker-Key") != WORKER_API_KEY:
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


# Find Deno path and add to environment if needed
def setup_deno_path():
    """Ensure Deno is in PATH for yt-dlp to find"""
    try:
        subprocess.run(["deno", "--version"], capture_output=True, check=True)
        print("✓ Deno found in PATH")
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        deno_paths = [
            os.path.expanduser("~\\.deno\\bin"),
            os.path.expandvars("%USERPROFILE%\\.deno\\bin"),
            "C:\\Program Files\\deno\\bin",
            os.path.expanduser("~/.deno/bin"),
        ]
        for deno_path in deno_paths:
            deno_exe = os.path.join(deno_path, "deno.exe" if os.name == 'nt' else "deno")
            if os.path.exists(deno_exe):
                os.environ["PATH"] = deno_path + os.pathsep + os.environ.get("PATH", "")
                print(f"✓ Added Deno to PATH: {deno_path}")
                return True
        print("⚠ Deno not found - some formats may be unavailable")
        return False

DENO_AVAILABLE = setup_deno_path()

# Check for FFmpeg
def check_ffmpeg():
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        print("✓ FFmpeg found")
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("⚠ FFmpeg not found - some features may be unavailable")
        return False

FFMPEG_AVAILABLE = check_ffmpeg()

# Invidious instances used when ON_RENDER (all tried in parallel, first success wins)
INVIDIOUS_INSTANCES = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://yt.artemislena.eu",
    "https://inv.tux.pizza",
    "https://yewtu.be",
    "https://invidious.privacydev.net",
    "https://inv.vern.cc",
    "https://invidious.projectsegfau.lt",
    "https://invidious.perennialte.ch",
]


def _invidious_fetch(path):
    instances = list(INVIDIOUS_INSTANCES)
    random.shuffle(instances)

    def _try(base):
        req = urllib.request.Request(
            f"{base}{path}",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read())

    last_err = None
    with ThreadPoolExecutor(max_workers=len(instances)) as pool:
        futures = {pool.submit(_try, base): base for base in instances}
        for fut in as_completed(futures, timeout=25):
            base = futures[fut]
            try:
                return fut.result()
            except Exception as exc:
                logger.warning(f"Invidious {base} failed: {exc}")
                last_err = exc
    raise RuntimeError(f"All Invidious instances failed — last error: {last_err}")


def _height_from_label(label):
    if label:
        m = re.match(r"(\d+)p", str(label))
        if m:
            return int(m.group(1))
    return 0


def invidious_get_info(video_id):
    fields = "title,author,lengthSeconds,viewCount,videoThumbnails,adaptiveFormats,formatStreams,chapters"
    data = _invidious_fetch(f"/api/v1/videos/{video_id}?fields={fields}")

    duration = data.get("lengthSeconds") or 0
    adaptive = data.get("adaptiveFormats") or []
    prebuilt = data.get("formatStreams") or []

    available_qualities = []
    seen_heights = set()
    resolution_filesizes = {}

    for f in adaptive:
        mime = f.get("type", "")
        if "video" not in mime or "audio" in mime:
            continue
        height = _height_from_label(f.get("qualityLabel", ""))
        if not height or height in seen_heights:
            continue
        seen_heights.add(height)

        vcodec = f.get("encoding", "")
        codec_display = (
            "h264" if any(x in vcodec.lower() for x in ("h264", "avc")) else
            "h265" if any(x in vcodec.lower() for x in ("h265", "hevc")) else
            "vp9"  if "vp9" in vcodec.lower() else
            "av1"  if "av1" in vcodec.lower() else
            vcodec or "mp4"
        )

        filesize = int(f.get("clen") or 0)
        if not filesize:
            bitrate = int(f.get("bitrate") or 0)
            if bitrate and duration:
                filesize = int(bitrate / 8 * duration)
        if filesize:
            resolution_filesizes[height] = filesize

        available_qualities.append({"height": height, "label": f"{height}p", "codec": codec_display, "vcodec": vcodec})

    for f in prebuilt:
        height = _height_from_label(f.get("qualityLabel", ""))
        if not height or height in seen_heights:
            continue
        seen_heights.add(height)
        available_qualities.append({"height": height, "label": f"{height}p", "codec": "h264", "vcodec": "avc1"})

    audio_bytes = int(130_000 / 8 * duration) if duration else 0
    for q in available_qualities:
        if q["height"] in resolution_filesizes:
            q["filesize"] = resolution_filesizes[q["height"]] + audio_bytes

    available_qualities.sort(key=lambda x: x["height"], reverse=True)

    formats = [{
        "format_id": "best", "ext": "mp4",
        "resolution": f"{max(seen_heights) if seen_heights else 720}p",
        "height": max(seen_heights) if seen_heights else 720,
        "vcodec": "h264", "acodec": "aac",
    }] if seen_heights else []

    raw_ch = data.get("chapters") or []
    chapters = None
    if raw_ch:
        chapters = []
        for i, ch in enumerate(raw_ch):
            start = ch.get("start") or 0
            end = raw_ch[i + 1].get("start", duration) if i + 1 < len(raw_ch) else duration
            chapters.append({
                "index": i, "title": ch.get("title", f"Chapter {i + 1}"),
                "start_time": start, "end_time": end,
                "start_formatted": format_timestamp(start), "end_formatted": format_timestamp(end),
                "duration": end - start, "duration_formatted": format_timestamp(end - start),
            })

    thumbs = data.get("videoThumbnails") or []
    thumbnail = thumbs[0].get("url") if thumbs else None

    return {
        "success": True, "id": video_id,
        "title": data.get("title"), "thumbnail": thumbnail,
        "duration": duration, "channel": data.get("author"),
        "view_count": data.get("viewCount"), "upload_date": None,
        "formats": formats, "available_qualities": available_qualities, "chapters": chapters,
    }


def invidious_get_streams(video_id, format_str):
    data = _invidious_fetch(f"/api/v1/videos/{video_id}?fields=adaptiveFormats,formatStreams,title,author")
    adaptive = data.get("adaptiveFormats") or []
    prebuilt = data.get("formatStreams") or []

    if format_str in ("bestaudio", "bestaudio/best"):
        audio = sorted(
            [f for f in adaptive if "audio" in f.get("type", "")],
            key=lambda f: int(f.get("bitrate") or 0), reverse=True
        )
        if not audio:
            raise RuntimeError("No audio streams from Invidious")
        return {"stream_urls": [audio[0]["url"]], "title": data.get("title"),
                "channel": data.get("author"), "ext": "m4a", "height": None, "vcodec_display": ""}

    m = re.search(r"height<=(\d+)", format_str)
    max_h = int(m.group(1)) if m else None

    video_s = [f for f in adaptive if "video" in f.get("type", "") and "audio" not in f.get("type", "")]
    audio_s = [f for f in adaptive if "audio" in f.get("type", "")]
    if max_h:
        video_s = [f for f in video_s if _height_from_label(f.get("qualityLabel", "")) <= max_h]

    if video_s and audio_s:
        video_s.sort(key=lambda f: (_height_from_label(f.get("qualityLabel", "")), int(f.get("bitrate") or 0)), reverse=True)
        audio_s.sort(key=lambda f: int(f.get("bitrate") or 0), reverse=True)
        bv, ba = video_s[0], audio_s[0]
        height = _height_from_label(bv.get("qualityLabel", ""))
        vcodec = bv.get("encoding", "")
        vcodec_display = (
            "h264" if any(x in vcodec.lower() for x in ("h264", "avc")) else
            "h265" if any(x in vcodec.lower() for x in ("h265", "hevc")) else
            "vp9" if "vp9" in vcodec.lower() else
            "av1" if "av1" in vcodec.lower() else vcodec or ""
        )
        return {"stream_urls": [bv["url"], ba["url"]], "title": data.get("title"),
                "channel": data.get("author"), "ext": "mp4", "height": height, "vcodec_display": vcodec_display}

    if max_h:
        prebuilt = [f for f in prebuilt if _height_from_label(f.get("qualityLabel", "")) <= max_h]
    prebuilt.sort(key=lambda f: _height_from_label(f.get("qualityLabel", "")), reverse=True)
    if prebuilt:
        best = prebuilt[0]
        return {"stream_urls": [best["url"]], "title": data.get("title"),
                "channel": data.get("author"), "ext": "mp4",
                "height": _height_from_label(best.get("qualityLabel", "")), "vcodec_display": "h264"}

    raise RuntimeError("No suitable streams found via Invidious")


def clean_url(url):
    """Clean YouTube URL to remove playlist parameters"""
    if not url:
        return url
    if "youtube.com" in url or "youtu.be" in url:
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)
        if 'v' in params:
            return f"https://www.youtube.com/watch?v={params['v'][0]}"
    return url


def get_ydl_opts(for_download=False, format_str="best"):
    """Get yt-dlp options that work with current YouTube restrictions"""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": False,
        "no_color": True,
        "extractor_args": {
            "youtube": {
                # Use multiple clients on Render as fallback chain (data-center IPs get blocked)
                # Fall back to web on local where Firefox cookies are available
                "player_client": ["ios", "tv_embedded", "mweb"] if ON_RENDER else ["web", "ios", "tv_embedded"],
                # Performance: skip DASH manifest for info-only requests
                "skip_dash_manifest": not for_download,
            }
        },
        # Network settings optimized for speed
        "socket_timeout": 30,  # Reduced from 60 seconds
        "retries": 2,  # Reduced retries for faster failure
        "fragment_retries": 2,
        "file_access_retries": 2,
        # HTTP settings
        "http_chunk_size": 10485760,  # 10MB chunks
    }
    
    # Additional optimizations for info requests
    if not for_download:
        opts.update({
            # Skip thumbnail extraction for faster loading
            "writethumbnail": False,
            "writeinfojson": False,
            # Reduce format processing overhead
            "listformats": False,
            # Skip subtitle info for faster metadata
            "listsubtitles": False,
            "writeautomaticsub": False,
            "writesubtitles": False,
        })
    
    if for_download:
        # Simplify format - let yt-dlp choose the best available
        # The format_str from client is already simple like "best" or "best[height<=720]/best"
        opts.update({
            "format": format_str,
            # Prefer mp4 when possible, but don't require it
            "format_sort": ["ext:mp4:m4a", "res"],
        })
        
        # Initialize postprocessors list
        opts["postprocessors"] = []
        
        if FFMPEG_AVAILABLE:
            opts["merge_output_format"] = "mp4"
            if format_str == "bestaudio" or format_str == "bestaudio/best":
                opts["postprocessors"].append({
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                })
    else:
        opts["skip_download"] = True

    if ON_RENDER:
        if COOKIES_FILE:
            opts["cookiesfile"] = COOKIES_FILE
    else:
        opts["cookiesfrombrowser"] = ("firefox",)

    return opts

@app.route("/worker/jobs", methods=["GET"])
@require_worker_key
def worker_jobs():
    """Worker polls this to claim pending jobs."""
    return jsonify({"jobs": job_queue.take_pending()})


@app.route("/worker/result", methods=["POST"])
@require_worker_key
def worker_result():
    """Worker posts resolved job results here."""
    data = request.get_json()
    job_id = data.get("job_id") if data else None
    if not job_id:
        return jsonify({"error": "job_id required"}), 400
    job_queue.set_result(job_id, data.get("result"), data.get("error"))
    return jsonify({"ok": True})


def _build_download_filename(video_title, channel_name, resolution, codec, ext):
    safe_title = "".join(c for c in video_title if c.isalnum() or c in " -_").strip() or "video"
    safe_channel = "".join(c for c in channel_name if c.isalnum() or c in " -_").strip()
    if safe_channel and resolution and codec:
        filename = f"{safe_title} - {safe_channel} ({resolution}, {codec}){ext}"
    elif safe_channel and resolution:
        filename = f"{safe_title} - {safe_channel} ({resolution}){ext}"
    elif safe_channel:
        filename = f"{safe_title} - {safe_channel}{ext}"
    else:
        filename = f"{safe_title}{ext}"
    return filename


def stream_from_worker_result(data, video_title, channel_name, resolution, codec, format_str):
    """Proxy the video stream from googlevideo.com CDN URLs resolved by the local worker."""
    from urllib.parse import quote

    stream_urls = data.get("stream_urls", [])
    if not stream_urls:
        return jsonify({"error": "No stream URLs returned by worker"}), 500

    title = video_title or data.get("title", "video")
    channel = channel_name or data.get("channel", "")
    height = data.get("height")
    ext = "." + data.get("ext", "mp4").lstrip(".")
    res_str = resolution or (f"{height}p" if height else "")
    codec_str = codec or data.get("vcodec_display", "")

    filename = _build_download_filename(title, channel, res_str, codec_str, ext)
    filename_encoded = quote(filename)
    ascii_filename = "".join(c if ord(c) < 128 else '_' for c in filename)

    is_audio = format_str in ("bestaudio", "bestaudio/best")
    mime_type = "audio/mpeg" if is_audio else "video/mp4"

    headers = {
        "Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{filename_encoded}",
        "Content-Type": mime_type,
        "Cache-Control": "no-cache",
    }

    if len(stream_urls) == 1:
        cdn_url = stream_urls[0]

        def generate_single():
            req = urllib.request.Request(cdn_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                content_length = resp.headers.get("Content-Length")
                if content_length:
                    headers["Content-Length"] = content_length
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    yield chunk

        return Response(stream_with_context(generate_single()), mimetype=mime_type, headers=headers)

    else:
        # Separate video + audio — merge on-the-fly with FFmpeg
        cmd = [
            "ffmpeg",
            "-i", stream_urls[0],
            "-i", stream_urls[1],
            "-c", "copy",
            "-f", "mp4",
            "-movflags", "frag_keyframe+empty_moov",
            "pipe:1",
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        def generate_merged():
            try:
                while True:
                    chunk = proc.stdout.read(65536)
                    if not chunk:
                        break
                    yield chunk
            finally:
                proc.stdout.close()
                proc.wait()

        return Response(stream_with_context(generate_merged()), mimetype="video/mp4", headers=headers)


@app.route("/health", methods=["GET"])
@limiter.limit(RATE_LIMITS["health"])
def health_check():
    return jsonify({
        "status": "ok",
        "deno": DENO_AVAILABLE,
        "ffmpeg": FFMPEG_AVAILABLE
    }), 200

@app.route("/ping", methods=["GET"])
@limiter.limit(RATE_LIMITS["ping"]) 
def ping():
    """Lightweight server status check"""
    return jsonify({"status": "ok"}), 200

@app.route("/disk-space", methods=["GET"])
@limiter.limit(RATE_LIMITS["disk_space"])
def disk_space():
    """Return free disk space for the downloads directory"""
    try:
        download_dir = os.path.expanduser("~/Downloads")
        if not os.path.exists(download_dir):
            download_dir = os.path.expanduser("~")
        usage = shutil.disk_usage(download_dir)
        free_bytes = usage.free
        
        # Human-readable format
        if free_bytes >= 1024 ** 3:
            free_human = f"{free_bytes / (1024 ** 3):.1f} GB"
        elif free_bytes >= 1024 ** 2:
            free_human = f"{free_bytes / (1024 ** 2):.1f} MB"
        else:
            free_human = f"{free_bytes / 1024:.1f} KB"
        
        return jsonify({
            "free_bytes": free_bytes,
            "free_human": free_human,
            "total_bytes": usage.total,
            "used_bytes": usage.used
        }), 200
    except Exception as e:
        logger.error(f"Error getting disk space: {e}")
        return jsonify({"error": str(e)}), 500


# Log file path — use /tmp on Render (ephemeral), project root locally
if ON_RENDER:
    LOG_FILE_PATH = "/tmp/extension_logs.txt"
else:
    LOG_FILE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "extension_logs.txt")

@app.route("/save-logs", methods=["POST"])
@limiter.limit(RATE_LIMITS["save_logs"])
def save_logs():
    """Save extension logs to a file in the project folder"""
    try:
        data = request.get_json()
        logs = data.get("logs", [])
        append = data.get("append", False)
        
        if not logs:
            return jsonify({"success": False, "error": "No logs provided"}), 400
        
        # Format logs as structured text for easy debugging
        log_lines = []
        for entry in logs:
            timestamp = entry.get("timestamp", "")
            # Show just time portion for readability, keep date on first line
            time_part = timestamp[11:23] if len(timestamp) > 23 else timestamp
            source = entry.get("source", "unknown").upper()
            log_type = entry.get("type", "INFO")
            message = entry.get("message", "")
            data_str = entry.get("data", "")

            # Structured format: TIME | SOURCE | LEVEL | message
            level_pad = log_type.ljust(8)
            source_pad = source.ljust(10)
            line = f"{time_part}  {source_pad}  {level_pad}  {message}"
            if data_str and data_str != "null":
                # Pretty-print data on next line indented for readability
                line += f"\n{'':>36}  {data_str}"
            log_lines.append(line)

        log_text = "\n".join(log_lines)
        
        # Write to file
        mode = "a" if append else "w"
        with open(LOG_FILE_PATH, mode, encoding="utf-8") as f:
            if append and os.path.exists(LOG_FILE_PATH) and os.path.getsize(LOG_FILE_PATH) > 0:
                f.write("\n")
            f.write(log_text)
        
        logger.info(f"Saved {len(logs)} log entries to {LOG_FILE_PATH}")
        return jsonify({
            "success": True, 
            "path": LOG_FILE_PATH,
            "entries": len(logs)
        }), 200
        
    except Exception as e:
        logger.error(f"Error saving logs: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/clear-log-file", methods=["POST"])
def clear_log_file():
    """Clear the log file"""
    try:
        if os.path.exists(LOG_FILE_PATH):
            os.remove(LOG_FILE_PATH)
            logger.info(f"Cleared log file: {LOG_FILE_PATH}")
        return jsonify({"success": True}), 200
    except Exception as e:
        logger.error(f"Error clearing log file: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/get-log-file", methods=["GET"])
def get_log_file():
    """Get the contents of the log file"""
    try:
        if os.path.exists(LOG_FILE_PATH):
            with open(LOG_FILE_PATH, "r", encoding="utf-8") as f:
                content = f.read()
            return jsonify({
                "success": True,
                "content": content,
                "path": LOG_FILE_PATH
            }), 200
        else:
            return jsonify({
                "success": True,
                "content": "",
                "path": LOG_FILE_PATH
            }), 200
    except Exception as e:
        logger.error(f"Error reading log file: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


def format_timestamp(seconds):
    """Format seconds to HH:MM:SS or MM:SS"""
    if seconds is None:
        return "00:00"
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def extract_chapters(info_dict):
    """Extract chapter information from video metadata"""
    chapters_raw = info_dict.get("chapters", [])

    if not chapters_raw:
        logger.info("No chapters found in video")
        return None

    video_duration = info_dict.get("duration") or 0

    chapters = []
    for i, ch in enumerate(chapters_raw):
        start_time = ch.get("start_time") or 0
        end_time = ch.get("end_time") or 0

        # Last chapter often has end_time=0 or missing — fall back to video duration
        if end_time <= start_time:
            if i + 1 < len(chapters_raw):
                end_time = chapters_raw[i + 1].get("start_time") or 0
            else:
                end_time = video_duration

        chapter = {
            "index": i,
            "title": ch.get("title", f"Chapter {i + 1}"),
            "start_time": start_time,
            "end_time": end_time,
            "start_formatted": format_timestamp(start_time),
            "end_formatted": format_timestamp(end_time),
            "duration": end_time - start_time,
            "duration_formatted": format_timestamp(end_time - start_time)
        }
        chapters.append(chapter)

    logger.info(f"Extracted {len(chapters)} chapters from video")
    return chapters


def embed_chapters_in_video(video_path, chapters, temp_dir):
    """Embed chapter metadata into video file using FFmpeg"""
    if not chapters or not FFMPEG_AVAILABLE:
        return video_path
    
    try:
        # Create FFmpeg metadata file
        metadata_path = os.path.join(temp_dir, "chapters_metadata.txt")
        
        with open(metadata_path, "w", encoding="utf-8") as f:
            f.write(";FFMETADATA1\n")
            
            for chapter in chapters:
                start_ms = int(chapter["start_time"] * 1000)
                end_ms = int(chapter["end_time"] * 1000)
                title = chapter["title"].replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#").replace("\n", " ")
                
                f.write("\n[CHAPTER]\n")
                f.write("TIMEBASE=1/1000\n")
                f.write(f"START={start_ms}\n")
                f.write(f"END={end_ms}\n")
                f.write(f"title={title}\n")
        
        # Create output filename
        base, ext = os.path.splitext(video_path)
        output_path = os.path.join(temp_dir, f"chaptered_video{ext}")
        
        # Run FFmpeg to embed chapters
        cmd = [
            "ffmpeg",
            "-i", video_path,
            "-i", metadata_path,
            "-map_metadata", "1",
            "-codec", "copy",
            "-y",  # Overwrite output file if exists
            output_path
        ]
        
        logger.info(f"Embedding {len(chapters)} chapters into video...")
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        
        if result.returncode == 0 and os.path.exists(output_path):
            # Remove original file and use the chaptered version
            os.remove(video_path)
            logger.info(f"Successfully embedded {len(chapters)} chapters")
            return output_path
        else:
            logger.warning(f"FFmpeg chapter embedding failed: {result.stderr[:500] if result.stderr else 'Unknown error'}")
            return video_path
            
    except subprocess.TimeoutExpired:
        logger.warning("FFmpeg chapter embedding timed out, using original file")
        return video_path
    except Exception as e:
        logger.warning(f"Chapter embedding failed: {e}, using original file")
        return video_path


@app.route("/info", methods=["GET"])
@limiter.limit(RATE_LIMITS["info"])
def info():
    """Get video metadata without downloading"""
    url = request.args.get("url")
    
    if not url:
        return jsonify({"error": "URL parameter is required"}), 400
    
    url = clean_url(url)
    
    # Extract video ID for caching
    video_id = None
    if "youtube.com" in url or "youtu.be" in url:
        parsed = urllib.parse.urlparse(url)
        params = urllib.parse.parse_qs(parsed.query)
        video_id = params.get('v', [None])[0]
    
    # Check cache first
    if video_id:
        cached = video_cache.get(video_id)
        if cached:
            return jsonify(cached)

    if RENDER_MODE:
        job_id, ev = job_queue.create("info", url=url)
        logger.info(f"Queued info job {job_id} for {url}")
        if not ev.wait(timeout=60):
            job_queue.pop_result(job_id)
            return jsonify({"error": "Worker did not respond in time"}), 504
        outcome = job_queue.pop_result(job_id)
        if not outcome or outcome.get("error"):
            return jsonify({"success": False, "error": (outcome or {}).get("error", "No result from worker")}), 500
        result = outcome["result"]
        if video_id:
            video_cache.set(video_id, result)
        return jsonify(result)

    if ON_RENDER:
        if not video_id:
            return jsonify({"success": False, "error": "Only YouTube watch URLs are supported in hosted mode"}), 400
        logger.info(f"Fetching info via Invidious for: {video_id}")
        try:
            result = invidious_get_info(video_id)
            video_cache.set(video_id, result)
            return jsonify(result)
        except Exception as e:
            logger.error(f"Invidious error: {e}")
            return jsonify({"success": False, "error": str(e)}), 500

    logger.info(f"Fetching info for: {url}")
    
    ydl_opts = get_ydl_opts(for_download=False)
    
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=False)
            
            # Fast format processing - focus on video qualities only
            available_qualities = []
            resolution_filesizes = {}
            seen_heights = set()
            
            # Process formats - collect best filesize info per resolution
            video_formats = [f for f in info_dict.get("formats", [])
                           if f.get("height") and f.get("vcodec") != "none"]

            duration = info_dict.get("duration") or 0

            for f in video_formats:
                height = f.get("height")
                vcodec = f.get("vcodec", "")
                filesize = f.get("filesize") or f.get("filesize_approx") or 0
                tbr = f.get("tbr") or 0  # total bitrate in kbps
                vbr = f.get("vbr") or 0  # video bitrate in kbps

                # Estimate filesize from bitrate if not available
                if not filesize and duration > 0:
                    bitrate = tbr or vbr
                    if bitrate:
                        filesize = int(bitrate * 1000 / 8 * duration)  # bits to bytes

                # Track best filesize per resolution
                if filesize and (height not in resolution_filesizes or filesize > resolution_filesizes[height]):
                    resolution_filesizes[height] = filesize

                # Only create one entry per resolution
                if height in seen_heights:
                    continue
                seen_heights.add(height)

                # Quick codec detection
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

            # Back-patch filesize onto every quality entry (including estimates)
            # Add ~10% for audio stream estimate
            for q in available_qualities:
                h = q["height"]
                if h in resolution_filesizes:
                    q["filesize"] = int(resolution_filesizes[h] * 1.1)

            # Sort by height (highest first)
            available_qualities.sort(key=lambda x: x["height"], reverse=True)
            
            # Use available_qualities directly (already unique)
            unique_qualities = available_qualities
            
            # Simplified formats array for compatibility (optional)
            formats = [{
                "format_id": "best",
                "ext": "mp4", 
                "resolution": f"{max(seen_heights) if seen_heights else 720}p",
                "height": max(seen_heights) if seen_heights else 720,
                "vcodec": "h264",
                "acodec": "aac",
            }] if seen_heights else []
            
            logger.info(f"Found {len(unique_qualities)} unique resolutions for: {info_dict.get('title')}")
            
            result = {
                "success": True,
                "id": info_dict.get("id"),
                "title": info_dict.get("title"),
                "thumbnail": info_dict.get("thumbnail"),
                "duration": info_dict.get("duration"),
                "channel": info_dict.get("channel"),
                "view_count": info_dict.get("view_count"),
                "upload_date": info_dict.get("upload_date"),
                "formats": formats,
                "available_qualities": unique_qualities,
                "chapters": extract_chapters(info_dict)
            }
            
            # Cache the result
            if video_id:
                video_cache.set(video_id, result)
            
            return jsonify(result)
    except Exception as e:
        logger.error(f"Error fetching info: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/download", methods=["GET"])
@limiter.limit(RATE_LIMITS["download"])
def download():
    """Download video and stream to client"""
    url = request.args.get("url")
    format_str = request.args.get("format", "best")
    # Get metadata for filename
    video_title = request.args.get("title", "")
    channel_name = request.args.get("channel", "")
    resolution = request.args.get("resolution", "")
    codec = request.args.get("codec", "")
    subtitles = request.args.get("subtitles", "")  # Subtitle language code
    
    if not url:
        return jsonify({"error": "URL parameter is required"}), 400
    
    url = clean_url(url)
    logger.info(f"Starting download: {url} (format: {format_str})")

    if RENDER_MODE:
        job_id, ev = job_queue.create("resolve", url=url, format=format_str)
        logger.info(f"Queued resolve job {job_id} for {url}")
        if not ev.wait(timeout=120):
            job_queue.pop_result(job_id)
            return jsonify({"error": "Worker did not respond in time"}), 504
        outcome = job_queue.pop_result(job_id)
        if not outcome or outcome.get("error"):
            return jsonify({"success": False, "error": (outcome or {}).get("error", "No result from worker")}), 500
        return stream_from_worker_result(outcome["result"], video_title, channel_name, resolution, codec, format_str)

    if ON_RENDER:
        parsed = urllib.parse.urlparse(url)
        vid = urllib.parse.parse_qs(parsed.query).get("v", [None])[0]
        if not vid:
            return jsonify({"error": "Only YouTube watch URLs are supported in hosted mode"}), 400
        logger.info(f"Fetching streams via Invidious for: {vid}")
        try:
            data = invidious_get_streams(vid, format_str)
            return stream_from_worker_result(data, video_title, channel_name, resolution, codec, format_str)
        except Exception as e:
            logger.error(f"Invidious error: {e}")
            return jsonify({"success": False, "error": str(e)}), 500

    temp_dir = None
    
    try:
        # Create temp directory for download
        temp_dir = tempfile.mkdtemp()
        output_template = os.path.join(temp_dir, "%(title)s.%(ext)s")
        
        # Get download options
        ydl_opts = get_ydl_opts(for_download=True, format_str=format_str)
        ydl_opts["outtmpl"] = output_template
        
        # Add subtitle options if requested
        if subtitles:
            logger.info(f"Subtitles requested: {subtitles}")
            ydl_opts["writesubtitles"] = True
            ydl_opts["writeautomaticsub"] = True  # Always try auto-generated too
            
            if subtitles == "auto":
                # For auto, get any available auto-generated subs
                ydl_opts["subtitleslangs"] = ["en", "en-orig", "en-US", "en-GB"]
            else:
                # Include the language and common variants
                ydl_opts["subtitleslangs"] = [subtitles, f"{subtitles}-orig", f"{subtitles}-US", f"{subtitles}-GB"]
            
            ydl_opts["subtitlesformat"] = "srt/vtt/best"
            
            # Embed subtitles in video if FFmpeg available
            if FFMPEG_AVAILABLE:
                # Initialize postprocessors list if not exists
                if "postprocessors" not in ydl_opts:
                    ydl_opts["postprocessors"] = []
                ydl_opts["postprocessors"].append({
                    "key": "FFmpegEmbedSubtitle",
                    "already_have_subtitle": False
                })
                logger.info("Subtitles will be embedded in video")
            else:
                logger.warning("FFmpeg not available - subtitles will be saved as separate file")
        
        logger.info(f"Downloading to: {temp_dir}")
        
        # Download the video
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            
            # Get video info for filename if not provided
            if not video_title:
                video_title = info.get("title", "video")
            if not channel_name:
                channel_name = info.get("channel", info.get("uploader", "Unknown"))
            
            # Get actual downloaded format info
            if not resolution or not codec:
                # Try to get from the downloaded format
                requested_formats = info.get("requested_formats", [])
                if requested_formats:
                    video_fmt = next((f for f in requested_formats if f.get("vcodec") != "none"), None)
                    if video_fmt:
                        if not resolution:
                            resolution = f"{video_fmt.get('height', '')}p"
                        if not codec:
                            vcodec = video_fmt.get("vcodec", "")
                            codec = "h264" if "avc" in vcodec.lower() else \
                                   "h265" if "hevc" in vcodec.lower() else \
                                   "vp9" if "vp9" in vcodec.lower() else \
                                   "av1" if "av01" in vcodec.lower() else \
                                   vcodec.split(".")[0] if vcodec else ""
                elif info.get("height"):
                    if not resolution:
                        resolution = f"{info.get('height')}p"
                    if not codec:
                        vcodec = info.get("vcodec", "")
                        codec = "h264" if "avc" in vcodec.lower() else \
                               "h265" if "hevc" in vcodec.lower() else \
                               "vp9" if "vp9" in vcodec.lower() else \
                               "av1" if "av01" in vcodec.lower() else \
                               vcodec.split(".")[0] if vcodec else ""
        
        # Find the downloaded file — pick the largest file to avoid picking subtitle sidecar files
        VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mp3", ".m4a", ".opus", ".ogg", ".flac", ".wav"}
        downloaded_file = None
        best_size = -1
        for f in os.listdir(temp_dir):
            filepath = os.path.join(temp_dir, f)
            if not os.path.isfile(filepath):
                continue
            ext = os.path.splitext(f)[1].lower()
            if ext not in VIDEO_EXTS:
                continue
            size = os.path.getsize(filepath)
            if size > best_size:
                best_size = size
                downloaded_file = filepath
        
        if not downloaded_file or not os.path.exists(downloaded_file):
            logger.error("Download failed - no file found")
            if temp_dir:
                shutil.rmtree(temp_dir, ignore_errors=True)
            return jsonify({"error": "Download failed - no file created"}), 500
        
        # Embed chapters if available and FFmpeg is present (skip for audio-only formats)
        CHAPTER_SUPPORTED_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}
        chapters = extract_chapters(info)
        if chapters and FFMPEG_AVAILABLE and os.path.splitext(downloaded_file)[1].lower() in CHAPTER_SUPPORTED_EXTS:
            downloaded_file = embed_chapters_in_video(downloaded_file, chapters, temp_dir)
        
        file_size = os.path.getsize(downloaded_file)
        ext = os.path.splitext(downloaded_file)[1] or ".mp4"
        
        # Build filename: "Video Title - Channel (Resolution, Codec).ext"
        # Clean characters for filename - be more restrictive for HTTP headers
        safe_title = "".join(c for c in video_title if c.isalnum() or c in " -_").strip()
        safe_channel = "".join(c for c in channel_name if c.isalnum() or c in " -_").strip()
        
        if not safe_title:
            safe_title = "video"
        
        # Build the filename parts
        if safe_channel and resolution and codec:
            filename = f"{safe_title} - {safe_channel} ({resolution}, {codec}){ext}"
        elif safe_channel and resolution:
            filename = f"{safe_title} - {safe_channel} ({resolution}){ext}"
        elif safe_channel:
            filename = f"{safe_title} - {safe_channel}{ext}"
        else:
            filename = f"{safe_title}{ext}"
        
        # URL-encode the filename for Content-Disposition header (RFC 5987)
        from urllib.parse import quote
        filename_encoded = quote(filename)
        
        logger.info(f"Download complete: {filename} ({file_size} bytes)")
        
        # Determine mime type
        mime_types = {
            ".mp4": "video/mp4",
            ".webm": "video/webm",
            ".mkv": "video/x-matroska",
            ".mp3": "audio/mpeg",
            ".m4a": "audio/mp4",
            ".opus": "audio/opus",
        }
        mime_type = mime_types.get(ext.lower(), "application/octet-stream")
        
        def generate():
            try:
                with open(downloaded_file, "rb") as f:
                    while True:
                        chunk = f.read(65536)  # 64KB chunks
                        if not chunk:
                            break
                        yield chunk
            finally:
                # Cleanup temp directory
                try:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    logger.info("Temp files cleaned up")
                except Exception as e:
                    logger.error(f"Cleanup error: {e}")
        
        # Build response headers with proper filename encoding
        # Use both filename (ASCII fallback) and filename* (UTF-8 encoded) for compatibility
        ascii_filename = "".join(c if ord(c) < 128 else '_' for c in filename)
        headers = {
            "Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{filename_encoded}",
            "Content-Length": str(file_size),
            "Content-Type": mime_type,
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        }
        
        return Response(
            stream_with_context(generate()),
            mimetype=mime_type,
            headers=headers
        )
        
    except Exception as e:
        logger.error(f"Download error: {e}")
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/playlist-info", methods=["GET"])
@limiter.limit(RATE_LIMITS["playlist_info"])
def playlist_info():
    """Get playlist metadata without downloading"""
    url = request.args.get("url")
    
    if not url:
        return jsonify({"error": "URL parameter is required"}), 400
    
    logger.info(f"Fetching playlist info for: {url}")
    
    ydl_opts = get_ydl_opts(for_download=False)
    ydl_opts["extract_flat"] = True  # Don't extract individual videos, just the playlist info
    ydl_opts["playlistend"] = 1  # Only check first video to get playlist metadata faster
    
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=False)
            
            # Check if this is actually a playlist
            if info_dict.get("_type") != "playlist" and not info_dict.get("entries"):
                return jsonify({"success": False, "error": "Not a playlist URL"}), 400
            
            # Get full playlist info (need to re-extract without flat for count)
            ydl_opts_full = get_ydl_opts(for_download=False)
            ydl_opts_full["extract_flat"] = "in_playlist"
            
            with YoutubeDL(ydl_opts_full) as ydl_full:
                full_info = ydl_full.extract_info(url, download=False)
                entries = full_info.get("entries", [])
                video_count = len([e for e in entries if e]) if entries else 0
            
            result = {
                "success": True,
                "id": info_dict.get("id"),
                "title": info_dict.get("title", "Unknown Playlist"),
                "channel": info_dict.get("channel") or info_dict.get("uploader", "Unknown"),
                "video_count": video_count,
                "thumbnail": info_dict.get("thumbnails", [{}])[0].get("url") if info_dict.get("thumbnails") else None,
            }
            
            logger.info(f"Playlist: {result['title']} ({video_count} videos)")
            return jsonify(result)
            
    except Exception as e:
        logger.error(f"Error fetching playlist info: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/download-playlist", methods=["GET"])
@limiter.limit(RATE_LIMITS["download_playlist"])
def download_playlist():
    """Download entire playlist and stream as ZIP"""
    url = request.args.get("url")
    format_str = request.args.get("format", "best")
    playlist_title = request.args.get("playlist_title", "playlist")
    resolution = request.args.get("resolution", "")
    subtitles = request.args.get("subtitles", "")
    
    if not url:
        return jsonify({"error": "URL parameter is required"}), 400
    
    logger.info(f"Starting playlist download: {url} (format: {format_str})")
    
    temp_dir = None
    
    try:
        # Create temp directory for downloads
        temp_dir = tempfile.mkdtemp()
        output_template = os.path.join(temp_dir, "%(playlist_index)02d - %(title)s.%(ext)s")
        
        # Get download options
        ydl_opts = get_ydl_opts(for_download=True, format_str=format_str)
        ydl_opts["outtmpl"] = output_template
        ydl_opts["noplaylist"] = False  # Enable playlist download
        ydl_opts["ignoreerrors"] = True  # Continue on individual video errors
        
        # Add subtitle options if requested
        if subtitles:
            logger.info(f"Subtitles requested for playlist: {subtitles}")
            ydl_opts["writesubtitles"] = True
            ydl_opts["writeautomaticsub"] = True
            
            if subtitles == "auto":
                ydl_opts["subtitleslangs"] = ["en", "en-orig", "en-US", "en-GB"]
            else:
                ydl_opts["subtitleslangs"] = [subtitles, f"{subtitles}-orig", f"{subtitles}-US", f"{subtitles}-GB"]
            
            ydl_opts["subtitlesformat"] = "srt/vtt/best"
            
            if FFMPEG_AVAILABLE:
                if "postprocessors" not in ydl_opts:
                    ydl_opts["postprocessors"] = []
                ydl_opts["postprocessors"].append({
                    "key": "FFmpegEmbedSubtitle",
                    "already_have_subtitle": False
                })
        
        logger.info(f"Downloading playlist to: {temp_dir}")
        
        # Download the playlist
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            playlist_name = info.get("title", playlist_title)
        
        # Find all downloaded files
        downloaded_files = []
        for f in sorted(os.listdir(temp_dir)):
            filepath = os.path.join(temp_dir, f)
            if os.path.isfile(filepath) and not f.endswith(('.vtt', '.srt', '.ass')):
                downloaded_files.append(filepath)
        
        if not downloaded_files:
            logger.error("Playlist download failed - no files found")
            if temp_dir:
                shutil.rmtree(temp_dir, ignore_errors=True)
            return jsonify({"error": "Playlist download failed - no files created"}), 500
        
        logger.info(f"Downloaded {len(downloaded_files)} videos from playlist")
        
        # Create ZIP file in memory
        zip_path = os.path.join(temp_dir, "playlist.zip")
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for filepath in downloaded_files:
                arcname = os.path.basename(filepath)
                zipf.write(filepath, arcname)
        
        zip_size = os.path.getsize(zip_path)
        
        # Build filename
        safe_title = "".join(c for c in playlist_name if c.isalnum() or c in " -_").strip()
        if not safe_title:
            safe_title = "playlist"
        
        if resolution:
            filename = f"{safe_title} ({resolution}).zip"
        else:
            filename = f"{safe_title}.zip"
        
        from urllib.parse import quote
        filename_encoded = quote(filename)
        ascii_filename = "".join(c if ord(c) < 128 else '_' for c in filename)
        
        logger.info(f"Playlist ZIP ready: {filename} ({zip_size} bytes, {len(downloaded_files)} videos)")
        
        def generate():
            try:
                with open(zip_path, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        yield chunk
            finally:
                try:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                    logger.info("Playlist temp files cleaned up")
                except Exception as e:
                    logger.error(f"Cleanup error: {e}")
        
        headers = {
            "Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{filename_encoded}",
            "Content-Length": str(zip_size),
            "Content-Type": "application/zip",
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        }
        
        return Response(
            stream_with_context(generate()),
            mimetype="application/zip",
            headers=headers
        )
        
    except Exception as e:
        logger.error(f"Playlist download error: {e}")
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    print("\n" + "="*60)
    print("YouTube Downloader API")
    print("="*60)
    print(f"Server: http://localhost:5000")
    print(f"Deno: {'✓ Available' if DENO_AVAILABLE else '✗ Not found'}")
    print(f"FFmpeg: {'✓ Available' if FFMPEG_AVAILABLE else '✗ Not found'}")
    print("="*60)
    print("Endpoints:")
    print("  GET /health - Check server status")
    print("  GET /info?url=<youtube_url> - Get video info")
    print("  GET /download?url=<youtube_url>&format=<format> - Download video")
    print("  GET /playlist-info?url=<playlist_url> - Get playlist info")
    print("  GET /download-playlist?url=<playlist_url>&format=<format> - Download playlist")
    print("="*60 + "\n")
    app.run(debug=DEBUG, host=HOST, port=PORT, threaded=True, use_reloader=False)