"""The batches (scripts/batch-build.sh, scripts/batch.sh), which the phone's test runs use (its
scripts/test-app.sh --from-batch): a build of main is made once, in a folder of its own with its
stamp, the newest two kept and older ones deleted once no test run has them open; two builds never
run at once; a run opens the newest batch, waits for a batch being built, and refuses when the newest
build failed or stopped; the check refuses tests the batch hasn't; and the compile check brings its
one kept folder to main file by file. (The retired Swift Mac app has no batch.)

Each test has a folder of its own: stand-in checkouts (git repositories in it), the batches
(KUVO_BATCH_DIR), heavy.sh's locks (KUVO_HEAVY_DIR) and an xcodebuild stand-in first on PATH, which
makes what a build would and says what it was asked.

    cd scripts && python3 -m unittest test_batch
"""
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from test_heavy import clean_environment, without_background_priority

SCRIPTS = Path(__file__).resolve().parent
BUILD = str(SCRIPTS / "batch-build.sh")
BATCH = str(SCRIPTS / "batch.sh")

# Makes what build-for-testing makes in its -derivedDataPath (the products, an .xctestrun, files
# the tests don't use), unless FAKE_XCODE_FAIL; with FAKE_XCODE_HOLD, it says it's running and
# waits until that fifo is written.
XCODEBUILD = r"""#!/bin/sh
echo "$*" >> "$FAKE_XCODE_LOG"
if [ -n "${FAKE_XCODE_HOLD:-}" ]; then
    : > "$FAKE_XCODE_HOLD.running"
    read x < "$FAKE_XCODE_HOLD"
fi
derived=
while [ $# -gt 0 ]; do
    case "$1" in -derivedDataPath) derived=$2; shift ;; esac
    shift
done
if [ -n "${FAKE_XCODE_FAIL:-}" ]; then
    echo "Thing.swift:1:1: error: it doesn't compile"
    echo "** TEST BUILD FAILED **"
    exit 65
fi
mkdir -p "$derived/Build/Products/Debug-iphonesimulator/KuvoCodeMobile.app" "$derived/Build/Intermediates.noindex/KuvoCodeMobile.build" "$derived/Index.noindex"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>KuvoCodeMobileTests</key><dict><key>TestHostBundleIdentifier</key><string>run.kuvo.code.ios.tests</string></dict></dict></plist>\n' > "$derived/Build/Products/KuvoCodeMobile_iphonesimulator-arm64.xctestrun"
echo "** TEST BUILD SUCCEEDED **"
"""

# The user's temporary and cache folders, the test's own.
GETCONF = r"""#!/bin/sh
case "$1" in
    DARWIN_USER_TEMP_DIR) echo "$FAKE_TEMP_DIR/" ;;
    DARWIN_USER_CACHE_DIR) echo "$FAKE_CACHE_DIR/" ;;
    *) exec /usr/bin/getconf "$@" ;;
esac
"""


# A clock of the test's own (the seconds in $FAKE_CLOCK), which only a whole number of seconds'
# sleep moves, at once, without waiting: for builds one at a time, where only batch-build.sh's
# naming sleeps whole seconds (heavy.sh's waits for a turn would spin). A shorter sleep sleeps.
DATE = r"""#!/bin/sh
exec /bin/date -r "$(cat "$FAKE_CLOCK")" "$@"
"""
SLEEP = r"""#!/bin/sh
case "$1" in
    "" | *[!0-9]*) exec /bin/sleep "$@" ;;
esac
echo $(($(cat "$FAKE_CLOCK") + $1)) > "$FAKE_CLOCK"
"""


def wait_for(path, what, text=None):
    """Until the file is there (and has the text)."""
    deadline = time.time() + 30
    while not os.path.exists(path) or (text is not None and text not in read(path)):
        if time.time() > deadline:
            raise AssertionError(what)
        time.sleep(0.1)


def release(fifo):
    with open(fifo, "w") as go:
        go.write("go\n")


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
                          check=True, capture_output=True, text=True).stdout.strip()


def read(path):
    with open(path) as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


