from flask import jsonify
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["200 per day", "50 per hour"],
    storage_uri="memory://"
)

# Route-specific rate limits (centralized configuration)
RATE_LIMITS = {
    "health": "30 per minute",
    "ping": "60 per minute",
    "disk_space": "30 per minute",
    "info": "30 per minute",
    "download": "10 per hour",
    "playlist_info": "20 per minute",
    "download_playlist": "5 per hour",
}


def init_limiter(app):
    """Initialize the rate limiter with the Flask app and register error handler."""
    limiter.init_app(app)

    @app.errorhandler(429)
    def ratelimit_handler(e):
        """Handle rate limit exceeded"""
        return jsonify({
            "success": False,
            "error": "Rate limit exceeded",
            "message": "You have made too many requests. Please try again later.",
            "retry_after": e.description
        }), 429
