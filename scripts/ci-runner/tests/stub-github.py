"""A stand-in for the bits of GitHub's REST API the Mini's orchestrator uses, for its tests.

    python3 -I stub-github.py <folder>

Listens on 127.0.0.1, on a port of the OS's choosing, which it writes to <folder>/port. Each
request reads <folder>/scenario.json afresh (so a test can change GitHub's mind mid-job) and is
noted in <folder>/requests.log as "METHOD PATH AUTHORIZATION".

scenario.json:
  token           the token a request must carry (else 401)
  busy            true/false/"gone" (404)/"error" (500), for GET runners/<id>
  runs            the in_progress runs: [{id, event, head_branch, repo, head_repo}]
  runs_status     an HTTP status for the runs list instead of the list (500, say)
  runs_hang       seconds the runs list takes to answer
  jobs            {run-id: [runner-id, ...]}: which runners the run's jobs are on
  delete_status   the answer to DELETE runners/<id> (204, 404, 422, 500)
  jit_status      the answer to POST generate-jitconfig (201 by default)
  expiration      the github-authentication-token-expiration header, if any
"""
import http.server
import json
import os
import re
import sys
import time

folder = sys.argv[1]
REPO = "/repos/serhatandic/kuvo-code/actions"


def scenario():
    with open(os.path.join(folder, "scenario.json")) as f:
        return json.load(f)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self, status, body=None, s=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if s and s.get("expiration"):
            self.send_header("github-authentication-token-expiration", s["expiration"])
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self, method):
        s = scenario()
        auth = self.headers.get("Authorization", "")
        with open(os.path.join(folder, "requests.log"), "a") as log:
            log.write(f"{method} {self.path} {auth}\n")
        if auth != f"Bearer {s.get('token', '')}":
            return self.answer(401, {"message": "Bad credentials"}, s)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        path = self.path.split("?")[0]

        if method == "POST" and path == f"{REPO}/runners/generate-jitconfig":
            request = json.loads(body or b"{}")
            with open(os.path.join(folder, "jit-request.json"), "w") as f:
                json.dump(request, f)
            status = s.get("jit_status", 201)
            if status != 201:
                return self.answer(status, {"message": "No runners for you", "encoded_jit_config": "SECRET-IN-ERROR"}, s)
            return self.answer(201, {"runner": {"id": 42, "name": request.get("name")}, "encoded_jit_config": "SklUQ09ORklH"}, s)
        m = re.fullmatch(f"{REPO}/runners/(\\d+)", path)
        if m and method == "DELETE":
            return self.answer(s.get("delete_status", 204), None if s.get("delete_status", 204) == 204 else {"message": "nope"}, s)
        if m and method == "GET":
            busy = s.get("busy", False)
            if busy == "gone":
                return self.answer(404, {"message": "Not Found"}, s)
            if busy == "error":
                return self.answer(500, {"message": "oops"}, s)
            return self.answer(200, {"id": int(m.group(1)), "busy": busy, "status": "online"}, s)
        if method == "GET" and path == f"{REPO}/runners":
            return self.answer(200, {"runners": s.get("runners", [])}, s)
        if method == "GET" and path == f"{REPO}/runs":
            time.sleep(s.get("runs_hang", 0))
            if s.get("runs_status"):
                return self.answer(s["runs_status"], {"message": "oops"}, s)
            runs = [
                {
                    "id": r["id"],
                    "event": r["event"],
                    "head_branch": r["head_branch"],
                    "repository": {"full_name": r.get("repo", "serhatandic/kuvo-code")},
                    "head_repository": {"full_name": r.get("head_repo", "serhatandic/kuvo-code")},
                }
                for r in s.get("runs", [])
            ]
            return self.answer(200, {"workflow_runs": runs}, s)
        m = re.fullmatch(f"{REPO}/runs/(\\d+)/jobs", path)
        if m and method == "GET":
            runners = s.get("jobs", {}).get(m.group(1), [])
            return self.answer(200, {"jobs": [{"id": 1000 + i, "runner_id": r} for i, r in enumerate(runners)]}, s)
        return self.answer(404, {"message": "Not Found"}, s)

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_DELETE(self):
        self.handle_any("DELETE")


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(os.path.join(folder, "port.new"), "w") as f:
    f.write(str(server.server_address[1]))
os.rename(os.path.join(folder, "port.new"), os.path.join(folder, "port"))
server.serve_forever()