class Batches(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="kuvo-batch-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.batches = os.path.join(self.root, "batches")
        self.kuvo_ai = self.repo("kuvo-ai", {
            "swift/KuvoClient/Package.swift": "// let package = Package(name: \"KuvoClient\")\n",
        })
        self.phone = self.repo("kuvo-code-ios", {
            "KuvoCodeMobile/App.swift": "struct App {}\n",
            "KuvoCodeMobileTests/PairingTests.swift": "@Suite struct PairingTests {\n    @Test func pairs() {}\n}\n",
            "KuvoCodeMobileTests/QueueTests.swift": "@MainActor final class QueueTests: XCTestCase {\n    func testAdds() {}\n}\n",
            "KuvoCodeMobileTests/Outer.swift": "@Suite struct Outer {\n    @Suite struct Inner {\n        @Test func deep() {}\n    }\n}\n\n@Test func freeTest() {}\n",
            "Gone.txt": "removed in the next commit\n",
        })
        bin_folder = os.path.join(self.root, "bin")
        for tool, script in [("xcodebuild", XCODEBUILD), ("getconf", GETCONF)]:
            write(os.path.join(bin_folder, tool), script)
            os.chmod(os.path.join(bin_folder, tool), 0o755)
        for folder in ["home", "tmp", "user-temp", "user-cache"]:
            os.makedirs(os.path.join(self.root, folder))
        self.xcode_log = os.path.join(self.root, "xcodebuild.log")
        env = without_background_priority(dict(clean_environment(), KUVO_HEAVY_DIR=os.path.join(self.root, "locks"),
                                               KUVO_HEAVY_LOAD="1000", KUVO_HEAVY_MEMORY="0", KUVO_HEAVY_OLD_UNTIL="20000101",
                                               KUVO_XCODE_CACHE="0"))
        os.makedirs(env["KUVO_HEAVY_DIR"])
        self.env = dict(env, PATH=bin_folder + os.pathsep + env["PATH"], KUVO_BATCH_DIR=self.batches,
                        KUVO_BATCH_MAC_REPO=self.kuvo_ai, KUVO_BATCH_PHONE_REPO=self.phone,
                        KUVO_HEAVY_SH=str(SCRIPTS / "heavy.sh"), FAKE_XCODE_LOG=self.xcode_log,
                        FAKE_TEMP_DIR=os.path.join(self.root, "user-temp"), FAKE_CACHE_DIR=os.path.join(self.root, "user-cache"))

    def stop_the_clock(self):
        """From now on, the scripts' time stands still unless they sleep."""
        bin_folder = os.path.join(self.root, "clock-bin")
        for tool, script in [("date", DATE), ("sleep", SLEEP)]:
            write(os.path.join(bin_folder, tool), script)
            os.chmod(os.path.join(bin_folder, tool), 0o755)
        clock = os.path.join(self.root, "clock")
        write(clock, f"{int(time.time())}\n")
        self.env = dict(self.env, PATH=bin_folder + os.pathsep + self.env["PATH"], FAKE_CLOCK=clock)

    def amend_until(self, wanted):
        """The phone's main's last commit, made again at other times (each a new hash) until its hash is one wanted."""
        for second in range(64):
            if wanted(git(self.phone, "rev-parse", "main")):
                return True
            git(self.phone, "commit", "-q", "--amend", "--no-edit", f"--date={1700000000 + second} +0000")
        return False

    def repo(self, name, files):
        path = os.path.join(self.root, name)
        os.makedirs(path)
        git(path, "init", "-q", "-b", "main")
        for file, text in files.items():
            write(os.path.join(path, file), text)
        git(path, "add", "-A")
        git(path, "commit", "-q", "-m", "First")
        return path

    def commit_to_phone(self, text, message):
        write(os.path.join(self.phone, "KuvoCodeMobile/App.swift"), text)
        git(self.phone, "commit", "-qam", message)
        return git(self.phone, "rev-parse", "main")

    def build(self, *args, **env):
        return subprocess.run(["/bin/sh", BUILD, *args], env=dict(self.env, **env), capture_output=True, text=True, timeout=60)

    def start_build(self, hold, **extra):
        """A build that waits, once its xcodebuild starts, until the fifo `hold` is written."""
        build = subprocess.Popen(["/bin/sh", BUILD, "phone"], env=dict(self.env, FAKE_XCODE_HOLD=hold, **extra),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        wait_for(hold + ".running", "the build never started")
        return build

    def built(self):
        """The phone's batches, oldest first."""
        folder = os.path.join(self.batches, "phone")
        return sorted(name for name in os.listdir(folder) if os.path.isdir(os.path.join(folder, name))) if os.path.isdir(folder) else []

    def folder(self, name):
        return os.path.join(self.batches, "phone", name)

    def stamp(self, name):
        with open(os.path.join(self.folder(name), "stamp")) as f:
            return dict(line.rstrip("\n").split("=", 1) for line in f)

    def batch(self, *args):
        return subprocess.run(["/bin/sh", BATCH, *args], env=self.env, capture_output=True, text=True, timeout=30)

    def xcode_said(self):
        return read(self.xcode_log) if os.path.exists(self.xcode_log) else ""


class Building(Batches):
    def test_a_batch_is_built_once_from_both_mains_and_its_stamp_says_what_it_is(self):
        done = self.build("phone")
        self.assertEqual(done.returncode, 0, done.stderr)
        [name] = self.built()
        commit = git(self.phone, "rev-parse", "main")
        self.assertTrue(name.endswith("-" + commit[:7]), name)
        stamp = self.stamp(name)
        src = os.path.join(self.folder(name), "src")
        self.assertEqual(stamp["kuvo_code_ios"], commit)
        self.assertEqual(stamp["kuvo_code_ios_subject"], "First")
        self.assertEqual(stamp["kuvo_ai"], git(self.kuvo_ai, "rev-parse", "main"))
        self.assertEqual(stamp["kuvo_code_ios_src"], os.path.join(src, "kuvo-code-ios"))
        self.assertEqual(stamp["kuvo_ai_src"], os.path.join(src, "kuvo-ai"))
        self.assertEqual(stamp["xctestrun"], os.path.join(self.folder(name), "build", "Build", "Products", "KuvoCodeMobile_iphonesimulator-arm64.xctestrun"))
        self.assertTrue(os.path.isfile(stamp["xctestrun"]))
        self.assertIn("built", stamp)
        # Both mains' files, exported side by side: the phone's project finds kuvo-ai's packages at ../kuvo-ai.
        self.assertTrue(os.path.isfile(os.path.join(src, "kuvo-code-ios", "KuvoCodeMobileTests", "PairingTests.swift")))
        self.assertTrue(os.path.isfile(os.path.join(src, "kuvo-ai", "swift", "KuvoClient", "Package.swift")))
        said = self.xcode_said()
        self.assertEqual(said.count("build-for-testing"), 1)
        for part in ["APP_BUNDLE_ID=run.kuvo.code.ios.tests", "-scheme KuvoCodeMobile", "generic/platform=iOS Simulator",
                     "-derivedDataPath " + os.path.join(self.folder(name), "build"),
                     os.path.join(src, "kuvo-code-ios", "KuvoCodeMobile.xcodeproj")]:
            self.assertIn(part, said)
        self.assertNotIn("KuvoCode.xcodeproj", said, "never the retired Mac app")
        self.assertFalse(os.path.exists(os.path.join(self.folder(name), "build", "Build", "Intermediates.noindex")))
        self.assertFalse(os.path.exists(os.path.join(self.folder(name), "build", "Index.noindex")))
        self.assertIn("Built the phone batch " + name, done.stdout)

    def test_given_commits_are_built_instead_of_main(self):
        first_phone = git(self.phone, "rev-parse", "main")
        first_ai = git(self.kuvo_ai, "rev-parse", "main")
        self.commit_to_phone("struct App { var later = 1 }\n", "Later")
        write(os.path.join(self.kuvo_ai, "swift/KuvoClient/Later.swift"), "struct Later {}\n")
        git(self.kuvo_ai, "add", "-A")
        git(self.kuvo_ai, "commit", "-qm", "Later")
        done = self.build("phone", KUVO_BATCH_PHONE_REF=first_phone, KUVO_BATCH_MAC_REF=first_ai)
        self.assertEqual(done.returncode, 0, done.stderr)
        stamp = self.stamp(self.built()[0])
        self.assertEqual((stamp["kuvo_code_ios"], stamp["kuvo_ai"]), (first_phone, first_ai))
        self.assertEqual(self.build("phone", KUVO_BATCH_PHONE_REF="nothing-like-it").returncode, 1)

    def test_all_builds_the_phones_and_the_mac_has_none(self):
        done = self.build()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.built()), 1)
        self.assertFalse(os.path.exists(os.path.join(self.batches, "mac")))
        done = self.build("mac")
        self.assertEqual(done.returncode, 64)
        self.assertIn("retired", done.stderr)
        self.assertEqual(self.batch("open", "mac", str(os.getpid())).returncode, 64)

    def test_a_build_that_fails_leaves_no_batch_and_says_where_its_log_is(self):
        done = self.build("phone", FAKE_XCODE_FAIL="1")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(self.built(), [])
        self.assertIn("error: it doesn't compile", done.stderr)
        logs = [name for name in os.listdir(os.path.join(self.batches, "phone")) if name.startswith("failed-") and name.endswith(".log")]
        self.assertEqual(len(logs), 1)
        self.assertIn(logs[0], done.stderr)
        # And no batch to test from.
        opened = self.batch("open", "phone", str(os.getpid()))
        self.assertEqual(opened.returncode, 1)
        self.assertIn("The newest phone batch didn't build", opened.stderr)

    def test_builds_in_one_second_are_named_in_the_order_they_were_built(self):
        self.stop_the_clock()
        # A good commit whose name sorts in the upper half, so a few tries find one below it.
        self.assertTrue(self.amend_until(lambda commit: commit[0] >= "8"))
        self.assertEqual(self.build("phone").returncode, 0)
        good = git(self.phone, "rev-parse", "main")
        # A broken commit whose name sorts before the good one's: in the same second, its failed
        # build would look older than the batch, and runs would test that.
        self.commit_to_phone("struct App { var broken }\n", "Breaks it")
        self.assertTrue(self.amend_until(lambda commit: commit[:7] < good[:7]))
        broken = git(self.phone, "rev-parse", "main")
        self.assertEqual(self.build("phone", FAKE_XCODE_FAIL="1").returncode, 1)
        opened = self.batch("open", "phone", str(os.getpid()))
        self.assertEqual(opened.returncode, 1, opened.stdout)
        self.assertIn("The newest phone batch didn't build: kuvo-code-ios " + broken[:9] + " “Breaks it”", opened.stderr)
        self.assertIn("error: it doesn't compile", opened.stderr)
        # Fixed and built, the next is the newest.
        self.assertEqual(self.build("phone").returncode, 0)
        [older, newer] = self.built()
        self.assertTrue(older.endswith(good[:7]) and newer.endswith(broken[:7]), (older, newer))
        [failed] = [name[len("failed-"):-len(".stamp")] for name in os.listdir(os.path.join(self.batches, "phone"))
                    if name.startswith("failed-") and name.endswith(".stamp")]
        self.assertEqual(sorted([newer, failed, older]), [older, failed, newer], "named in the order they were built")
        opened = self.batch("open", "phone", str(os.getpid()))
        self.assertEqual(opened.returncode, 0, opened.stderr)
        self.assertEqual(opened.stdout.strip(), self.folder(newer))

    def test_a_second_build_while_one_runs_is_refused(self):
        hold = os.path.join(self.root, "hold")
        os.mkfifo(hold)
        first = self.start_build(hold)
        try:
            second = self.build("phone")
            self.assertEqual(second.returncode, 75)
            self.assertIn("Another build of the phone batch is running", second.stderr)
        finally:
            release(hold)
            out, err = first.communicate(timeout=60)
        self.assertEqual(first.returncode, 0, err)
        self.assertEqual(len(self.built()), 1, "the refused one made no batch")


