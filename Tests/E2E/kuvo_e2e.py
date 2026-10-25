"""The end-to-end tests' harness: a separate copy of the app (run.kuvo.code.e2e, with folders of its
own), driven in the background through Accessibility, with a real model, on real projects. See
README.md.

Everything a run makes is in its folder under the user's temporary folder, and in the e2e copy's
own folders, which `clean()` removes.
"""
import base64
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
BUNDLE = "run.kuvo.code.e2e"
HOME = os.path.expanduser("~")
SUPPORT = HOME + "/Library/Application Support/" + BUNDLE
DERIVED = REPO + "/build/E2EDerivedData"
APP = DERIVED + "/Build/Products/Debug/Kuvo Code.app"
TEMP = subprocess.run(["getconf", "DARWIN_USER_TEMP_DIR"], capture_output=True, text=True).stdout.strip()
ROOT = os.path.join(TEMP, "kuvo-e2e")
DRIVE = os.path.join(ROOT, "bin", "drive")
# The model the copy works with: free, no account needed (DeepSeek's, opencode/deepseek-v4.1-flash-free,
# is the other one the tests use).
MODEL = os.environ.get("KUVO_E2E_MODEL", "opencode/glm-5.3-flash-free")
# Where a machine's things go, for cases on one (KUVO_E2E_MACHINE names it).
MACHINE_ROOT = ".kuvo-code-e2e"


def log(*parts):
    print(dt.datetime.now().strftime("%H:%M:%S"), *parts, flush=True)


GUARD = os.path.join(REPO, "scripts", "real-app-guard.sh")


def guard(caller, *values):
    """Stops here, naming `caller`, when any of `values` is the real Kuvo Code's: its bundle ID, its
    folder in Application Support (its engine among what's there), or the installed app
    (scripts/real-app-guard.sh says what counts)."""
    if subprocess.run(["sh", GUARD, caller] + [str(v) for v in values if v]).returncode != 0:
        sys.exit(1)


def sh(command, cwd=None, check=True, env=None, timeout=None):
    """Runs a command; its output, stripped."""
    done = subprocess.run(command, cwd=cwd, capture_output=True, text=True, env=env, timeout=timeout,
                          shell=isinstance(command, str))
    if check and done.returncode != 0:
        raise RuntimeError("%s failed (%d): %s" % (command, done.returncode, (done.stderr or done.stdout)[-800:]))
    return done.stdout.strip()


# MARK: Building

def build(force=False):
    """The e2e copy, and the driver."""
    guard("kuvo_e2e.py build", BUNDLE, SUPPORT)
    os.makedirs(os.path.dirname(DRIVE), exist_ok=True)
    source = os.path.join(HERE, "drive.swift")
    if force or not os.path.exists(DRIVE) or os.path.getmtime(DRIVE) < os.path.getmtime(source):
        sh(["swiftc", "-O", "-o", DRIVE, source])
    log("building the e2e copy")
    out = sh(["xcodebuild", "-project", REPO + "/KuvoCode.xcodeproj", "-scheme", "KuvoCode", "-configuration", "Debug",
              "-derivedDataPath", DERIVED, "APP_BUNDLE_ID=" + BUNDLE, "build"], check=False)
    if "BUILD SUCCEEDED" not in out:
        raise RuntimeError("build failed:\n" + "\n".join(l for l in out.splitlines() if " error:" in l)[:3000])


# MARK: A run

