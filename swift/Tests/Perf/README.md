# Performance

How smoothly a conversation streams and scrolls, measured the same way each time. A real run is
recorded once from a separate copy of the app (`run.kuvo.code.perf`), with one of OpenCode's free
models; then a debug build plays it back into a new session (`KUVO_DEMO_REPLAY`) at the pace it
came, while the app measures itself. Compare two builds on the same recording.

```sh
cd swift/Tests/Perf
python3 kuvo_perf.py build                                   # the perf copy, from this checkout
python3 kuvo_perf.py record draw "draw the coolest thing you can in this chat"
python3 kuvo_perf.py bench "$TMPDIR/kuvo-perf/DerivedData/Build/Products/Debug/Kuvo Code.app" draw thinking-scrolling
python3 kuvo_perf.py clean                                   # quits it and removes all it keeps
```

To compare with an older version, export it (`git archive <commit> | tar -x -C <folder>`), add
`KuvoCode/App/PerfReplay.swift` and the replay lines in `MainView.swift` if it predates them, and
`build <folder> <app>` it.

Each result says how long the main thread kept you waiting (the waits over 50 and 100 ms are what
you feel as stutters), how busy it and the process were, memory, the frames drawn, how many rows,
Markdown pieces and code blocks were made meanwhile, and whether every block of words showed what
the engine says it was. The cases:

| Case | What it does while the run plays |
| --- | --- |
| `thinking` | The thinking open, following the end |
| `thinking-scrolling` | The thinking open, scrolling up and down through it |
| `reply` | Following the end |
| `reply-scrolling` | Scrolling up and down a screen or two from the end |
| `finished-scrolling` | Plays the run at once, then measures 30 s of scrolling the finished conversation |

The window sits past the screen's edge, out of your way. A debug build is slower than what
people use, so compare builds with each other rather than with a target.

## Group chats

`python3 kuvo_perf.py groups <app> [label]` measures a group chat: three bots on a stand-in model
that `kuvo_perf.py` serves (an OpenAI-compatible server on 127.0.0.1 answering each bot's turn with
its line of `groups/discussion.json`, a word at a time), in one of 40 chats on the Mac. It opens the
app twice from a clean copy: once to make the bots and chats, then to measure, with the chats kept
from before in its first frame. It prints when each bot's message reached the chat against when
the stand-in finished it (reply-to-row), the main thread's waits, its CPU and the app's, and the
coding agents' bridge's and engine's CPU. Run it on a build from before a change to compare.
Each build is measured for the same 15 s from the question (`KUVO_PERF_GROUP_SECONDS`), however
fast it answers, since a shorter run puts its few long waits higher in the percentiles; an older
build compared with it needs that line of `PerfGroups.swift` too.

The perf copy downloads its own engine on its first run, and later runs reuse it
(`KUVO_PERF_ENGINE` names another). Every mode stops at once, naming itself, if the bundle ID,
folder, app or engine it would use is the real Kuvo Code's (`scripts/real-app-guard.sh`).

## What it leaves

- The perf copy keeps its data where any copy of the app does, under the bundle ID
  `run.kuvo.code.perf`; `clean` removes it.
- Builds, recordings, projects and results are in `kuvo-perf` in your temporary folder, and the
  engine group chat runs reuse in `kuvo-perf-engine` there.
