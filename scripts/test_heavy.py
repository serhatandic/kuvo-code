"""scripts/heavy.sh: jobs of different kinds run together, two of one kind queue (two phone jobs that
handle slots run at once, each with a simulator of its own, and two mac-build jobs, each with a build
folder of its own, beside the app suite's mac; the phone's builds are phone-build, which is mac-build's lane), a job started the
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
import time
import unittest
from pathlib import Path

HEAVY = str(Path(__file__).with_name("heavy.sh"))
WAITS = 75


def clean_environment():
    """The environment of the run without what a job of heavy.sh leaves in it (a test run from inside
    one would otherwise see that job's turn and slot)."""
    return {k: v for k, v in os.environ.items() if k not in ("KUVO_HEAVY_SLOTS", "KUVO_HEAVY_HELD", "KUVO_HEAVY_HOLDING", "KUVO_HEAVY_SLOT", "KUVO_HEAVY_BUILD_SUFFIX", "KUVO_TEST_SIMULATOR", "KUVO_HEAVY_WAIT", "KUVO_HEAVY_LIMIT", "KUVO_HEAVY_MAC_FIRST_FOR", "KUVO_HEAVY_MEMORY", "KUVO_HEAVY_MEMORY_WAIT_FOR")}


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
        self.env = dict(clean_environment(), KUVO_HEAVY_DIR=self.locks, KUVO_HEAVY_LOAD="1000", KUVO_HEAVY_MEMORY="0", KUVO_HEAVY_OLD_UNTIL="20000101")

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
        self.env = dict(clean_environment(), KUVO_HEAVY_DIR=self.locks, KUVO_HEAVY_LOAD="1000", KUVO_HEAVY_MEMORY="0", KUVO_HEAVY_OLD_UNTIL="20000101", KUVO_HEAVY_WAIT="0")
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
