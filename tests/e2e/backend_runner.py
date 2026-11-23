"""Run the real Report Cards API locally for the intel sync end-to-end test.

What is real: api.py, chat_guard (key, origin and rate checks), intel_store
and its Lua, executed by a real redis-server. Upstash is replaced by a tiny
HTTP shim that speaks the same REST shape ({"result": ...} for a JSON command
array) and forwards each command to that redis-server.

What is stubbed: Sleeper league membership (fixed owner ids 1000-1011), the
LiteLLM warm-up (a 30 s boot cost irrelevant here) and the spend budget
(memory backend; /chat is mocked in the browser and never reaches this
process).

Usage: python backend_runner.py <ddreportcards_dir> <api_port> <shim_port>
"""
import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DD_DIR, API_PORT, SHIM_PORT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
SECRET = "e2e-secret"
MEMBERS = [{"user_id": str(1000 + i)} for i in range(12)]

sys.path.insert(0, DD_DIR)
os.chdir(DD_DIR)
from tests._local_redis import LocalRedis  # noqa: E402

redis = LocalRedis()
redis_lock = threading.Lock()


class Shim(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer e2e-token":
            self.send_response(401); self.end_headers(); return
        args = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            with redis_lock:
                body = {"result": redis(*args)}
        except RuntimeError as exc:
            body = {"error": str(exc)}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", SHIM_PORT), Shim).serve_forever, daemon=True).start()

os.environ.update({
    "GM_CHAT_SECRET": SECRET,
    "GM_UPSTASH_REST_URL": f"http://127.0.0.1:{SHIM_PORT}",
    "GM_UPSTASH_REST_TOKEN": "e2e-token",
    "GM_BUDGET_BACKEND": "memory",
    "GM_INTEL_RATE_REQUESTS": "100000",
})

import uvicorn  # noqa: E402

import api  # noqa: E402
import chat_guard  # noqa: E402


async def _no_prewarm():
    return None


api._prewarm_litellm = _no_prewarm
api.get_league_users = lambda league_id: MEMBERS
chat_guard.SHARED_SECRET = SECRET
chat_guard.INTEL_RATE_LIMIT_REQUESTS = 100000

try:
    uvicorn.run(api.app, host="127.0.0.1", port=API_PORT, log_level="warning")
finally:
    redis.close()
