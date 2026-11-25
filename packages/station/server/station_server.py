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
    GET  /api/bt              adapter on/searching, devices (paired first, gamepads first)
    POST /api/bt/scan         search for 20 s
    POST /api/bt/pair         {"mac": "..."}: pair, trust, connect (a gamepad then reconnects by itself)
    POST /api/bt/connect      {"mac": "..."}
    POST /api/bt/remove       {"mac": "..."}
    GET  /api/gamepad/events  server-sent events: the joysticks Linux sees (axes −1…1, buttons),
                              for gamepads the browser does not show (vendor 0000, some clones)
    GET  /api/net             the link in use (wifi / ethernet / none), its name, address, signal
    GET  /api/time            time zone, automatic time (NTP) on/off and synchronised, zones
    POST /api/time            {"timezone": "...", "ntp": bool, "set": "YYYY-MM-DD HH:MM:SS"}
    GET  /api/display         {"rotate": 0|90|180|270}
    POST /api/display         {"rotate": ...}: saved, the kiosk restarts turned
"""
import json
import os
import re
import struct
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROTATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rotate")
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


MAC = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")


def btctl(*args, timeout=15, agent=False):
    """bluetoothctl, non-interactive; (exit code, output). `agent`: a no-input agent for pairing."""
    cmd = ["bluetoothctl"]
    if agent:
        cmd += ["--agent", "NoInputNoOutput"]
    try:
        p = subprocess.run(cmd + list(args), capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired as e:
        return 1, (e.stdout or "") if isinstance(e.stdout, str) else "timeout"


def bt_info(mac):
    _, out = btctl("info", mac, timeout=5)
    info = {"mac": mac, "name": mac, "icon": "", "paired": False, "connected": False, "trusted": False}
    for line in out.splitlines():
        key, _, value = line.strip().partition(": ")
        if key == "Name":
            info["name"] = value
        elif key == "Icon":
            info["icon"] = value
        elif key in ("Paired", "Connected", "Trusted"):
            info[key.lower()] = value.strip() == "yes"
    info["gamepad"] = info["icon"] in ("input-gaming", "input-joystick") or bool(
        re.search(r"gamepad|controller|joy|xbox|dualshock|dualsense|8bitdo|pro controller", info["name"], re.I)
    )
    return info


_scan_until = 0.0


def bt_status():
    import time

    _, show = btctl("show", timeout=5)
    devices = []
    _, out = btctl("devices", timeout=5)
    for line in out.splitlines():
        parts = line.split(" ", 2)
        if len(parts) >= 2 and parts[0] == "Device" and MAC.match(parts[1]):
            d = bt_info(parts[1])
            # nameless beacons nearby are noise
            if d["name"] != d["mac"] and d["name"].replace("-", ":") != d["mac"]:
                devices.append(d)
    devices.sort(key=lambda d: (not d["connected"], not d["paired"], not d["gamepad"], d["name"].lower()))
    return {
        "powered": "Powered: yes" in show,
        "present": "Controller" in show,
        "scanning": time.time() < _scan_until,
        "devices": devices,
        "pairing": dict(_pairing) if _pairing else None,
    }


def bt_scan(seconds=20):
    import time

    global _scan_until
    _scan_until = time.time() + seconds
    btctl("power", "on", timeout=5)
    threading.Thread(target=btctl, args=("--timeout", str(seconds), "scan", "on"), kwargs={"timeout": seconds + 5}, daemon=True).start()


_pairing = {}


def _strip(line):
    # colour codes and readline markers bluetoothctl puts round its prompt
    return re.sub(r"\x1b\[[0-9;]*[a-zA-Z]|[\x01\x02]", "", line)


def bt_pair_session(mac):
    """
    Pairs in one interactive bluetoothctl session (agent, scan, pair, trust, connect), as the
    command line would: separate non-interactive calls lose the freshly found device and hang until
    their timeouts. Progress goes to `_pairing` for the page to poll.
    """
    import queue
    import time

    st = _pairing
    st.update(mac=mac, stage="запуск", done=False, ok=False, error="")
    p = subprocess.Popen(["bluetoothctl"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, bufsize=1)
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(_strip(l)) for l in p.stdout], daemon=True).start()

    def send(cmd):
        p.stdin.write(cmd + "\n")
        p.stdin.flush()

    def expect(good, bad, seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                continue
            if any(g in line for g in good):
                return True, line
            if any(b in line for b in bad):
                return False, line.strip()
        return False, "нет ответа от устройства"

    try:
        for cmd in ("power on", "agent NoInputNoOutput", "default-agent", "pairable on", "scan on"):
            send(cmd)
        st["stage"] = "поиск устройства"
        if not bt_info(mac).get("name") or bt_info(mac)["name"] == mac:
            expect([mac], [], 15)
        time.sleep(1)
        if not bt_info(mac)["paired"]:
            st["stage"] = "сопряжение"
            send(f"pair {mac}")
            ok, line = expect(["Pairing successful", "AlreadyExists"], ["Failed to pair", "not available"], 30)
            if not ok and not bt_info(mac)["paired"]:
                st.update(error=line, done=True)
                return
        st["stage"] = "доверие"
        send(f"trust {mac}")
        expect(["trust succeeded", "Trusted: yes"], [], 5)
        st["stage"] = "подключение"
        send(f"connect {mac}")
        ok, line = expect(["Connection successful", "Connected: yes"], ["Failed to connect"], 20)
        connected = ok or bt_info(mac)["connected"]
        st.update(ok=connected, done=True, error="" if connected else line)
    finally:
        try:
            send("scan off")
            send("quit")
            p.wait(timeout=5)
        except Exception:
            p.kill()


def bt_pair(mac):
    if _pairing and not _pairing.get("done", True):
        return False
    threading.Thread(target=bt_pair_session, args=(mac,), daemon=True).start()
    return True


# ---- gamepads read from Linux (evdev) -------------------------------------------------------

EV_KEY, EV_ABS = 1, 3
# buttons in raw order: BTN_SOUTH (304) … the 16th button; the hat (ABS 16/17) becomes the d-pad 12–15
BTN_FIRST, BTN_COUNT = 304, 16
AXES = (0, 1, 3, 4, 2, 5)  # X, Y, RX, RY, Z, RZ → axes 0…5

_pads = {}  # event path → {"id", "axes", "buttons", "ranges"}
_pads_version = 0
_pads_cond = threading.Condition()


def _joystick_nodes():
    """Event nodes of the joysticks: /proc/bus/input/devices entries with a js handler."""
    nodes = {}
    block = {}
    for line in open("/proc/bus/input/devices", encoding="utf-8", errors="replace").read().splitlines() + [""]:
        if not line.strip():
            handlers = block.get("H", "")
            if " js" in f" {handlers}" or handlers.startswith("js"):
                ev = next((h for h in handlers.split() if h.startswith("event")), None)
                if ev:
                    nodes["/dev/input/" + ev] = block.get("N", "Gamepad").strip('"')
            block = {}
            continue
        key, _, value = line.partition(": ")
        if key in ("N", "H"):
            block[key] = value.partition("=")[2]
    return nodes


def _abs_range(fd, code):
    import fcntl

    buf = bytearray(24)
    try:
        fcntl.ioctl(fd, 0x80184540 + code, buf)  # EVIOCGABS(code): value, min, max, fuzz, flat, res
    except OSError:
        return (-32768, 32767)
    _, lo, hi, *_ = struct.unpack("6i", bytes(buf))
    return (lo, hi) if hi > lo else (-32768, 32767)


def _publish():
    global _pads_version
    with _pads_cond:
        _pads_version += 1
        _pads_cond.notify_all()


def gamepad_reader():
    import select
    import time

    open_fds = {}  # fd → path
    next_scan = 0.0
    while True:
        if time.time() >= next_scan:
            next_scan = time.time() + 2
            nodes = _joystick_nodes()
            for fd, path in list(open_fds.items()):
                if path not in nodes:
                    os.close(fd)
                    del open_fds[fd]
                    _pads.pop(path, None)
                    _publish()
            for path, name in nodes.items():
                if path in open_fds.values():
                    continue
                try:
                    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                except OSError:
                    continue
                open_fds[fd] = path
                _pads[path] = {
                    "id": name,
                    "axes": [0.0] * len(AXES),
                    "buttons": [0.0] * (BTN_COUNT + 8),
                    "ranges": {code: _abs_range(fd, code) for code in AXES},
                }
                _publish()
        if not open_fds:
            time.sleep(1)
            continue
        ready, _, _ = select.select(list(open_fds), [], [], 0.5)
        changed = False
        for fd in ready:
            path = open_fds[fd]
            pad = _pads.get(path)
            try:
                data = os.read(fd, 24 * 64)
            except OSError:
                continue
            for i in range(0, len(data) - 23, 24):
                _, _, typ, code, val = struct.unpack("llHHi", data[i : i + 24])
                if typ == EV_KEY and BTN_FIRST <= code < BTN_FIRST + BTN_COUNT:
                    index = code - BTN_FIRST
                    # 12…15 are the d-pad (from the hat): the 13th and 14th buttons (home,
                    # capture on a Switch pad) move to 16, 17
                    if index >= 12:
                        index += 4
                    if index < len(pad["buttons"]):
                        pad["buttons"][index] = 1.0 if val else 0.0
                    changed = True
                elif typ == EV_ABS and code in AXES:
                    lo, hi = pad["ranges"][code]
                    pad["axes"][AXES.index(code)] = round((2 * (val - lo) / (hi - lo)) - 1, 3)
                    changed = True
                elif typ == EV_ABS and code in (16, 17):  # hat: d-pad up/down/left/right = 12…15
                    b = pad["buttons"]
                    if code == 17:
                        b[12], b[13] = (1.0 if val < 0 else 0.0), (1.0 if val > 0 else 0.0)
                    else:
                        b[14], b[15] = (1.0 if val < 0 else 0.0), (1.0 if val > 0 else 0.0)
                    changed = True
        if changed:
            _publish()


def pads_snapshot():
    return [{"id": p["id"], "axes": p["axes"], "buttons": p["buttons"]} for p in _pads.values()]


# ---- network status and time ----------------------------------------------------------------


def net_status():
    _, out, _ = nmcli("-f", "DEVICE,TYPE,STATE,CONNECTION", "device")
    links = []
    for line in out.splitlines():
        dev, typ, state, conn = (split_terse(line) + ["", "", "", ""])[:4]
        if typ in ("wifi", "ethernet") and state == "connected":
            links.append((dev, typ, conn))
    # a cable first: it is what the machine should be on when both are
    links.sort(key=lambda l: l[1] != "ethernet")
    if not links:
        return {"kind": "none", "name": "", "ip": "", "signal": 0, "host": os.uname().nodename}
    dev, typ, conn = links[0]
    ip = ""
    _, out, _ = nmcli("-f", "IP4.ADDRESS", "device", "show", dev)
    for line in out.splitlines():
        if line.startswith("IP4.ADDRESS"):
            ip = line.split(":", 1)[1].split("/")[0]
            break
    signal = 0
    if typ == "wifi":
        _, out, _ = nmcli("-f", "IN-USE,SIGNAL", "device", "wifi", "list", "--rescan", "no")
        for line in out.splitlines():
            in_use, sig = (split_terse(line) + ["", ""])[:2]
            if in_use == "*":
                signal = int(sig or 0)
    return {"kind": typ, "name": conn, "ip": ip, "signal": signal, "host": os.uname().nodename}


def time_status(with_zones=False):
    import datetime

    p = subprocess.run(["timedatectl", "show", "-p", "Timezone", "-p", "NTP", "-p", "NTPSynchronized"],
                       capture_output=True, text=True, timeout=10)
    props = dict(line.split("=", 1) for line in p.stdout.splitlines() if "=" in line)
    out = {
        "now": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "timezone": props.get("Timezone", ""),
        "ntp": props.get("NTP") == "yes",
        "synced": props.get("NTPSynchronized") == "yes",
    }
    if with_zones:
        z = subprocess.run(["timedatectl", "list-timezones"], capture_output=True, text=True, timeout=10)
        out["zones"] = z.stdout.split()
    return out


def set_time(req):
    """Time zone, automatic time, or a time set by hand (which turns automatic time off)."""
    errors = []

    def run(*args):
        p = subprocess.run(["timedatectl", *args], capture_output=True, text=True, timeout=15)
        if p.returncode != 0:
            errors.append(p.stderr.strip() or p.stdout.strip())

    if req.get("timezone"):
        run("set-timezone", str(req["timezone"]))
    if "ntp" in req:
        run("set-ntp", "true" if req["ntp"] else "false")
    if req.get("set"):
        run("set-ntp", "false")
        run("set-time", str(req["set"]))
    return errors


def rotation():
    try:
        value = int(open(ROTATE_FILE, encoding="ascii").read().strip() or 0)
    except (OSError, ValueError):
        value = 0
    return value if value in (0, 90, 180, 270) else 0


def set_rotation(value):
    """Saves the turn and restarts cage (the login loop starts it again with the new -r count)."""
    with open(ROTATE_FILE, "w", encoding="ascii") as f:
        f.write(str(value))
    subprocess.run(["pkill", "-x", "cage"], check=False)


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

    def gamepad_stream(self):
        """Server-sent events: the pads now, then on every change (at most ~60 a second)."""
        import time

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        seen = -1
        try:
            while True:
                with _pads_cond:
                    if _pads_version == seen:
                        _pads_cond.wait(timeout=10)
                    seen = _pads_version
                self.wfile.write(f"data: {json.dumps(pads_snapshot())}\n\n".encode())
                self.wfile.flush()
                time.sleep(1 / 60)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_GET(self):
        if self.path == "/api/gamepad/events":
            return self.gamepad_stream()
        if self.path == "/api/wifi":
            return self.reply(200, wifi_status())
        if self.path == "/api/display":
            return self.reply(200, {"rotate": rotation()})
        if self.path == "/api/bt":
            return self.reply(200, bt_status())
        if self.path == "/api/net":
            return self.reply(200, net_status())
        if self.path.startswith("/api/time"):
            return self.reply(200, time_status(with_zones="zones" in self.path))
        if self.path.startswith("/api/"):
            return self.reply(404, {"error": "unknown"})
        return super().do_GET()

    def do_POST(self):
        try:
            req = self.body()
        except ValueError:
            return self.reply(400, {"error": "bad json"})
        if self.path == "/api/time":
            errors = set_time(req)
            return self.reply(200, {"ok": not errors, "error": "; ".join(errors), **time_status()})
        if self.path == "/api/bt/scan":
            bt_scan()
            return self.reply(200, bt_status())
        if self.path.startswith("/api/bt/"):
            mac = str(req.get("mac", "")).upper()
            if not MAC.match(mac):
                return self.reply(400, {"error": "mac"})
            if self.path == "/api/bt/pair":
                # runs in the background: the page polls /api/bt for "pairing"
                bt_pair(mac)
                return self.reply(200, bt_status())
            if self.path == "/api/bt/connect":
                code, out = btctl("--timeout", "15", "connect", mac, timeout=20)
                ok = bt_info(mac)["connected"]
                return self.reply(200, {"ok": ok, "error": "" if ok else out.strip()[-120:], **bt_status()})
            if self.path == "/api/bt/remove":
                btctl("remove", mac, timeout=10)
                return self.reply(200, {"ok": True, **bt_status()})
            return self.reply(404, {"error": "unknown"})
        if self.path == "/api/display":
            value = int(req.get("rotate", 0))
            if value not in (0, 90, 180, 270):
                return self.reply(400, {"error": "rotate"})
            self.reply(200, {"rotate": value})
            set_rotation(value)  # after the reply: the page goes away with the kiosk
            return None
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
    threading.Thread(target=gamepad_reader, daemon=True).start()
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.daemon_threads = True
    print(f"Kern3D Станок: http://{BIND}:{PORT}/station.html, files from {ROOT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
