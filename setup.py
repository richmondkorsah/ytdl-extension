#!/usr/bin/env python3
"""
Run once to set up the YT Downloader server to auto-start on Windows login.

Usage:
    python setup.py          # install
    python setup.py remove   # uninstall
"""
import os, sys, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHONW = os.path.join(HERE, ".venv", "Scripts", "pythonw.exe")
SERVER = os.path.join(HERE, "backend", "server.py")
BACKEND_DIR = os.path.join(HERE, "backend")
STARTUP_DIR = os.path.join(os.environ["APPDATA"], "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
SHORTCUT = os.path.join(STARTUP_DIR, "YTDownloaderServer.lnk")


def install():
    if not os.path.exists(PYTHONW):
        print(f"ERROR: pythonw.exe not found at {PYTHONW}")
        print("Set up the venv first: python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt")
        sys.exit(1)

    # Create a silent shortcut in the Windows startup folder using PowerShell
    ps = f"""
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('{SHORTCUT}')
$sc.TargetPath = '{PYTHONW}'
$sc.Arguments = '"{SERVER}"'
$sc.WorkingDirectory = '{BACKEND_DIR}'
$sc.WindowStyle = 7
$sc.Description = 'YT Downloader Flask Server'
$sc.Save()
"""
    result = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True)
    if result.returncode != 0:
        print("ERROR creating shortcut:")
        print(result.stderr)
        sys.exit(1)

    print("SUCCESS: Server will now start automatically on Windows login.")
    print(f"Shortcut: {SHORTCUT}")
    print()
    print("To start it right now without logging out:")
    print(f'  "{PYTHONW}" "{SERVER}"')


def remove():
    if os.path.exists(SHORTCUT):
        os.remove(SHORTCUT)
        print("Removed startup shortcut.")
    else:
        print("No startup shortcut found.")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "remove":
        remove()
    else:
        install()