class Pruning(Batches):
    def test_the_newest_two_are_kept_and_an_older_one_a_run_has_open_until_its_over(self):
        self.assertEqual(self.build("phone").returncode, 0)
        oldest = self.built()[0]
        # A test run (a process of its own) opens it.
        run = subprocess.Popen(["/bin/sh", "-c", "read x"], stdin=subprocess.PIPE)
        self.addCleanup(run.kill)
        opened = self.batch("open", "phone", str(run.pid))
        self.assertEqual(opened.stdout.strip(), self.folder(oldest))
        # A build that never finished, left behind.
        os.makedirs(os.path.join(self.folder("20000101-000000-abcdef0"), "src"))
        self.assertEqual(self.build("phone").returncode, 0)
        done = self.build("phone")
        self.assertEqual(done.returncode, 0)
        self.assertIn("Kept " + oldest, done.stderr)
        built = self.built()
        self.assertEqual(len(built), 3, "the two newest, and the one open")
        self.assertEqual(built[0], oldest)
        # Its run over, the next build deletes it.
        run.communicate(b"\n", timeout=10)
        self.assertEqual(self.build("phone").returncode, 0)
        built = self.built()
        self.assertEqual(len(built), 2)
        self.assertNotIn(oldest, built)

    def test_a_run_opens_the_newest_and_closes_it(self):
        self.assertEqual(self.build("phone").returncode, 0)
        self.assertEqual(self.build("phone").returncode, 0)
        newest = self.built()[-1]
        opened = self.batch("open", "phone", "12345")
        folder = self.folder(newest)
        self.assertEqual(opened.stdout.strip(), folder)
        self.assertTrue(os.path.exists(os.path.join(folder, "runs", "12345")))
        self.batch("close", folder, "12345")
        self.assertFalse(os.path.exists(os.path.join(folder, "runs", "12345")))


