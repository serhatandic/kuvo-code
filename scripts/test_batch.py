"""The batches (scripts/batch-build.sh, scripts/batch.sh, scripts/test-app.sh --from-batch): a build of
main is made once, in a folder of its own with its stamp, the newest two kept and older ones deleted
once no test run has them open; two builds of one platform never run at once; a run from a batch
tests it without building and prints its stamp, refuses tests the batch hasn't, waits for a batch
being built and refuses when the newest build failed; and the compile check brings its one kept
folder to main file by file.

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
TEST_APP = str(SCRIPTS / "test-app.sh")

# Makes what build-for-testing makes in its -derivedDataPath (the products, an .xctestrun, files
# the tests don't use), unless FAKE_XCODE_FAIL; with FAKE_XCODE_HOLD, it says it's running and
# waits until that fifo is written.
XCODEBUILD = r"""#!/bin/sh
echo "$*" >> "$FAKE_XCODE_LOG"
echo "source root: ${TEST_RUNNER_KUVO_SOURCE_ROOT:-none}" >> "$FAKE_XCODE_LOG"
if [ "$1" = test-without-building ]; then
    if [ -n "${FAKE_XCODE_TEST_HOLD:-}" ]; then
        : > "$FAKE_XCODE_TEST_HOLD.running"
        read x < "$FAKE_XCODE_TEST_HOLD"
    fi
    [ -n "${FAKE_XCODE_NO_TESTS:-}" ] || echo "✔ Test run with 1 test in 1 suite passed after 0.001 seconds."
    echo "** TEST EXECUTE SUCCEEDED **"
    exit 0
fi
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
mkdir -p "$derived/Build/Products/Debug/Kuvo Code.app/Contents/MacOS" "$derived/Build/Intermediates.noindex/KuvoCode.build" "$derived/Index.noindex"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>KuvoCodeTests</key><dict><key>TestHostBundleIdentifier</key><string>run.kuvo.code.tests</string></dict></dict></plist>\n' > "$derived/Build/Products/KuvoCode_macosx-arm64.xctestrun"
echo "** TEST BUILD SUCCEEDED **"
"""

# The user's temporary and cache folders, the test's own (test-app.sh's lock and build folders).
GETCONF = r"""#!/bin/sh
case "$1" in
    DARWIN_USER_TEMP_DIR) echo "$FAKE_TEMP_DIR/" ;;
    DARWIN_USER_CACHE_DIR) echo "$FAKE_CACHE_DIR/" ;;
    *) exec /usr/bin/getconf "$@" ;;
