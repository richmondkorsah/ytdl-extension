from flask import Flask, jsonify, request, Response, stream_with_context
from flask_cors import CORS
from yt_dlp import YoutubeDL
import os
import tempfile
import subprocess
import logging
import shutil
import urllib.parse
import zipfile

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# Server-side cache for video info (reduces repeated yt-dlp calls)
from functools import lru_cache
from threading import Lock
import time

# Simple in-memory cache with TTL
class VideoInfoCache:
    def __init__(self, ttl=300):  # 5 minute TTL
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
            # Limit cache size to 100 entries
            if len(self.cache) > 100:
                oldest_key = min(self.cache.keys(), key=lambda k: self.cache[k]['timestamp'])
                del self.cache[oldest_key]

video_cache = VideoInfoCache()

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
        # Try to use browser cookies for authentication
        "cookiesfrombrowser": ("firefox",),
        # CRITICAL: Enable remote JS challenge solver for YouTube
        "extractor_args": {
            "youtube": {
                "remote_components": ["ejs:github"],
            }
        },
        # Network settings to handle timeouts
        "socket_timeout": 60,  # 60 seconds timeout
        "retries": 5,  # Retry up to 5 times
        "fragment_retries": 5,
        "file_access_retries": 5,
        # HTTP settings
        "http_chunk_size": 10485760,  # 10MB chunks
    }
    
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
    
    return opts

@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "ok",
        "deno": DENO_AVAILABLE,
        "ffmpeg": FFMPEG_AVAILABLE
    }), 200


@app.route("/info", methods=["GET"])
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
    
    logger.info(f"Fetching info for: {url}")
    
    ydl_opts = get_ydl_opts(for_download=False)
    
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=False)
            
            # Get available formats and extract unique resolutions
            formats = []
            resolutions_seen = set()
            available_qualities = []
            
            for f in info_dict.get("formats", []):
                height = f.get("height")
                vcodec = f.get("vcodec", "none")
                acodec = f.get("acodec", "none")
                
                formats.append({
                    "format_id": f.get("format_id"),
                    "ext": f.get("ext"),
                    "resolution": f.get("resolution", "audio only"),
                    "height": height,
                    "filesize": f.get("filesize"),
                    "vcodec": vcodec,
                    "acodec": acodec,
                })
                
                # Collect unique video resolutions (with video codec)
                if height and vcodec != "none":
                    if height not in resolutions_seen:
                        resolutions_seen.add(height)
                        # Simplify codec name for display
                        codec_display = "h264" if "avc" in vcodec.lower() else \
                                       "h265" if "hevc" in vcodec.lower() or "hev" in vcodec.lower() else \
                                       "vp9" if "vp9" in vcodec.lower() or "vp09" in vcodec.lower() else \
                                       "av1" if "av01" in vcodec.lower() or "av1" in vcodec.lower() else \
                                       vcodec.split(".")[0]
                        available_qualities.append({
                            "height": height,
                            "label": f"{height}p",
                            "codec": codec_display,
                            "vcodec": vcodec,
                        })
            
            # Sort qualities by height (highest first)
            available_qualities.sort(key=lambda x: x["height"], reverse=True)
            
            # Remove duplicates keeping highest quality codec for each resolution
            unique_qualities = []
            seen_heights = set()
            for q in available_qualities:
                if q["height"] not in seen_heights:
                    seen_heights.add(q["height"])
                    unique_qualities.append(q)
            
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
                "available_qualities": unique_qualities
            }
            
            # Cache the result
            if video_id:
                video_cache.set(video_id, result)
            
            return jsonify(result)
    except Exception as e:
        logger.error(f"Error fetching info: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/download", methods=["GET"])
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
        
        # Find the downloaded file
        downloaded_file = None
        for f in os.listdir(temp_dir):
            filepath = os.path.join(temp_dir, f)
            if os.path.isfile(filepath):
                downloaded_file = filepath
                break
        
        if not downloaded_file or not os.path.exists(downloaded_file):
            logger.error("Download failed - no file found")
            if temp_dir:
                shutil.rmtree(temp_dir, ignore_errors=True)
            return jsonify({"error": "Download failed - no file created"}), 500
        
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
    app.run(debug=True, port=5000, threaded=True)