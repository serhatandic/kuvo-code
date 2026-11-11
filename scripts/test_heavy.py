"""scripts/heavy.sh: jobs of different kinds run together, two of one kind queue (two phone jobs that
handle slots run at once, each with a simulator of its own, and two mac-build jobs, each with a build
folder of its own, beside the app suite's mac; the phone's builds, phone-build, take mac-build's slots), a job started the
old way (under the one lock for every kind) holds up every kind, a busy Mac holds a job back, and jobs
waiting for a lane go in line, high-priority ones first, however many come at once.
Each test has locks of its own (KUVO_HEAVY_DIR), and asks with KUVO_HEAVY_WAIT=0, which says what a
job would wait for instead of waiting."""
import atexit
import os
import pty
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HEAVY = str(Path(__file__).with_name("heavy.sh"))
WAITS = 75


def clean_environment():
    """The environment of the run without what a job of heavy.sh leaves in it (a test run from inside
    one would otherwise see that job's turn and slot)."""
    return {k: v for k, v in os.environ.items() if k not in ("KUVO_HEAVY_SLOTS", "KUVO_HEAVY_HELD", "KUVO_HEAVY_HOLDING", "KUVO_HEAVY_SLOT", "KUVO_HEAVY_BUILD_SUFFIX", "KUVO_TEST_SIMULATOR", "KUVO_HEAVY_WAIT", "KUVO_HEAVY_LIMIT", "KUVO_HEAVY_MAC_FIRST_FOR", "KUVO_HEAVY_MEMORY", "KUVO_HEAVY_MEMORY_WAIT_FOR", "KUVO_HEAVY_PRIORITY")}


# Prints what the priority of the process it runs in is: on macOS 1 for the background policy
# (`taskpolicy -b`: getpriority's PRIO_DARWIN_PROCESS), 0 for the default; elsewhere its nice value.
PRIORITY_PROBE = """import os, sys
if sys.platform == "darwin":
    import ctypes
    print(ctypes.CDLL(None).getpriority(4, 0))
else:
    print(os.getpriority(os.PRIO_PROCESS, 0))
"""
PROBE = ["/bin/sh", "-c", 'exec "$0" -S -c "$1"', sys.executable, PRIORITY_PROBE]  # in a child of the job's shell


def is_low(printed):
    """Whether what the probe printed is background priority."""
    value = int(printed.strip().splitlines()[-1])
    return value == 1 if sys.platform == "darwin" else value >= 15


_STAND_IN = None


def without_background_priority(env):
    """`env` with a `taskpolicy` first on PATH that runs the command as it is (and, with FAKE_POLICY_LOG
    set, writes the option it was given there). Jobs run at background priority, which on a Mac under
    heavy load can take minutes for what a test starts in a second: the tests that aren't about the
    policy run the helper's jobs as they are, and the tests of it look at what `taskpolicy` is asked,
    and, once, at the real policy."""
    global _STAND_IN
    if _STAND_IN is None:
        _STAND_IN = tempfile.mkdtemp()
        atexit.register(shutil.rmtree, _STAND_IN, ignore_errors=True)
        path = os.path.join(_STAND_IN, "taskpolicy")
        with open(path, "w") as f:
            f.write('#!/bin/sh\n[ -z "${FAKE_POLICY_LOG-}" ] || echo "$1" >> "$FAKE_POLICY_LOG"\n[ "$1" = -b ] && shift\nexec "$@"\n')
        os.chmod(path, 0o755)
    return dict(env, PATH=_STAND_IN + os.pathsep + env["PATH"])


class Held:
    """A job that holds a lock until it's let go: started, it says it's running through a pipe,
    then waits on another."""

    def __init__(self, command, env):
        folder = tempfile.mkdtemp()
        self.running, self.go = os.path.join(folder, "running"), os.path.join(folder, "go")
        os.mkfifo(self.running)
        os.mkfifo(self.go)
        # What the job sees of its slot, said when it's running.
        script = f'echo "${{KUVO_TEST_SIMULATOR-}}|${{KUVO_HEAVY_SLOT-}}|${{KUVO_HEAVY_BUILD_SUFFIX-}}" > "{self.running}"; read x < "{self.go}"'
        self.process = subprocess.Popen(command + ["/bin/sh", "-c", script], env=env)
        with open(self.running) as running:
            self.seen = running.read().strip()

    def let_go(self):
        with open(self.go, "w") as go:
            go.write("go\n")
        self.process.wait(timeout=30)


