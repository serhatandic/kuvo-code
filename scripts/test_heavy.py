"""scripts/heavy.sh: jobs of different kinds run together, two of one kind queue, a job started the
old way (under the one lock for every kind) holds up every kind, and a busy Mac holds a job back.
Each test has locks of its own (KUVO_HEAVY_DIR), and asks with KUVO_HEAVY_WAIT=0, which says what a
job would wait for instead of waiting."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HEAVY = str(Path(__file__).with_name("heavy.sh"))
WAITS = 75


class Held:
    """A job that holds a lock until it's let go: started, it says it's running through a pipe,
    then waits on another."""

    def __init__(self, command, env):
        folder = tempfile.mkdtemp()
        self.running, self.go = os.path.join(folder, "running"), os.path.join(folder, "go")
        os.mkfifo(self.running)
        os.mkfifo(self.go)
        script = f'echo yes > "{self.running}"; read x < "{self.go}"'
        self.process = subprocess.Popen(command + ["/bin/sh", "-c", script], env=env)
        with open(self.running) as running:
            running.read()

    def let_go(self):
        with open(self.go, "w") as go:
            go.write("go\n")
        self.process.wait(timeout=30)


class HeavyTests(unittest.TestCase):
    def setUp(self):
        self.locks = tempfile.mkdtemp()
        self.env = dict(os.environ, KUVO_HEAVY_DIR=self.locks, KUVO_HEAVY_LOAD="1000")

    def run_heavy(self, kind, *command, **env):
        result = subprocess.run([HEAVY, kind, *command], env=dict(self.env, KUVO_HEAVY_WAIT="0", **env), capture_output=True, text=True, timeout=30)
        return result.returncode, result.stderr

    def test_kinds_run_together_and_one_kind_queues(self):
        mac = Held([HEAVY, "mac"], self.env)
        try:
            self.assertEqual(self.run_heavy("phone", "true")[0], 0)
            self.assertEqual(self.run_heavy("box", "true")[0], 0)
            code, said = self.run_heavy("mac", "true")
            self.assertEqual(code, WAITS)
            self.assertIn("Another mac job is running", said)
        finally:
            mac.let_go()
        self.assertEqual(self.run_heavy("mac", "true")[0], 0)

    def test_a_job_inside_its_kinds_job_runs_at_once(self):
        nested = f'KUVO_HEAVY_WAIT=0 "{HEAVY}" mac true'
        result = subprocess.run([HEAVY, "mac", "/bin/sh", "-c", nested], env=self.env, timeout=30)
        self.assertEqual(result.returncode, 0)

    def test_a_script_can_ask_whether_its_kinds_turn_is_held(self):
        holds = lambda *command: subprocess.run(command, env=self.env, timeout=30).returncode
        self.assertEqual(holds(HEAVY, "--holds", "mac"), 1)
        self.assertEqual(holds(HEAVY, "mac", HEAVY, "--holds", "mac"), 0)
        self.assertEqual(holds(HEAVY, "phone", HEAVY, "--holds", "mac"), 1)

    def test_a_job_started_the_old_way_holds_up_every_kind(self):
        old = os.path.join(self.locks, f"kuvo-code-heavy-{os.getuid()}.lock")
        job = Held(["lockf", "-k", old], self.env)
        try:
            for kind in ("mac", "phone", "box"):
                code, said = self.run_heavy(kind, "true")
                self.assertEqual(code, WAITS, kind)
                self.assertIn("started the old way", said)
        finally:
            job.let_go()
        # Once the old lock's day is over, it holds nothing up.
        job = Held(["lockf", "-k", old], self.env)
        try:
            self.assertEqual(self.run_heavy("mac", "true", KUVO_HEAVY_OLD_UNTIL="20000101")[0], 0)
        finally:
            job.let_go()
        # One run inside it (its test-app.sh) goes on at once.
        inside = subprocess.run(["lockf", "-k", old, HEAVY, "mac", "true"], env=dict(self.env, KUVO_HEAVY_WAIT="0"), timeout=30)
        self.assertEqual(inside.returncode, 0)

    def test_a_busy_mac_holds_a_job_back(self):
        code, said = self.run_heavy("box", "true", KUVO_HEAVY_LOAD="-1")
        self.assertEqual(code, WAITS)
        self.assertIn("The Mac is busy", said)
        self.assertEqual(self.run_heavy("box", "true", KUVO_HEAVY_LOAD="1000")[0], 0)

    def test_its_command_runs_with_its_arguments_and_answer(self):
        result = subprocess.run([HEAVY, "box", "/bin/sh", "-c", 'echo "$1"; exit 3', "sh", "a b"], env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual((result.returncode, result.stdout), (3, "a b\n"))

    def test_an_unknown_kind_says_how_its_used(self):
        result = subprocess.run([HEAVY, "watch", "true"], env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 64)
        self.assertIn("Usage", result.stderr)


if __name__ == "__main__":
    unittest.main()
