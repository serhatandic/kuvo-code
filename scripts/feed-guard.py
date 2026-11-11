#!/usr/bin/env python3
"""Points Kuvo Code back at the real update feed once scripts/try-update.sh is gone, however it ends.

    scripts/feed-guard.py <script's PID> <server's PID> <defaults domain> <feed URL>

try-update.sh's own trap undoes its feed override when it exits, is interrupted or loses its
terminal, but nothing runs in it when it's killed outright (SIGKILL: a harness's time limit, or
stopping a background command), whether that's it alone, its process group or its whole tree. So
before it writes the override it starts this: it leaves the script's process group and tree (it's
launchd's child, in a session of its own), says "watching" once it watches both processes, and
waits. When either one ends, it stops the server if it's still running, deletes the override if
it's still this run's feed, and exits.
"""
import os
import select
import signal
import subprocess
import sys


def current_feed(domain):
    done = subprocess.run(["defaults", "read", domain, "SUFeedURL"], capture_output=True, text=True)
    return done.stdout.strip() if done.returncode == 0 else None


def restore(domain, url, server, server_ended):
    if not server_ended:
        try:
            os.kill(server, signal.SIGTERM)
        except OSError:
            pass
    if current_feed(domain) == url:
        subprocess.run(["defaults", "delete", domain, "SUFeedURL"], capture_output=True)


def main():
    if len(sys.argv) != 5:
        sys.exit("usage: scripts/feed-guard.py <script's PID> <server's PID> <defaults domain> <feed URL>")
    script, server = int(sys.argv[1]), int(sys.argv[2])
    domain, url = sys.argv[3], sys.argv[4]

    # Away from the script's process group (a session of its own) and from its tree (the middle
    # process exits, so launchd takes this one), where a kill of either doesn't reach.
    if os.fork():
        os._exit(0)
    os.setsid()
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    if os.fork():
        os._exit(0)
    os.chdir("/")

    queue = select.kqueue()
    ended = set()
    for pid in (script, server):
        event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD, fflags=select.KQ_NOTE_EXIT)
        try:
            queue.control([event], 0)
        except ProcessLookupError:
            ended.add(pid)
    if not ended:
        print("watching", flush=True)
    # Nothing of the script's left open: whatever reads its output sees it end with it.
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)

    while not ended:
        for event in queue.control(None, 2):
            ended.add(event.ident)
    restore(domain, url, server, server in ended)


if __name__ == "__main__":
    main()
