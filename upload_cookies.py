"""
One-time setup: exports YouTube cookies from Firefox and uploads them to Render.
Run this locally: python upload_cookies.py
"""
import sqlite3
import shutil
import base64
import os
import sys
import glob
import tempfile
import urllib.request
import json


def find_firefox_cookies():
    """Find Firefox cookies.sqlite — works on Windows, Mac, Linux."""
    candidates = [
        os.path.expandvars(r"%APPDATA%\Mozilla\Firefox\Profiles\*\cookies.sqlite"),  # Windows
        os.path.expanduser("~/.mozilla/firefox/*/cookies.sqlite"),                    # Linux
        os.path.expanduser("~/Library/Application Support/Firefox/Profiles/*/cookies.sqlite"),  # Mac
    ]
    for pattern in candidates:
        matches = glob.glob(pattern)
        if matches:
            # Pick the most recently modified profile
            return max(matches, key=os.path.getmtime)
    return None


def export_youtube_cookies(cookies_sqlite):
    """Read YouTube cookies from Firefox's SQLite and write Netscape cookies.txt."""
    tmp_db = os.path.join(tempfile.gettempdir(), "ff_cookies_tmp.sqlite")
    shutil.copy2(cookies_sqlite, tmp_db)  # copy so Firefox lock doesn't block us

    out_lines = ["# Netscape HTTP Cookie File"]
    try:
        conn = sqlite3.connect(tmp_db)
        # Only export the specific cookies YouTube needs for auth — exporting all
        # google.com cookies bloats the env var past Linux's ARG_MAX limit on Render.
        YOUTUBE_COOKIE_NAMES = {
            "SID", "HSID", "SSID", "APISID", "SAPISID",
            "__Secure-1PSID", "__Secure-3PSID",
            "__Secure-1PAPISID", "__Secure-3PAPISID",
            "__Secure-1PSIDTS", "__Secure-3PSIDTS",
            "__Secure-1PSIDCC", "__Secure-3PSIDCC",
            "LOGIN_INFO", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA",
            "YSC", "PREF", "GPS",
        }
        placeholders = ",".join("?" * len(YOUTUBE_COOKIE_NAMES))
        cur = conn.execute(
            "SELECT host, isHttpOnly, path, isSecure, expiry, name, value "
            "FROM moz_cookies "
            f"WHERE (host LIKE '%youtube.com' OR host LIKE '%google.com') "
            f"AND name IN ({placeholders})",
            tuple(YOUTUBE_COOKIE_NAMES),
        )
        for host, http_only, path, secure, expiry, name, value in cur:
            include_subdomains = "TRUE" if host.startswith(".") else "FALSE"
            secure_str = "TRUE" if secure else "FALSE"
            out_lines.append(
                f"{host}\t{include_subdomains}\t{path}\t{secure_str}\t{expiry}\t{name}\t{value}"
            )
        conn.close()
    finally:
        os.remove(tmp_db)

    return "\n".join(out_lines) + "\n"


def get_service_id(api_key):
    req = urllib.request.Request(
        "https://api.render.com/v1/services?limit=20",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req) as r:
        services = json.loads(r.read())
    for item in services:
        svc = item.get("service", {})
        if "ytdl" in svc.get("name", "").lower() or "yt" in svc.get("name", "").lower():
            return svc["id"], svc["name"]
    print("\nAvailable services:")
    for i, item in enumerate(services):
        svc = item.get("service", {})
        print(f"  {i+1}. {svc.get('name')} ({svc.get('id')})")
    choice = int(input("Enter number: ")) - 1
    svc = services[choice]["service"]
    return svc["id"], svc["name"]


def set_env_var(api_key, service_id, key, value):
    req = urllib.request.Request(
        f"https://api.render.com/v1/services/{service_id}/env-vars",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req) as r:
        existing = json.loads(r.read())

    env_vars = []
    for e in existing:
        ev = e.get("envVar", e)
        if ev.get("key") != key:
            env_vars.append({"key": ev["key"], "value": ev["value"]})
    env_vars.append({"key": key, "value": value})

    payload = json.dumps(env_vars).encode()
    req = urllib.request.Request(
        f"https://api.render.com/v1/services/{service_id}/env-vars",
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        method="PUT"
    )
    with urllib.request.urlopen(req) as r:
        return r.status


def main():
    print("=== YouTube Cookie Uploader for Render ===\n")

    # Step 1: Find and export cookies directly from Firefox's database
    print("Locating Firefox cookie database...")
    db_path = find_firefox_cookies()
    if not db_path:
        print("Could not find Firefox cookies. Make sure Firefox is installed and you've visited YouTube.")
        sys.exit(1)
    print(f"✓ Found: {db_path}")

    print("Extracting YouTube/Google cookies...")
    cookies_txt = export_youtube_cookies(db_path)
    line_count = cookies_txt.count("\n") - 1
    print(f"✓ Extracted {line_count} cookies")

    # Step 2: Base64 encode
    encoded = base64.b64encode(cookies_txt.encode("utf-8")).decode("utf-8")

    # Step 3: Upload to Render
    api_key = os.environ.get("RENDER_API_KEY", "")
    if not api_key:
        print("\nGet your Render API key from: https://dashboard.render.com/u/settings#api-keys")
        api_key = input("Render API key: ").strip()

    service_id = os.environ.get("RENDER_SERVICE_ID", "")
    if not service_id:
        service_id, name = get_service_id(api_key)
        print(f"✓ Found service: {name} ({service_id})")

    print("Uploading YOUTUBE_COOKIES to Render...")
    status = set_env_var(api_key, service_id, "YOUTUBE_COOKIES", encoded)
    print(f"✓ Done (HTTP {status}) — Render will redeploy automatically.")
    print("\nRun this script again in a few months if YouTube starts blocking again.")


if __name__ == "__main__":
    main()
