"""The batches (scripts/batch-build.sh, scripts/batch.sh, scripts/test-app.sh --from-batch): a build of
main is made once, in a folder of its own with its stamp, the newest two kept and older ones deleted
once no test run has them open; two builds of one platform never run at once; a run from a batch
refuses tests the batch hasn't; and the compile check brings its one kept folder to main file by
file.

Each test has a folder of its own: stand-in checkouts (git repositories in it), the batches
(KUVO_BATCH_DIR), heavy.sh's locks (KUVO_HEAVY_DIR) and an xcodebuild stand-in first on PATH, which
makes what a build would and says what it was asked.

    cd scripts && python3 -m unittest test_batch
"""
import os
import shutil
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
            "Gone.txt": "removed in the next commit\n",
        })
        self.phone = self.repo("kuvo-code-ios", {
            "KuvoCodeMobileTests/PairingTests.swift": "@Suite struct PairingTests {}\n",
        })
        bin_folder = os.path.join(self.root, "bin")
        write(os.path.join(bin_folder, "xcodebuild"), XCODEBUILD)
        os.chmod(os.path.join(bin_folder, "xcodebuild"), 0o755)
        self.xcode_log = os.path.join(self.root, "xcodebuild.log")
        env = without_background_priority(dict(clean_environment(), KUVO_HEAVY_DIR=os.path.join(self.root, "locks"),
                                               KUVO_HEAVY_LOAD="1000", KUVO_HEAVY_MEMORY="0", KUVO_HEAVY_OLD_UNTIL="20000101",
                                               KUVO_XCODE_CACHE="0"))
        os.makedirs(env["KUVO_HEAVY_DIR"])
        self.env = dict(env, PATH=bin_folder + os.pathsep + env["PATH"], KUVO_BATCH_DIR=self.batches,
                        KUVO_BATCH_MAC_REPO=self.mac, KUVO_BATCH_PHONE_REPO=self.phone,
                        KUVO_HEAVY_SH=str(SCRIPTS / "heavy.sh"), FAKE_XCODE_LOG=self.xcode_log)

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
        logs = [name for name in os.listdir(os.path.join(self.batches, "mac")) if name.startswith("failed-")]
        self.assertEqual(len(logs), 1)
        self.assertIn(logs[0], done.stderr)
        # And no batch to test from.
        opened = self.batch("open", "mac", str(os.getpid()))
        self.assertEqual(opened.returncode, 1)
        self.assertIn("There's no mac batch yet", opened.stderr)

    def test_a_second_build_of_a_platform_while_one_runs_is_refused_and_another_platforms_goes_on(self):
        hold = os.path.join(self.root, "hold")
        os.mkfifo(hold)
        first = subprocess.Popen(["/bin/sh", BUILD, "mac"], env=dict(self.env, FAKE_XCODE_HOLD=hold),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.time() + 30
            while not os.path.exists(hold + ".running"):
                self.assertLess(time.time(), deadline, "the first build never started")
                time.sleep(0.1)
            second = self.build("mac")
            self.assertEqual(second.returncode, 75)
            self.assertIn("Another build of the mac batch is running", second.stderr)
            self.assertEqual(self.build("phone").returncode, 0)
        finally:
            with open(hold, "w") as go:
                go.write("go\n")
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
    """scripts/test-app.sh --from-batch, up to where it would wait in line: it refuses before that.
    In a home folder of its own, so nothing of the real test copy's is touched."""

    def run_tests(self, only, *args):
        env = dict(self.env, HOME=os.path.join(self.root, "home"), TMPDIR=os.path.join(self.root, "tmp") + "/")
        if only is not None:
            env["ONLY"] = only
        os.makedirs(env["TMPDIR"], exist_ok=True)
        return subprocess.run(["/bin/sh", TEST_APP, *args], env=env, cwd=self.mac, capture_output=True, text=True, timeout=60)

    def test_tests_the_batch_hasnt_are_refused_before_it_waits_in_line(self):
        self.assertEqual(self.build("mac").returncode, 0)
        name = self.built("mac")[0]
        for only in ["KuvoCodeTests/NewerTests", "KuvoCodeTests/WindowTabsTests KuvoCodeTests/NewerTests",
                     "KuvoCodeTests/WindowTabsTests/aNewerTest()", "SomeOtherTests", "KuvoCodeTests/Window.*"]:
            with self.subTest(only=only):
                done = self.run_tests(only, "--from-batch")
                self.assertEqual(done.returncode, 1, done.stderr)
                self.assertIn("Not in the batch " + name, done.stderr)
                self.assertIn(only.split()[-1], done.stderr)
                self.assertIn("next batch", done.stderr)
        self.assertEqual(self.xcode_said().count("test-without-building"), 0)
        self.assertFalse(os.path.exists(os.path.join(self.env["KUVO_HEAVY_DIR"], f"kuvo-code-heavy-mac-{os.getuid()}.queue")), "it never queued")
        self.assertEqual(os.listdir(os.path.join(self.batches, "mac", name, "runs")), [], "and it closed the batch")

    def test_the_batchs_tests_pass_the_check(self):
        self.assertEqual(self.build("mac").returncode, 0)
        folder = os.path.join(self.batches, "mac", self.built("mac")[0])
        for only in [["KuvoCodeTests"], ["KuvoCodeTests/WindowTabsTests", "KuvoCodeTests/WorkQueueTests"],
                     ["KuvoCodeTests/WindowTabsTests/opensATab()"], ["KuvoCodeTests/WorkQueueTests/testAdds"]]:
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
