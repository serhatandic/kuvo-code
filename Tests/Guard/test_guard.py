"""Nothing that starts a copy of Kuvo Code or its engine for a test, a demo or a measurement may use
the real app: each script, given the real app's bundle ID, folder or engine, stops before it starts
anything and names itself; given a copy's own, it goes on.

Each test runs in a home folder of its own (the real app's folder made there, with a stand-in engine
in it), with stand-ins first on PATH for every tool that would start, quit or build something, so a
guard that let something through still never touches this Mac's apps.

    python3 -m unittest discover -s Tests/Guard
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GUARD = os.path.join(REPO, "scripts", "real-app-guard.sh")
TOOLS = ["xcodebuild", "open", "osascript", "pkill", "pgrep", "kill", "defaults", "gh", "hdiutil", "swiftc"]


class Home:
    """A home folder of its own: the real app's folder in it, with an engine, and a perf copy's."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="kuvo-guard-")
        self.home = os.path.join(self.root, "home")
        support = os.path.join(self.home, "Library", "Application Support")
        self.real = os.path.join(support, "run.kuvo.code")
        self.real_engine = os.path.join(self.real, "engine", "2.0.32", "opencode")
        self.copy_engine = os.path.join(support, "run.kuvo.code.perf", "engine", "2.0.32", "opencode")
        self.tmp = os.path.join(self.root, "tmp")
        self.bin = os.path.join(self.root, "bin")
        for folder in [os.path.dirname(self.real_engine), os.path.dirname(self.copy_engine), self.tmp, self.bin]:
            os.makedirs(folder)
        # Engines and tools that fail at once and say they ran, should a guard let them through.
        self.ran = os.path.join(self.root, "ran.txt")
        for path in [self.real_engine, self.copy_engine] + [os.path.join(self.bin, tool) for tool in TOOLS]:
            with open(path, "w") as f:
                f.write('#!/bin/sh\necho "$0 $*" >> "%s"\nexit 99\n' % self.ran)
            os.chmod(path, 0o755)

    def env(self, **extra):
        env = {"HOME": self.home, "TMPDIR": self.tmp + "/", "PATH": self.bin + ":/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"}
        env.update(extra)
        return env

    def what_ran(self):
        if not os.path.exists(self.ran):
            return ""
        with open(self.ran) as f:
            return f.read()

    def remove(self):
        shutil.rmtree(self.root, ignore_errors=True)


class Case(unittest.TestCase):
    def setUp(self):
        self.box = Home()
        self.addCleanup(self.box.remove)

    def run_script(self, command, **extra):
        return subprocess.run(command, cwd=REPO, env=self.box.env(**extra), stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=60)

    def assertRefused(self, done, caller):
        self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn(caller + ": refusing to start", done.stderr)
        self.assertEqual(self.box.what_ran(), "", "nothing started before it stopped")


class TheRule(Case):
    """What counts as the real app's, and what's a copy's own."""

    def check(self, *values):
        return self.run_script(["sh", GUARD, "the caller"] + list(values))

    def test_the_real_apps_bundle_id_folder_engine_and_app_are_refused(self):
        for value in ["run.kuvo.code", "Run.Kuvo.Code", self.box.real, self.box.real + "/", self.box.real_engine,
                      self.box.real + "/../run.kuvo.code/engine", "/Applications/Kuvo Code.app",
                      "/Applications/Kuvo Code.app/Contents/MacOS/Kuvo Code", ".kuvo-code", "~/.kuvo-code", "/home/someone/.kuvo-code"]:
            with self.subTest(value=value):
                self.assertRefused(self.check("run.kuvo.code.perf", value), "the caller")

    def test_a_link_to_the_real_engine_is_refused(self):
        link = os.path.join(self.box.root, "engine-link")
        os.symlink(self.box.real_engine, link)
        self.assertRefused(self.check(link), "the caller")

    def test_copies_of_their_own_go_on(self):
        for value in ["run.kuvo.code.demo", "run.kuvo.code.tests", "run.kuvo.code.perf", "run.kuvo.code.e2e",
                      "run.kuvo.code.shots", self.box.copy_engine, os.path.dirname(self.box.real) + "/run.kuvo.code.perf",
                      "", "1", "/Applications/Kuvo Code Beta.app", ".kuvo-code-perf", ".kuvo-code-demo"]:
            with self.subTest(value=value):
                done = self.check(value)
                self.assertEqual(done.returncode, 0, done.stderr)