class HeavyTests(unittest.TestCase):
    def setUp(self):
        self.locks = tempfile.mkdtemp()
        # As from the 29th, when the old single lock is over (the day before, test_the_day_before).
        self.env = without_background_priority(dict(clean_environment(), KUVO_HEAVY_DIR=self.locks, KUVO_HEAVY_LOAD="1000", KUVO_HEAVY_MEMORY="0", KUVO_HEAVY_OLD_UNTIL="20000101"))

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

    def queued(self, kind, command, **env):
        """A job that waits in line: started, once it says it waits. Stopped with its session at the
        end of the test if it's still there."""
        job = subprocess.Popen([HEAVY, kind, *command], env=dict(self.env, **env), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        def stop():
            if job.poll() is None:
                os.killpg(job.pid, signal.SIGKILL)
            job.wait(timeout=30)
            job.stdout.close()
            job.stderr.close()
        self.addCleanup(stop)
        self.said_waiting(job, kind)
        return job

    def said_waiting(self, job, kind):
        self.assertTrue(select.select([job.stderr], [], [], 30)[0], "it said nothing")
        self.assertIn(f"Waiting for another {kind} job", job.stderr.readline())

    def queue(self, kind="box"):
        folder = os.path.join(self.locks, f"kuvo-code-heavy-{kind}-{os.getuid()}.queue")
        os.makedirs(folder, exist_ok=True)
        return folder

    def test_a_high_priority_job_goes_before_the_normal_ones_waiting_and_each_priority_keeps_its_order(self):
        first = Held([HEAVY, "box"], self.env)
        output = os.path.join(self.locks, "order")
        jobs = []
        try:
            for name, priority in (("normal1", "normal"), ("high1", "high"), ("normal2", "normal"), ("high2", "high")):
                jobs.append(self.queued("box", ["/bin/sh", "-c", f"echo {name} >> '{output}'"], KUVO_HEAVY_PRIORITY=priority))
        finally:
            first.let_go()
        for job in jobs:
            self.assertEqual(job.wait(timeout=30), 0)
        with open(output) as f:
            self.assertEqual(f.read().splitlines(), ["high1", "high2", "normal1", "normal2"])

    def test_a_high_priority_job_never_stops_one_running(self):
        first = Held([HEAVY, "box"], self.env)
        try:
            high = self.queued("box", ["true"], KUVO_HEAVY_PRIORITY="high")
            self.assertIsNone(first.process.poll(), "the running job was stopped")
            self.assertIsNone(high.poll(), "it ran beside the running job")
        finally:
            first.let_go()
        self.assertEqual(first.process.returncode, 0)
        self.assertEqual(high.wait(timeout=30), 0)

    def test_a_priority_that_isnt_one_is_refused(self):
        code, said = self.run_heavy("box", "true", KUVO_HEAVY_PRIORITY="urgent")
        self.assertEqual(code, 64)
        self.assertIn("KUVO_HEAVY_PRIORITY is high or normal", said)

    def test_jobs_that_come_at_once_while_the_lane_is_held_go_in_turn_high_ones_first(self):
        """Many jobs arriving together: each waits in line, none slips in beside another, and the
        high ones go first, whatever order they came in."""
        first = Held([HEAVY, "box"], self.env)
        output = os.path.join(self.locks, "order")
        script = f'echo "start $1" >> "{output}"; sleep 0.2; echo "end $1" >> "{output}"'
        names = [("normal", f"n{i}") for i in range(6)] + [("high", f"h{i}") for i in range(2)]
        jobs = []
        try:
            for priority, name in names:  # all started before any says it waits
                job = subprocess.Popen([HEAVY, "box", "/bin/sh", "-c", script, "sh", name], env=dict(self.env, KUVO_HEAVY_PRIORITY=priority), stdin=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, start_new_session=True)
                self.addCleanup(lambda job=job: (job.poll() is None and os.killpg(job.pid, signal.SIGKILL), job.wait(timeout=30), job.stderr.close()))
                jobs.append(job)
            for job in jobs:
                self.said_waiting(job, "box")
        finally:
            first.let_go()
        for job in jobs:
            self.assertEqual(job.wait(timeout=60), 0)
        with open(output) as f:
            lines = f.read().splitlines()
        ran = [line.split()[1] for line in lines[::2]]
        self.assertEqual(lines, [f"{what} {name}" for name in ran for what in ("start", "end")], "two ran at once")
        self.assertEqual(sorted(ran[:2]), ["h0", "h1"])
        self.assertEqual(sorted(ran[2:]), [f"n{i}" for i in range(6)])

    def at_once(self, kind, count, command, **env):
        """`count` jobs told not to wait, started together. Their answers, each within 15 seconds."""
        jobs = [subprocess.Popen([HEAVY, kind, *command], env=dict(self.env, KUVO_HEAVY_WAIT="0", **env), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True) for _ in range(count)]
        for job in jobs:
            self.addCleanup(lambda job=job: (job.poll() is None and os.killpg(job.pid, signal.SIGKILL), job.wait(timeout=30), job.stdout.close(), job.stderr.close()))
        return jobs

    def test_jobs_told_not_to_wait_that_come_at_once_never_wait_and_take_each_slot_once(self):
        """The race between looking at a slot and taking it: of many jobs that find a slot free at
        the same moment, one gets it, and the others say so at once (none waits for it, nor runs
        after it). The winners hold their slots until every other has answered."""
        for kind, slots, env in (("box", 1, {}), ("phone", 2, {"KUVO_HEAVY_SLOTS": "2"}), ("mac-build", 2, {})):
            for attempt in range(3):
                with self.subTest(kind=kind, attempt=attempt):
                    done = os.path.join(self.locks, f"done-{kind}-{attempt}")
                    # (box has one slot, and no KUVO_HEAVY_SLOT.)
                    hold = f'echo "${{KUVO_HEAVY_SLOT:-1}}"; while [ ! -f "{done}" ]; do sleep 0.05; done'
                    jobs = self.at_once(kind, 10, ["/bin/sh", "-c", hold], **env)
                    winners, answers = [], []
                    try:
                        deadline = time.monotonic() + 15
                        for job in jobs:
                            ready = select.select([job.stdout], [], [], max(0, deadline - time.monotonic()))[0]
                            self.assertTrue(ready, "a job neither ran nor said it would wait")
                            line = job.stdout.readline()
                            if line:
                                winners.append((job, line.strip()))
                            else:
                                answers.append(job.wait(timeout=15))
                        self.assertEqual(answers, [WAITS] * (10 - slots))
                        self.assertEqual(sorted(slot for _, slot in winners), [str(n + 1) for n in range(slots)])
                    finally:
                        with open(done, "w"):
                            pass
                    for job, _ in winners:
                        self.assertEqual(job.wait(timeout=30), 0)

    def test_told_not_to_wait_it_never_waits_while_others_wait_in_line(self):
        first = Held([HEAVY, "box"], self.env)
        try:
            self.queued("box", ["true"])
            self.queued("box", ["true"], KUVO_HEAVY_PRIORITY="high")
            for priority in ("normal", "high"):
                with self.subTest(priority):
                    started = time.monotonic()
                    code, said = self.run_heavy("box", "true", KUVO_HEAVY_PRIORITY=priority)
                    self.assertEqual(code, WAITS)
                    self.assertIn("Another box job is running", said)
                    self.assertLess(time.monotonic() - started, 5)
        finally:
            first.let_go()

    def in_line(self, name, seen=None, kind="box"):
        """An entry in the lane's queue, as a job waiting in line has (seen: when it last looked)."""
        path = os.path.join(self.queue(kind), name)
        with open(path, "w") as f:
            f.write(f"{int(time.time()) if seen is None else seen}\n")
        return path

    def test_with_its_slot_free_a_job_told_not_to_wait_still_keeps_its_place_in_line(self):
        """A job in line that hasn't taken the free slot yet (it looks once a second; here, one that
        never looks) is before a normal job told not to wait, which says so, and after a high one,
        which goes. One whose process is gone holds no one up."""
        waiting = self.in_line(f"1-000000000000-{os.getpid()}-1")
        code, said = self.run_heavy("box", "true")
        self.assertEqual(code, WAITS)
        self.assertIn("Another box job is waiting for its turn ahead of this one", said)
        self.assertEqual(self.run_heavy("box", "true", KUVO_HEAVY_PRIORITY="high")[0], 0)
        gone = subprocess.Popen(["true"])
        gone.wait()
        os.rename(waiting, os.path.join(self.queue(), f"0-000000000000-{gone.pid}-1"))
        self.assertEqual(self.run_heavy("box", "true"), (0, ""))
        self.assertEqual(sorted(name for name in os.listdir(self.queue()) if name[0] in "01"), [], "it left an entry in line")

    def test_a_job_that_hasnt_looked_for_a_while_holds_no_one_up(self):
        """Stopped, or its pid now another process's (here, this test's): it leaves the line."""
        self.in_line(f"0-000000000000-{os.getpid()}-1", seen=int(time.time()) - 120)
        self.assertEqual(self.run_heavy("box", "true"), (0, ""))
        # One that never said when (cut short as it did) neither.
        open(os.path.join(self.queue(), f"0-000000000001-{os.getpid()}-1"), "w").close()
        self.assertEqual(self.run_heavy("box", "true"), (0, ""))

    def test_a_new_job_goes_after_those_in_line_whatever_became_of_the_last_number(self):
        self.in_line(f"1-000000000005-{os.getpid()}-1")
        open(os.path.join(self.queue(), "sequence"), "w").close()  # cut short as it was written
        code, said = self.run_heavy("box", "true")
        self.assertEqual(code, WAITS)
        self.assertIn("waiting for its turn ahead of this one", said)

    def test_a_job_in_a_sandbox_that_cant_signal_others_keeps_them_in_line(self):
        """Some sandboxes refuse to signal a process outside them: it still runs, and its job stays
        in line before this one."""
        if not shutil.which("sandbox-exec"):
            self.skipTest("no sandbox-exec")
        other = subprocess.Popen(["sleep", "60"])
        self.addCleanup(lambda: (other.kill(), other.wait()))
        self.in_line(f"1-000000000000-{other.pid}-1")
        profile = "(version 1)(allow default)(deny signal)(allow signal (target same-sandbox))"
        result = subprocess.run(["sandbox-exec", "-p", profile, HEAVY, "box", "true"], env=dict(self.env, KUVO_HEAVY_WAIT="0"), capture_output=True, text=True, timeout=30)
        if "Operation not permitted" in result.stderr and "sandbox" in result.stderr:
            self.skipTest("sandbox-exec isn't allowed here")
        self.assertEqual(result.returncode, WAITS, result.stderr)
        self.assertIn("waiting for its turn ahead of this one", result.stderr)

    def test_the_time_limit_counts_from_when_the_job_gets_its_slot(self):
        """It waits in line longer than its limit and isn't stopped for it: its limit starts when it
        starts, and then it is stopped on time."""
        first = Held([HEAVY, "box"], self.env)
        try:
            job = self.queued("box", ["sleep", "30"], KUVO_HEAVY_LIMIT="3s")
            time.sleep(4)
            self.assertIsNone(job.poll(), "it was stopped while it waited")
        finally:
            first.let_go()
        started = time.monotonic()
        self.assertEqual(job.wait(timeout=30), 124)
        self.assertGreater(time.monotonic() - started, 2.5, "its limit counted while it waited")
        self.assertIn("ran past its time limit (3s)", job.stderr.read())

    def test_two_phone_jobs_waiting_in_line_take_both_slots_at_once(self):
        env = self.phone_slots()
        one, two = Held([HEAVY, "phone"], env), Held([HEAVY, "phone"], env)
        seen = os.path.join(self.locks, "seen")
        # Each says its slot and runs until both have: only together do both finish.
        meet = f'echo "$KUVO_HEAVY_SLOT" >> "{seen}"; n=0; while [ "$(wc -l < "{seen}")" -lt 2 ]; do n=$((n + 1)); [ $n -lt 300 ] || exit 3; sleep 0.05; done'
        try:
            jobs = [self.queued("phone", ["/bin/sh", "-c", meet], KUVO_HEAVY_SLOTS="2") for _ in range(2)]
        finally:
            two.let_go()
            one.let_go()
        self.assertEqual([job.wait(timeout=30) for job in jobs], [0, 0])
        with open(seen) as f:
            self.assertEqual(sorted(f.read().split()), ["1", "2"])

    def test_a_phone_job_waiting_for_slot_one_doesnt_hold_up_one_behind_it_that_takes_slot_two(self):
        env = self.phone_slots()
        one, two = Held([HEAVY, "phone"], env), Held([HEAVY, "phone"], env)
        say = ["/bin/sh", "-c", 'echo "$KUVO_TEST_SIMULATOR"']
        try:
            only_one = self.queued("phone", say)  # a caller that doesn't handle slots: slot 1 only
            either = self.queued("phone", say, KUVO_HEAVY_SLOTS="2")
            two.let_go()
            out, _ = either.communicate(timeout=30)
            self.assertEqual((either.returncode, out), (0, "Kuvo Code Tests 2\n"))
            self.assertIsNone(only_one.poll(), "it took slot 2")
            # Slot 2 free, while one waits for slot 1: a job told not to wait that may take either
            # goes, one that may take only slot 1 says it would wait.
            self.assertEqual(self.run_heavy("phone", "true", KUVO_HEAVY_SLOTS="2")[0], 0)
            self.assertEqual(self.run_heavy("phone", "true")[0], WAITS)
        finally:
            one.let_go()
        self.assertEqual(only_one.wait(timeout=30), 0)
        self.assertEqual(only_one.stdout.read(), "Kuvo Code Tests\n")

    def test_a_job_inside_its_kinds_job_runs_at_once(self):
        nested = f'KUVO_HEAVY_WAIT=0 "{HEAVY}" mac true'
        result = subprocess.run([HEAVY, "mac", "/bin/sh", "-c", nested], env=self.env, timeout=30)
        self.assertEqual(result.returncode, 0)

    def phone_slots(self, **env):
        """The environment of a caller that handles slots."""
        return dict(self.env, KUVO_HEAVY_SLOTS="2", **env)

    def old_lock(self, kind="phone"):
        return os.path.join(self.locks, f"kuvo-code-heavy-{kind}-{os.getuid()}.lock")

    def test_two_phone_jobs_run_at_once_each_on_its_own_simulator_and_a_third_waits(self):
        env = self.phone_slots()
        first = Held([HEAVY, "phone"], env)
        try:
            second = Held([HEAVY, "phone"], env)
            try:
                self.assertEqual(first.seen, "Kuvo Code Tests|1|")
                self.assertEqual(second.seen, "Kuvo Code Tests 2|2|-2")
                code, said = self.run_heavy("phone", "true", KUVO_HEAVY_SLOTS="2")
                self.assertEqual(code, WAITS)
                self.assertIn("Another phone job is running", said)
                # Another kind isn't held up by either.
                self.assertEqual(self.run_heavy("box", "true")[0], 0)
            finally:
                second.let_go()
        finally:
            first.let_go()
        self.assertEqual(self.run_heavy("phone", "true", KUVO_HEAVY_SLOTS="2")[0], 0)

    def test_a_third_phone_job_takes_whichever_slot_frees_first(self):
        env = self.phone_slots()
        first, second = Held([HEAVY, "phone"], env), Held([HEAVY, "phone"], env)
        third = None
        try:
            third = subprocess.Popen([HEAVY, "phone", "/bin/sh", "-c", 'echo "$KUVO_TEST_SIMULATOR"'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertIn("Waiting for another phone job", third.stderr.readline())
            self.assertIsNone(third.poll(), "it ran with both slots taken")
            second.let_go()  # the second slot frees, not the first
            out, _ = third.communicate(timeout=30)
            self.assertEqual((third.returncode, out), (0, "Kuvo Code Tests 2\n"))
        finally:
            first.let_go()
            if third is not None and third.poll() is None:
                third.kill()
                third.wait()

    def test_a_job_that_started_before_slots_holds_slot_one_alone(self):
        """An older script holds the one phone lock it always did: it and a new job on slot 1
        exclude each other, and a new job takes slot 2 beside it."""
        env = self.phone_slots()
        old = Held(["lockf", "-k", self.old_lock()], env)
        try:
            new = Held([HEAVY, "phone"], env)
            try:
                self.assertEqual(new.seen, "Kuvo Code Tests 2|2|-2")
                self.assertEqual(self.run_heavy("phone", "true", KUVO_HEAVY_SLOTS="2")[0], WAITS)
            finally:
                new.let_go()
        finally:
            old.let_go()
        # A new job on slot 1 holds that lock for an old-style one, which waits for it.
        new = Held([HEAVY, "phone"], env)
        try:
            self.assertEqual(new.seen, "Kuvo Code Tests|1|")
            taken = subprocess.run(["lockf", "-ks", "-t", "0", self.old_lock(), "true"], timeout=30)
            self.assertNotEqual(taken.returncode, 0, "an old-style job would start beside it")
            # …and another new one goes to slot 2 meanwhile.
            other = Held([HEAVY, "phone"], env)
            try:
                self.assertEqual(other.seen, "Kuvo Code Tests 2|2|-2")
            finally:
                other.let_go()
        finally:
            new.let_go()

    def test_a_caller_that_does_not_handle_slots_only_ever_gets_slot_one(self):
        first = Held([HEAVY, "phone"], self.env)
        try:
            self.assertEqual(first.seen, "Kuvo Code Tests|1|")
            code, said = self.run_heavy("phone", "true")
            self.assertEqual(code, WAITS)
            self.assertIn("Another phone job is running", said)
            # Not even when slot 2 is free: only for a caller that handles slots.
            self.assertEqual(self.run_heavy("phone", "true", KUVO_HEAVY_SLOTS="2")[0], 0)
        finally:
            first.let_go()
        # Slot 2 held, a caller of the old kind takes slot 1, and doesn't mind.
        second = Held([HEAVY, "phone"], self.phone_slots())
        third = Held([HEAVY, "phone"], self.phone_slots())
        try:
            self.assertEqual(self.run_heavy("phone", "true")[0], WAITS)
        finally:
            third.let_go()
            second.let_go()

    def test_a_job_inside_a_phone_job_runs_at_once_on_the_same_simulator(self):
        env = self.phone_slots()
        # Inside a job on slot 1 or slot 2, a script asking whether its turn is held gets yes, and a
        # nested job sees that job's simulator.
        holds = lambda *command, **e: subprocess.run(command, env=dict(env, **e), timeout=30).returncode
        sim = lambda *command: subprocess.run(command, env=dict(env, KUVO_HEAVY_WAIT="0"), capture_output=True, text=True, timeout=30).stdout.strip()
        self.assertEqual(holds(HEAVY, "--holds", "phone"), 1)
        self.assertEqual(holds(HEAVY, "phone", HEAVY, "--holds", "phone"), 0)
        inner = ["/bin/sh", "-c", f'"{HEAVY}" phone /bin/sh -c \'echo "$KUVO_TEST_SIMULATOR"\'']
        self.assertEqual(sim(HEAVY, "phone", *inner), "Kuvo Code Tests")
        slot_one = Held(["lockf", "-k", self.old_lock()], env)  # slot 1 taken, so the next job is on slot 2
        try:
            self.assertEqual(sim(HEAVY, "phone", *inner), "Kuvo Code Tests 2")
            self.assertEqual(holds(HEAVY, "phone", HEAVY, "--holds", "phone"), 0)
        finally:
            slot_one.let_go()

    def test_a_phone_job_under_a_slot_one_lock_of_an_older_script_runs_at_once_on_slot_ones_simulator(self):
        """Whatever slot's values it inherited (a shell started in a slot 2 job keeps them): it runs
        under slot 1's lock, so it is slot 1's."""
        stale = dict(self.phone_slots(), KUVO_HEAVY_WAIT="0", KUVO_TEST_SIMULATOR="Kuvo Code Tests 2", KUVO_HEAVY_SLOT="2", KUVO_HEAVY_BUILD_SUFFIX="-2")
        result = subprocess.run(["lockf", "-k", self.old_lock(), HEAVY, "phone", "/bin/sh", "-c", 'echo "$KUVO_TEST_SIMULATOR|$KUVO_HEAVY_SLOT|$KUVO_HEAVY_BUILD_SUFFIX"'], env=stale, capture_output=True, text=True, timeout=30)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "Kuvo Code Tests|1|"))

    def previous_heavy(self):
        """heavy.sh as it was before slots (the script an older checkout runs), to run beside this one."""
        source = subprocess.run(["git", "show", "de71a5b7b:scripts/heavy.sh"], cwd=os.path.dirname(HEAVY), capture_output=True, text=True)
        if source.returncode != 0:
            self.skipTest("the previous heavy.sh isn't in this checkout's history")
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        path = os.path.join(folder, "heavy.sh")
        with open(path, "w") as f:
            f.write(source.stdout)
        os.chmod(path, 0o755)
        return path

    def test_the_previous_heavy_sh_and_this_one_share_slot_one_and_this_one_has_slot_two_besides(self):
        old = self.previous_heavy()
        env = self.phone_slots()
        before = Held([old, "phone"], env)
        try:
            self.assertEqual(self.run_heavy("phone", "true")[0], WAITS)  # slot 1 only: it waits for the older one
            new = Held([HEAVY, "phone"], env)  # slot 2 beside it
            try:
                self.assertEqual(new.seen, "Kuvo Code Tests 2|2|-2")
                self.assertEqual(subprocess.run([old, "phone", "true"], env=dict(env, KUVO_HEAVY_WAIT="0"), timeout=30).returncode, WAITS)
            finally:
                new.let_go()
        finally:
            before.let_go()
        new = Held([HEAVY, "phone"], env)  # slot 1 now: the older one waits for it
        try:
            self.assertEqual(new.seen, "Kuvo Code Tests|1|")
            result = subprocess.run([old, "phone", "true"], env=dict(env, KUVO_HEAVY_WAIT="0"), capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, WAITS)
            self.assertIn("Another phone job is running", result.stderr)
        finally:
            new.let_go()

    def lock(self, name):
        return os.path.join(self.locks, f"kuvo-code-heavy-{name}-{os.getuid()}.lock")

    def test_two_mac_build_jobs_run_at_once_each_in_a_build_folder_of_its_own_and_a_third_waits(self):
        # Any caller: nothing to opt into.
        first = Held([HEAVY, "mac-build"], self.env)
        try:
            second = Held([HEAVY, "mac-build"], self.env)
            try:
                self.assertEqual(first.seen, "|1|-1")
                self.assertEqual(second.seen, "|2|-2")
                code, said = self.run_heavy("mac-build", "true")
                self.assertEqual(code, WAITS)
                self.assertIn("Another mac-build job is running", said)
                self.assertEqual(self.run_heavy("box", "true")[0], 0)
            finally:
                second.let_go()
        finally:
            first.let_go()
        self.assertEqual(self.run_heavy("mac-build", "true")[0], 0)

    def test_a_third_mac_build_job_takes_whichever_slot_frees_first(self):
        first, second = Held([HEAVY, "mac-build"], self.env), Held([HEAVY, "mac-build"], self.env)
        third = None
        try:
            third = subprocess.Popen([HEAVY, "mac-build", "/bin/sh", "-c", 'echo "$KUVO_HEAVY_SLOT$KUVO_HEAVY_BUILD_SUFFIX"'], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertIn("Waiting for another mac-build job", third.stderr.readline())
            self.assertIsNone(third.poll(), "it ran with both slots taken")
            second.let_go()
            out, _ = third.communicate(timeout=30)
            self.assertEqual((third.returncode, out), (0, "2-2\n"))
        finally:
            first.let_go()
            if third is not None and third.poll() is None:
                third.kill()
                third.wait()

    def test_a_mac_build_job_runs_while_the_app_suite_holds_the_mac_lock_and_the_other_way_round(self):
        suite = Held([HEAVY, "mac"], self.env)
        try:
            self.assertEqual(self.run_heavy("mac-build", "true")[0], 0)
            one, two = Held([HEAVY, "mac-build"], self.env), Held([HEAVY, "mac-build"], self.env)
            try:
                self.assertEqual((one.seen, two.seen), ("|1|-1", "|2|-2"))
            finally:
                two.let_go()
                one.let_go()
        finally:
            suite.let_go()
        build = Held([HEAVY, "mac-build"], self.env)
        try:
            self.assertEqual(self.run_heavy("mac", "true")[0], 0)
        finally:
            build.let_go()

    def test_a_phone_build_does_not_wait_on_held_phone_slots_and_takes_a_build_lane_slot(self):
        env = self.phone_slots()
        one, two = Held([HEAVY, "phone"], env), Held([HEAVY, "phone"], env)
        try:
            self.assertEqual((one.seen, two.seen), ("Kuvo Code Tests|1|", "Kuvo Code Tests 2|2|-2"))
            # Both phone slots are held, and another phone test run would wait.
            self.assertEqual(self.run_heavy("phone", "true", KUVO_HEAVY_SLOTS="2")[0], WAITS)
            self.assertEqual(self.run_heavy("phone-build", "true")[0], 0)
            # It's in the build lane's slot, with no simulator, and a suffix that isn't the phone's.
            build = Held([HEAVY, "phone-build"], self.env)
            try:
                self.assertEqual(build.seen, "|1|-1")
            finally:
                build.let_go()
        finally:
            two.let_go()
            one.let_go()

    def test_a_phone_build_waits_on_a_full_build_lane_and_shares_it_with_mac_builds(self):
        first, second = Held([HEAVY, "phone-build"], self.env), Held([HEAVY, "mac-build"], self.env)
        try:
            self.assertEqual((first.seen, second.seen), ("|1|-1", "|2|-2"))
            for kind in ("phone-build", "mac-build"):
                code, said = self.run_heavy(kind, "true")
                self.assertEqual(code, WAITS)
                self.assertIn("Another mac-build job is running", said)
            # The phone's test runs and the app suite aren't held up by the full lane.
            self.assertEqual(self.run_heavy("phone", "true")[0], 0)
            self.assertEqual(self.run_heavy("mac", "true")[0], 0)
        finally:
            second.let_go()
            first.let_go()
        self.assertEqual(self.run_heavy("phone-build", "true")[0], 0)

    def test_a_phone_build_runs_beside_the_app_suite_and_one_inside_a_build_job_runs_at_once(self):
        suite = Held([HEAVY, "mac"], self.env)
        try:
            self.assertEqual(self.run_heavy("phone-build", "true")[0], 0)
        finally:
            suite.let_go()
        nested = f'KUVO_HEAVY_WAIT=0 "{HEAVY}" phone-build /bin/sh -c \'echo "$KUVO_HEAVY_SLOT$KUVO_HEAVY_BUILD_SUFFIX"\''
        result = subprocess.run([HEAVY, "phone-build", "/bin/sh", "-c", nested], env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual((result.returncode, result.stdout), (0, "1-1\n"))
        self.assertEqual(subprocess.run([HEAVY, "--holds", "phone-build", "true"], env=self.env).returncode, 1)
        held = f'"{HEAVY}" --holds phone-build'
        self.assertEqual(subprocess.run([HEAVY, "mac-build", "/bin/sh", "-c", held], env=self.env).returncode, 0)

    def test_a_job_that_still_says_mac_for_a_build_does_not_block_mac_build_and_still_excludes_mac(self):
        """What an older script does, under the one mac lock as before: no mac-build slot is theirs."""
        old = Held(["lockf", "-k", self.lock("mac")], self.env)
        try:
            one, two = Held([HEAVY, "mac-build"], self.env), Held([HEAVY, "mac-build"], self.env)
            try:
                self.assertEqual((one.seen, two.seen), ("|1|-1", "|2|-2"))
            finally:
                two.let_go()
                one.let_go()
            self.assertEqual(self.run_heavy("mac", "true")[0], WAITS)
        finally:
            old.let_go()

    def test_the_previous_heavy_sh_runs_mac_beside_mac_build_jobs(self):
        old = self.previous_heavy()
        before = Held([old, "mac"], self.env)
        try:
            one, two = Held([HEAVY, "mac-build"], self.env), Held([HEAVY, "mac-build"], self.env)
            try:
                self.assertEqual((one.seen, two.seen), ("|1|-1", "|2|-2"))
                result = subprocess.run([old, "mac", "true"], env=dict(self.env, KUVO_HEAVY_WAIT="0"), capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, WAITS)
                self.assertIn("Another mac job is running", result.stderr)
            finally:
                two.let_go()
                one.let_go()
        finally:
            before.let_go()

    def test_a_job_inside_a_mac_build_job_runs_at_once_in_the_same_slot(self):
        env = self.env
        holds = lambda *command: subprocess.run(command, env=env, timeout=30).returncode
        slot = lambda *command: subprocess.run(command, env=dict(env, KUVO_HEAVY_WAIT="0"), capture_output=True, text=True, timeout=30).stdout.strip()
        self.assertEqual(holds(HEAVY, "--holds", "mac-build"), 1)
        self.assertEqual(holds(HEAVY, "mac-build", HEAVY, "--holds", "mac-build"), 0)
        self.assertEqual(holds(HEAVY, "mac-build", HEAVY, "--holds", "mac"), 1)  # not mac's turn
        inner = ["/bin/sh", "-c", f'"{HEAVY}" mac-build /bin/sh -c \'echo "$KUVO_HEAVY_SLOT$KUVO_HEAVY_BUILD_SUFFIX"\'']
        self.assertEqual(slot(HEAVY, "mac-build", *inner), "1-1")
        first = Held([HEAVY, "mac-build"], env)  # slot 1 taken: the next job and its nested one are on slot 2
        try:
            self.assertEqual(slot(HEAVY, "mac-build", *inner), "2-2")
        finally:
            first.let_go()
        # Stale values from a slot 2 shell, under slot 1's lock: slot 1's.
        stale = dict(env, KUVO_HEAVY_WAIT="0", KUVO_HEAVY_SLOT="2", KUVO_HEAVY_BUILD_SUFFIX="-2")
        result = subprocess.run(["lockf", "-k", self.lock("mac-build"), HEAVY, "mac-build", "/bin/sh", "-c", 'echo "$KUVO_HEAVY_SLOT$KUVO_HEAVY_BUILD_SUFFIX"'], env=stale, capture_output=True, text=True, timeout=30)
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "1-1"))

    def test_a_mac_build_job_started_without_ps_takes_a_slot_too(self):
        env = self.refused_ps()
        first = Held([HEAVY, "mac-build"], env)
        try:
            second = Held([HEAVY, "mac-build"], env)
            try:
                self.assertEqual((first.seen, second.seen), ("|1|-1", "|2|-2"))
                self.assertEqual(subprocess.run([HEAVY, "mac-build", "true"], env=dict(env, KUVO_HEAVY_WAIT="0"), timeout=30).returncode, WAITS)
            finally:
                second.let_go()
        finally:
            first.let_go()

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
        return dict(self.env, PATH=folder + os.pathsep + self.env["PATH"])

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

    def test_a_job_is_started_under_background_priority_in_every_way_it_starts(self):
        """Whatever way a job starts, its command is run by `taskpolicy -b` (macOS): a stand-in logs what
        it's asked. (Elsewhere, nice and ionice, which the test of the real policy sees.)"""
        if sys.platform != "darwin":
            self.skipTest("taskpolicy is macOS's")
        log = os.path.join(self.locks, "policy")
        env = dict(self.env, FAKE_POLICY_LOG=log, KUVO_HEAVY_WAIT="0")
        def policies(*command, **more):
            if os.path.exists(log):
                os.remove(log)
            result = subprocess.run(command, env=dict(env, **more), capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL, start_new_session=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(log) as f:
                return f.read().split()
        with self.subTest("a job"):
            self.assertEqual(policies(HEAVY, "box", "true"), ["-b"])
        with self.subTest("each kind"):
            for kind in ("mac", "mac-build", "phone-build", "phone"):
                self.assertEqual(policies(HEAVY, kind, "true"), ["-b"], kind)
        with self.subTest("inside another job"):
            self.assertEqual(policies(HEAVY, "box", HEAVY, "box", "true"), ["-b", "-b"])
            self.assertEqual(policies(HEAVY, "box", HEAVY, "phone", "true"), ["-b", "-b"])
        with self.subTest("the old way (the single lock)"):
            self.assertEqual(policies(HEAVY, "box", "true", KUVO_HEAVY_OLD_UNTIL="20991231"), ["-b"])
        with self.subTest("under a lock of an older script"):
            self.assertEqual(policies("lockf", "-k", self.old_lock("box"), HEAVY, "box", "true"), ["-b"])
        with self.subTest("in a terminal"):
            if os.path.exists(log):
                os.remove(log)
            pid, fd = pty.fork()
            if pid == 0:
                try:
                    os.execve(HEAVY, [HEAVY, "box", "true"], env)
                finally:
                    os._exit(127)
            try:
                while select.select([fd], [], [], 60)[0]:
                    try:
                        if not os.read(fd, 4096):
                            break
                    except OSError:  # the terminal's end: the job is over
                        break
                _, status = os.waitpid(pid, 0)
            finally:
                os.close(fd)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            with open(log) as f:
                self.assertEqual(f.read().split(), ["-b"])

    def test_a_job_runs_at_background_priority_for_real(self):
        """The policy the job's own children see (the real `taskpolicy`, or nice), not a process started
        by hand, which is at the default. A background job gets almost no CPU on a Mac that's very
        busy: if it hasn't run in two minutes, the test can't say."""
        baseline = subprocess.run(PROBE, capture_output=True, text=True, timeout=120).stdout
        if is_low(baseline):  # run under heavy.sh itself, say
            self.skipTest("this test run is at background priority already")
        env = dict(self.env, PATH=os.environ["PATH"], KUVO_HEAVY_WAIT="0")
        try:
            result = subprocess.run([HEAVY, "box", *PROBE], env=env, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL, start_new_session=True)
        except subprocess.TimeoutExpired:
            self.skipTest("the Mac is too busy for a job at background priority to run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(is_low(result.stdout), result.stdout)

    def test_a_job_that_fails_keeps_its_answer_under_the_lower_priority(self):
        result = subprocess.run([HEAVY, "box", "/bin/sh", "-c", 'echo "$1"; exit 3', "sh", "a b"], env=self.env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL, start_new_session=True)
        self.assertEqual((result.returncode, result.stdout), (3, "a b\n"))

    def waiting_mac(self, **env):
        """A Mac app suite that has its turn and waits for the Mac to be less busy (to it, the Mac is
        always busy), once it says so. Stopped with its whole session at the end of the test."""
        mac = subprocess.Popen([HEAVY, "mac", "true"], env=dict(self.env, KUVO_HEAVY_LOAD="-1", **env), stderr=subprocess.PIPE, text=True, start_new_session=True)
        def stop():
            try:
                os.killpg(mac.pid, signal.SIGKILL)
            except ProcessLookupError:  # stopped by the test already
                pass
            mac.wait(timeout=30)
            mac.stderr.close()
        self.addCleanup(stop)
        self.assertTrue(select.select([mac.stderr], [], [], 30)[0], "the suite said nothing")
        self.assertIn("Waiting while the Mac is busy", mac.stderr.readline())
        return mac

    def test_while_the_app_suite_waits_for_a_less_busy_mac_new_jobs_of_other_kinds_wait_for_it(self):
        self.waiting_mac()
        for kind in ("phone", "mac-build", "box"):
            with self.subTest(kind):
                code, said = self.run_heavy(kind, "true")
                self.assertEqual(code, WAITS)
                self.assertIn("The Mac app's suite is waiting for the Mac to be less busy, and goes first", said)
        # Waiting (not told not to), it says why, once.
        waiting = subprocess.Popen([HEAVY, "box", "true"], env=self.env, stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertIn("Waiting for the Mac app's suite to start first", waiting.stderr.readline())
            self.assertIsNone(waiting.poll(), "it started before the suite")
        finally:
            os.killpg(waiting.pid, signal.SIGKILL)
            waiting.wait(timeout=30)
            waiting.stderr.close()

    def test_the_app_suite_holds_other_jobs_back_only_so_long_and_only_while_it_waits(self):
        mac = self.waiting_mac()
        # Past the time it may hold them back, they go.
        self.assertEqual(self.run_heavy("phone", "true", KUVO_HEAVY_MAC_FIRST_FOR="0")[0], 0)
        # A suite that's gone holds nothing back.
        os.killpg(mac.pid, signal.SIGKILL)
        mac.wait(timeout=30)
        self.assertEqual(self.run_heavy("box", "true")[0], 0)

    def test_an_app_suite_that_isnt_waiting_holds_nothing_back(self):
        marker = os.path.join(self.locks, f"kuvo-code-heavy-mac-first-{os.getuid()}")
        # Told not to wait, it says so and leaves nothing behind that holds others back.
        code, said = self.run_heavy("mac", "true", KUVO_HEAVY_LOAD="-1")
        self.assertEqual(code, WAITS)
        self.assertFalse(os.path.exists(marker), "a suite that didn't wait said it does")
        # Once it started (and while it runs), neither.
        suite = Held([HEAVY, "mac"], self.env)
        try:
            self.assertFalse(os.path.exists(marker), "a suite that started still says it waits")
            self.assertEqual(self.run_heavy("phone", "true")[0], 0)
            self.assertEqual(self.run_heavy("box", "true")[0], 0)
        finally:
            suite.let_go()

    def test_a_job_started_inside_one_already_running_doesnt_wait_for_the_app_suite(self):
        """A job of another kind that a running job starts (a test run starting the box's suite) is
        part of that one, which was going before the suite began to wait."""
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, ignore_errors=True)
        running, go, inner = (os.path.join(folder, name) for name in ("running", "go", "inner"))
        os.mkfifo(running)
        os.mkfifo(go)
        script = f'echo yes > "{running}"; read x < "{go}"; KUVO_HEAVY_WAIT=0 "{HEAVY}" phone true; echo $? > "{inner}"'
        outer = subprocess.Popen([HEAVY, "box", "/bin/sh", "-c", script], env=self.env)
        with open(running) as said:
            said.read()
        self.waiting_mac()
        with open(go, "w") as told:
            told.write("go\n")
        self.assertEqual(outer.wait(timeout=30), 0)
        with open(inner) as f:
            self.assertEqual(f.read().strip(), "0", "it waited for the suite")

    # Memory: KUVO_HEAVY_MEMORY=100 makes it short whatever this Mac has (all of it is never
    # available: some is always wired); 0, the tests' own, never.
    def test_a_new_job_waits_while_memory_is_short_and_says_why(self):
        for kind in ("mac", "mac-build", "phone", "box"):
            with self.subTest(kind):
                code, said = self.run_heavy(kind, "true", KUVO_HEAVY_MEMORY="100")
                self.assertEqual(code, WAITS)
                self.assertRegex(said, r"The Mac is short of memory \(swapping \d+ MB a second, pressure \S+, \d+% available\)")
        waiting = subprocess.Popen([HEAVY, "box", "true"], env=dict(self.env, KUVO_HEAVY_MEMORY="100"), stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertTrue(select.select([waiting.stderr], [], [], 30)[0], "it said nothing")
            self.assertIn("Waiting for memory: the Mac is short of it", waiting.stderr.readline())
            self.assertIsNone(waiting.poll(), "it started")
        finally:
            os.killpg(waiting.pid, signal.SIGKILL)
            waiting.wait(timeout=30)
            waiting.stderr.close()

    def test_past_its_time_to_wait_for_memory_a_job_goes(self):
        self.assertEqual(self.run_heavy("box", "true", KUVO_HEAVY_MEMORY="100", KUVO_HEAVY_MEMORY_WAIT_FOR="0")[0], 0)

    def test_the_time_to_wait_for_memory_counts_from_when_any_job_found_it_short(self):
        """A shortage another job found two hours ago is past the time any job waits for it."""
        with open(os.path.join(self.locks, f"kuvo-code-heavy-memory-short-{os.getuid()}"), "w") as since:
            since.write(f"{int(time.time()) - 7200}\n")
        self.assertEqual(self.run_heavy("box", "true", KUVO_HEAVY_MEMORY="100")[0], 0)

    def test_a_job_started_inside_one_already_running_doesnt_wait_for_memory(self):
        code, said = self.run_heavy("box", "/bin/sh", "-c", f'KUVO_HEAVY_MEMORY=100 "{HEAVY}" phone true')
        self.assertEqual((code, said), (0, ""))

    def test_an_app_suite_waiting_for_memory_goes_first_too(self):
        mac = subprocess.Popen([HEAVY, "mac", "true"], env=dict(self.env, KUVO_HEAVY_MEMORY="100"), stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertTrue(select.select([mac.stderr], [], [], 30)[0], "the suite said nothing")
            self.assertIn("Waiting for memory", mac.stderr.readline())
            code, said = self.run_heavy("phone", "true")
            self.assertEqual(code, WAITS)
            self.assertIn("The Mac app's suite is waiting for the Mac to be less busy, and goes first", said)
        finally:
            os.killpg(mac.pid, signal.SIGKILL)
            mac.wait(timeout=30)
            mac.stderr.close()

    def test_a_share_of_memory_that_isnt_one_is_refused(self):
        for given in ("lots", "20%", "1000", "101"):
            with self.subTest(given):
                result = subprocess.run([HEAVY, "box", "true"], env=dict(self.env, KUVO_HEAVY_MEMORY=given), capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 64)
                self.assertIn("KUVO_HEAVY_MEMORY is a share of memory in percent", result.stderr)

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
        self.env = without_background_priority(dict(clean_environment(), KUVO_HEAVY_DIR=self.locks, KUVO_HEAVY_LOAD="1000", KUVO_HEAVY_MEMORY="0", KUVO_HEAVY_OLD_UNTIL="20000101", KUVO_HEAVY_WAIT="0"))
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

    def start(self, job, kind="box", env=None, child="sleep 300", stderr=None):
        """Runs `job` (shell) under heavy.sh once it has started a child of its own (`child`, which
        sleeps) and said so. Returns the process and the child's pid."""
        self.fresh()  # folders of their own for each job: one job's leftovers aren't the next one's
        ready, pidfile = (os.path.join(self.folder, name) for name in ("ready", "pid"))
        script = f'{child} & echo $! > "{pidfile}"; echo "${{KUVO_HEAVY_SLOT-}}" > "{self.folder}/slot"; echo yes > "{ready}"; {job}'
        process = self.run_job(["/bin/sh", "-c", script], kind, env, stderr)
        self.ready()
        return process, self.child("pid")

    def run_job(self, command, kind="box", env=None, stderr=None):
        """In a session of its own, as a harness runs a command, and not under a shell's `&`."""
        return subprocess.Popen([HEAVY, kind, *command], env=env or self.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr, start_new_session=True,
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

    def test_a_job_on_the_second_phone_slot_ends_with_its_command_too(self):
        """Slot 1 is taken, so the job is on slot 2: stopped, any way, its command's child ends."""
        env = dict(self.env, KUVO_HEAVY_SLOTS="2")
        first, _ = self.start("wait", kind="phone", env=env)
        try:
            for how, sig in (("pid", signal.SIGTERM), ("group", signal.SIGINT), ("group", signal.SIGKILL)):
                with self.subTest(f"{sig.name} to its {how}"):
                    process, child = self.start("wait", kind="phone", env=env)
                    with open(os.path.join(self.folder, "slot")) as f:
                        self.assertEqual(f.read().strip(), "2")
                    if how == "pid":
                        process.send_signal(sig)
                    else:
                        os.killpg(process.pid, sig)
                    process.wait(timeout=30)
                    self.over(process)
                    self.gone(child, "its command's child is still running")
        finally:
            first.send_signal(signal.SIGTERM)
            first.wait(timeout=30)
            self.over(first)

    def test_a_job_past_its_time_limit_is_stopped_and_says_what_was_running(self):
        """A job that hangs (here, one waiting for good on a child that takes no TERM) is stopped
        once its time is up, all of it, and its turn is free again: it can't hold its kind for hours.
        (The job never ends by itself, so only its limit ends it; five seconds is plenty for it to
        start its child and say so, which takes milliseconds.)"""
        env = dict(self.env, KUVO_HEAVY_LIMIT="5s")
        process, child = self.start("wait", env=env, child=self.STUBBORN, stderr=subprocess.PIPE)
        self.assertEqual(process.wait(timeout=30), 124)
        said = process.stderr.read().decode()
        process.stderr.close()
        self.over(process)
        self.gone(child, "a child of a job past its time limit is still running")
        self.assertIn("this box job ran past its time limit (5s) and was stopped: /bin/sh -c", said)
        self.assertIn("KUVO_HEAVY_LIMIT", said)
        free = subprocess.run([HEAVY, "box", "true"], env=self.env, capture_output=True, timeout=30)
        self.assertEqual(free.returncode, 0, "its turn is still held")
        self.assertEqual(self.left_in(process), [], "something of the helper is still running")

    def left_in(self, process):
        """What's still running in the session the job was started in (the helper's watcher, a
        command's child): by session, never by name."""
        left = []
        for line in subprocess.run(["ps", "-axo", "pid="], capture_output=True, text=True).stdout.split():
            try:
                if os.getsid(int(line)) == process.pid:
                    left.append(int(line))
            except (ProcessLookupError, PermissionError):
                pass
        return left

    def test_a_job_within_its_limit_ends_as_it_would_have(self):
        """With a limit, a job that ends in time keeps its own answer and leaves nothing behind: not
        its command's child, nor the helper's watcher, which keeps the limit."""
        env = dict(self.env, KUVO_HEAVY_LIMIT="2h")
        process, child = self.start("exit 7", env=env)
        self.assertEqual(process.wait(timeout=30), 7)
        self.over(process)
        self.gone(child, "a background child of a finished command is still running")
        self.assertEqual(self.left_in(process), [], "something of the helper is still running")

    def test_a_limit_is_read_in_base_ten_whatever_zeros_lead_it(self):
        for given in ("08m", "010", "0", "009s"):
            with self.subTest(given):
                result = subprocess.run([HEAVY, "box", "true"], env=dict(self.env, KUVO_HEAVY_LIMIT=given), capture_output=True, text=True, timeout=30)
                self.assertEqual((result.returncode, result.stderr), (0, ""))

    def test_a_limit_that_isnt_a_time_is_refused(self):
        for given in ("soon", "1.5m", "5ms", "m", "1234567m"):
            with self.subTest(given):
                result = subprocess.run([HEAVY, "box", "true"], env=dict(self.env, KUVO_HEAVY_LIMIT=given), capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 64)
                self.assertIn("KUVO_HEAVY_LIMIT is a time like 90m", result.stderr)

    def test_the_old_way_lock_changes_nothing(self):
        env = dict(self.env, KUVO_HEAVY_OLD_UNTIL="20991231")
        process, child = self.start("wait", env=env)
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=30)
        self.over(process)
        self.gone(child, "its command's child is still running")


if __name__ == "__main__":
    unittest.main()
