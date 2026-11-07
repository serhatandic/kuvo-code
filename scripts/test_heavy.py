"""scripts/heavy.sh: jobs of different kinds run together, two of one kind queue, a job started the
old way (under the one lock for every kind) holds up every kind, and a busy Mac holds a job back.
Each test has locks of its own (KUVO_HEAVY_DIR), and asks with KUVO_HEAVY_WAIT=0, which says what a
job would wait for instead of waiting."""
import os
import select
import shlex
import shutil
import signal
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
        # As from the 29th, when the old single lock is over (the day before, test_the_day_before).
        self.env = dict(os.environ, KUVO_HEAVY_DIR=self.locks, KUVO_HEAVY_LOAD="1000", KUVO_HEAVY_OLD_UNTIL="20000101")

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

    def test_a_second_job_of_a_kind_waits_for_the_first_and_runs_after_it(self):
        first = Held([HEAVY, "box"], self.env)
        second = subprocess.Popen([HEAVY, "box", "/bin/sh", "-c", "echo ran; exit 7"], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertIn("Waiting for another box job", second.stderr.readline())
            self.assertIsNone(second.poll(), "it ran beside the first")
        finally:
            first.let_go()
        out, _ = second.communicate(timeout=30)
        self.assertEqual((second.returncode, out), (7, "ran\n"))

    def test_a_job_inside_its_kinds_job_runs_at_once(self):
        nested = f'KUVO_HEAVY_WAIT=0 "{HEAVY}" mac true'
        result = subprocess.run([HEAVY, "mac", "/bin/sh", "-c", nested], env=self.env, timeout=30)
        self.assertEqual(result.returncode, 0)

    def test_a_script_can_ask_whether_its_kinds_turn_is_held(self):
        holds = lambda *command: subprocess.run(command, env=self.env, timeout=30).returncode
        self.assertEqual(holds(HEAVY, "--holds", "mac"), 1)
        self.assertEqual(holds(HEAVY, "mac", HEAVY, "--holds", "mac"), 0)
        self.assertEqual(holds(HEAVY, "phone", HEAVY, "--holds", "mac"), 1)

    def test_the_day_before_jobs_started_the_old_way_and_these_take_turns(self):
        """Until the 28th, other checkouts start jobs under the old single lock: one of those holds
        up every kind, and one of these holds that lock as it runs, so none starts beside it."""
        transition = dict(self.env, KUVO_HEAVY_OLD_UNTIL="20991231")
        old = os.path.join(self.locks, f"kuvo-code-heavy-{os.getuid()}.lock")
        job = Held(["lockf", "-k", old], transition)
        try:
            for kind in ("mac", "phone", "box"):
                code, said = self.run_heavy(kind, "true", KUVO_HEAVY_OLD_UNTIL="20991231")
                self.assertEqual(code, WAITS, kind)
                self.assertIn("started the old way", said)
        finally:
            job.let_go()
        mac = Held([HEAVY, "mac"], transition)
        try:
            taken = subprocess.run(["lockf", "-ks", "-t", "0", old, "true"], timeout=30)
            self.assertNotEqual(taken.returncode, 0, "an old-style job would start beside it")
        finally:
            mac.let_go()
        # From the 29th, it holds nothing up.
        job = Held(["lockf", "-k", old], self.env)
        try:
            self.assertEqual(self.run_heavy("mac", "true")[0], 0)
        finally:
            job.let_go()
        inside = subprocess.run(["lockf", "-k", old, HEAVY, "mac", "true"], env=dict(transition, KUVO_HEAVY_WAIT="0"), timeout=30)
        self.assertEqual(inside.returncode, 0, "a job inside an old-style one runs at once")

    def refused_ps(self):
        """The environment of an Auto session, where the sandbox refuses `ps`: a stand-in that
        fails, first on PATH."""
        folder = tempfile.mkdtemp()
        stand_in = os.path.join(folder, "ps")
        with open(stand_in, "w") as f:
            f.write("#!/bin/sh\nexit 1\n")
        os.chmod(stand_in, 0o755)
        return dict(self.env, PATH=folder + os.pathsep + os.environ["PATH"])

    def test_without_ps_a_job_runs_and_still_knows_it_holds_its_turn(self):
        env = self.refused_ps()
        result = subprocess.run([HEAVY, "mac", "true"], env=dict(env, KUVO_HEAVY_WAIT="0"), timeout=30)
        self.assertEqual(result.returncode, 0)
        holds = lambda *command: subprocess.run(command, env=env, timeout=30).returncode
        self.assertEqual(holds(HEAVY, "--holds", "mac"), 1)
        self.assertEqual(holds(HEAVY, "mac", HEAVY, "--holds", "mac"), 0)
        self.assertEqual(holds(HEAVY, "phone", HEAVY, "--holds", "mac"), 1)
        nested = f'KUVO_HEAVY_WAIT=0 "{HEAVY}" mac true'
        self.assertEqual(subprocess.run([HEAVY, "mac", "/bin/sh", "-c", nested], env=env, timeout=30).returncode, 0)

    def test_without_ps_a_job_still_waits_for_another_holding_the_lock(self):
        env = self.refused_ps()
        mac = Held([HEAVY, "mac"], env)
        try:
            result = subprocess.run([HEAVY, "mac", "true"], env=dict(env, KUVO_HEAVY_WAIT="0"), capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, WAITS)
            self.assertIn("Another mac job is running", result.stderr)
            # A leftover claim in the environment doesn't get in.
            claim = f"{os.path.join(self.locks, f'kuvo-code-heavy-mac-{os.getuid()}.lock')}:1"
            result = subprocess.run([HEAVY, "mac", "true"], env=dict(env, KUVO_HEAVY_WAIT="0", KUVO_HEAVY_HELD=claim), timeout=30)
            self.assertEqual(result.returncode, WAITS)
        finally:
            mac.let_go()
        self.assertEqual(subprocess.run([HEAVY, "mac", "true"], env=dict(env, KUVO_HEAVY_WAIT="0"), timeout=30).returncode, 0)

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


class StoppingTests(unittest.TestCase):
    """What a job starts ends with it: when the command is over, and when heavy.sh is stopped, any
    way it is. Each test names the pids its own job started and asks about those, never about names."""

    STUBBORN = '(trap "" TERM; exec sleep 300)'  # a child that takes no TERM

    def setUp(self):
        self.locks = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.locks, ignore_errors=True)
        self.env = dict(os.environ, KUVO_HEAVY_DIR=self.locks, KUVO_HEAVY_LOAD="1000", KUVO_HEAVY_OLD_UNTIL="20000101", KUVO_HEAVY_WAIT="0")
        self.pids = []

    def tearDown(self):
        for pid in self.pids:  # a job's child that a failed test never saw gone
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def gone(self, pid, said):
        """That a child of its own job is gone, and so no longer one to clean up. A process that
        has stopped can stay a moment before it's reaped, and still answers `kill -0`: the kernel
        says when it has exited."""
        queue = select.kqueue()
        try:
            exited = queue.control([select.kevent(pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT, select.KQ_NOTE_EXIT)], 1, 10)
        except ProcessLookupError:  # reaped already
            exited = True
        finally:
            queue.close()
        self.assertTrue(exited, said)
        self.pids.remove(pid)

    def fresh(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)
        os.mkfifo(os.path.join(self.folder, "ready"))

    def over(self, process):
        """Waits until all of the job is over. The job's whole tree shares the pipe its output goes
        through, so it reaches its end once the helper, the command and everything the command
        started have stopped (stopping the helper's `lockf` ends that one at once, and the rest a
        moment later, which the lock can't tell: it's let go as `lockf` ends)."""
        while True:
            self.assertTrue(select.select([process.stdout], [], [], 30)[0], "the job didn't end")
            if not os.read(process.stdout.fileno(), 4096):
                process.stdout.close()
                return

    def ready(self):
        """Waits until the job says it's going; a job that never starts times out."""
        fd = os.open(os.path.join(self.folder, "ready"), os.O_RDWR)  # doesn't wait for a writer
        try:
            self.assertTrue(select.select([fd], [], [], 30)[0], "the job didn't start")
        finally:
            os.close(fd)

    def child(self, name):
        with open(os.path.join(self.folder, name)) as f:
            pid = int(f.read())
        self.pids.append(pid)
        return pid

    def start(self, job, kind="box", env=None, child="sleep 300"):
        """Runs `job` (shell) under heavy.sh once it has started a child of its own (`child`, which
        sleeps) and said so. Returns the process and the child's pid."""
        self.fresh()  # folders of their own for each job: one job's leftovers aren't the next one's
        ready, pidfile = (os.path.join(self.folder, name) for name in ("ready", "pid"))
        script = f'{child} & echo $! > "{pidfile}"; echo yes > "{ready}"; {job}'
        process = self.run_job(["/bin/sh", "-c", script], kind, env)
        self.ready()
        return process, self.child("pid")

    def run_job(self, command, kind="box", env=None):
        """In a session of its own, as a harness runs a command, and not under a shell's `&`."""
        return subprocess.Popen([HEAVY, kind, *command], env=env or self.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, start_new_session=True,
                                preexec_fn=lambda: signal.signal(signal.SIGINT, signal.SIG_DFL))

    def test_stopping_it_stops_what_its_command_started(self):
        """Stopped as its caller does: by the pid it started (`lockf` is that process, and ends at
        once; the job finds out and stops its command's group), or the whole group of the call."""
        for how, name, sig in (("pid", "TERM", signal.SIGTERM), ("pid", "HUP", signal.SIGHUP), ("group", "TERM", signal.SIGTERM), ("group", "INT", signal.SIGINT), ("group", "HUP", signal.SIGHUP), ("group", "KILL", signal.SIGKILL), ("pid", "KILL", signal.SIGKILL)):
            with self.subTest(f"{name} to its {how}"):
                process, child = self.start("wait")
                if how == "pid":
                    process.send_signal(sig)
                else:
                    os.killpg(process.pid, sig)
                process.wait(timeout=30)
                self.over(process)
                self.gone(child, "its command's child is still running")

    def test_what_its_command_left_running_ends_with_it(self):
        process, child = self.start("exit 0")
        self.assertEqual(process.wait(timeout=30), 0)
        self.over(process)
        self.gone(child, "a background child of a finished command is still running")

    def test_a_child_that_takes_no_term_is_killed_in_the_end(self):
        process, child = self.start("wait", child=self.STUBBORN)
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=30)
        self.over(process)
        self.gone(child, "a child that ignores TERM is still running")

    def test_its_commands_answer_passes_through(self):
        for code in (0, 3, 70):
            with self.subTest(code):
                process, child = self.start(f"exit {code}")
                self.assertEqual(process.wait(timeout=30), code)
                self.over(process)
                self.gone(child, "a background child of a finished command is still running")

    def test_a_job_started_inside_another_ends_with_it_too(self):
        """Test-app.sh starts the box's suites through heavy.sh of another kind: stopped, both
        jobs' children end, one that takes no TERM too (the outer helper doesn't wait for it)."""
        self.fresh()
        ready, inner_pid = (os.path.join(self.folder, name) for name in ("ready", "inner"))
        inner = f"{self.STUBBORN} & echo $! > '{inner_pid}'; echo yes > '{ready}'; wait"
        process = self.run_job(["/bin/sh", "-c", f'"{HEAVY}" phone /bin/sh -c {shlex.quote(inner)}'])
        self.ready()
        inner_child = self.child("inner")
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=30)
        self.over(process)
        self.gone(inner_child, "the inner job's child is still running")

    def test_the_old_way_lock_changes_nothing(self):
        env = dict(self.env, KUVO_HEAVY_OLD_UNTIL="20991231")
        process, child = self.start("wait", env=env)
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=30)
        self.over(process)
        self.gone(child, "its command's child is still running")


if __name__ == "__main__":
    unittest.main()