class Opening(Batches):
    """What a run from a batch is given (scripts/batch.sh open, check and behind, as the phone's
    scripts/test-app.sh --from-batch asks)."""

    def test_without_a_batch_it_says_how_to_make_one(self):
        opened = self.batch("open", "phone", str(os.getpid()))
        self.assertEqual(opened.returncode, 1)
        self.assertIn("There's no phone batch yet", opened.stderr)

    def test_a_run_started_while_a_batch_is_built_waits_for_it_and_takes_that_one(self):
        self.assertEqual(self.build("phone").returncode, 0)
        older = self.built()[0]
        self.commit_to_phone("struct App { var later = 1 }\n", "Later")
        hold = os.path.join(self.root, "hold")
        os.mkfifo(hold)
        build = self.start_build(hold)
        said = os.path.join(self.root, "said")
        try:
            with open(said, "w") as err:
                run = subprocess.Popen(["/bin/sh", BATCH, "open", "phone", str(os.getpid())], env=self.env,
                                       stdout=subprocess.PIPE, stderr=err, text=True)
            wait_for(said, "the run never waited for the build", "Waiting for the phone batch being built now")
        finally:
            release(hold)
            build.communicate(timeout=60)
        out, _ = run.communicate(timeout=60)
        self.assertEqual(run.returncode, 0, read(said))
        [newer] = [name for name in self.built() if name != older]
        self.assertEqual(out.strip(), self.folder(newer))

    def test_a_run_waiting_for_a_build_that_is_stopped_refuses_rather_than_take_the_older_batch(self):
        self.assertEqual(self.build("phone").returncode, 0)
        hold = os.path.join(self.root, "hold")
        os.mkfifo(hold)
        build = self.start_build(hold)
        said = os.path.join(self.root, "said")
        try:
            with open(said, "w") as err:
                run = subprocess.Popen(["/bin/sh", BATCH, "open", "phone", str(os.getpid())], env=self.env,
                                       stdout=subprocess.PIPE, stderr=err, text=True)
            wait_for(said, "the run never waited for the build", "Waiting for the phone batch being built now")
            # Stopped, as by Ctrl-C or a caller's TERM: the build's own process group.
            os.killpg(build.pid, signal.SIGTERM)
            build.communicate(timeout=60)
        finally:
            # (The stand-in xcodebuild, if it's still there, reading its fifo.)
            if os.path.exists(hold + ".running"):
                try:
                    fd = os.open(hold, os.O_WRONLY | os.O_NONBLOCK)
                    os.close(fd)
                except OSError:
                    pass
        out, _ = run.communicate(timeout=60)
        self.assertEqual(run.returncode, 1, out)
        # (Its failed stamp, or its folder still there as it looked: either way it says so.)
        self.assertIn("stopped before it was built", read(said))
        self.assertEqual(len(self.built()), 1, "it left no batch behind")

    def test_when_the_newest_build_stopped_before_it_was_built_a_run_refuses(self):
        self.assertEqual(self.build("phone").returncode, 0)
        # (Killed outright, it couldn't say so: its folder without a stamp is what's left.)
        os.makedirs(os.path.join(self.folder("29991231-000000-abcdef0"), "src"))
        opened = self.batch("open", "phone", str(os.getpid()))
        self.assertEqual(opened.returncode, 1)
        self.assertIn("29991231-000000-abcdef0, stopped before it was built", opened.stderr)

    def test_the_batchs_tests_pass_the_check(self):
        self.assertEqual(self.build("phone").returncode, 0)
        folder = self.folder(self.built()[0])
        for only in [["KuvoCodeMobileTests"], ["KuvoCodeMobileTests/PairingTests", "KuvoCodeMobileTests/QueueTests"],
                     ["KuvoCodeMobileTests/PairingTests/pairs()"], ["KuvoCodeMobileTests/QueueTests/testAdds"],
                     ["KuvoCodeMobileTests/Outer/Inner"], ["KuvoCodeMobileTests/Outer/Inner/deep()"], ["KuvoCodeMobileTests/freeTest()"]]:
            with self.subTest(only=only):
                done = self.batch("check", folder, "kuvo-code-ios", *only)
                self.assertEqual(done.returncode, 0, done.stderr)

    def test_tests_the_batch_hasnt_are_refused(self):
        self.assertEqual(self.build("phone").returncode, 0)
        name = self.built()[0]
        for only in ["KuvoCodeMobileTests/NewerTests", "KuvoCodeMobileTests/PairingTests KuvoCodeMobileTests/NewerTests",
                     "KuvoCodeMobileTests/PairingTests/aNewerTest()", "SomeOtherTests", "KuvoCodeMobileTests/Pair.*",
                     "KuvoCodeMobileTests/Outer/Missing"]:
            with self.subTest(only=only):
                done = self.batch("check", self.folder(name), "kuvo-code-ios", *only.split())
                self.assertEqual(done.returncode, 1, done.stderr)
                self.assertIn("Not in the batch " + name, done.stderr)
                self.assertIn(only.split()[-1], done.stderr)
                self.assertIn("next batch", done.stderr)

    def test_it_says_when_the_callers_head_isnt_in_the_batch(self):
        self.assertEqual(self.build("phone").returncode, 0)
        folder = self.folder(self.built()[0])
        self.assertEqual(self.batch("behind", folder, "kuvo-code-ios", self.phone).stderr, "")
        self.commit_to_phone("struct App { var mine = 1 }\n", "Mine")
        said = self.batch("behind", folder, "kuvo-code-ios", self.phone).stderr
        self.assertIn("isn't in this batch", said)


