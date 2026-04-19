#!/usr/bin/env python3
"""
Run this script ONCE to register the native messaging host with Firefox.
It creates a launcher batch file and writes the host manifest, then
adds a registry key so Firefox can find it.

Usage:
    python native_host/install.py
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)

HOST_SCRIPT = os.path.join(HERE, "host.py")
MANIFEST_PATH = os.path.join(HERE, "ytdl_companion.json")

# Locate the venv Python
VENV_PYTHON = os.path.join(PROJECT, ".venv", "Scripts", "python.exe")
if not os.path.exists(VENV_PYTHON):
    VENV_PYTHON = os.path.join(PROJECT, ".venv", "bin", "python")
if not os.path.exists(VENV_PYTHON):
    VENV_PYTHON = sys.executable
    print(f"  Warning: venv not found, falling back to: {VENV_PYTHON}")


def install_windows():
    import winreg

    # Create a .bat launcher (Firefox requires an executable path on Windows)
    launcher = os.path.join(HERE, "launch_host.bat")
    with open(launcher, "w") as f:
        f.write(f'@echo off\n"{VENV_PYTHON}" "{HOST_SCRIPT}"\n')
    print(f"  Created launcher : {launcher}")

    # Write the host manifest
    manifest = {
        "name": "ytdl_companion",
        "description": "YouTube Downloader Companion App Launcher",
        "path": launcher,
        "type": "stdio",
        "allowed_extensions": ["ytdl@richmondkorsah"],
    }
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"  Wrote manifest   : {MANIFEST_PATH}")

    # Register in HKCU so no admin rights are needed
    key_path = r"SOFTWARE\Mozilla\NativeMessagingHosts\ytdl_companion"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, MANIFEST_PATH)
    print(f"  Registry key     : HKCU\\{key_path}")


def install_unix():
    import shutil, stat

    # Make host.py executable
    os.chmod(HOST_SCRIPT, os.stat(HOST_SCRIPT).st_mode | stat.S_IEXEC)

    manifest = {
        "name": "ytdl_companion",
        "description": "YouTube Downloader Companion App Launcher",
        "path": HOST_SCRIPT,
        "type": "stdio",
        "allowed_extensions": ["ytdl@richmondkorsah"],
    }
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2)

    candidates = [
        os.path.expanduser("~/.mozilla/native-messaging-hosts"),
        os.path.expanduser(
            "~/Library/Application Support/Mozilla/NativeMessagingHosts"
        ),
    ]
    for nm_dir in candidates:
        parent = os.path.dirname(nm_dir)
        if os.path.isdir(parent):
            os.makedirs(nm_dir, exist_ok=True)
            dest = os.path.join(nm_dir, "ytdl_companion.json")
            shutil.copy(MANIFEST_PATH, dest)
            print(f"  Installed to     : {dest}")
            return
    print("  Could not find Firefox native-messaging-hosts directory.")
    sys.exit(1)


def main():
    print("YouTube Downloader — Native Messaging Host Installer")
    print("=" * 52)

    if os.name == "nt":
        install_windows()
    else:
        install_unix()

    print()
    print("Done! Firefox can now auto-start the companion server.")
    print("Reload the extension (about:debugging) for it to take effect.")


if __name__ == "__main__":
    main()
