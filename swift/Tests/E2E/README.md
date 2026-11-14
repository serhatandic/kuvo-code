# End-to-end tests

Kuvo Code tried the way people use it: a separate copy of the app, driven in the background with a
real model, on real projects. `SCENARIOS.md` lists the cases, written from what people ask of
the app, with where each stands.

## What it needs

- Accessibility access for the app you run the tests from (Terminal, say), in System Settings ›
  Privacy & Security › Accessibility. The driver reads and presses the window through it, so the
  pointer and keyboard stay yours. The screen must be unlocked.
- The network: the copy downloads its engine, and the tests use OpenCode's free models
  (`opencode/glm-5.3-flash-free`, or `opencode/deepseek-v4.1-flash-free` with
  `KUVO_E2E_MODEL`), which need no account.
- For the cases on a machine, a Linux machine you reach with SSH, named in `KUVO_E2E_MACHINE`.

## Running

```sh
cd Tests/E2E
python3 kuvo_e2e.py build                 # the copy (run.kuvo.code.e2e) and the driver
python3 kuvo_e2e.py new slugify-review    # a run: a folder for its projects and captures
python3 kuvo_e2e.py project slugify https://github.com/sindresorhus/slugify.git
python3 kuvo_e2e.py launch KUVO_DEMO_FOLDER=<that folder> "KUVO_DEMO_PROMPT=What does this project do?"
python3 kuvo_e2e.py sessions              # what its engine has
python3 kuvo_e2e.py wait <session>        # until the agent is done
python3 kuvo_e2e.py messages <session>
python3 kuvo_e2e.py drive find Send       # drive.swift, for the running copy
python3 kuvo_e2e.py shot review           # a capture of its window
python3 kuvo_e2e.py clean                 # quits it and removes everything it keeps
```

`kuvo_e2e.py` is also the library the cases use: `App` launches and drives the copy, `Engine`
reads its engine (the copy writes where it answers to `e2e-engine.json` in its own folder, with
`KUVO_E2E` set, in debug builds only), and `Run` makes projects and keeps the report.

## What it leaves

- The copy keeps its data where any copy of the app does, under the bundle ID `run.kuvo.code.e2e`
  (`~/Library/Application Support/run.kuvo.code.e2e`, its caches and preferences); `clean` removes
  all of it.
- Runs are in `kuvo-e2e` in your temporary folder: projects, captures and `report.md`.
- On a machine, the copy's things go in `~/.kuvo-code-e2e`.
