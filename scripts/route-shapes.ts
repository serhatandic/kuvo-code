// What scripts/route-shapes.sh writes from Packages/Box/src/shared, so nothing it holds is kept by
// hand twice: each route's answers (Vectors/routes/shapes/answers.json), the scenario that holds
// each box's `kuvo/info` to its features (Vectors/routes/features.json), and the Mac app's list of
// them (KuvoCode/Stores/BoxFeatures.swift). Run as `bun scripts/route-shapes.ts <checkout> [--check]`.

import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const check = process.argv[3] === "--check";
const { ERROR, PASSED_ON, ROUTES } = await import(path.join(root, "Packages/Box/src/shared/routes/index.ts"));
const { FEATURES, MAC_BOX_FEATURES, MACHINE_FEATURES } = await import(path.join(root, "Packages/Box/src/shared/features.ts"));
const { MAC_FEATURES, MAC_FEATURES_AT_TIMES } = await import(path.join(root, "Packages/Box/src/shared/routes/mac.ts"));

// In order, as the box's own lists are (and Swift's `sorted()`): by UTF-16 code unit.
const inOrder = (names: readonly string[]): string[] => [...new Set(names)].sort();

/** What this Mac answers at all times: every box's names but a machine's own, and the Mac's. */
const macFeatures = inOrder([...MAC_BOX_FEATURES, ...MAC_FEATURES.filter((name: string) => !MAC_FEATURES_AT_TIMES.includes(name))]);

const answers = (): string => {
  const about = "What each route of a box answers (scripts/route-shapes.sh writes it from Packages/Box/src/shared/routes; never edit it): its JSON by status, or \"bytes\". A shape is \"string\", \"number\", \"bool\", \"null\", \"any\", {list}, {map}, {object} (those fields and no others; a name ending in ? may be left out), {oneOf} or {literal}. A refusal (400 and over) in JSON is `error`, unless its route has a shape of its own for that status; what starts with a `passedOn` path is the engine's or the agents bridge's own.";
  return JSON.stringify({ about, error: ERROR, passedOn: PASSED_ON, routes: ROUTES }, null, 1) + "\n";
};

const features = (): string => {
  const about = "What each box answers, by name (scripts/route-shapes.sh writes it from Packages/Box/src/shared/features.ts and routes/mac.ts; never edit it): a machine every name in FEATURES, in order, and nothing else; a Mac all of them but a machine's own (MACHINE_FEATURES), and its own (MAC_FEATURES), `usage` only while it has the usage panel.";
  const scenario = {
    name: "kuvo/info: what the box answers, by name, not by version",
    steps: [{
      send: "GET kuvo/info",
      why: "A client checks `features` before it shows what needs a route: both boxes name what they both answer the same way; only a machine updates itself and starts an engine an older Mac's Stop left down; only a Mac has Settings › Machines, its phones' hosts, While Agents Work, and Claude Code's agents and commands (every box says which of its sign-ins ended).",
      expect: {
        mac: { status: 200, json: { features: { "<includes>": macFeatures, "<excludes>": inOrder(MACHINE_FEATURES) } } },
        machine: { status: 200, json: { features: inOrder(FEATURES) } },
      },
    }],
  };
  return JSON.stringify({ about, scenarios: [scenario] }, null, 1) + "\n";
};

const swift = (): string => [
  "// Written by scripts/route-shapes.sh from Packages/Box/src/shared/features.ts and routes/mac.ts:",
  "// never edit it. Change those, then run it (CI checks this is what they write).",
  "",
  "/// What this Mac answers (PROTOCOL.md, \"Features\"), one name per route or group of routes a",
  "/// client might check: every box's but a machine's own (`MACHINE_FEATURES`), and the Mac's own",
  "/// (`MAC_FEATURES`). PhoneLink adds `usage` while the usage panel is.",
  "enum BoxFeatures {",
  "    static let mac = [",
  ...macFeatures.map(name => `        ${JSON.stringify(name)},`),
  "    ]",
  "}",
  "",
].join("\n");

const files: [string, () => string][] = [
  ["Packages/KuvoLink/Vectors/routes/shapes/answers.json", answers],
  ["Packages/KuvoLink/Vectors/routes/features.json", features],
  ["KuvoCode/Stores/BoxFeatures.swift", swift],
];

let stale = 0;
for (const [file, write] of files) {
  const where = path.join(root, file);
  const text = write();
  if (check) {
    let kept: string | null = null;
    try { kept = fs.readFileSync(where, "utf8"); } catch {}
    if (kept === text) continue;
    console.error(`${file} isn't what Packages/Box/src/shared writes: run ./scripts/route-shapes.sh and commit it.`);
    stale++;
    continue;
  }
  fs.mkdirSync(path.dirname(where), { recursive: true });
  fs.writeFileSync(where, text);
  console.log(`Wrote ${file}`);
}
process.exit(stale ? 1 : 0);