class CompileOnly(Batches):
    def test_the_compile_check_keeps_one_folder_and_rewrites_only_what_changed(self):
        done = self.build("--compile-only", "phone")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("compiles for the phone", done.stdout)
        src = os.path.join(self.batches, "compile", "src", "kuvo-code-ios")
        self.assertTrue(os.path.isfile(os.path.join(self.batches, "compile", "src", "kuvo-ai", "swift", "KuvoClient", "Package.swift")))
        kept, changed = os.path.join(src, "KuvoCodeMobileTests", "PairingTests.swift"), os.path.join(src, "KuvoCodeMobile", "App.swift")
        old = os.stat(kept).st_mtime_ns
        os.utime(changed, ns=(1, 1))
        write(os.path.join(self.phone, "KuvoCodeMobile/App.swift"), "struct App { var later = 1 }\n")
        os.remove(os.path.join(self.phone, "Gone.txt"))
        git(self.phone, "commit", "-qam", "Later")
        done = self.build("--compile-only", "phone")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(os.stat(kept).st_mtime_ns, old, "a file that's the same isn't written again")
        self.assertEqual(read(changed), "struct App { var later = 1 }\n")
        self.assertNotEqual(os.stat(changed).st_mtime_ns, 1)
        self.assertFalse(os.path.exists(os.path.join(src, "Gone.txt")))
        # One folder for every check, and no batch.
        self.assertEqual(self.xcode_said().count("-derivedDataPath " + os.path.join(self.batches, "compile", "phone-build")), 2)
        self.assertEqual(self.built(), [])
        self.assertTrue(read(os.path.join(self.batches, "compile", "phone.last")).startswith("compiles " + git(self.phone, "rev-parse", "main")))
        # The checkouts themselves are untouched.
        self.assertEqual(git(self.phone, "status", "--porcelain"), "")
        self.assertEqual(git(self.kuvo_ai, "status", "--porcelain"), "")

    def test_a_compile_that_fails_says_so(self):
        done = self.build("--compile-only", "phone", FAKE_XCODE_FAIL="1")
        self.assertEqual(done.returncode, 1)
        self.assertIn("doesn't compile for the phone", done.stderr)
        self.assertTrue(read(os.path.join(self.batches, "compile", "phone.last")).startswith("failed "))


if __name__ == "__main__":
    unittest.main()
