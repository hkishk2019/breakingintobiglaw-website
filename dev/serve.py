#!/usr/bin/env python3
"""Local preview: serves the site and stands in for the Apps Script backend.

    python3 dev/serve.py [port]

POSTs to /api/submit are appended to dev/submissions.jsonl.
"""
import json
import sys
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
LOG = SITE / "dev" / "submissions.jsonl"


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/submit":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._reply(400, {"ok": False, "error": "bad-json"})
        if data.get("type") not in ("comment", "subscribe"):
            return self._reply(400, {"ok": False, "error": "unknown-type"})
        data["_received"] = datetime.now(timezone.utc).isoformat()
        with LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False) + "\n")
        self._reply(200, {"ok": True})

    def _reply(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8793
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(SITE)))
    print(f"serving {SITE} on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
