"""How fast the conversation streams and scrolls, measured the same way every time: a real run is
recorded once from a separate copy of the app (run.kuvo.code.perf), then played back into a debug
build as often as you like (KUVO_DEMO_REPLAY), while the app measures how long its main thread
keeps you waiting, its CPU, memory and frames. See README.md.

Everything it makes is in its folder under the user's temporary folder, and in the perf copy's
own folders, which `clean` removes.
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BUNDLE = "run.kuvo.code.perf"
HOME = os.path.expanduser("~")
SUPPORT = HOME + "/Library/Application Support/" + BUNDLE
TEMP = subprocess.run(["getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True).stdout.strip()
ROOT = os.path.join(TEMP, "kuvo-perf")
DERIVED = os.path.join(ROOT, "DerivedData")
APP = DERIVED + "/Build/Products/Debug/Kuvo Code.app"
MODEL = os.environ.get("KUVO_PERF_MODEL", "opencode/deepseek-v4.1-flash-free")


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


GUARD = os.path.join(REPO, "scripts", "real-app-guard.sh")


def guard(caller, *values):
    """Stops here, naming `caller`, when any of `values` is the real Kuvo Code's: its bundle ID, its
    folder in Application Support (its engine among what's there), or the installed app
    (scripts/real-app-guard.sh says what counts)."""
    if subprocess.run(["sh", GUARD, caller] + [str(v) for v in values if v]).returncode != 0:
        sys.exit(1)


def bundle_id(app):
    """The bundle ID an app copy runs as, from its Info.plist."""
    import plistlib
    with open(os.path.join(app, "Contents", "Info.plist"), "rb") as f:
        return plistlib.load(f).get("CFBundleIdentifier", "")


def sh(command, check=True, **kwargs):
    done = subprocess.run(command, capture_output=True, text=True, **kwargs)
    if check and done.returncode != 0:
        raise RuntimeError("%s failed: %s" % (command[0], (done.stderr or done.stdout)[-1500:]))
    return done.stdout.strip()


def build(source=REPO, app=None):
    """A debug build of `source` (this checkout, or another, like one at an older commit) as the
    perf copy; with `app`, also copied there to keep."""
    log("building", source)
    sh(["xcodebuild", "-project", source + "/KuvoCode.xcodeproj", "-scheme", "KuvoCode", "-configuration", "Debug",
        "-derivedDataPath", DERIVED, "-clonedSourcePackagesDirPath", os.path.join(ROOT, "SourcePackages"),
        "APP_BUNDLE_ID=" + BUNDLE, "COMPILER_INDEX_STORE_ENABLE=NO", "build"])
    if app:
        shutil.rmtree(app, ignore_errors=True)
        sh(["cp", "-cR", APP, app])
    return app or APP


def project(name):
    """A folder for a run's project, a git repository, in the perf folder."""
    folder = os.path.join(ROOT, "projects", name)
    if not os.path.exists(os.path.join(folder, ".git")):
        os.makedirs(folder, exist_ok=True)
        open(os.path.join(folder, "README.md"), "w").write("# %s\n" % name)
        env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null")
        for args in (["init", "-q"], ["add", "-A"], ["-c", "user.name=perf", "-c", "user.email=perf@example.com", "commit", "-qm", "Start"]):
            sh(["git", "-C", folder] + args, env=env)
    return folder


def quit_app(app=None):
    """Asks the perf copy to quit (for a few seconds at most: a busy main thread never answers),
    then stops what's left of it by its process number: told to stop first, so its engine and
    bridge stop with it, and made to after a few seconds more."""
    try:
        subprocess.run(["osascript", "-e", 'tell application id "%s" to quit' % BUNDLE], capture_output=True, timeout=15)
    except subprocess.TimeoutExpired:
        pass
    time.sleep(2)

    def running():
        found = sh(["pgrep", "-f", (app or APP) + "/Contents/MacOS/"], check=False)
        return [pid for pid in found.split() if int(pid) != os.getpid()]
    for signal in ["-TERM", "-KILL"]:
        left = running()
        if not left:
            break
        for pid in left:
            sh(["kill", signal, pid], check=False)
        for _ in range(10):
            if not running():
                break
            time.sleep(0.5)
    time.sleep(1)


def launch(app, **env):
    """The perf copy, in the background, its window past the screen's edge."""
    values = {"KUVO_DEMO_BACKGROUND": "1", "KUVO_DEMO_USAGE": "off", "KUVO_DEMO_OFFSCREEN": "1", "KUVO_DEMO_WINDOW": "1300x820",
              "KUVO_DEMO_MACHINE_ROOT": ".kuvo-code-perf",
              # The engine finds skills in ~/.claude/skills, where one can be a link into your Desktop:
              # macOS would ask whether the copy may read it, and the run would wait on the answer.
              "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS": "1"}
    values.update({k: str(v) for k, v in env.items()})
    guard("kuvo_perf.py launch", app, bundle_id(app), *values.values())
    if bundle_id(app) != BUNDLE:
        sys.exit("kuvo_perf.py launch: %s runs as %s, not the perf copy (%s): build it with `kuvo_perf.py build`." % (app, bundle_id(app), BUNDLE))
    quit_app(app)
    sh(["defaults", "write", BUNDLE, "analytics.noticeShown", "-bool", "true"])
    command = ["open", "-n", "-g"]
    for k, v in values.items():
        command += ["--env", "%s=%s" % (k, v)]
    sh(command + [app, "--args", "-AppleLocale", "en_US", "-ApplePersistenceIgnoreState", "YES"])


def record(name, prompt, app=APP, limit=1200):
    """Has the perf copy's agent answer `prompt` with a free model, and keeps the engine's events
    until the run ends, in <name>.jsonl."""
    os.makedirs(ROOT, exist_ok=True)
    out = os.path.join(ROOT, name + ".jsonl")
    engine = os.path.join(SUPPORT, "e2e-engine.json")
    if os.path.exists(engine):
        os.remove(engine)
    launch(app, KUVO_E2E="1", KUVO_DEMO_FOLDER=project(name), KUVO_DEMO_PROMPT=prompt, KUVO_DEMO_MODEL=MODEL)
    deadline = time.time() + 300
    while not os.path.exists(engine):
        if time.time() > deadline:
            raise RuntimeError("the perf copy's engine didn't start")
        time.sleep(0.5)
    record = json.load(open(engine))
    auth = "Basic " + base64.b64encode(("%s:%s" % (record["username"], record["password"])).encode()).decode()
    request = urllib.request.Request(record["url"].rstrip("/") + "/api/event", headers={"Authorization": auth})
    start, count = time.time(), 0
    with urllib.request.urlopen(request, timeout=limit) as events, open(out, "w") as f:
        for line in events:
            line = line.decode().rstrip("\n")
            if not line.startswith("data:"):
                continue
            raw = line[5:].strip()
            f.write(json.dumps({"t": round((time.time() - start) * 1000), "raw": raw}) + "\n")
            count += 1
            kind = json.loads(raw).get("type", "")
            if kind.startswith("session.execution.") and kind != "session.execution.started":
                break
    quit_app(app)
    log("recorded %d events in %d s: %s" % (count, time.time() - start, out))
    return out


def bench(app, replay, label, **env):
    """Plays `replay` into a new session of `app`, and the app's measurements of it."""
    result = os.path.join(ROOT, "result.txt")
    if os.path.exists(result):
        os.remove(result)
    launch(app, KUVO_DEMO_FOLDER=project("replay"), KUVO_DEMO_REPLAY=replay, KUVO_PERF_LOG=result, **env)
    deadline = time.time() + 1800
    while not (os.path.exists(result) and os.path.getsize(result) > 0):
        if time.time() > deadline:
            raise RuntimeError("no result")
        time.sleep(1)
    quit_app(app)
    line = "[%s] %s" % (label, open(result).read().strip())
    with open(os.path.join(ROOT, "results.txt"), "a") as f:
        f.write(line + "\n")
    return line


# The measurements that matter, each a way of using a conversation while it streams.
CASES = {
    "thinking": dict(KUVO_DEMO_OPEN_STEPS=1),
    "thinking-scrolling": dict(KUVO_DEMO_OPEN_STEPS=1, KUVO_DEMO_WANDER=15, KUVO_DEMO_WANDER_FOR=600),
    "reply": dict(),
    "reply-scrolling": dict(KUVO_DEMO_WANDER=15, KUVO_DEMO_WANDER_FOR=600),
    "finished-scrolling": dict(KUVO_DEMO_REPLAY_SPEED=50, KUVO_DEMO_REPLAY_HOLD=30, KUVO_DEMO_WANDER=8, KUVO_DEMO_WANDER_FOR=40),
}


# ---- Group chats (PerfGroups): a three-bot discussion on a stand-in model ----

# The engine group chat runs start with: KUVO_PERF_ENGINE's, else the one the perf copy downloaded
# itself, kept here between runs (each starts from a clean copy, which would download it again).
# Never the real Kuvo Code's.
ENGINES = os.path.join(TEMP, "kuvo-perf-engine")


def engine():
    if os.environ.get("KUVO_PERF_ENGINE"):
        return os.environ["KUVO_PERF_ENGINE"]
    import glob
    # By version: 2.0.32 after 2.0.9.
    def version(path):
        return [int(part) if part.isdigit() else -1 for part in os.path.basename(os.path.dirname(path)).split(".")]
    kept = sorted(glob.glob(os.path.join(ENGINES, "*", "opencode")), key=version)
    return kept[-1] if kept else None


def keep_engine():
    """Keeps the engine the perf copy downloaded, for the next runs."""
    import glob
    for binary in glob.glob(os.path.join(SUPPORT, "engine", "*", "opencode")):
        kept = os.path.join(ENGINES, os.path.basename(os.path.dirname(binary)), "opencode")
        if not os.path.exists(kept):
            os.makedirs(os.path.dirname(kept), exist_ok=True)
            sh(["cp", "-c", binary, kept])


class StandIn:
    """An OpenAI-compatible model on 127.0.0.1 that answers a group chat's turns with the recorded
    discussion (groups/discussion.json): the bot whose turn it is says its next line, a word at a
    time at the pace it was written, then PASS; a wrap-up is the lead's. When each reply finished
    goes to `log`, to set against when it reached the chat."""

    def __init__(self, log):
        import http.server
        import threading
        script = json.load(open(os.path.join(HERE, "groups", "discussion.json")))
        self.lines = {name: list(lines) for name, lines in script["lines"].items()}
        self.wrap_up = script["wrapUp"]
        self.pace = 1.0 / script["words_per_second"]
        self.log = log
        open(log, "w").close()
        stand_in = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                body = json.dumps({"object": "list", "data": [{"id": "standin", "object": "model"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                asked = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                text = stand_in.reply(asked)
                if not asked.get("stream"):
                    body = json.dumps({"id": "c", "object": "chat.completion", "created": int(time.time()), "model": "standin",
                                       "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                       "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()

                def chunk(delta, finish=None, usage=None):
                    value = {"id": "c", "object": "chat.completion.chunk", "created": int(time.time()), "model": "standin",
                             "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    if usage:
                        value["usage"] = usage
                    self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                    self.wfile.flush()

                chunk({"role": "assistant", "content": ""})
                words = text.split(" ")
                for index, word in enumerate(words):
                    chunk({"content": word + ("" if index == len(words) - 1 else " ")})
                    time.sleep(stand_in.pace)
                chunk({}, "stop", {"prompt_tokens": 1000, "completion_tokens": len(words), "total_tokens": 1000 + len(words)})
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                if text != "PASS":
                    with open(stand_in.log, "a") as f:
                        f.write(json.dumps({"at": round(time.time() * 1000), "text": text[:80]}) + "\n")

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/v1" % self.server.server_address[1]

    def reply(self, asked):
        import re
        said = []
        for message in asked.get("messages", []):
            content = message.get("content")
            if isinstance(content, list):
                content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
            if message.get("role") == "user" and isinstance(content, str):
                said.append(content)
        last = said[-1] if said else ""
        if "Wrap up this discussion now" in last:
            return self.wrap_up
        turn = re.findall(r"Your turn, ([A-Za-z]+)\.", last)
        if turn and self.lines.get(turn[-1]):
            return self.lines[turn[-1]].pop(0)
        return "PASS"

    def stop(self):
        self.server.shutdown()


def groups_bench(app, label):
    """Plays the discussion in a group chat of `app` (a build of this checkout or an older one),
    from a clean copy: the bots and 40 chats made first, then the app opened again (the chats it
    shows in its first moment, kept from before) and the discussion measured. Prints its numbers."""
    clean(keep_engine=True)
    os.makedirs(ROOT, exist_ok=True)
    replies = os.path.join(ROOT, "replies.jsonl")
    stand_in = StandIn(replies)
    result = os.path.join(ROOT, "groups-result.json")
    try:
        for mode in ["setup", "run"]:
            if os.path.exists(result):
                os.remove(result)
            # KUVO_PERF_PROFILE / KUVO_PERF_STALLS given here go to the measured run (README).
            extra = {k: v for k, v in os.environ.items() if mode == "run" and k in ("KUVO_PERF_PROFILE", "KUVO_PERF_STALLS")}
            if mode == "run":
                # Every build measured over the same span from the question, however fast it answers.
                extra["KUVO_PERF_GROUP_SECONDS"] = os.environ.get("KUVO_PERF_GROUP_SECONDS", "15")
            if engine():
                extra["KUVO_OPENCODE_BINARY"] = engine()
            launch(app, KUVO_DEMO_GROUP_REPLAY=mode, KUVO_PERF_PROVIDER=stand_in.url, KUVO_PERF_LOG=result, **extra)
            deadline = time.time() + 900
            while not (os.path.exists(result) and os.path.getsize(result) > 0):
                if time.time() > deadline:
                    raise RuntimeError("no result from " + mode)
                time.sleep(1)
            quit_app(app)
            keep_engine()
        measured = json.load(open(result))
    finally:
        stand_in.stop()
    finished = [json.loads(line) for line in open(replies) if line.strip()]
    lags = []
    for shown in measured.get("appeared", []):
        match = next((reply for reply in finished if reply["text"][:60] == shown["text"][:60]), None)
        if match:
            lags.append(shown["at"] - match["at"])
    lags.sort()
    p95 = lags[min(len(lags) - 1, int(len(lags) * 0.95))] if lags else None
    line = "[%s] %d replies, reply-to-row p95 %s ms (all %s); first frame %s chats; %s s; app %.0f%% CPU, bridge %.0f%%, engine %.0f%%; %s" % (
        label, len(lags), p95, lags, measured.get("firstFrameChats"), measured.get("seconds"), measured.get("appCPU", 0),
        measured.get("bridgeCPU", 0), measured.get("engineCPU", 0), measured.get("meter"))
    with open(os.path.join(ROOT, "results.txt"), "a") as f:
        f.write(line + "\n")
    return line


def clean(keep_engine=False):
    """Removes everything the perf copy keeps on this Mac, and the perf folder."""
    guard("kuvo_perf.py clean", BUNDLE, SUPPORT)
    quit_app()
    # For a few seconds at most: left alone, it has waited for good.
    try:
        subprocess.run(["defaults", "delete", BUNDLE], capture_output=True, timeout=20)
    except subprocess.TimeoutExpired:
        raise RuntimeError("`defaults delete %s` didn't finish: stopping rather than measuring a copy that isn't clean" % BUNDLE)
    lib = HOME + "/Library/"
    for path in [SUPPORT, lib + "Caches/" + BUNDLE, lib + "HTTPStorages/" + BUNDLE, lib + "HTTPStorages/" + BUNDLE + ".binarycookies",
                 lib + "WebKit/" + BUNDLE, lib + "Saved Application State/" + BUNDLE + ".savedState",
                 lib + "Preferences/" + BUNDLE + ".plist", os.path.join(TEMP, BUNDLE),
                 os.path.join(sh(["getconf", "DARWIN_USER_CACHE_DIR"]), BUNDLE), ROOT] + ([] if keep_engine else [ENGINES]):
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)
    log("cleaned the perf copy's folders")


USAGE = """kuvo_perf.py <command>
  build [source] [app]           the perf copy, from this checkout or another; app keeps a copy of it
  record <name> <prompt>         a real run with a free model, recorded as <name>.jsonl
  bench <app> <name> <case>      plays <name>.jsonl into <app> and prints the measurements
                                 (cases: %s; KEY=VALUE adds launch values)
  groups <app> [label]           a three-bot group chat discussion in <app>, on a stand-in model
  clean                          quits the copy and removes all it keeps""" % ", ".join(CASES)

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(USAGE)
        sys.exit(2)
    # Every mode works on the perf copy's own bundle ID, folders and engine, never the real app's.
    guard("kuvo_perf.py " + a[0], BUNDLE, SUPPORT, engine())
    if a[0] == "build":
        print(build(*a[1:3]))
    elif a[0] == "record" and len(a) >= 3:
        record(a[1], " ".join(a[2:]))
    elif a[0] == "bench" and len(a) >= 4:
        extra = dict(kv.split("=", 1) for kv in a[4:])
        print(bench(os.path.abspath(a[1]), os.path.join(ROOT, a[2] + ".jsonl"), "%s %s %s" % (os.path.basename(a[1]), a[2], a[3]), **{**CASES[a[3]], **extra}))
    elif a[0] == "groups" and len(a) >= 2:
        print(groups_bench(os.path.abspath(a[1]), a[2] if len(a) > 2 else os.path.basename(a[1])))
    elif a[0] == "clean":
        clean()
    else:
        print(USAGE)
        sys.exit(2)
