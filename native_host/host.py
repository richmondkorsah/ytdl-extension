#!/usr/bin/env python3
"""
Native Messaging Host for YouTube Downloader Extension.
Firefox communicates with this script via stdin/stdout to auto-start the Flask server.
"""
import sys
import json
import struct
import subprocess
import os
import socket


def read_message():
    """Read a native messaging message (4-byte LE length prefix + JSON body)."""
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode("utf-8"))


def send_message(obj):
    """Write a native messaging message to stdout."""
    encoded = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def is_server_running(port=5000):
    """Check if the Flask server is already listening on localhost."""
    try:
        with socket.create_connection(("localhost", port), timeout=1):
            return True
    except OSError:
        return False


def start_server():
    """Launch server.py as a fully detached background process."""
    # native_host/ is one level below the project root
    here = os.path.dirname(os.path.abspath(__file__))
    project = os.path.dirname(here)

    server_script = os.path.join(project, "backend", "server.py")
    venv_python = os.path.join(project, ".venv", "Scripts", "python.exe")

    if not os.path.exists(venv_python):
        venv_python = os.path.join(project, ".venv", "bin", "python")
    if not os.path.exists(venv_python):
        venv_python = sys.executable  # last resort

    if not os.path.exists(server_script):
        return False, f"server.py not found: {server_script}"

    try:
        kwargs = dict(
            cwd=os.path.join(project, "backend"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
        )
        if os.name == "nt":
            kwargs["creationflags"] = (
                subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            )
        else:
            kwargs["start_new_session"] = True

        subprocess.Popen([venv_python, server_script], **kwargs)
        return True, "Server process launched"
    except Exception as exc:
        return False, str(exc)


def main():
    while True:
        msg = read_message()
        if msg is None:
            break

        action = msg.get("action")

        if action == "start":
            if is_server_running():
                send_message({"success": True, "message": "Server already running"})
            else:
                ok, text = start_server()
                send_message({"success": ok, "message": text})

        elif action == "ping":
            send_message({"success": True, "running": is_server_running()})

        else:
            send_message({"success": False, "error": f"Unknown action: {action}"})


if __name__ == "__main__":
    main()