esac
"""


# A clock of the test's own (the seconds in $FAKE_CLOCK), which only a whole number of seconds'
# sleep moves, at once; a shorter sleep (heavy.sh's polls) sleeps.
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
        self.mac = self.repo("kuvo-ai", {
            "KuvoCode/App.swift": "struct App {}\n",
            "KuvoCodeTests/WindowTabsTests.swift": "@Suite struct WindowTabsTests {\n    @Test func opensATab() {}\n}\n",
            "KuvoCodeTests/WorkQueueTests.swift": "@MainActor final class WorkQueueTests: XCTestCase {\n    func testAdds() {}\n}\n",
            "KuvoCodeTests/Outer.swift": "@Suite struct Outer {\n    @Suite struct Inner {\n        @Test func deep() {}\n    }\n}\n\n@Test func freeTest() {}\n",
            "Gone.txt": "removed in the next commit\n",
        })
        self.phone = self.repo("kuvo-code-ios", {
            "KuvoCodeMobileTests/PairingTests.swift": "@Suite struct PairingTests {}\n",
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
                        KUVO_BATCH_MAC_REPO=self.mac, KUVO_BATCH_PHONE_REPO=self.phone,
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

    def repo(self, name, files):
        path = os.path.join(self.root, name)
        os.makedirs(path)
        git(path, "init", "-q", "-b", "main")
        for file, text in files.items():
            write(os.path.join(path, file), text)
        git(path, "add", "-A")
        git(path, "commit", "-q", "-m", "First")
        return path

    def build(self, *args, **env):
        return subprocess.run(["/bin/sh", BUILD, *args], env=dict(self.env, **env), capture_output=True, text=True, timeout=60)

    def built(self, platform):
        """The batches of a platform, oldest first."""
        folder = os.path.join(self.batches, platform)
        return sorted(name for name in os.listdir(folder) if os.path.isdir(os.path.join(folder, name))) if os.path.isdir(folder) else []

    def stamp(self, platform, name):
        with open(os.path.join(self.batches, platform, name, "stamp")) as f:
            return dict(line.rstrip("\n").split("=", 1) for line in f)

    def batch(self, *args):
        return subprocess.run(["/bin/sh", BATCH, *args], env=self.env, capture_output=True, text=True, timeout=30)

    def xcode_said(self):
        return read(self.xcode_log) if os.path.exists(self.xcode_log) else ""


class Building(Batches):
    def test_a_batch_is_built_once_from_mains_commit_and_its_stamp_says_what_it_is(self):
        done = self.build("mac")
        self.assertEqual(done.returncode, 0, done.stderr)
        [name] = self.built("mac")
        commit = git(self.mac, "rev-parse", "main")
        self.assertTrue(name.endswith("-" + commit[:7]), name)
        stamp = self.stamp("mac", name)
        folder = os.path.join(self.batches, "mac", name)
        self.assertEqual(stamp["kuvo_ai"], commit)
        self.assertEqual(stamp["kuvo_ai_subject"], "First")
        self.assertEqual(stamp["kuvo_ai_src"], os.path.join(folder, "src", "kuvo-ai"))
        self.assertEqual(stamp["xctestrun"], os.path.join(folder, "build", "Build", "Products", "KuvoCode_macosx-arm64.xctestrun"))
        self.assertTrue(os.path.isfile(stamp["xctestrun"]))
        self.assertIn("built", stamp)
        # Main's files, exported; the test copy's settings; what the tests don't use, gone.
        self.assertTrue(os.path.isfile(os.path.join(folder, "src", "kuvo-ai", "KuvoCodeTests", "WindowTabsTests.swift")))
        said = self.xcode_said()
        self.assertEqual(said.count("build-for-testing"), 1)
        for part in ["APP_BUNDLE_ID=run.kuvo.code.tests", "CODE_SIGN_IDENTITY=-", "-scheme KuvoCode",
                     "-derivedDataPath " + os.path.join(folder, "build"), os.path.join(folder, "src", "kuvo-ai", "KuvoCode.xcodeproj")]:
            self.assertIn(part, said)
        self.assertFalse(os.path.exists(os.path.join(folder, "build", "Build", "Intermediates.noindex")))
        self.assertFalse(os.path.exists(os.path.join(folder, "build", "Index.noindex")))
        self.assertIn("Built the mac batch " + name, done.stdout)

    def test_a_given_commit_is_built_instead_of_main(self):
        first = git(self.mac, "rev-parse", "main")
        write(os.path.join(self.mac, "KuvoCode/App.swift"), "struct App { var later = 1 }\n")
        git(self.mac, "commit", "-qam", "Later")
        done = self.build("mac", KUVO_BATCH_MAC_REF=first)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.stamp("mac", self.built("mac")[0])["kuvo_ai"], first)
        self.assertEqual(self.build("mac", KUVO_BATCH_MAC_REF="nothing-like-it").returncode, 1)

    def test_the_phones_batch_is_built_with_kuvo_ai_beside_it(self):
        done = self.build("phone")
        self.assertEqual(done.returncode, 0, done.stderr)
        [name] = self.built("phone")
        stamp = self.stamp("phone", name)
        self.assertEqual(stamp["kuvo_code_ios"], git(self.phone, "rev-parse", "main"))
        self.assertEqual(stamp["kuvo_ai"], git(self.mac, "rev-parse", "main"))
        src = os.path.join(self.batches, "phone", name, "src")
        self.assertEqual(stamp["kuvo_code_ios_src"], os.path.join(src, "kuvo-code-ios"))
        self.assertEqual(stamp["kuvo_ai_src"], os.path.join(src, "kuvo-ai"))
        # The phone's project finds kuvo-ai's packages at ../kuvo-ai.
        self.assertTrue(os.path.isdir(os.path.join(src, "kuvo-code-ios", "KuvoCodeMobileTests")))
        self.assertTrue(os.path.isdir(os.path.join(src, "kuvo-ai", "KuvoCode")))
        said = self.xcode_said()
        self.assertIn("APP_BUNDLE_ID=run.kuvo.code.ios.tests", said)
        self.assertIn("-scheme KuvoCodeMobile", said)
        self.assertEqual(self.built("mac"), [], "phone builds only the phone's")

    def test_all_builds_both(self):
        done = self.build()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.built("mac")), 1)
        self.assertEqual(len(self.built("phone")), 1)

    def test_a_build_that_fails_leaves_no_batch_and_says_where_its_log_is(self):
        done = self.build("mac", FAKE_XCODE_FAIL="1")
        self.assertEqual(done.returncode, 1)
        self.assertEqual(self.built("mac"), [])
        self.assertIn("error: it doesn't compile", done.stderr)
        logs = [name for name in os.listdir(os.path.join(self.batches, "mac")) if name.startswith("failed-") and name.endswith(".log")]
        self.assertEqual(len(logs), 1)
        self.assertIn(logs[0], done.stderr)
        # And no batch to test from.
        opened = self.batch("open", "mac", str(os.getpid()))
        self.assertEqual(opened.returncode, 1)
        self.assertIn("The newest mac batch didn't build", opened.stderr)

    def test_builds_in_one_second_are_named_in_the_order_they_were_built(self):
        self.stop_the_clock()
        self.assertEqual(self.build("mac").returncode, 0)
        good = git(self.mac, "rev-parse", "main")
        # A broken commit whose name sorts before the good one's: in the same second, its failed
        # build would look older than the batch, and runs would test that.
        write(os.path.join(self.mac, "KuvoCode/App.swift"), "struct App { var broken }\n")
        git(self.mac, "commit", "-qam", "Breaks it")
        second = 0
        while git(self.mac, "rev-parse", "main")[:7] >= good[:7]:
            second += 1
            git(self.mac, "commit", "-q", "--amend", "--no-edit", f"--date={1700000000 + second} +0000")
        broken = git(self.mac, "rev-parse", "main")
        self.assertEqual(self.build("mac", FAKE_XCODE_FAIL="1").returncode, 1)
        opened = self.batch("open", "mac", str(os.getpid()))
        self.assertEqual(opened.returncode, 1, opened.stdout)
        self.assertIn("The newest mac batch didn't build: kuvo-ai " + broken[:9], opened.stderr)
        # Fixed and built, the next is the newest.
        self.assertEqual(self.build("mac").returncode, 0)
        [older, newer] = self.built("mac")
        self.assertTrue(older.endswith(good[:7]) and newer.endswith(broken[:7]), (older, newer))
        [failed] = [name[len("failed-"):-len(".stamp")] for name in os.listdir(os.path.join(self.batches, "mac"))
                    if name.startswith("failed-") and name.endswith(".stamp")]
        self.assertEqual(sorted([newer, failed, older]), [older, failed, newer], "named in the order they were built")
        opened = self.batch("open", "mac", str(os.getpid()))
        self.assertEqual(opened.returncode, 0, opened.stderr)
        self.assertEqual(opened.stdout.strip(), os.path.join(self.batches, "mac", newer))

    def test_a_second_build_of_a_platform_while_one_runs_is_refused_and_another_platforms_goes_on(self):
        hold = os.path.join(self.root, "hold")
        os.mkfifo(hold)
        first = subprocess.Popen(["/bin/sh", BUILD, "mac"], env=dict(self.env, FAKE_XCODE_HOLD=hold),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            wait_for(hold + ".running", "the first build never started")
            second = self.build("mac")
            self.assertEqual(second.returncode, 75)
            self.assertIn("Another build of the mac batch is running", second.stderr)
            self.assertEqual(self.build("phone").returncode, 0)
        finally:
            release(hold)
            out, err = first.communicate(timeout=60)
        self.assertEqual(first.returncode, 0, err)
        self.assertEqual(len(self.built("mac")), 1, "the refused one made no batch")


class Pruning(Batches):
    def test_the_newest_two_are_kept_and_an_older_one_a_run_has_open_until_its_over(self):
        self.assertEqual(self.build("mac").returncode, 0)
        oldest = self.built("mac")[0]
        # A test run (a process of its own) opens it.
        run = subprocess.Popen(["/bin/sh", "-c", "read x"], stdin=subprocess.PIPE)
        self.addCleanup(run.kill)
        opened = self.batch("open", "mac", str(run.pid))
        self.assertEqual(opened.stdout.strip(), os.path.join(self.batches, "mac", oldest))
        # A build that never finished, left behind.
        os.makedirs(os.path.join(self.batches, "mac", "20000101-000000-abcdef0", "src"))
        self.assertEqual(self.build("mac").returncode, 0)
        done = self.build("mac")
        self.assertEqual(done.returncode, 0)
        self.assertIn("Kept " + oldest, done.stderr)
        built = self.built("mac")
        self.assertEqual(len(built), 3, "the two newest, and the one open")
        self.assertEqual(built[0], oldest)
        # Its run over, the next build deletes it.
        run.communicate(b"\n", timeout=10)
        self.assertEqual(self.build("mac").returncode, 0)
        built = self.built("mac")
        self.assertEqual(len(built), 2)
        self.assertNotIn(oldest, built)

    def test_a_run_opens_the_newest_and_closes_it(self):
        self.assertEqual(self.build("mac").returncode, 0)
        self.assertEqual(self.build("mac").returncode, 0)
        newest = self.built("mac")[-1]
        opened = self.batch("open", "mac", "12345")
        folder = os.path.join(self.batches, "mac", newest)
        self.assertEqual(opened.stdout.strip(), folder)
        self.assertTrue(os.path.exists(os.path.join(folder, "runs", "12345")))
        self.batch("close", folder, "12345")
        self.assertFalse(os.path.exists(os.path.join(folder, "runs", "12345")))


class CompileOnly(Batches):
    def test_the_compile_check_keeps_one_folder_and_rewrites_only_what_changed(self):
        done = self.build("--compile-only", "mac")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("compiles for the mac", done.stdout)
        src = os.path.join(self.batches, "compile", "src", "kuvo-ai")
        kept, changed = os.path.join(src, "KuvoCodeTests", "WindowTabsTests.swift"), os.path.join(src, "KuvoCode", "App.swift")
        old = os.stat(kept).st_mtime_ns
        os.utime(changed, ns=(1, 1))
        write(os.path.join(self.mac, "KuvoCode/App.swift"), "struct App { var later = 1 }\n")
        os.remove(os.path.join(self.mac, "Gone.txt"))
        git(self.mac, "commit", "-qam", "Later")
        done = self.build("--compile-only", "mac")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(os.stat(kept).st_mtime_ns, old, "a file that's the same isn't written again")
        self.assertEqual(read(changed), "struct App { var later = 1 }\n")
        self.assertNotEqual(os.stat(changed).st_mtime_ns, 1)
        self.assertFalse(os.path.exists(os.path.join(src, "Gone.txt")))
        # One folder for every check, and no batch.
        self.assertEqual(self.xcode_said().count("-derivedDataPath " + os.path.join(self.batches, "compile", "mac-build")), 2)
        self.assertEqual(self.built("mac"), [])
        self.assertTrue(read(os.path.join(self.batches, "compile", "mac.last")).startswith("compiles " + git(self.mac, "rev-parse", "main")))
        # The checkout itself is untouched.
        self.assertEqual(git(self.mac, "status", "--porcelain"), "")

    def test_a_compile_that_fails_says_so(self):
        done = self.build("--compile-only", "phone", FAKE_XCODE_FAIL="1")
        self.assertEqual(done.returncode, 1)
        self.assertIn("doesn't compile for the phone", done.stderr)
        self.assertTrue(read(os.path.join(self.batches, "compile", "phone.last")).startswith("failed "))


@unittest.skipUnless(os.path.exists("/dev/console") and os.stat("/dev/console").st_uid == os.getuid(),
                     "the app's tests need this account on the Mac's screen")
class FromBatch(Batches):
    """scripts/test-app.sh --from-batch, all the way to the xcodebuild stand-in: in a home folder of
    its own, with temporary and cache folders of its own (a getconf stand-in), so nothing of the
    real test copy's, nor the real runs' lock, is touched."""

    def env_for(self, only, **extra):
        env = dict(self.env, HOME=os.path.join(self.root, "home"), TMPDIR=os.path.join(self.root, "tmp") + "/", **extra)
        if only is not None:
            env["ONLY"] = only
        return env

    def run_tests(self, only, *args, **extra):
        return subprocess.run(["/bin/sh", TEST_APP, *args], env=self.env_for(only, **extra), cwd=self.mac,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)

    def start_tests(self, only, **extra):
        return subprocess.Popen(["/bin/sh", TEST_APP, "--from-batch"], env=self.env_for(only, **extra), cwd=self.mac,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def start_tests_said_to(self, only, said):
        """A run whose stderr goes to the file `said`, to see what it says as it goes."""
        with open(said, "w") as err:
            return subprocess.Popen(["/bin/sh", TEST_APP, "--from-batch"], env=self.env_for(only), cwd=self.mac,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=err, text=True)

    def runs(self, name):
        folder = os.path.join(self.batches, "mac", name, "runs")
        return os.listdir(folder) if os.path.isdir(folder) else []

    def test_a_run_tests_the_newest_batch_without_building_and_prints_its_stamp(self):
        self.assertEqual(self.build("mac").returncode, 0)
        self.assertEqual(self.build("mac").returncode, 0)
        name = self.built("mac")[-1]
        stamp = self.stamp("mac", name)
        done = self.run_tests("KuvoCodeTests/WindowTabsTests KuvoCodeTests/WorkQueueTests", "--from-batch")
        self.assertEqual(done.returncode, 0, done.stderr)
        said = self.xcode_said()
        self.assertEqual(said.count("build-for-testing"), 2, "only the batches were built")
        self.assertIn("test-without-building -xctestrun " + stamp["xctestrun"] + " -destination platform=macOS", said)
        self.assertIn("-only-testing:KuvoCodeTests/WindowTabsTests -only-testing:KuvoCodeTests/WorkQueueTests", said)
        # The tests that read the sources read the batch's, as its stamp says.
        self.assertEqual(stamp["kuvo_ai_src"], os.path.join(self.batches, "mac", name, "src", "kuvo-ai"))
        self.assertIn("source root: " + stamp["kuvo_ai_src"] + "\n", said)
        self.assertIn("Tested the batch " + name + ":", done.stdout)
        self.assertIn("kuvo_ai=" + stamp["kuvo_ai"], done.stdout)
        self.assertIn("xctestrun=" + stamp["xctestrun"], done.stdout)
        self.assertEqual(self.runs(name), [], "it closed the batch")

    def test_the_tests_read_the_sources_the_stamp_names(self):
        self.assertEqual(self.build("mac").returncode, 0)
        name = self.built("mac")[0]
        elsewhere = os.path.join(self.root, "sources-elsewhere")
        shutil.copytree(os.path.join(self.batches, "mac", name, "src", "kuvo-ai"), elsewhere)
        stamp = os.path.join(self.batches, "mac", name, "stamp")
        write(stamp, "".join(("kuvo_ai_src=" + elsewhere if line.startswith("kuvo_ai_src=") else line) + "\n"
                             for line in read(stamp).splitlines()))
        done = self.run_tests("KuvoCodeTests/WindowTabsTests", "--from-batch")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("source root: " + elsewhere + "\n", self.xcode_said())

    def test_a_run_that_builds_gives_the_tests_its_own_checkout(self):
        done = self.run_tests("KuvoCodeTests/HeldMenuGuardTests")
        self.assertEqual(done.returncode, 0, done.stderr)
        said = self.xcode_said()
        self.assertIn("test -project KuvoCode.xcodeproj", said)
        self.assertIn("source root: " + str(SCRIPTS.parent) + "\n", said)

    def test_a_batch_whose_stamp_names_no_sources_gives_the_tests_its_exported_ones(self):
        self.assertEqual(self.build("mac").returncode, 0)
        name = self.built("mac")[0]
        stamp = os.path.join(self.batches, "mac", name, "stamp")
        write(stamp, "".join(line + "\n" for line in read(stamp).splitlines() if not line.startswith("kuvo_ai_src=")))
        done = self.run_tests("KuvoCodeTests/WindowTabsTests", "--from-batch")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("source root: " + os.path.join(self.batches, "mac", name, "src", "kuvo-ai") + "\n", self.xcode_said())

    def test_a_batch_a_run_has_open_is_kept_while_it_waits_or_runs(self):
        self.assertEqual(self.build("mac").returncode, 0)
        name = self.built("mac")[0]
        hold = os.path.join(self.root, "hold")
        os.mkfifo(hold)
        run = self.start_tests("KuvoCodeTests/WindowTabsTests", FAKE_XCODE_TEST_HOLD=hold)
        try:
            wait_for(hold + ".running", "the run never started its tests")
            for _ in range(3):
                done = self.build("mac")
                self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("Kept " + name, done.stderr)
            self.assertIn(name, self.built("mac"))
        finally:
            release(hold)
            out, err = run.communicate(timeout=60)
        self.assertEqual(run.returncode, 0, err)
        self.assertIn("Tested the batch " + name, out)
        self.assertEqual(self.runs(name), [])
        self.assertEqual(self.build("mac").returncode, 0)
        self.assertNotIn(name, self.built("mac"), "once it's over, the next build deletes it")

    def test_a_run_inside_a_job_that_holds_the_turn_and_the_runs_lock_closes_its_batch_too(self):
        self.assertEqual(self.build("mac").returncode, 0)
        name = self.built("mac")[0]
        # Inside heavy.sh's mac job, and holding the app tests' own lock: it runs on as it is.
        lock = os.path.join(self.env["FAKE_TEMP_DIR"], f"kuvo-code-tests-{os.getuid()}.lock")
        done = subprocess.run(["lockf", "-k", lock, self.env["KUVO_HEAVY_SH"], "mac", "/bin/sh", TEST_APP, "--from-batch"],
                              env=self.env_for("KuvoCodeTests/WindowTabsTests", KUVO_TESTS_LOCK=lock),
                              cwd=self.mac, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("test-without-building", self.xcode_said())
        self.assertNotIn("rm:", done.stderr)
        self.assertEqual(self.runs(name), [])

    def test_a_run_where_no_test_ran_fails(self):
        self.assertEqual(self.build("mac").returncode, 0)
        done = self.run_tests("KuvoCodeTests/WindowTabsTests", "--from-batch", FAKE_XCODE_NO_TESTS="1")
        self.assertEqual(done.returncode, 1)
        self.assertIn("No tests ran", done.stderr)

    def test_a_run_started_while_a_batch_is_built_waits_for_it_and_tests_that_one(self):
        self.assertEqual(self.build("mac").returncode, 0)
        older = self.built("mac")[0]
        write(os.path.join(self.mac, "KuvoCode/App.swift"), "struct App { var later = 1 }\n")
        git(self.mac, "commit", "-qam", "Later")
        hold = os.path.join(self.root, "hold")
        os.mkfifo(hold)
        build = subprocess.Popen(["/bin/sh", BUILD, "mac"], env=dict(self.env, FAKE_XCODE_HOLD=hold),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            wait_for(hold + ".running", "the build never started")
            said = os.path.join(self.root, "said")
            run = self.start_tests_said_to("KuvoCodeTests/WindowTabsTests", said)
            wait_for(said, "the run never waited for the build", "Waiting for the mac batch being built now")
            self.assertNotIn("test-without-building", self.xcode_said())
        finally:
            release(hold)
            build.communicate(timeout=60)
        out, _ = run.communicate(timeout=60)
        self.assertEqual(run.returncode, 0, read(said))
        newer = [name for name in self.built("mac") if name != older][0]
        self.assertIn("-xctestrun " + self.stamp("mac", newer)["xctestrun"], self.xcode_said())
        self.assertIn("Tested the batch " + newer, out)

    def test_when_the_newest_batch_failed_a_run_refuses_saying_which_commit_and_why(self):
        self.assertEqual(self.build("mac").returncode, 0)
        write(os.path.join(self.mac, "KuvoCode/App.swift"), "struct App { var broken }\n")
        git(self.mac, "commit", "-qam", "Breaks it")
        broken = git(self.mac, "rev-parse", "main")
        self.assertEqual(self.build("mac", FAKE_XCODE_FAIL="1").returncode, 1)
        done = self.run_tests("KuvoCodeTests/WindowTabsTests", "--from-batch")
        self.assertEqual(done.returncode, 1)
        self.assertIn("The newest mac batch didn't build: kuvo-ai " + broken[:9] + " “Breaks it”", done.stderr)
        self.assertIn("error: it doesn't compile", done.stderr)
        self.assertIn("failed-", done.stderr)
        self.assertNotIn("test-without-building", self.xcode_said(), "never the older batch")
        # Fixed and built, it tests again.
        self.assertEqual(self.build("mac").returncode, 0)
        self.assertEqual(self.run_tests("KuvoCodeTests/WindowTabsTests", "--from-batch").returncode, 0)

    def test_a_run_waiting_for_a_build_that_is_stopped_refuses_rather_than_test_the_older_batch(self):
        self.assertEqual(self.build("mac").returncode, 0)
        hold = os.path.join(self.root, "hold")
        os.mkfifo(hold)
        build = subprocess.Popen(["/bin/sh", BUILD, "mac"], env=dict(self.env, FAKE_XCODE_HOLD=hold), start_new_session=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            wait_for(hold + ".running", "the build never started")
            said = os.path.join(self.root, "said")
            run = self.start_tests_said_to("KuvoCodeTests/WindowTabsTests", said)
            wait_for(said, "the run never waited for the build", "Waiting for the mac batch being built now")
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
        run.communicate(timeout=60)
        self.assertEqual(run.returncode, 1)
        # (Its failed stamp, or its folder still there as it looked: either way it says so.)
        self.assertIn("stopped before it was built", read(said))
        self.assertNotIn("test-without-building", self.xcode_said(), "never the older batch")
        self.assertEqual(len(self.built("mac")), 1, "it left no batch behind")

    def test_when_the_newest_build_stopped_before_it_was_built_a_run_refuses(self):
        self.assertEqual(self.build("mac").returncode, 0)
        # (Killed outright, it couldn't say so: its folder without a stamp is what's left.)
        os.makedirs(os.path.join(self.batches, "mac", "29991231-000000-abcdef0", "src"))
        done = self.run_tests("KuvoCodeTests/WindowTabsTests", "--from-batch")
        self.assertEqual(done.returncode, 1)
        self.assertIn("29991231-000000-abcdef0, stopped before it was built", done.stderr)

    def test_tests_the_batch_hasnt_are_refused_before_it_waits_in_line(self):
        self.assertEqual(self.build("mac").returncode, 0)
        name = self.built("mac")[0]
        for only in ["KuvoCodeTests/NewerTests", "KuvoCodeTests/WindowTabsTests KuvoCodeTests/NewerTests",
                     "KuvoCodeTests/WindowTabsTests/aNewerTest()", "SomeOtherTests", "KuvoCodeTests/Window.*",
                     "KuvoCodeTests/Outer/Missing"]:
            with self.subTest(only=only):
                done = self.run_tests(only, "--from-batch")
                self.assertEqual(done.returncode, 1, done.stderr)
                self.assertIn("Not in the batch " + name, done.stderr)
                self.assertIn(only.split()[-1], done.stderr)
                self.assertIn("next batch", done.stderr)
        self.assertEqual(self.xcode_said().count("test-without-building"), 0)
        self.assertFalse(os.path.exists(os.path.join(self.env["KUVO_HEAVY_DIR"], f"kuvo-code-heavy-mac-{os.getuid()}.queue")), "it never queued")
        self.assertEqual(self.runs(name), [], "and it closed the batch")

    def test_the_batchs_tests_pass_the_check(self):
        self.assertEqual(self.build("mac").returncode, 0)
        folder = os.path.join(self.batches, "mac", self.built("mac")[0])
        for only in [["KuvoCodeTests"], ["KuvoCodeTests/WindowTabsTests", "KuvoCodeTests/WorkQueueTests"],
                     ["KuvoCodeTests/WindowTabsTests/opensATab()"], ["KuvoCodeTests/WorkQueueTests/testAdds"],
                     ["KuvoCodeTests/Outer/Inner"], ["KuvoCodeTests/Outer/Inner/deep()"], ["KuvoCodeTests/freeTest()"]]:
            with self.subTest(only=only):
                done = self.batch("check", folder, "kuvo-ai", *only)
                self.assertEqual(done.returncode, 0, done.stderr)

    def test_without_only_or_a_batch_it_says_what_it_needs(self):
        done = self.run_tests(None, "--from-batch")
        self.assertEqual(done.returncode, 64)
        self.assertIn("ONLY", done.stderr)
        done = self.run_tests("KuvoCodeTests/WindowTabsTests", "--from-batch")
        self.assertEqual(done.returncode, 1)
        self.assertIn("There's no mac batch yet", done.stderr)
        done = self.run_tests("KuvoCodeTests/WindowTabsTests", "--something")
        self.assertEqual(done.returncode, 64)

    def test_it_says_when_the_callers_head_isnt_in_the_batch(self):
        self.assertEqual(self.build("mac").returncode, 0)
        folder = os.path.join(self.batches, "mac", self.built("mac")[0])
        self.assertEqual(self.batch("behind", folder, "kuvo-ai", self.mac).stderr, "")
        write(os.path.join(self.mac, "KuvoCode/App.swift"), "struct App { var mine = 1 }\n")
        git(self.mac, "commit", "-qam", "Mine")
        said = self.batch("behind", folder, "kuvo-ai", self.mac).stderr
        self.assertIn("isn't in this batch", said)


if __name__ == "__main__":
    unittest.main()
