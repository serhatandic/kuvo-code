// Which engine a machine's keeper starts (`bin/kuvo-start`'s `keep` and `engine`): the version its
// script names (`V=`) while that one is there, else the newest there is. The coding agents' bridge
// makes way for a newer bundle only while it runs on that engine (renewal.ts), and the box says
// whether its engine is behind it (`kuvo/info`'s `pieces`): the same answer for both.

import fs from "node:fs";
import path from "node:path";

/** `a` against `b`, as `sort -t. -k1,1n -k2,2n -k3,3n` orders them (each number in turn). */
function byNumbers(a: string, b: string): number {
  const [x, y] = [a, b].map(version => version.split(".").map(part => parseInt(part, 10) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** The engine versions there (`engine/<version>/opencode`), oldest first. */
export function enginesThere(root: string): string[] {
  return enginesIn(path.join(root, "engine"));
}

/** The engine versions in a folder of them (`<version>/opencode`), oldest first. */
export function enginesIn(folder: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(folder); } catch {}
  const runs = (name: string) => { try { fs.accessSync(path.join(folder, name, "opencode"), fs.constants.X_OK); return true; } catch { return false; } };
  // (As the keeper looks for them: `[ -x … ]`.)
  return names.filter(name => !name.startsWith(".") && runs(name)).sort(byNumbers);
}

/** The engine the keeper in `root` starts, or null (none there). */
export function keeperEngine(root: string): string | null {
  let named: string | undefined;
  try { named = /^V=([0-9][0-9A-Za-z.+-]*)$/m.exec(fs.readFileSync(path.join(root, "bin", "kuvo-start"), "utf8"))?.[1]; } catch {}
  const there = enginesThere(root);
  return named && there.includes(named) ? named : there.at(-1) ?? null;
}