class Run:
    """One run's folder: projects, captures, the report."""

    def __init__(self, name="run"):
        self.folder = os.path.join(ROOT, dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + name)
        for sub in ["projects", "shots", "files"]:
            os.makedirs(os.path.join(self.folder, sub), exist_ok=True)
        self.results = []

    def path(self, *parts):
        return os.path.join(self.folder, *parts)

    def record(self, case, status, notes=""):
        """status: pass, friction, fail, skip."""
        self.results.append((case, status, notes))
        log("%-5s %s %s" % (case, status.upper(), notes))
        with open(self.path("report.md"), "a") as f:
            f.write("| %s | %s | %s |\n" % (case, status, notes.replace("\n", " ").replace("|", "/")))

    def project(self, name, repo=None, ref=None, files=None):
        """A project folder: a real repository cloned shallow, or files written here, made a git
        repository either way."""
        folder = self.path("projects", name)
        if repo:
            command = ["git", "clone", "--quiet", "--depth", "1"] + (["--branch", ref] if ref else []) + [repo, folder]
            sh(command, timeout=300)
        else:
            os.makedirs(folder, exist_ok=True)
        for rel, text in (files or {}).items():
            path = os.path.join(folder, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(text)
        if not os.path.exists(os.path.join(folder, ".git")):
            git(folder, "init", "-q")
            git(folder, "add", "-A")
            git(folder, "commit", "-qm", "Start", "--allow-empty")
        return folder


def git(folder, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="E2E", GIT_AUTHOR_EMAIL="e2e@example.com",
               GIT_COMMITTER_NAME="E2E", GIT_COMMITTER_EMAIL="e2e@example.com", GIT_CONFIG_GLOBAL="/dev/null")
    return sh(["git", "-C", folder] + list(args), env=env)


# MARK: The app

def defaults(key, value):
    kind = {bool: "-bool", int: "-int", float: "-float"}.get(type(value), "-string")
    sh(["defaults", "write", BUNDLE, key, kind, str(value).lower() if isinstance(value, bool) else str(value)])


class App:
    """The e2e copy, running in the background: never in front, its window past the screen's edge."""

    def __init__(self, run):
        self.run = run
        self.pid = None
        self._engine = None

    def launch(self, appearance="dark", window="1300x820", wait_engine=True, model=MODEL, **env):
        """model: what new conversations and bots use (None leaves the app's own choice)."""
        # Never the real app: its bundle ID, folders or engine.
        import plistlib
        plist = os.path.join(APP, "Contents", "Info.plist")
        runs_as = plistlib.load(open(plist, "rb")).get("CFBundleIdentifier", "") if os.path.exists(plist) else ""
        guard("kuvo_e2e.py launch", BUNDLE, SUPPORT, APP, runs_as, *env.values())
        self.quit()
        defaults("analytics.noticeShown", True)
        if model:
            # As the app keeps it: the model whole, as JSON ("provider/model" for short here).
            provider, _, model_id = model.partition("/")
            defaults("lastModelRef", json.dumps({"id": model_id, "providerID": provider}))
        # What its browser downloads goes into the run's folder, not your Downloads.
        downloads = self.run.path("downloads")
        os.makedirs(downloads, exist_ok=True)
        values = {"KUVO_E2E": "1", "KUVO_DEMO_BACKGROUND": "1", "KUVO_DEMO_USAGE": "off", "KUVO_DEMO_OFFSCREEN": "1",
                  "KUVO_DEMO_APPEARANCE": appearance, "KUVO_DEMO_WINDOW": window, "KUVO_DEMO_MACHINE_ROOT": MACHINE_ROOT,
                  "KUVO_DEMO_DOWNLOADS": downloads}
        values.update({k: str(v) for k, v in env.items()})
        # A session started with a prompt takes its model from here, not from the last one used.
        if model and "KUVO_DEMO_PROMPT" in values:
            values.setdefault("KUVO_DEMO_MODEL", model)
        command = ["open", "-n", "-g"]
        for k, v in values.items():
            command += ["--env", "%s=%s" % (k, v)]
        sh(command + [APP, "--args", "-AppleLocale", "en_US"])
        for _ in range(60):
            self.pid = self._find()
            if self.pid:
                break
            time.sleep(0.5)
        if not self.pid:
            raise RuntimeError("the e2e copy didn't start")
        self._engine = None
        if wait_engine:
            self.engine(timeout=300)
        return self

    def _find(self):
        out = sh(["pgrep", "-f", APP + "/Contents/MacOS"], check=False)
        return int(out.split()[0]) if out else None

    def quit(self):
        if not self._find():
            return
        sh(["osascript", "-e", 'tell application id "%s" to quit' % BUNDLE], check=False)
        for _ in range(20):
            if not self._find():
                break
            time.sleep(0.5)
        if self._find():
            sh(["pkill", "-TERM", "-f", APP + "/Contents/MacOS"], check=False)
            time.sleep(2)
            sh(["pkill", "-KILL", "-f", APP + "/Contents/MacOS"], check=False)
        self.pid = None
        self._engine = None

    # Driving it

    def drive(self, *args, check=False):
        done = subprocess.run([DRIVE, str(self.pid)] + [str(a) for a in args], capture_output=True, text=True)
        if check and done.returncode != 0:
            raise RuntimeError("drive %s: %s" % (" ".join(map(str, args)), done.stdout.strip() or done.stderr.strip()))
        return done.returncode == 0, done.stdout.strip()

    def press(self, query, n=0, check=True):
        return self.drive("press", query, n, check=check)[0]

    def set(self, query, text, n=0, check=True):
        return self.drive("set", query, text, n, check=check)[0]

    def wait(self, query, seconds=30):
        return self.drive("wait", query, seconds)[0]

    def gone(self, query, seconds=30):
        return self.drive("gone", query, seconds)[0]

    def find(self, query):
        return [l for l in self.drive("find", query)[1].splitlines() if l and not l.startswith("not found")]

    def text(self):
        return self.drive("text")[1]

    def key(self, code, modifiers=""):
        return self.drive("key", code, modifiers)[0]

    def shot(self, name):
        """Captures the window; the file's path."""
        out = self.drive("shot", self.run.path("shots", name))[1].splitlines()
        return out[-1] if out else None

    def send(self, text):
        """Writes in the composer of the conversation in view and sends it."""
        self.set("#composer", text)
        time.sleep(0.4)
        self.press("#send")

    # Its engine

    def engine(self, timeout=60):
        if self._engine:
            return self._engine
        path = SUPPORT + "/e2e-engine.json"
        deadline = time.time() + timeout
        while time.time() < deadline:
            if os.path.exists(path):
                try:
                    self._engine = Engine(json.load(open(path)))
                    return self._engine
                except ValueError:
                    pass
            time.sleep(1)
        raise RuntimeError("the e2e copy's engine didn't start")


class Engine:
    """The copy's engine, read as the app reads it."""

    def __init__(self, record):
        self.url = record["url"].rstrip("/")
        self.auth = "Basic " + base64.b64encode(("%s:%s" % (record["username"], record["password"])).encode()).decode()

    def call(self, method, path, body=None, directory=None, timeout=60):
        headers = {"Authorization": self.auth, "Content-Type": "application/json"}
        if directory:
            headers["x-opencode-directory"] = urllib.parse.quote(directory, safe="/")
        req = urllib.request.Request(self.url + "/" + path.lstrip("/"), method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raise RuntimeError("%s %s: %d %s" % (method, path, error.code, error.read()[:300]))

    def sessions(self):
        return (self.call("GET", "api/session?limit=200") or {}).get("data", [])

    def session(self, title=None, directory=None):
        """The newest session with that title or in that folder."""
        for s in sorted(self.sessions(), key=lambda s: -(s.get("time", {}).get("updated") or 0)):
            if title and s.get("title") != title:
                continue
            if directory and (s.get("location") or {}).get("directory") != directory:
                continue
            return s
        return None

    def messages(self, sid, limit=100):
        page = self.call("GET", "api/session/%s/message?limit=%d&order=desc" % (sid, limit)) or {}
        return list(reversed(page.get("data", [])))

    def active(self):
        return set((self.call("GET", "api/session/active") or {}).get("data", []))

    def wait_idle(self, sid, timeout=600, settle=2):
        """Until the session's run ends (or time's up): True when it ended."""
        deadline = time.time() + timeout
        started = False
        while time.time() < deadline:
            busy = sid in self.active()
            started = started or busy
            if started and not busy:
                time.sleep(settle)
                if sid not in self.active():
                    return True
            elif not started and time.time() > deadline - timeout + 20:
                # Never seen running: perhaps over before we looked.
                if self.replies(sid):
                    return True
            time.sleep(1)
        return False

    def replies(self, sid):
        """The assistant's words, step by step."""
        out = []
        for m in self.messages(sid):
            if m.get("type") == "assistant":
                text = " ".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text").strip()
                if text:
                    out.append(text)
        return out

    def tools(self, sid):
        """Each tool call: (name, status, input, output text)."""
        out = []
        for m in self.messages(sid):
            for c in m.get("content", []) if m.get("type") == "assistant" else []:
                if c.get("type") == "tool":
                    state = c.get("state") or {}
                    output = " ".join(x.get("text", "") for x in state.get("content") or [] if isinstance(x, dict))
                    out.append((c.get("name"), state.get("status"), state.get("input"), output))
        return out

    def errors(self, sid):
        return [m["error"] for m in self.messages(sid) if m.get("type") == "assistant" and m.get("error")]


# MARK: Cleaning up

def clean():
    """Removes everything the e2e copy keeps on this Mac: its folders, preferences and caches."""
    guard("kuvo_e2e.py clean", BUNDLE, SUPPORT)
    App(None).quit()
    sh(["defaults", "delete", BUNDLE], check=False)
    lib = HOME + "/Library/"
    for path in [SUPPORT, lib + "Caches/" + BUNDLE, lib + "HTTPStorages/" + BUNDLE, lib + "HTTPStorages/" + BUNDLE + ".binarycookies",
                 lib + "WebKit/" + BUNDLE, lib + "Saved Application State/" + BUNDLE + ".savedState",
                 lib + "Preferences/" + BUNDLE + ".plist", os.path.join(TEMP, BUNDLE),
                 os.path.join(sh(["getconf", "DARWIN_USER_CACHE_DIR"]), BUNDLE)]:
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)
    log("cleaned the e2e copy's folders")


# MARK: By hand

def current_run(new=None):
    """The run the command line works in: a new one, or the last one started."""
    marker = os.path.join(ROOT, "current")
    if new:
        run = Run(new)
        os.makedirs(ROOT, exist_ok=True)
        open(marker, "w").write(run.folder)
        return run
    run = Run.__new__(Run)
    run.folder = open(marker).read().strip() if os.path.exists(marker) else Run("hand").folder
    run.results = []
    return run


USAGE = """kuvo_e2e.py <command>
  build                      the e2e copy and the driver
  new <name>                 starts a run (a folder for its projects and captures)
  launch [KEY=VALUE…]        the copy, in the background, with these launch values
  quit | clean               quits it | quits it and removes all it keeps
  drive <args…>              drive.swift's commands, for the running copy
  send <text>                writes and sends in the conversation in view
  shot <name>                captures the window into the run's shots
  sessions                   the engine's sessions, newest first
  messages <session> [n]     its last messages, briefly
  wait <session> [seconds]   until its run ends
  project <name> [repo]      a project folder in the run (a repository cloned, or empty)"""

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        print(USAGE); sys.exit(2)
    command = a[0]
    if command == "build":
        build(force=True)
    elif command == "clean":
        clean()
    elif command == "new":
        print(current_run(a[1] if len(a) > 1 else "run").folder)
    else:
        run = current_run()
        app = App(run)
        app.pid = app._find()
        if command == "launch":
            env = dict(kv.split("=", 1) for kv in a[1:])
            app.launch(**env)
            print("pid", app.pid)
        elif command == "quit":
            app.quit()
        elif command == "drive":
            ok, out = app.drive(*a[1:])
            print(out); sys.exit(0 if ok else 1)
        elif command == "send":
            app.send(" ".join(a[1:]))
        elif command == "shot":
            print(app.shot(a[1]))
        elif command == "sessions":
            for s in app.engine().sessions()[:25]:
                print(s["id"], "|", s.get("title"), "|", (s.get("location") or {}).get("directory"))
        elif command == "messages":
            e = app.engine()
            for m in e.messages(a[1], int(a[2]) if len(a) > 2 else 12):
                kind = m.get("type")
                bits = []
                for c in m.get("content") or []:
                    if c.get("type") == "text": bits.append(c.get("text", "")[:400])
                    elif c.get("type") == "tool": bits.append("[%s %s]" % (c.get("name"), (c.get("state") or {}).get("status")))
                if kind == "user": bits = [m.get("text") or (m.get("content") or "")]
                if m.get("error"): bits.append("ERROR: " + json.dumps(m["error"])[:300])
                print("-", kind, " ".join(str(b) for b in bits).replace("\n", " ")[:700])
        elif command == "wait":
            print("ended" if app.engine().wait_idle(a[1], timeout=int(a[2]) if len(a) > 2 else 600) else "still running")
        elif command == "project":
            print(run.project(a[1], repo=a[2] if len(a) > 2 else None))
        else:
            print(USAGE); sys.exit(2)
