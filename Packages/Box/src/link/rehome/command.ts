// `kuvo-link.js rehome <root> …` (PROTOCOL.md, "Moving this Mac's box"): what the keeper runs, with
// the old box stopped. One JSON line on stdout, and an exit status that says what to start (`EXIT`);
// 2 for a command it doesn't know.
//
//   rehome <root> [--release <folder>] [--keeps-awake on|off]   the move (KUVO_HOME the app's box)
//   rehome <root> --ready [--release <folder>]                  whether to move (or finish one) now
//   rehome <root> --resume                                      one that stopped part way, finished
//   rehome <root> --back                                        moved back into the app's folder
//   rehome <root> --new --release <folder> [--keeps-awake on|off]  a new Mac's box made there (no move)
//   rehome <root> --new --check                                 whether it's made, or could be now
//   rehome <root> --failed <why>                                a try the keeper gave up on, counted
//   rehome <root> --status                                      how it stands (`kuvo/box/rehome`)
//   rehome <root> --settled keychain|agent                      what the app owed it, done

import path from "node:path";
import { accountHome, located } from "../home";
import { appFolderOf, homeOfRoot, keeperFailed, newReadiness, NOTHING_TO_MOVE, rehome, rehomeBack, rehomeNew, rehomeReady, rehomeResume, settled, type RehomeOutcome } from "./move";
import { moveUnderWay, rehomeStatus } from "./state";

/** Each result's exit status: 0, start what's there; 1, it didn't move, start the box where it was;
 * 3, stuck past the point it goes back from (`--resume`), start nothing; 4, another move holds the
 * lock, start nothing. */
const EXIT: Record<RehomeOutcome["result"], number> = { done: 0, back: 0, nothing: 0, refused: 1, failed: 1, stuck: 3, waits: 4 };

const USAGE = "Usage: kuvo-link.js rehome <root> [--new] [--release <folder>] [--keeps-awake on|off] | --ready | --resume | --back | --status | --settled keychain|agent | --new --check | --failed <why>";

export async function rehomeCommand(root: string | undefined, args: string[]): Promise<number> {
  // (Whether something runs is told by its process, never taken from a pid alone, as `KUVO_BOX=mac`
  // would have it: a stale record would hold the move back.)
  delete process.env.KUVO_BOX;
  const option = (name: string): string | undefined => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  const say = (value: unknown) => console.log(JSON.stringify(value));
  const waiting = () => console.error("Another move is under way: this one waits for it.");
  let home: string;
  try {
    home = homeOfRoot(root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error), USAGE);
    return 2;
  }
  const folders = () => ({ appFolder: appFolderOf(process.env.KUVO_HOME, home), home });
  const appFolder = (): string | null => { try { return folders().appFolder; } catch { return null; } };
  try {
    if (args.includes("--status")) {
      say(rehomeStatus(home));
      return 0;
    }
    // (A copy of the app, a demo's or a test's, never acts on the real one's move: only Kuvo Code
    // itself, or the box in that home.)
    const asked = process.env.KUVO_HOME ? path.resolve(process.env.KUVO_HOME) : null;
    if (located(home) === located(path.join(accountHome(), ".kuvo-code")) && asked && located(asked) !== located(home)
      && path.basename(path.dirname(asked)) !== "run.kuvo.code") {
      const why = "Only Kuvo Code itself moves the box in ~/.kuvo-code.";
      say(args.includes("--ready") ? { ready: false, how: null, why, status: rehomeStatus(home) } : { result: "refused", message: why, status: rehomeStatus(home) });
      return args.includes("--ready") ? 0 : EXIT.refused;
    }
    if (args.includes("--settled")) {
      const what = option("--settled");
      if (what !== "keychain" && what !== "agent") {
        console.error(USAGE);
        return 2;
      }
      say({ settled: settled(home, what), status: rehomeStatus(home) });
      return 0;
    }
    if (args.includes("--failed")) {
      const why = option("--failed");
      if (!why) {
        console.error(USAGE);
        return 2;
      }
      say({ noted: keeperFailed(home, why), status: rehomeStatus(home) });
      return 0;
    }
    if (args.includes("--new") && args.includes("--check")) {
      let answer: ReturnType<typeof newReadiness>;
      try { answer = newReadiness(folders(), { engineData: process.env.KUVO_ENGINE_DATA || undefined }); } catch (error) {
        answer = { ready: false, made: false, why: error instanceof Error ? error.message : String(error) };
      }
      say(answer);
      return 0;
    }
    if (args.includes("--ready")) {
      say(await rehomeReady(home, appFolder(), { appVersion: process.env.KUVO_APP_VERSION || null, release: option("--release") }));
      return 0;
    }
    // A machine's box (on Linux) is in its own home already.
    if (process.platform !== "darwin" && !args.includes("--resume")) {
      say({ result: "refused", message: NOTHING_TO_MOVE, status: rehomeStatus(home) });
      return 1;
    }
    const outcome = args.includes("--resume") ? await rehomeResume(home, { waiting })
      : args.includes("--back") ? await rehomeBack(home, { waiting })
      : args.includes("--new") ? await rehomeNew(folders(), { release: option("--release") ?? null, keepsAwakeOff: option("--keeps-awake") === "off", engineData: process.env.KUVO_ENGINE_DATA || undefined, waiting })
      : await rehome(folders(), { appVersion: process.env.KUVO_APP_VERSION || null, release: option("--release") ?? null, keepsAwakeOff: option("--keeps-awake") === "off", waiting });
    say(outcome);
    return EXIT[outcome.result];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // (Asked whether it's ready: not, saying why.)
    if (args.includes("--failed")) {
      const why = option("--failed");
      if (!why) {
        console.error(USAGE);
        return 2;
      }
      say({ noted: keeperFailed(home, why), status: rehomeStatus(home) });
      return 0;
    }
    if (args.includes("--new") && args.includes("--check")) {
      let answer: ReturnType<typeof newReadiness>;
      try { answer = newReadiness(folders(), { engineData: process.env.KUVO_ENGINE_DATA || undefined }); } catch (error) {
        answer = { ready: false, made: false, why: error instanceof Error ? error.message : String(error) };
      }
      say(answer);
      return 0;
    }
    if (args.includes("--ready")) {
      say({ ready: false, how: null, why: message, status: rehomeStatus(home) });
      return 0;
    }
    // (Something unforeseen: stuck where a move is under way, by its journal, which `here` says
    // too; else it never began, and the box where it was starts as it was.)
    const result = moveUnderWay(home) ? "stuck" : "failed";
    say({ result, message, status: rehomeStatus(home) });
    return EXIT[result];
  }
}
