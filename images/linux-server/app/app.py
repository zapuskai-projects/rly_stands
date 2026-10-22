import hashlib
import json
import os
import random
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH = "/var/log/app/app.log"
UPLOAD_DIR = "/var/uploads"
PORT = 3000
ITEMS = [{"id": 1, "title": "Договор поставки"}, {"id": 2, "title": "Акт сверки"}, {"id": 3, "title": "Счёт"}]
LOG_LOCK = threading.Lock()


def now():
    moment = datetime.now(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def new_request_id():
    return "req-" + hashlib.md5(os.urandom(16)).hexdigest()[:10]


def log(level, request_id, text):
    with LOG_LOCK:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"{now()} {level} requestId={request_id} {text}\n")


def probe_log_dir():
    path = os.path.join(os.path.dirname(LOG_PATH), ".health-probe")
    try:
        with open(path, "wb") as handle:
            handle.write(b"0" * 8192)
        os.remove(path)
        return None
    except OSError as error:
        return str(error)


def safe_log(level, request_id, text):
    try:
        log(level, request_id, text)
        return None
    except OSError as error:
        return str(error)


if not os.environ.get("APP_SECRET"):
    safe_log("ERROR", "startup", "APP_SECRET is not set, exiting")
    sys.stderr.write("APP_SECRET is not set\n")
    sys.exit(1)


class Handler(BaseHTTPRequestHandler):
    server_version = "training-app"

    def log_message(self, *args):
        return

    def reply(self, status, body, request_id, started):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-Request-Id", request_id)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        elapsed = int((time.time() - started) * 1000)
        level = "ERROR" if status >= 500 else "WARN" if status >= 400 else "INFO"
        safe_log(level, request_id, f"{self.command} {self.path} {status} {elapsed}ms")

    def handle_any(self):
        started = time.time()
        request_id = self.headers.get("X-Request-Id") or new_request_id()
        path = self.path.split("?")[0]
        if path == "/health":
            error = probe_log_dir() or safe_log("INFO", request_id, "health check")
            if error:
                return self.reply(500, {"status": "error", "detail": error}, request_id, started)
            return self.reply(200, {"status": "ok"}, request_id, started)
        if path == "/api/items" and self.command == "GET":
            return self.reply(200, {"items": ITEMS}, request_id, started)
        if path == "/api/upload" and self.command == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length)
            name = f"upload-{int(time.time() * 1000)}.bin"
            try:
                with open(os.path.join(UPLOAD_DIR, name), "wb") as handle:
                    handle.write(data)
            except OSError as error:
                return self.reply(500, {"error": str(error)}, request_id, started)
            return self.reply(200, {"saved": name, "bytes": len(data)}, request_id, started)
        return self.reply(404, {"error": "not found"}, request_id, started)

    do_GET = handle_any
    do_POST = handle_any


def background_noise():
    paths = ["/api/items", "/api/items", "/api/items", "/health"]
    while True:
        time.sleep(1.0)
        safe_log("INFO", new_request_id(), f"GET {random.choice(paths)} 200 {random.randint(2, 40)}ms")


threading.Thread(target=background_noise, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
