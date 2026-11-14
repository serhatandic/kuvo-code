"""scripts/try-update.sh points the installed Kuvo Code at an update feed on 127.0.0.1 while it
runs; however it ends, the app must be pointed back at the real feed, or it checks a feed nothing
serves. Each test runs the script in a folder of its own (stand-ins for the build, the notes and the
appcast), against an app and a defaults domain of its own, with a stand-in `defaults` that keeps
them in a folder: never the real app, its domain or /Applications.

    python3 -m unittest discover -s swift/Tests/Guard -p 'test_try_update.py'
"""
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
REAL_DOMAIN = "run.kuvo.code"

DEFAULTS = """#!/bin/sh
echo "$*" >> "%(log)s"
store="%(store)s/$2"
case "$1" in
    read) [ -f "$store/$3" ] || exit 1; cat "$store/$3" ;;
    write) mkdir -p "$store"; printf '%%s\\n' "$4" > "$store/$3" ;;
    delete) [ -f "$store/$3" ] || exit 1; rm "$store/$3" ;;
esac
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def until(check, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return check()


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@unittest.skipUnless(sys.platform == "darwin", "the app, defaults and the guard's kqueue are macOS's")
class TheFeedOverride(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="kuvo-try-update-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.domain = "run.kuvo.code.tests.try-update-%d" % os.getpid()
        self.port = free_port()
        self.feed = "http://127.0.0.1:%d/appcast.xml" % self.port
        self.store = os.path.join(self.root, "defaults")
        self.log = os.path.join(self.root, "defaults.log")
        self.app = os.path.join(self.root, "Kuvo Code.app")
        os.makedirs(os.path.join(self.app, "Contents"))

        # A checkout of its own: the script and its guard, with stand-ins for what they call.
        self.checkout = os.path.join(self.root, "checkout")
        scripts = os.path.join(self.checkout, "scripts")
        os.makedirs(scripts)
        os.makedirs(os.path.join(self.checkout, "build"))
        open(os.path.join(self.checkout, "build", "KuvoCode.dmg"), "w").close()
        for name in ["try-update.sh", "feed-guard.py"]:
            if os.path.exists(os.path.join(REPO, "scripts", name)):
                shutil.copy(os.path.join(REPO, "scripts", name), scripts)
        self.tool(os.path.join(scripts, "build-version.sh"), "#!/bin/sh\necho 1\n")
        self.tool(os.path.join(scripts, "release-notes.sh"), "#!/bin/sh\necho notes\n")
        self.tool(os.path.join(scripts, "appcast.sh"), "#!/bin/sh\necho '<rss/>'\n")
        self.bin = os.path.join(self.root, "bin")
        os.makedirs(self.bin)
        self.tool(os.path.join(self.bin, "defaults"), DEFAULTS % {"log": self.log, "store": self.store})
        self.pids = []
        self.scripts = []
        self.addCleanup(self.stop_leftovers)

    def tool(self, path, text):
        with open(path, "w") as f:
            f.write(text)
        os.chmod(path, 0o755)

    def env(self):
        return {"HOME": os.path.join(self.root, "home"), "PATH": "%s:%s:/usr/bin:/bin" % (self.bin, os.path.dirname(sys.executable)),
                "LANG": "C", "SKIP_BUILD": "1", "PORT": str(self.port), "TRY_UPDATE_APP": self.app, "TRY_UPDATE_DOMAIN": self.domain}

    def overrides(self):
        """Every SUFeedURL set, in any domain, the real app's too (should the script ignore ours)."""
        found = {}
        if os.path.isdir(self.store):
            for domain in os.listdir(self.store):
                path = os.path.join(self.store, domain, "SUFeedURL")
                if os.path.exists(path):
                    with open(path) as f:
                        found[domain] = f.read().strip()
        return found

    def serving(self):
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=1):
                return True
        except OSError:
            return False

    def start(self):
        """Runs the script until it's serving its feed: its PID and its server's."""
        script = subprocess.Popen(["sh", "scripts/try-update.sh", "9.9.9"], cwd=self.checkout, env=self.env(),
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, start_new_session=True)
        self.script = script
        self.scripts.append(script)
        self.pids.append(script.pid)
        said = ""
        for line in script.stdout:
            said += line
            if "is waiting at" in line:
                break
        else:
            self.fail("it never served its feed:\n" + said)
        server = int(subprocess.run(["pgrep", "-P", str(script.pid), "-f", "http.server"],
                                    capture_output=True, text=True).stdout.split()[0])
        self.pids.append(server)
        self.assertTrue(until(self.serving), "the feed is served")
        self.assertEqual(list(self.overrides().values()), [self.feed], "it points the app at its feed")
        return script.pid, server

    def stop_leftovers(self):
        for pid in self.pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        for script in self.scripts:
            script.stdout.close()
            script.wait()

    def assertRestored(self, how):
        self.assertTrue(until(lambda: not self.overrides()), "%s: the override is still set: %s" % (how, self.overrides()))
        self.assertTrue(until(lambda: not self.serving()), "%s: the feed is still served" % how)
        with open(self.log) as f:
            domains = [line.split()[1] for line in f if len(line.split()) > 1]
        self.assertNotIn(REAL_DOMAIN, domains, "never the real app's domain")

    def test_ctrl_c_terminate_and_hangup_restore_the_feed(self):
        for sig in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
            with self.subTest(signal=sig.name):
                script, _ = self.start()
                os.kill(script, sig)
                self.assertRestored(sig.name)

    def test_ctrl_c_at_its_terminal_restores_the_feed(self):
        # The whole foreground group gets it: the server stops too, often before the script's trap.
        script, _ = self.start()
        os.killpg(script, signal.SIGINT)
        self.assertTrue(until(lambda: self.script.poll() is not None), "the script ends")
        self.assertRestored("Ctrl-C at its terminal")

    def test_its_own_trap_restores_the_feed_when_the_server_has_stopped(self):
        # The trap alone, without the guard: it mustn't stop at the server it can't kill.
        self.tool(os.path.join(self.checkout, "scripts", "feed-guard.py"), "print('watching')\n")
        script, server = self.start()
        os.kill(server, signal.SIGKILL)
        self.assertTrue(until(lambda: self.script.poll() is not None), "the script ends with its server")
        self.assertRestored("the server killed, the trap alone")

    def test_killed_outright_alone_restores_the_feed(self):
        script, _ = self.start()
        os.kill(script, signal.SIGKILL)
        self.assertRestored("SIGKILL to the script")

    def test_killed_outright_with_its_process_group_restores_the_feed(self):
        script, _ = self.start()
        os.killpg(script, signal.SIGKILL)
        self.assertRestored("SIGKILL to its process group")

    def test_killed_outright_with_its_tree_restores_the_feed(self):
        script, server = self.start()
        os.kill(script, signal.SIGKILL)
        os.kill(server, signal.SIGKILL)
        self.assertRestored("SIGKILL to the script and its server")

    def test_the_server_ending_restores_the_feed(self):
        script, server = self.start()
        os.kill(server, signal.SIGKILL)
        self.assertRestored("the server killed")
        self.assertTrue(until(lambda: self.script.poll() is not None), "the script ends with its server")

    def test_a_feed_an_earlier_run_left_is_cleared_first(self):
        os.makedirs(os.path.join(self.store, self.domain))
        for left, cleared in [("http://127.0.0.1:8742/appcast.xml", True), ("https://example.com/appcast.xml", False)]:
            with self.subTest(left=left):
                with open(os.path.join(self.store, self.domain, "SUFeedURL"), "w") as f:
                    f.write(left + "\n")
                # Even a run that stops at once, before it builds anything.
                self.tool(os.path.join(self.checkout, "scripts", "build-version.sh"), "#!/bin/sh\nexit 1\n")
                env = dict(self.env(), TRY_UPDATE_APP=os.path.join(self.root, "no such app.app"))
                done = subprocess.run(["sh", "scripts/try-update.sh", "9.9.9"], cwd=self.checkout, env=env,
                                      stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
                self.assertNotEqual(done.returncode, 0)
                self.assertEqual(self.overrides(), {} if cleared else {self.domain: left})


if __name__ == "__main__":
    unittest.main()
