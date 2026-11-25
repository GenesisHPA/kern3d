#!/usr/bin/env python3
# Part of the Chili3d Project, under the AGPL-3.0 License.
# See LICENSE file in the project root for full license information.
"""
Kern3D Станок — the station PC's own server (Debian, systemd unit kern3d-station-web).

Serves the station page from www/ on localhost and a small JSON API the page cannot do from a
browser: Wi-Fi through NetworkManager (nmcli). Only the standard library; runs as the station
user (a polkit rule lets that user change the network).

    GET  /api/wifi            state, the network in use, the ones in range
    POST /api/wifi/rescan
    POST /api/wifi/connect    {"ssid": "...", "password": "..."}
    POST /api/wifi/forget     {"ssid": "..."}
    POST /api/wifi/radio      {"on": true|false}
"""
import json
import os
import subprocess
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "www")
PORT = int(os.environ.get("KERN3D_STATION_PORT", "8080"))
BIND = os.environ.get("KERN3D_STATION_BIND", "127.0.0.1")


def nmcli(*args, timeout=30):
    """nmcli in terse mode; (exit code, stdout, stderr)."""
    p = subprocess.run(["nmcli", "-t", *args], capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr.strip()


def split_terse(line):
    """nmcli -t fields: ':' separates, '\\:' is a colon inside a value."""
    out, cur, esc = [], "", False
    for ch in line:
        if esc:
            cur += ch
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == ":":
            out.append(cur)
            cur = ""
        else:
            cur += ch
    out.append(cur)
    return out


def wifi_device():
    _, out, _ = nmcli("-f", "DEVICE,TYPE,STATE", "device")
    for line in out.splitlines():
        dev, typ, state = (split_terse(line) + ["", "", ""])[:3]
        if typ == "wifi":
            return dev, state
    return None, "missing"


def wifi_status():
    dev, state = wifi_device()
    _, radio, _ = nmcli("radio", "wifi")
    networks = {}
    if dev:
        _, out, _ = nmcli("-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "no")
        for line in out.splitlines():
            in_use, ssid, signal, security = (split_terse(line) + ["", "", "", ""])[:4]
            if not ssid:
                continue
            signal = int(signal or 0)
            prev = networks.get(ssid)
            if prev is None or signal > prev["signal"] or in_use == "*":
                networks[ssid] = {
                    "ssid": ssid,
                    "signal": signal,
                    "secure": security not in ("", "--"),
                    "active": in_use == "*" or (prev or {}).get("active", False),
                }
    _, saved_out, _ = nmcli("-f", "NAME,TYPE", "connection", "show")
    saved = {split_terse(l)[0] for l in saved_out.splitlines() if l.endswith(":802-11-wireless")}
    for n in networks.values():
        n["saved"] = n["ssid"] in saved
    ip = ""
    if dev:
        _, out, _ = nmcli("-f", "IP4.ADDRESS", "device", "show", dev)
        for line in out.splitlines():
            if line.startswith("IP4.ADDRESS"):
                ip = line.split(":", 1)[1].split("/")[0]
                break
    return {
        "device": dev,
        "state": state,
        "radio": radio.strip() == "enabled",
        "ip": ip,
        "networks": sorted(networks.values(), key=lambda n: (not n["active"], -n["signal"])),
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):  # quiet: journald gets only errors
        pass

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_GET(self):
        if self.path == "/api/wifi":
            return self.reply(200, wifi_status())
        if self.path.startswith("/api/"):
            return self.reply(404, {"error": "unknown"})
        return super().do_GET()

    def do_POST(self):
        try:
            req = self.body()
        except ValueError:
            return self.reply(400, {"error": "bad json"})
        dev, _ = wifi_device()
        if self.path == "/api/wifi/rescan":
            nmcli("device", "wifi", "rescan", timeout=20)
            return self.reply(200, wifi_status())
        if self.path == "/api/wifi/radio":
            nmcli("radio", "wifi", "on" if req.get("on") else "off")
            return self.reply(200, wifi_status())
        ssid = str(req.get("ssid", "")).strip()
        if not ssid:
            return self.reply(400, {"error": "ssid"})
        if self.path == "/api/wifi/connect":
            args = ["device", "wifi", "connect", ssid]
            password = str(req.get("password", ""))
            if password:
                args += ["password", password]
            if dev:
                args += ["ifname", dev]
            code, out, err = nmcli(*args, timeout=60)
            if code != 0:
                # a wrong password leaves a half-made profile behind: drop it so the next try is clean
                if password:
                    nmcli("connection", "delete", "id", ssid)
                return self.reply(200, {"ok": False, "error": err or out, **wifi_status()})
            return self.reply(200, {"ok": True, **wifi_status()})
        if self.path == "/api/wifi/forget":
            code, _, err = nmcli("connection", "delete", "id", ssid)
            return self.reply(200, {"ok": code == 0, "error": err, **wifi_status()})
        return self.reply(404, {"error": "unknown"})


def main():
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"Kern3D Станок: http://{BIND}:{PORT}/station.html, files from {ROOT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
