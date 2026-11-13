// `kuvo-link.js rehome <root> …` (PROTOCOL.md, "Moving this Mac's box"): what the keeper runs, with
// the old box stopped. One JSON line on stdout; exit 0 when it did (or there was nothing to do), 1
// when it was refused or failed (and went back), 2 for a command it doesn't know.
//
//   rehome <root> [--release <folder>] [--keeps-awake on|off]   the move (KUVO_HOME the app's box)
//   rehome <root> --ready [--release <folder>]                  whether to move (or finish one) now
//   rehome <root> --resume                                      one that stopped part way, finished
//   rehome <root> --back                                        moved back into the app's folder
//   rehome <root> --status                                      how it stands (`kuvo/box/rehome`)
//   rehome <root> --settled keychain|agent                      what the app owed it, done

import { appFolderOf, homeOfRoot, NOTHING_TO_MOVE, rehome, rehomeBack, rehomeReady, rehomeResume, settled } from "./move";
import { rehomeStatus } from "./state";

const USAGE = "Usage: kuvo-link.js rehome <root> [--release <folder>] [--keeps-awake on|off] | --ready | --resume | --back | --status | --settled keychain|agent";

export async function rehomeCommand(root: string | undefined, args: string[]): Promise<number> {
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
    if (args.includes("--settled")) {
      const what = option("--settled");
      if (what !== "keychain" && what !== "agent") {
        console.error(USAGE);
        return 2;
      }
      say({ settled: settled(home, what), status: rehomeStatus(home) });
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
      : await rehome(folders(), { appVersion: process.env.KUVO_APP_VERSION || null, release: option("--release") ?? null, keepsAwakeOff: option("--keeps-awake") === "off", waiting });
    say(outcome);
    return outcome.result === "refused" || outcome.result === "failed" || outcome.result === "waits" ? 1 : 0;
  } catch (error) {
    // (Past the point it goes back from: `--resume` carries it on.)
    say({ result: "failed", message: error instanceof Error ? error.message : String(error), status: rehomeStatus(home) });
    return 1;
  }
}
