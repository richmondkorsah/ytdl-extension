from flask import Flask, jsonify, request, Response, stream_with_context
from flask_cors import CORS
from yt_dlp import YoutubeDL
import os
import tempfile
import subprocess
import logging
import shutil
import urllib.parse

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

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
        
        if FFMPEG_AVAILABLE:
            opts["merge_output_format"] = "mp4"
            if format_str == "bestaudio" or format_str == "bestaudio/best":
                opts["postprocessors"] = [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }]
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
    logger.info(f"Fetching info for: {url}")
    
    ydl_opts = get_ydl_opts(for_download=False)
    
    try:
        with YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=False)
            
            # Get available formats
            formats = []
            for f in info_dict.get("formats", []):
                formats.append({
                    "format_id": f.get("format_id"),
                    "ext": f.get("ext"),
                    "resolution": f.get("resolution", "audio only"),
                    "filesize": f.get("filesize"),
                    "vcodec": f.get("vcodec"),
                    "acodec": f.get("acodec"),
                })
            
            logger.info(f"Found {len(formats)} formats for: {info_dict.get('title')}")
            
            return jsonify({
                "success": True,
                "id": info_dict.get("id"),
                "title": info_dict.get("title"),
                "thumbnail": info_dict.get("thumbnail"),
                "duration": info_dict.get("duration"),
                "channel": info_dict.get("channel"),
                "view_count": info_dict.get("view_count"),
                "upload_date": info_dict.get("upload_date"),
                "formats": formats
            })
    except Exception as e:
        logger.error(f"Error fetching info: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/download", methods=["GET"])
def download():
    """Download video and stream to client"""
    url = request.args.get("url")
    format_str = request.args.get("format", "best")
    
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
        
        logger.info(f"Downloading to: {temp_dir}")
        
        # Download the video
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get("title", "video")
            # Clean filename for headers
            safe_title = "".join(c for c in title if c.isalnum() or c in " -_").strip()
            if not safe_title:
                safe_title = "video"
        
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
        filename = f"{safe_title}{ext}"
        
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
        
        # Build response headers
        headers = {
            "Content-Disposition": f'attachment; filename="{filename}"',
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
    print("="*60 + "\n")
    app.run(debug=True, port=5000, threaded=True)