class TheScripts(Case):
    """Each script that starts a copy or its engine, given the real app's."""

    def test_the_app_tests_never_run_with_the_real_engine(self):
        done = self.run_script(["sh", "scripts/test-app.sh"], KUVO_TEST_BUN=self.box.real_engine)
        self.assertRefused(done, "scripts/test-app.sh")

    def test_the_app_tests_go_on_with_a_copys_engine(self):
        done = self.run_script(["sh", "scripts/test-app.sh"], KUVO_TEST_BUN=self.box.copy_engine)
        self.assertNotIn("refusing", done.stderr)
        self.assertIn("xcodebuild test", self.box.what_ran(), "it went on to build (a stand-in here)")

    def test_the_bun_the_scripts_fall_back_to_is_a_copys_newest_engine(self):
        support = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(self.box.copy_engine))))
        for copy, version in [("run.kuvo.code.demo", "2.0.9"), ("run.kuvo.code.e2e", "2.0.10")]:
            engine = os.path.join(support, copy, "engine", version, "opencode")
            os.makedirs(os.path.dirname(engine))
            open(engine, "w").close()
        # The real app's is newer still, and never chosen.
        newer = os.path.join(self.box.real, "engine", "9.9.9", "opencode")
        os.makedirs(os.path.dirname(newer))
        open(newer, "w").close()
        done = self.run_script(["sh", "-c", ". scripts/real-app-guard.sh; newest_copy_engine"])
        self.assertEqual(done.stdout.strip(), self.box.copy_engine, "2.0.32 after 2.0.10 and 2.0.9, and not the real app's")

    def test_the_perf_copy_reuses_its_newest_engine(self):
        perf = self.load("Tests/Perf/kuvo_perf.py")
        perf.ENGINES = os.path.join(self.box.root, "kept")
        for version in ["2.0.9", "2.0.32", "2.0.10"]:
            os.makedirs(os.path.join(perf.ENGINES, version))
            open(os.path.join(perf.ENGINES, version, "opencode"), "w").close()
        os.environ.pop("KUVO_PERF_ENGINE", None)
        self.assertEqual(perf.engine(), os.path.join(perf.ENGINES, "2.0.32", "opencode"))

    def test_the_agents_bridge_is_never_built_with_the_real_engine(self):
        done = self.run_script(["sh", "scripts/build-agents.sh"], BUN=self.box.real_engine)
        self.assertRefused(done, "scripts/build-agents.sh")

    def test_the_rehearsal_never_works_on_the_real_app_without_someone_at_the_terminal(self):
        for step in ["prepare", "save", "fresh", "open", "restore"]:
            with self.subTest(step=step):
                done = self.run_script(["sh", "scripts/groups-rehearsal.sh", step, "this"])
                self.assertRefused(done, "scripts/groups-rehearsal.sh " + step)

    def test_every_perf_mode_refuses_the_real_engine(self):
        for mode in ["build", "record", "bench", "groups", "clean"]:
            with self.subTest(mode=mode):
                # Only the mode named: past the guard, each would stop at its usage, starting nothing.
                done = self.run_script([sys.executable, "-I", "Tests/Perf/kuvo_perf.py", mode], KUVO_PERF_ENGINE=self.box.real_engine)
                self.assertRefused(done, "kuvo_perf.py " + mode)

    def test_the_perf_copy_is_never_launched_as_the_real_app(self):
        perf = self.load("Tests/Perf/kuvo_perf.py")
        app = self.app("run.kuvo.code")
        with self.assertRaises(SystemExit):
            perf.launch(app, KUVO_DEMO_GROUP_REPLAY="setup")
        self.assertEqual(self.box.what_ran(), "")

    def test_the_perf_copy_is_never_launched_with_the_real_engine(self):
        perf = self.load("Tests/Perf/kuvo_perf.py")
        with self.assertRaises(SystemExit):
            perf.launch(self.app("run.kuvo.code.perf"), KUVO_OPENCODE_BINARY=self.box.real_engine)
        self.assertEqual(self.box.what_ran(), "")

    def test_the_e2e_copy_is_never_launched_with_the_real_engine(self):
        e2e = self.load("Tests/E2E/kuvo_e2e.py")
        with self.assertRaises(SystemExit):
            e2e.App(None).launch(KUVO_OPENCODE_BINARY=self.box.real_engine)
        self.assertEqual(self.box.what_ran(), "")

    # A script loaded as a module, in this test's home with its stand-in tools; what would start
    # or quit an app fails the test if it's reached.
    def load(self, path):
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        os.environ.update(self.box.env())
        spec = importlib.util.spec_from_file_location("guarded_" + os.path.basename(path)[:-3], os.path.join(REPO, path))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        def reached(*args, **kwargs):
            self.fail("got past the guard: %s" % (args,))
        module.sh = reached
        if hasattr(module, "quit_app"):
            module.quit_app = reached
        if hasattr(module, "App"):
            module.App.quit = reached
        return module

    def app(self, bundle_id):
        import plistlib
        app = os.path.join(self.box.root, bundle_id, "Kuvo Code.app")
        os.makedirs(os.path.join(app, "Contents"))
        with open(os.path.join(app, "Contents", "Info.plist"), "wb") as f:
            plistlib.dump({"CFBundleIdentifier": bundle_id}, f)
        return app


if __name__ == "__main__":
    unittest.main()
