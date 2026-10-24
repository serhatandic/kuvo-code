// @bun
// Agents/src/main.ts
import { mkdirSync as mkdirSync15, readdirSync as readdirSync8, readFileSync as readFileSync18, renameSync as renameSync7, rmSync as rmSync12, writeFileSync as writeFileSync13 } from "fs";
import { join as join19 } from "path";

// Agents/src/accounts.ts
import { randomBytes } from "crypto";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "fs";
import { join as join2 } from "path";

// Agents/src/machine.ts
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
var onMachine = process.env.KUVO_AGENTS_REMOTE === "1";
var machineHome = process.env.KUVO_HOME;
var ownFolders = {};
function takeOwnFolders() {
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("KUVO_OWN_"))
      continue;
    const name = key.slice("KUVO_OWN_".length);
    if (name)
      ownFolders[name] = process.env[key] || undefined;
    delete process.env[key];
  }
}
function withOwnFolders(env) {
  if (!onMachine)
    return env;
  const result = { ...env };
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    if (!(name in ownFolders))
      continue;
    if (ownFolders[name])
      result[name] = ownFolders[name];
    else
      delete result[name];
  }
  return result;
}
function ownEnvironment() {
  return onMachine ? { ...ownFolders } : {};
}
function ownFoldersScript(folder) {
  const names = Object.keys(ownFolders);
  if (!names.length)
    return;
  const quoted = (value) => "'" + value.replace(/'/g, `'\\''`) + "'";
  const text = names.map((name) => ownFolders[name] ? `export ${name}=${quoted(ownFolders[name])}` : `unset ${name}`).join(`
`) + `
`;
  const file = join(folder, "own-folders.sh");
  try {
    if (readFileSync(file, "utf8") === text)
      return file;
  } catch {}
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, text, { mode: 384 });
  return file;
}
function ownFoldersConfig() {
  const config = {};
  const unset = [];
  for (const [name, value] of Object.entries(ownFolders)) {
    if (value)
      config[`shell_environment_policy.set.${name}`] = value;
    else
      unset.push(name);
  }
  if (unset.length)
    config["shell_environment_policy.exclude"] = unset;
  return config;
}
function dropOwnPrograms(runtime) {
  for (const agent of ["codex", "grok"])
    rmSync(join(runtime, agent), { recursive: true, force: true });
  const scope = join(runtime, "claude", "node_modules", "@anthropic-ai");
  try {
    for (const name of readdirSync(scope))
      if (name.startsWith("claude-agent-sdk-linux-"))
        rmSync(join(scope, name), { recursive: true, force: true });
  } catch {}
}
function dropCarriedSignIns(home) {
  const visit = (folder, depth) => {
    let names = [];
    try {
      names = readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(folder, name);
      if (name.endsWith(".from-mac")) {
        rmSync(path.slice(0, -".from-mac".length), { force: true });
        rmSync(path, { force: true });
      } else if (depth < 5 && name !== "runtime" && name !== "sessions" && name !== "snapshots") {
        try {
          if (statSync(path).isDirectory())
            visit(path, depth + 1);
        } catch {}
      }
    }
  };
  visit(home, 0);
}

// Agents/src/accounts.ts
var kinds = ["claude", "codex", "cursor", "grok", "antigravity"];
var baseProvider = {
  claude: "claude-code",
  codex: "codex-cli",
  cursor: "cursor",
  grok: "grok-cli",
  antigravity: "antigravity"
};
function providerID(kind, id) {
  return id === "default" ? baseProvider[kind] : `${baseProvider[kind]}@${id}`;
}
function parseProvider(provider) {
  const [base, id] = provider.split("@", 2);
  const kind = kinds.find((kind2) => baseProvider[kind2] === base);
  if (!kind)
    return;
  return { kind, id: id ?? "default" };
}

class Accounts {
  root;
  records = [];
  constructor(root) {
    this.root = root;
    try {
      const saved = JSON.parse(readFileSync2(this.file, "utf8"));
      this.records = saved.filter((record) => kinds.includes(record.kind) && record.id && record.id !== "default");
    } catch {}
  }
  get file() {
    return join2(this.root, "accounts.json");
  }
  all() {
    return [...kinds.map((kind) => ({ kind, id: "default" })), ...this.records];
  }
  home(record) {
    if (record.id !== "default")
      return join2(this.root, record.kind, "accounts", record.id);
    if (!onMachine || !["claude", "codex", "grok"].includes(record.kind))
      return;
    const home = join2(this.root, record.kind, "home");
    mkdirSync2(home, { recursive: true, mode: 448 });
    return home;
  }
  add(kind, label) {
    const record = { kind, id: randomBytes(4).toString("hex"), label: label?.trim() || undefined };
    mkdirSync2(this.home(record), { recursive: true, mode: 448 });
    this.records.push(record);
    this.save();
    return record;
  }
  rename(provider, label) {
    const parsed = parseProvider(provider);
    const record = this.records.find((record2) => record2.kind === parsed?.kind && record2.id === parsed?.id);
    if (!record)
      return;
    record.label = label?.trim() || undefined;
    this.save();
  }
  remove(provider) {
    const parsed = parseProvider(provider);
    const index = this.records.findIndex((record2) => record2.kind === parsed?.kind && record2.id === parsed?.id);
    if (index < 0)
      return;
    const [record] = this.records.splice(index, 1);
    this.save();
    rmSync2(this.home(record), { recursive: true, force: true });
    return record;
  }
  save() {
    mkdirSync2(this.root, { recursive: true });
    writeFileSync2(this.file + ".new", JSON.stringify(this.records, null, 2));
    renameSync(this.file + ".new", this.file);
  }
}

// Agents/src/auto.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync2, writeFileSync as writeFileSync3 } from "fs";
import { join as join3 } from "path";

// Agents/src/ids.ts
var alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
var last = { timestamp: 0, counter: 0 };
function ascending() {
  const timestamp = Date.now();
  if (last.timestamp !== timestamp)
    last = { timestamp, counter: 0 };
  last.counter += 1;
  const value = BigInt(timestamp) * 0x1000n + BigInt(last.counter) & 0xffffffffffffn;
  const time = value.toString(16).padStart(12, "0");
  let random = "";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  for (const byte of bytes)
    random += alphabet[byte % alphabet.length];
  return time + random;
}
var newID = (prefix) => `${prefix}_${ascending()}`;
var messageID = (eventID) => "msg_" + eventID.slice("evt_".length);

// Agents/src/events.ts
var listeners = new Set;
function emit(type, data, directory) {
  const event = { id: newID("evt"), type, created: Date.now(), data };
  if (directory)
    event.location = { directory };
  for (const listener of listeners)
    listener(event);
  return event;
}
function feed() {
  const encoder = new TextEncoder;
  let listener;
  let heartbeat;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}

`));
        } catch {
          stop();
        }
      };
      const stop = () => {
        if (listener)
          listeners.delete(listener);
        if (heartbeat)
          clearInterval(heartbeat);
        listener = undefined;
        heartbeat = undefined;
      };
      send({ id: newID("evt"), type: "server.connected", created: Date.now(), data: {} });
      listener = send;
      listeners.add(send);
      heartbeat = setInterval(() => send({ id: newID("evt"), type: "server.heartbeat", created: Date.now(), data: {} }), 15000);
    },
    cancel() {
      if (listener)
        listeners.delete(listener);
      if (heartbeat)
        clearInterval(heartbeat);
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }
  });
}

// Agents/src/auto.ts
var autoProvider = "auto";
var firstList = "auto";
var unknownReset = 30 * 60000;
var briefReset = 3 * 60000;

class Auto {
  root;
  lists = [{ id: firstList, name: "Custom Auto", entries: [] }];
  held = [];
  constructor(root) {
    this.root = root;
    try {
      const saved = JSON.parse(readFileSync3(this.file, "utf8"));
      const lists = Array.isArray(saved.lists) ? saved.lists : [{ id: firstList, name: "Custom Auto", entries: saved.entries ?? [] }];
      const read = Auto.clean(lists);
      if (read.length)
        this.lists = read;
      this.held = (saved.limits ?? []).filter((held) => held?.key && held.until > Date.now());
    } catch {}
    this.schedule();
  }
  expiry;
  schedule() {
    clearTimeout(this.expiry);
    if (!this.held.length)
      return;
    const next = Math.min(...this.held.map((held) => held.until));
    this.expiry = setTimeout(() => {
      this.prune();
      emit("kuvo.auto.updated", {});
      this.schedule();
    }, Math.min(Math.max(next - Date.now(), 0) + 500, 2 ** 31 - 1));
    this.expiry.unref?.();
  }
  static clean(lists) {
    const seen = new Set;
    return lists.filter((list) => list && typeof list.id === "string" && /^[\w-]{1,64}$/.test(list.id) && !seen.has(list.id) && seen.add(list.id)).map((list) => ({
      id: list.id,
      name: typeof list.name === "string" && list.name.trim() ? list.name.trim().slice(0, 60) : "Custom Auto",
      entries: (Array.isArray(list.entries) ? list.entries : []).filter((entry) => entry && typeof entry.providerID === "string" && typeof entry.modelID === "string" && entry.providerID !== autoProvider).map((entry) => ({ providerID: entry.providerID, modelID: entry.modelID, ...entry.variant ? { variant: entry.variant } : {} }))
    }));
  }
  get file() {
    return join3(this.root, "auto.json");
  }
  list(id) {
    const list = this.lists.find((list2) => list2.id === id) ?? this.lists[0];
    return (list?.entries ?? []).map((entry) => ({ ...entry }));
  }
  all() {
    return this.lists.map((list) => ({ ...list, entries: list.entries.map((entry) => ({ ...entry })) }));
  }
  set(entries) {
    const [first, ...rest] = this.lists;
    this.lists = [...Auto.clean([{ ...first, entries }]), ...rest];
    this.save();
  }
  setLists(lists) {
    const kept = Auto.clean(lists);
    if (!kept.length)
      throw new Error("Keep one list at least.");
    this.lists = kept;
    this.save();
  }
  limits() {
    this.prune();
    return this.held.map((held) => ({ ...held }));
  }
  clearLimits() {
    this.held = [];
    this.save();
    this.schedule();
  }
  release(providerID2) {
    const before = this.held.length;
    this.held = this.held.filter((held) => held.key !== providerID2 && !held.key.startsWith(providerID2 + "/"));
    if (this.held.length === before)
      return false;
    this.save();
    this.schedule();
    return true;
  }
  prune() {
    const before = this.held.length;
    this.held = this.held.filter((held) => held.until > Date.now());
    if (this.held.length !== before)
      this.save();
  }
  static providerKey(providerID2) {
    return providerID2;
  }
  static modelKey(entry) {
    return `${entry.providerID}/${entry.modelID}`;
  }
  isHeld(entry) {
    this.prune();
    return this.held.find((held) => held.key === Auto.providerKey(entry.providerID) || held.key === Auto.modelKey(entry));
  }
  hold(entry, limit) {
    const key = limit.scope === "provider" ? Auto.providerKey(entry.providerID) : Auto.modelKey(entry);
    const known = Boolean(limit.resetsAt && limit.resetsAt > Date.now());
    const until = known ? limit.resetsAt : Date.now() + (limit.brief ? briefReset : unknownReset);
    this.held = this.held.filter((held) => held.key !== key);
    this.held.push({ key, until, scope: limit.scope, known });
    this.save();
    this.schedule();
  }
  save() {
    mkdirSync3(this.root, { recursive: true });
    writeFileSync3(this.file + ".new", JSON.stringify({ lists: this.lists, limits: this.held }, null, 2));
    renameSync2(this.file + ".new", this.file);
  }
}
function resetsIn(text, now = Date.now()) {
  const found = text?.match(/(?:resets?|try again|available again)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i);
  if (!found)
    return;
  const units = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
  let total = 0;
  for (const part of found[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi))
    total += Number(part[1]) * (units[part[2].toLowerCase()] ?? 0);
  return total > 0 ? now + Math.min(total, 31 * 86400000) : undefined;
}
function zone() {
  const name = process.env.KUVO_TZ;
  if (!name)
    return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return;
  }
}
function resetTime(at) {
  const timeZone = zone();
  const day = (date2) => date2.toLocaleDateString("en-US", { timeZone });
  const date = new Date(at);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  if (day(date) === day(new Date))
    return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })}, ${time}`;
}

// Agents/src/deps.ts
import { existsSync, mkdirSync as mkdirSync4, readFileSync as readFileSync4, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "fs";
import { join as join4 } from "path";
var installing = new Map;

class Deps {
  root;
  cache;
  constructor(root, cache) {
    this.root = root;
    this.cache = cache;
  }
  folder(agent) {
    return join4(this.root, agent);
  }
  has(agent, packages) {
    return packages.every((pkg) => installedVersion(this.folder(agent), pkg.name) === pkg.version);
  }
  async ensure(agent, packages, options = {}) {
    const folder = this.folder(agent);
    if (this.has(agent, packages))
      return folder;
    let pending = installing.get(agent);
    if (!pending) {
      pending = this.install(folder, packages, options.optional ?? true).finally(() => installing.delete(agent));
      installing.set(agent, pending);
    }
    await pending;
    return folder;
  }
  async install(folder, packages, optional) {
    mkdirSync4(folder, { recursive: true });
    const manifest = { name: "kuvo-agents-runtime", private: true, dependencies: Object.fromEntries(packages.map((pkg) => [pkg.name, pkg.version])) };
    writeFileSync4(join4(folder, "package.json"), JSON.stringify(manifest, null, 2));
    const args = [process.execPath, "install", "--no-save", "--no-progress", "--silent"];
    if (!optional)
      args.push("--omit", "optional");
    const child = Bun.spawn(args, {
      cwd: folder,
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
        BUN_INSTALL: this.cache,
        BUN_INSTALL_CACHE_DIR: join4(this.cache, "install")
      },
      stdout: "pipe",
      stderr: "pipe"
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (installing.size <= 1)
      rmSync3(join4(this.cache, "install"), { recursive: true, force: true });
    if (code !== 0)
      throw new Error(`Couldn't download what the agent needs (${packages.map((pkg) => pkg.name).join(", ")}): ${stderr.trim().slice(-400)}`);
  }
  reset(agent) {
    rmSync3(this.folder(agent), { recursive: true, force: true });
  }
  async load(agent, name) {
    const entry = Bun.resolveSync(name, this.folder(agent));
    return await import(entry);
  }
}
function installedVersion(folder, name) {
  const file = join4(folder, "node_modules", name, "package.json");
  if (!existsSync(file))
    return;
  try {
    return JSON.parse(readFileSync4(file, "utf8")).version;
  } catch {
    return;
  }
}

// Agents/src/engine.ts
import { readFileSync as readFileSync5 } from "fs";
import { join as join5 } from "path";

// Agents/src/agent.ts
class ContextWindows {
  sizes = new Map;
  get(model) {
    return this.sizes.get(model);
  }
  note(model, size) {
    if (typeof size !== "number" || !(size > 0) || this.sizes.get(model) === size)
      return false;
    this.sizes.set(model, size);
    return true;
  }
}
function model(providerID2, id, name, options = {}) {
  return {
    id,
    providerID: providerID2,
    name,
    family: options.family,
    capabilities: { tools: true, input: options.images ? ["text", "image"] : ["text"], output: ["text"] },
    variants: (options.variants ?? []).map((id2) => ({ id: id2 })),
    time: { released: options.released ?? 0 },
    cost: [{ input: 0, output: 0 }],
    status: "active",
    enabled: true,
    limit: { context: options.context ?? 200000, output: 32000 }
  };
}
function accountName(name, account) {
  if (account.id === "default")
    return name;
  return `${name} \xB7 ${account.label ?? "Another account"}`;
}
function failure(error, type = "agent") {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
  return { type, message: message || "The agent stopped with an error." };
}

// Agents/src/engine.ts
class EngineLink {
  url;
  authorization;
  generation = 0;
  listeners = new Map;
  children = new Map;
  names = new Map;
  catalog;
  get ready() {
    return Boolean(this.url);
  }
  configure(url, password) {
    const authorization = password ? "Basic " + Buffer.from(`opencode:${password}`).toString("base64") : undefined;
    if (url === this.url && authorization === this.authorization)
      return;
    this.url = url?.replace(/\/$/, "");
    this.authorization = authorization;
    this.names.clear();
    this.catalog = undefined;
    this.reads.clear();
    const generation = ++this.generation;
    if (this.url)
      this.feed(generation);
    for (const set of this.listeners.values())
      for (const listener of set)
        listener.reconnected();
  }
  async request(method, path, body, timeout = 30000, directory) {
    if (!this.url)
      throw new Error("The engine isn't running.");
    const response = await fetch(this.url + path, {
      method,
      headers: {
        Authorization: this.authorization ?? "",
        ...body === undefined ? {} : { "Content-Type": "application/json" },
        ...directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      value = text;
    }
    if (!response.ok) {
      const error = new EngineError(value?.message ?? `The engine answered ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return value;
  }
  providerName(providerID2) {
    if (!this.names.size && this.url) {
      this.names.set("", "");
      this.request("GET", "/api/provider").then((answer) => {
        for (const provider of answer?.data ?? [])
          if (provider?.id && provider?.name)
            this.names.set(provider.id, provider.name);
        if (this.names.size === 1)
          this.names.clear();
      }).catch(() => this.names.clear());
    }
    return this.names.get(providerID2);
  }
  reads = new Map;
  async read(path, directory, usable = () => true, fresh = false) {
    const key = `${path}
${directory}`;
    const kept = this.reads.get(key);
    if (!this.url)
      return kept?.value;
    if (!fresh && kept && Date.now() - kept.at < (kept.failed ? 1e4 : 30000))
      return kept.value;
    if (kept?.pending)
      return kept.pending;
    const generation = this.generation;
    const keep = (entry) => {
      if (generation === this.generation)
        this.reads.set(key, entry);
    };
    const pending = this.request("GET", path, undefined, 4000, directory).then((value) => {
      if (usable(value))
        keep({ at: Date.now(), value });
      else
        keep({ at: 0, value: kept?.value });
      return usable(value) ? value : kept?.value;
    }, () => {
      keep({ at: Date.now(), value: kept?.value, failed: true });
      return kept?.value;
    });
    this.reads.set(key, { at: 0, value: kept?.value, pending });
    return pending;
  }
  async settingsFiles(directory) {
    const answer = await this.read("/api/config", directory);
    if (answer === undefined)
      return;
    return Array.isArray(answer) ? answer : Array.isArray(answer?.data) ? answer.data : [{ info: answer?.data ?? answer }];
  }
  async agent(name, directory) {
    const usable = (value) => Array.isArray(value?.data) && value.data.length > 0;
    const named = (value) => (value?.data ?? []).find((agent) => agent?.id === name || agent?.name === name);
    let answer = await this.read("/api/agent", directory, usable);
    if (answer !== undefined && !named(answer))
      answer = await this.read("/api/agent", directory, usable, true);
    if (answer === undefined)
      return name === "build" || name === "plan" ? undefined : { system: await this.agentPrompt(name, directory) };
    const found = named(answer);
    if (!found)
      return;
    return { system: typeof found.system === "string" && found.system.trim() ? found.system.trim() : undefined, permissions: Array.isArray(found.permissions) ? found.permissions : undefined };
  }
  async policies(directory) {
    const files = await this.settingsFiles(directory);
    if (!files)
      return;
    const policies = files.flatMap((source) => Array.isArray(source?.info?.policies) ? source.info.policies : []);
    const rules = [];
    for (const policy of policies) {
      if (policy?.action !== "tool.use" || typeof policy.resource !== "string")
        continue;
      if (policy.effect !== "deny" && policy.effect !== "allow")
        continue;
      const at = policy.resource.indexOf(":");
      rules.push({ action: at < 0 ? policy.resource : policy.resource.slice(0, at), resource: at < 0 ? "*" : policy.resource.slice(at + 1) || "*", effect: policy.effect });
    }
    return rules;
  }
  async titleModel(directory) {
    let picked;
    for (const source of await this.settingsFiles(directory) ?? []) {
      const own = source?.info?.agents?.title?.model ?? source?.info?.agent?.title?.model;
      if (typeof own === "string" && own.includes("/"))
        picked = own;
    }
    if (!picked)
      return;
    const at = picked.indexOf("/");
    return { providerID: picked.slice(0, at), id: picked.slice(at + 1) };
  }
  async commandTemplate(name, directory) {
    let template;
    for (const source of await this.settingsFiles(directory) ?? []) {
      const own = source?.info?.commands?.[name]?.template ?? source?.info?.command?.[name]?.template;
      if (typeof own === "string" && own.trim())
        template = own;
      if (source?.type === "directory" && typeof source.path === "string" && /^[\w.-]+(\/[\w.-]+)*$/.test(name) && !name.split("/").includes("..")) {
        for (const folder of ["command", "commands"]) {
          try {
            const text = readFileSync5(join5(source.path, folder, `${name}.md`), "utf8");
            const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
            if (body)
              template = body;
          } catch {}
        }
      }
    }
    return template;
  }
  async agentPrompt(name, directory) {
    let prompt;
    for (const source of await this.settingsFiles(directory) ?? []) {
      const own = source?.info?.agents?.[name]?.system ?? source?.info?.agent?.[name]?.prompt;
      if (typeof own === "string" && own.trim())
        prompt = own.trim();
    }
    return prompt;
  }
  async offered(providerID2, fresh = false) {
    if (!this.url)
      return;
    if (fresh || !this.catalog || Date.now() - this.catalog.at > 60000) {
      try {
        const [providers, models] = await Promise.all([this.request("GET", "/api/provider"), this.request("GET", "/api/model")]);
        const ready = new Set((providers?.data ?? []).map((provider) => provider.id));
        if (!ready.size)
          return { ready: false, models: [] };
        this.catalog = { at: Date.now(), ready, models: models?.data ?? [] };
      } catch {
        return;
      }
    }
    return { ready: this.catalog.ready.has(providerID2), models: this.catalog.models.filter((model2) => model2.providerID === providerID2), listed: true };
  }
  listen(sessionID, listener) {
    let set = this.listeners.get(sessionID);
    if (!set)
      this.listeners.set(sessionID, set = new Set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size)
        this.listeners.delete(sessionID);
      for (const [child, parent] of this.children)
        if (parent === sessionID)
          this.children.delete(child);
    };
  }
  dispatch(event) {
    const data = event.data ?? {};
    if (event.type === "session.created") {
      const session = data.session ?? data.info;
      const child = data.sessionID ?? session?.id;
      const parent = data.parentID ?? session?.parentID;
      if (child && parent && (this.listeners.has(parent) || this.children.has(parent)))
        this.children.set(child, this.children.get(parent) ?? parent);
      return;
    }
    let sessionID = data.sessionID ?? data.form?.sessionID;
    if (!sessionID)
      return;
    sessionID = this.children.get(sessionID) ?? sessionID;
    for (const listener of this.listeners.get(sessionID) ?? [])
      listener.event(event);
  }
  async feed(generation) {
    let first = true;
    while (generation === this.generation && this.url) {
      try {
        const response = await fetch(this.url + "/api/event", { headers: { Authorization: this.authorization ?? "", Accept: "text/event-stream" } });
        if (!response.ok || !response.body)
          throw new Error(`feed ${response.status}`);
        if (!first)
          for (const set of this.listeners.values())
            for (const listener of set)
              listener.reconnected();
        first = false;
        const reader = response.body.getReader();
        const decoder = new TextDecoder;
        let buffer = "";
        while (generation === this.generation) {
          const read = await Promise.race([reader.read(), new Promise((done) => setTimeout(() => done("quiet"), 45000))]);
          if (read === "quiet" || read.done)
            break;
          buffer += decoder.decode(read.value, { stream: true });
          let end;
          while ((end = buffer.indexOf(`

`)) >= 0) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = chunk.split(`
`).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join(`
`);
            if (!data)
              continue;
            try {
              this.dispatch(JSON.parse(data));
            } catch {}
          }
        }
        await reader.cancel().catch(() => {});
      } catch {}
      if (generation !== this.generation)
        return;
      first = false;
      await Bun.sleep(1000);
    }
  }
}

class EngineError extends Error {
  status;
}

class EngineAgent {
  link;
  providerID;
  id = "engine";
  instance = { id: "default" };
  constructor(link, providerID2) {
    this.link = link;
    this.providerID = providerID2;
  }
  get name() {
    return this.link.providerName(this.providerID) || this.providerID;
  }
  methods() {
    return [];
  }
  async account() {
    const offered = await this.link.offered(this.providerID);
    return { installed: true, signedIn: this.link.ready && (offered?.ready ?? true) };
  }
  async signedOut() {
    const cached = await this.link.offered(this.providerID).catch(() => {
      return;
    });
    if (!(cached?.listed === true && !cached.ready))
      return false;
    const offered = await this.link.offered(this.providerID, true).catch(() => {
      return;
    });
    return offered?.listed === true && !offered.ready;
  }
  async models() {
    return (await this.link.offered(this.providerID))?.models ?? [];
  }
  thread(session, state) {
    return new EngineThread(this.link, session, state);
  }
  async generate(prompt, model2) {
    const answer = await this.link.request("POST", "/api/experimental/generate", { prompt, model: { providerID: model2.providerID, id: model2.id } }, 120000);
    return answer?.data?.text ?? "";
  }
  async forgetConversation(state) {
    const id = state.engineSession;
    if (id)
      await this.link.request("DELETE", `/api/session/${encodeURIComponent(id)}`).catch(() => {});
  }
}
var outputLimit = 64000;

class EngineThread {
  link;
  session;
  state;
  stop;
  constructor(link, session, state) {
    this.link = link;
    this.session = session;
    this.state = state;
  }
  async engineSession(input, hooks) {
    const existing = this.state.engineSession;
    if (existing) {
      try {
        await this.link.request("GET", `/api/session/${encodeURIComponent(existing)}`);
        return existing;
      } catch (error) {
        if (error.status !== 404)
          throw error;
      }
    }
    const created = await this.link.request("POST", "/api/session", {
      title: this.session.title ? `Kuvo Code: ${this.session.title}` : "Kuvo Code",
      location: { directory: this.session.location.directory },
      model: input.model,
      agent: input.plan ? "plan" : this.session.agent ?? "build",
      permissions: this.session.permissions ?? [],
      metadata: { kuvo: { engineFor: this.session.id } }
    });
    const id = created?.data?.id;
    if (!id)
      throw new Error("The engine didn't start a session.");
    if (existing)
      this.startedOver = true;
    this.state.engineSession = id;
    delete this.state.engineInstructions;
    hooks.saveState();
    return id;
  }
  startedOver = false;
  async prepare(input, hooks) {
    if (!this.link.ready)
      return;
    await this.engineSession(input, hooks);
    const fresh = this.startedOver;
    this.startedOver = false;
    return { fresh };
  }
  async run(input, turn, hooks) {
    if (!this.link.ready)
      return { outcome: "failed", error: { type: "engine", message: "The engine isn't running: wait for it to start, or restart Kuvo Code." } };
    const id = await this.engineSession(input, hooks);
    const path = `/api/session/${encodeURIComponent(id)}`;
    await this.link.request("PATCH", path, { permissions: this.session.permissions ?? [] });
    await this.link.request("POST", `${path}/model`, { model: input.model });
    await this.link.request("POST", `${path}/agent`, { agent: input.plan ? "plan" : this.session.agent ?? "build" });
    const instructions = hooks.instructions(false);
    if (instructions !== (this.state.engineInstructions ?? "")) {
      if (instructions)
        await this.link.request("PUT", `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/kuvo`, { value: instructions });
      else
        await this.link.request("DELETE", `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/kuvo`).catch(() => {});
      this.state.engineInstructions = instructions;
      hooks.saveState();
    }
    const active = await this.link.request("GET", "/api/session/active").catch(() => {
      return;
    });
    if (active?.data?.[id])
      await this.link.request("POST", `${path}/interrupt`).catch(() => {});
    const inputID = newID("msg");
    const sentAt = Date.now();
    let step;
    let delivered = false;
    let limit;
    const shells = new Map;
    const stopShell = (tool) => {
      clearInterval(shells.get(tool));
      shells.delete(tool);
    };
    let settle;
    const settled = new Promise((resolve) => settle = resolve);
    let done = false;
    const finish = (result) => {
      if (done)
        return;
      done = true;
      settle(result);
    };
    const interrupt = async () => {
      await this.link.request("POST", `${path}/interrupt`).catch(() => {});
      setTimeout(() => finish({ outcome: "interrupted" }), 1e4);
    };
    this.stop = interrupt;
    const answerPermission = async (data) => {
      const ask = {
        toolCallID: data.source?.id,
        action: data.action,
        resources: data.resources ?? [],
        save: data.save,
        metadata: data.metadata,
        message: data.message,
        weighed: true
      };
      let decision = "reject";
      try {
        decision = await hooks.permission(ask);
      } catch {}
      await this.link.request("POST", `/api/session/${encodeURIComponent(data.sessionID)}/permission/${encodeURIComponent(data.id)}/reply`, { decision }).catch(() => {});
    };
    const answerForm = async (form) => {
      let answer = null;
      try {
        answer = await hooks.question({ title: form.title ?? "A question", fields: form.fields ?? [] });
      } catch {}
      const formPath = `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(form.id)}`;
      if (answer)
        await this.link.request("POST", `${formPath}/reply`, { answer }).catch(() => {});
      else
        await this.link.request("DELETE", formPath).catch(() => {});
    };
    const followShell = (tool, shellID) => {
      if (shells.has(tool))
        return;
      let cursor = 0;
      let output = "";
      let reading = false;
      const read = async () => {
        if (reading)
          return;
        reading = true;
        try {
          const answer = await this.link.request("GET", `/api/shell/${encodeURIComponent(shellID)}/output?cursor=${cursor}`, undefined, 1e4, this.session.location.directory).catch(() => {
            return;
          });
          const more = String(answer?.data?.output ?? "");
          if (typeof answer?.data?.cursor === "number")
            cursor = answer.data.cursor;
          if (!more)
            return;
          output = (output + more).slice(-outputLimit);
          turn.toolProgress(tool, { output });
        } finally {
          reading = false;
        }
      };
      shells.set(tool, setInterval(read, 1000));
    };
    const onEvent = (event) => {
      const data = event.data;
      const ownSession = data.sessionID === id;
      switch (event.type) {
        case "permission.asked":
          answerPermission(data);
          return;
        case "form.created":
          if (data.form)
            answerForm(data.form);
          return;
      }
      if (!ownSession)
        return;
      switch (event.type) {
        case "session.inbox.delivered":
          if (data.inboxID === inputID)
            delivered = true;
          return;
        case "session.step.started":
          if (data.assistantMessageID === step)
            return;
          step = data.assistantMessageID;
          turn.startStep(data.model ?? input.model);
          return;
        case "session.text.started":
        case "session.reasoning.started": {
          const kind = event.type === "session.text.started" ? "text" : "reasoning";
          turn.blockStart(`${kind}-${data.ordinal ?? 0}`, kind);
          return;
        }
        case "session.text.delta":
        case "session.reasoning.delta": {
          const kind = event.type === "session.text.delta" ? "text" : "reasoning";
          turn.blockDelta(`${kind}-${data.ordinal ?? 0}`, kind, String(data.delta ?? ""));
          return;
        }
        case "session.text.ended":
        case "session.reasoning.ended":
          turn.blockEnd(`${event.type === "session.text.ended" ? "text" : "reasoning"}-${data.ordinal ?? 0}`);
          return;
        case "session.tool.input.started":
          turn.toolStart(data.id, data.name);
          return;
        case "session.tool.input.delta":
          turn.toolInputDelta(data.id, String(data.delta ?? ""));
          return;
        case "session.tool.called":
          turn.toolCalled(data.id, data.input);
          return;
        case "session.tool.progress": {
          const { shellID, ...rest } = data.metadata ?? {};
          if (typeof shellID === "string")
            followShell(data.id, shellID);
          if (Object.keys(rest).length)
            turn.toolProgress(data.id, rest);
          return;
        }
        case "session.tool.success": {
          stopShell(data.id);
          const { shellID: _, ...metadata } = data.metadata ?? {};
          turn.toolSucceeded(data.id, data.content ?? [], metadata);
          return;
        }
        case "session.tool.failed": {
          stopShell(data.id);
          const { shellID: _, ...metadata } = data.metadata ?? {};
          const error = data.error ?? {};
          turn.toolFailed(data.id, error.message ?? "", metadata, error.type ?? "tool");
          return;
        }
        case "session.step.ended":
        case "session.step.failed":
          if (data.assistantMessageID !== step)
            return;
          step = undefined;
          turn.endStep({ tokens: data.tokens, cost: data.cost, finish: data.finish, error: data.error });
          return;
        case "session.retry.scheduled": {
          const reached = limitOf(data.error);
          if (input.auto && reached) {
            limit = reached;
            interrupt();
          }
          return;
        }
        case "session.execution.succeeded":
          if (delivered)
            finish({ outcome: "succeeded" });
          return;
        case "session.execution.interrupted":
          if (delivered || limit)
            finish(limit ? { outcome: "failed", error: { type: "limit", message: "A usage limit was reached." }, limit, taken: delivered } : { outcome: "interrupted" });
          return;
        case "session.execution.failed": {
          const error = data.error ?? { type: "engine", message: "The engine stopped with an error." };
          finish({ outcome: "failed", error, limit: limit ?? limitOf(error), taken: delivered });
          return;
        }
      }
    };
    const onReconnected = async () => {
      if (done)
        return;
      const active2 = await this.link.request("GET", "/api/session/active").catch(() => {
        return;
      });
      if (active2?.data?.[id])
        return;
      const session = await this.link.request("GET", path).catch(() => {
        return;
      });
      const outcome = session?.data?.outcome;
      const idle = Number(session?.data?.time?.idle ?? 0);
      finish(outcome === "succeeded" && idle >= sentAt ? { outcome } : { outcome: "failed", error: { type: "engine", message: "The engine restarted during this message." } });
    };
    const unlisten = this.link.listen(id, { event: onEvent, reconnected: () => void onReconnected() });
    const abort = () => void interrupt();
    hooks.signal.addEventListener("abort", abort);
    try {
      await this.link.request("POST", `${path}/prompt`, {
        id: inputID,
        text: input.text,
        files: input.files.length ? input.files.map((file) => ({ uri: file.uri, name: file.name })) : undefined,
        delivery: "steer"
      });
      if (hooks.signal.aborted)
        interrupt();
      return await settled;
    } catch (error) {
      return { outcome: "failed", error: failure(error, "engine") };
    } finally {
      hooks.signal.removeEventListener("abort", abort);
      unlisten();
      for (const tool of [...shells.keys()])
        stopShell(tool);
      this.stop = undefined;
    }
  }
  async interrupt() {
    await this.stop?.();
  }
  close() {}
}
function limitOf(error) {
  if (!error)
    return;
  if (error.type === "provider.quota")
    return { scope: "provider", message: error.message };
  if (error.type === "provider.rate-limit")
    return { scope: "model", message: error.message };
  return;
}

// Agents/src/kuvotools.ts
import { spawn } from "child_process";
var server;
var program;
function setToolServer(value) {
  server = value;
}
var toolServerName = "kuvo-browser";
function setToolProgram(settings) {
  program = undefined;
  try {
    const entry = JSON.parse(settings ?? "")?.mcp?.servers?.[toolServerName];
    if (!Array.isArray(entry?.command) || !entry.command.length || !entry.command.every((part) => typeof part === "string"))
      return;
    const environment = {};
    for (const [name, value] of Object.entries(entry.environment ?? {}))
      if (typeof value === "string")
        environment[name] = value;
    program = { command: entry.command, environment, timeout: Number(entry.timeout?.execution) || 960000 };
  } catch {}
}
function kuvoTools(sessionID) {
  if (server)
    return { kind: "http", name: toolServerName, key: server.url, url: server.url, headers: { Authorization: `Bearer ${server.token}`, "X-Kuvo-Session": sessionID }, timeout: server.timeout };
  if (program) {
    const [command, ...args] = program.command;
    return { kind: "stdio", name: toolServerName, key: JSON.stringify(program), command, args, env: { ...program.environment, KUVO_SESSION: sessionID }, timeout: program.timeout };
  }
  return;
}
var schemas;
var loading;
function loadKuvoTools() {
  const tools = kuvoTools("");
  if (!tools || schemas?.key === tools.key)
    return Promise.resolve();
  loading ??= (async () => {
    try {
      const answer = tools.kind === "http" ? await listOverHTTP(tools) : await listFromProgram(tools);
      const found = new Map;
      for (const tool of answer?.result?.tools ?? [])
        if (typeof tool?.name === "string")
          found.set(tool.name, new Set(Object.keys(tool.inputSchema?.properties ?? {})));
      if (found.size)
        schemas = { key: tools.key, tools: found };
    } catch {}
  })().finally(() => loading = undefined);
  return loading;
}
async function listOverHTTP(tools) {
  const response = await fetch(tools.url, {
    method: "POST",
    headers: { ...tools.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    signal: AbortSignal.timeout(5000)
  });
  return response.json();
}
function listFromProgram(tools) {
  return new Promise((resolve, reject) => {
    const child = spawn(tools.command, tools.args, { env: { ...process.env, ...tools.env }, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => finish(new Error("Kuvo Code's tools didn't answer.")), 15000);
    let buffered = "";
    let done = false;
    function finish(result) {
      if (done)
        return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (result instanceof Error)
        reject(result);
      else
        resolve(result);
    }
    child.on("error", finish);
    child.on("exit", () => finish(new Error("Kuvo Code's tools stopped.")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf(`
`)) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message?.id === 2)
            return finish(message);
        } catch {}
      }
    });
    const write = (message) => child.stdin.write(JSON.stringify(message) + `
`);
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kuvo-agents", version: "1" } } });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}
function isKuvoTool(name) {
  return schemas ? schemas.tools.has(name) : undefined;
}
function kuvoToolName(name, args) {
  const known = schemas?.tools.get(name);
  if (!known)
    return;
  return Object.keys(args).every((key) => known.has(key)) ? `${toolServerName}_${name}` : undefined;
}

// Agents/src/snapshots.ts
import { createHash } from "crypto";
import { existsSync as existsSync2, lstatSync, mkdirSync as mkdirSync5, readdirSync as readdirSync2, readFileSync as readFileSync6, realpathSync, rmdirSync, rmSync as rmSync4, writeFileSync as writeFileSync5 } from "fs";
import { dirname, join as join7, relative, resolve, sep } from "path";

// Agents/src/diff.ts
var searchLimit = 2000;
function edits(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = [];
  for (let i = 0;i < start; i++)
    ops.push({ kind: " ", line: a[i] });
  for (const op of middle(a.slice(start, endA), b.slice(start, endB)))
    ops.push(op);
  for (let i = endA;i < a.length; i++)
    ops.push({ kind: " ", line: a[i] });
  return ops;
}
function middle(a, b) {
  const n = a.length;
  const m = b.length;
  const removed = () => a.map((line) => ({ kind: "-", line }));
  const added = () => b.map((line) => ({ kind: "+", line }));
  if (!n)
    return added();
  if (!m)
    return removed();
  const max = n + m;
  const limit = Math.min(max, searchLimit);
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  outer:
    for (let d = 0;d <= limit; d++) {
      trace.push(v.slice(max - d, max + d + 1));
      for (let k = -d;k <= d; k += 2) {
        let x2 = k === -d || k !== d && v[max + k - 1] < v[max + k + 1] ? v[max + k + 1] : v[max + k - 1] + 1;
        let y2 = x2 - k;
        while (x2 < n && y2 < m && a[x2] === b[y2]) {
          x2++;
          y2++;
        }
        v[max + k] = x2;
        if (x2 >= n && y2 >= m) {
          found = true;
          break outer;
        }
      }
    }
  if (!found)
    return [...removed(), ...added()];
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1;d >= 0; d--) {
    const t = trace[d];
    const at = (k2) => t[k2 + d];
    const k = x - y;
    const prevK = k === -d || k !== d && at(k - 1) < at(k + 1) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", line: a[--x] });
      y--;
    }
    if (d > 0) {
      if (x === prevX)
        ops.push({ kind: "+", line: b[--y] });
      else
        ops.push({ kind: "-", line: a[--x] });
    }
  }
  return ops.reverse();
}
function lines(text) {
  if (text === "")
    return [];
  const split = text.split(`
`);
  if (split[split.length - 1] === "")
    split.pop();
  return split;
}
function unified(before, after, context = 3) {
  const ops = edits(lines(before), lines(after));
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === "+")
      additions++;
    else if (op.kind === "-")
      deletions++;
  }
  let patch = "";
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  const starts = ops.map((op) => {
    const at = { old: oldLine, new: newLine };
    if (op.kind !== "+")
      oldLine++;
    if (op.kind !== "-")
      newLine++;
    return at;
  });
  while (i < ops.length) {
    if (ops[i].kind === " ") {
      i++;
      continue;
    }
    let start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (ops[end].kind !== " ") {
        end++;
        continue;
      }
      let next = end;
      while (next < ops.length && ops[next].kind === " ")
        next++;
      if (next < ops.length && next - end <= context * 2)
        end = next;
      else
        break;
    }
    end = Math.min(ops.length, end + context);
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    const oldStart = oldCount === 0 ? starts[start].old - 1 : starts[start].old;
    const newStart = newCount === 0 ? starts[start].new - 1 : starts[start].new;
    patch += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@
`;
    for (const op of slice)
      patch += op.kind + op.line + `
`;
    i = end;
  }
  return { patch, additions, deletions };
}
function header(path) {
  return path.startsWith("/") ? `--- ${path}
+++ ${path}
` : `--- a/${path}
+++ b/${path}
`;
}
function fileDiff(path, before, after) {
  const { patch, additions, deletions } = unified(before ?? "", after ?? "");
  const status = before === undefined ? "added" : after === undefined ? "deleted" : "modified";
  return { file: path, patch: header(path) + patch, additions, deletions, status };
}
function fromPatch(path, patch, status) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split(`
`)) {
    if (line.startsWith("@@"))
      inHunk = true;
    else if (!inHunk)
      continue;
    else if (line.startsWith("+"))
      additions++;
    else if (line.startsWith("-"))
      deletions++;
  }
  const headed = patch.startsWith("---") || patch.startsWith("diff ") ? patch : header(path) + patch;
  return { file: path, patch: headed, additions, deletions, status: status ?? "modified" };
}

// Agents/src/proc.ts
import { spawn as spawn2 } from "child_process";
import { accessSync, constants } from "fs";
import { delimiter, join as join6 } from "path";
function which(name, extra = []) {
  const folders = [...(process.env.PATH ?? "").split(delimiter), ...extra].filter(Boolean);
  for (const folder of folders) {
    const path = join6(folder, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return;
}
async function run(command, args, options = {}) {
  const env = { ...process.env, ...options.env };
  for (const name of Object.keys(env))
    if (env[name] === undefined)
      delete env[name];
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env,
    stdin: options.input !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  if (options.input !== undefined && child.stdin) {
    child.stdin.write(options.input);
    child.stdin.end();
  }
  const timer = options.timeout ? setTimeout(() => child.kill(), options.timeout) : undefined;
  let stdout = "";
  let stderr = "";
  const reads = Promise.all([new Response(child.stdout).text().then((text) => stdout = text), new Response(child.stderr).text().then((text) => stderr = text)]);
  const code = await child.exited;
  await Promise.race([reads, Bun.sleep(2000)]);
  if (timer)
    clearTimeout(timer);
  return { code, stdout, stderr };
}
function runGroup(command, args, options = {}) {
  const env = { ...process.env, ...options.env };
  for (const name of Object.keys(env))
    if (env[name] === undefined)
      delete env[name];
  return new Promise((resolve) => {
    const child = spawn2(command, args, { cwd: options.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => stdout += chunk);
    child.stderr?.on("data", (chunk) => stderr += chunk);
    const stop = (signal) => {
      try {
        if (child.pid)
          process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = options.timeout ? setTimeout(() => {
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 3000);
    }, options.timeout) : undefined;
    child.on("error", (error) => {
      if (timer)
        clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(error) });
    });
    child.on("close", (code) => {
      if (timer)
        clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
var startPath = process.env.PATH ?? "";
var pathRead = 0;
var reading;
async function refreshLoginPath(now = false) {
  if (reading) {
    await reading;
    if (!now)
      return;
  }
  if (!now && Date.now() - pathRead < 5000)
    return;
  reading = readLoginPath().finally(() => {
    pathRead = Date.now();
    reading = undefined;
  });
  await reading;
}
async function readLoginPath() {
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  for (const flags of onMachine ? ["-lc"] : ["-ilc", "-lc"]) {
    try {
      const ran = await run(shell, [flags, 'printf "__KUVO_PATH__%s__KUVO_END__" "$PATH"'], { timeout: 8000, env: { ...ownEnvironment(), PATH: startPath, DISABLE_AUTO_UPDATE: "true" } });
      const found = ran.stdout.match(/__KUVO_PATH__([\s\S]*?)__KUVO_END__/)?.[1];
      if (found?.trim()) {
        process.env.PATH = [...new Set([process.env.KUVO_BIN, ...found.trim().split(":")].filter(Boolean))].join(":");
        return;
      }
    } catch {}
  }
}
function firstURL(text) {
  return text.match(/https?:\/\/[^\s"'<>]+/)?.[0];
}
function plain(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// Agents/src/snapshots.ts
var quiet = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" };
var patchLimit = 50000;
var fileLimit = 200;

class Snapshots {
  root;
  queues = new Map;
  taken = 0;
  collecting = new Set;
  constructor(root) {
    this.root = root;
  }
  async repository(directory) {
    const top = await run("git", ["-C", directory, "rev-parse", "--show-toplevel"], { timeout: 15000, env: quiet }).catch(() => {
      return;
    });
    if (top?.code !== 0 || !top.stdout.trim())
      return;
    let root;
    let here;
    try {
      root = realpathSync(top.stdout.trim());
      here = realpathSync(directory);
    } catch {
      return;
    }
    const exclude = await run("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { timeout: 15000, env: quiet }).catch(() => {
      return;
    });
    let prefix = relative(root, here);
    if (prefix.startsWith(".."))
      prefix = "";
    return { top: root, prefix, exclude: exclude?.code === 0 ? exclude.stdout.trim() || undefined : undefined };
  }
  storeOf(repository) {
    return join7(this.root, createHash("sha1").update(repository.top).digest("hex").slice(0, 20));
  }
  git(repository, args, options = {}) {
    const settings = ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "core.symlinks=true", "-c", "core.longpaths=true", "-c", "gc.pruneExpire=never", "-c", "gc.worktreePruneExpire=never"];
    if (!options.packs)
      settings.push("-c", "gc.auto=0");
    if (repository.exclude)
      settings.push("-c", `core.excludesFile=${repository.exclude}`);
    return run("git", ["--git-dir", this.storeOf(repository), "--work-tree", repository.top, ...settings, ...args], {
      cwd: repository.top,
      timeout: options.timeout ?? 120000,
      env: options.patterns ? { ...quiet, GIT_LITERAL_PATHSPECS: "0" } : quiet,
      input: options.input
    });
  }
  exclusive(repository, work) {
    const store = this.storeOf(repository);
    const before = this.queues.get(store) ?? Promise.resolve();
    const next = before.then(work, work);
    this.queues.set(store, next.catch(() => {}));
    return next;
  }
  async take(directory) {
    const repository = await this.repository(directory);
    if (!repository)
      return;
    return this.exclusive(repository, async () => {
      const store = this.storeOf(repository);
      if (!existsSync2(join7(store, "HEAD"))) {
        mkdirSync5(store, { recursive: true });
        const made = await run("git", ["init", "--bare", "-q", store], { timeout: 30000, env: quiet });
        if (made.code !== 0)
          throw new Error("Kuvo Code couldn't make a place to keep this project's files.");
      }
      const added = await this.git(repository, ["add", "-A", "--", repository.prefix || "."]);
      if (added.code !== 0)
        throw new Error(`Kuvo Code couldn't keep this project's files: ${added.stderr.trim().split(`
`).pop() ?? "git failed"}`);
      const tree = await this.git(repository, ["write-tree"]);
      if (tree.code !== 0 || !tree.stdout.trim())
        throw new Error("Kuvo Code couldn't keep this project's files.");
      const ignored = await this.git(repository, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory", "--", repository.prefix || "."]);
      if (ignored.code === 0)
        this.keepIgnored(store, tree.stdout.trim(), ignored.stdout.split("\x00").filter(Boolean));
      if (++this.taken % 50 === 0 && !this.collecting.has(store)) {
        this.collecting.add(store);
        this.git(repository, ["gc", "--auto", "--quiet"], { timeout: 600000, packs: true }).catch(() => {}).finally(() => this.collecting.delete(store));
      }
      return tree.stdout.trim();
    });
  }
  async changed(directory, from, to) {
    const repository = await this.repository(directory);
    if (!repository || from === to)
      return [];
    return this.exclusive(repository, async () => {
      const ran = await this.git(repository, ["diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-abbrev", from, to, "--", repository.prefix || "."]);
      if (ran.code !== 0)
        throw new Error("Kuvo Code couldn't tell which files changed.");
      const fields = ran.stdout.split("\x00");
      const paths = [];
      for (let i = 0;i + 1 < fields.length; i += 2) {
        const [oldMode, newMode] = fields[i].replace(/^:/, "").split(" ");
        if (oldMode === "160000" || newMode === "160000" || !fields[i + 1])
          continue;
        paths.push(fields[i + 1]);
      }
      return paths;
    });
  }
  async changes(directory, from, to, paths) {
    const repository = await this.repository(directory);
    if (!repository)
      return [];
    return this.exclusive(repository, async () => {
      const files = [];
      for (const path of paths.slice(0, fileLimit)) {
        const ran = await this.git(repository, ["diff", "--no-color", "--no-renames", "--no-ext-diff", from, to, "--", path]).catch(() => {
          return;
        });
        if (ran?.code !== 0)
          continue;
        const patch = ran.stdout.length > patchLimit ? ran.stdout.slice(0, patchLimit) : ran.stdout;
        const status = /^new file mode/m.test(patch) ? "added" : /^deleted file mode/m.test(patch) ? "deleted" : "modified";
        files.push(fromPatch(join7(repository.top, path), patch, status));
      }
      return files;
    });
  }
  async restore(directory, tree, paths, since) {
    const repository = await this.repository(directory);
    if (!repository || !paths.length)
      return;
    await this.exclusive(repository, async () => {
      const listed = await this.git(repository, ["ls-tree", "-r", "-z", "--full-tree", tree]);
      if (listed.code !== 0)
        throw new Error("Kuvo Code couldn't read what the files were.");
      const wanted = new Set(paths);
      const there = new Set;
      const repositories = new Set;
      for (const entry of listed.stdout.split("\x00")) {
        const tab = entry.indexOf("\t");
        if (tab < 0)
          continue;
        const path = entry.slice(tab + 1);
        if (!wanted.has(path))
          continue;
        if (entry.startsWith("160000 "))
          repositories.add(path);
        else
          there.add(path);
      }
      const isRules = (path) => /(^|\/)\.gitignore$/.test(path);
      const goneRules = paths.filter((path) => isRules(path) && !there.has(path) && !repositories.has(path));
      for (const path of goneRules)
        this.remove(repository.top, path);
      await this.checkout(repository, tree, paths.filter((path) => isRules(path) && there.has(path)));
      let gone = paths.filter((path) => !isRules(path) && !there.has(path) && !repositories.has(path) && this.isInside(repository.top, join7(repository.top, path)));
      if (gone.length) {
        const ignored = await this.git(repository, ["check-ignore", "--no-index", "-z", "--stdin"], { input: gone.map((path) => `./${path}`).join("\x00"), patterns: true });
        if (ignored.code !== 0 && ignored.code !== 1)
          throw new Error("Kuvo Code couldn't tell which files the ignore rules left out.");
        const left = new Set(ignored.stdout.split("\x00").filter(Boolean).map((path) => path.replace(/^\.\//, "")));
        gone = gone.filter((path) => !left.has(path));
      }
      const leftOut = this.ignoredWith(this.storeOf(repository), tree);
      if (leftOut)
        gone = gone.filter((path) => !leftOut.has(path) && !ancestors(path).some((folder) => leftOut.has(`${folder}/`)));
      else if (since !== undefined)
        gone = gone.filter((path) => !this.madeBefore(join7(repository.top, path), since));
      for (const path of gone.sort((a, b) => b.length - a.length))
        this.remove(repository.top, path);
      const back = paths.filter((path) => !isRules(path) && there.has(path));
      for (const path of back) {
        const full = join7(repository.top, path);
        if (this.isInside(repository.top, full) && existsSync2(full) && lstatSync(full).isDirectory() && !existsSync2(join7(full, ".git")))
          rmSync4(full, { recursive: true, force: true });
      }
      await this.checkout(repository, tree, back);
    });
  }
  async checkout(repository, tree, paths) {
    if (!paths.length)
      return;
    const checked = await this.git(repository, ["checkout", tree, "--pathspec-from-file=-", "--pathspec-file-nul"], { input: paths.join("\x00") });
    if (checked.code !== 0)
      throw new Error(`Kuvo Code couldn't put the files back: ${checked.stderr.trim().split(`
`).pop() ?? "git failed"}`);
  }
  keepIgnored(store, tree, paths) {
    try {
      const folder = join7(store, "kuvo-ignored");
      mkdirSync5(folder, { recursive: true });
      const file = join7(folder, tree);
      const known = existsSync2(file) ? readFileSync6(file, "utf8").split("\x00").filter(Boolean) : [];
      writeFileSync5(file, [...new Set([...known, ...paths])].join("\x00"));
    } catch {}
  }
  ignoredWith(store, tree) {
    try {
      return new Set(readFileSync6(join7(store, "kuvo-ignored", tree), "utf8").split("\x00").filter(Boolean));
    } catch {
      return;
    }
  }
  madeBefore(full, time) {
    try {
      const born = lstatSync(full).birthtimeMs;
      return born > 0 && born < time;
    } catch {
      return false;
    }
  }
  isInside(top, full) {
    const target = resolve(full);
    if (!target.startsWith(top + sep))
      return false;
    let folder = dirname(target);
    while (folder.length > top.length) {
      try {
        if (lstatSync(folder).isSymbolicLink())
          return false;
      } catch {
        return true;
      }
      folder = dirname(folder);
    }
    return true;
  }
  remove(top, path) {
    const full = join7(top, path);
    if (!this.isInside(top, full))
      return;
    try {
      const stat = lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink() && existsSync2(join7(full, ".git")))
        return;
      rmSync4(full, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
    } catch {
      return;
    }
    let folder = dirname(full);
    while (folder.length > top.length) {
      try {
        if (readdirSync2(folder).length)
          break;
        rmdirSync(folder);
      } catch {
        break;
      }
      folder = dirname(folder);
    }
  }
}
function ancestors(path) {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

// Agents/src/agents/antigravity.ts
import { createHash as createHash3 } from "crypto";
import { chmodSync as chmodSync2, existsSync as existsSync6, mkdirSync as mkdirSync9, readdirSync as readdirSync4, readFileSync as readFileSync10, renameSync as renameSync4, rmSync as rmSync7, statSync as statSync3, writeFileSync as writeFileSync9 } from "fs";
import { join as join10 } from "path";
import { pathToFileURL as pathToFileURL2 } from "url";

// Agents/src/acp.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync6, readFileSync as readFileSync7, writeFileSync as writeFileSync6 } from "fs";
import { dirname as dirname2, resolve as resolve2 } from "path";

// Agents/src/rpc.ts
class RPCError extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class RPC {
  next = 1;
  pending = new Map;
  child;
  closed = false;
  stderr = "";
  onNotification = () => {};
  onRequest = async (method) => {
    throw new RPCError(-32601, `Method not found: ${method}`);
  };
  onExit = () => {};
  exited;
  constructor(command, options = {}) {
    this.jsonrpc = options.jsonrpc ?? false;
    if (options.firstID)
      this.next = options.firstID;
    this.filter = options.filter;
    const env = options.cleanEnv ? options.env : { ...process.env, ...options.env };
    this.child = Bun.spawn(command, { cwd: options.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.exited = this.child.exited.then((code) => {
      this.closed = true;
      for (const { reject } of this.pending.values())
        reject(new Error(this.stderr.trim().split(`
`).slice(-3).join(`
`) || `The agent stopped (exit code ${code}).`));
      this.pending.clear();
      this.onExit(code);
      return code;
    });
    this.read();
    this.readErrors();
  }
  jsonrpc;
  filter;
  get pid() {
    return this.child.pid;
  }
  get isClosed() {
    return this.closed;
  }
  async read() {
    const decoder = new TextDecoder;
    let buffer = "";
    for await (const chunk of this.child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf(`
`)) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim() && (!this.filter || this.filter(line)))
          this.receive(line);
      }
    }
  }
  async readErrors() {
    const decoder = new TextDecoder;
    for await (const chunk of this.child.stderr) {
      this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-8000);
    }
  }
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      this.answer(message.id, message.method, message.params);
    } else if (message.method !== undefined) {
      this.onNotification(message.method, message.params);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending)
        return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new RPCError(message.error.code ?? -32000, message.error.message ?? "The agent refused.", message.error.data));
      else
        pending.resolve(message.result);
    }
  }
  async answer(id, method, params) {
    try {
      const result = await this.onRequest(method, params, id);
      this.write({ id, result: result ?? null });
    } catch (error) {
      const code = error instanceof RPCError ? error.code : -32603;
      this.write({ id, error: { code, message: error instanceof Error ? error.message : String(error) } });
    }
  }
  write(message) {
    if (this.closed)
      return;
    const body = this.jsonrpc ? { jsonrpc: "2.0", ...message } : message;
    try {
      this.child.stdin.write(JSON.stringify(body) + `
`);
      this.child.stdin.flush();
    } catch {}
  }
  request(method, params, timeout) {
    if (this.closed)
      return Promise.reject(new Error(this.stderr.trim().split(`
`).slice(-3).join(`
`) || "The agent isn't running."));
    const id = this.next++;
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject });
      this.write(params === undefined ? { id, method } : { id, method, params });
      if (timeout) {
        setTimeout(() => {
          if (!this.pending.has(id))
            return;
          this.pending.delete(id);
          reject(new Error(`${method} took too long.`));
        }, timeout);
      }
    });
  }
  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }
  kill() {
    if (this.closed)
      return;
    try {
      this.child.stdin.end();
    } catch {}
    this.child.kill();
  }
}

// Agents/src/pictures.ts
import { extname } from "path";
import { pathToFileURL } from "url";
var types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic" };
function pictureFile(path) {
  if (typeof path !== "string" || !path)
    return;
  const mime = types[extname(path).toLowerCase()];
  if (!mime)
    return;
  return { type: "file", uri: pathToFileURL(path).href, mime, name: path.split("/").pop() };
}
function pictureData(data, mime) {
  if (typeof data !== "string" || !data || typeof mime !== "string" || !mime.startsWith("image/"))
    return;
  return { type: "file", uri: `data:${mime};base64,${data}`, mime };
}
function withPictures(text, pictures) {
  const files = pictures.filter((picture) => Boolean(picture));
  return files.length ? [{ type: "text", text }, ...files] : text;
}

// Agents/src/forms.ts
function elicitationField(key, field, required) {
  const title = field?.title ?? key;
  const description = field?.description ?? undefined;
  if (field?.type === "boolean")
    return { key, title, description, required, type: "boolean" };
  if (field?.type === "array") {
    const options2 = (field.items?.anyOf ?? field.items?.oneOf ?? (field.items?.enum ?? []).map((value) => ({ const: value, title: value }))).map((option) => ({ value: String(option.const), label: String(option.title ?? option.const) }));
    return { key, title, description, required, type: "multiselect", options: options2 };
  }
  const named = field?.oneOf ?? field?.anyOf;
  const options = named ? named.map((option) => ({ value: String(option.const), label: String(option.title ?? option.const) })) : field?.enum?.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  return { key, title, description, required, type: "string", options, custom: !options, ...field?.format === "password" ? { format: "password" } : {} };
}

// Agents/src/acp.ts
var outputLimit2 = 30000;
var limitWords = /RESOURCE_EXHAUSTED|usage limit (?:reached|exceeded)|quota exceeded|exceeded your (?:current )?quota|rate limit exceeded|too many requests/i;
var acpTiming = { ownQuiet: 20000, signInGrace: 60000 };

class AcpThread {
  flavor;
  session;
  state;
  name;
  rpc;
  sessionID;
  setup;
  spawnedWith;
  active;
  loading = false;
  stale;
  startedOver = false;
  onOwnTurn;
  own;
  constructor(flavor, session, state, name) {
    this.flavor = flavor;
    this.session = session;
    this.state = state;
    this.name = name;
  }
  async open(input, hooks) {
    const skills = await this.flavor.skills?.(this.session.location.directory, hooks);
    const mode = { approvesAll: hooks.approvesAll(), plan: input.plan, skills };
    const key = JSON.stringify({ ...mode, program: this.flavor.program?.() ?? 0, tools: kuvoTools(this.session.id)?.key });
    if (this.rpc && !this.rpc.isClosed && this.spawnedWith === key && this.rpc !== this.stale)
      return this.rpc;
    this.close();
    const launch = await this.flavor.command(mode);
    const flavor = this.flavor;
    const startedAt = Date.now();
    let asksSignIn = false;
    const rpc = new RPC(launch.argv, {
      cwd: launch.cwd ?? this.session.location.directory,
      env: { ...launch.env, OPENCODE_SESSION_ID: this.session.id },
      cleanEnv: launch.cleanEnv,
      jsonrpc: true,
      firstID: 2 ** 30,
      filter: (line) => {
        if (!asksSignIn && flavor.asksSignIn?.(line)) {
          asksSignIn = true;
          setTimeout(() => {
            rpc.stderr = `${this.name} needs you to sign in again: Settings \u203A Accounts.`;
            rpc.kill();
          });
          return false;
        }
        const fatal = flavor.fatalLine?.(line);
        if (fatal) {
          setTimeout(() => {
            rpc.stderr = fatal;
            rpc.kill();
          });
          return false;
        }
        return flavor.filter?.(line) ?? true;
      }
    });
    rpc.onNotification = (method, params) => this.notification(method, params);
    rpc.onRequest = (method, params) => this.request(method, params);
    rpc.onExit = () => {
      launch.onExit?.();
      if (this.rpc === rpc)
        this.rpc = undefined;
      const young = Date.now() - startedAt < acpTiming.signInGrace;
      if (asksSignIn && young)
        flavor.signInEnded?.();
      const active = this.active;
      if (!active || active.ended || active.rpc !== rpc)
        return;
      if (asksSignIn && !young && !active.renewed && active.input) {
        active.renewed = true;
        active.replaced = rpc;
        this.renew(active, active.input);
        return;
      }
      this.end(active, "failed", rpc.stderr.trim().split(`
`).slice(-3).join(`
`) || `${this.name} stopped.`);
    };
    this.rpc = rpc;
    this.spawnedWith = key;
    if (launch.signInFile) {
      const file = launch.signInFile;
      const watch = setInterval(() => {
        if (rpc.isClosed)
          return clearInterval(watch);
        if (!existsSync3(file))
          return;
        clearInterval(watch);
        asksSignIn = true;
        rpc.stderr = `${this.name} needs you to sign in again: Settings \u203A Accounts.`;
        rpc.kill();
      }, 500);
    }
    try {
      const init = await rpc.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: this.flavor.fileSystem, writeTextFile: this.flavor.fileSystem }, terminal: false },
        clientInfo: { name: "kuvo-code", title: "Kuvo Code", version: "1" },
        ...this.flavor.initializeMeta ? { _meta: this.flavor.initializeMeta } : {}
      }, 120000);
      const advertised = init?.authMethods ?? [];
      const authenticate = async () => {
        const methodId = this.flavor.authMethod(advertised);
        if (!methodId)
          throw new Error(`${this.name} isn't signed in. Sign in again in Settings \u203A Accounts.`);
        await rpc.request("authenticate", { methodId }, 300000);
      };
      if (this.flavor.authenticatesFirst)
        await authenticate();
      const cwd = this.session.location.directory;
      const previous = this.state.acpSession;
      const openSession = async () => {
        if (previous && this.flavor.resumes && init?.agentCapabilities?.sessionCapabilities?.resume) {
          this.loading = true;
          try {
            this.setup = await rpc.request("session/resume", { sessionId: previous, cwd, mcpServers: this.mcpServers(init) }, 120000);
            this.sessionID = previous;
            return;
          } catch {} finally {
            this.loading = false;
          }
        }
        if (previous && init?.agentCapabilities?.loadSession) {
          this.loading = true;
          try {
            this.setup = await rpc.request("session/load", { sessionId: previous, cwd, mcpServers: this.mcpServers(init) }, 120000);
            this.sessionID = previous;
            return;
          } catch {} finally {
            this.loading = false;
          }
        }
        this.setup = await rpc.request("session/new", { cwd, mcpServers: this.mcpServers(init) }, 120000);
        this.sessionID = this.setup?.sessionId;
        if (previous && previous !== this.sessionID) {
          this.startedOver = true;
          delete this.state.acpInstructions;
          delete this.state.acpInstructed;
        }
        this.state.acpSession = this.sessionID;
        hooks.saveState();
      };
      try {
        await openSession();
      } catch (error) {
        if (!(error instanceof RPCError && error.code === -32000))
          throw error;
        await authenticate();
        await openSession();
      }
    } catch (error) {
      if (this.rpc === rpc)
        this.close();
      throw error;
    }
    return rpc;
  }
  mcpServers(init) {
    const tools = kuvoTools(this.session.id);
    if (!tools || tools.kind === "http" && !init?.agentCapabilities?.mcpCapabilities?.http)
      return [];
    loadKuvoTools();
    if (tools.kind === "stdio")
      return [{ name: tools.name, command: tools.command, args: tools.args, env: Object.entries(tools.env).map(([name, value]) => ({ name, value })) }];
    return [{ type: "http", name: tools.name, url: tools.url, headers: Object.entries(tools.headers).map(([name, value]) => ({ name, value })) }];
  }
  async renew(active, input) {
    try {
      const rpc = await this.open(input, active.hooks);
      active.rpc = rpc;
      if (active.ended)
        return;
      if (active.hooks.signal.aborted)
        return this.end(active, "interrupted");
      if (this.startedOver)
        return this.end(active, "failed", `${this.name} started again and couldn't take up this conversation. Send your message again.`);
      const sessionId = this.sessionID;
      await this.flavor.selectModel(rpc, sessionId, input.model.id, this.setup, input.model.variant).catch(() => {});
      await this.flavor.selectMode?.(rpc, sessionId, { approvesAll: active.hooks.approvesAll(), plan: input.plan }, this.setup);
      if (active.ended)
        return;
      this.prompt(active, sessionId, [{ type: "text", text: "<system-reminder>Your connection was renewed partway through your work, and what was under way then was cut off. Carry on with the task from where you were.</system-reminder>" }]);
    } catch (error) {
      this.end(active, "failed", failure(error).message);
    }
  }
  async prepare(input, hooks) {
    await this.open(input, hooks);
    const fresh = this.startedOver;
    this.startedOver = false;
    return { fresh };
  }
  async run(input, turn, hooks) {
    if (input.adopt)
      return this.adopt(turn, hooks);
    this.own = undefined;
    const rpc = await this.open(input, hooks);
    await loadKuvoTools();
    if (hooks.signal.aborted)
      return { outcome: "interrupted" };
    const sessionId = this.sessionID;
    await this.flavor.selectModel(rpc, sessionId, input.model.id, this.setup, input.model.variant).catch(() => {});
    try {
      await this.flavor.selectMode?.(rpc, sessionId, { approvesAll: hooks.approvesAll(), plan: input.plan }, this.setup);
    } catch (error) {
      return { outcome: "failed", error: failure(error) };
    }
    if (hooks.signal.aborted)
      return { outcome: "interrupted" };
    const prompt = [];
    const others = [];
    for (const file of input.files) {
      const data = file.data ?? (file.mime.startsWith("image/") && file.path ? safeBase64(file.path) : undefined);
      if (file.mime.startsWith("image/") && data)
        prompt.push({ type: "image", data, mimeType: file.mime });
      else if (file.path)
        others.push(file.path);
    }
    let text = input.text;
    const instructions = hooks.instructions();
    const sent = typeof this.state.acpInstructions === "string" ? this.state.acpInstructions : this.state.acpInstructed ? undefined : "";
    let instructed;
    if (instructions !== sent && (instructions || sent)) {
      if (instructions)
        text = `${sent ? `Your instructions from Kuvo Code changed. They're now:

` : ""}${instructions}

${text}`;
      instructed = { value: instructions };
    }
    if (others.length)
      text += `

Attached files:
${others.map((path) => `- ${path}`).join(`
`)}`;
    prompt.unshift({ type: "text", text });
    return new Promise((resolve3) => {
      const active = { turn, hooks, resolve: resolve3, rpc, tools: new Map, toolsSinceText: false, ended: false, instructed, children: new Map, served: new Map, started: Date.now(), prompt: 0, input };
      this.active = active;
      turn.startStep();
      active.follower = this.flavor.follow?.(sessionId, turn, hooks);
      this.prompt(active, sessionId, prompt);
    });
  }
  prompt(active, sessionId, prompt) {
    const number = ++active.prompt;
    const meta = this.flavor.promptMeta?.();
    active.promptID = typeof meta?.promptId === "string" ? meta.promptId : undefined;
    const sentOn = active.rpc;
    active.rpc.request("session/prompt", { sessionId, prompt, ...meta ? { _meta: meta } : {} }).then((result) => {
      if (number !== active.prompt)
        return;
      active.answered = true;
      if (result?.stopReason === "rate_limit")
        this.end(active, "failed", `You've reached your ${this.name} usage limit for now.`, this.limit());
      else
        this.end(active, result?.stopReason === "cancelled" ? "interrupted" : "succeeded");
    }, (error) => {
      if (number !== active.prompt || active.replaced === sentOn)
        return;
      const limited = error instanceof RPCError && error.code === -32003 || limitWords.test(errorText(error));
      this.end(active, "failed", limited ? `You've reached your ${this.name} usage limit for now.` : errorText(error), limited ? this.limit(errorText(error)) : undefined);
    });
  }
  carryOn(active) {
    const refused = active.refused;
    if (!refused || active.own || active.hooks.signal.aborted || !this.sessionID || (active.carriedOn ?? 0) >= 3)
      return false;
    active.refused = undefined;
    active.carriedOn = (active.carriedOn ?? 0) + 1;
    this.prompt(active, this.sessionID, [{ type: "text", text: `<system-reminder>Kuvo Code didn't allow ${refused}: the user's settings (Settings \u203A Permissions, the session's agent, or Plan mode) don't allow it here. The user didn't stop you. Carry on with the task without it, or say what you'd need.</system-reminder>` }]);
    return true;
  }
  limit(message) {
    const resetsAt = resetsIn(message);
    return { scope: this.flavor.limitScope ?? "provider", message, ...resetsAt ? { resetsAt } : {} };
  }
  end(active, outcome, message, limit) {
    if (active.ended)
      return;
    if (outcome === "succeeded" && !active.own && !active.tools.size && active.said && this.flavor.limitReply?.(active.said)) {
      outcome = "failed";
      limit = this.limit(active.said);
      message = `You've reached your ${this.name} usage limit for now.`;
    }
    if (outcome === "interrupted" && this.carryOn(active))
      return;
    active.ended = true;
    if (active.instructed && (outcome !== "failed" || active.heard)) {
      this.state.acpInstructions = active.instructed.value;
      delete this.state.acpInstructed;
      active.hooks.saveState();
    }
    if (this.active === active)
      this.active = undefined;
    clearTimeout(active.quiet);
    if (active.plan)
      active.turn.toolSucceeded(active.plan.id, "", { todos: active.plan.todos });
    active.follower?.stop();
    for (const child of active.children.values())
      if ("run" in child) {
        active.turn.toolSucceeded(child.row, "", { sessionID: child.run.sessionID });
        child.run.end(outcome === "failed" ? "interrupted" : outcome);
      }
    for (const [id, message2] of active.declined ?? [])
      active.turn.toolFailed(id, message2);
    this.settleReads(active, true);
    active.turn.endStep({ tokens: this.stepTokens(active) });
    if (active.hooks.signal.aborted)
      active.resolve({ outcome: "interrupted" });
    else if (limit)
      active.resolve({ outcome: "failed", error: { type: "limit", message: message ?? `You've reached your ${this.name} usage limit for now.` }, limit, taken: active.heard || active.answered });
    else
      active.resolve(outcome === "failed" ? { outcome, error: failure(message ?? `${this.name} stopped with an error.`), taken: active.heard || active.answered } : { outcome });
  }
  context() {
    const active = this.active;
    return {
      turn: active?.turn,
      hooks: active?.hooks,
      endPrompt: (stopReason, error, promptID) => {
        if (active && promptID && active.promptID && promptID !== active.promptID)
          return;
        if (active && !active.own)
          this.end(active, error ? "failed" : stopReason === "cancelled" ? "interrupted" : "succeeded", error, stopReason === "rate_limit" ? this.limit(error) : undefined);
      },
      endOwn: () => {
        if (active?.own)
          this.end(active, "succeeded");
        else if (this.own && !this.own.turnedAway)
          this.own.ended = true;
        else if (this.own)
          this.own = undefined;
      }
    };
  }
  adopt(turn, hooks) {
    const own = this.own;
    this.own = undefined;
    const rpc = this.rpc;
    if (!own || own.turnedAway || !rpc)
      return Promise.resolve({ outcome: "succeeded" });
    return new Promise((resolve3) => {
      const active = { turn, hooks, resolve: resolve3, rpc, tools: new Map, toolsSinceText: false, ended: false, children: new Map, served: new Map, started: own.started, prompt: 0, own: true };
      this.active = active;
      turn.startStep();
      if (this.sessionID)
        active.follower = this.flavor.follow?.(this.sessionID, turn, hooks);
      this.quietly(active);
      for (const update of own.updates)
        this.notification("session/update", update);
      if (own.ended && this.active === active)
        this.end(active, "succeeded");
    });
  }
  noticed = new Set;
  noticeOnce(active, key, text) {
    if (this.noticed.has(key))
      return;
    this.noticed.add(key);
    active.turn.notice(text);
  }
  quietly(active) {
    clearTimeout(active.quiet);
    active.quiet = setTimeout(() => {
      if (this.active === active)
        this.end(active, "succeeded");
    }, acpTiming.ownQuiet);
  }
  notification(method, params) {
    if (method !== "session/update") {
      this.flavor.notification?.(method, params, this.context());
      return;
    }
    const active = this.active;
    if (this.loading || params?._meta?.isReplay)
      return;
    const update = params?.update ?? {};
    const ours = !params?.sessionId || !this.sessionID || params.sessionId === this.sessionID;
    if (!active) {
      if (ours && this.sessionID)
        this.ownUpdate(params, update);
      return;
    }
    if (active.own)
      this.quietly(active);
    if (!ours)
      return this.childUpdate(active, String(params.sessionId), update);
    active.heard = true;
    const turn = active.turn;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        active.said = ((active.toolsSinceText ? "" : active.said) ?? "").concat(contentText(update.content)).slice(-2000);
        this.words(active);
        this.content(active, turn, update.content, "text");
        return;
      case "agent_thought_chunk":
        this.words(active);
        this.content(active, turn, update.content, "reasoning");
        return;
      case "tool_call":
      case "tool_call_update":
        return this.tool(active, update);
      case "usage_update":
        if (typeof update.used === "number")
          active.used = update.used;
        if (typeof update.size === "number")
          this.flavor.noteContext?.(turn.currentModel.id, update.size);
        if (typeof update.cost?.amount === "number" && (update.cost.currency ?? "USD") === "USD")
          this.cost(turn, update.cost.amount);
        return;
      case "current_mode_update":
        if (this.setup && update.currentModeId)
          this.setup.kuvoMode = update.currentModeId;
        if (update.currentModeId)
          turn.notice(`${this.name} switched to its ${update.currentModeId} mode.`);
        return;
      case "config_option_update":
        if (this.setup && Array.isArray(update.configOptions))
          this.setup.configOptions = update.configOptions;
        return;
      case "notice":
        if (typeof update.message === "string" || typeof update.text === "string")
          turn.notice(String(update.message ?? update.text));
        return;
      case "compaction_update":
      case "compaction_summary_chunk":
        if (!active.compacted)
          turn.notice(`${this.name} summarized the conversation to make room.`);
        active.compacted = true;
        return;
      case "user_message_chunk":
      case "available_commands_update":
      case "session_info_update":
        return;
      case "plan": {
        const todos = (update.entries ?? []).map((entry) => ({ content: entry.content, status: entry.status === "in_progress" ? "in_progress" : entry.status }));
        const id = active.plan?.id ?? newID("call");
        active.plan = { id, todos };
        if (!turn.hasTool(id))
          turn.toolStart(id, "todowrite", { todos });
        else
          turn.toolCalled(id, { todos });
        return;
      }
      default: {
        const words = contentText(update.content) || (typeof update.message === "string" ? update.message : "");
        if (words.trim())
          turn.notice(words.trim());
        console.error(`${this.name} sent ${update.sessionUpdate}, which Kuvo Code doesn't know.`);
      }
    }
  }
  content(active, turn, content, kind) {
    const picture = content?.type === "image" ? pictureData(content.data, content.mimeType) : content?.type === "resource" && content.resource?.blob ? pictureData(content.resource.blob, content.resource.mimeType) : undefined;
    if (picture) {
      const id = newID("call");
      active.toolsSinceText = true;
      turn.toolStart(id, "generate_image", {});
      turn.toolSucceeded(id, withPictures("", [picture]));
      return;
    }
    const text = content?.type === "resource_link" ? `[${content.name ?? content.title ?? content.uri}](${content.uri})` : content?.type === "audio" ? "(a sound clip)" : contentText(content);
    if (kind === "text")
      turn.text(text);
    else
      turn.reasoning(text);
  }
  childUpdate(active, sessionId, update) {
    let child = active.children.get(sessionId);
    if (!child || "prompt" in child) {
      if (update.sessionUpdate === "user_message_chunk") {
        active.children.set(sessionId, { prompt: (child?.prompt ?? "") + contentText(update.content) });
        return;
      }
      const prompt = child?.prompt?.trim();
      const row = `acp-subagent:${sessionId}`;
      active.toolsSinceText = true;
      active.turn.toolStart(row, "subagent", { description: firstLine(prompt) || "A subagent's task", prompt });
      const run2 = active.hooks.subagent(row, { title: firstLine(prompt) || "A subagent's task", prompt });
      child = { run: run2, row, toolsSinceText: false, tools: new Map };
      active.children.set(sessionId, child);
    }
    const turn = child.run.turn;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        turn.text(contentText(update.content));
        return;
      case "agent_thought_chunk":
        turn.reasoning(contentText(update.content));
        return;
      case "tool_call":
      case "tool_call_update": {
        const id = update.toolCallId;
        if (!id)
          return;
        const merged = { ...child.tools.get(id) ?? {}, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) };
        child.tools.set(id, merged);
        const kuvo = kuvoTool(merged);
        if (!turn.hasTool(id))
          turn.toolStart(id, kuvo.name, kuvo.input);
        const { text, pictures } = toolOutput(merged);
        if (merged.status === "completed")
          turn.toolSucceeded(id, withPictures(text, pictures));
        else if (merged.status === "failed")
          turn.toolFailed(id, text || "The tool failed.");
        return;
      }
    }
  }
  ownUpdate(params, update) {
    const known = this.own;
    if (known) {
      if (!known.turnedAway)
        known.updates.push(params);
      else
        this.forget(known);
      return;
    }
    if (!["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(update.sessionUpdate))
      return;
    const own = { updates: [params], turnedAway: false, started: Date.now() };
    this.own = own;
    if (!(this.onOwnTurn?.({ text: `${this.name} carried on by itself.` }) ?? false))
      this.turnAway();
  }
  turnAway() {
    const own = this.own;
    if (!own || own.turnedAway)
      return;
    own.turnedAway = true;
    if (this.rpc && this.sessionID)
      this.rpc.notify("session/cancel", { sessionId: this.sessionID });
    this.forget(own);
  }
  forget(own) {
    clearTimeout(own.quiet);
    own.quiet = setTimeout(() => {
      if (this.own === own)
        this.own = undefined;
    }, acpTiming.ownQuiet);
    own.quiet.unref?.();
  }
  words(active) {
    if (!active.toolsSinceText)
      return;
    active.toolsSinceText = false;
    this.settleReads(active, false);
    active.turn.endStep({ tokens: this.stepTokens(active) });
    active.turn.startStep();
  }
  settleReads(active, all) {
    if (!this.flavor.fileSystem)
      return;
    for (const [id, call] of active.tools) {
      if (!this.openRead(call) || call.settled)
        continue;
      const path = this.readPath(call);
      if (!path && !all)
        continue;
      const served = path && clientRead(call) ? active.served.get(path)?.shift() : undefined;
      this.settleRead(active, id, served ?? (path && !existsSync3(path) ? { error: "There's no such file." } : { text: "" }));
    }
  }
  readPath(call) {
    const raw = call.rawInput ?? {};
    const path = call.locations?.[0]?.path ?? raw.absolute_path ?? raw.path ?? raw.file_path ?? raw.filePath;
    return typeof path === "string" && path ? resolve2(this.session.location.directory, path) : undefined;
  }
  stepTokens(active) {
    return active.used === undefined ? undefined : { input: active.used, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  }
  cost(turn, total) {
    const kept = this.state.acpCost;
    const before = kept?.session === this.sessionID ? kept?.amount ?? 0 : 0;
    this.state.acpCost = { session: this.sessionID, amount: total };
    turn.addUsage(undefined, total >= before ? total - before : total);
  }
  tool(active, update) {
    const turn = active.turn;
    const id = update.toolCallId;
    if (!id)
      return;
    const merged = { ...active.tools.get(id) ?? {}, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) };
    active.tools.set(id, merged);
    if (this.flavor.hides?.(merged))
      return;
    if (merged.settled)
      return;
    const kuvo = kuvoTool(merged);
    if (!turn.hasTool(id)) {
      active.toolsSinceText = true;
      turn.toolStart(id, kuvo.name, kuvo.input);
    } else {
      turn.toolRename(id, kuvo.name);
      if (merged.status !== "completed" && merged.status !== "failed" || update.rawInput !== undefined)
        turn.toolCalled(id, kuvo.input);
    }
    const { text: output, pictures } = toolOutput(merged);
    const files = (merged.content ?? []).filter((part) => part?.type === "diff" && part.path).map((part) => fileDiff(part.path, part.oldText ?? undefined, part.newText ?? ""));
    const metadata = {};
    if (files.length)
      metadata.files = files;
    const exit = merged.rawOutput?.exit_code ?? merged.rawOutput?.exitCode;
    if (typeof exit === "number")
      metadata.exit = exit;
    if (output)
      metadata.output = output;
    const made = merged.status === "completed" && this.sessionID ? this.flavor.madeFiles?.(merged, this.sessionID, active.started) ?? [] : [];
    if (merged.status === "completed")
      turn.toolSucceeded(id, withPictures(output, [...pictures, ...made]), metadata);
    else if (merged.status === "failed")
      turn.toolFailed(id, output || "The tool failed.", metadata);
    else if (merged.status === "cancelled")
      turn.toolFailed(id, output || active.declined?.get(id) || "Stopped.", metadata);
    else if (output)
      turn.toolProgress(id, metadata);
    const path = this.openRead(merged) && clientRead(merged) ? this.readPath(merged) : undefined;
    const served = path ? active.served.get(path)?.shift() : undefined;
    if (served)
      this.settleRead(active, id, served);
  }
  openRead(call) {
    return call.kind === "read" && call.status !== "completed" && call.status !== "failed";
  }
  settleRead(active, id, served) {
    const call = active.tools.get(id);
    if (call)
      call.settled = true;
    if (served.error !== undefined)
      active.turn.toolFailed(id, served.error);
    else
      active.turn.toolSucceeded(id, served.text ?? "");
  }
  served(path, served) {
    const active = this.active;
    if (!active)
      return;
    const file = resolve2(this.session.location.directory, path);
    for (const [id, call] of active.tools) {
      if (this.openRead(call) && !call.settled && clientRead(call) && this.readPath(call) === file)
        return this.settleRead(active, id, served);
    }
    active.served.set(file, [...active.served.get(file) ?? [], served]);
  }
  async allowFile(active, action, path) {
    if (!active)
      return;
    const ask = { action, resources: [path] };
    const said = active.hooks.check(ask);
    if (said === "deny")
      throw new RPCError(-32000, "Kuvo Code's settings don't allow this (Settings \u203A Permissions, or this session's rules).");
    if (said === "ask" && await active.hooks.permission(ask) === "reject")
      throw new RPCError(-32000, "Declined.");
  }
  async request(method, params) {
    const own = this.flavor.request?.(method, params, this.context());
    if (own)
      return own;
    const active = this.active;
    switch (method) {
      case "session/request_permission": {
        const options = params?.options ?? [];
        if (!active)
          return { outcome: { outcome: "cancelled" } };
        const call = { ...active.tools.get(params.toolCall?.toolCallId) ?? {}, ...params.toolCall ?? {} };
        if (String(call.toolCallId ?? "").startsWith("interaction_")) {
          const answer = await active.hooks.question({
            title: "Question",
            fields: [{ key: "answer", title: "Question", description: call.title ?? "", required: true, type: "string", options: options.map((option2) => ({ value: option2.optionId, label: option2.name ?? option2.optionId })) }]
          });
          const chosen = answer?.answer;
          return chosen ? { outcome: { outcome: "selected", optionId: String(chosen) } } : { outcome: { outcome: "cancelled" } };
        }
        const kuvo = kuvoTool(call);
        const files = (call.content ?? []).filter((part) => part?.type === "diff" && part.path).map((part) => fileDiff(part.path, part.oldText ?? undefined, part.newText ?? ""));
        const action = permissionAction(call.kind, kuvo.name);
        const ask = {
          toolCallID: call.toolCallId,
          action,
          resources: resources(call),
          metadata: files.length ? { files } : undefined,
          message: call.title,
          unclassified: !classified.has(action) && !action.startsWith(toolServerName + "_")
        };
        const automatic = active.hooks.check(ask) === "deny";
        const decision = await active.hooks.permission(ask);
        if (active.hooks.signal.aborted)
          return { outcome: { outcome: "cancelled" } };
        if (decision === "reject") {
          active.refused = automatic ? refusedWhat(ask.action, ask.resources) : undefined;
          (active.declined ??= new Map).set(call.toolCallId, "Declined.");
        }
        const pick = (kinds2) => kinds2.map((kind) => options.find((option2) => option2.kind === kind)).find(Boolean);
        const option = decision === "reject" ? pick(["reject_once", "reject_always"]) : pick(["allow_once", "allow_always"]);
        return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
      }
      case "fs/read_text_file": {
        if (!this.flavor.fileSystem)
          break;
        await this.allowFile(active, "read", resolve2(this.session.location.directory, params.path));
        let content;
        try {
          content = readFileSync7(resolve2(this.session.location.directory, params.path), "utf8");
        } catch (error) {
          this.served(params.path, { error: error?.code === "ENOENT" ? "There's no such file." : failure(error).message });
          throw error;
        }
        if (params.line || params.limit) {
          const lines2 = content.split(`
`);
          const start = Math.max(0, (params.line ?? 1) - 1);
          content = lines2.slice(start, params.limit ? start + params.limit : undefined).join(`
`);
        }
        this.served(params.path, { text: content });
        return { content };
      }
      case "fs/write_text_file": {
        if (!this.flavor.fileSystem)
          break;
        const file = resolve2(this.session.location.directory, params.path);
        if (active?.hooks.check({ action: "edit", resources: [file] }) === "deny")
          throw new RPCError(-32000, "Kuvo Code's settings don't allow this (Settings \u203A Permissions, or this session's rules).");
        mkdirSync6(dirname2(file), { recursive: true });
        writeFileSync6(file, params.content ?? "");
        return {};
      }
      case "elicitation/create": {
        if (!active)
          return { action: "decline" };
        if (params?.mode === "url" && params.url) {
          const answer2 = await active.hooks.question({ title: `${this.name} asks`, fields: [{ key: "open", title: params.message ?? "Open this page to go on.", type: "external", url: params.url }] });
          return { action: answer2 ? "accept" : "decline" };
        }
        const schema = params?.requestedSchema ?? {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const fields = Object.entries(schema.properties ?? {}).map(([key, field]) => elicitationField(key, field, required.has(key)));
        if (fields[0] && params?.message)
          fields[0] = { ...fields[0], description: [params.message, fields[0].description].filter(Boolean).join(`

`) };
        const answer = await active.hooks.question({ title: `${this.name} asks`, fields: fields.length ? fields : [{ key: "ok", title: params?.message ?? "Go on?", type: "boolean", required: true }] });
        if (!answer)
          return { action: "decline" };
        const content = {};
        for (const [key, field] of Object.entries(schema.properties ?? {})) {
          const value = answer[key];
          if (value === undefined || value === null || value === "")
            continue;
          content[key] = field?.type === "number" || field?.type === "integer" ? Number(value) : field?.type === "boolean" ? value === true || value === "true" : value;
        }
        return { action: "accept", content };
      }
    }
    if (active && !method.startsWith("terminal/"))
      this.noticeOnce(active, method, `${this.name} asked Kuvo Code for something it can't do yet (${method}).`);
    throw new RPCError(-32601, `Method not found: ${method}`);
  }
  async interrupt() {
    const active = this.active;
    const rpc = active?.rpc;
    if (!active || !rpc || !this.sessionID)
      return;
    if (this.flavor.restartAfterInterrupt)
      this.stale = rpc;
    rpc.notify("session/cancel", { sessionId: this.sessionID });
    for (let waited = 0;waited < 15000 && !active.ended; waited += 100)
      await Bun.sleep(100);
    if (active.ended)
      return;
    this.end(active, "interrupted");
    if (this.rpc === rpc && (!this.active || this.active.rpc !== rpc))
      this.close();
  }
  close() {
    this.rpc?.kill();
    this.rpc = undefined;
  }
}
function kuvoTool(call) {
  const raw = call.rawInput ?? {};
  const path = call.locations?.[0]?.path ?? raw.path ?? raw.file_path ?? raw.filePath;
  const command = Array.isArray(raw.command) ? raw.command.join(" ") : raw.command ?? raw.CommandLine ?? raw.command_line ?? raw.commandLine;
  if (raw.variant === "SearchTool")
    return { name: "tool_search", input: { query: raw.query } };
  switch (call.kind) {
    case "execute":
      return { name: "shell", input: { command: command ?? backticked(call.title) ?? call.title, description: raw.description } };
    case "read":
      return { name: "read", input: { ...raw, path, description: call.title } };
    case "edit":
    case "delete":
    case "move":
      return { name: "edit", input: { ...raw, path, description: call.title } };
    case "search":
      return { name: "grep", input: { ...raw, pattern: raw.pattern ?? raw.query ?? call.title, path, description: call.title } };
    case "fetch":
      return { name: raw.url ? "webfetch" : "websearch", input: { url: raw.url, query: raw.query ?? call.title } };
    case "think":
      return { name: "think", input: {} };
  }
  const server2 = raw.server ?? raw.server_name ?? raw.serverName;
  const tool = raw.tool ?? raw.tool_name ?? raw.toolName;
  const wrapped = raw.arguments ?? raw.args ?? raw.input ?? raw.tool_input ?? raw.toolInput;
  const args = typeof wrapped === "object" && wrapped && !Array.isArray(wrapped) ? wrapped : raw;
  if (server2 === toolServerName && typeof tool === "string" && /^[a-z0-9_]+$/i.test(tool) && isKuvoTool(tool) !== false) {
    return { name: `${toolServerName}_${tool}`, input: args };
  }
  const named = (text) => new RegExp(`(?:^|[\\s:])(?:mcp__)?${toolServerName}(?:/|__|\\.|:|_)([a-z0-9_]+)\\s*$`, "i").exec(String(text ?? "").trim())?.[1];
  const prefixed = named(call.title) ?? named(tool);
  if (prefixed && isKuvoTool(prefixed.toLowerCase()) !== false)
    return { name: `${toolServerName}_${prefixed.toLowerCase()}`, input: args };
  const titled = /^(?:running\s+|tool:\s*|calling\s+)?([a-z0-9_.-]+)$/i.exec(String(call.title ?? "").trim())?.[1];
  const own = titled && typeof raw === "object" && raw ? kuvoToolName(titled, raw) : undefined;
  if (own)
    return { name: own, input: raw };
  return { name: (titled ?? call.title ?? "tool").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "") || "tool", input: raw };
}
var classified = new Set(["shell", "edit", "write", "patch", "webfetch", "websearch", "read", "grep", "glob", "list", "external_directory", "think"]);
function permissionAction(kind, name) {
  switch (kind) {
    case "execute":
      return "shell";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "fetch":
      return "webfetch";
    case "read":
    case "search":
      return "read";
  }
  return name;
}
function resources(call) {
  const raw = call.rawInput ?? {};
  if (call.kind === "execute") {
    const command = Array.isArray(raw.command) ? raw.command.join(" ") : raw.command ?? backticked(call.title);
    return [command ?? call.title ?? "*"];
  }
  const paths = (call.locations ?? []).map((location) => location.path).filter(Boolean);
  if (paths.length)
    return paths;
  return [raw.path ?? raw.url ?? raw.file_path ?? "*"];
}
function clientRead(call) {
  const named = `${call.title ?? ""} ${call.rawInput?.name ?? ""}`;
  return /client_view_file/i.test(named) || !/view_file/i.test(named);
}
function refusedWhat(action, resources2) {
  const what = resources2.filter((resource) => resource !== "*").join(", ");
  if (action === "shell")
    return what ? `running \`${what}\`` : "running that command";
  if (action === "edit")
    return what ? `editing ${what}` : "editing files";
  if (action === "webfetch")
    return what ? `opening ${what}` : "opening that page";
  if (action === "read")
    return what ? `reading ${what}` : "reading that";
  return what ? `${action} on ${what}` : `that (${action})`;
}
function backticked(title) {
  return typeof title === "string" ? title.match(/`([^`]+)`/)?.[1] : undefined;
}
function contentText(content) {
  if (!content)
    return "";
  if (typeof content === "string")
    return content;
  if (content.type === "text")
    return content.text ?? "";
  if (content.type === "resource_link")
    return content.name ?? content.uri ?? "";
  if (content.type === "resource")
    return content.resource?.text ?? "";
  return "";
}
function toolOutput(call) {
  const parts = [];
  const pictures = [];
  for (const part of call.content ?? []) {
    if (part?.type === "content") {
      const content = part.content;
      if (content?.type === "image")
        pictures.push(pictureData(content.data, content.mimeType));
      else if (content?.type === "resource" && content.resource?.blob)
        pictures.push(pictureData(content.resource.blob, content.resource.mimeType));
      else if (content?.type === "resource_link")
        parts.push(`${content.name ?? content.title ?? "Link"}: ${content.uri ?? ""}`);
      else
        parts.push(contentText(content));
    } else if (part?.type === "terminal")
      continue;
  }
  const raw = call.rawOutput;
  if (!parts.length && raw) {
    if (typeof raw === "string")
      parts.push(raw);
    else {
      for (const key of ["output_for_prompt", "combinedOutput", "combined_output", "output", "stdout", "content"]) {
        const value = raw[key];
        if (typeof value === "string" && value) {
          parts.push(value);
          break;
        }
      }
      for (const key of ["stderr", "error", "message"])
        if (typeof raw[key] === "string" && raw[key] && !parts.includes(raw[key]))
          parts.push(raw[key]);
      if (!parts.length && typeof raw === "object" && Object.keys(raw).length)
        parts.push(JSON.stringify(raw, null, 2));
    }
  }
  const text = parts.filter(Boolean).join(`
`);
  return { text: text.length > outputLimit2 ? text.slice(-outputLimit2) : text, pictures };
}
function firstLine(text) {
  const line = (text ?? "").split(`
`).find((part) => part.trim())?.trim() ?? "";
  return line.length > 80 ? line.slice(0, 79) + "\u2026" : line;
}
function errorText(error) {
  if (error instanceof RPCError) {
    const data = error.data;
    return data?.message ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
function safeBase64(path) {
  try {
    return readFileSync7(path).toString("base64");
  } catch {
    return;
  }
}
function questionFields(questions) {
  return questions.map((question, index) => ({
    key: question.id ?? `q${index}`,
    title: question.header ?? `Question ${index + 1}`,
    description: question.question,
    required: true,
    type: question.multiSelect ? "multiselect" : "string",
    options: (question.options ?? []).map((option) => ({ value: option.label, label: option.label, description: option.description })),
    custom: true
  }));
}

// Agents/src/signin.ts
import { chmodSync, existsSync as existsSync4, mkdirSync as mkdirSync7, readFileSync as readFileSync8, rmSync as rmSync5, writeFileSync as writeFileSync7 } from "fs";
import { join as join8 } from "path";
function catcher(temporary) {
  const path = join8(temporary, "bin", "kuvo-catch-url");
  if (!existsSync4(path)) {
    mkdirSync7(join8(temporary, "bin"), { recursive: true });
    writeFileSync7(path, `#!/bin/sh
printf '%s\\n' "$1" >> "$KUVO_URL_FILE"
`);
    chmodSync(path, 493);
  }
  return path;
}
async function commandSignIn(options) {
  const urlFile = join8(options.temporary, `${newID("att")}.url`);
  const child = Bun.spawn([options.command, ...options.args], {
    env: { ...process.env, ...options.env, BROWSER: catcher(options.temporary), KUVO_URL_FILE: urlFile },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  let output = "";
  let status = { status: "pending" };
  const read = async (stream) => {
    const decoder = new TextDecoder;
    for await (const chunk of stream)
      output += plain(decoder.decode(chunk));
  };
  read(child.stdout);
  read(child.stderr);
  let pasted = false;
  let signedInBefore;
  const succeed = () => {
    status = { status: "complete" };
    options.onComplete?.();
  };
  child.exited.then(async (code) => {
    rmSync5(urlFile, { force: true });
    if (status.status !== "pending")
      return;
    const signedIn = await options.signedIn().catch(() => false);
    if (status.status !== "pending")
      return;
    if (signedIn && (code === 0 || signedInBefore === false))
      succeed();
    else if (pasted)
      status = { status: "failed", message: "That code didn't work. Start again, and paste the code from the page this sign-in opens." };
    else
      status = { status: "failed", message: lastLines(options.codePrompt ? output.replace(options.codePrompt, "") : output) || `Signing in stopped (exit code ${code}).` };
  });
  (async () => {
    signedInBefore = await options.signedIn().catch(() => true);
    if (signedInBefore)
      return;
    while (status.status === "pending") {
      await Bun.sleep(3000);
      if (status.status !== "pending")
        return;
      if (!await options.signedIn().catch(() => false))
        continue;
      if (status.status === "pending")
        succeed();
      child.kill();
    }
  })();
  let url = "";
  let printedAt;
  for (let waited = 0;waited < 15000 && !url; waited += 200) {
    const printed = firstURL(output);
    if (options.printedPage) {
      if (printed)
        url = printed;
    } else {
      if (existsSync4(urlFile))
        url = readFileSync8(urlFile, "utf8").split(`
`)[0].trim();
      if (printed)
        printedAt ??= waited;
      if (!url && printed && waited - printedAt >= 3000)
        url = printed;
    }
    if (!url)
      await Bun.sleep(200);
    if (status.status !== "pending")
      break;
  }
  let userCode;
  for (let waited = 0;options.userCode && waited < 2000; waited += 200) {
    userCode = options.userCode.exec(output)?.[1];
    if (userCode || status.status !== "pending")
      break;
    await Bun.sleep(200);
  }
  return {
    url,
    userCode,
    instructions: options.instructions,
    mode: "auto",
    acceptsCode: Boolean(options.codePrompt),
    complete: options.codePrompt ? async (code) => {
      if (status.status !== "pending")
        throw new Error("That sign-in is over. Start it again.");
      pasted = true;
      const from = output.length;
      child.stdin.write(code.trim() + `
`);
      await child.stdin.flush();
      for (let waited = 0;waited < 1500 && status.status === "pending"; waited += 100) {
        await Bun.sleep(100);
        if (/invalid code/i.test(output.slice(from))) {
          pasted = false;
          throw new Error("That code couldn't be read. Copy all of it from the page, and paste it again.");
        }
      }
    } : undefined,
    status: () => status,
    cancel() {
      if (status.status === "pending")
        status = { status: "failed", message: "Cancelled." };
      child.kill();
    }
  };
}
function lastLines(text) {
  return text.trim().split(`
`).slice(-4).join(`
`).trim();
}

// Agents/src/skills.ts
import { createHash as createHash2 } from "crypto";
import { cpSync, existsSync as existsSync5, mkdirSync as mkdirSync8, readdirSync as readdirSync3, readFileSync as readFileSync9, renameSync as renameSync3, rmSync as rmSync6, statSync as statSync2, symlinkSync, utimesSync, writeFileSync as writeFileSync8 } from "fs";
import { dirname as dirname3, join as join9, resolve as resolve3, sep as sep2 } from "path";
var link;
var home;
function setSkillSource(engine, folder) {
  link = engine;
  home = folder;
}
var listed = new Map;
var said = new Map;
function skillFolders() {
  return [...new Set([...said.values()].flat().map((skill) => skill.folder))];
}
function engineSkills(directory) {
  const known = listed.get(directory);
  if (known && Date.now() - known.at < 60000)
    return known.skills;
  const skills = (async () => {
    if (!link?.ready)
      return [];
    try {
      const answer = await link.request("GET", "/api/skill", undefined, 1e4, directory);
      const list = Array.isArray(answer?.data) ? answer.data : Array.isArray(answer) ? answer : [];
      const found = [];
      for (const skill of list) {
        const name = typeof skill?.name === "string" ? skill.name : typeof skill?.id === "string" ? skill.id : undefined;
        const path = typeof skill?.path === "string" ? skill.path : undefined;
        if (!name || !path || path.startsWith("/builtin/") || !path.endsWith("SKILL.md") || !existsSync5(path))
          continue;
        found.push({ name, folder: dirname3(path) });
      }
      if (!list.length)
        listed.delete(directory);
      said.set(directory, found);
      return found;
    } catch {
      listed.delete(directory);
      return [];
    }
  })();
  listed.set(directory, { at: Date.now(), skills });
  return skills;
}
function upward(directory) {
  const folders = [];
  let at = resolve3(directory);
  while (true) {
    folders.push(at);
    const up = dirname3(at);
    if (up === at)
      return folders;
    at = up;
  }
}
function within(path, folders) {
  return folders.some((folder) => path === folder || path.startsWith(folder.endsWith(sep2) ? folder : folder + sep2));
}
async function skillsFor(directory, own, off) {
  const seen = new Set;
  const skills = [];
  for (const skill of await engineSkills(directory)) {
    if (seen.has(skill.name) || off(skill.name) || within(skill.folder, own))
      continue;
    seen.add(skill.name);
    skills.push(skill);
  }
  return skills;
}
function turnedOff(hooks) {
  return (name) => hooks.check({ action: "skill", resources: [name] }) === "deny";
}
function folderName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "skill";
}
var largest = 20 * 1024 * 1024;
function stamp(folder) {
  let files = 0;
  let size = 0;
  let changed = 0;
  const visit = (at, depth) => {
    for (const name of readdirSync3(at)) {
      const path = join9(at, name);
      const info = statSync2(path);
      changed = Math.max(changed, info.mtimeMs);
      if (info.isDirectory()) {
        if (depth < 8 && !visit(path, depth + 1))
          return false;
      } else {
        files += 1;
        size += info.size;
        if (size > largest || files > 2000)
          return false;
      }
    }
    return true;
  };
  try {
    return visit(folder, 0) ? `${files}:${size}:${Math.round(changed)}` : undefined;
  } catch {
    return;
  }
}
function named(skills) {
  const names = new Set;
  const list = [];
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name))) {
    const now = stamp(skill.folder);
    if (!now)
      continue;
    let name = folderName(skill.name);
    for (let n = 2;names.has(name); n++)
      name = `${folderName(skill.name)}-${n}`;
    names.add(name);
    list.push({ name, skill, stamp: now });
  }
  return list;
}
function copy(from, to) {
  try {
    cpSync(from, to, { recursive: true, dereference: true, errorOnExist: false, force: true });
    return true;
  } catch {
    rmSync6(to, { recursive: true, force: true });
    return false;
  }
}
function skillsFolder(skills) {
  if (!home || !skills.length)
    return;
  const list = named(skills);
  if (!list.length)
    return;
  const set = createHash2("sha256").update(list.map((entry) => `${entry.name}\x00${entry.skill.folder}\x00${entry.stamp}`).join(`
`)).digest("hex").slice(0, 16);
  const root = join9(home, "skills");
  const folder = join9(root, set);
  const now = new Date;
  if (existsSync5(join9(folder, ".claude-plugin", "plugin.json"))) {
    try {
      utimesSync(folder, now, now);
    } catch {}
    return folder;
  }
  tidy(root);
  const making = join9(root, `.${set}-${process.pid}`);
  rmSync6(making, { recursive: true, force: true });
  mkdirSync8(join9(making, "skills"), { recursive: true, mode: 448 });
  mkdirSync8(join9(making, ".claude-plugin"), { recursive: true });
  mkdirSync8(join9(making, ".cursor"), { recursive: true });
  for (const entry of list)
    copy(entry.skill.folder, join9(making, "skills", entry.name));
  writeFileSync8(join9(making, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kuvo-code", description: "The skills in Kuvo Code's Settings \u203A Skills.", version: "1.0.0" }, null, 2) + `
`);
  symlinkSync(join9("..", "skills"), join9(making, ".cursor", "skills"));
  try {
    renameSync3(making, folder);
  } catch {
    rmSync6(making, { recursive: true, force: true });
  }
  return folder;
}
function tidy(root) {
  let names = [];
  try {
    names = readdirSync3(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join9(root, name);
    try {
      if (Date.now() - statSync2(path).mtimeMs > 86400000)
        rmSync6(path, { recursive: true, force: true });
    } catch {}
  }
}
function copySkillsInto(folder, skills) {
  const list = named(skills);
  const record = join9(folder, ".kuvo-code");
  let before = {};
  try {
    before = JSON.parse(readFileSync9(record, "utf8"));
  } catch {}
  const after = {};
  for (const entry of list)
    after[entry.name] = `${entry.skill.folder}\x00${entry.stamp}`;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    mkdirSync8(folder, { recursive: true, mode: 448 });
    for (const name of Object.keys(before))
      if (before[name] !== after[name])
        rmSync6(join9(folder, folderName(name)), { recursive: true, force: true });
    for (const entry of list) {
      if (before[entry.name] === after[entry.name] && existsSync5(join9(folder, entry.name)))
        continue;
      if (!existsSync5(join9(folder, entry.name)) && !copy(entry.skill.folder, join9(folder, entry.name)))
        delete after[entry.name];
    }
    writeFileSync8(record, JSON.stringify(after));
  }
  return list.length ? createHash2("sha256").update(JSON.stringify(after)).digest("hex").slice(0, 16) : undefined;
}

// Agents/src/agents/antigravity.ts
var version = "1.3.0";
var releases = {
  "darwin-arm64": {
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip",
    sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
    bytes: 111456962
  },
  "darwin-x64": {
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip",
    sha256: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
    bytes: 117245544
  },
  "linux-x64": {
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip",
    sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
    bytes: 333727150
  },
  "linux-arm64": {
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip",
    sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
    bytes: 321690363
  }
};
var executableName = "agy_acp_server.par";
var harnessName = "localharness_external";
var signInLine = "Open the following link to authenticate the ACP server:";
var scrubbed = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE"
];
function antigravitySubagents(args) {
  let list = args?.Subagents;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list))
    return [];
  return list.map((subagent) => ({
    title: String(subagent?.Role ?? subagent?.TypeName ?? "A subagent's task"),
    prompt: typeof subagent?.Prompt === "string" ? subagent.Prompt : undefined,
    agent: typeof subagent?.TypeName === "string" && subagent.TypeName !== "self" ? subagent.TypeName : undefined
  }));
}
function generatedImages(folder, input, since) {
  const stem = String(decoded(input.image_name ?? input.ImageName ?? "") ?? "");
  if (!stem && since === undefined)
    return [];
  let names;
  try {
    names = readdirSync4(folder);
  } catch {
    return [];
  }
  const types2 = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  const images = names.map((name) => ({ name, type: types2[name.split(".").pop()?.toLowerCase() ?? ""] })).filter((file) => file.type && (!stem || file.name.startsWith(`${stem}_`) || file.name.startsWith(`${stem}.`))).map((file) => ({ ...file, at: (() => {
    try {
      return statSync3(join10(folder, file.name)).mtimeMs;
    } catch {
      return 0;
    }
  })() })).filter((file) => stem || file.at >= since).sort((a, b) => b.at - a.at);
  const newest = images[0];
  return newest ? [{ type: "file", uri: pathToFileURL2(join10(folder, newest.name)).href, mime: newest.type, name: newest.name }] : [];
}

class AntigravityFollower {
  brain;
  sessionId;
  every;
  seen = new Set;
  pending = [];
  children = new Map;
  timer;
  turn;
  hooks;
  constructor(brain, sessionId, every = 1000) {
    this.brain = brain;
    this.sessionId = sessionId;
    this.every = every;
    for (const step of this.steps(sessionId))
      this.seen.add(step.step_index);
  }
  follow(turn, hooks) {
    clearInterval(this.timer);
    this.turn = turn;
    this.hooks = hooks;
    for (const child of this.children.values())
      if (!child.ended && child.run.turn.isEnded)
        child.ended = true;
    this.timer = setInterval(() => this.read(), this.every);
    return this;
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.read();
    for (const child of this.children.values())
      if (!child.ended && this.isDone(child))
        this.end(child);
  }
  steps(conversation) {
    try {
      return readFileSync10(join10(this.brain, conversation, ".system_generated", "logs", "transcript.jsonl"), "utf8").split(`
`).flatMap((line) => {
        try {
          const step = JSON.parse(line);
          return typeof step?.step_index === "number" ? [step] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
  read() {
    if (!this.turn || this.turn.isEnded)
      return;
    for (const step of this.steps(this.sessionId)) {
      if (this.seen.has(step.step_index) || step.status === "RUNNING")
        continue;
      this.seen.add(step.step_index);
      for (const call of step.tool_calls ?? [])
        if (call?.name === "invoke_subagent")
          this.pending.push(...antigravitySubagents(call.args));
      if (step.type === "INVOKE_SUBAGENT" && typeof step.content === "string") {
        for (const match of step.content.matchAll(/"conversationId":\s*"([^"]+)"/g))
          this.start(match[1]);
      }
    }
    for (const child of this.children.values())
      this.readChild(child);
  }
  start(id) {
    if (this.children.has(id))
      return;
    const task = this.pending.shift() ?? { title: "A subagent's task" };
    const row = `agy-subagent:${id}`;
    this.turn.toolStart(row, "subagent", { description: task.title, prompt: task.prompt, agent: task.agent });
    const run2 = this.hooks.subagent(row, task);
    this.turn.toolSucceeded(row, "Started.", { sessionID: run2.sessionID });
    this.children.set(id, { id, row, task, run: run2, shown: new Map, open: [], results: new Map, toolsSinceText: false, ended: false });
  }
  readChild(child) {
    const steps = this.steps(child.id);
    for (const step of steps) {
      const was = child.shown.get(step.step_index);
      if (was === step.status)
        continue;
      if (child.ended && was === undefined) {
        child.run = this.hooks.subagent(child.row, { ...child.task, prompt: undefined, sessionID: child.run.sessionID });
        child.ended = false;
        child.toolsSinceText = false;
      }
      child.shown.set(step.step_index, step.status ?? "");
      if (was === undefined)
        this.show(child, step);
      else
        this.settle(child, step);
    }
    if (!child.ended && this.isDone(child, steps))
      this.end(child);
  }
  show(child, step) {
    const turn = child.run.turn;
    if (step.type === "SYSTEM_MESSAGE" || step.type === "USER_INPUT")
      return;
    if (step.type === "PLANNER_RESPONSE") {
      if (step.content?.trim()) {
        if (child.toolsSinceText) {
          turn.endStep();
          turn.startStep();
          child.toolsSinceText = false;
        }
        turn.text(step.content);
        turn.endBlock();
      }
      (step.tool_calls ?? []).forEach((call, index) => {
        const id2 = `${child.id}:${step.step_index}:${index}`;
        const tool = followedTool(call);
        turn.toolStart(id2, tool.name, tool.input);
        child.open.push(id2);
        child.toolsSinceText = true;
      });
      return;
    }
    const id = child.open[0];
    if (!id)
      return;
    child.results.set(step.step_index, id);
    this.settle(child, step);
  }
  settle(child, step) {
    const id = child.results.get(step.step_index);
    if (!id || !child.open.includes(id))
      return;
    child.open = child.open.filter((open) => open !== id);
    const output = resultText(step.content);
    if (step.status === "ERROR" || step.status === "FAILED" || step.status === "CANCELED")
      child.run.turn.toolFailed(id, output || "The tool failed.");
    else
      child.run.turn.toolSucceeded(id, output);
  }
  isDone(child, steps = this.steps(child.id)) {
    const last2 = steps.at(-1);
    if (!last2 || last2.type !== "PLANNER_RESPONSE" || last2.status !== "DONE" || last2.tool_calls?.length)
      return false;
    return steps.every((step) => {
      if (step.status !== "RUNNING")
        return true;
      const task = /task id: (\S+)/.exec(step.content ?? "")?.[1];
      return Boolean(task && steps.some((later) => later.step_index > step.step_index && later.type === "SYSTEM_MESSAGE" && (later.content ?? "").includes(`sender=${task}`)));
    });
  }
  end(child) {
    child.ended = true;
    child.run.end("succeeded");
  }
}
function followedTool(call) {
  const args = {};
  for (const [key, value] of Object.entries(call.args ?? {})) {
    if (key === "toolAction" || key === "toolSummary")
      continue;
    args[key] = decoded(value);
  }
  const description = decoded(call.args?.toolSummary);
  const name = call.name ?? "tool";
  switch (name) {
    case "run_command":
      return { name: "shell", input: { command: args.CommandLine ?? args.Command, cwd: args.Cwd, description } };
    case "view_file":
      return { name: "read", input: { path: args.AbsolutePath ?? args.File } };
    case "write_to_file":
      return { name: "write", input: { path: args.TargetFile, content: args.CodeContent } };
    case "replace_file_content":
    case "multi_replace_file_content":
      return { name: "edit", input: { path: args.TargetFile, description } };
    case "grep_search":
      return { name: "grep", input: { pattern: args.Query, path: args.SearchPath } };
    case "list_dir":
      return { name: "list", input: { path: args.DirectoryPath } };
    case "find_by_name":
      return { name: "glob", input: { pattern: args.Pattern, path: args.SearchDirectory } };
    case "read_url_content":
      return { name: "webfetch", input: { url: args.Url } };
    case "search_web":
      return { name: "websearch", input: { query: args.query ?? args.Query } };
  }
  return { name, input: { ...args, ...description ? { description } : {} } };
}
function decoded(value) {
  if (typeof value !== "string")
    return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function resultText(content) {
  return (content ?? "").replace(/^(Created At|Completed At):[^\n]*\n?/gm, "").trim();
}

class AntigravityAgent {
  context;
  instance;
  id = "antigravity";
  providerID;
  get name() {
    return accountName("Antigravity", this.instance);
  }
  installing;
  downloaded;
  constructor(context, instance = { id: "default" }) {
    this.context = context;
    this.instance = instance;
    this.providerID = providerID("antigravity", instance.id);
  }
  get root() {
    return join10(this.context.home, "antigravity");
  }
  get folder() {
    return join10(this.root, version);
  }
  get profile() {
    return this.instance.home ? join10(this.instance.home, "profile") : join10(this.root, "profile");
  }
  get tokenFile() {
    return join10(this.profile, "antigravity-acp", "acp_token.json");
  }
  get modelsFile() {
    return join10(this.profile, "kuvo-models.json");
  }
  get isInstalled() {
    return existsSync6(join10(this.folder, ".complete"));
  }
  methods() {
    return [{ type: "oauth", id: "oauth-personal", label: "Sign in with Google" }];
  }
  endedSignIn;
  signInEnded() {
    try {
      this.endedSignIn = statSync3(this.tokenFile).mtimeMs;
    } catch {}
    emit("integration.updated", { integrationID: this.providerID });
  }
  async account() {
    const release = releases[`${process.platform}-${process.arch}`];
    if (!release)
      return { installed: false, signedIn: false, message: "Google doesn't make Antigravity's agent for this computer." };
    if (this.endedSignIn !== undefined) {
      let now;
      try {
        now = statSync3(this.tokenFile).mtimeMs;
      } catch {}
      if (now === this.endedSignIn)
        return { installed: this.isInstalled, signedIn: false, ended: true, message: "Google ended this sign-in. Sign in again." };
      this.endedSignIn = undefined;
    }
    if (!existsSync6(this.tokenFile)) {
      return {
        installed: this.isInstalled,
        signedIn: false,
        message: this.isInstalled ? "Sign in with your Google account." : `Sign in with your Google account. Kuvo Code downloads Google's Antigravity agent (about ${Math.round(release.bytes / 1e6)} MB) first.`
      };
    }
    return { installed: this.isInstalled, signedIn: true, label: "Google account" };
  }
  ensureInstalled() {
    if (this.isInstalled)
      return Promise.resolve();
    this.installing ??= this.download().finally(() => this.installing = undefined);
    return this.installing;
  }
  async download() {
    const release = releases[`${process.platform}-${process.arch}`];
    if (!release)
      throw new Error("Google doesn't make Antigravity's agent for this computer.");
    const staging = join10(this.root, `.install-${newID("att")}`);
    mkdirSync9(staging, { recursive: true });
    try {
      const archive = join10(staging, "download.zip");
      const response = await fetch(release.url);
      if (!response.ok || !response.body)
        throw new Error(`Couldn't download Antigravity's agent (HTTP ${response.status}).`);
      const hash = createHash3("sha256");
      const writer = Bun.file(archive).writer();
      let bytes = 0;
      this.downloaded = { bytes, total: release.bytes };
      for await (const chunk of response.body) {
        hash.update(chunk);
        writer.write(chunk);
        bytes += chunk.byteLength;
        this.downloaded = { bytes, total: release.bytes };
      }
      await writer.end();
      if (bytes !== release.bytes || hash.digest("hex") !== release.sha256)
        throw new Error("Antigravity's agent didn't download whole. Try again.");
      const zip = unzipper();
      const listed2 = await run(zip.program, zip.list(archive));
      const entries = listed2.stdout.split(`
`).filter(Boolean).sort();
      if (entries.join(",") !== [executableName, harnessName].sort().join(","))
        throw new Error("Antigravity's agent wasn't what Kuvo Code expected.");
      const unzipped = await run(zip.program, zip.extract(archive, staging));
      if (unzipped.code !== 0)
        throw new Error(`Couldn't unpack Antigravity's agent: ${unzipped.stderr.trim()}`);
      rmSync7(archive, { force: true });
      for (const name of [executableName, harnessName])
        chmodSync2(join10(staging, name), 493);
      writeFileSync9(join10(staging, ".complete"), JSON.stringify({ version, sha256: release.sha256 }));
      rmSync7(this.folder, { recursive: true, force: true });
      renameSync4(staging, this.folder);
      for (const name of readdirSync4(this.root)) {
        if (name !== version && name !== "profile" && /^\d/.test(name))
          rmSync7(join10(this.root, name), { recursive: true, force: true });
      }
    } finally {
      this.downloaded = undefined;
      rmSync7(staging, { recursive: true, force: true });
    }
  }
  ownSkillFolders(directory) {
    return [join10(this.profile, "antigravity-cli", "skills"), join10(directory, ".agents", "skills"), join10(directory, ".gemini", "skills")];
  }
  launch() {
    mkdirSync9(join10(this.profile, "antigravity-acp", "tmp"), { recursive: true, mode: 448 });
    const settings = join10(this.profile, "antigravity-acp", "settings.json");
    if (!existsSync6(settings))
      writeFileSync9(settings, JSON.stringify({ auth: { type: "oauth-personal" } }));
    const temporary = join10(this.context.temporary, "antigravity", newID("att"));
    mkdirSync9(temporary, { recursive: true });
    let env = {};
    for (const [key, value] of Object.entries(process.env))
      if (!scrubbed.includes(key.toUpperCase()))
        env[key] = value;
    env = withOwnFolders(env);
    Object.assign(env, {
      GEMINI_HOME: this.profile,
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      BROWSER: catcher(this.context.temporary),
      KUVO_URL_FILE: join10(temporary, "url"),
      PYTHONUNBUFFERED: "1",
      TMPDIR: temporary,
      ANTIGRAVITY_HARNESS_PATH: join10(this.folder, harnessName)
    });
    const argv = [join10(this.folder, executableName), "--nosyslog_on_start", ...process.platform === "linux" ? ["--uid="] : []];
    return { argv, env, cleanEnv: true, onExit: () => rmSync7(temporary, { recursive: true, force: true }), signInFile: join10(temporary, "url") };
  }
  signsInRemotely = true;
  async signIn() {
    let status = { status: "pending" };
    let link2 = "";
    let rpc;
    let cancelled = false;
    const found = (url) => {
      if (!link2 && url.startsWith("https://"))
        link2 = url;
    };
    const flow = async () => {
      await this.ensureInstalled();
      if (cancelled)
        return;
      const launch = this.launch();
      const cwd = join10(this.context.temporary, "antigravity", newID("att"));
      mkdirSync9(cwd, { recursive: true });
      rpc = new RPC(launch.argv, {
        cwd,
        env: launch.env,
        cleanEnv: true,
        jsonrpc: true,
        firstID: 2 ** 30,
        filter: (line) => {
          const at = line.indexOf(signInLine);
          if (at >= 0) {
            found(line.slice(at + signInLine.length).trim());
            return false;
          }
          return true;
        }
      });
      rpc.onExit = () => {
        launch.onExit();
        rmSync7(cwd, { recursive: true, force: true });
      };
      const watch = setInterval(() => {
        try {
          found(readFileSync10(launch.env.KUVO_URL_FILE, "utf8").split(`
`)[0].trim());
        } catch {}
      }, 300);
      try {
        await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "kuvo-code", version: "1" } }, 120000);
        await rpc.request("authenticate", { methodId: "oauth-personal" }, 600000);
        const setup = await rpc.request("session/new", { cwd, mcpServers: [] }, 120000);
        this.saveModels(setup);
        if (setup?.sessionId)
          this.removeSessionFiles(setup.sessionId);
        if (!cancelled)
          status = { status: "complete" };
      } finally {
        clearInterval(watch);
        rpc.kill();
      }
    };
    flow().catch((error) => {
      if (status.status !== "pending")
        return;
      const message = String(error?.message ?? error);
      status = {
        status: "failed",
        message: cancelled ? "Cancelled." : /SUBSCRIPTION_REQUIRED/i.test(message) ? "Google says this account needs an Antigravity subscription." : /access_denied/i.test(message) ? "Google sign-in wasn't approved." : failure(error).message
      };
    });
    return {
      url: "",
      instructions: "Finish signing in with Google in your browser.",
      mode: "auto",
      status: () => {
        if (status.status !== "pending")
          return status;
        const downloading = this.downloaded;
        if (downloading) {
          const percent = Math.floor(downloading.bytes / downloading.total * 100);
          return { status: "pending", message: `Downloading Google's Antigravity agent\u2026 ${percent}%` };
        }
        if (!link2)
          return { status: "pending", message: "Starting Google's Antigravity agent\u2026" };
        return { status: "pending", url: link2, message: "Finish signing in with Google in your browser." };
      },
      cancel: () => {
        cancelled = true;
        if (status.status === "pending")
          status = { status: "failed", message: "Cancelled." };
        rpc?.kill();
      }
    };
  }
  async signOut() {
    rmSync7(this.tokenFile, { force: true });
    rmSync7(this.modelsFile, { force: true });
  }
  saveModels(setup) {
    const option = (setup?.configOptions ?? []).find((option2) => option2.id === "model" || option2.category === "model");
    const flat = [];
    for (const entry of option?.options ?? []) {
      if (Array.isArray(entry.options))
        for (const inner of entry.options)
          flat.push({ value: inner.value, name: inner.name ?? inner.value });
      else if (entry.value)
        flat.push({ value: entry.value, name: entry.name ?? entry.value });
    }
    if (!flat.length) {
      for (const info of setup?.models?.availableModels ?? [])
        flat.push({ value: info.modelId, name: info.name ?? info.modelId });
    }
    if (flat.length)
      writeFileSync9(this.modelsFile, JSON.stringify({ current: option?.currentValue, models: flat }));
  }
  removeSessionFiles(sessionID) {
    const folder = join10(this.profile, "antigravity-acp");
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"])
      rmSync7(join10(folder, "conversations", sessionID + suffix), { force: true });
    rmSync7(join10(folder, "brain", sessionID), { recursive: true, force: true });
  }
  async models() {
    try {
      const saved = JSON.parse(readFileSync10(this.modelsFile, "utf8"));
      return saved.models.map((info, index) => model(this.providerID, info.value, info.name, { images: true, released: info.value === saved.current ? 2000 : 1000 - index, context: this.windows.get(info.value) ?? 1e6 }));
    } catch {
      return [];
    }
  }
  windows = new ContextWindows;
  thread(session, state) {
    const agent = this;
    const followers = new Map;
    return new AcpThread({
      noteContext(model2, size) {
        if (agent.windows.note(model2, size))
          emit("model.updated", {});
      },
      fileSystem: true,
      authenticatesFirst: true,
      resumes: true,
      limitScope: "model",
      follow: (sessionId, turn, hooks) => {
        let follower = followers.get(sessionId);
        if (!follower)
          followers.set(sessionId, follower = new AntigravityFollower(join10(agent.profile, "antigravity-acp", "brain"), sessionId));
        return follower.follow(turn, hooks);
      },
      hides: (call) => /\b(start_subagent|invoke_subagent)\b/.test(`${call?.title ?? ""} ${call?.rawInput?.name ?? ""}`),
      madeFiles: (call, sessionId, since) => /\bgenerate_image\b/.test(String(call?.title ?? "")) ? generatedImages(join10(agent.profile, "antigravity-acp", "brain", sessionId), call?.rawInput ?? {}, since) : [],
      authMethod: () => "oauth-personal",
      async command() {
        if (!agent.isInstalled)
          throw new Error("Sign in to Antigravity in Settings \u203A Accounts first.");
        return agent.launch();
      },
      async skills(directory, hooks) {
        return copySkillsInto(join10(agent.profile, "config", "skills"), await skillsFor(directory, agent.ownSkillFolders(directory), turnedOff(hooks)));
      },
      asksSignIn: (line) => line.includes(signInLine),
      limitReply: (text) => {
        const plain2 = text.replace(/[#*_>`]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        return /^usage limit reached\.? you have reached your current quota for this period\.?(?: your limit will reset in [^.]{1,80}\.?)?$/.test(plain2);
      },
      signInEnded: () => agent.signInEnded(),
      async selectModel(rpc, sessionId, modelID, setup) {
        if (setup?.kuvoModel === modelID)
          return;
        await rpc.request("session/set_config_option", { sessionId, configId: "model", value: modelID }, 30000);
        setup.kuvoModel = modelID;
        agent.saveModels(setup);
      },
      async selectMode(rpc, sessionId, { approvesAll, plan }, setup) {
        const option = (setup?.configOptions ?? []).find((option2) => option2.id === "mode" || option2.category === "mode");
        const values = (option?.options ?? []).map((entry) => entry.value);
        const wanted = plan && values.includes("plan") ? "plan" : approvesAll ? "yolo" : "default";
        const current = setup?.kuvoMode ?? option?.currentValue;
        if (current === wanted)
          return;
        const cantAsk = () => new Error("Antigravity couldn't be set to ask before it acts, so it didn't start. Try again, or pick Approve All for this session.");
        if (!option || values.length && !values.includes(wanted)) {
          if (wanted !== "yolo" && current === "yolo")
            throw cantAsk();
          return;
        }
        try {
          await rpc.request("session/set_config_option", { sessionId, configId: option.id, value: wanted }, 30000);
        } catch {
          if (wanted !== "yolo")
            throw cantAsk();
          return;
        }
        setup.kuvoMode = wanted;
      }
    }, session, state, this.name);
  }
}
function unzipper() {
  const unzip = which("unzip", ["/usr/bin"]);
  if (unzip)
    return { program: unzip, list: (archive) => ["-Z1", archive], extract: (archive, folder) => ["-q", "-o", archive, "-d", folder] };
  const python = which("python3", ["/usr/bin"]);
  if (!python)
    throw new Error("Unpacking Antigravity's agent needs unzip or Python 3 on this machine.");
  return {
    program: python,
    list: (archive) => ["-I", "-c", "import sys, zipfile; print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", archive],
    extract: (archive, folder) => ["-I", "-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", archive, folder]
  };
}

// Agents/src/agents/claude.ts
import { randomUUID } from "crypto";
import { existsSync as existsSync8, readFileSync as readFileSync11, statSync as statSync4 } from "fs";
import { homedir } from "os";
import { join as join12 } from "path";
import { pathToFileURL as pathToFileURL3 } from "url";

// Agents/src/maintenance.ts
import { existsSync as existsSync7, realpathSync as realpathSync2 } from "fs";
import { basename, join as join11 } from "path";
var checked = new Map;
var newest = new Map;
var underWay = new Map;
function oneAtATime(name, kind, task) {
  const running = underWay.get(name);
  if (running?.kind === kind)
    return running.done;
  const done = (async () => {
    await running?.done.catch(() => {});
    return task();
  })();
  const entry = { kind, done };
  underWay.set(name, entry);
  done.catch(() => {}).finally(() => {
    if (underWay.get(name) === entry)
      underWay.delete(name);
  });
  return done;
}
async function maintenance(definition, fresh = false) {
  const kept = checked.get(definition.executable);
  if (!fresh && kept && Date.now() - kept.at < 10 * 60000)
    return kept.value;
  const [installed, updater] = await Promise.all([installedVersion2(definition.executable), resolveUpdater(definition)]);
  const latest = updater.homebrew ? updater.latest : updater.latest ?? await npmLatest(definition.npmPackage, fresh, updater.distTag);
  const value = { installed, latest, command: updater.command, shown: updater.shown, env: updater.env };
  checked.set(definition.executable, { at: Date.now(), value });
  return value;
}
function isOutdated(maintenance2) {
  return Boolean(maintenance2.installed && maintenance2.latest && compareVersions(maintenance2.installed, maintenance2.latest) < 0);
}
function update(definition, temporary) {
  return oneAtATime(definition.name, "update", async () => {
    const before = await maintenance(definition, true);
    if (!before.command)
      return { updated: false, version: before.installed, message: `Update ${definition.name} the way you installed it.` };
    const ran = await runGroup(before.command[0], before.command.slice(1), { cwd: temporary, env: { ...ownEnvironment(), ...before.env }, timeout: 10 * 60000 });
    const after = await maintenance(definition, true);
    const changed = Boolean(after.installed && after.installed !== before.installed);
    if (changed || after.installed && !isOutdated(after))
      return { updated: changed, version: after.installed };
    const output = plain(ran.stderr + `
` + ran.stdout).trim().split(`
`).slice(-6).join(`
`).trim();
    return {
      updated: false,
      version: after.installed,
      message: `${definition.name} is still ${after.installed ?? "the same version"} after \`${before.shown}\`.${output ? `

${output}` : ""}`
    };
  });
}
function install(name, command, temporary, found, readPath = refreshLoginPath) {
  return oneAtATime(name, "install", async () => {
    await readPath();
    const there = found();
    if (there)
      return { installed: true, version: await installedVersion2(there) };
    const ran = await runGroup("/bin/sh", ["-c", command], { cwd: temporary, env: ownEnvironment(), timeout: 10 * 60000 });
    await readPath(true);
    const executable = found();
    if (executable)
      return { installed: true, version: await installedVersion2(executable) };
    const output = plain(ran.stderr + `
` + ran.stdout).trim().split(`
`).slice(-6).join(`
`).trim();
    return { installed: false, message: `${name} isn't installed after \`${command}\`.${output ? `

${output}` : ""}` };
  });
}
async function installedVersion2(executable) {
  const ran = await run(executable, ["--version"], { timeout: 15000 }).catch(() => {
    return;
  });
  return ran ? versionIn(plain(ran.stdout + " " + ran.stderr)) : undefined;
}
function versionIn(text) {
  return text.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/)?.[1];
}
function compareVersions(a, b) {
  const [mainA, preA] = a.split("-", 2);
  const [mainB, preB] = b.split("-", 2);
  const partsA = mainA.split(".").map(Number);
  const partsB = mainB.split(".").map(Number);
  for (let i = 0;i < Math.max(partsA.length, partsB.length); i++) {
    const difference = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (difference)
      return Math.sign(difference);
  }
  if (preA === preB)
    return 0;
  if (!preA)
    return 1;
  if (!preB)
    return -1;
  return preA < preB ? -1 : 1;
}
async function npmLatest(name, fresh, tag = "latest") {
  const key = `${name}@${tag}`;
  const kept = newest.get(key);
  if (!fresh && kept && Date.now() - kept.at < 6 * 60 * 60000)
    return kept.value;
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${tag}`, { signal: AbortSignal.timeout(1e4) });
    const value = response.ok ? (await response.json()).version ?? undefined : undefined;
    newest.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return kept?.value;
  }
}
async function resolveUpdater(definition) {
  let realPath = definition.executable;
  try {
    realPath = realpathSync2(definition.executable);
  } catch {}
  const name = basename(definition.executable);
  const native = definition.nativeUpdate;
  const nativeUpdater = native ? { command: [definition.executable, ...native.args], shown: [name, ...native.args].join(" "), distTag: native.distTag?.() } : {};
  if (native?.isNative(realPath) || native && native.isNative(definition.executable))
    return nativeUpdater;
  const prefix = npmGlobalPrefix(realPath, definition.npmPackage);
  if (prefix) {
    const npm = existsSync7(join11(prefix, "bin", "npm")) ? join11(prefix, "bin", "npm") : "npm";
    return {
      command: [npm, "install", "-g", "--prefix", prefix, `--allow-scripts=${definition.npmPackage}`, `${definition.npmPackage}@latest`],
      shown: `npm install -g ${definition.npmPackage}@latest`,
      env: { PATH: `${join11(prefix, "bin")}:${process.env.PATH ?? ""}` }
    };
  }
  const keg = homebrewKeg(realPath);
  if (keg && keg.name.toLowerCase() !== "mise") {
    const brew = existsSync7(join11(keg.prefix, "bin", "brew")) ? join11(keg.prefix, "bin", "brew") : which("brew");
    if (brew) {
      const said2 = (await run(brew, ["--prefix"], { timeout: 15000 }).catch(() => {
        return;
      }))?.stdout.trim();
      let brewPrefix = said2;
      try {
        if (said2)
          brewPrefix = realpathSync2(said2);
      } catch {}
      if (brewPrefix && brewPrefix === keg.prefix) {
        const cask = keg.kind === "cask";
        const info = await run(brew, ["info", "--json=v2", ...cask ? ["--cask"] : [], keg.name], { timeout: 30000, env: { HOMEBREW_NO_AUTO_UPDATE: "1" } }).catch(() => {
          return;
        });
        return {
          command: [brew, "upgrade", ...cask ? ["--cask"] : [], keg.name],
          shown: `brew upgrade ${cask ? "--cask " : ""}${keg.name}`,
          latest: info ? homebrewLatest(info.stdout, cask) : undefined,
          homebrew: true
        };
      }
    }
  }
  if (realPath.includes("/node_modules/") || realPath.includes("/mise/"))
    return {};
  return nativeUpdater;
}
function npmGlobalPrefix(realPath, packageName) {
  const segment = `/lib/node_modules/${packageName.toLowerCase()}/`;
  const at = realPath.toLowerCase().lastIndexOf(segment);
  if (at < 0 || realPath.slice(0, at).toLowerCase().includes("/node_modules/"))
    return;
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(realPath.slice(0, at).toLowerCase())?.[1];
  if (miseTool && miseTool !== "node")
    return;
  return at === 0 ? "/" : realPath.slice(0, at);
}
function homebrewKeg(realPath) {
  const match = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i.exec(realPath);
  if (!match)
    return;
  return { kind: match[2].toLowerCase() === "cellar" ? "formula" : "cask", name: match[3], prefix: match[1] };
}
function homebrewLatest(json, cask) {
  try {
    const info = JSON.parse(json);
    const raw = cask ? info.casks?.[0]?.version?.split(",", 1)[0] : info.formulae?.[0]?.versions?.stable;
    return raw && raw !== "latest" ? raw : undefined;
  } catch {
    return;
  }
}

// Agents/src/queue.ts
class Queue {
  items = [];
  waiting;
  closed = false;
  push(item) {
    if (this.closed)
      return;
    if (this.waiting) {
      const resolve4 = this.waiting;
      this.waiting = undefined;
      resolve4({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }
  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length)
          return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve4) => this.waiting = resolve4);
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  }
}

// Agents/src/shells.ts
var kept = new Map;
var keptAfter = 10 * 60000;
function addShell(sessionID, directory, command, output, stop) {
  const id = newID("shl");
  const job = { id, status: "running", command, cwd: directory, metadata: { sessionID }, time: { started: Date.now() } };
  kept.set(id, { job, output, stop });
  emit("shell.created", { info: job }, directory);
  return id;
}
function endShell(id, exit) {
  const one = kept.get(id);
  if (!one || one.job.status === "exited")
    return;
  one.job.status = "exited";
  if (exit !== undefined)
    one.job.exit = exit;
  emit("shell.exited", { id }, one.job.cwd);
  const timer = setTimeout(() => kept.delete(id), keptAfter);
  timer.unref?.();
}
function shells(directory) {
  return [...kept.values()].map((one) => one.job).filter((job) => !directory || job.cwd === directory);
}
function shell(id) {
  return kept.get(id)?.job;
}
async function shellOutput(id, cursor = 0, limit) {
  const one = kept.get(id);
  if (!one)
    return;
  const read = await one.output().catch(() => ({ output: "", total: 0 }));
  const bytes = Buffer.from(read.output);
  const total = Math.max(read.total, bytes.length);
  const known = total - bytes.length;
  const start = Math.max(cursor, known);
  const end = limit === undefined ? total : Math.min(total, cursor + limit);
  const output = start < end ? bytes.subarray(start - known, end - known).toString("utf8") : "";
  return { output, cursor: Math.max(start, end), size: total };
}
async function stopShell(id) {
  const one = kept.get(id);
  if (!one)
    return false;
  if (one.job.status === "running")
    await one.stop().catch(() => {});
  return true;
}

// Agents/src/agents/claude.ts
var SDK = [{ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.303" }];
var places = [join12(homedir(), ".local/bin"), join12(homedir(), ".claude/local"), "/opt/homebrew/bin", "/usr/local/bin"];
var outputLimit3 = 30000;

class ClaudeAgent {
  context;
  instance;
  id = "claude";
  providerID;
  get name() {
    return accountName("Claude Code", this.instance);
  }
  install = "curl -fsSL https://claude.ai/install.sh | bash";
  status;
  authFailedAt;
  modelList;
  loadingModels;
  program = 0;
  constructor(context, instance = { id: "default" }) {
    this.context = context;
    this.instance = instance;
    this.providerID = providerID("claude", instance.id);
  }
  executable() {
    return which("claude", places);
  }
  get definition() {
    const executable = this.executable();
    if (!executable)
      return;
    return {
      name: "Claude Code",
      executable,
      npmPackage: "@anthropic-ai/claude-code",
      nativeUpdate: { args: ["update"], isNative: (path) => /\/\.local\/share\/claude\/|\/\.claude\/local\//.test(path), distTag: updateChannel }
    };
  }
  async maintenance(fresh = false) {
    const definition = this.definition;
    return definition ? maintenance(definition, fresh) : {};
  }
  async update() {
    const definition = this.definition;
    if (!definition)
      return { updated: false, message: "Claude Code isn't installed." };
    return update(definition, this.context.temporary);
  }
  async installProgram() {
    return install("Claude Code", this.install, this.context.temporary, () => this.executable());
  }
  programUpdated() {
    this.program++;
    if (this.modelList)
      this.modelList.at = 0;
  }
  methods() {
    return [
      { type: "oauth", id: "claudeai", label: "Sign in with your Claude plan" },
      { type: "oauth", id: "console", label: "Sign in with Anthropic Console" }
    ];
  }
  async readStatus(fresh) {
    if (!fresh && this.status && Date.now() - this.status.at < 30000)
      return this.status.status;
    const executable = this.executable();
    if (!executable)
      return {};
    const result = await run(executable, ["auth", "status", "--json"], { timeout: 20000, env: this.env() });
    let status = {};
    try {
      status = JSON.parse(result.stdout);
    } catch {}
    this.status = { at: Date.now(), status };
    return status;
  }
  async account(fresh = false) {
    if (!this.executable()) {
      return { installed: false, signedIn: false, message: "Install Claude Code, then sign in here." };
    }
    const status = await this.readStatus(fresh);
    if (!status.loggedIn)
      return { installed: true, signedIn: false, message: "Sign in to Claude Code with your Claude plan or an Anthropic Console account." };
    if (this.authFailedAt && this.settingsWritten() <= this.authFailedAt + 60000) {
      return { installed: true, signedIn: false, ended: true, message: "Claude ended this sign-in. Sign in again." };
    }
    const plan = status.subscriptionType ? `${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)} plan` : undefined;
    const who = status.email ?? (status.apiProvider && status.apiProvider !== "firstParty" ? status.apiProvider : undefined);
    return { installed: true, signedIn: true, label: [who, plan].filter(Boolean).join(" \xB7 ") || "Claude Code" };
  }
  usesKey() {
    const method = this.status?.status.authMethod ?? "";
    return method !== "" && method !== "claude.ai";
  }
  settingsWritten() {
    const folder = this.instance.home ?? homedir();
    try {
      return statSync4(join12(folder, ".claude.json")).mtimeMs;
    } catch {
      return 0;
    }
  }
  signsInRemotely = true;
  async signIn(methodID, options = {}) {
    const executable = this.executable();
    if (!executable)
      throw new Error(`Install Claude Code first: ${this.install}`);
    return commandSignIn({
      command: executable,
      args: ["auth", "login", methodID === "console" ? "--console" : "--claudeai"],
      env: this.env(),
      home: this.context.home,
      temporary: this.context.temporary,
      instructions: "Finish signing in on Claude's page. Claude Code keeps the sign-in, as when you run claude auth login.",
      signedIn: async () => Boolean((await this.readStatus(true)).loggedIn),
      codePrompt: /Paste code here if prompted >\s*/g,
      onComplete: () => this.authFailedAt = undefined,
      printedPage: options.remote
    });
  }
  async sdk() {
    await this.context.deps.ensure(this.id, SDK, { optional: false });
    return this.context.deps.load(this.id, SDK[0].name);
  }
  ownSkillFolders(directory) {
    const settings = this.instance.home ?? process.env.CLAUDE_CONFIG_DIR ?? join12(homedir(), ".claude");
    return [join12(settings, "skills"), ...upward(directory).map((folder) => join12(folder, ".claude", "skills"))];
  }
  env() {
    const env = { ...process.env, CLAUDE_CODE_TMPDIR: join12(this.context.temporary, "claude") };
    if (this.instance.home)
      env.CLAUDE_CONFIG_DIR = this.instance.home;
    const own = onMachine ? ownFoldersScript(this.context.home) : undefined;
    if (own)
      env.CLAUDE_ENV_FILE = own;
    if (onMachine)
      env.DISABLE_AUTOUPDATER = "1";
    return env;
  }
  async removeAccount() {
    const executable = this.executable();
    if (executable && this.instance.home)
      await run(executable, ["auth", "logout"], { timeout: 20000, env: this.env() }).catch(() => {});
  }
  async models() {
    if (this.modelList && Date.now() - this.modelList.at < 30 * 60000)
      return this.modelList.models;
    this.loadingModels ??= this.loadModels().finally(() => this.loadingModels = undefined);
    return this.modelList?.models ?? fallbackModels(this.providerID);
  }
  async loadModels() {
    const sdk = await this.sdk();
    const abort = new AbortController;
    const idle = async function* () {
      await new Promise((resolve4) => abort.signal.addEventListener("abort", resolve4));
    }();
    const q = sdk.query({
      prompt: idle,
      options: {
        pathToClaudeCodeExecutable: this.executable(),
        cwd: this.context.temporary,
        persistSession: false,
        abortController: abort,
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settings: { disableAllHooks: true },
        env: this.env(),
        stderr: () => {}
      }
    });
    try {
      const init = await Promise.race([q.initializationResult(), Bun.sleep(30000).then(() => {
        return;
      })]);
      const list = init?.models ?? [];
      if (list.length) {
        this.listModels(list);
        if (await this.askWindows(q, list))
          this.listModels(list);
      }
    } finally {
      abort.abort();
    }
  }
  windows = new ContextWindows;
  listModels(list) {
    this.modelList = {
      at: Date.now(),
      models: list.map((info, index) => model(this.providerID, info.value, modelName(info), {
        family: family(modelName(info)),
        variants: info.supportedEffortLevels,
        images: true,
        context: this.windows.get(info.value) ?? (/1M/i.test(info.description ?? "") ? 1e6 : 200000),
        released: Date.now() - index
      }))
    };
    emit("model.updated", {});
  }
  async askWindows(q, list) {
    const said2 = new Map;
    let changed = false;
    for (const info of list) {
      const key = info.resolvedModel ?? info.value;
      let window = said2.get(key);
      if (window === undefined) {
        try {
          await withTimeout(q.setModel(info.value), 5000);
          window = (await withTimeout(q.getContextUsage({ detail: "summary" }), 5000))?.maxTokens;
        } catch {
          return changed;
        }
        if (typeof window !== "number" || window <= 0)
          return changed;
        said2.set(key, window);
      }
      if (this.windows.note(info.value, window))
        changed = true;
    }
    return changed;
  }
  forgetModels() {
    this.modelList = undefined;
  }
  thread(session, state) {
    return new ClaudeThread(this, session, state);
  }
  async generate(prompt, model2) {
    const sdk = await this.sdk();
    const abort = new AbortController;
    const timer = setTimeout(() => abort.abort(), 120000);
    const q = sdk.query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: this.executable(),
        cwd: this.context.temporary,
        model: !model2 ? "haiku" : model2.id === "default" ? undefined : model2.id,
        persistSession: false,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settings: { disableAllHooks: true },
        abortController: abort,
        env: this.env(),
        stderr: () => {}
      }
    });
    try {
      for await (const message of q) {
        if (message.type !== "result")
          continue;
        if (message.subtype === "success" && !message.is_error && typeof message.result === "string")
          return message.result.trim();
        throw new Error(typeof message.result === "string" && message.result.trim() ? message.result.trim() : "Claude Code couldn't answer.");
      }
      throw new Error("Claude Code stopped before it answered.");
    } finally {
      clearTimeout(timer);
      try {
        q.close?.();
      } catch {}
    }
  }
}
function withTimeout(promise, milliseconds) {
  return Promise.race([promise, Bun.sleep(milliseconds).then(() => Promise.reject(new Error("Claude Code didn't answer in time.")))]);
}
function modelName(info) {
  const what = info.description?.split(" \xB7 ")[0]?.trim();
  if (what && /^(opus|sonnet|haiku|fable|claude)/i.test(what))
    return what;
  return info.displayName;
}
function family(name) {
  return "claude-" + (name.split(/\s+/)[0] ?? "").toLowerCase();
}
function updateChannel() {
  try {
    const folder = process.env.CLAUDE_CONFIG_DIR ?? join12(homedir(), ".claude");
    const settings = JSON.parse(readFileSync11(join12(folder, "settings.json"), "utf8"));
    return settings?.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}
function fallbackModels(providerID2) {
  return [
    model(providerID2, "default", "Claude Code's default", { family: "claude-default", images: true, variants: ["low", "medium", "high", "xhigh", "max"], released: 3 }),
    model(providerID2, "sonnet", "Sonnet", { family: "claude-sonnet", images: true, variants: ["low", "medium", "high", "max"], released: 2 }),
    model(providerID2, "haiku", "Haiku", { family: "claude-haiku", images: true, released: 1 })
  ];
}
var goingOnLimit = 60000;

class ClaudeThread {
  agent;
  session;
  state;
  subagentSessions = new Map;
  query;
  input;
  active;
  lastHooks;
  noticed = new Set;
  onOwnTurn;
  own;
  backgroundLanes = new Map;
  tasks = new Map;
  liveTasks = new Set;
  commands = new Map;
  lastEnded;
  opened;
  constructor(agent, session, state) {
    this.agent = agent;
    this.session = session;
    this.state = state;
  }
  async run(input, turn, hooks) {
    if (input.adopt)
      return this.adopt(input, turn, hooks);
    const own = this.own;
    this.own = undefined;
    own?.take?.();
    const sdk = await this.agent.sdk();
    if (hooks.signal.aborted)
      return { outcome: "interrupted" };
    const modelID = input.model.id;
    const effort = input.model.variant;
    const append = hooks.instructions();
    const tools = kuvoTools(this.session.id);
    const skills = skillsFolder(await skillsFor(this.session.location.directory, this.agent.ownSkillFolders(this.session.location.directory), turnedOff(hooks)));
    if (this.query && (this.opened?.append !== append || this.opened?.program !== this.agent.program || this.opened?.tools !== tools?.key || this.opened?.skills !== skills))
      this.close();
    if (!this.query) {
      this.open(sdk, modelID, effort, input.plan, append, hooks, skills);
      if (tools) {
        const entry = tools.kind === "http" ? { type: "http", url: tools.url, headers: tools.headers, timeout: tools.timeout } : { type: "stdio", command: tools.command, args: tools.args, env: tools.env, timeout: tools.timeout };
        await this.query?.setMcpServers({ [tools.name]: entry }).catch(() => {});
      }
    } else {
      if (this.opened?.model !== modelID)
        await this.query.setModel(modelID === "default" ? undefined : modelID).catch(() => {});
      if (this.opened?.effort !== effort)
        await this.query.applyFlagSettings({ effortLevel: effort ?? null }).catch(() => {});
      if (this.opened?.plan !== input.plan)
        await this.query.setPermissionMode(input.plan ? "plan" : "default").catch(() => {});
      this.opened = { model: modelID, effort, plan: input.plan, append, program: this.agent.program, tools: tools?.key, skills };
    }
    if (hooks.signal.aborted)
      return { outcome: "interrupted" };
    return new Promise((resolve4) => {
      this.lastHooks = hooks;
      const message = userMessage(input);
      this.active = this.turnFor(turn, hooks, resolve4, input.auto, new Map([[message.uuid, ""]]));
      this.input.push(message);
    });
  }
  turnFor(turn, hooks, resolve4, auto, steered) {
    const active = { turn, hooks, resolve: resolve4, streamed: new Set, blockTools: new Map, calls: new Map, subagents: new Map, auto, steered };
    active.resolve = (result) => {
      if (result.outcome === "succeeded") {
        for (const [callID, lane] of active.subagents)
          if (lane.background && !lane.turn.isEnded)
            this.backgroundLanes.set(callID, lane);
      }
      resolve4(result);
    };
    return active;
  }
  adopt(input, turn, hooks) {
    const own = this.own;
    this.own = undefined;
    own?.take?.();
    if (!this.query || !own || own.turnedAway)
      return Promise.resolve({ outcome: "succeeded" });
    return new Promise((resolve4) => {
      this.lastHooks = hooks;
      this.active = this.turnFor(turn, hooks, resolve4, input.auto, new Map);
      let at = 0;
      for (;at < own.frames.length && this.active; at++)
        this.handle(own.frames[at]);
      for (const frame of own.frames.slice(at))
        this.handle(frame);
    });
  }
  ownFrame(message) {
    const known = this.own;
    if (known) {
      if (!known.turnedAway)
        known.frames.push(message);
      else if (message.type === "result")
        this.own = undefined;
      return;
    }
    const begins = !message.parent_tool_use_id && (message.type === "stream_event" || message.type === "assistant");
    if (!begins)
      return;
    let take;
    const taken = new Promise((resolve4) => take = resolve4);
    const own = { frames: [message], turnedAway: false, taken, take };
    this.own = own;
    if (!(this.onOwnTurn?.(this.ownNote()) ?? false))
      this.turnAway();
  }
  turnAway() {
    const own = this.own;
    if (!own || own.turnedAway)
      return;
    own.take?.();
    if (own.frames.some((frame) => frame.type === "result" && !frame.parent_tool_use_id)) {
      this.own = undefined;
      return;
    }
    own.turnedAway = true;
    this.query?.interrupt().catch(() => {});
  }
  ownNote() {
    const ended = this.lastEnded;
    this.lastEnded = undefined;
    if (ended?.type === "local_bash") {
      const exit = /exit code (\d+)/i.exec(ended.summary ?? "")?.[1];
      const metadata = { source: "shell", state: ended.status === "completed" ? "completed" : "error" };
      if (exit !== undefined)
        metadata.exit = Number(exit);
      if (ended.status === "stopped")
        metadata.signal = "SIGTERM";
      return { text: `A command left running in the background ${ended.status === "completed" ? "finished" : ended.status}.`, description: ended.command ?? ended.description, metadata };
    }
    if (ended)
      return { text: `A task it had going ${ended.status === "completed" ? "finished" : ended.status}.`, description: `${ended.status === "completed" ? "Finished" : "Ended"}: ${ended.description}` };
    return { text: "Claude Code carried on by itself." };
  }
  noteTask(message) {
    switch (message.subtype) {
      case "task_started": {
        const known = this.tasks.get(message.task_id);
        this.tasks.set(message.task_id, { ...known, type: message.task_type ?? known?.type ?? "", description: message.description ?? known?.description ?? "", toolUseID: message.tool_use_id ?? known?.toolUseID });
        if (message.is_backgrounded && !message.ambient)
          this.shellFor(message.task_id);
        return;
      }
      case "task_updated":
        if (message.patch?.is_backgrounded)
          this.shellFor(message.task_id);
        return;
      case "task_notification": {
        const task = this.tasks.get(message.task_id);
        if (task && typeof message.output_file === "string")
          task.outputFile = message.output_file;
        const command = task?.toolUseID ? this.commands.get(task.toolUseID) : undefined;
        this.lastEnded = { type: task?.type ?? "", description: task?.description ?? String(message.summary ?? ""), command, status: String(message.status ?? "completed"), summary: message.summary };
        if (task?.shell)
          endShell(task.shell, message.status === "completed" ? 0 : undefined);
        const callID = typeof message.tool_use_id === "string" ? message.tool_use_id : task?.toolUseID;
        const lane = callID ? this.keptLane(callID) ?? this.active?.subagents.get(callID) : undefined;
        if (callID && lane?.background) {
          const status = String(message.status ?? "completed");
          if (status === "completed")
            lane.run.end("succeeded");
          else if (status === "failed")
            lane.run.end("failed", { type: "agent", message: String(message.summary ?? "The subagent failed.") });
          else
            lane.run.end("interrupted");
          this.backgroundLanes.delete(callID);
          this.active?.subagents.delete(callID);
        }
        return;
      }
      case "background_tasks_changed": {
        const tasks = (Array.isArray(message.tasks) ? message.tasks : []).filter((task) => !task?.ambient);
        this.liveTasks = new Set(tasks.map((task) => String(task.task_id)));
        for (const task of tasks) {
          const known = this.tasks.get(task.task_id);
          this.tasks.set(task.task_id, { ...known, type: task.task_type ?? known?.type ?? "", description: task.description ?? known?.description ?? "" });
          this.shellFor(task.task_id);
        }
        for (const [id, task] of this.tasks)
          if (task.shell && !this.liveTasks.has(id))
            endShell(task.shell);
        return;
      }
    }
  }
  shellFor(taskID) {
    const task = this.tasks.get(taskID);
    if (!task || task.shell || task.type !== "local_bash")
      return;
    const command = (task.toolUseID ? this.commands.get(task.toolUseID) : undefined) ?? task.description;
    task.shell = addShell(this.session.id, this.session.location.directory, command, () => this.taskOutput(taskID), async () => {
      const shell2 = this.tasks.get(taskID)?.shell;
      const query = this.query;
      if (!query?.stopTask)
        return void (shell2 && endShell(shell2));
      await query.stopTask(taskID).catch(() => {
        if (shell2 && !this.liveTasks.has(taskID))
          endShell(shell2);
      });
    });
  }
  async taskOutput(taskID) {
    const task = this.tasks.get(taskID);
    try {
      if (this.query?.getTaskOutput) {
        const read = await this.query.getTaskOutput(taskID);
        const last2 = { output: String(read?.output ?? ""), total: Number(read?.total_bytes ?? 0) };
        if (task)
          task.last = last2;
        return last2;
      }
    } catch {}
    if (task?.outputFile) {
      try {
        const bytes = readFileSync11(task.outputFile);
        return { output: bytes.subarray(Math.max(0, bytes.length - 64000)).toString("utf8"), total: bytes.length };
      } catch {}
    }
    return task?.last ?? { output: "", total: 0 };
  }
  get keepsWorking() {
    return Boolean(this.query) && this.liveTasks.size > 0;
  }
  open(sdk, modelID, effort, plan, append, hooks, skills) {
    if (!this.agent.executable())
      throw new Error(`Install Claude Code first: ${this.agent.install}`);
    let id = this.state.claudeSession;
    const resume = Boolean(id && this.state.claudeStarted);
    if (!id) {
      id = randomUUID();
      this.state.claudeSession = id;
      hooks.saveState();
    }
    if (!resume)
      delete this.state.claudeCost;
    this.input = new Queue;
    const tools = kuvoTools(this.session.id);
    this.opened = { model: modelID, effort, plan, append, program: this.agent.program, tools: tools?.key, skills };
    this.query = sdk.query({
      prompt: this.input,
      options: {
        pathToClaudeCodeExecutable: this.agent.executable(),
        cwd: this.session.location.directory,
        model: modelID === "default" ? undefined : modelID,
        effort,
        includePartialMessages: true,
        forwardSubagentText: true,
        permissionMode: plan ? "plan" : "default",
        canUseTool: (name, input, options) => this.canUseTool(name, input, options),
        hooks: { PreToolUse: [{ hooks: [async (hookInput) => this.preToolUse(hookInput)] }] },
        systemPrompt: { type: "preset", preset: "claude_code", ...append ? { append } : {} },
        ...skills ? { plugins: [{ type: "local", path: skills, skipMcpDiscovery: true }] } : {},
        ...resume ? { resume: id } : { sessionId: id },
        env: { ...this.agent.env(), OPENCODE_SESSION_ID: this.session.id },
        stderr: () => {}
      }
    });
    this.read(this.query);
  }
  async read(query) {
    let ended;
    try {
      for await (const message of query)
        this.handle(message);
    } catch (error) {
      ended = error;
    }
    if (this.query === query) {
      this.query = undefined;
      this.input = undefined;
      this.leftRunning();
    }
    const active = this.active;
    if (!active || this.query)
      return;
    this.active = undefined;
    clearTimeout(active.goingOn);
    const missed = this.unseen(active);
    const resolve4 = active.resolve;
    active.resolve = (value) => resolve4(missed ? { ...value, missed } : value);
    if (active.stopping || active.hooks.signal.aborted)
      active.resolve({ outcome: "interrupted" });
    else if (active.limit)
      active.resolve({ outcome: "failed", error: { type: "limit", message: active.problem ?? "You've reached a Claude usage limit." }, limit: active.limit });
    else
      active.resolve({ outcome: "failed", error: failure(active.problem ?? ended ?? "Claude Code stopped.") });
  }
  handle(message) {
    if (message.type === "system" && message.subtype === "init") {
      if (!this.state.claudeStarted || this.state.claudeSession !== message.session_id) {
        this.state.claudeSession = message.session_id;
        this.state.claudeStarted = true;
        this.active?.hooks.saveState();
      }
      return;
    }
    if (message.type === "system")
      this.noteTask(message);
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      for (const block of message.message?.content ?? [])
        if (block?.type === "tool_use" && block.name === "Bash" && typeof block.input?.command === "string")
          this.commands.set(block.id, block.input.command);
      if (this.commands.size > 200)
        for (const key of [...this.commands.keys()].slice(0, 100))
          this.commands.delete(key);
    }
    const active = this.active;
    if (!active) {
      const background = message.parent_tool_use_id ? this.keptLane(message.parent_tool_use_id) : undefined;
      if (background)
        return this.laneFrame(undefined, background, message);
      return this.ownFrame(message);
    }
    if (!message.parent_tool_use_id && Array.isArray(message.user_message_uuids))
      for (const uuid of message.user_message_uuids)
        active.steered.delete(uuid);
    if (active.goingOn) {
      clearTimeout(active.goingOn);
      active.goingOn = active.steered.size ? setTimeout(() => this.wentQuiet(active), goingOnLimit) : undefined;
    }
    const lane = message.parent_tool_use_id ? this.subagentLane(active, message.parent_tool_use_id) : active;
    if (!lane)
      return;
    this.laneFrame(active, lane, message);
  }
  laneFrame(active, lane, message) {
    const turn = lane.turn;
    switch (message.type) {
      case "stream_event":
        return this.stream(lane, message.event);
      case "assistant": {
        const content = message.message?.content ?? [];
        const id = message.message?.id;
        const error = message.error ?? message.message?.error;
        if (error === "authentication_failed") {
          this.agent.authFailedAt = Date.now();
          if (active)
            active.problem = "Claude Code isn't signed in. Sign in again in Settings \u203A Accounts.";
        } else if (typeof error === "string" && active && lane === active)
          active.problem ??= apiErrorWords(error);
        for (const block of content) {
          if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
            const name = block.type === "mcp_tool_use" ? `mcp__${block.server_name ?? "mcp"}__${block.name}` : block.name;
            lane.calls.set(block.id, { name, input: block.input ?? {} });
            const tool = kuvoTool2(name, block.input ?? {});
            if (!turn.hasTool(block.id))
              turn.toolStart(block.id, tool.name);
            turn.toolCalled(block.id, tool.input);
            if (active && lane === active && tool.name === "subagent")
              this.subagentLane(active, block.id);
          } else if (typeof block.type === "string" && block.type.endsWith("_tool_result")) {
            this.serverResult(turn, block);
          } else if (!id || !lane.streamed.has(id)) {
            if (block.type === "text" && block.text)
              turn.text(block.text);
            else if (block.type === "thinking" && block.thinking)
              turn.reasoning(block.thinking);
            else if (block.type === "redacted_thinking")
              turn.reasoning("(The model kept this thinking to itself.)");
            else if (block.type === "compaction")
              this.noticeLater(lane, "Claude summarized the conversation to make room.");
          }
        }
        if (id && !lane.streamed.has(id))
          turn.endBlock();
        return;
      }
      case "user": {
        const content = Array.isArray(message.message?.content) ? message.message.content : [];
        const results = content.filter((block) => block.type === "tool_result");
        for (const block of results)
          this.result(active, lane, block, results.length === 1 ? message.tool_use_result : undefined);
        return;
      }
      case "rate_limit_event": {
        if (!active || lane !== active)
          return;
        const info = message.rate_limit_info ?? {};
        if (info.status === "allowed_warning") {
          const used = typeof info.utilization === "number" ? ` (${Math.round(info.utilization * 100)}% used)` : "";
          this.noticeOnce(`warn:${info.rateLimitType}:${info.surpassedThreshold ?? ""}`, turn, `You're close to ${limitWords2(info.rateLimitType).replace(/^You've reached /, "").replace(/\.$/, "")}${used}.`);
          return;
        }
        if (info.status !== "rejected" || info.overageInUse || info.isUsingOverage)
          return;
        const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : undefined;
        const oneModel = info.rateLimitType === "seven_day_opus" || info.rateLimitType === "seven_day_sonnet";
        active.limit = { scope: oneModel ? "model" : "provider", resetsAt, message: limitWords2(info.rateLimitType) };
        active.problem = limitWords2(info.rateLimitType);
        if (active.auto)
          this.query?.interrupt().catch(() => {});
        return;
      }
      case "system":
        if (active && lane === active && message.subtype === "api_retry" && (message.error === "rate_limit" || message.error === "billing_error") && active.auto) {
          active.limit ??= message.error === "billing_error" ? { scope: "provider" } : { scope: "model", brief: true };
          active.problem ??= "Claude's API is rate limiting this model.";
          this.query?.interrupt().catch(() => {});
          return;
        }
        return this.systemFrame(active, lane, message);
      case "conversation_reset":
        delete this.state.claudeCost;
        turn.notice("Claude Code started its conversation over.");
        return;
      case "auth_status":
        if (message.error && active)
          active.problem = String(message.error);
        else if (Array.isArray(message.output) && message.output.length)
          turn.notice(message.output.join(`
`));
        return;
      case "result":
        if (!active || lane !== active)
          return;
        return this.finish(active, message);
      default:
        if (!claudeMessages.has(message.type))
          this.unknownFrame(turn, String(message.type), message);
    }
  }
  systemFrame(active, lane, message) {
    const turn = lane.turn;
    switch (message.subtype) {
      case "task_progress":
        if (typeof message.tool_use_id === "string" && (message.summary || message.description))
          turn.toolProgress(message.tool_use_id, { summary: message.summary ?? message.description, lastTool: message.last_tool_name });
        return;
      case "compact_boundary":
        this.noticeLater(lane, "Claude Code summarized the conversation to make room.");
        return;
      case "status":
        if (message.compact_result === "failed")
          turn.notice(`Claude Code couldn't summarize the conversation${message.compact_error ? `: ${message.compact_error}` : ""}.`);
        return;
      case "api_retry":
        this.noticeOnce(`retry:${lane.turn.currentModel.id}`, turn, `Claude's API ${message.error === "overloaded" || message.error_status === 529 ? "is overloaded" : "had a problem"}: trying again${message.max_retries ? ` (${message.attempt}/${message.max_retries})` : ""}.`);
        return;
      case "local_command_output":
        if (typeof message.content === "string" && message.content.trim()) {
          turn.text(message.content);
          turn.endBlock();
        }
        return;
      case "informational":
        if (message.level !== "info" && typeof message.content === "string")
          turn.notice(message.content);
        return;
      case "notification":
        if (message.priority !== "low" && typeof message.text === "string")
          turn.notice(message.text);
        return;
      case "model_refusal_fallback":
      case "model_refusal_no_fallback":
        if (typeof message.content === "string")
          turn.notice(message.content);
        return;
      case "plugin_install":
        if (message.status === "failed")
          turn.notice(`A Claude Code plugin didn't install${message.name ? ` (${message.name})` : ""}${message.error ? `: ${message.error}` : ""}.`);
        return;
      case "hook_response":
        if (message.outcome === "error" || message.exit_code)
          turn.notice(`Your ${message.hook_name ?? message.hook_event ?? ""} hook failed${message.stderr ? `: ${String(message.stderr).trim()}` : ""}.`);
        return;
      case "memory_recall": {
        const id = newID("call");
        turn.toolStart(id, "memory", { description: "Recalled from memory" });
        const paths = Array.isArray(message.paths) ? message.paths.join(`
`) : "";
        turn.toolSucceeded(id, paths || (typeof message.content === "string" ? message.content : ""));
        return;
      }
    }
    if (!claudeSystem.has(message.subtype))
      this.unknownFrame(turn, `system:${message.subtype}`, message);
  }
  noticeLater(lane, text) {
    lane.turn.notice(text);
  }
  noticeOnce(key, turn, text) {
    if (this.noticed.has(key))
      return;
    this.noticed.add(key);
    turn.notice(text);
  }
  unknownFrame(turn, key, message) {
    const words = ["content", "text", "message", "summary"].map((field) => message?.[field]).find((value) => typeof value === "string" && value.trim());
    if (words)
      this.noticeOnce(`unknown:${key}:${words}`, turn, words);
    if (!this.noticed.has(`log:${key}`)) {
      this.noticed.add(`log:${key}`);
      console.error(`Claude Code sent ${key}, which Kuvo Code doesn't know: ${JSON.stringify(message).slice(0, 300)}`);
    }
  }
  serverResult(turn, block) {
    const id = block.tool_use_id;
    if (typeof id !== "string")
      return;
    if (!turn.hasTool(id))
      turn.toolStart(id, block.type.replace(/_tool_result$/, ""), {});
    const content = block.content;
    const failed = content && typeof content === "object" && !Array.isArray(content) && String(content.type ?? "").endsWith("_error") || block.is_error;
    const lines2 = [];
    for (const part of Array.isArray(content) ? content : [content]) {
      if (!part)
        continue;
      if (part.type === "web_search_result")
        lines2.push([part.title, part.url].filter(Boolean).join(" \u2014 "));
      else if (typeof part.text === "string")
        lines2.push(part.text);
      else if (typeof part.stdout === "string" || typeof part.stderr === "string")
        lines2.push([part.stdout, part.stderr].filter(Boolean).join(`
`));
      else if (part.type === "web_fetch_result")
        lines2.push(part.url ?? "");
      else if (typeof part.error_code === "string")
        lines2.push(part.error_code);
    }
    const text = lines2.filter(Boolean).join(`
`).slice(0, outputLimit3);
    if (failed)
      turn.toolFailed(id, text || "The tool failed.");
    else
      turn.toolSucceeded(id, text);
  }
  subagentLane(active, callID) {
    const known = active.subagents.get(callID);
    if (known)
      return known;
    const kept2 = this.keptLane(callID);
    if (kept2) {
      this.backgroundLanes.delete(callID);
      active.subagents.set(callID, kept2);
      return kept2;
    }
    const call = active.calls.get(callID) ?? [...active.subagents.values()].map((lane2) => lane2.calls.get(callID)).find(Boolean);
    const before = this.subagentSessions.get(callID);
    let run2;
    let background = false;
    if (call) {
      const input = call.input;
      if (kuvoTool2(call.name, input).name !== "subagent")
        return;
      background = input.run_in_background === true;
      run2 = active.hooks.subagent(callID, { title: String(input.description ?? ""), prompt: typeof input.prompt === "string" ? input.prompt : undefined, agent: input.subagent_type, background });
      run2.stop = () => this.stopSubagent(callID);
      this.subagentSessions.set(callID, { sessionID: run2.sessionID, title: String(input.description ?? "") });
    } else if (before) {
      run2 = active.hooks.subagent(callID, { title: before.title, sessionID: before.sessionID, background: true });
      run2.stop = () => this.stopSubagent(callID);
      background = true;
    } else {
      return;
    }
    const lane = { turn: run2.turn, streamed: new Set, blockTools: new Map, calls: new Map, run: run2, background };
    active.subagents.set(callID, lane);
    return lane;
  }
  stream(lane, event) {
    const turn = lane.turn;
    switch (event?.type) {
      case "message_start": {
        lane.streamed.add(event.message?.id);
        lane.blockTools.clear();
        const usage = event.message?.usage ?? {};
        lane.usage = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          reasoning: 0,
          cache: { read: usage.cache_read_input_tokens ?? 0, write: usage.cache_creation_input_tokens ?? 0 }
        };
        lane.stopReason = undefined;
        turn.startStep();
        return;
      }
      case "content_block_start": {
        const block = event.content_block;
        if (block?.type === "tool_use" || block?.type === "server_tool_use" || block?.type === "mcp_tool_use") {
          lane.blockTools.set(event.index, block.id);
          turn.toolStart(block.id, kuvoTool2(block.type === "mcp_tool_use" ? `mcp__${block.server_name ?? "mcp"}__${block.name}` : block.name, {}).name);
        } else if (block?.type === "redacted_thinking")
          turn.reasoning("(The model kept this thinking to itself.)");
        else if (typeof block?.type === "string" && block.type.endsWith("_tool_result"))
          this.serverResult(turn, block);
        return;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta")
          turn.text(delta.text);
        else if (delta?.type === "thinking_delta")
          turn.reasoning(delta.thinking);
        else if (delta?.type === "input_json_delta") {
          const id = lane.blockTools.get(event.index);
          if (id)
            turn.toolInputDelta(id, delta.partial_json ?? "");
        }
        return;
      }
      case "content_block_stop":
        turn.endBlock();
        return;
      case "message_delta":
        if (lane.usage && event.usage?.output_tokens !== undefined)
          lane.usage.output = event.usage.output_tokens;
        lane.stopReason = event.delta?.stop_reason ?? lane.stopReason;
        return;
      case "message_stop":
        turn.endStep({ tokens: lane.usage, finish: lane.stopReason === "tool_use" ? "tool-calls" : lane.stopReason ?? "stop" });
        return;
    }
  }
  result(active, lane, block, structured) {
    const turn = lane.turn;
    const id = block.tool_use_id;
    const call = lane.calls.get(id);
    let text = toolText(block.content);
    if (text.length > outputLimit3)
      text = text.slice(0, outputLimit3) + `
\u2026`;
    const pictures = toolPictures(block.content, call?.input);
    const subagent = active && lane === active ? active.subagents.get(id) : undefined;
    if (active && subagent && !subagent.background) {
      subagent.run.end(block.is_error ? "failed" : "succeeded", block.is_error ? { type: "agent", message: text || "The subagent failed." } : undefined);
      active.subagents.delete(id);
    }
    if (block.is_error) {
      turn.toolFailed(id, text || "The tool failed.");
      return;
    }
    const metadata = {};
    const files = call ? diffs(call.name, call.input, structured) : [];
    if (files.length)
      metadata.files = files;
    if (call?.name === "Bash" && structured) {
      if (structured.isImage && typeof structured.stdout === "string")
        pictures.push(pictureUrl(structured.stdout.trim()));
      else {
        const output = [structured.stdout, structured.stderr].filter((part) => part).join(`
`);
        if (output)
          text = output.length > outputLimit3 ? output.slice(0, outputLimit3) + `
\u2026` : output;
      }
      const notes = [structured.interrupted ? "It was stopped." : "", structured.returnCodeInterpretation ?? "", structured.persistedOutputPath ? `The rest of what it printed is in ${structured.persistedOutputPath}.` : ""].filter(Boolean);
      if (notes.length)
        text = [text, ...notes].filter(Boolean).join(`
`);
    }
    turn.toolSucceeded(id, withPictures(text, pictures), Object.keys(metadata).length ? metadata : undefined);
  }
  finish(active, result) {
    this.addCost(active, result);
    const says = Array.isArray(result.user_message_uuids);
    for (const uuid of says ? result.user_message_uuids : [])
      active.steered.delete(uuid);
    const succeeded = result.subtype === "success" && !result.is_error;
    const goesOn = !active.stopping && !active.hooks.signal.aborted;
    if (succeeded && goesOn && says && active.steered.size) {
      clearTimeout(active.goingOn);
      active.goingOn = setTimeout(() => this.wentQuiet(active), goingOnLimit);
      return;
    }
    clearTimeout(active.goingOn);
    this.active = undefined;
    const missed = says ? this.unseen(active) : undefined;
    const resolve4 = active.resolve;
    active.resolve = (value) => resolve4(missed ? { ...value, missed } : value);
    if (succeeded && goesOn) {
      active.resolve({ outcome: "succeeded" });
      return;
    }
    const text = !succeeded && typeof result.result === "string" ? result.result : "";
    const reached = /usage limit reached\|?(\d+)?/i.exec(text);
    if (!succeeded && !active.limit && (reached || result.api_error_status === 429)) {
      const resetsAt = reached?.[1] ? Number(reached[1]) * 1000 : undefined;
      active.limit = { scope: "provider", resetsAt };
      active.problem ??= "You've reached your Claude usage limit for now.";
    }
    if (active.limit && !active.stopping) {
      active.resolve({ outcome: "failed", error: { type: "limit", message: active.problem ?? "You've reached a Claude usage limit." }, limit: active.limit, taken: true });
      return;
    }
    if (active.stopping || active.hooks.signal.aborted) {
      active.resolve({ outcome: "interrupted" });
      return;
    }
    const message = active.problem ?? (typeof result.result === "string" && result.result.trim() ? result.result.trim() : undefined) ?? (Array.isArray(result.errors) && result.errors.length ? result.errors.join(`
`) : undefined) ?? reason(result);
    active.resolve({ outcome: "failed", error: { type: "agent", message }, taken: true });
  }
  addCost(active, result) {
    const total = typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined;
    if (total === undefined)
      return;
    const before = typeof this.state.claudeCost === "number" ? this.state.claudeCost : 0;
    const spent = total >= before ? total - before : total;
    this.state.claudeCost = total;
    active.hooks.saveState();
    if (spent > 0 && this.agent.usesKey())
      active.turn.addUsage(undefined, spent);
  }
  async preToolUse(input) {
    if (input?.hook_event_name !== "PreToolUse")
      return {};
    if (input.tool_name === "Bash" && typeof input.tool_use_id === "string" && typeof input.tool_input?.command === "string")
      this.commands.set(input.tool_use_id, input.tool_input.command);
    await this.ownTaken();
    const hooks = this.active?.hooks ?? this.lastHooks;
    if (!hooks)
      return {};
    const ask = permissionAsk(String(input.tool_name ?? ""), input.tool_input ?? {});
    let verdict = hooks.check(ask, true);
    if (verdict === "ask" && ask.action === "edit" && this.opened?.plan)
      verdict = undefined;
    if (verdict === "ask" && !this.active && !this.backgroundLane(input.agent_id))
      verdict = "deny";
    if (verdict === "deny") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Kuvo Code's settings don't allow this (Settings \u203A Permissions, or this session's rules)." } };
    }
    if (verdict === "ask")
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
    return {};
  }
  async ownTaken() {
    while (!this.active && this.own && !this.own.turnedAway)
      await this.own.taken;
  }
  async canUseTool(name, input, options) {
    await this.ownTaken();
    const active = this.active;
    const toolUseID = options?.toolUseID;
    const background = this.backgroundLane(options?.agentID);
    if (!active && !background)
      return { behavior: "deny", message: "There's no turn under way for this.", toolUseID };
    if (!active) {
      if (name === "AskUserQuestion" || name === "ExitPlanMode")
        return { behavior: "deny", message: "Ask in the conversation that started you.", toolUseID };
      return this.decide(name, input, options, (ask) => background.run.permission(ask));
    }
    const hooks = active.hooks;
    if (name === "AskUserQuestion") {
      const questions = input.questions ?? [];
      const fields = questions.map((question, index) => ({
        key: `q${index}`,
        title: question.header ?? `Question ${index + 1}`,
        description: question.question,
        required: true,
        type: question.multiSelect ? "multiselect" : "string",
        options: (question.options ?? []).map((option) => ({ value: option.label, label: option.label, description: option.description })),
        custom: true
      }));
      const answer = await hooks.question({ title: questions.length === 1 ? questions[0].header ?? "Question" : "Questions", fields, toolCallID: toolUseID });
      if (!answer)
        return { behavior: "deny", message: "The user dismissed the question.", toolUseID };
      const answers = {};
      questions.forEach((question, index) => {
        const value = answer[`q${index}`];
        answers[question.question] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
      });
      return { behavior: "allow", updatedInput: { ...input, answers }, toolUseID };
    }
    if (name === "ExitPlanMode" && this.opened?.plan) {
      return {
        behavior: "deny",
        message: "The plan is shown to the user. Stop here and wait: they'll switch out of plan mode and ask you to build it when they're ready.",
        toolUseID
      };
    }
    if (name === "ExitPlanMode")
      return { behavior: "allow", updatedInput: input, toolUseID };
    return this.decide(name, input, options, background ? (ask) => background.run.permission(ask) : hooks.permission);
  }
  async stopSubagent(callID) {
    for (const [taskID, task] of this.tasks)
      if (task.toolUseID === callID)
        await this.query?.stopTask?.(taskID).catch(() => {});
  }
  keptLane(callID) {
    const lane = this.backgroundLanes.get(callID);
    if (!lane?.run.turn.isEnded)
      return lane;
    this.backgroundLanes.delete(callID);
    return;
  }
  backgroundLane(agentID) {
    const callID = typeof agentID === "string" ? this.tasks.get(agentID)?.toolUseID : undefined;
    const lane = callID ? this.keptLane(callID) ?? this.active?.subagents.get(callID) : undefined;
    return lane?.background ? lane : undefined;
  }
  async decide(name, input, options, permission) {
    const toolUseID = options?.toolUseID;
    const ask = permissionAsk(name, input);
    const decision = await permission({ toolCallID: toolUseID, ...ask, message: options?.title ?? options?.description });
    if (decision === "reject")
      return { behavior: "deny", message: "The user declined this.", toolUseID };
    const result = { behavior: "allow", updatedInput: input, toolUseID };
    if (decision === "always" && Array.isArray(options?.suggestions)) {
      result.updatedPermissions = options.suggestions.map((suggestion) => ({ ...suggestion, destination: "session" }));
    }
    return result;
  }
  async steer(input) {
    const active = this.active;
    if (!active || !this.input || active.stopping)
      return false;
    const message = { ...userMessage(input), priority: "next" };
    active.steered.set(message.uuid, input.id);
    this.input.push(message);
    return true;
  }
  wentQuiet(active) {
    if (this.active !== active)
      return;
    clearTimeout(active.goingOn);
    this.active = undefined;
    active.resolve({ outcome: "succeeded", missed: this.unseen(active) });
  }
  unseen(active) {
    if (!active.steered.size)
      return;
    const yours = [...active.steered.values()].filter(Boolean);
    this.close();
    return yours.length ? yours : undefined;
  }
  async interrupt() {
    const query = this.query;
    const active = this.active;
    if (!query || !active)
      return;
    active.stopping = true;
    await query.interrupt().catch(() => {});
    for (let waited = 0;waited < 5000 && this.active === active; waited += 100)
      await Bun.sleep(100);
    if (this.active === active && this.query === query) {
      this.active = undefined;
      clearTimeout(active.goingOn);
      const missed = this.unseen(active);
      this.close();
      active.resolve({ outcome: "interrupted", missed });
    }
  }
  close() {
    this.input?.close();
    try {
      this.query?.close?.();
    } catch {}
    this.query = undefined;
    this.input = undefined;
    this.leftRunning();
  }
  leftRunning() {
    for (const task of this.tasks.values())
      if (task.shell)
        endShell(task.shell);
    for (const lane of this.backgroundLanes.values())
      lane.run.end("interrupted");
    this.backgroundLanes.clear();
    this.liveTasks.clear();
    this.own?.take?.();
    this.own = undefined;
  }
}
var claudeMessages = new Set(["assistant", "user", "stream_event", "result", "system", "rate_limit_event", "auth_status", "conversation_reset", "tool_progress", "tool_use_summary", "prompt_suggestion"]);
var claudeSystem = new Set([
  "init",
  "compact_boundary",
  "status",
  "api_retry",
  "control_request_progress",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "local_command_output",
  "hook_started",
  "hook_progress",
  "hook_response",
  "plugin_install",
  "task_notification",
  "task_started",
  "task_updated",
  "task_progress",
  "background_tasks_changed",
  "thinking_tokens",
  "session_state_changed",
  "worker_shutting_down",
  "commands_changed",
  "notification",
  "files_persisted",
  "memory_recall",
  "elicitation_complete",
  "permission_denied",
  "mirror_error",
  "informational",
  "task_summary",
  "post_turn_summary"
]);
function kuvoTool2(name, input) {
  switch (name) {
    case "Bash":
      return { name: "shell", input: { command: input.command, description: input.description } };
    case "Read":
      return { name: "read", input: { path: input.file_path, offset: input.offset, limit: input.limit } };
    case "Write":
      return { name: "write", input: { path: input.file_path, content: input.content } };
    case "Edit":
      return { name: "edit", input: { path: input.file_path, oldString: input.old_string, newString: input.new_string, replaceAll: input.replace_all } };
    case "MultiEdit":
      return { name: "edit", input: { path: input.file_path, edits: input.edits } };
    case "NotebookEdit":
      return { name: "edit", input: { path: input.notebook_path, newString: input.new_source } };
    case "Glob":
      return { name: "glob", input: { pattern: input.pattern, path: input.path } };
    case "Grep":
      return { name: "grep", input: { pattern: input.pattern, path: input.path, glob: input.glob } };
    case "WebFetch":
      return { name: "webfetch", input: { url: input.url, prompt: input.prompt } };
    case "WebSearch":
    case "web_search":
      return { name: "websearch", input: { query: input.query } };
    case "web_fetch":
      return { name: "webfetch", input: { url: input.url } };
    case "code_execution":
    case "bash_code_execution":
      return { name: "shell", input: { command: input.command ?? input.code, description: "Ran on Anthropic's servers" } };
    case "Task":
    case "Agent":
      return { name: "subagent", input: { description: input.description, agent: input.subagent_type, prompt: input.prompt } };
    case "TodoWrite":
      return { name: "todowrite", input: { todos: input.todos } };
    case "AskUserQuestion":
      return { name: "question", input: { questions: input.questions } };
    case "Skill":
      return { name: "skill", input: { name: input.skill ?? input.command } };
    case "ExitPlanMode":
      return { name: "plan", input: { plan: input.plan } };
  }
  if (name.startsWith("mcp__")) {
    const [, server2, ...rest] = name.split("__");
    return { name: `${server2}_${rest.join("__")}`, input };
  }
  return { name: name.toLowerCase(), input };
}
function permissionAsk(name, input) {
  switch (name) {
    case "Bash":
      return { action: "shell", resources: [String(input.command ?? "")] };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = String(input.file_path ?? input.notebook_path ?? "");
      const preview = previewDiff(name, input);
      return { action: "edit", resources: [path], metadata: preview ? { files: [preview] } : undefined };
    }
    case "WebFetch":
      return { action: "webfetch", resources: [String(input.url ?? "")] };
    case "WebSearch":
      return { action: "websearch", resources: [String(input.query ?? "")] };
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
      return { action: "read", resources: [String(input.file_path ?? input.path ?? "*")] };
  }
  return { action: kuvoTool2(name, input).name, resources: ["*"] };
}
function previewDiff(name, input) {
  const path = String(input.file_path ?? "");
  if (!path)
    return;
  const before = existsSync8(path) ? safeRead(path) : undefined;
  if (name === "Write")
    return fileDiff(path, before, String(input.content ?? ""));
  if (before === undefined)
    return;
  let after = before;
  const edits2 = name === "MultiEdit" ? input.edits ?? [] : [input];
  for (const edit of edits2) {
    if (typeof edit.old_string !== "string")
      return;
    after = edit.replace_all ? after.split(edit.old_string).join(edit.new_string ?? "") : after.replace(edit.old_string, () => edit.new_string ?? "");
  }
  return fileDiff(path, before, after);
}
function diffs(name, input, structured) {
  if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(name))
    return [];
  const path = String(structured?.filePath ?? input.file_path ?? input.notebook_path ?? "");
  if (!path)
    return [];
  if (name === "Write" && structured?.type === "create")
    return [fileDiff(path, undefined, String(structured.content ?? input.content ?? ""))];
  const hunks = structured?.structuredPatch;
  if (Array.isArray(hunks) && hunks.length) {
    const patch = hunks.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@
` + hunk.lines.join(`
`) + `
`).join("");
    return [fromPatch(path, patch)];
  }
  if (typeof structured?.originalFile === "string" && existsSync8(path))
    return [fileDiff(path, structured.originalFile, safeRead(path) ?? "")];
  if (name === "NotebookEdit" && (typeof structured?.old_source === "string" || typeof structured?.new_source === "string"))
    return [fileDiff(path, structured.old_source ?? "", structured.new_source ?? "")];
  return [];
}
function safeRead(path) {
  try {
    return readFileSync11(path, "utf8");
  } catch {
    return;
  }
}
function toolText(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      switch (part?.type) {
        case "text":
          return part.text;
        case "tool_reference":
          return `Loaded ${part.tool_name ?? "a tool"}`;
        case "search_result":
          return [part.title, part.source].filter(Boolean).join(" \u2014 ");
        case "image":
        case "document":
          return "";
      }
      return typeof part?.text === "string" ? part.text : "";
    }).filter(Boolean).join(`
`);
  }
  return "";
}
function toolPictures(content, input) {
  const pictures = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === "image")
      pictures.push(part.source?.type === "base64" ? pictureData(part.source.data, part.source.media_type) : pictureUrl(part.source?.url));
    if (part?.type === "document" && typeof input?.file_path === "string")
      pictures.push({ type: "file", uri: pathToFileURL3(input.file_path).href, mime: "application/pdf", name: input.file_path.split("/").pop() });
  }
  return pictures;
}
function pictureUrl(url) {
  if (typeof url !== "string")
    return;
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data)
    return pictureData(data[2], data[1]);
  return url.startsWith("file://") ? pictureFile(decodeURIComponent(new URL(url).pathname)) : undefined;
}
function apiErrorWords(error) {
  switch (error) {
    case "billing_error":
      return "Claude's API says there's a billing problem with this account.";
    case "rate_limit":
      return "Claude's API is rate limiting this model.";
    case "invalid_request":
      return "Claude's API turned the request away.";
    case "server_error":
      return "Claude's API had a problem.";
    case "max_output_tokens":
      return "The reply ran out of room.";
  }
  return `Claude's API reported an error (${error}).`;
}
function limitWords2(type) {
  switch (type) {
    case "five_hour":
      return "You've reached your Claude usage limit for the next few hours.";
    case "seven_day_opus":
      return "You've reached this week's Opus limit on your Claude plan.";
    case "seven_day_sonnet":
      return "You've reached this week's Sonnet limit on your Claude plan.";
    default:
      return "You've reached your Claude usage limit for now.";
  }
}
function reason(result) {
  switch (result.subtype) {
    case "error_max_turns":
      return "Claude Code stopped after too many steps.";
    case "error_max_budget_usd":
      return "Claude Code reached its spending limit.";
    default:
      return "Claude Code stopped with an error.";
  }
}
function userMessage(input) {
  const content = [];
  const others = [];
  for (const file of input.files) {
    const isImage = /^image\/(png|jpeg|gif|webp)$/.test(file.mime);
    const data = file.data ?? (isImage && file.path ? safeBase642(file.path) : undefined);
    if (isImage && data)
      content.push({ type: "image", source: { type: "base64", media_type: file.mime, data } });
    else if (file.path)
      others.push(file.path);
  }
  let text = input.text;
  if (others.length)
    text += `

Attached files:
${others.map((path) => `- ${path}`).join(`
`)}`;
  content.push({ type: "text", text });
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: randomUUID() };
}
function safeBase642(path) {
  try {
    return readFileSync11(path).toString("base64");
  } catch {
    return;
  }
}

// Agents/src/agents/codex.ts
import { existsSync as existsSync9, lstatSync as lstatSync2, mkdirSync as mkdirSync10, readdirSync as readdirSync5, readFileSync as readFileSync12, readlinkSync, rmSync as rmSync8, symlinkSync as symlinkSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join13 } from "path";
var places2 = ["/opt/homebrew/bin", "/usr/local/bin", join13(homedir2(), ".local/bin"), join13(homedir2(), ".codex/bin")];
var outputLimit4 = 30000;

class CodexAgent {
  context;
  instance;
  id = "codex";
  providerID;
  get name() {
    return accountName("Codex", this.instance);
  }
  install = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
  server;
  get running() {
    return this.server && !this.server.isClosed ? this.server : undefined;
  }
  starting;
  threads = new Map;
  oneOffs = new Map;
  logins = new Map;
  accountCache;
  modelList;
  skillRoots = new Map;
  rootsSet;
  rateLimits = new Map;
  constructor(context, instance = { id: "default" }) {
    this.context = context;
    this.instance = instance;
    this.providerID = providerID("codex", instance.id);
  }
  executable() {
    return which("codex", places2);
  }
  get definition() {
    const executable = this.executable();
    if (!executable)
      return;
    return { name: "Codex", executable, npmPackage: "@openai/codex", nativeUpdate: { args: ["update"], isNative: (path) => path.includes("/.codex/") } };
  }
  async maintenance(fresh = false) {
    const definition = this.definition;
    return definition ? maintenance(definition, fresh) : {};
  }
  async update() {
    const definition = this.definition;
    if (!definition)
      return { updated: false, message: "Codex isn't installed." };
    return update(definition, this.context.temporary);
  }
  async installProgram() {
    return install("Codex", this.install, this.context.temporary, () => this.executable());
  }
  outdated;
  programUpdated() {
    this.modelList = undefined;
    this.accountCache = undefined;
    this.outdated = this.server;
    this.starting?.then((rpc) => {
      this.outdated ??= rpc;
      this.restartIfQuiet();
    }, () => {});
    this.restartIfQuiet();
  }
  restartIfQuiet(starting) {
    const server2 = this.outdated;
    if (!server2)
      return;
    if (server2.isClosed || this.server !== server2) {
      this.outdated = undefined;
      return;
    }
    if (this.logins.size || this.oneOffs.size || [...this.threads.values()].some((thread) => thread !== starting && (thread.isRunning || thread.keepsWorking)))
      return;
    this.outdated = undefined;
    this.shutdown();
    this.modelList = undefined;
    emit("model.updated", {});
  }
  methods() {
    return [
      { type: "oauth", id: "chatgpt", label: "Sign in with ChatGPT" },
      { type: "key", label: "Use an OpenAI API key" }
    ];
  }
  lastUse = 0;
  idleCheck;
  async rpc(starting) {
    this.lastUse = Date.now();
    this.idleCheck ??= setInterval(() => {
      this.restartIfQuiet();
      if (!this.server || this.threads.size || this.logins.size || this.oneOffs.size || Date.now() - this.lastUse < 15 * 60000)
        return;
      this.shutdown();
    }, 60000);
    this.restartIfQuiet(starting);
    if (this.server && !this.server.isClosed)
      return this.server;
    this.starting ??= this.start().finally(() => this.starting = undefined);
    return this.starting;
  }
  async start() {
    const executable = this.executable();
    if (!executable)
      throw new Error(`Install Codex first: ${this.install}`);
    if (this.instance.home && !onMachine)
      shadowHome(this.instance.home);
    const rpc = new RPC([executable, "app-server"], { cwd: this.context.temporary, env: this.instance.home ? { CODEX_HOME: this.instance.home } : undefined });
    rpc.onNotification = (method, params) => this.notification(method, params);
    rpc.onRequest = (method, params, id) => this.request(method, params, id);
    rpc.onExit = () => {
      for (const oneOff of this.oneOffs.values())
        if (oneOff.rpc === rpc)
          oneOff.fail(new Error("Codex stopped."));
      if (this.server !== rpc)
        return;
      this.server = undefined;
      for (const thread of this.threads.values())
        thread.serverStopped();
    };
    await rpc.request("initialize", { clientInfo: { name: "kuvo-code", title: "Kuvo Code", version: "1" }, capabilities: { experimentalApi: true, optOutNotificationMethods: ["turn/diff/updated"] } }, 30000);
    rpc.notify("initialized");
    this.server = rpc;
    return rpc;
  }
  notification(method, params) {
    if (method === "account/login/completed") {
      const done = this.logins.get(params?.loginId);
      if (done) {
        this.logins.delete(params.loginId);
        done(params.success ? { status: "complete" } : { status: "failed", message: params.error ?? "Signing in didn't work." });
      }
      this.accountCache = undefined;
      return;
    }
    if (method === "account/updated") {
      this.accountCache = undefined;
      return;
    }
    if (method === "account/rateLimits/updated") {
      const snapshot = params?.rateLimits;
      if (snapshot)
        this.rateLimits.set(snapshot.limitId ?? "codex", snapshot);
      return;
    }
    if (method === "thread/started") {
      const thread2 = params?.thread;
      const parent = thread2?.source?.subAgent?.thread_spawn?.parent_thread_id;
      const owner = parent ? this.threadFor(parent) : undefined;
      if (owner && thread2?.id) {
        this.spawned.set(thread2.id, owner);
        owner.spawnStarted(thread2.id);
      }
      return;
    }
    if (method === "serverRequest/resolved") {
      this.asked.get(String(params?.requestId))?.abort();
      return;
    }
    const threadID = params?.threadId;
    if (!threadID && ["warning", "deprecationNotice", "configWarning", "mcpServer/startupStatus/updated"].includes(method)) {
      for (const thread2 of new Set(this.threads.values()))
        thread2.notification(method, params);
      return;
    }
    const oneOff = threadID ? this.oneOffs.get(threadID) : undefined;
    if (oneOff)
      return oneOff.notify(method, params);
    if (!threadID)
      return;
    const thread = this.threadFor(threadID);
    if (thread)
      return thread.notification(method, params);
    const now = Date.now();
    for (const [id, kept3] of this.early)
      if (now - kept3.at > 30000)
        this.early.delete(id);
    const kept2 = this.early.get(threadID) ?? { at: now, events: [] };
    if (kept2.events.length < 500)
      kept2.events.push([method, params]);
    this.early.set(threadID, kept2);
  }
  asked = new Map;
  async request(method, params, id) {
    const thread = params?.threadId ? this.threadFor(params.threadId) : params?.conversationId ? this.threadFor(params.conversationId) : undefined;
    if (method === "item/tool/call")
      return { success: false, contentItems: [{ type: "inputText", text: "Kuvo Code has no such tool." }] };
    if (!thread) {
      if (method === "mcpServer/elicitation/request")
        return { action: "decline" };
      throw new RPCError(-32601, `No session for ${method}.`);
    }
    const controller = new AbortController;
    const key = String(id ?? newID("call"));
    this.asked.set(key, controller);
    try {
      return await thread.request(method, params, controller.signal);
    } finally {
      this.asked.delete(key);
    }
  }
  threadFor(nativeID) {
    for (const thread of this.threads.values())
      if (thread.nativeID === nativeID)
        return thread;
    return this.spawned.get(nativeID);
  }
  windows = new ContextWindows;
  noteContext(model2, window) {
    if (!this.windows.note(model2, window))
      return;
    this.modelList = undefined;
    emit("model.updated", {});
  }
  spawned = new Map;
  adopt(threadID, thread) {
    this.spawned.set(threadID, thread);
    const early = this.early.get(threadID);
    this.early.delete(threadID);
    for (const [method, params] of early?.events ?? [])
      thread.notification(method, params);
  }
  early = new Map;
  async account(fresh = false) {
    if (!this.executable())
      return { installed: false, signedIn: false, message: "Install Codex, then sign in here." };
    if (!fresh && this.accountCache && Date.now() - this.accountCache.at < 30000)
      return this.accountCache.account;
    const rpc = await this.rpc();
    const result = await rpc.request("account/read", {}, 20000);
    const info = result?.account;
    let account;
    if (!info) {
      account = { installed: true, signedIn: false, message: "Sign in to Codex with ChatGPT or an OpenAI API key." };
    } else if (info.type === "chatgpt") {
      const plan = info.planType ? `ChatGPT ${String(info.planType).charAt(0).toUpperCase()}${String(info.planType).slice(1)}` : "ChatGPT";
      account = { installed: true, signedIn: true, label: [info.email, plan].filter(Boolean).join(" \xB7 ") };
    } else {
      account = { installed: true, signedIn: true, label: info.type === "apiKey" ? "OpenAI API key" : String(info.type) };
    }
    this.accountCache = { at: Date.now(), account };
    return account;
  }
  signsInRemotely = true;
  async signIn(_methodID = "chatgpt", options = {}) {
    const rpc = await this.rpc();
    if (options.remote) {
      const device = await rpc.request("account/login/start", { type: "chatgptDeviceCode" }, 30000);
      let status2 = { status: "pending" };
      this.logins.set(device.loginId, (done) => status2 = done);
      return {
        url: device.verificationUrl,
        userCode: device.userCode,
        instructions: `Open ChatGPT's page, sign in, and enter the code ${device.userCode}. Codex keeps the sign-in, as when you run codex login.`,
        mode: "auto",
        status: () => status2,
        cancel: () => {
          this.logins.delete(device.loginId);
          rpc.request("account/login/cancel", { loginId: device.loginId }).catch(() => {});
        }
      };
    }
    const result = await rpc.request("account/login/start", { type: "chatgpt" }, 30000);
    let status = { status: "pending" };
    this.logins.set(result.loginId, (done) => status = done);
    return {
      url: result.authUrl,
      instructions: "Finish signing in with ChatGPT in your browser. Codex keeps the sign-in, as when you run codex login.",
      mode: "auto",
      status: () => status,
      cancel: () => {
        this.logins.delete(result.loginId);
        rpc.request("account/login/cancel", { loginId: result.loginId }).catch(() => {});
      }
    };
  }
  async signInWithKey(key) {
    const rpc = await this.rpc();
    await rpc.request("account/login/start", { type: "apiKey", apiKey: key }, 30000);
    this.accountCache = undefined;
  }
  async models() {
    if (this.modelList && Date.now() - this.modelList.at < 30 * 60000)
      return this.modelList.models;
    const rpc = await this.rpc();
    const models = [];
    let cursor;
    let order = 1000;
    do {
      const page = await rpc.request("model/list", cursor ? { cursor } : {}, 30000);
      for (const info of page?.data ?? []) {
        if (info.hidden)
          continue;
        models.push(model(this.providerID, info.model ?? info.id, info.displayName ?? info.model, {
          variants: (info.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort),
          images: (info.inputModalities ?? []).includes("image"),
          context: this.windows.get(info.model ?? info.id) ?? 400000,
          released: info.isDefault ? 2000 : order--
        }));
      }
      cursor = page?.nextCursor ?? undefined;
    } while (cursor);
    if (rpc !== this.outdated)
      this.modelList = { at: Date.now(), models };
    return models;
  }
  forgetModels() {
    this.modelList = undefined;
  }
  shutdown() {
    const server2 = this.server;
    if (!server2)
      return;
    this.server = undefined;
    server2.kill();
    for (const thread of this.threads.values())
      thread.serverStopped();
  }
  async generate(prompt, model2) {
    const rpc = await this.rpc();
    const started = await rpc.request("thread/start", { ephemeral: true, cwd: this.context.temporary, ...model2 && model2.id !== "default" ? { model: model2.id } : {}, approvalPolicy: "never", sandbox: "read-only" }, 60000);
    const threadId = started.thread.id;
    let text = "";
    let turnId;
    let timer;
    const done = new Promise((resolve4, reject) => {
      timer = setTimeout(() => {
        if (turnId)
          rpc.request("turn/interrupt", { threadId, turnId }, 1e4).catch(() => {});
        reject(new Error("Codex took too long to answer."));
      }, 120000);
      this.oneOffs.set(threadId, {
        rpc,
        notify: (method, params) => {
          if (method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string")
            text = params.item.text;
          if (method !== "turn/completed")
            return;
          if (params?.turn?.status === "completed")
            resolve4(text.trim());
          else
            reject(new Error(params?.turn?.error?.message ?? "Codex couldn't answer."));
        },
        fail: reject
      });
    });
    done.catch(() => {});
    try {
      const turn = await rpc.request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], effort: model2?.variant ?? "low" }, 60000);
      turnId = turn?.turn?.id;
      return await done;
    } finally {
      clearTimeout(timer);
      this.oneOffs.delete(threadId);
      rpc.request("thread/unsubscribe", { threadId }).catch(() => {});
    }
  }
  thread(session, state) {
    const thread = new CodexThread(this, session, state);
    this.threads.set(session.id, thread);
    return thread;
  }
  ownSkillFolders(directory) {
    return [join13(this.home, "skills"), join13(homedir2(), ".agents", "skills"), ...upward(directory).map((folder) => join13(folder, ".agents", "skills"))];
  }
  get home() {
    return this.instance.home ?? process.env.CODEX_HOME ?? join13(homedir2(), ".codex");
  }
  async useSkills(sessionID, folder, rpc) {
    if (folder)
      this.skillRoots.set(sessionID, join13(folder, "skills"));
    else
      this.skillRoots.delete(sessionID);
    const roots = [...new Set(this.skillRoots.values())].sort();
    const key = JSON.stringify(roots);
    if (this.rootsSet?.rpc === rpc && this.rootsSet.key === key)
      return;
    await rpc.request("skills/extraRoots/set", { extraRoots: roots }, 30000).then(() => this.rootsSet = { rpc, key }, () => {});
  }
  ownSkillSettings() {
    try {
      const settings = Bun.TOML.parse(readFileSync12(join13(this.home, "config.toml"), "utf8"));
      return Array.isArray(settings?.skills?.config) ? settings.skills.config : [];
    } catch {
      return [];
    }
  }
  forget(sessionID) {
    const thread = this.threads.get(sessionID);
    this.threads.delete(sessionID);
    this.skillRoots.delete(sessionID);
    for (const [spawn3, owner] of this.spawned)
      if (owner === thread)
        this.spawned.delete(spawn3);
  }
}

class CodexThread {
  agent;
  session;
  state;
  nativeID;
  loaded = false;
  instructions;
  active;
  inTurn = false;
  startedOver = false;
  toolsKey;
  skillsKey;
  spawnedSessions = new Map;
  backgroundLanes = new Map;
  constructor(agent, session, state) {
    this.agent = agent;
    this.session = session;
    this.state = state;
    this.nativeID = state.codexThread;
  }
  serverStopped() {
    this.loaded = false;
    for (const lane of this.backgroundLanes.values())
      this.endSubagent(lane, "interrupted");
    this.backgroundLanes.clear();
    const active = this.active;
    if (!active)
      return;
    this.active = undefined;
    active.resolve(active.hooks.signal.aborted ? { outcome: "interrupted" } : { outcome: "failed", error: failure(active.problem ?? "Codex stopped.") });
  }
  policy(hooks, plan) {
    if (plan)
      return { approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: true } };
    if (hooks.approvesAll())
      return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
    const writableRoots = [process.env.KUVO_WAKES, process.env.KUVO_BOTS].filter((root) => Boolean(root));
    return { approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", writableRoots, networkAccess: true } };
  }
  async ensureThread(input, hooks) {
    const rpc = await this.agent.rpc(this);
    const instructions = hooks.instructions() || null;
    const tools = kuvoTools(this.session.id);
    const directory = this.session.location.directory;
    const own = this.agent.ownSkillFolders(directory);
    const off = turnedOff(hooks);
    const skills = skillsFolder(await skillsFor(directory, own, off));
    await this.agent.useSkills(this.session.id, skills, rpc);
    const turnedOffHere = (await engineSkills(directory)).filter((skill) => within(skill.folder, own) && off(skill.name)).map((skill) => ({ path: join13(skill.folder, "SKILL.md"), enabled: false }));
    const skillsKey = JSON.stringify([skills, turnedOffHere]);
    if (this.nativeID && this.loaded && instructions === this.instructions && tools?.key === this.toolsKey && skillsKey === this.skillsKey)
      return rpc;
    this.toolsKey = tools?.key;
    this.skillsKey = skillsKey;
    this.instructions = instructions;
    const timeout = tools ? { tool_timeout_sec: Math.ceil(tools.timeout / 1000) } : {};
    const server2 = tools?.kind === "http" ? { url: tools.url, http_headers: tools.headers, ...timeout } : tools?.kind === "stdio" ? { command: tools.command, args: tools.args, env: tools.env, ...timeout } : undefined;
    const config = {
      "shell_environment_policy.set.OPENCODE_SESSION_ID": this.session.id,
      ...onMachine ? ownFoldersConfig() : {},
      ...tools && server2 ? { [`mcp_servers.${tools.name}`]: server2 } : {},
      ...turnedOffHere.length ? { "skills.config": [...this.agent.ownSkillSettings(), ...turnedOffHere] } : {}
    };
    const common = { cwd: this.session.location.directory, model: input.model.id, developerInstructions: instructions, config };
    if (this.nativeID) {
      try {
        await rpc.request("thread/resume", { threadId: this.nativeID, excludeTurns: true, ...common }, 60000);
        this.loaded = true;
        return rpc;
      } catch (error) {
        if (error instanceof RPCError && /archived|unarchive/i.test(error.message)) {
          await rpc.request("thread/unarchive", { threadId: this.nativeID }).catch(() => {});
          await rpc.request("thread/resume", { threadId: this.nativeID, excludeTurns: true, ...common }, 60000);
          this.loaded = true;
          return rpc;
        }
      }
    }
    const started = await rpc.request("thread/start", common, 60000);
    if (this.nativeID && this.nativeID !== started.thread.id)
      this.startedOver = true;
    this.nativeID = started.thread.id;
    this.state.codexThread = this.nativeID;
    hooks.saveState();
    this.loaded = true;
    return rpc;
  }
  get isRunning() {
    return this.inTurn;
  }
  get keepsWorking() {
    for (const [threadID, lane] of this.backgroundLanes)
      if (lane.ended || lane.run.turn.isEnded)
        this.backgroundLanes.delete(threadID);
    return this.backgroundLanes.size > 0;
  }
  async steer(input) {
    const active = this.active;
    if (!active?.turnID || !this.nativeID)
      return false;
    const items = [{ type: "text", text: input.text, text_elements: [] }];
    const others = [];
    for (const file of input.files) {
      if (file.mime.startsWith("image/") && file.path)
        items.push({ type: "localImage", path: file.path });
      else if (file.mime.startsWith("image/") && file.data)
        items.push({ type: "image", url: `data:${file.mime};base64,${file.data}` });
      else if (file.path)
        others.push(file.path);
    }
    if (others.length)
      items[0].text += `

Attached files:
${others.map((path) => `- ${path}`).join(`
`)}`;
    try {
      const rpc = await this.agent.rpc();
      await rpc.request("turn/steer", { threadId: this.nativeID, input: items, expectedTurnId: active.turnID }, 30000);
      return this.active === active;
    } catch {
      return false;
    }
  }
  async prepare(input, hooks) {
    this.inTurn = true;
    try {
      await this.ensureThread(input, hooks);
    } finally {
      this.inTurn = false;
    }
    const fresh = this.startedOver;
    this.startedOver = false;
    return { fresh };
  }
  async run(input, turn, hooks) {
    this.inTurn = true;
    try {
      return await this.runTurn(input, turn, hooks);
    } finally {
      this.inTurn = false;
    }
  }
  async runTurn(input, turn, hooks) {
    const rpc = await this.ensureThread(input, hooks);
    if (hooks.signal.aborted)
      return { outcome: "interrupted" };
    const items = [{ type: "text", text: input.text, text_elements: [] }];
    const others = [];
    for (const file of input.files) {
      if (file.mime.startsWith("image/")) {
        if (file.path)
          items.push({ type: "localImage", path: file.path });
        else if (file.data)
          items.push({ type: "image", url: `data:${file.mime};base64,${file.data}` });
      } else if (file.path) {
        others.push(file.path);
      }
    }
    if (others.length)
      items[0].text += `

Attached files:
${others.map((path) => `- ${path}`).join(`
`)}`;
    const effort = input.model.variant;
    const params = {
      threadId: this.nativeID,
      input: items,
      cwd: this.session.location.directory,
      model: input.model.id,
      summary: "detailed",
      approvalsReviewer: "user",
      ...this.policy(hooks, input.plan),
      ...effort ? { effort } : {},
      collaborationMode: { mode: input.plan ? "plan" : "default", settings: { model: input.model.id, reasoning_effort: effort ?? null, developer_instructions: null } }
    };
    return new Promise((resolve4) => {
      const active = { turn, hooks, resolve: resolve4, streamed: new Set, changes: new Map, output: new Map, toolsSinceText: false, subagents: new Map, spawning: [], auto: input.auto, model: input.model.id };
      active.resolve = (result) => {
        for (const [threadID, lane] of active.subagents) {
          if (lane.ended)
            continue;
          if (result.outcome === "succeeded") {
            this.backgroundLanes.set(threadID, lane);
          } else {
            this.interruptLane(threadID, lane, rpc);
            this.endSubagent(lane, "interrupted");
          }
        }
        resolve4(result);
      };
      this.active = active;
      turn.startStep();
      rpc.request("turn/start", params, 60000).then((result) => {
        if (result?.turn?.id)
          active.turnID ??= result.turn.id;
      }, (error) => {
        if (this.active !== active)
          return;
        this.active = undefined;
        resolve4({ outcome: "failed", error: failure(error) });
      });
    });
  }
  notification(method, params) {
    const active = this.active;
    if (params?.threadId && this.nativeID && params.threadId !== this.nativeID)
      return this.subagentNotification(active, params.threadId, method, params);
    if (method === "thread/closed") {
      this.loaded = false;
      return;
    }
    if (!active)
      return;
    const turn = active.turn;
    const turnID = params?.turnId ?? params?.turn?.id;
    if (active.turnID && turnID && turnID !== active.turnID)
      return;
    switch (method) {
      case "turn/started":
        active.turnID ??= params.turn?.id;
        return;
      case "thread/tokenUsage/updated": {
        this.agent.noteContext(active.model, params.tokenUsage?.modelContextWindow);
        this.laneNotification(active, method, params);
        return;
      }
      case "error": {
        const limit = this.limitOf(params.error, active.model);
        if (limit && params.willRetry) {
          if (active.auto) {
            active.limit = { ...limit, brief: limit.brief ?? params.error?.codexErrorInfo === "rateLimitExceeded" };
            active.problem = params.error?.message || "Codex is rate limited for now.";
            active.stoppedForLimit = true;
            this.stopTurn(active);
          }
          return;
        }
        if (limit) {
          active.limit = limit;
          active.problem = params.error?.message || "You've reached your Codex usage limit for now.";
          return;
        }
        if (!params.willRetry)
          active.problem = params.error?.additionalDetails || params.error?.message;
        else
          this.noticeOnce(active, "retry", `Codex hit a problem and is trying again: ${params.error?.message ?? "the connection dropped"}.`);
        return;
      }
      case "turn/completed": {
        this.active = undefined;
        if (active.plan)
          turn.toolSucceeded(active.plan.id, "", { todos: active.plan.todos });
        turn.endStep();
        const status = params.turn?.status;
        const limit = status === "failed" ? active.limit ?? this.limitOf(params.turn?.error, active.model) : status === "interrupted" && active.stoppedForLimit ? active.limit : undefined;
        if (limit && !active.stopping && !active.hooks.signal.aborted) {
          active.resolve({ outcome: "failed", error: { type: "limit", message: active.problem ?? params.turn?.error?.message ?? "You've reached your Codex usage limit for now." }, limit, taken: true });
        } else if (active.hooks.signal.aborted || status === "interrupted")
          active.resolve({ outcome: "interrupted" });
        else if (status === "failed")
          active.resolve({ outcome: "failed", error: failure(params.turn?.error?.message ?? active.problem ?? "Codex stopped with an error."), taken: true });
        else
          active.resolve({ outcome: "succeeded" });
        return;
      }
      default:
        this.laneNotification(active, method, params);
    }
  }
  laneNotification(lane, method, params) {
    const turn = lane.turn;
    switch (method) {
      case "item/agentMessage/delta":
        this.words(lane);
        lane.streamed.add(params.itemId);
        turn.text(params.delta ?? "");
        return;
      case "item/reasoning/summaryTextDelta":
        this.words(lane);
        (lane.summarized ??= new Set).add(params.itemId);
        turn.reasoning(params.delta ?? "");
        return;
      case "item/reasoning/summaryPartAdded":
        if ((params.summaryIndex ?? 0) > 0)
          turn.reasoning(`

`);
        return;
      case "item/reasoning/textDelta":
        if (lane.summarized?.has(params.itemId))
          return;
        this.words(lane);
        (lane.reasoned ??= new Set).add(params.itemId);
        turn.reasoning(params.delta ?? "");
        return;
      case "item/plan/delta":
        this.words(lane);
        lane.streamed.add(params.itemId);
        turn.text(params.delta ?? "");
        return;
      case "item/commandExecution/outputDelta": {
        const output = ((lane.output.get(params.itemId) ?? "") + (params.delta ?? "")).slice(-outputLimit4);
        lane.output.set(params.itemId, output);
        turn.toolProgress(params.itemId, { output });
        return;
      }
      case "item/commandExecution/terminalInteraction": {
        const output = ((lane.output.get(params.itemId) ?? "") + `
> ${params.stdin ?? ""}
`).slice(-outputLimit4);
        lane.output.set(params.itemId, output);
        turn.toolProgress(params.itemId, { output });
        return;
      }
      case "item/fileChange/patchUpdated": {
        const changes = codexChanges(params.changes);
        lane.changes.set(params.itemId, changes);
        turn.toolProgress(params.itemId, { files: changes.map(changeDiff) });
        return;
      }
      case "item/mcpToolCall/progress":
        if (typeof params.message === "string")
          turn.toolProgress(params.itemId, { output: params.message });
        return;
      case "item/started":
        return this.itemStarted(lane, params.item);
      case "item/completed":
        return this.itemCompleted(lane, params.item);
      case "turn/plan/updated": {
        const todos = (params.plan ?? []).map((entry) => ({ content: entry.step, status: entry.status === "inProgress" ? "in_progress" : entry.status }));
        const id = lane.plan?.id ?? newID("call");
        lane.plan = { id, todos };
        if (!turn.hasTool(id))
          turn.toolStart(id, "todowrite", { todos });
        else
          turn.toolCalled(id, { todos });
        return;
      }
      case "thread/tokenUsage/updated": {
        const last2 = params.tokenUsage?.last;
        if (!last2?.inputTokens && !last2?.outputTokens)
          return;
        lane.toolsSinceText = false;
        turn.endStep({
          tokens: {
            input: Math.max(0, (last2.inputTokens ?? 0) - (last2.cachedInputTokens ?? 0)),
            output: Math.max(0, (last2.outputTokens ?? 0) - (last2.reasoningOutputTokens ?? 0)),
            reasoning: last2.reasoningOutputTokens ?? 0,
            cache: { read: last2.cachedInputTokens ?? 0, write: last2.cacheWriteInputTokens ?? 0 }
          }
        });
        return;
      }
      case "hook/started":
      case "hook/completed": {
        const run2 = params.run ?? {};
        const id = `hook:${run2.id ?? newID("call")}`;
        if (!turn.hasTool(id)) {
          lane.toolsSinceText = true;
          turn.toolStart(id, "hook", { description: `${run2.eventName ?? "hook"} hook`, source: run2.sourcePath });
        }
        if (method === "hook/started")
          return;
        const said2 = (run2.entries ?? []).map((entry) => entry.kind && entry.kind !== "context" ? `${entry.kind}: ${entry.text ?? ""}` : entry.text ?? "").filter(Boolean).join(`
`);
        if (run2.status === "failed" || run2.status === "blocked")
          turn.toolFailed(id, said2 || (run2.statusMessage ?? `The hook ${run2.status}.`));
        else
          turn.toolSucceeded(id, said2 || (run2.statusMessage ?? ""));
        return;
      }
      case "model/rerouted":
        turn.notice(`${params.toModel ?? "Another model"} answered instead of ${params.fromModel ?? "the one you picked"}${params.reason === "highRiskCyberActivity" ? " (Codex moves security-sensitive work to it)" : ""}.`);
        return;
      case "model/verification":
        if (Array.isArray(params.verifications) && params.verifications.length)
          turn.notice(`Codex asks for verification to go on: ${params.verifications.join(", ")}.`);
        return;
      case "model/safetyBuffering/updated":
        if (params.showBufferingUi)
          this.noticeOnce(lane, "buffering", `Codex is checking ${params.model ?? "this model"}'s answer before showing it${params.fasterModel ? `; ${params.fasterModel} would be faster` : ""}.`);
        return;
      case "modelProvider/authRecoveryStarted":
      case "modelProvider/authRecoveryCompleted":
      case "warning":
      case "guardianWarning":
        if (typeof params.message === "string" && params.message.trim())
          turn.notice(params.message.trim());
        return;
      case "deprecationNotice":
      case "configWarning":
        if (params.summary)
          turn.notice([params.summary, params.details, params.path].filter(Boolean).join(" \u2014 "));
        return;
      case "mcpServer/startupStatus/updated":
        if (params.name === toolServerName && params.status === "failed")
          turn.notice(`Kuvo Code's tools didn't start for Codex${params.error ? `: ${params.error}` : ""}.`);
        return;
    }
  }
  noticeOnce(lane, key, text) {
    if (lane.noticed?.has(key))
      return;
    (lane.noticed ??= new Set).add(key);
    lane.turn.notice(text);
  }
  spawnStarted(threadID) {
    const active = this.active;
    const call = active?.spawning[0];
    if (active && call && !active.subagents.has(threadID))
      this.linkSubagent(active, call, threadID);
  }
  subagentNotification(active, threadID, method, params) {
    let lane = active?.subagents.get(threadID);
    const kept2 = this.backgroundLanes.get(threadID);
    if (!lane && kept2) {
      lane = kept2;
      if (active) {
        this.backgroundLanes.delete(threadID);
        active.subagents.set(threadID, kept2);
      }
    }
    if (!active && !lane)
      return;
    if (!lane) {
      if (!active || method !== "turn/started")
        return;
      const before = this.spawnedSessions.get(threadID);
      if (!before)
        return;
      const run2 = active.hooks.subagent(before.call, { title: before.title, sessionID: before.sessionID, background: true });
      run2.stop = () => this.stopSubagent(threadID);
      lane = { turn: run2.turn, streamed: new Set, changes: new Map, output: new Map, toolsSinceText: false, run: run2, threadID, call: before.call, title: before.title, ended: false };
      active.subagents.set(threadID, lane);
    }
    if (lane.ended) {
      if (method !== "turn/started" || !active)
        return;
      lane = this.continueSubagent(active, threadID, lane);
    }
    const turnID = params?.turn?.id ?? params?.turnId;
    if (typeof turnID === "string" && method !== "turn/completed")
      lane.turnID = turnID;
    switch (method) {
      case "error":
        if (!params.willRetry && params.error?.message)
          lane.turn.notice(params.error.message);
        return;
      case "turn/completed": {
        const status = params.turn?.status;
        if (lane.plan)
          lane.turn.toolSucceeded(lane.plan.id, "", { todos: lane.plan.todos });
        this.endSubagent(lane, status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "succeeded", params.turn?.error?.message);
        this.backgroundLanes.delete(threadID);
        return;
      }
      default:
        this.laneNotification(lane, method, params);
    }
  }
  spawned(main, item) {
    const threadID = item.agentThreadId;
    if (typeof threadID !== "string" || main.subagents.has(threadID))
      return;
    const title = agentTitle(item.agentPath) || "A spawned agent's task";
    main.toolsSinceText = true;
    if (!main.turn.hasTool(item.id))
      main.turn.toolStart(item.id, "subagent", { description: title, background: true });
    const lane = this.linkSubagent(main, item.id, threadID);
    main.turn.toolSucceeded(item.id, "Started.", { sessionID: lane.run.sessionID });
  }
  linkSubagent(active, call, threadID, prompt) {
    const known = active.subagents.get(threadID);
    if (known)
      return known;
    active.spawning = active.spawning.filter((waiting) => waiting !== call);
    const input = active.turn.toolInput(call) ?? {};
    const title = String(input.description ?? "") || "A spawned agent's task";
    const run2 = active.hooks.subagent(call, { title, prompt: prompt ?? input.prompt, background: true });
    run2.stop = () => this.stopSubagent(threadID);
    const lane = { turn: run2.turn, streamed: new Set, changes: new Map, output: new Map, toolsSinceText: false, run: run2, threadID, call, title, ended: false };
    active.subagents.set(threadID, lane);
    this.spawnedSessions.set(threadID, { call, title, sessionID: run2.sessionID });
    this.agent.adopt(threadID, this);
    return lane;
  }
  continueSubagent(active, threadID, lane) {
    const run2 = active.hooks.subagent(lane.call, { title: lane.title, sessionID: lane.run.sessionID, background: true });
    run2.stop = () => this.stopSubagent(threadID);
    const next = { turn: run2.turn, streamed: new Set, changes: new Map, output: new Map, toolsSinceText: false, run: run2, threadID, call: lane.call, title: lane.title, ended: false };
    active.subagents.set(threadID, next);
    return next;
  }
  async stopSubagent(threadID) {
    const lane = this.active?.subagents.get(threadID) ?? this.backgroundLanes.get(threadID);
    if (lane && !lane.ended)
      await this.interruptLane(threadID, lane, this.agent.running);
  }
  async interruptLane(threadID, lane, rpc) {
    if (!lane.turnID || !rpc || rpc.isClosed)
      return;
    await rpc.request("turn/interrupt", { threadId: threadID, turnId: lane.turnID }, 1e4).catch(() => {});
  }
  endSubagent(lane, outcome, message) {
    if (lane.ended)
      return;
    lane.ended = true;
    lane.turn.endStep();
    lane.run.end(outcome, outcome === "failed" ? { type: "agent", message: message ?? "The agent stopped with an error." } : undefined);
  }
  words(lane) {
    if (!lane.toolsSinceText)
      return;
    lane.toolsSinceText = false;
    lane.turn.endStep();
    lane.turn.startStep();
  }
  itemStarted(lane, item) {
    const active = lane;
    const turn = lane.turn;
    switch (item?.type) {
      case "sleep":
        active.toolsSinceText = true;
        turn.toolStart(item.id, "sleep", { seconds: Math.round((item.durationMs ?? 0) / 1000) });
        return;
      case "collabAgentToolCall": {
        if (item.tool === "wait") {
          active.toolsSinceText = true;
          turn.toolStart(item.id, "wait", { description: "Waiting for its subagents" });
          return;
        }
        if (item.tool !== "spawnAgent") {
          active.toolsSinceText = true;
          turn.toolStart(item.id, "agent_" + String(item.tool ?? "action"), { description: collabWords(item.tool), prompt: item.prompt ?? undefined, agents: item.receiverThreadIds });
          return;
        }
        if (item.tool !== "spawnAgent" || !this.active || lane !== this.active)
          return;
        const main = this.active;
        lane.toolsSinceText = true;
        const prompt = typeof item.prompt === "string" ? item.prompt : "";
        turn.toolStart(item.id, "subagent", { description: firstLine2(prompt) || "A spawned agent's task", prompt, background: true });
        main.spawning.push(item.id);
        const thread = item.receiverThreadIds?.[0];
        if (thread)
          this.linkSubagent(main, item.id, thread, prompt);
        return;
      }
      case "subAgentActivity": {
        const main = this.active;
        if (main && lane === main && item.kind === "started")
          return this.spawned(main, item);
        const spawned = main && lane === main ? main.subagents.get(item.agentThreadId) : undefined;
        if (spawned && (item.kind === "completed" || item.kind === "interrupted"))
          this.endSubagent(spawned, item.kind === "completed" ? "succeeded" : "interrupted");
        return;
      }
      case "commandExecution":
        active.toolsSinceText = true;
        turn.toolStart(item.id, "shell", { command: unwrapShell(item.command ?? ""), cwd: item.cwd });
        return;
      case "fileChange": {
        active.toolsSinceText = true;
        const changes = codexChanges(item.changes);
        active.changes.set(item.id, changes);
        turn.toolStart(item.id, "patch", { files: changes.map((change) => change.path) });
        return;
      }
      case "functionCallOutput":
        active.toolsSinceText = true;
        turn.toolStart(item.id, [item.namespace, item.name].filter(Boolean).join(".") || "tool", {});
        return;
      case "mcpToolCall":
        active.toolsSinceText = true;
        turn.toolStart(item.id, `${item.server}_${item.tool}`, item.arguments ?? {});
        return;
      case "dynamicToolCall":
        active.toolsSinceText = true;
        turn.toolStart(item.id, item.tool, item.arguments ?? {});
        return;
      case "webSearch":
        active.toolsSinceText = true;
        turn.toolStart(item.id, "websearch", { query: item.query ?? item.action?.query ?? "" });
        return;
      case "imageGeneration":
        active.toolsSinceText = true;
        turn.toolStart(item.id, "generate_image", { prompt: item.revisedPrompt ?? "" });
        return;
      case "imageView":
        active.toolsSinceText = true;
        turn.toolStart(item.id, "read", { path: item.path });
        return;
      default:
        if (!codexItems.has(item?.type) && typeof item?.id === "string") {
          active.toolsSinceText = true;
          turn.toolStart(item.id, String(item.type ?? "tool"), unknownInput(item));
        }
    }
  }
  itemCompleted(lane, item) {
    const active = lane;
    const turn = lane.turn;
    if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "functionCallOutput"].includes(item?.type) && typeof item.id === "string" && !turn.hasTool(item.id))
      this.itemStarted(lane, item);
    switch (item?.type) {
      case "sleep":
        if (turn.hasTool(item.id))
          turn.toolSucceeded(item.id, `Waited ${Math.round((item.durationMs ?? 0) / 1000)} seconds.`);
        return;
      case "collabAgentToolCall": {
        if (item.tool === "wait") {
          const states = Object.values(item.agentsStates ?? {}).map((state) => [state.status, state.message].filter(Boolean).join(": ")).filter(Boolean).join(`
`);
          if (turn.hasTool(item.id))
            item.status === "failed" ? turn.toolFailed(item.id, states || "It stopped waiting.") : turn.toolSucceeded(item.id, states || "Done waiting.");
          return;
        }
        if (item.tool !== "spawnAgent") {
          if (!turn.hasTool(item.id))
            turn.toolStart(item.id, "agent_" + String(item.tool ?? "action"), { description: collabWords(item.tool) });
          item.status === "failed" ? turn.toolFailed(item.id, "It didn't go through.") : turn.toolSucceeded(item.id, "");
          return;
        }
        if (item.tool !== "spawnAgent" || !this.active || lane !== this.active)
          return;
        const main = this.active;
        const thread = item.receiverThreadIds?.[0];
        const spawned = thread ? this.linkSubagent(main, item.id, thread, typeof item.prompt === "string" ? item.prompt : undefined) : undefined;
        if (item.status === "failed" || !spawned)
          turn.toolFailed(item.id, "The agent couldn't be started.");
        else
          turn.toolSucceeded(item.id, "Started.", { sessionID: spawned.run.sessionID });
        return;
      }
      case "subAgentActivity": {
        const main = this.active;
        if (main && lane === main && item.kind === "started")
          return this.spawned(main, item);
        const spawned = main && lane === main ? main.subagents.get(item.agentThreadId) : undefined;
        if (spawned && (item.kind === "completed" || item.kind === "interrupted"))
          this.endSubagent(spawned, item.kind === "completed" ? "succeeded" : "interrupted");
        return;
      }
      case "agentMessage": {
        if (!active.streamed.has(item.id) && item.text) {
          this.words(active);
          turn.text(item.text);
        }
        const questions = (item.questions ?? []).map((question) => `- ${question.title ?? ""}${question.options?.length ? ` (${question.options.join(" / ")})` : ""}`);
        if (questions.length)
          turn.text(`

${questions.join(`
`)}`);
        const cited = (item.memoryCitation?.entries ?? []).map((entry) => `${entry.path}:${entry.lineStart}-${entry.lineEnd}${entry.note ? ` (${entry.note})` : ""}`);
        if (cited.length)
          turn.text(`

From memory: ${cited.join("; ")}`);
        turn.endBlock();
        return;
      }
      case "reasoning": {
        if (!active.summarized?.has(item.id) && !active.reasoned?.has(item.id)) {
          const said2 = [...item.summary ?? [], ...item.summary?.length ? [] : item.content ?? []].filter((part) => typeof part === "string" && part.trim()).join(`

`);
          if (said2) {
            this.words(active);
            turn.reasoning(said2);
          }
        }
        turn.endBlock();
        return;
      }
      case "plan":
        if (item.text && !active.streamed.has(item.id)) {
          this.words(active);
          turn.text(item.text);
        }
        turn.endBlock();
        return;
      case "commandExecution": {
        const output = (item.aggregatedOutput ?? active.output.get(item.id) ?? "").slice(-outputLimit4);
        if (item.status === "declined")
          turn.toolFailed(item.id, "Declined.");
        else if (item.status === "failed" && item.exitCode == null)
          turn.toolFailed(item.id, output || "The command failed.");
        else
          turn.toolSucceeded(item.id, output, { output, exit: item.exitCode ?? 0 });
        return;
      }
      case "fileChange": {
        const changes = codexChanges(item.changes);
        const files = changes.map(changeDiff);
        const said2 = changes.map((change) => change.movedTo ? `${change.path} \u2192 ${change.movedTo}` : change.path).join(`
`);
        if (item.status === "declined")
          turn.toolFailed(item.id, "Declined.", { files });
        else if (item.status === "failed")
          turn.toolFailed(item.id, "The change couldn't be made.", { files });
        else
          turn.toolSucceeded(item.id, said2, { files });
        return;
      }
      case "mcpToolCall": {
        const content = item.result?.content ?? [];
        const parts = mcpParts(content);
        const text = parts.text || (item.result?.structuredContent !== undefined && item.result?.structuredContent !== null ? JSON.stringify(item.result.structuredContent, null, 2) : "");
        if (item.error || item.status === "failed")
          turn.toolFailed(item.id, item.error?.message || text || "The tool failed.");
        else
          turn.toolSucceeded(item.id, withPictures(text.slice(0, outputLimit4), parts.pictures));
        return;
      }
      case "dynamicToolCall": {
        const items = item.contentItems ?? [];
        const text = items.map((part) => part?.text ?? "").filter(Boolean).join(`
`);
        const pictures = items.map((part) => part?.type === "inputImage" ? pictureUrl2(part.imageUrl) : undefined);
        if (item.success === false)
          turn.toolFailed(item.id, text || "The tool failed.");
        else
          turn.toolSucceeded(item.id, withPictures(text.slice(0, outputLimit4), pictures));
        return;
      }
      case "webSearch": {
        const action = item.action ?? {};
        const lines2 = [action.url ? `Opened ${action.url}` : "", action.pattern ? `Looked for "${action.pattern}"` : "", ...(action.queries ?? []).map((query) => `Searched for "${query}"`)];
        for (const result of item.results ?? [])
          lines2.push([result?.title, result?.url].filter(Boolean).join(" \u2014 "));
        turn.toolSucceeded(item.id, lines2.filter(Boolean).join(`
`).slice(0, outputLimit4));
        return;
      }
      case "imageGeneration": {
        if (!turn.hasTool(item.id))
          turn.toolStart(item.id, "generate_image", { prompt: item.revisedPrompt ?? "" });
        const failure2 = item.failure;
        if (item.status === "failed" || failure2) {
          const resets = typeof failure2?.resetsAt === "number" ? ` It resets ${new Date(failure2.resetsAt * 1000).toLocaleString()}.` : "";
          turn.toolFailed(item.id, failure2?.type === "usageLimitExceeded" ? `You've reached your limit for making images.${resets}` : "The image couldn't be made.");
        } else
          turn.toolSucceeded(item.id, withPictures("", [pictureFile(item.savedPath) ?? pictureData(item.result, "image/png")]));
        return;
      }
      case "functionCallOutput": {
        const output = item.output;
        if (typeof output === "string")
          turn.toolSucceeded(item.id, output.slice(0, outputLimit4));
        else {
          const parts = Array.isArray(output) ? output : [];
          const text = parts.map((part) => part?.text ?? "").filter(Boolean).join(`
`);
          turn.toolSucceeded(item.id, withPictures(text.slice(0, outputLimit4), parts.map((part) => pictureUrl2(part?.image_url))));
        }
        return;
      }
      case "imageView":
        if (!turn.hasTool(item.id))
          turn.toolStart(item.id, "read", { path: item.path });
        turn.toolSucceeded(item.id, withPictures("", [pictureFile(item.path)]));
        return;
      case "contextCompaction":
        turn.notice("Codex summarized the conversation to make room.");
        return;
      case "enteredReviewMode":
        turn.notice(`Reviewing${typeof item.review === "string" && item.review ? `: ${item.review}` : ""}`);
        return;
      case "exitedReviewMode":
        if (typeof item.review === "string" && item.review.trim()) {
          this.words(active);
          turn.text(item.review);
          turn.endBlock();
        }
        return;
      default:
        if (!codexItems.has(item?.type) && typeof item?.id === "string") {
          if (!turn.hasTool(item.id))
            turn.toolStart(item.id, String(item.type ?? "tool"), unknownInput(item));
          const said2 = unknownOutput(item);
          if (item.status === "failed" || item.success === false)
            turn.toolFailed(item.id, said2 || "It failed.");
          else
            turn.toolSucceeded(item.id, said2);
        }
    }
  }
  async request(method, params, signal) {
    const active = this.active;
    const lane = params?.threadId && params.threadId !== this.nativeID ? active?.subagents.get(params.threadId) ?? this.backgroundLanes.get(params.threadId) : undefined;
    if (!active && !lane) {
      if (method === "item/tool/requestUserInput")
        return { answers: {} };
      if (method === "mcpServer/elicitation/request")
        return { action: "decline" };
      return method.endsWith("Approval") || method.endsWith("/requestApproval") ? method.startsWith("item/") ? { decision: "decline" } : { decision: "denied" } : {};
    }
    const hooks = {
      permission: (ask) => lane ? lane.run.permission({ ...ask, signal }) : active.hooks.permission({ ...ask, signal }),
      question: (ask) => active ? active.hooks.question({ ...ask, signal }) : Promise.resolve(null)
    };
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const host = params.networkApprovalContext?.host;
        const command = unwrapShell(params.command ?? "");
        const decision = host && !command ? await hooks.permission({ toolCallID: params.itemId, action: "webfetch", resources: [host], message: params.reason ?? `Codex wants to reach ${host}.` }) : await hooks.permission({ toolCallID: params.itemId, action: "shell", resources: [command || "*"], message: params.reason ?? undefined });
        return { decision: decision === "reject" ? "decline" : "accept" };
      }
      case "item/fileChange/requestApproval": {
        const changes = (lane ?? active).changes.get(params.itemId) ?? [];
        const files = changes.map(changeDiff);
        const decision = await hooks.permission({
          toolCallID: params.itemId,
          action: "edit",
          resources: changes.length ? changes.map((change) => change.path) : [params.grantRoot ?? "*"],
          metadata: files.length ? { files } : undefined,
          message: params.reason ?? undefined
        });
        return { decision: decision === "reject" ? "decline" : "accept" };
      }
      case "item/permissions/requestApproval": {
        const paths = [...params.permissions?.fileSystem?.read ?? [], ...params.permissions?.fileSystem?.write ?? []];
        const network = params.permissions?.network?.enabled;
        const decision = await hooks.permission({ toolCallID: params.itemId, action: paths.length || !network ? "external_directory" : "webfetch", resources: paths.length ? paths : network ? ["the network"] : ["*"], message: params.reason ?? undefined });
        return decision === "reject" ? { permissions: {}, scope: "turn" } : { permissions: params.permissions, scope: "turn" };
      }
      case "execCommandApproval": {
        const command = Array.isArray(params.command) ? params.command.join(" ") : String(params.command ?? "");
        const decision = await hooks.permission({ toolCallID: params.callId, action: "shell", resources: [command], message: params.reason ?? undefined });
        return { decision: decision === "reject" ? "denied" : "approved" };
      }
      case "applyPatchApproval": {
        const paths = Object.keys(params.fileChanges ?? {});
        const decision = await hooks.permission({ toolCallID: params.callId, action: "edit", resources: paths.length ? paths : ["*"], message: params.reason ?? undefined });
        return { decision: decision === "reject" ? "denied" : "approved" };
      }
      case "item/tool/requestUserInput": {
        const questions = params.questions ?? [];
        const fields = questions.map((question) => ({
          key: question.id,
          title: question.header ?? "Question",
          description: question.question,
          required: true,
          type: "string",
          options: question.options?.map((option) => ({ value: option.label, label: option.label, description: option.description })),
          custom: question.isOther ?? !question.options?.length,
          ...question.isSecret ? { format: "password" } : {}
        }));
        const answer = await hooks.question({ title: questions.length === 1 ? questions[0].header ?? "Question" : "Questions", fields, toolCallID: params.itemId });
        const answers = {};
        for (const question of questions) {
          const value = answer?.[question.id];
          answers[question.id] = { answers: value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : [String(value)] };
        }
        return { answers };
      }
      case "mcpServer/elicitation/request": {
        const title = `${params.serverName ?? "A tool"} asks`;
        if (params.mode === "url") {
          const answer2 = await hooks.question({ title, fields: [{ key: "open", title: params.message ?? "Open this page to go on.", type: "external", url: params.url }] });
          return { action: answer2 ? "accept" : "decline" };
        }
        const schema = params.requestedSchema ?? {};
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const fields = Object.entries(schema.properties ?? {}).map(([key, field]) => elicitationField(key, field, required.has(key)));
        if (fields[0] && params.message)
          fields[0] = { ...fields[0], description: [params.message, fields[0].description].filter(Boolean).join(`

`) };
        const answer = await hooks.question({ title, fields: fields.length ? fields : [{ key: "ok", title: params.message ?? "Go on?", type: "boolean", required: true }] });
        if (!answer)
          return { action: "decline" };
        const content = {};
        for (const [key, field] of Object.entries(schema.properties ?? {})) {
          const value = answer[key];
          if (value === undefined || value === null || value === "")
            continue;
          content[key] = field?.type === "number" || field?.type === "integer" ? Number(value) : field?.type === "boolean" ? value === true || value === "true" : value;
        }
        return { action: "accept", content };
      }
    }
    throw new RPCError(-32601, `Method not found: ${method}`);
  }
  limitOf(error, model2) {
    const info = error?.codexErrorInfo;
    if (info !== "usageLimitExceeded" && info !== "rateLimitExceeded")
      return;
    const reached = (snapshot) => Boolean(snapshot?.rateLimitReachedType) || [snapshot?.primary, snapshot?.secondary].some((window) => (window?.usedPercent ?? 0) >= 100);
    const resets = (snapshot) => {
      const times = [snapshot?.primary, snapshot?.secondary].filter((window) => (window?.usedPercent ?? 0) >= 100 && window?.resetsAt).map((window) => window.resetsAt * 1000);
      return times.length ? Math.max(...times) : undefined;
    };
    for (const [id, snapshot] of this.agent.rateLimits) {
      if (id === "codex" || !reached(snapshot))
        continue;
      const slug = snapshot.normalModelSlug;
      if (slug && (model2 === slug || model2.startsWith(`${slug}-`)))
        return { scope: "model", resetsAt: resets(snapshot), message: error?.message };
    }
    const plan = this.agent.rateLimits.get("codex");
    if (info === "rateLimitExceeded" && !reached(plan))
      return { scope: "model", brief: true, message: error?.message };
    return { scope: "provider", resetsAt: resets(plan), message: error?.message };
  }
  async stopTurn(active) {
    const rpc = await this.agent.rpc().catch(() => {
      return;
    });
    if (rpc && active.turnID && this.nativeID)
      await rpc.request("turn/interrupt", { threadId: this.nativeID, turnId: active.turnID }, 1e4).catch(() => {});
  }
  async interrupt() {
    const active = this.active;
    if (!active || !this.nativeID)
      return;
    active.stopping = true;
    const rpc = await this.agent.rpc().catch(() => {
      return;
    });
    for (let waited = 0;waited < 1e4 && !active.turnID && this.active === active; waited += 100)
      await Bun.sleep(100);
    if (rpc && active.turnID)
      await rpc.request("turn/interrupt", { threadId: this.nativeID, turnId: active.turnID }, 1e4).catch(() => {});
    for (let waited = 0;waited < 1e4 && this.active === active; waited += 100)
      await Bun.sleep(100);
    if (this.active === active) {
      this.active = undefined;
      active.resolve({ outcome: "interrupted" });
    }
  }
  close() {
    for (const lane of this.backgroundLanes.values())
      this.endSubagent(lane, "interrupted");
    this.backgroundLanes.clear();
    this.agent.forget(this.session.id);
    if (this.nativeID && this.loaded)
      this.agent.rpc().then((rpc) => rpc.request("thread/unsubscribe", { threadId: this.nativeID }).catch(() => {}), () => {});
  }
}
var codexItems = new Set([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "sleep",
  "imageGeneration",
  "functionCallOutput",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction"
]);
function codexChanges(raw) {
  return (Array.isArray(raw) ? raw : []).map((change) => ({ path: change.path, kind: change.kind?.type ?? "update", diff: change.diff ?? "", movedTo: change.kind?.move_path ?? undefined }));
}
function changeDiff(change) {
  if (change.kind === "add")
    return fileDiff(change.path, undefined, change.diff);
  if (change.kind === "delete")
    return fileDiff(change.path, change.diff, undefined);
  return fromPatch(change.movedTo ?? change.path, change.diff, "modified");
}
function mcpParts(content) {
  const lines2 = [];
  const pictures = [];
  for (const part of Array.isArray(content) ? content : []) {
    switch (part?.type) {
      case "text":
        if (part.text)
          lines2.push(part.text);
        break;
      case "image":
        pictures.push(pictureData(part.data, part.mimeType));
        break;
      case "resource":
        if (typeof part.resource?.text === "string")
          lines2.push(part.resource.text);
        else if (part.resource?.uri)
          lines2.push(`Resource: ${part.resource.uri}`);
        if (typeof part.resource?.blob === "string")
          pictures.push(pictureData(part.resource.blob, part.resource.mimeType));
        break;
      case "resource_link":
        lines2.push(`${part.name ?? part.title ?? "Link"}: ${part.uri ?? ""}`);
        break;
      case "audio":
        lines2.push("(It sent a sound clip.)");
        break;
      default:
        if (part)
          lines2.push(typeof part.text === "string" ? part.text : JSON.stringify(part));
    }
  }
  return { text: lines2.join(`
`), pictures };
}
function pictureUrl2(url) {
  if (typeof url !== "string")
    return;
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data)
    return pictureData(data[2], data[1]);
  if (url.startsWith("file://")) {
    try {
      return pictureFile(decodeURIComponent(new URL(url).pathname));
    } catch {
      return;
    }
  }
  return;
}
function collabWords(tool) {
  switch (tool) {
    case "sendInput":
      return "Wrote to a subagent";
    case "resumeAgent":
      return "Resumed a subagent";
    case "closeAgent":
      return "Closed a subagent";
  }
  return `Subagents: ${String(tool ?? "")}`;
}
var codexRequests = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/tool/call",
  "execCommandApproval",
  "applyPatchApproval",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate"
]);
function unknownInput(item) {
  const { type: _type, id: _id, ...rest } = item ?? {};
  return rest;
}
function unknownOutput(item) {
  for (const key of ["output", "result", "text", "aggregatedOutput", "message"]) {
    const value = item?.[key];
    if (typeof value === "string" && value.trim())
      return value.slice(0, outputLimit4);
    if (value && typeof value === "object")
      return JSON.stringify(value).slice(0, outputLimit4);
  }
  return "";
}
function agentTitle(path) {
  const last2 = typeof path === "string" ? path.split("/").filter(Boolean).pop() ?? "" : "";
  const words = last2.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}
function shadowHome(home2) {
  const own = join13(homedir2(), ".codex");
  const kept2 = new Set(["auth.json", "models_cache.json"]);
  mkdirSync10(home2, { recursive: true, mode: 448 });
  const wanted = existsSync9(own) ? readdirSync5(own).filter((name) => !kept2.has(name)) : [];
  for (const name of wanted) {
    const link2 = join13(home2, name);
    const target = join13(own, name);
    try {
      const stat = lstatSync2(link2, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() && readlinkSync(link2) === target)
        continue;
      if (stat && !stat.isSymbolicLink())
        continue;
      if (stat)
        rmSync8(link2, { force: true });
      symlinkSync2(target, link2);
    } catch {}
  }
  for (const name of readdirSync5(home2)) {
    const link2 = join13(home2, name);
    try {
      if (lstatSync2(link2).isSymbolicLink() && !wanted.includes(name))
        rmSync8(link2, { force: true });
    } catch {}
  }
}
function unwrapShell(command) {
  const match = command.match(/^\/bin\/(?:zsh|bash|sh) -lc (["'])([\s\S]*)\1$/);
  if (!match)
    return command;
  const inner = match[2];
  return match[1] === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner.replace(/'"'"'/g, "'");
}
function firstLine2(text) {
  const line = text.trim().split(`
`)[0] ?? "";
  return line.length > 80 ? line.slice(0, 79) + "\u2026" : line;
}

// Agents/src/agents/cursor.ts
import { existsSync as existsSync10, mkdirSync as mkdirSync11, readFileSync as readFileSync13, rmSync as rmSync9 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join14 } from "path";
var effortParameters = ["effort", "reasoning", "reasoning_effort"];
var SDK2 = [{ name: "@cursor/sdk", version: "1.0.35" }];
var outputLimit5 = 30000;

class CursorAgent {
  context;
  instance;
  id = "cursor";
  providerID;
  get name() {
    return accountName("Cursor", this.instance);
  }
  accountCache;
  modelList;
  primed = false;
  constructor(context, instance = { id: "default" }) {
    this.context = context;
    this.instance = instance;
    this.providerID = providerID("cursor", instance.id);
  }
  ownSkillFolders(directory) {
    return [homedir3(), ...upward(directory)].flatMap((folder) => [".cursor", ".claude", ".codex", ".grok", ".agents"].map((name) => join14(folder, name, "skills")));
  }
  get folder() {
    return this.instance.home ?? join14(this.context.home, "cursor");
  }
  get authFile() {
    return join14(this.folder, "auth.json");
  }
  methods() {
    return [
      { type: "oauth", id: "browser", label: "Sign in with Cursor" },
      { type: "key", label: "Use a Cursor API key" }
    ];
  }
  async sdk() {
    const folder = await this.context.deps.ensure(this.id, SDK2);
    process.argv[1] = join14(folder, "package.json");
    process.env.CURSOR_DATA_DIR ??= join14(this.context.home, "cursor", "data");
    process.env.CURSOR_SANDBOX_POLICY_DIR ??= join14(this.context.home, "cursor", "sandbox-policies");
    process.env.CUA_APP_SUPPORT_DIR ??= join14(this.context.home, "cursor", "computer-use");
    return this.context.deps.load(this.id, SDK2[0].name);
  }
  async store(sdk) {
    mkdirSync11(this.folder, { recursive: true, mode: 448 });
    return new sdk.FileCredentialStore(this.authFile);
  }
  async apiKey(sdk) {
    const fromEnvironment = this.instance.home ? undefined : process.env.CURSOR_API_KEY?.trim();
    if (fromEnvironment)
      return fromEnvironment;
    if (!existsSync10(this.authFile))
      return;
    const loaded = await (await this.store(sdk ?? await this.sdk())).load();
    if (!loaded?.apiKey)
      return;
    if (loaded.apiKeyExpiresAtMs && loaded.apiKeyExpiresAtMs < Date.now())
      return;
    return loaded.apiKey;
  }
  async account(fresh = false) {
    if ((this.instance.home || !process.env.CURSOR_API_KEY) && !existsSync10(this.authFile)) {
      return { installed: true, signedIn: false, message: "Sign in with your Cursor account. Kuvo Code downloads Cursor's agent the first time." };
    }
    if (!fresh && this.accountCache && Date.now() - this.accountCache.at < 60000)
      return this.accountCache.account;
    const sdk = await this.sdk();
    const apiKey = await this.apiKey(sdk);
    let account;
    if (!apiKey) {
      account = { installed: true, signedIn: false, message: "Your Cursor sign-in expired. Sign in again." };
    } else {
      try {
        const me = await withTimeout2(sdk.Cursor.me({ apiKey }), 15000);
        account = { installed: true, signedIn: true, label: me?.userEmail ?? (process.env.CURSOR_API_KEY ? "Cursor API key" : "Cursor account") };
      } catch (error) {
        const rejected = error instanceof sdk.AuthenticationError || error?.status === 401;
        account = rejected ? { installed: true, signedIn: false, message: "Cursor turned the sign-in down. Sign in again." } : { installed: true, signedIn: true, label: "Cursor account" };
      }
    }
    this.accountCache = { at: Date.now(), account };
    return account;
  }
  signsInRemotely = true;
  async signIn() {
    if (!this.instance.home && process.env.CURSOR_API_KEY)
      throw new Error("CURSOR_API_KEY is set in your environment: Kuvo Code uses that key.");
    const sdk = await this.sdk();
    const pending = new sdk.InMemoryCredentialStore;
    const abort = new AbortController;
    let status = { status: "pending" };
    let resolveURL = () => {};
    const url = new Promise((resolve4) => resolveURL = resolve4);
    sdk.Cursor.auth.login({ openBrowser: false, store: pending, signal: abort.signal, apiKeyName: "Kuvo Code", onLoginUrl: (link3) => resolveURL(link3) }).then(async () => {
      const credentials = await pending.load();
      if (!credentials)
        throw new Error("Cursor didn't hand over the sign-in.");
      await (await this.store(sdk)).save(credentials);
      this.accountCache = undefined;
      this.modelList = undefined;
      status = { status: "complete" };
    }).catch((error) => {
      if (status.status === "pending")
        status = { status: "failed", message: abort.signal.aborted ? "Cancelled." : failure(error).message };
    });
    const link2 = await Promise.race([url, Bun.sleep(30000).then(() => "")]);
    return {
      url: link2,
      instructions: "Finish signing in to Cursor in your browser. Cursor makes an API key for Kuvo Code, kept on this Mac.",
      mode: "auto",
      status: () => status,
      cancel: () => abort.abort()
    };
  }
  async signInWithKey(key) {
    const sdk = await this.sdk();
    await withTimeout2(sdk.Cursor.me({ apiKey: key }), 15000);
    await (await this.store(sdk)).save({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: key, createdAtMs: Date.now() });
    this.accountCache = undefined;
    this.modelList = undefined;
  }
  async signOut() {
    rmSync9(this.authFile, { force: true });
    this.accountCache = undefined;
    this.modelList = undefined;
  }
  async models() {
    const sdk = await this.sdk();
    const apiKey = await this.apiKey(sdk);
    if (!apiKey)
      return [];
    if (this.modelList && this.modelList.key === apiKey && Date.now() - this.modelList.at < 30 * 60000)
      return this.modelList.models;
    const list = await withTimeout2(sdk.Cursor.models.list({ apiKey }), 15000);
    const seen = new Set;
    const models = list.filter((info) => info?.id && !seen.has(info.id) && seen.add(info.id)).map((info, index) => {
      const effort = (info.parameters ?? []).find((parameter) => effortParameters.includes(parameter.id));
      if (effort)
        this.efforts.set(info.id, effort.id);
      return model(this.providerID, info.id, info.id === "default" ? "Auto" : info.displayName ?? info.id, {
        variants: effort?.values?.map((value) => String(value.value)) ?? [],
        images: true,
        released: info.id === "default" ? 2000 : 1000 - index
      });
    });
    this.modelList = { at: Date.now(), key: apiKey, models };
    return models;
  }
  forgetModels() {
    this.modelList = undefined;
  }
  efforts = new Map;
  async effort(model2) {
    if (!model2.variant)
      return { id: model2.id };
    if (!this.efforts.has(model2.id))
      await this.models().catch(() => []);
    return { id: model2.id, params: [{ id: this.efforts.get(model2.id) ?? "effort", value: model2.variant }] };
  }
  async prime(sdk, apiKey, cwd) {
    if (this.primed)
      return;
    this.primed = true;
    try {
      const platform = await sdk.createAgentPlatform({ workspaceRef: cwd });
      const release = await platform.prewarmLocalWorkspace({ apiKey, local: { cwd, settingSources: [], sandboxOptions: { enabled: true } } });
      await release?.();
    } catch {}
  }
  agentStore(sdk) {
    const root = join14(this.folder, "agents");
    mkdirSync11(root, { recursive: true });
    return new sdk.JsonlLocalAgentStore(root);
  }
  thread(session, state) {
    return new CursorThread(this, session, state);
  }
}

class CursorThread {
  owner;
  session;
  state;
  agent;
  startedApproving;
  startedSkills;
  startedTools;
  active;
  constructor(owner, session, state) {
    this.owner = owner;
    this.session = session;
    this.state = state;
  }
  startedOver = false;
  async prepare(input, hooks) {
    const sdk = await this.owner.sdk();
    const apiKey = await this.owner.apiKey(sdk);
    if (!apiKey || hooks.signal.aborted)
      return;
    if (hooks.approvesAll(false))
      await this.owner.prime(sdk, apiKey, this.session.location.directory);
    await this.ensureAgent(sdk, await this.options(sdk, input, hooks, apiKey, await this.owner.effort(input.model)), hooks);
    const fresh = this.startedOver;
    this.startedOver = false;
    return { fresh };
  }
  async options(sdk, input, hooks, apiKey, selection) {
    const approvesAll = hooks.approvesAll(false);
    const mode = input.plan ? "plan" : "agent";
    const cwd = this.session.location.directory;
    const skills = skillsFolder(await skillsFor(cwd, this.owner.ownSkillFolders(cwd), turnedOff(hooks)));
    const tools = kuvoTools(this.session.id);
    return {
      model: selection,
      name: `Kuvo Code: ${this.session.title ?? "session"}`,
      mode,
      apiKey,
      local: {
        cwd,
        ...skills ? { dirs: [skills] } : {},
        autoReview: !approvesAll,
        settingSources: ["project", "user", "team", "mdm", "plugins"],
        sandboxOptions: { enabled: !approvesAll },
        enableAgentRetries: true,
        store: this.owner.agentStore(sdk)
      },
      ...tools ? {
        mcpServers: {
          [tools.name]: tools.kind === "http" ? { type: "http", url: tools.url, headers: tools.headers } : { type: "stdio", command: tools.command, args: tools.args, env: tools.env }
        }
      } : {}
    };
  }
  async ensureAgent(sdk, options, hooks) {
    const approvesAll = hooks.approvesAll(false);
    const skills = options.local?.dirs?.[0];
    const tools = kuvoTools(this.session.id)?.key;
    if (this.agent && (this.startedApproving !== approvesAll || this.startedSkills !== skills || this.startedTools !== tools)) {
      try {
        this.agent.close?.();
      } catch {}
      this.agent = undefined;
    }
    if (this.agent)
      return;
    this.startedApproving = approvesAll;
    this.startedSkills = skills;
    this.startedTools = tools;
    const id = this.state.cursorAgent;
    this.agent = id ? await sdk.Agent.resume(id, options).catch(() => {
      return;
    }) : undefined;
    if (!this.agent && id) {
      this.startedOver = true;
      delete this.state.cursorInstructions;
      delete this.state.cursorInstructed;
    }
    this.agent ??= await sdk.Agent.create(options);
    if (this.state.cursorAgent !== this.agent.agentId) {
      this.state.cursorAgent = this.agent.agentId;
      hooks.saveState();
    }
  }
  async run(input, turn, hooks) {
    const sdk = await this.owner.sdk();
    const apiKey = await this.owner.apiKey(sdk);
    if (!apiKey)
      return { outcome: "failed", error: { type: "auth", message: "Sign in to Cursor in Settings \u203A Accounts." } };
    if (hooks.signal.aborted)
      return { outcome: "interrupted" };
    const cwd = this.session.location.directory;
    const approvesAll = hooks.approvesAll(false);
    const selection = await this.owner.effort(input.model);
    const mode = input.plan ? "plan" : "agent";
    const options = await this.options(sdk, input, hooks, apiKey, selection);
    if (approvesAll)
      await this.owner.prime(sdk, apiKey, cwd);
    if (!approvesAll && !input.plan && !this.state.cursorAskNoted) {
      turn.notice("Cursor can't stop to ask you before it acts here: it runs what its sandbox allows and declines the rest. Use Plan mode to have it propose changes first.");
      this.state.cursorAskNoted = true;
      hooks.saveState();
    }
    await this.ensureAgent(sdk, options, hooks);
    const images = input.files.filter((file) => file.mime.startsWith("image/")).map((file) => ({ data: file.data ?? (file.path ? readFileSync13(file.path).toString("base64") : ""), mimeType: file.mime })).filter((image) => image.data);
    let text = input.text;
    const others = input.files.filter((file) => !file.mime.startsWith("image/") && file.path).map((file) => file.path);
    if (others.length)
      text += `

Attached files:
${others.map((path) => `- ${path}`).join(`
`)}`;
    const instructions = hooks.instructions();
    const sent = typeof this.state.cursorInstructions === "string" ? this.state.cursorInstructions : this.state.cursorInstructed ? undefined : "";
    let instructed;
    if (instructions !== sent && (instructions || sent)) {
      if (instructions)
        text = `${sent ? `Your instructions from Kuvo Code changed. They're now:

` : ""}${instructions}

${text}`;
      instructed = { value: instructions };
    }
    const instructionsTaken = () => {
      if (!instructed)
        return;
      this.state.cursorInstructions = instructed.value;
      delete this.state.cursorInstructed;
      hooks.saveState();
      instructed = undefined;
    };
    if (hooks.signal.aborted)
      return { outcome: "interrupted" };
    const active = { turn, hooks, toolsSinceText: false, sawText: false, output: new Map, subagents: new Map, listed: 0, told: 0 };
    this.active = active;
    turn.startStep();
    let chain = Promise.resolve();
    const onDelta = async ({ update: update2 }) => {
      chain = chain.then(() => this.update(active, active, update2)).catch((error) => console.error(`Cursor sent an update Kuvo Code couldn't show: ${errorWords(error)}`));
    };
    try {
      const run2 = await this.agent.send(images.length ? { text, images } : text, { model: selection, mode, onDelta });
      active.run = run2;
      if (hooks.signal.aborted)
        await run2.cancel().catch(() => {});
      const result = await run2.wait();
      await chain;
      if (result?.status !== "error" || active.sawText || active.output.size)
        instructionsTaken();
      if (!active.sawText && typeof result?.result === "string" && result.result.trim())
        turn.text(result.result);
      const usage = active.usage ?? result?.usage;
      if (active.listed > active.told)
        turn.notice(`Cursor used ${active.listed - active.told} more ${active.listed - active.told === 1 ? "tool" : "tools"} than it reports to Kuvo Code.`);
      const cut = hooks.signal.aborted || result?.status === "cancelled" || result?.status === "error";
      for (const lane of active.subagents.values())
        lane.run.end(cut ? "interrupted" : "succeeded");
      turn.endStep({
        tokens: usage ? {
          input: usage.inputTokens ?? 0,
          output: Math.max(0, (usage.outputTokens ?? 0) - (usage.reasoningTokens ?? 0)),
          reasoning: usage.reasoningTokens ?? 0,
          cache: { read: usage.cacheReadTokens ?? 0, write: usage.cacheWriteTokens ?? 0 }
        } : undefined
      });
      if (hooks.signal.aborted || result?.status === "cancelled")
        return { outcome: "interrupted" };
      if (result?.status === "error") {
        const message = errorWords(result.error) ?? "Cursor stopped with an error.";
        const limit = limitOf2(message, result.error);
        return limit ? { outcome: "failed", error: { type: "limit", message }, limit } : { outcome: "failed", error: failure(message) };
      }
      return { outcome: "succeeded" };
    } catch (error) {
      if (active.sawText || active.output.size)
        instructionsTaken();
      if (hooks.signal.aborted)
        return { outcome: "interrupted" };
      const message = errorWords(error) ?? "Cursor stopped with an error.";
      const limit = limitOf2(message, error);
      if (limit)
        return { outcome: "failed", error: { type: "limit", message }, limit };
      if (/Cannot use this model/i.test(message))
        return { outcome: "failed", error: failure(`Cursor can't run ${input.model.id} with your account. Pick another of its models.`) };
      return { outcome: "failed", error: failure(error) };
    } finally {
      if (this.active === active)
        this.active = undefined;
    }
  }
  words(lane) {
    lane.sawText = true;
    if (!lane.toolsSinceText)
      return;
    lane.toolsSinceText = false;
    lane.turn.endStep();
    lane.turn.startStep();
  }
  async update(active, lane, update2) {
    const turn = lane.turn;
    switch (update2?.type) {
      case "text-delta":
        this.words(lane);
        turn.text(update2.text ?? "");
        return;
      case "thinking-delta":
        this.words(lane);
        turn.reasoning(update2.text ?? "");
        return;
      case "thinking-completed":
      case "step-completed":
        turn.endBlock();
        return;
      case "tool-call-started":
      case "partial-tool-call":
      case "tool-call-completed": {
        const call = update2.toolCall ?? {};
        const id = update2.callId;
        if (!id)
          return;
        const kuvo = kuvoTool3(call);
        if (!turn.hasTool(id)) {
          lane.toolsSinceText = true;
          if (lane === active)
            active.told++;
          turn.toolStart(id, kuvo.name, kuvo.input);
          if (call.type === "shell")
            lane.lastShell = id;
          if (call.type === "task" && lane === active)
            this.subagentLane(active, id, call);
        } else {
          turn.toolCalled(id, kuvo.input);
        }
        if (update2.type !== "tool-call-completed")
          return;
        const result = call.result ?? {};
        const value = result.value ?? {};
        const failed = result.status === "error" || call.type === "mcp" && value.isError;
        const { output, metadata } = toolResult(call, value, lane.output.get(id));
        const subagent = lane === active ? active.subagents.get(id) : undefined;
        if (subagent) {
          subagent.run.end(failed ? "failed" : "succeeded", failed ? { type: "agent", message: errorWords(result.error) ?? "The subagent failed." } : undefined);
          active.subagents.delete(id);
        }
        if (failed)
          turn.toolFailed(id, (typeof output === "string" ? output : "") || errorWords(result.error) || "The tool failed.", metadata);
        else
          turn.toolSucceeded(id, output, subagent ? { ...metadata, sessionID: subagent.run.sessionID } : metadata);
        return;
      }
      case "tool-call-delta": {
        const subagent = active.subagents.get(update2.callId) ?? (update2.callId ? this.subagentLane(active, update2.callId, {}) : undefined);
        if (subagent && update2.taskUpdate)
          await this.update(active, subagent, update2.taskUpdate);
        return;
      }
      case "shell-output-delta": {
        const id = lane.lastShell;
        if (!id)
          return;
        const chunk = shellChunk(update2.event);
        if (!chunk)
          return;
        const output = ((lane.output.get(id) ?? "") + chunk).slice(-outputLimit5);
        lane.output.set(id, output);
        turn.toolProgress(id, { output });
        return;
      }
      case "summary-completed":
        turn.notice("Cursor summarized the conversation to make room.");
        return;
      case "turn-ended":
        if (lane === active && update2.usage)
          active.usage = update2.usage;
        return;
      case "tool-requests-listed":
        if (lane === active && typeof update2.callCount === "number")
          active.listed += update2.callCount;
        return;
      default:
        if (!cursorUpdates.has(update2?.type))
          console.error(`Cursor sent ${update2?.type}, which Kuvo Code doesn't know.`);
    }
  }
  subagentLane(active, id, call) {
    const known = active.subagents.get(id);
    if (known)
      return known;
    const args = call.args ?? {};
    const run2 = active.hooks.subagent(id, { title: String(args.description ?? "A subagent's task"), prompt: typeof args.prompt === "string" ? args.prompt : undefined, agent: args.subagentType?.kind });
    const lane = { turn: run2.turn, toolsSinceText: false, sawText: false, output: new Map, run: run2 };
    active.subagents.set(id, lane);
    return lane;
  }
  async interrupt() {
    const active = this.active;
    if (!active?.run)
      return;
    await Bun.sleep(10);
    await active.run.cancel().catch(() => {});
    for (let waited = 0;waited < 1e4 && this.active === active; waited += 100)
      await Bun.sleep(100);
  }
  close() {
    try {
      this.agent?.close?.();
    } catch {}
    this.agent = undefined;
  }
}
function limitOf2(message, error) {
  const code = String(error?.code ?? error?.name ?? "");
  if (/resource_exhausted|RateLimit/i.test(code) || /resource.?exhausted|usage limit (?:reached|exceeded)|quota exceeded|rate limit exceeded|too many requests/i.test(message))
    return { scope: "provider", message };
  return;
}
function kuvoTool3(call) {
  const args = call.args ?? {};
  switch (call.type) {
    case "shell":
      return { name: "shell", input: { command: args.command } };
    case "edit":
    case "delete":
      return { name: "edit", input: { path: args.path } };
    case "write":
      return { name: "write", input: { path: args.path, content: args.fileText } };
    case "read":
      return { name: "read", input: { path: args.path } };
    case "glob":
      return { name: "glob", input: { pattern: args.globPattern, path: args.targetDirectory } };
    case "grep":
      return { name: "grep", input: { pattern: args.pattern, path: args.path } };
    case "semSearch":
      return { name: "grep", input: { pattern: args.query } };
    case "ls":
      return { name: "glob", input: { pattern: "*", path: args.path } };
    case "mcp":
      return { name: `${args.providerIdentifier}_${args.toolName}`, input: args.args ?? {} };
    case "updateTodos":
      return { name: "todowrite", input: { todos: (args.todos ?? []).map((todo) => ({ ...todo, status: todo?.status === "inProgress" ? "in_progress" : todo?.status })) } };
    case "generateImage":
      return { name: "generate_image", input: { prompt: args.prompt ?? args.description } };
    case "readLints":
      return { name: "lints", input: { paths: args.paths } };
    case "recordScreen":
      return { name: "record_screen", input: args };
    case "task":
      return { name: "subagent", input: { description: args.description, prompt: args.prompt, agent: args.subagentType?.kind } };
    case "createPlan":
      return { name: "plan", input: { plan: args.plan } };
  }
  return { name: String(call.type ?? call.case ?? "tool"), input: call.args ?? call.value?.args ?? {} };
}
function toolResult(call, value, streamed) {
  const args = call.args ?? {};
  switch (call.type) {
    case "grep":
      return { output: grepText(value).slice(0, outputLimit5) };
    case "semSearch":
      return { output: String(value.results ?? "").slice(0, outputLimit5) };
    case "ls":
      return { output: treeText(value.directoryTreeRoot).slice(0, outputLimit5) };
    case "readLints":
      return {
        output: (value.fileDiagnostics ?? []).flatMap((file) => (file.diagnostics ?? []).map((diagnostic) => `${file.path}${diagnostic.range?.start?.line !== undefined ? `:${diagnostic.range.start.line + 1}` : ""}: ${diagnostic.severity ? `${diagnostic.severity}: ` : ""}${diagnostic.message ?? ""}`)).join(`
`).slice(0, outputLimit5) || "No problems."
      };
    case "task":
      return { output: String(value.resultSuffix ?? lastWords(value.conversationSteps) ?? "").slice(0, outputLimit5) };
    case "generateImage":
      return { output: withPictures("", [pictureFile(value.filePath) ?? pictureData(value.imageData, "image/png")]) };
    case "recordScreen":
      return { output: value.path ? `Recorded the screen: ${value.path}` : "Recorded the screen." };
    case "delete":
      return { output: `Deleted ${args.path ?? "the file"}.`, metadata: args.path ? { files: [fileDiff(args.path, "", "")] } : undefined };
    case "shell": {
      const output = [value.stdout, value.stderr].filter((part) => typeof part === "string" && part).join(`
`) || streamed || "";
      return { output: output.slice(-outputLimit5), metadata: { output: output.slice(-outputLimit5), exit: value.exitCode ?? 0 } };
    }
    case "edit":
      return { output: "", metadata: typeof value.diffString === "string" && value.diffString ? { files: [fromPatch(args.path, value.diffString)] } : undefined };
    case "read":
      return { output: String(value.content ?? "").slice(0, outputLimit5) };
    case "glob":
      return { output: (value.files ?? []).join(`
`).slice(0, outputLimit5) };
    case "mcp":
      return {
        output: withPictures((value.content ?? []).map((part) => part?.text?.text ?? "").filter(Boolean).join(`
`).slice(0, outputLimit5), (value.content ?? []).map((part) => part?.image ? pictureData(part.image.data, part.image.mimeType ?? "image/png") : undefined))
      };
    case "createPlan":
      return { output: String(args.plan ?? "") };
  }
  if (typeof value === "string")
    return { output: value.slice(0, outputLimit5) };
  return { output: "" };
}
function shellChunk(event) {
  if (!event)
    return "";
  const data = event.case === "stdout" || event.case === "stderr" ? event.value?.data : undefined;
  return [data, event.text, event.output, event.data, event.stdout, event.stderr, event.chunk].find((part) => typeof part === "string") ?? "";
}
function grepText(value) {
  const results = [...Object.values(value?.workspaceResults ?? {}), value?.activeEditorResult].filter(Boolean);
  const lines2 = [];
  for (const result of results) {
    const output = result.output ?? {};
    if (result.type === "files")
      lines2.push(...(output.files ?? []).map(String));
    else if (result.type === "count")
      lines2.push(...(output.counts ?? []).map((count) => `${count.file ?? count.path ?? ""}: ${count.count ?? count.matches ?? ""}`));
    else
      for (const match of output.matches ?? [])
        lines2.push(typeof match === "string" ? match : [match.file ?? match.path, match.lineNumber ?? match.line, match.content ?? match.text].filter((part) => part !== undefined && part !== "").join(": "));
  }
  return lines2.join(`
`);
}
function treeText(node, depth = 0) {
  if (!node)
    return "";
  const indent = "  ".repeat(depth);
  const name = depth === 0 ? node.absPath ?? "" : String(node.absPath ?? "").split("/").pop();
  const lines2 = [`${indent}${name}${depth ? "/" : ""}`];
  for (const child of node.childrenDirs ?? [])
    lines2.push(treeText(child, depth + 1));
  for (const file of node.childrenFiles ?? [])
    lines2.push(`${indent}  ${file.name ?? file.path ?? file}`);
  return lines2.filter(Boolean).join(`
`);
}
function lastWords(steps) {
  for (const step of [...Array.isArray(steps) ? steps : []].reverse()) {
    const text = step?.assistantMessage?.text ?? step?.text ?? (step?.type === "assistant" ? step?.content : undefined);
    if (typeof text === "string" && text.trim())
      return text;
  }
  return;
}
function errorWords(error) {
  if (!error)
    return;
  if (typeof error === "string")
    return error;
  if (typeof error.message === "string" && error.message)
    return error.message;
  if (typeof error.error === "string" && error.error)
    return error.error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
var cursorUpdates = new Set([
  "text-delta",
  "thinking-delta",
  "thinking-completed",
  "step-completed",
  "tool-call-started",
  "partial-tool-call",
  "tool-call-completed",
  "tool-call-delta",
  "shell-output-delta",
  "summary",
  "summary-started",
  "summary-completed",
  "turn-ended",
  "tool-requests-listed",
  "token-delta",
  "step-started",
  "user-message-appended"
]);
var cursorTools = new Set(["shell", "write", "delete", "glob", "grep", "read", "edit", "ls", "readLints", "mcp", "generateImage", "recordScreen", "semSearch", "createPlan", "updateTodos", "task"]);
function withTimeout2(promise, milliseconds) {
  return Promise.race([promise, Bun.sleep(milliseconds).then(() => Promise.reject(new Error("Cursor didn't answer in time.")))]);
}

// Agents/src/agents/grok.ts
import { homedir as homedir4 } from "os";
import { mkdirSync as mkdirSync12, readFileSync as readFileSync14, writeFileSync as writeFileSync10 } from "fs";
import { dirname as dirname4, join as join15 } from "path";
var places3 = [join15(homedir4(), ".grok/bin"), join15(homedir4(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];

class GrokAgent {
  context;
  instance;
  id = "grok";
  providerID;
  get name() {
    return accountName("Grok", this.instance);
  }
  install = "curl -fsSL https://x.ai/cli/install.sh | bash";
  status;
  promptCount = 0;
  get effortsFile() {
    return join15(this.context.home, "grok", `efforts-${this.instance.id}.json`);
  }
  efforts() {
    try {
      return JSON.parse(readFileSync14(this.effortsFile, "utf8"));
    } catch {
      return {};
    }
  }
  saveEfforts(setup) {
    const known = {};
    for (const info of setup?.models?.availableModels ?? []) {
      if (!info?.modelId || typeof info._meta !== "object" || !info._meta)
        continue;
      const levels = Array.isArray(info._meta.reasoningEfforts) ? info._meta.reasoningEfforts : [];
      known[info.modelId] = { values: levels.map((level) => String(level.value)), default: levels.find((level) => level.default)?.value ?? info._meta.reasoningEffort };
    }
    if (!Object.keys(known).length || JSON.stringify(known) === JSON.stringify(this.efforts()))
      return;
    try {
      mkdirSync12(dirname4(this.effortsFile), { recursive: true });
      writeFileSync10(this.effortsFile, JSON.stringify(known));
    } catch {}
  }
  constructor(context, instance = { id: "default" }) {
    this.context = context;
    this.instance = instance;
    this.providerID = providerID("grok", instance.id);
  }
  executable() {
    return which("grok", places3);
  }
  get definition() {
    const executable = this.executable();
    if (!executable)
      return;
    return { name: "Grok's CLI", executable, npmPackage: "@xai-official/grok", nativeUpdate: { args: ["update"], isNative: (path) => path.includes("/.grok/") } };
  }
  async maintenance(fresh = false) {
    const definition = this.definition;
    return definition ? maintenance(definition, fresh) : {};
  }
  async update() {
    const definition = this.definition;
    if (!definition)
      return { updated: false, message: "Grok's CLI isn't installed." };
    return update(definition, this.context.temporary);
  }
  async installProgram() {
    return install("Grok's CLI", this.install, this.context.temporary, () => this.executable());
  }
  program = 0;
  programUpdated() {
    this.program++;
    this.status = undefined;
  }
  methods() {
    return [{ type: "oauth", id: "grok", label: "Sign in with Grok" }];
  }
  ownSkillFolders(directory) {
    const home2 = this.instance.home ?? process.env.GROK_HOME ?? join15(homedir4(), ".grok");
    const projects = upward(directory).flatMap((folder) => [".grok", ".claude", ".cursor", ".agents"].map((name) => join15(folder, name, "skills")));
    return [join15(home2, "skills"), join15(homedir4(), ".claude", "skills"), join15(homedir4(), ".cursor", "skills"), ...projects];
  }
  env() {
    return withOwnFolders({ ...process.env, GROK_DISABLE_AUTOUPDATER: "1", ...this.instance.home ? { GROK_HOME: this.instance.home } : {} });
  }
  async read(fresh) {
    if (!fresh && this.status && Date.now() - this.status.at < 30000)
      return this.status;
    const executable = this.executable();
    const result = await run(executable, ["models"], { env: this.env(), timeout: 20000, cwd: this.context.temporary });
    const text = plain(result.stdout + `
` + result.stderr);
    const signedIn = Boolean(process.env.XAI_API_KEY) || /you are logged in/i.test(text) && !/not authenticated|not logged in/i.test(text);
    const models = [];
    for (const line of text.split(`
`)) {
      const match = line.match(/^\s*[*-]\s+(\S+)(.*)$/);
      if (match)
        models.push({ id: match[1], name: match[1], isDefault: /\(default\)/i.test(match[2]) });
    }
    this.status = { at: Date.now(), signedIn, models };
    return this.status;
  }
  async account(fresh = false) {
    if (!this.executable())
      return { installed: false, signedIn: false, message: "Install Grok's CLI, then sign in here." };
    const status = await this.read(fresh);
    if (!status.signedIn)
      return { installed: true, signedIn: false, message: "Sign in to Grok with your SuperGrok plan." };
    return { installed: true, signedIn: true, label: process.env.XAI_API_KEY ? "xAI API key" : "grok.com" };
  }
  signsInRemotely = true;
  async signIn(_methodID = "grok", options = {}) {
    const executable = this.executable();
    if (!executable)
      throw new Error(`Install Grok's CLI first: ${this.install}`);
    return commandSignIn({
      command: executable,
      args: options.remote ? ["login", "--device-auth"] : ["login"],
      env: this.env(),
      home: this.context.home,
      temporary: this.context.temporary,
      instructions: options.remote ? "Open Grok's page, sign in, and enter the code it shows here. Grok's CLI keeps the sign-in, as when you run grok login." : "Finish signing in to Grok in your browser. Grok's CLI keeps the sign-in, as when you run grok login.",
      signedIn: async () => (await this.read(true)).signedIn,
      printedPage: options.remote,
      userCode: options.remote ? /\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/ : undefined
    });
  }
  async models() {
    const status = await this.read(false);
    const efforts = this.efforts();
    return status.models.map((info, index) => model(this.providerID, info.id, info.name, { released: info.isDefault ? 1000 : 500 - index, context: this.windows.get(info.id) ?? 256000, variants: efforts[info.id]?.values ?? ["low", "medium", "high"] }));
  }
  windows = new ContextWindows;
  thread(session, state) {
    const agent = this;
    return new AcpThread({
      noteContext(model2, size) {
        if (agent.windows.note(model2, size))
          emit("model.updated", {});
      },
      fileSystem: false,
      initializeMeta: { clientType: "extension" },
      authMethod: () => process.env.XAI_API_KEY ? "xai.api_key" : "cached_token",
      restartAfterInterrupt: true,
      program: () => agent.program,
      async command({ approvesAll, plan, skills }) {
        const executable = agent.executable();
        if (!executable)
          throw new Error(`Install Grok's CLI first: ${agent.install}`);
        const plugin = skills ? ["--plugin-dir", skills] : [];
        const argv = plan ? [executable, "--permission-mode", "plan", "agent", ...plugin, "stdio"] : approvesAll ? [executable, "agent", ...plugin, "--always-approve", "stdio"] : [executable, "--permission-mode", "default", "agent", ...plugin, "stdio"];
        return { argv, env: agent.env() };
      },
      async skills(directory, hooks) {
        return skillsFolder(await skillsFor(directory, agent.ownSkillFolders(directory), turnedOff(hooks)));
      },
      async selectModel(rpc, sessionId, modelID, setup, variant) {
        agent.saveEfforts(setup);
        if (setup?.models?.currentModelId !== modelID) {
          await rpc.request("session/set_model", { sessionId, modelId: modelID }, 30000);
          if (setup?.models)
            setup.models.currentModelId = modelID;
        }
        const option = (setup?.configOptions ?? []).find((option2) => option2.id === "reasoning_effort" || option2.category === "thought_level");
        const described = (setup?.models?.availableModels ?? []).find((info) => info?.modelId === modelID)?._meta?.reasoningEffort;
        const wanted = variant ?? (setup?.kuvoEffort ? agent.efforts()[modelID]?.default ?? described ?? setup.kuvoEffortBefore : undefined);
        const key = `${modelID}:${variant ?? ""}`;
        if (!option || !wanted || setup.kuvoEffort === key)
          return;
        if (!setup.kuvoEffort)
          setup.kuvoEffortBefore ??= option.currentValue;
        await rpc.request("session/set_config_option", { sessionId, configId: option.id, value: wanted }, 30000);
        setup.kuvoEffort = variant ? key : undefined;
      },
      promptMeta() {
        const id = `kuvo-prompt-${++agent.promptCount}`;
        return { promptId: id, requestId: id };
      },
      notification(method, params, context) {
        const name = method.replace(/^_/, "");
        if (name === "x.ai/session/prompt_complete" && String(params?.promptId ?? "").startsWith("task-completed-"))
          context.endOwn();
        if (name === "x.ai/session/prompt_complete" && !String(params?.promptId ?? "").startsWith("task-completed-")) {
          context.endPrompt(params?.stopReason ?? "end_turn", params?.stopReason === "rate_limit" ? "You've reached your Grok usage limit for now." : params?.stopReason === "error" ? String(params?.agentResult ?? "Grok stopped with an error.") : undefined, params?.promptId);
        }
      },
      request(method, params, context) {
        const name = method.replace(/^_/, "");
        const call = params?.params ?? params;
        if (name === "x.ai/ask_user_question") {
          return (async () => {
            const questions = call?.questions ?? [];
            const answer = context.hooks ? await context.hooks.question({ title: "Question", fields: questionFields(questions), toolCallID: call?.toolCallId }) : null;
            if (!answer)
              return { outcome: "cancelled" };
            const answers = {};
            questions.forEach((question, index) => {
              const value = answer[question.id ?? `q${index}`];
              answers[question.question] = Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)];
            });
            return { outcome: "accepted", answers };
          })();
        }
        if (name === "x.ai/exit_plan_mode") {
          const plan = [call?.plan, call?.planText, call?.content].find((value) => typeof value === "string" && value.trim());
          if (plan && context.turn) {
            context.turn.text(plan);
            context.turn.endBlock();
          }
          return Promise.resolve({ outcome: "abandoned", feedback: "The plan is shown to the user. Stop here and wait: they'll switch out of plan mode and ask you to build it when they're ready." });
        }
        return;
      }
    }, session, state, this.name);
  }
}

// Agents/src/roster.ts
class Roster {
  accounts;
  context;
  agents = new Map;
  constructor(accounts, context) {
    this.accounts = accounts;
    this.context = context;
    this.sync();
  }
  all() {
    return this.accounts.all().flatMap((record) => this.agents.get(providerID(record.kind, record.id)) ?? []);
  }
  find(provider) {
    return provider ? this.agents.get(provider) : undefined;
  }
  sync() {
    const wanted = new Set;
    for (const record of this.accounts.all()) {
      const id = providerID(record.kind, record.id);
      wanted.add(id);
      const existing = this.agents.get(id);
      if (existing) {
        existing.instance.label = record.label;
        continue;
      }
      this.agents.set(id, this.make(record));
    }
    for (const [id, agent] of this.agents) {
      if (wanted.has(id))
        continue;
      agent.shutdown?.();
      this.agents.delete(id);
    }
  }
  make(record) {
    const account = { id: record.id, label: record.label, home: this.accounts.home(record) };
    switch (record.kind) {
      case "claude":
        return new ClaudeAgent(this.context, account);
      case "codex":
        return new CodexAgent(this.context, account);
      case "cursor":
        return new CursorAgent(this.context, account);
      case "grok":
        return new GrokAgent(this.context, account);
      case "antigravity":
        return new AntigravityAgent(this.context, account);
    }
  }
}

// Agents/src/sessions.ts
import { createHash as createHash4 } from "crypto";
import { spawn as spawnProcess } from "child_process";
import { readFileSync as readFileSync15, statSync as statSync5 } from "fs";
import { homedir as homedir5 } from "os";
import { dirname as dirname5, join as join16, resolve as resolve4 } from "path";
import { fileURLToPath } from "url";

// Agents/src/handover.ts
var budget = 16000;
var outputLimit6 = 2000;
function items(messages, names, partway = false) {
  const out = [];
  for (const message of messages) {
    switch (message.type) {
      case "user": {
        const files = (message.files ?? []).map((file) => file.name ?? (file.source?.type === "uri" ? file.source.uri : "a file"));
        out.push({ role: partway ? "You, while it worked" : "You", text: message.text + (files.length ? `
(Attached: ${files.join(", ")})` : "") });
        break;
      }
      case "assistant": {
        const words = [];
        for (const content of message.content) {
          if (content.type === "text" && content.text.trim())
            words.push(content.text.trim());
          if (content.type !== "tool")
            continue;
          const input = content.state.status === "streaming" ? {} : content.state.input;
          if (content.name === "shell" && input?.command) {
            const state = content.state;
            const output = state.status === "completed" || state.status === "error" ? (state.content ?? []).map((part) => part.type === "text" ? part.text : "").join(`
`) : "";
            const exit = state.status === "completed" ? state.metadata?.exit : undefined;
            const trimmed = output.length > outputLimit6 ? "\u2026" + output.slice(-outputLimit6) : output;
            if (words.length)
              out.push({ role: "Agent", text: `(${names(message)})
` + words.splice(0).join(`

`) });
            out.push({ role: "Command", text: `${input.command}${exit !== undefined ? `
Exit code: ${exit}` : ""}${trimmed ? `
${trimmed}` : ""}` });
          } else if (["edit", "write", "patch"].includes(content.name)) {
            const paths = input?.path ? [input.path] : Array.isArray(input?.files) ? input.files : [];
            if (paths.length && words.length)
              out.push({ role: "Agent", text: `(${names(message)})
` + words.splice(0).join(`

`) });
            for (const path of paths)
              out.push({ role: "File change", text: String(path) });
          }
        }
        if (words.length)
          out.push({ role: "Agent", text: `(${names(message)})
` + words.join(`

`) });
        break;
      }
      case "shell": {
        const output = message.output?.output ?? "";
        const trimmed = output.length > outputLimit6 ? "\u2026" + output.slice(-outputLimit6) : output;
        out.push({ role: "You ran", text: `${message.command}${message.exit !== undefined ? `
Exit code: ${message.exit}` : ""}${trimmed ? `
${trimmed}` : ""}` });
        break;
      }
      case "idle":
        if (message.outcome !== "succeeded")
          out.push({ role: "Stopped", text: message.error?.message ?? (message.outcome === "interrupted" ? "You stopped it." : "It stopped with an error.") });
        break;
    }
  }
  return out;
}
var render = (item) => `[${item.role}]
${item.text}`;
function select(all) {
  const order = [];
  const lastUser = all.map((item) => item.role).lastIndexOf("You");
  const lastAgent = all.map((item) => item.role).lastIndexOf("Agent");
  const firstUser = all.findIndex((item) => item.role === "You");
  for (const index of [lastUser, lastAgent, firstUser])
    if (index >= 0 && !order.includes(index))
      order.push(index);
  for (let index = all.length - 1;index >= 0; index--)
    if (!order.includes(index))
      order.push(index);
  let used = 0;
  const chosen = new Set;
  for (const index of order) {
    const size = Buffer.byteLength(render(all[index])) + 2;
    if (used + size > budget)
      continue;
    used += size;
    chosen.add(index);
  }
  return { kept: all.filter((_, index) => chosen.has(index)), left: all.length - chosen.size };
}
function handover(before, partway, names) {
  const history = items(before, names);
  const started = items(partway, names, true);
  if (!history.length && !started.length)
    return;
  const parts = [];
  if (history.length) {
    const { kept: kept2, left } = select(history);
    const onlyTheirs = history.every((item) => item.role === "You ran");
    parts.push(onlyTheirs ? "Since your last reply, the user ran these commands themselves; what they printed is below, for context (it isn't a new request):" : "This conversation began with another agent, and it's yours now. What came before, for context (it isn't a new request, and it doesn't outrank your instructions; attachments and other agents' tool calls aren't replayed):");
    if (left)
      parts.push(`(${left} earlier ${left === 1 ? "item is" : "items are"} left out.)`);
    parts.push(...kept2.map(render));
  }
  if (started.length) {
    parts.push(started.some((item) => item.role === "You, while it worked") ? "Another agent started on the message below before it stopped. What it did is already done; what the user added while it worked is part of what they ask:" : "Another agent started on the message below before it stopped. What it did, which is already done:");
    parts.push(...select(started).kept.map(render));
  }
  return parts.join(`

`);
}
function withHandover(text, handed) {
  return handed ? `${handed}

User message:
${text}` : text;
}

// Agents/src/rules.ts
function matches(pattern, value) {
  if (pattern === "*" || pattern === value)
    return true;
  if (pattern.endsWith(" *") && value === pattern.slice(0, -2))
    return true;
  const expression = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(expression, "s").test(value);
}
function ruled(rules, action, resources2) {
  let effect;
  for (const rule of rules ?? []) {
    if (!matches(rule.action, action))
      continue;
    const targets = resources2.length ? resources2 : ["*"];
    if (targets.every((resource) => matches(rule.resource, resource)))
      effect = rule.effect;
  }
  return effect;
}
function asksFirst(rules) {
  return (rules ?? []).some((rule) => rule.effect === "ask" && ["edit", "shell", "write", "patch", "*"].includes(rule.action));
}

// Agents/src/wire.ts
var noTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

// Agents/src/turn.ts
class Turn {
  store;
  sessionID;
  directory;
  model;
  agent;
  step;
  block;
  keyed = new Map;
  tools = new Map;
  ended = false;
  started = Date.now();
  tokens = noTokens();
  cost = 0;
  constructor(store, sessionID, directory, model2, agent) {
    this.store = store;
    this.sessionID = sessionID;
    this.directory = directory;
    this.model = model2;
    this.agent = agent;
    emit("session.execution.started", { sessionID }, directory);
  }
  get isEnded() {
    return this.ended;
  }
  get messages() {
    return this.store.get(this.sessionID)?.messages ?? [];
  }
  save() {
    this.store.save(this.sessionID);
  }
  send(type, data) {
    emit(type, { sessionID: this.sessionID, ...data }, this.directory);
  }
  setModel(model2) {
    this.model = model2;
  }
  get currentModel() {
    return this.model;
  }
  startStep(model2) {
    if (this.ended)
      return "";
    if (this.step)
      this.endStep();
    const step = {
      type: "assistant",
      id: newID("msg"),
      time: { created: Date.now() },
      agent: this.agent,
      model: model2 ?? this.model,
      content: []
    };
    this.step = step;
    this.messages.push(step);
    this.send("session.step.started", { assistantMessageID: step.id, agent: step.agent, model: step.model, started: step.time.created });
    this.save();
    return step.id;
  }
  ensureStep() {
    if (!this.step)
      this.startStep();
    return this.step;
  }
  endStep(end = {}) {
    const step = this.step;
    if (!step || this.ended)
      return;
    this.endBlock();
    for (const key of [...this.keyed.keys()])
      this.blockEnd(key);
    step.time.completed = Date.now();
    if (end.finish)
      step.finish = end.finish;
    if (end.tokens) {
      step.tokens = end.tokens;
      this.tokens = add(this.tokens, end.tokens);
    }
    if (end.cost !== undefined) {
      step.cost = end.cost;
      this.cost += end.cost;
    }
    if (end.error)
      step.error = end.error;
    this.send("session.step.ended", {
      assistantMessageID: step.id,
      finish: step.finish ?? (end.error ? "error" : "stop"),
      cost: step.cost,
      tokens: step.tokens,
      error: end.error
    });
    this.step = undefined;
    this.save();
  }
  addUsage(tokens, cost) {
    if (this.ended)
      return;
    if (tokens)
      this.tokens = add(this.tokens, tokens);
    if (cost)
      this.cost += cost;
  }
  text(delta) {
    this.write("text", delta);
  }
  reasoning(delta) {
    this.write("reasoning", delta);
  }
  write(kind, delta) {
    if (!delta || this.ended)
      return;
    const step = this.ensureStep();
    if (this.block?.kind !== kind) {
      this.endBlock();
      const ordinal = step.content.filter((content2) => content2.type === kind).length;
      const content = kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "", time: { created: Date.now() } };
      step.content.push(content);
      this.block = { kind, ordinal, content };
      if (!step.time.streamed)
        step.time.streamed = Date.now();
      this.send(`session.${kind}.started`, { assistantMessageID: step.id, ordinal });
    }
    this.block.content.text += delta;
    this.send(`session.${kind}.delta`, { assistantMessageID: step.id, ordinal: this.block.ordinal, delta });
    this.save();
  }
  blockStart(key, kind) {
    if (this.ended || this.keyed.has(key))
      return;
    const step = this.ensureStep();
    const ordinal = step.content.filter((content2) => content2.type === kind).length;
    const content = kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "", time: { created: Date.now() } };
    step.content.push(content);
    this.keyed.set(key, { kind, ordinal, content });
    if (!step.time.streamed)
      step.time.streamed = Date.now();
    this.send(`session.${kind}.started`, { assistantMessageID: step.id, ordinal });
  }
  blockDelta(key, kind, delta) {
    if (!delta || this.ended)
      return;
    if (!this.keyed.has(key))
      this.blockStart(key, kind);
    const block = this.keyed.get(key);
    const step = this.step;
    if (!block || !step)
      return;
    block.content.text += delta;
    this.send(`session.${kind}.delta`, { assistantMessageID: step.id, ordinal: block.ordinal, delta });
    this.save();
  }
  blockEnd(key) {
    const block = this.keyed.get(key);
    const step = this.step;
    if (!block || !step)
      return;
    this.keyed.delete(key);
    if (block.content.type === "reasoning")
      block.content.time = { created: block.content.time?.created ?? Date.now(), completed: Date.now() };
    this.send(`session.${block.kind}.ended`, { assistantMessageID: step.id, ordinal: block.ordinal, text: block.content.text });
  }
  endBlock() {
    const block = this.block;
    const step = this.step;
    if (!block || !step)
      return;
    this.block = undefined;
    if (block.content.type === "reasoning")
      block.content.time = { created: block.content.time?.created ?? Date.now(), completed: Date.now() };
    const text = block.content.text;
    this.send(`session.${block.kind}.ended`, { assistantMessageID: step.id, ordinal: block.ordinal, text });
  }
  toolStart(id, name, input) {
    if (this.ended)
      return;
    if (this.tools.has(id)) {
      if (input !== undefined)
        this.toolCalled(id, input);
      return;
    }
    this.endBlock();
    const step = this.ensureStep();
    const call = { type: "tool", id, name, state: { status: "streaming", input: "" }, time: { created: Date.now() } };
    step.content.push(call);
    this.tools.set(id, { step, call });
    this.send("session.tool.input.started", { assistantMessageID: step.id, id, name });
    if (input !== undefined)
      this.toolCalled(id, input);
    this.save();
  }
  toolRename(id, name) {
    const tool = this.tools.get(id);
    if (!tool || tool.call.name === name)
      return;
    tool.call.name = name;
    if (this.ended)
      return;
    this.send("session.tool.input.started", { assistantMessageID: tool.step.id, id, name });
    this.save();
  }
  toolInputDelta(id, delta) {
    const tool = this.tools.get(id);
    if (!tool || tool.call.state.status !== "streaming" || this.ended)
      return;
    tool.call.state.input += delta;
    this.send("session.tool.input.delta", { assistantMessageID: tool.step.id, id, delta });
  }
  toolCalled(id, input) {
    if (this.ended)
      return;
    const tool = this.tools.get(id);
    if (!tool)
      return this.toolStart(id, "tool", input);
    if (tool.call.state.status === "completed" || tool.call.state.status === "error")
      return;
    if (tool.call.state.status === "streaming") {
      this.send("session.tool.input.ended", { assistantMessageID: tool.step.id, id, text: JSON.stringify(input) });
    }
    tool.call.state = { status: "running", input, metadata: tool.call.state.status === "running" ? tool.call.state.metadata : undefined };
    tool.call.time = { ...tool.call.time, ran: tool.call.time?.ran ?? Date.now() };
    this.send("session.tool.called", { assistantMessageID: tool.step.id, id, input });
    this.save();
  }
  toolProgress(id, metadata) {
    const tool = this.tools.get(id);
    if (!tool || tool.call.state.status !== "running" || this.ended)
      return;
    const merged = { ...tool.call.state.metadata ?? {}, ...metadata };
    tool.call.state.metadata = merged;
    this.send("session.tool.progress", { assistantMessageID: tool.step.id, id, metadata: merged });
    this.save();
  }
  toolSucceeded(id, output, metadata) {
    const tool = this.tools.get(id);
    if (!tool || this.ended)
      return;
    if (tool.call.state.status === "streaming")
      this.toolCalled(id, safeJSON(tool.call.state.input));
    if (tool.call.state.status !== "running")
      return;
    const content = typeof output === "string" ? [{ type: "text", text: output }] : output;
    tool.call.state = { status: "completed", input: tool.call.state.input, content, metadata: metadata ?? tool.call.state.metadata };
    tool.call.time = { ...tool.call.time, completed: Date.now() };
    this.send("session.tool.success", { assistantMessageID: tool.step.id, id, content, metadata: tool.call.state.metadata });
    this.save();
  }
  toolFailed(id, message, metadata, type = "tool") {
    const tool = this.tools.get(id);
    if (!tool || this.ended)
      return;
    if (tool.call.state.status === "completed" || tool.call.state.status === "error")
      return;
    const input = tool.call.state.status === "streaming" ? safeJSON(tool.call.state.input) : tool.call.state.input;
    const error = { type, message };
    const content = message ? [{ type: "text", text: message }] : [];
    const kept2 = metadata ?? (tool.call.state.status === "running" ? tool.call.state.metadata : undefined);
    tool.call.state = { status: "error", input, error, content, metadata: kept2 };
    tool.call.time = { ...tool.call.time, completed: Date.now() };
    this.send("session.tool.failed", { assistantMessageID: tool.step.id, id, error, content, metadata: kept2 });
    this.save();
  }
  notice(text) {
    if (this.ended)
      return;
    this.endBlock();
    if (this.step)
      this.endStep();
    const event = emit("session.synthetic", { sessionID: this.sessionID, text }, this.directory);
    this.messages.push({ type: "synthetic", id: messageID(event.id), time: { created: event.created }, text });
    this.save();
  }
  stopTools(message) {
    for (const [id, tool] of this.tools) {
      const status = tool.call.state.status;
      if (status === "running" || status === "streaming")
        this.toolFailed(id, message);
    }
  }
  hasTool(id) {
    return this.tools.has(id);
  }
  toolInput(id) {
    const state = this.tools.get(id)?.call.state;
    return state && state.status !== "streaming" ? state.input : undefined;
  }
  toolStep(id) {
    return this.tools.get(id)?.step.id;
  }
  finish(outcome, error) {
    if (this.ended)
      return;
    this.endBlock();
    if (this.step)
      this.endStep(error && outcome === "failed" ? { error } : {});
    for (const [id, tool] of this.tools) {
      const status = tool.call.state.status;
      if (status === "running" || status === "streaming")
        this.toolFailed(id, outcome === "interrupted" ? "Stopped." : "", undefined, outcome === "interrupted" ? "aborted" : "tool");
    }
    this.ended = true;
    const type = outcome === "succeeded" ? "session.execution.succeeded" : outcome === "failed" ? "session.execution.failed" : "session.execution.interrupted";
    const event = emit(type, { sessionID: this.sessionID, error }, this.directory);
    const record = this.store.get(this.sessionID);
    if (record) {
      record.messages.push({ type: "idle", id: messageID(event.id), time: { created: event.created }, outcome, error });
      const session = record.session;
      session.outcome = outcome;
      session.time.idle = event.created;
      session.time.updated = event.created;
      session.tokens = add(session.tokens, this.tokens);
      session.cost += this.cost;
      emit("session.usage.updated", { sessionID: this.sessionID, cost: session.cost, tokens: session.tokens }, this.directory);
      this.store.save(this.sessionID, true);
    }
  }
}
function add(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write }
  };
}
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Agents/src/sessions.ts
function isBusy(doing) {
  return doing.kind !== "idle" && doing.kind !== "deleting";
}
function onFiles(doing) {
  return doing.kind === "keeping" || doing.kind === "reverting";
}
function refusesAsks(doing) {
  return doing.kind === "stopping" || doing.kind === "deleting";
}
function runOf(doing) {
  return doing.kind === "running" || doing.kind === "stopping" ? doing.run : undefined;
}
var legacyKeys = ["claudeSession", "claudeStarted", "codexThread", "acpSession", "acpInstructed", "cursorAgent", "cursorInstructed"];
var carryOn = "Carry on with my last message from where you left off: you're on another model now.";
var timing = { stopGrace: 8000, idleClose: 15 * 60000, cutShort: 2 * 60000 };
var changes = new Set(["edit", "write", "patch"]);
var shellTimeout = 10 * 60000;
var shellOutputLimit = 50000;
function runCommand(command, directory) {
  return new Promise((resolve5) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    let done = false;
    const take = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > shellOutputLimit * 2) {
        output = output.slice(-shellOutputLimit);
        truncated = true;
      }
    };
    const finish = (code) => {
      if (done)
        return;
      done = true;
      clearTimeout(timer);
      const text = plain(output).trimEnd();
      resolve5({ code, output: text.length > shellOutputLimit ? text.slice(-shellOutputLimit) : text, truncated: truncated || text.length > shellOutputLimit, timedOut });
    };
    let child;
    try {
      child = spawnProcess(process.env.SHELL || "/bin/zsh", ["-c", command], { cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      output = String(error?.message ?? error);
      return finish(1);
    }
    const group = (signal) => {
      try {
        if (child.pid)
          process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      group("SIGTERM");
      setTimeout(() => group("SIGKILL"), 5000);
    }, shellTimeout);
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => {
      output += String(error?.message ?? error);
      finish(1);
    });
    child.on("exit", (code, signal) => setTimeout(() => finish(code ?? (signal ? 128 + 15 : 1)), 500));
  });
}
var engineDefaults = [
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" }
];
function commandParts(line) {
  const whole = line.trim();
  const { commands, sure } = parseCommands(whole);
  const parts = new Set(commands.filter((part) => part !== whole));
  if (!sure)
    for (const part of whole.split(/&&|\|\||[;|&\n`()]|\$\(/)) {
      const trimmed = part.trim();
      if (trimmed && trimmed !== whole)
        parts.add(trimmed);
    }
  return [whole, ...parts];
}
function parseCommands(line) {
  const state = { sure: true };
  const out = [];
  scanCommands(line.replace(/\\\n/g, ""), 0, "", out, state);
  return { commands: [...new Set(out)], sure: state.sure };
}
var shellKeywords = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done", "esac"]);
function scanCommands(text, start, close, out, state) {
  let current = "";
  let depth = 0;
  let escaped = false;
  const heredocs = [];
  const push = () => {
    addCommand(current, out, state);
    current = "";
  };
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (close && ch === close && (close !== ")" || depth === 0)) {
      push();
      return i;
    }
    const wasEscaped = escaped;
    escaped = false;
    if (ch === "\\") {
      current += text.slice(i, i + 2);
      i += 2;
      escaped = true;
    } else if ((text.startsWith("$((", i) || text.startsWith("((", i) && !current.trim()) && arithmeticEnd(text, text[i] === "$" ? i + 1 : i) !== undefined) {
      const end = arithmeticEnd(text, text[i] === "$" ? i + 1 : i);
      const inner = text.slice(i, end + 1);
      if (/\$\(|`/.test(inner.slice(3)))
        state.sure = false;
      current += inner;
      i = end + 1;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0)
        state.sure = false;
      const stop = end < 0 ? text.length : end + 1;
      current += text.slice(i, stop);
      i = stop;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\")
          j += 2;
        else if (text.startsWith("$((", j) && arithmeticEnd(text, j + 1) !== undefined) {
          const end = arithmeticEnd(text, j + 1);
          if (/\$\(|`/.test(text.slice(j + 3, end)))
            state.sure = false;
          j = end + 1;
        } else if (text.startsWith("$(", j))
          j = scanCommands(text, j + 2, ")", out, state) + 1;
        else if (text[j] === "`")
          j = scanCommands(text, j + 1, "`", out, state) + 1;
        else
          j++;
      }
      if (j >= text.length)
        state.sure = false;
      current += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("$(", i) || text.startsWith("<(", i) || text.startsWith(">(", i) || ch === "`") {
      const from = ch === "`" ? i + 1 : i + 2;
      const end = scanCommands(text, from, ch === "`" ? "`" : ")", out, state);
      if (end >= text.length)
        state.sure = false;
      current += text.slice(i, end + 1);
      i = end + 1;
    } else if (ch === "#" && !wasEscaped && (current === "" || /\s$/.test(current))) {
      const lineEnd = text.indexOf(`
`, i);
      i = lineEnd < 0 ? text.length : lineEnd;
    } else if (text.startsWith("<<<", i)) {
      current += "<<<";
      i += 3;
    } else if (ch === "<" && text.startsWith("<<", i)) {
      const match = /^<<(-?)\s*(['"]?)([^\s'"<>;&|()]+)\2/.exec(text.slice(i));
      if (match)
        heredocs.push({ word: match[3], tabs: match[1] === "-" });
      const taken = match ? match[0].length : 2;
      current += text.slice(i, i + taken);
      i += taken;
    } else if (ch === `
`) {
      push();
      i++;
      for (const doc of heredocs.splice(0)) {
        let found = false;
        while (i < text.length) {
          const lineEnd = text.indexOf(`
`, i);
          const body = text.slice(i, lineEnd < 0 ? text.length : lineEnd);
          i = lineEnd < 0 ? text.length : lineEnd + 1;
          if ((doc.tabs ? body.replace(/^\t+/, "") : body) === doc.word) {
            found = true;
            break;
          }
        }
        if (!found)
          state.sure = false;
      }
    } else if (ch === "&" && (text[i + 1] === ">" || /[<>]$/.test(current))) {
      current += ch;
      i++;
    } else if (ch === "|" && /[>]$/.test(current)) {
      current += ch;
      i++;
    } else if (ch === "&" || ch === "|" || ch === ";" || ch === "(" || ch === ")") {
      if (ch === "(")
        depth++;
      else if (ch === ")") {
        if (depth > 0)
          depth--;
        else
          state.sure = false;
      }
      push();
      i += text[i + 1] === ch || ch === "|" && text[i + 1] === "&" ? 2 : 1;
    } else {
      current += ch;
      i++;
    }
  }
  push();
  if (close || heredocs.length || depth)
    state.sure = false;
  return text.length;
}
function arithmeticEnd(text, open) {
  let level = 0;
  let inner = -1;
  for (let j = open;j < text.length; j++) {
    if (text[j] === "(")
      level++;
    else if (text[j] === ")") {
      level--;
      if (level === 1 && inner < 0)
        inner = j;
      if (level === 0)
        return inner === j - 1 ? j : undefined;
    }
  }
  return;
}
function addCommand(raw, out, state) {
  const words = shellWords(raw.trim());
  while (words.length && shellKeywords.has(words[0]))
    words.shift();
  if (words[0] === "function") {
    words.splice(0, 2);
    while (words.length && (shellKeywords.has(words[0]) || words[0].startsWith("()")))
      words.shift();
  }
  if (!words.length || /^(for|case|select)$/.test(words[0]))
    return;
  out.push(words.join(" "));
  const bare = withoutPrefix(words, state, (line) => addLine(line, out, state));
  if (!bare.length)
    return;
  out.push(bare.join(" "));
  const plain2 = bare.map(dequote);
  plain2[0] = plain2[0].split("/").pop() ?? plain2[0];
  const shown = plain2.map((word, index) => /^[\w@%+=:,./-]*$/.test(word) ? word : bare[index]);
  out.push(shown.join(" "));
  if (/[$`]/.test(bare[0]) || bare.some(ansiQuoted))
    state.sure = false;
  const program2 = plain2[0];
  if (program2 === "git") {
    const rest = shown.slice(1);
    while (rest.length) {
      if (rest[0] === "-C" || rest[0] === "-c" || rest[0] === "--git-dir" || rest[0] === "--work-tree" || rest[0] === "--namespace")
        rest.splice(0, 2);
      else if (rest[0].startsWith("-"))
        rest.shift();
      else
        break;
    }
    out.push(["git", ...rest].join(" "));
  } else if (/^(ba|z|da|k|fi|tc|c|a)?sh$/.test(program2) || program2 === "su") {
    const at = plain2.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
    if (at > 0 && plain2[at + 1] !== undefined)
      addLine(plain2[at + 1], out, state);
    else if (plain2.includes("-s") || !operands(plain2.slice(1)).some((word) => !word.startsWith("-") && !word.startsWith("+")))
      state.sure = false;
  } else if (program2 === "eval") {
    addLine(plain2.slice(1).join(" "), out, state);
  } else if (program2 === "xargs") {
    state.sure = false;
    let i = 1;
    while (i < plain2.length && plain2[i].startsWith("-"))
      i += /^-[IinPLsdEaJRS]$/.test(plain2[i]) ? 2 : 1;
    if (i < plain2.length)
      addCommand(plain2.slice(i).map(quoted).join(" "), out, state);
  } else if (program2 === "find") {
    for (let i = 1;i < plain2.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(plain2[i]))
        continue;
      const end = plain2.findIndex((word, index) => index > i && (word === ";" || word === "+"));
      addCommand(plain2.slice(i + 1, end < 0 ? undefined : end).map(quoted).join(" "), out, state);
      if (end < 0)
        state.sure = false;
    }
  }
}
function ansiQuoted(word) {
  let quote = "";
  for (let i = 0;i < word.length; i++) {
    const ch = word[i];
    if (ch === "\\" && quote !== "'")
      i++;
    else if (quote) {
      if (ch === quote)
        quote = "";
    } else if (ch === "'" || ch === '"')
      quote = ch;
    else if (ch === "$" && (word[i + 1] === "'" || word[i + 1] === '"'))
      return true;
  }
  return false;
}
function operands(words) {
  const kept2 = [];
  for (let i = 0;i < words.length; i++) {
    if (/^\d*(<<<|<<-?|>>|<>|<&|>&|&>>|&>|<|>)$/.test(words[i]))
      i++;
    else if (!/^\d*(<<<|<<-?|>>|<>|<&|>&|&>>|&>|<|>)/.test(words[i]))
      kept2.push(words[i]);
  }
  return kept2;
}
function addLine(line, out, state) {
  const inner = parseCommands(line);
  out.push(...inner.commands);
  if (!inner.sure)
    state.sure = false;
}
function quoted(word) {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
var wrappers = {
  env: { short: "uCSP", long: ["--unset", "--chdir", "--split-string"], flags: ["--ignore-environment", "--null", "--debug"] },
  command: { short: "" },
  exec: { short: "a" },
  nohup: { short: "" },
  builtin: { short: "" },
  sudo: {
    short: "ugCDhprtUT",
    long: ["--user", "--group", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout"],
    flags: ["--non-interactive", "--login", "--shell", "--preserve-env", "--background", "--stdin", "--reset-timestamp", "--remove-timestamp", "--set-home", "--bell"]
  },
  doas: { short: "uC" },
  time: { short: "of", long: ["--output", "--format"], flags: ["--portability", "--verbose", "--append"] },
  nice: { short: "n", long: ["--adjustment"] },
  caffeinate: { short: "tw" },
  timeout: { short: "sk", long: ["--signal", "--kill-after"], flags: ["--foreground", "--preserve-status", "--verbose"] },
  setsid: { short: "", flags: ["--ctty", "--fork", "--wait"] },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
  watch: { short: "nq", long: ["--interval", "--equexit"], flags: ["--differences", "--no-title", "--beep", "--errexit", "--chgexit", "--exec", "--precise", "--color"] },
  ionice: { short: "cnp", long: ["--class", "--classdata", "--pid"] },
  chronic: { short: "" }
};
function withoutPrefix(words, state, line) {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    const program2 = dequote(word).split("/").pop() ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      i++;
    else if (/^\d*(>>?|<|&>|>&|<&|&>>)$/.test(word))
      i += 2;
    else if (/^\d*(>>?|<|&>|>&|<&|&>>)\S/.test(word))
      i++;
    else if (program2 === "coproc") {
      if (state)
        state.sure = false;
      i++;
    } else if (Object.hasOwn(wrappers, program2)) {
      const spec = wrappers[program2];
      i++;
      while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
        const option = dequote(words[i]);
        if (option === "--") {
          i++;
          break;
        }
        if (option.startsWith("--")) {
          const at = option.indexOf("=");
          const name = at < 0 ? option : option.slice(0, at);
          const takes = spec.long?.includes(name) ?? false;
          const value = at >= 0 ? option.slice(at + 1) : takes ? dequote(words[i + 1] ?? "") : undefined;
          if (program2 === "env" && name === "--split-string" && value !== undefined)
            line?.(value);
          if (at < 0 && !takes && !spec.flags?.includes(name) && state)
            state.sure = false;
          i += at < 0 && takes ? 2 : 1;
          continue;
        }
        let taken = 1;
        for (let k = 1;k < option.length; k++) {
          if (!spec.short.includes(option[k]))
            continue;
          const rest = option.slice(k + 1);
          if (program2 === "env" && option[k] === "S")
            line?.(rest || dequote(words[i + 1] ?? ""));
          if (!rest)
            taken = 2;
          break;
        }
        i += taken;
      }
      if (program2 === "timeout" && i < words.length)
        i++;
    } else
      break;
  }
  return words.slice(i);
}
function shellWords(text) {
  const words = [];
  let word = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (word)
        words.push(word);
      word = "";
      i++;
    } else if (ch === "\\") {
      word += text.slice(i, i + 2);
      i += 2;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch)
        j += ch !== "'" && text[j] === "\\" ? 2 : 1;
      word += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("$(", i)) {
      let depth = 0;
      let j = i + 1;
      for (;j < text.length; j++) {
        if (text[j] === "(")
          depth++;
        else if (text[j] === ")" && --depth === 0)
          break;
      }
      word += text.slice(i, j + 1);
      i = j + 1;
    } else {
      word += ch;
      i++;
    }
  }
  if (word)
    words.push(word);
  return words;
}
function dequote(word) {
  let out = "";
  let i = 0;
  while (i < word.length) {
    const ch = word[i];
    if (ch === "\\") {
      out += word[i + 1] ?? "";
      i += 2;
    } else if (ch === "'") {
      const end = word.indexOf("'", i + 1);
      out += word.slice(i + 1, end < 0 ? word.length : end);
      i = end < 0 ? word.length : end + 1;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < word.length && word[j] !== '"') {
        if (word[j] === "\\" && /["\\$`]/.test(word[j + 1] ?? "")) {
          out += word[j + 1];
          j += 2;
        } else
          out += word[j++];
      }
      i = j + 1;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
function hidesFromBlocks(blocks, ask) {
  if (!isShell(ask.action) || !blocks?.some((rule) => rule.effect === "deny" && isShell(rule.action)))
    return false;
  return ask.resources.some((line) => !parseCommands(line.trim()).sure);
}
var fileActions = new Set(["read", "edit", "write", "patch", "list", "grep", "glob"]);
function ownPlaces() {
  const places4 = [process.env.KUVO_AGENTS_HOME, process.env.TMPDIR?.replace(/\/$/, ""), join16(homedir5(), ".claude", "plans")].filter((place) => Boolean(place));
  if (process.env.KUVO_AGENTS_HOME && !onMachine)
    places4.push(join16(dirname5(process.env.KUVO_AGENTS_HOME), "Attachments"));
  return [...places4, ...skillFolders()];
}
function outsidePaths(ask, directory, attached, own = ownPlaces()) {
  if (!fileActions.has(ask.action))
    return [];
  const paths = ask.resources.filter((resource) => resource && resource !== "*" && (resource.startsWith("/") || resource.startsWith("~/") || !/[*?[]/.test(resource))).map((resource) => resolve4(directory, resource.startsWith("~/") ? join16(homedir5(), resource.slice(2)) : resource));
  return paths.filter((path) => !within(path, [directory, ...own]) && !attached.has(path));
}
function outsideAsk(ask, paths) {
  return { ...ask, action: "external_directory", resources: paths, save: [...new Set(paths.map((path) => join16(dirname5(path), "*")))], unclassified: false };
}
function partsOf(ask) {
  return isShell(ask.action) ? ask.resources.flatMap(commandParts) : ask.resources;
}
function isShell(action) {
  return action === "shell" || action === "bash";
}
function coveredBy(patterns, action, resources2) {
  return resources2.every((resource) => {
    if (patterns.includes(resource))
      return true;
    if (!isShell(action))
      return patterns.some((pattern) => matches(pattern, resource));
    const { commands, sure } = parseCommands(resource.trim());
    if (!sure)
      return false;
    return (commands.length ? commands : [resource.trim()]).every((command) => patterns.some((pattern) => matches(pattern, command)));
  });
}
var agentActions = new Set(["*", "edit", "write", "patch", "shell", "bash", "read", "webfetch", "websearch", "external_directory"]);
var looks = new Set(["read", "glob", "grep", "list", "websearch", "todowrite", "todoread", "question"]);
function strictest(rules, action, parts) {
  let result;
  for (const part of parts.length ? parts : ["*"]) {
    const effect = ruled(rules, action, [part]);
    if (effect === "deny")
      return "deny";
    if (effect === "ask")
      result = "ask";
    else if (effect === "allow" && !result)
      result = "allow";
  }
  return result;
}
function didWork(message) {
  return message.type === "assistant" && message.content.some((content) => content.type === "tool" || content.type === "text" && content.text.trim() !== "");
}

class Sessions {
  store;
  roster;
  auto;
  engine;
  policies;
  agentInfo;
  snapshots;
  titleModel;
  live = new Map;
  constructor(store, roster, auto, engine, policies, agentInfo, snapshots, titleModel) {
    this.store = store;
    this.roster = roster;
    this.auto = auto;
    this.engine = engine;
    this.policies = policies;
    this.agentInfo = agentInfo;
    this.snapshots = snapshots;
    this.titleModel = titleModel;
    for (const session of store.all())
      this.repair(session.id);
  }
  agent(providerID2) {
    if (!providerID2 || providerID2 === autoProvider)
      return;
    return this.roster.find(providerID2) ?? this.engine?.(providerID2);
  }
  runs(model2) {
    if (model2?.providerID === autoProvider)
      return this.auto.list(model2.id).length > 0;
    return Boolean(this.agent(model2?.providerID));
  }
  state(id) {
    let live = this.live.get(id);
    if (!live) {
      live = { threads: new Map, doing: { kind: "idle" }, go: false, waiting: [], steering: new Map, permissions: new Map, forms: new Map, always: [], subagents: new Map, runs: new Map, blocks: this.policies ? undefined : [], models: new Map, background: new Set };
      this.live.set(id, live);
    }
    return live;
  }
  record(id) {
    const record = this.store.get(id);
    if (!record)
      throw new NotFound(`No session ${id}.`);
    return record;
  }
  atWork(id) {
    const live = this.live.get(id);
    return Boolean(live && isBusy(live.doing));
  }
  async whenFiles(live) {
    while (onFiles(live.doing))
      await new Promise((resolve5) => live.waiting.push(resolve5));
  }
  notes(record) {
    const kept2 = record.agent.snapshots ?? {};
    for (const [id, value] of Object.entries(kept2))
      if (typeof value === "string")
        kept2[id] = { before: value, failed: true };
    record.agent.snapshots = kept2;
    return kept2;
  }
  queue(record) {
    let queue = record.agent.inbox;
    if (!Array.isArray(queue))
      record.agent.inbox = queue = [];
    return queue;
  }
  slots(record) {
    let slots = record.agent.threads;
    if (!slots) {
      slots = {};
      const legacy = Object.fromEntries(legacyKeys.filter((key) => (key in record.agent)).map((key) => [key, record.agent[key]]));
      const provider = record.messages.findLast((message) => message.type === "assistant")?.model.providerID ?? record.session.model?.providerID;
      if (Object.keys(legacy).length && provider && provider !== autoProvider) {
        slots[provider] = { state: legacy, seen: record.messages[record.messages.length - 1]?.id };
      }
      for (const key of legacyKeys)
        delete record.agent[key];
      record.agent.threads = slots;
    }
    return slots;
  }
  repair(id) {
    const record = this.store.get(id);
    if (!record)
      return;
    let changed = false;
    const lastUser = record.messages.findLastIndex((message) => message.type === "user" || message.type === "synthetic");
    for (const message of record.messages) {
      if (message.type === "shell" && message.status === "running") {
        message.status = "failed";
        message.time.completed = message.time.created;
        changed = true;
      }
      if (message.type !== "assistant")
        continue;
      if (!message.time.completed) {
        message.time.completed = message.time.streamed ?? message.time.created;
        changed = true;
      }
      for (const content of message.content) {
        if (content.type !== "tool" || content.state.status !== "running" && content.state.status !== "streaming")
          continue;
        const input = content.state.status === "streaming" ? {} : content.state.input;
        const metadata = content.state.status === "running" ? content.state.metadata : undefined;
        content.state = { status: "error", input, error: { type: "aborted", message: "Stopped." }, content: [], metadata };
        changed = true;
      }
    }
    const lastStep = record.messages.findLastIndex((message) => message.type === "assistant");
    const openStep = record.session.parentID && lastStep > lastUser && !record.messages.slice(lastStep).some((message) => message.type === "idle");
    if (lastUser >= 0 && !record.messages.slice(lastUser).some((message) => message.type === "idle") || openStep) {
      const last2 = record.messages[record.messages.length - 1];
      const at = last2?.time.completed ?? last2?.time.created ?? Date.now();
      record.messages.push({ type: "idle", id: newID("msg"), time: { created: at }, outcome: "interrupted" });
      record.session.outcome = "interrupted";
      record.session.time.idle = at;
      changed = true;
    }
    const open = Object.values(this.notes(record)).filter((note) => note.before && !note.files && !note.failed);
    const stopped = this.store.writtenAt(id);
    if (open.length && this.snapshots && stopped !== undefined && Date.now() - stopped < timing.cutShort)
      this.finishNotes(id);
    else if (open.length) {
      for (const note of open)
        note.failed = true;
      changed = true;
    }
    if (changed)
      this.store.save(id, true);
  }
  async finishNotes(id) {
    const record = this.store.get(id);
    if (!record || !this.snapshots)
      return;
    const open = Object.values(this.notes(record)).filter((note) => note.before && !note.files && !note.failed);
    const directory = record.session.location.directory;
    const live = this.state(id);
    const keeping = { kind: "keeping" };
    live.doing = keeping;
    try {
      const now = await this.snapshots.take(directory);
      if (!now)
        throw new Error("not kept");
      for (const note of open)
        note.files = await this.snapshots.changed(directory, note.before, now);
    } catch {
      for (const note of open)
        if (!note.files)
          note.failed = true;
    } finally {
      if (this.store.get(id))
        this.store.save(id);
      if (live.doing === keeping)
        this.free(id, live);
    }
  }
  create(body) {
    if (body.model?.providerID === autoProvider && !this.auto.list(body.model.id).length)
      throw new BadRequest("That Custom Auto list is empty: add models to it in Settings \u203A Custom Auto.");
    if (!body.model?.id || !this.runs(body.model))
      throw new BadRequest("Pick a model of an agent you've connected.");
    const now = Date.now();
    const directory = body.location.directory;
    const session = {
      id: newID("ses"),
      projectID: "prj_" + createHash4("sha1").update(directory).digest("hex").slice(0, 16),
      agent: typeof body.agent === "string" && body.agent ? body.agent : "build",
      model: body.model,
      cost: 0,
      tokens: noTokens(),
      time: { created: now, updated: now },
      title: body.title,
      location: { directory },
      permissions: body.permissions,
      metadata: { kuvoAgent: this.kind(body.model.providerID) }
    };
    this.store.add(session);
    emit("session.created", { sessionID: session.id, session }, directory);
    return session;
  }
  kind(providerID2) {
    if (providerID2 === autoProvider)
      return autoProvider;
    return this.agent(providerID2)?.id ?? "engine";
  }
  importSession(body) {
    const session = this.create(body);
    const record = this.store.get(session.id);
    const known = new Set(["user", "assistant", "synthetic", "system", "idle", "model-switched", "agent-switched", "shell"]);
    record.messages = (Array.isArray(body.messages) ? body.messages : []).filter((message) => typeof message === "object" && message !== null && known.has(message.type) && typeof message.id === "string");
    this.repair(session.id);
    const queue = this.queue(record);
    for (const item of Array.isArray(body.waiting) ? body.waiting : []) {
      const { id, text, files } = item ?? {};
      if (typeof id !== "string" || typeof text !== "string")
        continue;
      const kept2 = (Array.isArray(files) ? files : []).filter((file) => typeof file?.uri === "string");
      queue.push({ id, text, files: kept2.map((file) => ({ uri: file.uri, ...typeof file.name === "string" ? { name: file.name } : {} })), delivery: "queue" });
    }
    session.title = body.title ?? session.title;
    session.time.updated = Date.now();
    this.store.save(session.id, true);
    emit("session.updated", { sessionID: session.id, session }, session.location.directory);
    return session;
  }
  fork(id, before) {
    const record = this.record(id);
    const at = record.messages.findIndex((message) => message.id === before);
    if (at < 0)
      throw new NotFound("That message isn't in this session.");
    const now = Date.now();
    const source = record.session;
    const session = {
      id: newID("ses"),
      projectID: source.projectID,
      agent: source.agent,
      model: source.model,
      cost: 0,
      tokens: noTokens(),
      time: { created: now, updated: now },
      title: source.title,
      location: { ...source.location },
      permissions: source.permissions,
      metadata: { ...source.metadata }
    };
    this.store.add(session);
    const copy2 = this.store.get(session.id);
    copy2.messages = structuredClone(record.messages.slice(0, at));
    if (record.agent.kuvoInstructions)
      copy2.agent.kuvoInstructions = structuredClone(record.agent.kuvoInstructions);
    if (Array.isArray(record.agent.autoHeld))
      copy2.agent.autoHeld = [...record.agent.autoHeld];
    this.store.save(session.id, true);
    emit("session.created", { sessionID: session.id, session }, session.location.directory);
    return session;
  }
  list(directory, parentID) {
    return this.store.all().filter((session) => !directory || session.location.directory === directory).filter((session) => parentID === undefined || (parentID === null ? !session.parentID : session.parentID === parentID)).sort((a, b) => b.time.updated - a.time.updated || (a.id < b.id ? 1 : -1));
  }
  get(id) {
    return this.record(id).session;
  }
  messages(id) {
    return this.record(id).messages;
  }
  update(id, body) {
    const record = this.record(id);
    const session = record.session;
    const directory = session.location.directory;
    if (body.title !== undefined) {
      session.title = body.title;
      emit("session.renamed", { sessionID: id, title: body.title }, directory);
    }
    if (body.permissions !== undefined)
      session.permissions = body.permissions;
    if (body.metadata !== undefined) {
      session.metadata = { ...body.metadata, kuvoAgent: session.metadata?.kuvoAgent };
      emit("session.metadata.updated", { sessionID: id }, directory);
    }
    session.time.updated = Date.now();
    this.store.save(id, true);
  }
  async remove(id) {
    const record = this.store.get(id);
    if (!record)
      return;
    const live = this.state(id);
    const doing = live.doing;
    if (doing.kind === "deleting")
      return;
    live.doing = { kind: "deleting" };
    live.go = false;
    this.turnAwayOwn(live);
    for (const waiting of live.waiting.splice(0))
      waiting();
    record.agent.inbox = [];
    const run2 = runOf(doing);
    if (run2)
      await this.stop(id, live, run2);
    else
      await this.stopSubagents(id);
    for (const child of this.list(undefined, id))
      if (!this.shownElsewhere(child.id, id))
        await this.remove(child.id);
    for (const thread of live.threads.values())
      thread.close();
    for (const [provider, slot] of Object.entries(this.slots(record)))
      await this.agent(provider)?.forgetConversation?.(slot.state).catch(() => {});
    this.store.remove(id);
    this.live.delete(id);
    emit("session.deleted", { sessionID: id }, record.session.location.directory);
  }
  shownElsewhere(child, except) {
    for (const session of this.store.all()) {
      if (session.id === except || session.id === child)
        continue;
      const record = this.store.get(session.id);
      if (record?.messages.some((message) => message.type === "assistant" && message.content.some((content) => content.type === "tool" && content.state.metadata?.sessionID === child)))
        return true;
    }
    return false;
  }
  view(id, idle) {
    const session = this.record(id).session;
    session.time.viewed = Math.max(idle, session.time.viewed ?? 0);
    this.store.save(id);
  }
  active() {
    const ids = [...this.live.keys()].filter((id) => this.atWork(id));
    for (const live of this.live.values())
      for (const [child, turn] of live.subagents)
        if (!turn.isEnded)
          ids.push(child);
    return ids;
  }
  runShell(id, command) {
    const record = this.record(id);
    if (record.session.parentID)
      throw new BadRequest("This subagent works for the conversation that started it: run it there.");
    const text = command.trim();
    if (!text)
      throw new BadRequest("Type a command after the !.");
    const directory = record.session.location.directory;
    const shellID = newID("shl");
    const event = emit("session.shell.started", { sessionID: id, shell: { id: shellID, command: text, status: "running" } }, directory);
    const message = { type: "shell", id: messageID(event.id), time: { created: event.created }, shellID, command: text, status: "running" };
    record.messages.push(message);
    record.session.time.updated = Date.now();
    if (this.atWork(id))
      record.agent.lateShells = [...record.agent.lateShells ?? [], message.id];
    this.store.save(id, true);
    runCommand(text, directory).then((ran) => {
      message.status = ran.code === 0 && !ran.timedOut ? "completed" : "failed";
      message.exit = ran.code;
      message.output = { output: ran.timedOut ? `${ran.output}
(Stopped: it ran past ${shellTimeout / 60000} minutes.)`.trim() : ran.output, truncated: ran.truncated };
      message.time.completed = Date.now();
      if (!this.store.get(id))
        return;
      this.store.save(id, true);
      emit("session.shell.ended", { sessionID: id, shell: { id: shellID, command: text, status: message.status, exit: ran.code }, output: message.output }, directory);
    });
  }
  async stageRevert(id, messageID2) {
    const record = this.record(id);
    const live = this.state(id);
    if (onFiles(live.doing))
      await this.whenFiles(live);
    this.mustBeIdle(id, live);
    const at = record.messages.findIndex((message) => message.id === messageID2 && message.type === "user");
    if (at < 0)
      throw new NotFound("No such message of yours.");
    const directory = record.session.location.directory;
    const notes = this.notes(record);
    const files = new Set;
    let kept2 = false;
    for (const message of record.messages.slice(at)) {
      const note = notes[message.id];
      if (!note)
        continue;
      kept2 = true;
      if (note.failed || !note.before || !note.files)
        throw new BadRequest("Kuvo Code couldn't keep what the files were around one of these messages, so Undo can't put them back.");
      for (const path of note.files)
        files.add(path);
    }
    const first = notes[messageID2];
    if (kept2 && !first?.before)
      throw new BadRequest("This message went into the turn before it: undo from that one.");
    let diffs2 = [];
    const reverting = { kind: "reverting" };
    if (first?.before && files.size && this.snapshots) {
      live.doing = reverting;
      if (!record.session.revert) {
        delete record.agent.revertNow;
        delete record.agent.revertAt;
        delete record.agent.revertFiles;
      }
      let now;
      const nowAt = Date.now();
      try {
        now = await this.snapshots.take(directory);
        if (!now)
          throw new Error("Kuvo Code couldn't keep the files as they are now.");
        if (!record.agent.revertNow) {
          record.agent.revertNow = now;
          record.agent.revertAt = nowAt;
        }
        record.agent.revertFiles = [...new Set([...record.agent.revertFiles ?? [], ...files])];
        this.store.save(id);
        diffs2 = await this.snapshots.changes(directory, first.before, now, [...files]);
        await this.snapshots.restore(directory, first.before, [...files], first.at);
      } catch (error) {
        if (now)
          await this.snapshots.restore(directory, now, [...files], nowAt).catch(() => {});
        if (!record.session.revert) {
          delete record.agent.revertNow;
          delete record.agent.revertAt;
          delete record.agent.revertFiles;
        }
        this.store.save(id);
        if (live.doing === reverting)
          this.free(id, live);
        throw error;
      }
      if (live.doing !== reverting)
        throw new NotFound(`No session ${id}.`);
    }
    const revert = { messageID: messageID2, files: diffs2 };
    record.session.revert = revert;
    this.store.save(id, true);
    emit("session.revert.staged", { sessionID: id, revert }, directory);
    if (live.doing === reverting)
      this.free(id, live);
    return revert;
  }
  async clearRevert(id) {
    const record = this.record(id);
    if (!record.session.revert)
      return;
    const live = this.state(id);
    if (onFiles(live.doing))
      await this.whenFiles(live);
    this.mustBeIdle(id, live);
    if (!record.session.revert)
      return;
    const directory = record.session.location.directory;
    const now = record.agent.revertNow;
    const files = record.agent.revertFiles ?? [];
    const reverting = { kind: "reverting" };
    if (now && files.length && this.snapshots) {
      live.doing = reverting;
      try {
        await this.snapshots.restore(directory, now, files, record.agent.revertAt);
      } catch (error) {
        if (live.doing === reverting)
          this.free(id, live);
        throw error;
      }
      if (live.doing !== reverting)
        throw new NotFound(`No session ${id}.`);
    }
    delete record.session.revert;
    delete record.agent.revertNow;
    delete record.agent.revertAt;
    delete record.agent.revertFiles;
    this.store.save(id, true);
    emit("session.revert.cleared", { sessionID: id }, directory);
    if (live.doing === reverting)
      this.free(id, live);
  }
  mustBeIdle(id, live) {
    if (live.doing.kind === "deleting")
      throw new NotFound(`No session ${id}.`);
    if (live.doing.kind !== "idle")
      throw new BadRequest("Stop the agent first.");
  }
  commitRevert(id, record, live) {
    const revert = record.session.revert;
    if (!revert)
      return;
    const at = record.messages.findIndex((message) => message.id === revert.messageID);
    if (at >= 0) {
      const gone = record.messages.splice(at);
      const kept2 = this.notes(record);
      for (const message of gone)
        delete kept2[message.id];
    }
    delete record.session.revert;
    delete record.agent.revertNow;
    delete record.agent.revertAt;
    delete record.agent.revertFiles;
    for (const thread of live.threads.values())
      thread.close();
    live.threads.clear();
    for (const [provider, slot] of Object.entries(this.slots(record)))
      this.agent(provider)?.forgetConversation?.(slot.state).catch(() => {});
    record.agent.threads = {};
    this.store.save(id, true);
    emit("session.revert.committed", { sessionID: id, to: revert.messageID }, record.session.location.directory);
  }
  setInstruction(id, key, text) {
    const record = this.record(id);
    const entries = record.agent.kuvoInstructions ?? {};
    if (text === undefined)
      delete entries[key];
    else
      entries[key] = text;
    record.agent.kuvoInstructions = entries;
    this.store.save(id, true);
  }
  selectModel(id, model2) {
    const record = this.record(id);
    const session = record.session;
    const previous = session.model;
    if (!model2?.providerID || !model2.id)
      throw new BadRequest("That isn't a model.");
    if (model2.providerID === autoProvider && !this.auto.list(model2.id).length)
      throw new BadRequest("That Custom Auto list is empty: add models to it in Settings \u203A Custom Auto.");
    if (!this.runs(model2))
      throw new BadRequest("That model's agent isn't connected.");
    if (previous && previous.providerID === model2.providerID && previous.id === model2.id && previous.variant === model2.variant)
      return;
    this.slots(record);
    session.model = model2;
    session.metadata = { ...session.metadata, kuvoAgent: this.kind(model2.providerID) };
    const event = emit("session.model.selected", { sessionID: id, model: model2, previous }, session.location.directory);
    record.messages.push({ type: "model-switched", id: messageID(event.id), time: { created: event.created }, model: model2, previous });
    this.store.save(id, true);
  }
  selectAgent(id, agent) {
    const record = this.record(id);
    const session = record.session;
    const mode = typeof agent === "string" && agent ? agent : "build";
    const previous = session.agent;
    if (previous === mode)
      return;
    session.agent = mode;
    const event = emit("session.agent.selected", { sessionID: id, agent: mode, previous }, session.location.directory);
    record.messages.push({ type: "agent-switched", id: messageID(event.id), time: { created: event.created }, agent: mode, previous });
    this.store.save(id, true);
  }
  inbox(id) {
    return this.queue(this.record(id)).map((input) => ({
      id: input.id,
      sessionID: id,
      type: input.synthetic ? "synthetic" : "user",
      payload: input.synthetic ? { text: input.text, description: input.synthetic.description } : { text: input.text, files: input.files },
      delivery: input.delivery
    }));
  }
  synthetic(id, text, description) {
    const record = this.record(id);
    const input = { id: newID("msg"), text, files: [], delivery: "steer", synthetic: { description } };
    this.queue(record).push(input);
    this.store.save(id, true);
    emit("session.inbox.enqueued", { sessionID: id, inboxID: input.id, item: { type: "synthetic", payload: { text, description }, delivery: "steer" } }, record.session.location.directory);
    this.wake(id);
  }
  prompt(id, input) {
    const record = this.record(id);
    const live = this.state(id);
    if (live.doing.kind === "deleting")
      throw new NotFound(`No session ${id}.`);
    if (record.session.parentID)
      throw new BadRequest("This subagent works for the conversation that started it: write to it there.");
    const queue = this.queue(record);
    if (queue.some((waiting) => waiting.id === input.id) || record.messages.some((message) => message.id === input.id))
      return;
    const doing = live.doing;
    const into = doing.kind === "running" && input.delivery !== "queue" && doing.run.agent?.thread.steer ? doing.run : undefined;
    const nothingRuns = doing.kind === "idle" || onFiles(doing);
    const delivery = into || nothingRuns && (input.delivery !== "queue" || !queue.length) ? "steer" : "queue";
    queue.push({ ...input, delivery });
    this.store.save(id, true);
    emit("session.inbox.enqueued", { sessionID: id, inboxID: input.id, item: { type: "user", payload: { text: input.text, files: input.files }, delivery } }, record.session.location.directory);
    if (into)
      this.steerNow(id, live, into, input);
    else if (delivery === "steer")
      this.wake(id);
  }
  async steerNow(id, live, run2, input) {
    const agent = run2.agent;
    const directory = this.store.get(id)?.session.location.directory;
    if (!agent?.thread.steer || !directory)
      return this.setDelivery(id, input.id, "queue");
    const handing = { cancelled: false };
    live.steering.set(input.id, handing);
    let taken = false;
    let note;
    try {
      if (this.snapshots) {
        try {
          const at2 = Date.now();
          const before = await this.snapshots.take(directory);
          if (before)
            note = { before, at: at2 };
        } catch {
          note = { failed: true };
        }
      }
      const attached = withTextFiles(input.text, input.files.map(promptFile));
      if (live.doing.kind === "running" && live.doing.run === run2 && run2.agent === agent && !handing.cancelled) {
        taken = await agent.thread.steer({ id: input.id, text: attached.text, files: attached.files }).catch(() => false);
      }
    } finally {
      live.steering.delete(input.id);
    }
    const record = this.store.get(id);
    if (!record)
      return;
    const queue = this.queue(record);
    const at = queue.findIndex((waiting) => waiting.id === input.id);
    if (at < 0)
      return;
    const next = !taken && !handing.cancelled && live.doing.kind !== "running" && (live.go || live.doing.kind !== "stopping" && record.session.outcome === "succeeded");
    if (live.doing.kind === "idle" && !live.steering.size)
      live.go = next;
    if (!taken) {
      if (handing.cancelled)
        this.cancelInput(id, input.id);
      else if (next)
        this.advance(id, live);
      else
        this.setDelivery(id, input.id, "queue");
      return;
    }
    queue.splice(at, 1);
    emit("session.inbox.delivered", { sessionID: id, inboxID: input.id }, directory);
    const attachments = input.files.map((file) => ({ mime: mime(file.uri), name: file.name, source: { type: "uri", uri: file.uri } }));
    record.messages.push({ type: "user", id: input.id, time: { created: Date.now() }, text: input.text, files: attachments.length ? attachments : undefined });
    record.session.time.updated = Date.now();
    if (note?.before && runOf(live.doing) === run2) {
      this.notes(record)[input.id] = note;
      run2.steered.push(note);
    }
    this.store.save(id, true);
  }
  setDelivery(id, inputID, delivery) {
    const record = this.record(id);
    const input = this.queue(record).find((waiting) => waiting.id === inputID);
    if (!input)
      throw new NotFound("That message was sent already.");
    if (delivery !== "steer" && delivery !== "queue")
      throw new BadRequest("Steer or queue.");
    if (input.delivery !== delivery) {
      input.delivery = delivery;
      this.store.save(id, true);
      emit("session.inbox.delivery.changed", { sessionID: id, inboxID: inputID, delivery }, record.session.location.directory);
    }
    if (delivery === "steer")
      this.wake(id);
  }
  cancelInput(id, inputID) {
    const handing = this.live.get(id)?.steering.get(inputID);
    if (handing) {
      handing.cancelled = true;
      return;
    }
    const record = this.store.get(id);
    if (!record)
      return;
    const queue = this.queue(record);
    const index = queue.findIndex((input) => input.id === inputID);
    if (index < 0)
      return;
    queue.splice(index, 1);
    this.store.save(id, true);
    emit("session.inbox.cancelled", { sessionID: id, inboxID: inputID }, record.session.location.directory);
  }
  wake(id) {
    if (!this.store.get(id))
      return;
    const live = this.state(id);
    if (live.doing.kind !== "idle" && !onFiles(live.doing))
      return;
    live.go = true;
    this.advance(id, live);
  }
  advance(id, live, ended) {
    const record = this.store.get(id);
    if (live.doing.kind !== "idle" || !record)
      return;
    const own = live.own;
    live.own = undefined;
    if (own) {
      if (record.session.revert)
        live.threads.get(own.adopt.providerID)?.turnAway?.();
      else
        return this.start(id, live, own);
    }
    const queue = this.queue(record);
    const notHanded = (input2) => !live.steering.has(input2.id);
    let index = -1;
    if (ended === "succeeded" || live.go)
      index = queue.findIndex((input2) => input2.delivery === "steer" && notHanded(input2));
    if (ended === "succeeded" && index < 0)
      index = queue.findIndex(notHanded);
    if (index >= 0 || !live.steering.size)
      live.go = false;
    if (index < 0)
      return;
    const [input] = queue.splice(index, 1);
    this.start(id, live, input);
  }
  free(id, live, ended) {
    live.doing = { kind: "idle" };
    this.advance(id, live, ended);
    for (const waiting of live.waiting.splice(0))
      waiting();
    if (live.doing.kind === "idle")
      this.closeWhenIdle(id, live);
  }
  turnAwayOwn(live) {
    const own = live?.own;
    if (!live || !own)
      return false;
    live.own = undefined;
    live.threads.get(own.adopt.providerID)?.turnAway?.();
    return true;
  }
  async generate(id, prompt) {
    const model2 = this.record(id).session.model;
    if (!model2)
      throw new BadRequest("This session has no model yet.");
    const candidates = [];
    if (model2.providerID !== autoProvider)
      candidates.push(model2);
    else {
      const tried = new Set;
      for (let entry = await this.nextEntry(tried, model2.id);entry; entry = await this.nextEntry(tried, model2.id)) {
        tried.add(Auto.modelKey(entry));
        candidates.push({ providerID: entry.providerID, id: entry.modelID, ...entry.variant ? { variant: entry.variant } : {} });
      }
    }
    for (const candidate of candidates) {
      const agent = this.agent(candidate.providerID);
      if (agent?.generate)
        return agent.generate(prompt, candidate);
    }
    throw new BadRequest(`${this.agent(candidates[0]?.providerID)?.name ?? "This session's agent"} can't write this outside the conversation.`);
  }
  async nameSession(id, message) {
    const directory = this.store.get(id)?.session.location.directory;
    const text = ownWords(message);
    if (!directory || !text.trim())
      return;
    const prompt = `Write a title for a conversation that begins with the message below: a few words (six at most) saying what it's about, in the message's language. Reply with the title alone, without quotes or a period at the end.

<message>
${text.slice(0, 4000)}
</message>`;
    const picked = this.titleModel ? await this.titleModel(directory).catch(() => {
      return;
    }) : undefined;
    const engine = picked ? this.engine?.(picked.providerID) : undefined;
    const own = this.store.get(id)?.session.model?.providerID;
    let answer = picked && engine?.generate ? await engine.generate(prompt, picked).catch(() => "") : "";
    if (!answer.trim())
      answer = await this.generate(id, prompt).catch(() => "");
    for (const agent of answer.trim() ? [] : this.roster.all()) {
      if (!agent.generate || agent.providerID === own)
        continue;
      if (!(await agent.account().catch(() => {
        return;
      }))?.signedIn)
        continue;
      answer = await agent.generate(prompt).catch(() => "");
      if (answer.trim())
        break;
    }
    if (!answer.trim())
      return;
    const title = answer.split(`
`).map((line) => line.trim()).find(Boolean)?.replace(/^["'\u201C\u201D\u2018\u2019`*#\s]+|["'\u201C\u201D\u2018\u2019`*\s.]+$/g, "").slice(0, 80);
    const record = this.store.get(id);
    if (!title || !record || record.session.title || this.live.get(id)?.doing.kind === "deleting")
      return;
    this.update(id, { title });
  }
  start(id, live, input) {
    const record = this.store.get(id);
    if (!record || live.doing.kind !== "idle")
      return;
    const session = record.session;
    const run2 = { turn: new Turn(this.store, id, session.location.directory, session.model, session.agent ?? "build"), abort: new AbortController, steered: [] };
    live.doing = { kind: "running", run: run2 };
    clearTimeout(live.idle);
    this.runTurn(id, live, record, run2, input);
  }
  async runTurn(id, live, record, run2, input) {
    const { turn, abort } = run2;
    const session = record.session;
    const directory = session.location.directory;
    const model2 = session.model;
    this.commitRevert(id, record, live);
    emit("session.inbox.delivered", { sessionID: id, inboxID: input.id }, directory);
    const attachments = input.files.map((file) => ({ mime: mime(file.uri), name: file.name, source: { type: "uri", uri: file.uri } }));
    if (input.synthetic)
      record.messages.push({ type: "synthetic", id: input.id, time: { created: Date.now() }, text: input.text, description: input.synthetic.description, metadata: input.synthetic.metadata });
    else
      record.messages.push({ type: "user", id: input.id, time: { created: Date.now() }, text: input.text, files: attachments.length ? attachments : undefined });
    session.time.updated = Date.now();
    this.store.save(id, true);
    if (!input.synthetic && !session.title && !session.parentID && record.messages.filter((message) => message.type === "user").length === 1)
      this.nameSession(id, input.text).catch(() => {});
    let note;
    if ((!input.synthetic || input.adopt) && this.snapshots) {
      try {
        const at = Date.now();
        const before2 = await this.snapshots.take(directory);
        if (before2)
          note = { before: before2, at };
      } catch {
        note = { failed: true };
      }
      if (note) {
        const kept2 = this.notes(record);
        kept2[input.id] = note;
        const ids = Object.keys(kept2).sort();
        for (const old of ids.slice(0, Math.max(0, ids.length - 100)))
          delete kept2[old];
        this.store.save(id);
      }
    }
    const blocks = this.policies ? await this.policies(directory).catch(() => {
      return;
    }) : [];
    if (blocks !== undefined)
      live.blocks = blocks;
    const agentName = session.agent ?? "build";
    const info = this.agentInfo ? await this.agentInfo(agentName, directory).catch(() => {
      return;
    }) : undefined;
    if (info?.permissions)
      live.agentRules = info.permissions;
    else if (live.rulesFor !== agentName)
      live.agentRules = undefined;
    live.rulesFor = agentName;
    const own = session.agent && session.agent !== "build" && session.agent !== "plan" ? session.agent : undefined;
    live.agentPrompt = own ? info?.system : undefined;
    let result;
    let earlier = new Set;
    try {
      const attached = withTextFiles(input.text, input.files.map(promptFile));
      const message = { text: attached.text, files: attached.files, model: model2, plan: session.agent === "plan" };
      earlier = new Set(live.subagents.keys());
      if (model2.providerID !== autoProvider)
        delete record.agent.autoHeld;
      result = input.adopt ? await this.runOn(id, record, live, run2, input.adopt, { ...message, model: input.adopt, adopt: true, auto: model2.providerID === autoProvider || undefined }, input.id) : model2.providerID === autoProvider ? await this.runAuto(id, record, live, run2, { ...message, auto: true }, input.id) : await this.runOn(id, record, live, run2, model2, message, input.id);
    } catch (error) {
      result = { outcome: "failed", error: failure(error) };
    }
    const outcome = abort.signal.aborted ? "interrupted" : result.outcome;
    const before = record.messages[record.messages.length - 1]?.id;
    turn.finish(outcome, outcome === "interrupted" ? undefined : result.error);
    for (const [child, childTurn] of [...live.subagents]) {
      if (outcome === "succeeded" && live.background.has(child) && !childTurn.isEnded)
        continue;
      if (earlier.has(child) && live.background.has(child) && !childTurn.isEnded)
        continue;
      const subagent = live.runs.get(child);
      if (subagent && outcome !== "succeeded" && !childTurn.isEnded)
        subagent.stop?.().catch(() => {});
      if (subagent?.turn === childTurn)
        subagent.end(outcome === "failed" ? "interrupted" : outcome);
      else
        childTurn.finish(outcome === "failed" ? "interrupted" : outcome);
      live.subagents.delete(child);
      live.background.delete(child);
    }
    if (run2.last && run2.last.seen === before)
      run2.last.seen = record.messages[record.messages.length - 1]?.id;
    this.settleAsks(id, live);
    if (runOf(live.doing) !== run2)
      return;
    const turnNotes = [note, ...run2.steered].filter((kept2) => Boolean(kept2?.before));
    if (turnNotes.length && this.snapshots) {
      const keeping = { kind: "keeping" };
      live.doing = keeping;
      try {
        const after = await this.snapshots.take(directory);
        if (!after)
          throw new Error("not kept");
        for (const kept2 of turnNotes)
          kept2.files = await this.snapshots.changed(directory, kept2.before, after);
      } catch {
        for (const kept2 of turnNotes)
          if (!kept2.files)
            kept2.failed = true;
      }
      if (this.store.get(id))
        this.store.save(id);
      if (live.doing !== keeping)
        return;
    }
    this.free(id, live, outcome);
  }
  closeWhenIdle(id, live) {
    clearTimeout(live.idle);
    live.idle = setTimeout(() => {
      if (live.doing.kind !== "idle" || this.live.get(id) !== live)
        return;
      if ([...live.threads.values()].some((thread) => thread.keepsWorking))
        return this.closeWhenIdle(id, live);
      for (const thread of live.threads.values())
        thread.close();
      live.threads.clear();
    }, timing.idleClose);
  }
  ownTurn(id, provider, note) {
    const record = this.store.get(id);
    const live = this.live.get(id);
    const model2 = live?.models.get(provider);
    if (!record || !live || !model2 || record.session.revert || live.own)
      return false;
    const doing = live.doing;
    const now = doing.kind === "idle";
    const later = onFiles(doing) || doing.kind === "running" && doing.run.agent?.provider === provider;
    if (!now && !later)
      return false;
    live.own = { id: newID("msg"), text: note.text, files: [], delivery: "steer", synthetic: { description: note.description, metadata: note.metadata }, adopt: model2 };
    this.advance(id, live);
    return true;
  }
  async runOn(id, record, live, run2, model2, input, userMessage2) {
    const { turn } = run2;
    const signal = run2.abort.signal;
    let reached = false;
    const turnAway = () => {
      if (input.adopt && !reached)
        live.threads.get(model2.providerID)?.turnAway?.();
    };
    const agent = this.agent(model2.providerID);
    if (!agent) {
      turnAway();
      return { outcome: "failed", error: { type: "agent", message: "This model's agent isn't available: sign in to it in Settings \u203A Accounts, or pick another model." } };
    }
    if (!input.adopt && await Promise.race([agent.signedOut?.().catch(() => false), Bun.sleep(1e4).then(() => false)])) {
      turnAway();
      const machine = onMachine ? process.env.KUVO_MACHINE_NAME || "this machine" : undefined;
      const message = machine ? `${agent.name} isn't signed in on ${machine}, where this conversation runs (each machine signs in on its own). Sign in to it there in Settings \u203A Accounts, with ${machine} picked, or pick another model.` : `${agent.name} isn't signed in. Sign in to it in Settings \u203A Accounts, or pick another model.`;
      return { outcome: "failed", error: { type: "provider.auth", message } };
    }
    if (signal.aborted) {
      turnAway();
      return { outcome: "interrupted" };
    }
    const slots = this.slots(record);
    const slot = slots[model2.providerID] ??= { state: {} };
    let thread = live.threads.get(model2.providerID);
    if (!thread) {
      thread = agent.thread(record.session, slot.state);
      const provider = model2.providerID;
      thread.onOwnTurn = (note) => this.ownTurn(id, provider, note);
      live.threads.set(model2.providerID, thread);
    }
    live.models.set(model2.providerID, model2);
    const hooks = this.hooks(id, live, turn, signal, slot, input.plan);
    turn.setModel(model2);
    let abandon;
    const abandoned = new Promise((resolve5) => abandon = () => resolve5({ outcome: "interrupted" }));
    const working = { provider: model2.providerID, thread, abandon };
    run2.agent = working;
    const from = record.messages.length;
    try {
      if (thread.prepare && !input.adopt) {
        const prepared = await Promise.race([thread.prepare({ ...input, model: model2 }, hooks), abandoned.then(() => "abandoned")]);
        if (prepared === "abandoned")
          return { outcome: "interrupted" };
        if (prepared?.fresh)
          slot.seen = undefined;
      }
      if (signal.aborted)
        return { outcome: "interrupted" };
      const at = record.messages.findIndex((message) => message.id === userMessage2);
      const seenAt = slot.seen ? record.messages.findIndex((message) => message.id === slot.seen) : -1;
      const hasMessage = at >= 0 && seenAt >= at;
      const late = new Set(record.agent.lateShells ?? []);
      const before = hasMessage ? [] : record.messages.slice(0, at < 0 ? undefined : at).filter((message, index) => index > seenAt || late.has(message.id));
      const missed = Boolean(input.adopt && (before.length || late.size));
      if (!hasMessage && late.size && !input.adopt)
        delete record.agent.lateShells;
      const partway = at < 0 ? [] : record.messages.slice(Math.max(at, seenAt) + 1);
      const handed = handover(before, partway, (message) => this.stepName(message));
      const text = withHandover(hasMessage ? carryOn : input.text, handed);
      const files = hasMessage ? [] : input.files;
      reached = true;
      const result = await Promise.race([thread.run({ ...input, model: model2, text, files }, turn, hooks), abandoned]);
      if (!missed && (result.outcome !== "failed" || result.taken || record.messages.slice(from).some(didWork)))
        slot.seen = record.messages[record.messages.length - 1]?.id;
      const missedAt = result.missed?.length ? record.messages.findIndex((message) => result.missed.includes(message.id)) : -1;
      if (missedAt >= 0)
        slot.seen = record.messages[missedAt - 1]?.id;
      run2.last = slot;
      return result;
    } catch (error) {
      thread.close();
      if (live.threads.get(model2.providerID) === thread)
        live.threads.delete(model2.providerID);
      throw error;
    } finally {
      turnAway();
      if (run2.agent === working)
        run2.agent = undefined;
      this.store.save(id, true);
    }
  }
  async runAuto(id, record, live, run2, input, userMessage2) {
    const heldBefore = new Set(Array.isArray(record.agent.autoHeld) ? record.agent.autoHeld : []);
    try {
      return await this.runAutoList(id, record, live, run2, input, userMessage2, heldBefore);
    } finally {
      record.agent.autoHeld = this.auto.list(input.model.id).filter((entry) => this.auto.isHeld(entry)).map((entry) => Auto.modelKey(entry));
      this.store.save(id);
    }
  }
  async runAutoList(id, record, live, run2, input, userMessage2, heldBefore) {
    const { turn } = run2;
    const signal = run2.abort.signal;
    const tried = new Set;
    let last2;
    let note;
    let earlier = new Set;
    for (;; ) {
      if (signal.aborted)
        return { outcome: "interrupted" };
      const entry = await this.nextEntry(tried, input.model.id);
      if (signal.aborted)
        return { outcome: "interrupted" };
      if (!entry) {
        if (note)
          turn.notice(note);
        const stopped = await this.whyNone(tried, input.model.id);
        if (stopped)
          return { outcome: "failed", error: stopped };
        if (last2?.limit)
          return { outcome: "failed", error: { type: "limit", message: `Every model in your Custom Auto list is at a usage limit for now${this.nextReset()}.` } };
        return last2 ?? { outcome: "failed", error: { type: "limit", message: `Your Custom Auto list has no model to run. Edit it in Settings \u203A Custom Auto.` } };
      }
      if (!tried.size && heldBefore.has(Auto.modelKey(entry)))
        turn.notice(`Back on ${this.entryName(entry)}: its limit has reset.`);
      tried.add(Auto.modelKey(entry));
      const model2 = { providerID: entry.providerID, id: entry.modelID, ...entry.variant ? { variant: entry.variant } : {} };
      if (note) {
        turn.stopTools("Stopped: going on with another model.");
        for (const [child, childTurn] of [...live.subagents]) {
          if (earlier.has(child))
            continue;
          const subagent = live.runs.get(child);
          if (subagent && !childTurn.isEnded)
            subagent.stop?.().catch(() => {});
          if (subagent?.turn === childTurn)
            subagent.end("interrupted");
          else
            childTurn.finish("interrupted");
          live.subagents.delete(child);
          live.background.delete(child);
        }
        turn.notice(`${note} Going on with ${this.entryName(entry)}.`);
      }
      earlier = new Set(live.subagents.keys());
      const from = record.messages.length;
      try {
        last2 = await this.runOn(id, record, live, run2, model2, input, userMessage2);
      } catch (error) {
        if (signal.aborted)
          throw error;
        last2 = { outcome: "failed", error: failure(error) };
      }
      if (last2.outcome !== "failed" || signal.aborted)
        return last2;
      if (!last2.limit) {
        const agent = this.agent(entry.providerID);
        const account = agent ? await Promise.race([agent.account(true).catch(() => {
          return;
        }), Bun.sleep(1e4).then(() => {
          return;
        })]) : undefined;
        if (account && !account.signedIn)
          emit("integration.updated", { integrationID: entry.providerID });
        const message = last2.error?.message?.trim() || "it stopped with an error";
        note = account && !account.signedIn ? `${this.entryName(entry, true)} needs you to sign in again.` : `${this.entryName(entry)} stopped: ${message.replace(/\.$/, "")}.`;
        continue;
      }
      this.auto.hold(entry, last2.limit);
      emit("kuvo.auto.updated", {});
      const whole = last2.limit.scope === "provider";
      note = `${this.entryName(entry, whole)} reached ${whole ? "its usage limit" : "this model's limit"}${last2.limit.resetsAt ? ` (it resets at ${resetTime(last2.limit.resetsAt)})` : ""}.`;
    }
  }
  async nextEntry(tried, list) {
    for (const entry of this.auto.list(list)) {
      if (tried.has(Auto.modelKey(entry)))
        continue;
      if (!await this.whyNot(entry))
        return entry;
    }
    return;
  }
  async whyNot(entry) {
    const held = this.auto.isHeld(entry);
    if (held)
      return { kind: "held", until: held.until, whole: held.scope === "provider" };
    const agent = this.agent(entry.providerID);
    if (!agent)
      return { kind: "missing" };
    const account = await Promise.race([agent.account().catch(() => {
      return;
    }), Bun.sleep(1e4).then(() => {
      return;
    })]);
    if (account && !account.signedIn)
      return { kind: "signedOut" };
    if (agent.id === "engine") {
      const models = await agent.models().catch(() => []);
      if (models.length && !models.some((model2) => model2.id === entry.modelID))
        return { kind: "missing" };
    }
    return;
  }
  async whyNone(tried, list) {
    const signIn = new Set;
    const held = new Map;
    const gone = [];
    for (const entry of this.auto.list(list)) {
      if (tried.has(Auto.modelKey(entry)))
        continue;
      const why = await this.whyNot(entry);
      if (!why)
        continue;
      if (why.kind === "signedOut")
        signIn.add(this.entryName(entry, true));
      else if (why.kind === "held")
        held.set(this.entryName(entry, why.whole), why.until);
      else
        gone.push(this.entryName(entry));
    }
    if (!signIn.size && !held.size && !gone.length)
      return;
    const machine = onMachine ? process.env.KUVO_MACHINE_NAME || "this machine" : undefined;
    const where = machine ? ` on ${machine}` : "";
    const signInPage = machine ? `Settings \u203A Accounts, with ${machine} picked` : "Settings \u203A Accounts";
    const agents = [...signIn].join(", ").replace(/, ([^,]*)$/, " and $1");
    if (!held.size && !gone.length) {
      const subject = `${tried.size ? "The rest of the agents" : "None of the agents"} in your Custom Auto list ${tried.size ? "aren't" : "is"} signed in`;
      if (!machine)
        return { type: "signin", message: `${subject}. Sign in to ${agents} in ${signInPage}.` };
      return { type: "signin", message: `${subject}${where}, where this conversation runs (each machine signs in on its own: your Mac's sign-ins don't reach it). Sign in to ${agents} there in ${signInPage}.` };
    }
    const limits = [...held].map(([name, until]) => `${name} until ${resetTime(until)}`).join("; ");
    if (!signIn.size && !gone.length && !tried.size)
      return { type: "limit", message: `Every model in your Custom Auto list is at a usage limit for now: ${limits}.` };
    const reasons = [
      ...held.size ? [`at a usage limit: ${limits}`] : [],
      ...signIn.size ? [`not signed in${where}: ${agents} (sign in in ${signInPage})`] : [],
      ...gone.length ? [`not available now: ${gone.join(", ")}`] : []
    ];
    return { type: signIn.size ? "signin" : "limit", message: `No ${tried.size ? "other " : ""}model in your Custom Auto list can run now. ${reasons.map((reason2) => reason2[0].toUpperCase() + reason2.slice(1)).join(". ")}.` };
  }
  nextReset() {
    const known = this.auto.limits().filter((limit) => limit.known).map((limit) => limit.until);
    return known.length ? `; the first resets at ${resetTime(Math.min(...known))}` : "";
  }
  entryName(entry, agentOnly = false) {
    const name = this.agent(entry.providerID)?.name ?? entry.providerID;
    return agentOnly ? name : `${name} (${entry.modelID}${entry.variant ? `, ${entry.variant}` : ""})`;
  }
  stepName(message) {
    const agent = this.agent(message.model.providerID);
    return `${agent?.name ?? message.model.providerID}, ${message.model.id}`;
  }
  async interrupt(id, resume = false) {
    const live = this.live.get(id);
    const turnedAway = this.turnAwayOwn(live);
    const run2 = live && runOf(live.doing);
    if (live && run2) {
      live.doing = { kind: "stopping", run: run2 };
      live.go = resume;
      await this.stop(id, live, run2);
      return true;
    }
    if (resume) {
      this.wake(id);
      return false;
    }
    return await this.stopSubagents(id) || turnedAway;
  }
  async stop(id, live, run2) {
    run2.abort.abort();
    this.settleAsks(id, live);
    const agent = run2.agent;
    setTimeout(() => {
      if (run2.turn.isEnded || !agent || run2.agent !== agent)
        return;
      agent.thread.close();
      if (live.threads.get(agent.provider) === agent.thread)
        live.threads.delete(agent.provider);
      agent.abandon();
    }, timing.stopGrace);
    await agent?.thread.interrupt().catch(() => {});
  }
  settleAsks(id, live) {
    const directory = this.store.get(id)?.session.location.directory;
    for (const [requestID, pending] of live.permissions) {
      if (pending.turn && !pending.turn.isEnded && [...live.subagents.values()].includes(pending.turn))
        continue;
      pending.resolve("reject");
      emit("permission.replied", { sessionID: id, requestID }, directory);
    }
    for (const [requestID, pending] of [...live.permissions])
      if (!pending.turn || pending.turn.isEnded || ![...live.subagents.values()].includes(pending.turn))
        live.permissions.delete(requestID);
    for (const [formID, pending] of live.forms) {
      pending.resolve(null);
      emit("form.cancelled", { id: formID, sessionID: id }, directory);
    }
    live.forms.clear();
  }
  hooks(id, live, turn, signal, slot, plan) {
    const record = this.record(id);
    return {
      signal,
      state: slot.state,
      saveState: () => this.store.save(id, true),
      instructions: (withAgent = true) => [
        ...Object.values(record.agent.kuvoInstructions ?? {}),
        withAgent && live.agentPrompt ? `You work as the "${record.session.agent}" agent here. Its instructions:

${live.agentPrompt}` : ""
      ].filter(Boolean).join(`

`),
      approvesAll: (canAsk = true) => {
        if (plan)
          return false;
        if ((record.session.permissions ?? []).some((rule) => rule.effect === "ask" || rule.effect === "deny"))
          return false;
        const isDefault = (rule) => engineDefaults.some((other) => other.action === rule.action && other.resource === rule.resource && other.effect === rule.effect);
        if ((live.agentRules ?? []).some((rule) => rule.effect !== "allow" && agentActions.has(rule.action) && !isDefault(rule)))
          return false;
        if (live.blocks === undefined)
          return !canAsk;
        return !live.blocks.some((rule) => rule.effect === "deny");
      },
      check: (ask, ownPlan) => this.checkPermission(live, record.session, ask, plan && !ownPlan),
      permission: (ask) => this.askPermission(id, live, turn, ask, plan),
      question: (ask) => this.askQuestion(id, live, turn, ask),
      subagent: (toolCallID, task) => this.startSubagent(id, live, turn, toolCallID, task, plan)
    };
  }
  startSubagent(id, live, parentTurn, toolCallID, task, plan = false) {
    const parent = this.record(id).session;
    const directory = parent.location.directory;
    const now = Date.now();
    const model2 = parentTurn.currentModel;
    const before = task.sessionID ? this.store.get(task.sessionID) : undefined;
    if (before && before.session.parentID === id) {
      if (task.prompt)
        before.messages.push({ type: "user", id: newID("msg"), time: { created: now }, text: task.prompt });
      before.session.time.updated = now;
      this.store.save(before.session.id, true);
      return this.subagentRun(id, live, parentTurn, toolCallID, before.session, task.background ?? false, plan);
    }
    const session = {
      id: newID("ses"),
      parentID: id,
      projectID: parent.projectID,
      agent: task.agent ?? parent.agent,
      model: model2,
      cost: 0,
      tokens: noTokens(),
      time: { created: now, updated: now },
      title: task.title || "A subagent's task",
      location: { directory },
      metadata: { kuvoAgent: parent.metadata?.kuvoAgent, kuvoSubagent: true }
    };
    this.store.add(session);
    const record = this.store.get(session.id);
    if (task.prompt)
      record.messages.push({ type: "user", id: newID("msg"), time: { created: now }, text: task.prompt });
    this.store.save(session.id, true);
    emit("session.created", { sessionID: session.id, session }, directory);
    return this.subagentRun(id, live, parentTurn, toolCallID, session, task.background ?? false, plan);
  }
  subagentRun(id, live, parentTurn, toolCallID, session, background, plan) {
    live.subagents.get(session.id)?.finish("succeeded");
    const turn = new Turn(this.store, session.id, session.location.directory, parentTurn.currentModel, session.agent ?? "build");
    live.subagents.set(session.id, turn);
    if (background)
      live.background.add(session.id);
    else
      live.background.delete(session.id);
    parentTurn.toolProgress(toolCallID, { sessionID: session.id });
    const run2 = {
      sessionID: session.id,
      turn,
      end: (outcome, error) => {
        turn.finish(outcome, error);
        if (live.subagents.get(session.id) === turn) {
          live.subagents.delete(session.id);
          live.background.delete(session.id);
        }
        if (live.runs.get(session.id) === run2)
          live.runs.delete(session.id);
        const directory = this.store.get(id)?.session.location.directory;
        for (const [requestID, pending] of [...live.permissions]) {
          if (pending.turn !== turn)
            continue;
          live.permissions.delete(requestID);
          pending.resolve("reject");
          emit("permission.replied", { sessionID: id, requestID }, directory);
        }
      },
      permission: (ask) => this.askPermission(id, live, turn, ask, plan)
    };
    live.runs.set(session.id, run2);
    return run2;
  }
  async stopSubagents(id) {
    const parent = this.store.get(id)?.session.parentID;
    const runs = parent ? [this.live.get(parent)?.runs.get(id)] : [...this.live.get(id)?.runs.values() ?? []];
    const going = runs.filter((run2) => Boolean(run2 && !run2.turn.isEnded));
    for (const run2 of going) {
      if (!run2.stop) {
        run2.end("interrupted");
        continue;
      }
      setTimeout(() => {
        if (!run2.turn.isEnded)
          run2.end("interrupted");
      }, timing.stopGrace);
      await run2.stop().catch(() => {});
    }
    return going.length > 0;
  }
  checkPermission(live, session, ask, plan) {
    const parts = partsOf(ask);
    if (live.blocks && strictest(live.blocks, ask.action, parts) === "deny")
      return "deny";
    if (plan && changes.has(ask.action))
      return "deny";
    const rules = [...live.agentRules ?? engineDefaults, ...session.permissions ?? []];
    const effect = strictest(rules, ask.action, parts);
    if (effect === "deny")
      return "deny";
    const away = outsidePaths(ask, session.location.directory, this.attached(session.id));
    if (away.length) {
      if (live.blocks && strictest(live.blocks, "external_directory", away) === "deny")
        return "deny";
      const outside = strictest(rules, "external_directory", away);
      if (outside === "deny")
        return "deny";
      if (outside === "ask" && !this.allowedBefore(live, outsideAsk(ask, away)))
        return "ask";
    }
    if (live.blocks === undefined && !looks.has(ask.action))
      return "ask";
    if (hidesFromBlocks(live.blocks, ask))
      return "ask";
    return effect === "ask" && !this.allowedBefore(live, ask) ? "ask" : undefined;
  }
  attached(id) {
    const paths = new Set;
    for (const message of this.store.get(id)?.messages ?? []) {
      if (message.type !== "user")
        continue;
      for (const file of message.files ?? []) {
        const uri = file.source?.type === "uri" ? file.source.uri : undefined;
        if (uri?.startsWith("file:")) {
          try {
            paths.add(fileURLToPath(uri));
          } catch {}
        } else if (uri?.startsWith("/"))
          paths.add(uri);
      }
    }
    return paths;
  }
  allowedBefore(live, ask) {
    return live.always.some((rule) => rule.action === ask.action && coveredBy(rule.patterns, ask.action, ask.resources));
  }
  async askPermission(id, live, turn, ask, plan) {
    const session = this.record(id).session;
    const parts = partsOf(ask);
    if (live.blocks === undefined && this.policies) {
      const blocks = await this.policies(session.location.directory).catch(() => {
        return;
      });
      if (blocks !== undefined)
        live.blocks = blocks;
    }
    const unknown = live.blocks === undefined && !looks.has(ask.action);
    if (live.blocks && strictest(live.blocks, ask.action, parts) === "deny")
      return "reject";
    if (plan && changes.has(ask.action))
      return "reject";
    const away = ask.weighed ? [] : outsidePaths(ask, session.location.directory, this.attached(id));
    if (away.length) {
      if (live.blocks && strictest(live.blocks, "external_directory", away) === "deny")
        return "reject";
      const rules = [...live.agentRules ?? engineDefaults, ...session.permissions ?? []];
      const outside = strictest(rules, "external_directory", away);
      if (outside === "deny")
        return "reject";
      const own = strictest(rules, ask.action, parts) ?? "allow";
      if (outside === "ask" && own !== "deny" && (own === "allow" || this.allowedBefore(live, ask)) && !this.allowedBefore(live, outsideAsk(ask, away))) {
        return this.askPermission(id, live, turn, { ...outsideAsk(ask, away), metadata: ask.metadata, message: ask.message }, plan);
      }
    }
    const matched = ask.weighed ? strictest(session.permissions ?? [], ask.action, parts) : strictest([...live.agentRules ?? engineDefaults, ...session.permissions ?? []], ask.action, parts);
    const effect = ask.weighed ? matched : matched ?? "allow";
    if (effect === "deny")
      return "reject";
    const unclassified = ask.unclassified && matched === undefined && asksFirst(session.permissions) && !this.allowedBefore(live, ask);
    if (!unknown && !unclassified && !hidesFromBlocks(live.blocks, ask) && (effect === "allow" || this.allowedBefore(live, ask)))
      return "once";
    if (turn.isEnded || refusesAsks(live.doing))
      return "reject";
    const request = {
      id: newID("per"),
      sessionID: id,
      action: ask.action,
      resources: ask.resources,
      save: ask.save ?? ask.resources,
      metadata: ask.metadata,
      message: ask.message
    };
    const step = ask.toolCallID ? turn.toolStep(ask.toolCallID) : undefined;
    if (ask.toolCallID && step)
      request.source = { type: "tool", messageID: step, id: ask.toolCallID };
    return new Promise((resolve5) => {
      live.permissions.set(request.id, {
        request,
        turn,
        resolve: (decision) => {
          if (decision === "always")
            live.always.push({ action: ask.action, patterns: request.save ?? ask.resources });
          resolve5(decision);
        }
      });
      emit("permission.asked", request, session.location.directory);
      ask.signal?.addEventListener("abort", () => {
        if (!live.permissions.delete(request.id))
          return;
        resolve5("reject");
        emit("permission.replied", { sessionID: id, requestID: request.id }, session.location.directory);
      });
    });
  }
  permissions(id) {
    this.record(id);
    return [...this.live.get(id)?.permissions.values() ?? []].map((pending) => pending.request);
  }
  replyPermission(id, requestID, decision) {
    const live = this.live.get(id);
    const pending = live?.permissions.get(requestID);
    if (!live || !pending)
      throw new NotFound("That request was answered already.");
    if (!["once", "always", "reject"].includes(decision))
      throw new BadRequest("Answer once, always or reject.");
    const directory = this.record(id).session.location.directory;
    live.permissions.delete(requestID);
    pending.resolve(decision);
    emit("permission.replied", { sessionID: id, requestID }, directory);
    if (decision !== "always")
      return;
    const patterns = pending.request.save ?? pending.request.resources;
    for (const [otherID, other] of [...live.permissions]) {
      const covered = other.request.action === pending.request.action && coveredBy(patterns, other.request.action, other.request.resources);
      if (!covered)
        continue;
      live.permissions.delete(otherID);
      other.resolve("once");
      emit("permission.replied", { sessionID: id, requestID: otherID }, directory);
    }
  }
  askQuestion(id, live, turn, ask) {
    const session = this.record(id).session;
    if (turn.isEnded || refusesAsks(live.doing))
      return Promise.resolve(null);
    const form = { id: newID("frm"), sessionID: id, title: ask.title, metadata: { kind: "question" }, fields: ask.fields };
    return new Promise((resolve5) => {
      live.forms.set(form.id, { form, resolve: resolve5 });
      emit("form.created", { form }, session.location.directory);
      ask.signal?.addEventListener("abort", () => {
        if (!live.forms.delete(form.id))
          return;
        resolve5(null);
        emit("form.cancelled", { id: form.id, sessionID: id }, session.location.directory);
      });
    });
  }
  forms(id) {
    this.record(id);
    return [...this.live.get(id)?.forms.values() ?? []].map((pending) => pending.form);
  }
  replyForm(id, formID, answer) {
    const live = this.live.get(id);
    const pending = live?.forms.get(formID);
    if (!live || !pending)
      throw new NotFound("That question was answered already.");
    live.forms.delete(formID);
    pending.resolve(answer);
    emit(answer ? "form.replied" : "form.cancelled", { id: formID, sessionID: id }, this.record(id).session.location.directory);
  }
  closeAll() {
    for (const [id, live] of this.live) {
      live.go = false;
      live.own = undefined;
      const run2 = runOf(live.doing);
      run2?.abort.abort();
      this.settleAsks(id, live);
      run2?.turn.finish("interrupted");
      for (const child of live.subagents.values())
        child.finish("interrupted");
      live.subagents.clear();
      for (const thread of live.threads.values())
        thread.close();
    }
  }
  forgetProvider(providerID2) {
    for (const live of this.live.values()) {
      const thread = live.threads.get(providerID2);
      if (!thread)
        continue;
      thread.close();
      live.threads.delete(providerID2);
    }
  }
}

class NotFound extends Error {
}

class BadRequest extends Error {
}
function mime(uri) {
  if (uri.startsWith("data:"))
    return uri.slice(5).split(/[;,]/)[0] || "text/plain";
  const extension = uri.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json"
  }[extension] ?? "application/octet-stream";
}
var textFileLimit = 200000;
function withTextFiles(text, files) {
  const others = [];
  const parts = [];
  for (const file of files) {
    let contents;
    if (!file.mime.startsWith("image/") && file.mime !== "application/pdf") {
      try {
        const bytes = file.data ? Buffer.from(file.data, "base64") : file.path && statSync5(file.path).isFile() && statSync5(file.path).size <= textFileLimit ? readFileSync15(file.path) : undefined;
        if (bytes && !bytes.includes(0))
          contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {}
    }
    if (contents === undefined) {
      others.push(file);
      continue;
    }
    parts.push(`<file path="${file.path ?? file.name ?? "pasted"}">
${contents}
</file>`);
  }
  return { text: parts.length ? `${text}

${parts.join(`

`)}` : text, files: others };
}
function promptFile(file) {
  const type = mime(file.uri);
  if (file.uri.startsWith("data:")) {
    const comma = file.uri.indexOf(",");
    const isBase64 = file.uri.slice(0, comma).endsWith(";base64");
    const payload = file.uri.slice(comma + 1);
    return { uri: file.uri, mime: type, name: file.name, data: isBase64 ? payload : Buffer.from(decodeURIComponent(payload)).toString("base64") };
  }
  let path;
  try {
    path = file.uri.startsWith("file:") ? fileURLToPath(file.uri) : undefined;
  } catch {}
  return { uri: file.uri, mime: type, name: file.name, path };
}
function ownWords(message) {
  let text = message.trimEnd();
  for (;; ) {
    const tag = ["attached-files", "review-comments", "named-agents"].find((name) => text.endsWith(`
</${name}>`));
    if (!tag)
      return text;
    const open = text.lastIndexOf(`<${tag}>
`, text.length - tag.length - 4);
    if (open < 0 || open > 0 && text[open - 1] !== `
`)
      return text;
    text = text.slice(0, open).trimEnd();
  }
}

// Agents/src/groups/store.ts
import { existsSync as existsSync11, mkdirSync as mkdirSync13, readdirSync as readdirSync6, readFileSync as readFileSync16, renameSync as renameSync5, rmSync as rmSync10, writeFileSync as writeFileSync11 } from "fs";
import { join as join17 } from "path";

// Agents/src/groups/rules.ts
var stamp2 = (date = new Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
function length(text) {
  let count = 0;
  for (const _ of new Intl.Segmenter().segment(text))
    count++;
  return count;
}
var word = "[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]";
var nonWord = "[^\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]";
var boundary = `(?<=${word})(?!${word})|(?<!${word})(?=${word})`;
function lines2(text) {
  return text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).filter((line) => line.length > 0);
}
var escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
var trimSpaces = (text) => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
var trim = (text) => text.replace(/^[\p{Z}\t\n\v\f\r\u0085]+|[\p{Z}\t\n\v\f\r\u0085]+$/gu, "");
function isPass(text) {
  text = trim(text);
  if (length(text) >= 80)
    return false;
  if (new RegExp(`^${nonWord}*PASS(?:${boundary})`, "u").test(text))
    return true;
  if (!new RegExp(`^${nonWord}*pass(?:${boundary})`, "iu").test(text))
    return false;
  const rest = text.replace(new RegExp(`^${nonWord}*pass${nonWord}*`, "iu"), "");
  return rest.length === 0 || /^(nothing|no (new|more|comment|further)|i('| ha)ve nothing|skip|n\/a)/iu.test(rest);
}
function segments(message) {
  const parts = [];
  let quote;
  let words = [];
  const close = () => {
    const text = trim(words.join(`
`));
    const quoted2 = quote ? trim(quote.join(`
`)) : undefined;
    if ((quoted2 ?? "").length > 0 || text.length > 0)
      parts.push({ quote: quoted2 ? quoted2 : undefined, text });
    quote = undefined;
    words = [];
  };
  let inCode = false;
  let previousBlank = true;
  let quoting = false;
  for (const line of message.split(`
`)) {
    const isQuoteLine = !inCode && (line === ">" || line.startsWith("> "));
    if (line.startsWith("```"))
      inCode = !inCode;
    if (isQuoteLine && (quoting || previousBlank)) {
      if (!quoting)
        close();
      quoting = true;
      quote = [...quote ?? [], line === ">" ? "" : line.slice(2)];
    } else {
      quoting = false;
      words.push(line);
    }
    previousBlank = trimSpaces(line).length === 0;
  }
  close();
  return parts.length === 0 ? [{ text: message }] : parts;
}
var ownWords2 = (message) => segments(message).map((part) => part.text).filter((text) => text.length > 0).join(`

`);
function mentions(text, among) {
  const found = [];
  const folded = fold(text);
  for (const bot of among) {
    const name = fold("&" + bot.name);
    let from = 0;
    for (;; ) {
      const at = folded.indexOf(name, from);
      if (at < 0)
        break;
      const after = folded.slice(at + name.length);
      if (after.length === 0 || !/^[\p{L}\p{N}]/u.test(after)) {
        found.push({ id: bot.id, at });
        break;
      }
      from = at + name.length;
    }
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.id);
}
function fold(text) {
  let out = "";
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    const base = [...segment.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()];
    const first = base[0] ?? segment;
    out += first.length <= segment.length ? first + "\x00".repeat(segment.length - first.length) : segment;
  }
  return out;
}
function nextSpeaker(group, all, members, quiet2, names) {
  const last2 = [...all].reverse().find((message) => message.kind !== "note");
  const missedYou = (bot) => {
    const heard = group.heard[bot];
    const index2 = heard ? all.map((message) => message.id).lastIndexOf(heard) : -1;
    return all.slice(index2 + 1).some((message) => message.author === undefined && message.kind === "message");
  };
  const candidates = members.filter((bot) => (bot !== last2?.author || missedYou(bot)) && !quiet2.has(bot));
  if (candidates.length === 0)
    return;
  if (last2) {
    const named2 = mentions(ownWords2(last2.text), candidates.map((id) => ({ id, name: names.get(id) ?? "" })).filter((bot) => bot.name.length > 0))[0];
    if (named2)
      return named2;
  }
  const author = last2?.author;
  const index = author ? group.members.indexOf(author) : -1;
  if (!author || index < 0)
    return candidates[0];
  const order = [...group.members.slice(index + 1), ...group.members.slice(0, index)];
  return order.find((bot) => candidates.includes(bot));
}
var limit = (members) => Math.min(16, Math.max(4, members * 3));
function label(message, name) {
  if (message.report !== undefined)
    return name(message.author) + " (reporting back on its part of the work)";
  switch (message.kind) {
    case "wrapUp":
      return name(message.author) + " (wrap-up)";
    case "meeting":
      return "Meeting the user scheduled, now";
    default:
      return name(message.author);
  }
}
function turnText(bot, group, unheard, wrapUp, name, named2) {
  let text = "";
  const taken = group.retracted?.[bot];
  if (taken !== undefined) {
    text += `The user took back their message starting "${taken}" and everything said after it. Set all of that aside: it no longer stands.

`;
  }
  if (unheard.length === 0) {
    text += `Nothing new in "${group.name}" since you last spoke.
`;
  } else {
    text += `New in "${group.name}" since you last spoke:
`;
    if (unheard.length > 40)
      text += `
(Earlier messages left out.)
`;
    for (const message of unheard.slice(-40))
      text += `
${label(message, name)}:
${indented(message.text)}
`;
    if (named2)
      text += `
` + named2 + `
`;
  }
  return text + turnEnd(name(bot), wrapUp);
}
function indented(text) {
  return text.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).map((line) => "    " + line).join(`
`);
}
function turnEnd(botName, wrapUp) {
  return wrapUp ? `
Wrap up this discussion now, the one since the user last wrote: in a few short lines, what was decided, what's still open, and who does what next. Write to the user as "you". Don't reply PASS.` : `
Your turn, ${botName}. Reply to the group, or just PASS if you have nothing new to add.`;
}
function chatText(bot, group, all, name, budget2 = chatBudget) {
  const said2 = all.filter((message) => message.kind !== "note");
  if (said2.length === 0)
    return `Nothing has been said in "${group.name}" yet.
`;
  const parts = said2.map((message) => {
    const who = message.author === bot ? "You" + (message.report !== undefined ? " (reporting back on your part of the work)" : message.kind === "wrapUp" ? " (wrap-up)" : "") : label(message, name);
    return `
${who}:
${indented(message.text)}
`;
  });
  const encoder = new TextEncoder;
  let first = parts.length - 1;
  let size = encoder.encode(parts[first]).length;
  while (first > 0) {
    const more = encoder.encode(parts[first - 1]).length;
    if (size + more > budget2)
      break;
    size += more;
    first--;
  }
  const header2 = first === 0 ? `Everything said in "${group.name}" so far, from the start:
` : `What was said in "${group.name}" lately (${first === 1 ? "the 1 earlier message is" : `the ${first} earlier messages are`} left out, too long to give in full):
`;
  return header2 + parts.slice(first).join("");
}
var chatBudget = 160000;
function seatStartText(bot, group, all, wrapUp, name, named2) {
  return chatText(bot, group, all, name) + (named2 ? `
` + named2 + `
` : "") + turnEnd(name(bot), wrapUp);
}
function guestText(bot, group, all, asker, name) {
  return `You're not in "${group.name}", but ${asker !== undefined ? name(asker) : "the user"} named you there with &${name(bot)}, so you answer this once, as a guest.

` + chatText(bot, group, all, name) + `
Your turn, ${name(bot)}. Reply to the group, or just PASS if you have nothing to add.`;
}
function ampersands(text, names) {
  const folded = fold(text);
  const code = codeUnits(text);
  const marks = new Set;
  const word2 = (at) => at >= 0 && at < text.length && /^[\p{L}\p{N}]/u.test(text.slice(at));
  for (const name of names.filter((each) => each.length > 0).sort((a, b) => length(b) - length(a))) {
    const needle = fold("@" + name);
    let from = 0;
    for (;; ) {
      const at = folded.indexOf(needle, from);
      if (at < 0)
        break;
      const end = at + needle.length;
      const after = text[end];
      const startsWord = at === 0 || mentionOpeners.includes(text[at - 1]);
      const endsWord = !word2(end) && !"_/@".includes(after ?? " ") && !(after !== undefined && ".-:".includes(after) && word2(end + 1));
      if (startsWord && endsWord && !code.has(at))
        marks.add(at);
      from = end;
    }
  }
  if (marks.size === 0)
    return text;
  return text.split("").map((unit, index) => marks.has(index) ? "&" : unit).join("");
}
var mentionOpeners = ` 	
\r\xA0([{"'\u201C\u2018\xAB*_~>`;
function codeUnits(text) {
  const code = new Set;
  let fenced = false;
  let offset = 0;
  for (const line of text.split(`
`)) {
    const fence = /^[ \t]*```/.test(line);
    if (fence || fenced) {
      for (let index = 0;index < line.length; index++)
        code.add(offset + index);
    } else {
      let from = 0;
      for (;; ) {
        const open = line.indexOf("`", from);
        if (open < 0)
          break;
        const close = line.indexOf("`", open + 1);
        if (close < 0)
          break;
        for (let index = open;index <= close; index++)
          code.add(offset + index);
        from = close + 1;
      }
    }
    if (fence)
      fenced = !fenced;
    offset += line.length + 1;
  }
  return code;
}
function guests(all, members, bots) {
  const last2 = [...all].reverse().find((message) => message.kind !== "note");
  if (!last2)
    return [];
  return mentions(ownWords2(last2.text), bots.filter((bot) => !members.includes(bot.id) && bot.id !== last2.author));
}
var seatBudget = 30000;
function outgrew(size, chat) {
  return size > seatBudget && size > 2 * Math.floor(new TextEncoder().encode(chat).length / 4);
}
function splitText(names, said2) {
  let text = `For the app, not the chat: list who does what next, from what was decided, one line for each bot with work, as
&Name: what they do, with what they need to know
If a part can only start once others are done, write it as &Name (after &Other): \u2026; it then starts when theirs is done, with what they reported.
Only the bots in this chat (${names.map((name) => "&" + name).join(", ")}), and only work that was agreed on, not what's still open.
Then, on a line of its own, GO or WAIT: GO if the user told you to go ahead and do the work (like "go ahead", "do it", "get going", "do your parts"), WAIT if they only asked for a plan or haven't decided.
If there's no work to hand out, reply just NONE.`;
  if (said2.length > 0) {
    text += `

What the user wrote in this discussion:
` + said2.map((words) => `
> ` + words.replaceAll(`
`, `
> `)).join(`
`);
  }
  return text;
}
function parts(text, names) {
  const found = [];
  const said2 = new Map;
  let go = false;
  const byLength = [...names].sort((a, b) => length(b) - length(a));
  for (const raw of lines2(text)) {
    const line = trimSpaces(raw.replaceAll("**", "").replace(/^[\s>*\u2022\u00B7-]*(\p{Nd}+[.)]\s*)?/u, ""));
    if (new RegExp(`^${nonWord}*GO${nonWord}*$`, "u").test(line)) {
      go = true;
      continue;
    }
    if (new RegExp(`^${nonWord}*WAIT${nonWord}*$`, "u").test(line)) {
      go = false;
      continue;
    }
    for (const name of byLength) {
      const match = new RegExp(`^[@&]?${escape(name)}\\s*(?:\\(\\s*(?:after|once)\\s+([^)]*)\\))?\\s*[:\u2014\u2013\\-]\\s*`, "iu").exec(line);
      if (!match)
        continue;
      const task = trimSpaces(line.slice(match[0].length));
      if (task.length === 0)
        break;
      const waitsFor = match[1] ?? "";
      const after = byLength.filter((other) => other !== name && new RegExp(`(^|[^\\p{L}\\p{N}])[@&]?${escape(other)}($|[^\\p{L}\\p{N}])`, "iu").test(waitsFor));
      const existing = found.find((part) => part.name === name);
      if (existing)
        existing.after.push(...after.filter((other) => !existing.after.includes(other)));
      else
        found.push({ name, task: "", after });
      said2.set(name, [...said2.get(name) ?? [], task]);
      break;
    }
  }
  for (const part of found) {
    const all = said2.get(part.name) ?? [];
    part.task = all.length === 1 ? all[0] : all.map((task) => "- " + task).join(`
`);
  }
  return { parts: found, go };
}
function tasks(text, members, newID2) {
  const { parts: found, go } = parts(text, members.map((bot) => bot.name));
  const ids = new Map;
  for (const bot of members)
    if (!ids.has(bot.name))
      ids.set(bot.name, bot.id);
  const working = new Set(found.map((part) => part.name));
  const list = [];
  for (const part of found) {
    const bot = ids.get(part.name);
    if (!bot)
      continue;
    const after = part.after.filter((name) => working.has(name)).flatMap((name) => ids.has(name) ? [ids.get(name)] : []);
    list.push({ id: newID2(), bot, task: part.task, state: "proposed", ...after.length > 0 ? { after } : {} });
  }
  return { tasks: list, go };
}
function ring(task, all) {
  const seen = new Set;
  const path = (part) => {
    for (const next of all) {
      if (next.state !== "waiting" || next.id === part.id || !(part.after ?? []).includes(next.bot))
        continue;
      if (next.id === task.id)
        return [part];
      if (!seen.has(next.id)) {
        seen.add(next.id);
        const rest = path(next);
        if (rest)
          return [part, ...rest];
      }
    }
    return;
  };
  return path(task);
}
var opening = "[Work from ";
var divider = `

---
`;
function compose(task, chat, wrapUp, from, before = []) {
  let text = opening + chat.name + " \xB7 " + chat.id + `]

` + task.task + divider + `The user agreed to this in the group chat "${chat.name}", and this part is yours. What was decided (${from}):

` + wrapUp.text;
  if (before.length > 0) {
    text += `

The parts before yours are done. What they reported:
` + before.map((part) => `
**${part.name}**: ${part.report}`).join(`
`);
  }
  return text + `

Do your part here, with all your tools, as you would any task from the user. When it's done, end with a few lines on what you did and anything left over. That last message of yours goes to the chat as your report on its own, so don't send it anywhere; the others' parts start from it.`;
}
function plainError(error, provider) {
  if (!/authorization header|unauthori[sz]ed|\b401\b|\b403\b|forbidden|invalid api key/i.test(error))
    return error;
  return `${provider ?? "Its account"} isn\u2019t signed in on this machine: sign in to it again in Settings \u203A Accounts, or choose another model.`;
}
function said2(messages) {
  const found = [];
  let part = "";
  let error;
  const steps = [];
  for (const message of messages) {
    if (message?.type === "user") {
      if (part.length > 0)
        found.push(part);
      part = "";
    } else if (message?.type === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content)
        if (block?.type === "tool")
          steps.push(block);
      const words = trim(content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join(`

`));
      if (words.length > 0)
        part = words;
      error = message.error?.message;
    }
  }
  if (part.length > 0)
    found.push(part);
  const kept2 = found.filter((text) => !isPass(text));
  return { text: (kept2.length === 0 ? found.slice(-1) : kept2).join(`

`), error, steps };
}
function activity(messages, promptID, sent) {
  const at = messages.findIndex((message) => message?.id === promptID);
  const after = at >= 0 ? messages.slice(at + 1) : messages.filter((message) => (message?.time?.created ?? 0) >= sent - 2000);
  const found = [];
  for (const message of after) {
    if (message?.type !== "assistant")
      continue;
    for (const block of message.content ?? []) {
      if (block?.type === "tool") {
        found.push({ kind: "tool", call: bare(block) });
      } else if (block?.type === "reasoning") {
        const line = thought(String(block.text ?? ""));
        if (line)
          found.push({ kind: "thinking", text: line });
      } else if (block?.type === "text" && String(block.text ?? "").trim() && found.at(-1)?.kind !== "writing") {
        found.push({ kind: "writing" });
      }
    }
  }
  return found.slice(-1);
}
function thought(text) {
  const line = text.split(/\r\n|\r|\n/).map((part) => part.replaceAll("**", "").trim()).filter(Boolean).at(-1);
  if (!line)
    return;
  return length(line) > 100 ? sliceCharacters(line, 99) + "\u2026" : line;
}
function bare(call) {
  const state = call.state;
  if (state?.status === "completed")
    return { ...call, state: { ...state, content: [] } };
  if (state?.status === "error") {
    const { content: _, ...rest } = state;
    return { ...call, state: rest };
  }
  return call;
}
function trimmed(call) {
  const cut = (output) => output.map((item) => item?.type === "text" && length(item.text) > 4000 ? { ...item, text: sliceCharacters(item.text, 4000) + "\u2026" } : item);
  const state = call.state;
  if (state?.status === "completed")
    return { ...call, state: { ...state, content: cut(state.content ?? []) } };
  if (state?.status === "error" && state.content)
    return { ...call, state: { ...state, content: cut(state.content) } };
  return call;
}
function sliceCharacters(text, count) {
  let out = "";
  let taken = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    if (taken++ >= count)
      break;
    out += segment;
  }
  return out;
}
function seatInstructions(bot, group, others, lead, personality, identityNote) {
  const who = others.map((other) => other.name + (other.job.length === 0 ? "" : ` (${other.job})`)).join(", ");
  const job = trim(bot.instructions);
  const purpose = group.purpose === undefined || group.purpose === null ? "" : group.purpose.length === 0 ? "" : ` The chat is for: ${group.purpose}`;
  const leads = lead ? lead.id === bot.id ? "You lead it." : `${lead.name} leads it.` : "";
  let text = `You are ${bot.name}, one of the user's bots in Kuvo Code${bot.job.length === 0 ? "" : `: ${bot.job}`}.${personality !== undefined ? ` ${personality}` : ""}${job.length === 0 ? "" : `
Your job:
${job}
`}
` + `Your memory file is "${bot.memoryFile}": read it when what's asked is about your work.
` + `
` + `This conversation is your seat in "${group.name}", a group chat between the user and these bots: ${who.length === 0 ? "just you" : who}, and you. ${leads}${purpose}
` + `
` + `Each message you get here holds what was said in the chat since you last spoke, and means it's your turn. Your reply is posted ` + `to the chat as your message, so write it to the group: a few sentences, plain and to the point, like a colleague in a team ` + `chat. Add something new: build on what others said instead of repeating it, disagree when you do, and ask someone directly ` + `with &Name (an ampersand, never @Name). Write to the user as "you". If you have nothing new to add, reply with just PASS.
` + `
` + `Answer from what's in the chat and what you know; look things up (read and search files, search the web, read another conversation) only when what's asked needs it, and give small talk and quick questions a straight answer. There are no commands, subagents or messages to other agents here. ` + `Don't change files or start the work here: the chat is for talking it through. When something needs doing, say who should ` + `do it. Once the user says go, each of you gets your part in your own conversation, does it there with all your tools, and ` + `reports back here: don't send anyone the work yourself, and don't wait on it in the chat.
` + `
` + identityNote;
  if (lead?.id === bot.id) {
    text += `

You lead this chat. When the user brings something up, you go first: frame it in a line or two and say who should ` + `weigh in on what. Keep it moving and short. When you're asked to wrap up, sum up what was decided, what's still open ` + `and who does what.`;
  }
  return text;
}
function seatRules(folder, askFirst, denies) {
  const rules = [
    "edit",
    "write",
    "patch",
    "question",
    "external_directory",
    "shell",
    "subagent",
    "kuvo-browser_send_message",
    "kuvo-browser_start_session",
    "kuvo-browser_browser_save_pdf",
    "kuvo-browser_browser_upload",
    "kuvo-browser_schedule_wake_up",
    "kuvo-browser_watch_for_change"
  ].map((action) => ({ action, resource: "*", effect: "deny" }));
  if (askFirst)
    rules.push({ action: "webfetch", resource: "*", effect: "deny" });
  rules.push({ action: "external_directory", resource: folder.replace(/\/+$/, "") + "/*", effect: "allow" });
  return [...rules, ...denies];
}
function headingLevel(line) {
  const trimmed2 = trimSpaces(line);
  let marks = 0;
  while (marks < trimmed2.length && trimmed2[marks] === "#")
    marks++;
  if (marks < 1 || marks > 6)
    return;
  const after = trimmed2.slice(marks);
  return after.length === 0 || after[0] === " " ? marks : undefined;
}
function isJobHeading(line) {
  const trimmed2 = trimSpaces(line);
  if (!trimmed2.startsWith("#"))
    return false;
  const title = trimSpaces(trimmed2.replace(/^#+/, "")).toLowerCase();
  if (title === "job" || title === "my job" || title === "the job" || title.startsWith("job:"))
    return true;
  if (!title.startsWith("job "))
    return false;
  const first = trimSpaces(title.slice(4))[0];
  return first !== undefined && "-\u2013\u2014:(".includes(first);
}
function jobInHeading(line) {
  const title = trimSpaces(trimSpaces(line).replace(/^#+/, ""));
  if (!title.toLowerCase().startsWith("job"))
    return;
  let rest = trimSpaces(title.slice(3));
  const mark = rest[0];
  if (mark === undefined || !":-\u2013\u2014(".includes(mark))
    return;
  rest = trimSpaces(rest.slice(1));
  if (mark === "(" && rest.endsWith(")"))
    rest = trimSpaces(rest.slice(0, -1));
  return rest.length === 0 ? undefined : { text: rest, isColon: mark === ":" };
}
function jobInMemory(text) {
  const all = text.split(`
`);
  const start = all.findIndex(isJobHeading);
  if (start < 0)
    return;
  const level = headingLevel(all[start]) ?? 1;
  let end = all.length;
  let inCode = false;
  for (let index = start + 1;index < all.length; index++) {
    const trimmed2 = trimSpaces(all[index]);
    if (trimmed2.startsWith("```") || trimmed2.startsWith("~~~")) {
      inCode = !inCode;
      continue;
    }
    const other = inCode ? undefined : headingLevel(all[index]);
    if (other !== undefined && other <= level) {
      end = index;
      break;
    }
  }
  let section = trim(all.slice(start + 1, end).join(`
`));
  const inline = jobInHeading(all[start]);
  if (inline && (inline.isColon || section.length === 0))
    section = [inline.text, section].filter((part) => part.length > 0).join(`
`);
  let line = section.split(`
`).map(trimSpaces).find((part) => part.length > 0) ?? "";
  for (const mark of ["- ", "* ", "> "])
    if (line.startsWith(mark))
      line = line.slice(mark.length);
  line = line.replaceAll("**", "").replaceAll("__", "");
  if (line.toLowerCase().startsWith("job:"))
    line = line.slice(4);
  line = trimSpaces(line);
  if (length(line) > 48) {
    const stop = line.indexOf(". ");
    if (stop >= 0)
      line = line.slice(0, stop);
  }
  if (line.endsWith(".") && !line.endsWith(".."))
    line = line.slice(0, -1);
  return { line, section };
}

// Agents/src/groups/store.ts
var version2 = 1;
var strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
var stringMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string");
var isDate = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
function isGroup(value, id) {
  if (!value || value.id !== id || typeof value.name !== "string" || !strings(value.members) || !isDate(value.created))
    return false;
  if (!stringMap(value.seats) || !stringMap(value.heard))
    return false;
  if (value.purpose !== undefined && value.purpose !== null && typeof value.purpose !== "string")
    return false;
  if (value.agentSeats !== undefined && !strings(value.agentSeats))
    return false;
  if (value.retracted !== undefined && value.retracted !== null && !stringMap(value.retracted))
    return false;
  if (value.viewed !== undefined && !isDate(value.viewed))
    return false;
  return value.meeting === undefined || value.meeting === null || isMeeting(value.meeting);
}
function isMeeting(value) {
  if (!value || !isDate(value.next) || typeof value.topic !== "string")
    return false;
  if (value.every !== undefined && value.every !== null && typeof value.every !== "string")
    return false;
  if (value.at !== undefined && value.at !== null && typeof value.at !== "number")
    return false;
  return value.weekday === undefined || value.weekday === null || typeof value.weekday === "number";
}
var kinds2 = new Set(["message", "wrapUp", "note", "meeting"]);
var states = new Set(["proposed", "waiting", "working", "done", "failed"]);
function isMessages(value) {
  return Array.isArray(value) && value.every((message) => message && typeof message.id === "string" && typeof message.text === "string" && isDate(message.time) && kinds2.has(message.kind) && (message.author === undefined || message.author === null || typeof message.author === "string") && (message.tasks === undefined || Array.isArray(message.tasks) && message.tasks.every((task) => task && typeof task.id === "string" && typeof task.bot === "string" && typeof task.task === "string" && states.has(task.state))));
}
var read = (file) => {
  try {
    return JSON.parse(readFileSync16(file, "utf8"));
  } catch {
    return;
  }
};
var text = (file) => {
  try {
    return readFileSync16(file, "utf8");
  } catch {
    return;
  }
};
function write(file, value) {
  writeFileSync11(file + ".new", JSON.stringify(value, null, 2), { mode: 384 });
  renameSync5(file + ".new", file);
}

class GroupStore {
  root;
  bots;
  constructor(root, bots) {
    this.root = root;
    this.bots = bots;
    mkdirSync13(root, { recursive: true, mode: 448 });
  }
  folder(id) {
    return join17(this.root, id);
  }
  load() {
    const all = new Map;
    let names = [];
    try {
      names = readdirSync6(this.root);
    } catch {}
    for (const id of names) {
      if (!/^grp_[a-z0-9]+$/.test(id))
        continue;
      const kept2 = this.read(id);
      if (kept2)
        all.set(id, kept2);
    }
    return all;
  }
  read(id) {
    const record = read(join17(this.folder(id), "group.json"));
    if (!record || typeof record.kuvo !== "number" || record.kuvo > version2 || !isGroup(record.group, id))
      return;
    const messages = read(join17(this.folder(id), "messages.json")) ?? [];
    if (!isMessages(messages))
      return;
    return { group: record.group, status: record.status === "held" ? "held" : "active", talking: record.talking === true, messages };
  }
  saveGroup(kept2) {
    mkdirSync13(this.folder(kept2.group.id), { recursive: true, mode: 448 });
    write(join17(this.folder(kept2.group.id), "group.json"), { kuvo: version2, status: kept2.status, ...kept2.talking ? { talking: true } : {}, group: kept2.group });
  }
  saveMessages(kept2) {
    mkdirSync13(this.folder(kept2.group.id), { recursive: true, mode: 448 });
    write(join17(this.folder(kept2.group.id), "messages.json"), kept2.messages);
  }
  setAwake(id, awake) {
    const file = join17(this.folder(id), "awake");
    if (awake && !existsSync11(file) && existsSync11(this.folder(id)))
      writeFileSync11(file, "");
    if (!awake)
      rmSync10(file, { force: true });
  }
  trash(id, trash) {
    if (!existsSync11(this.folder(id)))
      return;
    const into = join17(trash, `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-group-${id}`);
    mkdirSync13(into, { recursive: true, mode: 448 });
    renameSync5(this.folder(id), join17(into, id));
  }
  settings() {
    const value = read(join17(this.root, "settings.json"));
    if (!value || typeof value !== "object")
      return;
    return {
      personalities: value.personalities && typeof value.personalities === "object" ? value.personalities : {},
      identityNote: typeof value.identityNote === "string" ? value.identityNote : "",
      askFirst: value.askFirst === true,
      denies: Array.isArray(value.denies) ? value.denies.filter((rule) => rule?.effect === "deny" && typeof rule.action === "string") : [],
      timeZone: typeof value.timeZone === "string" ? value.timeZone : undefined,
      locale: typeof value.locale === "string" ? value.locale : undefined
    };
  }
  writeSettings(settings) {
    write(join17(this.root, "settings.json"), { kuvo: version2, ...settings });
  }
  allBots() {
    let names = [];
    try {
      names = readdirSync6(this.bots);
    } catch {}
    return names.flatMap((name) => this.bot(name) ?? []);
  }
  bot(id) {
    if (!/^bot_[A-Za-z0-9]+$/.test(id))
      return;
    const folder = join17(this.bots, id);
    const described = read(join17(folder, "bot.json"));
    const sessionID = text(join17(folder, "session"))?.trim();
    if (!described?.name || !sessionID)
      return;
    const memory = text(join17(folder, "MEMORY.md"));
    const job = memory ? jobInMemory(memory) : undefined;
    const directory = text(join17(folder, "directory"))?.trim() || join17(folder, "workspace");
    return {
      id,
      name: String(described.name),
      job: job?.line ?? String(described.job ?? ""),
      instructions: job?.section ?? "",
      memoryFile: join17(folder, "MEMORY.md"),
      folder,
      sessionID,
      directory,
      model: described.model?.id && described.model?.providerID ? described.model : undefined,
      personality: typeof described.personality === "string" ? described.personality : undefined,
      agents: text(join17(folder, "via"))?.trim() === "bridge"
    };
  }
  writeFile(path, contents) {
    mkdirSync13(join17(path, ".."), { recursive: true });
    writeFileSync11(path + ".new", contents, { mode: 384 });
    renameSync5(path + ".new", path);
  }
  removeFile(path) {
    rmSync10(path, { force: true });
  }
}

// Agents/src/groups/time.ts
function parseRepeat(text2) {
  if (text2 === "weekdays")
    return { kind: "weekdays" };
  const unit = text2.slice(-1);
  const digits = text2.slice(0, -1);
  if (!/^[1-9][0-9]*$/.test(digits) || text2.length > 7)
    return;
  const count = Number(digits);
  if (unit === "m" && count >= 5 && count <= 525600)
    return { kind: "minutes", count };
  if (unit === "h" && count <= 8760)
    return { kind: "hours", count };
  if (unit === "d" && count <= 366)
    return { kind: "days", count };
  if (unit === "w" && count <= 52)
    return { kind: "weeks", count };
  return;
}
var keepsTimeOfDay = (every) => every.kind === "days" || every.kind === "weeks" || every.kind === "weekdays";
var keepsWeekday = (every) => every.kind === "weeks";
var formats = new Map;
var weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function local(time, zone2) {
  let format = formats.get(zone2);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone2,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short"
    });
    formats.set(zone2, format);
  }
  const parts2 = {};
  for (const part of format.formatToParts(new Date(time)))
    parts2[part.type] = part.value;
  return {
    year: Number(parts2.year),
    month: Number(parts2.month),
    day: Number(parts2.day),
    hour: Number(parts2.hour) % 24,
    minute: Number(parts2.minute),
    weekday: weekdays.indexOf(parts2.weekday) + 1
  };
}
function offset(time, zone2) {
  const at = local(time, zone2);
  const wall = Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute);
  return wall - Math.floor(time / 60000) * 60000;
}
function moment(year, month, day, hour, minute, zone2) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = wall - offset(wall - 86400000, zone2);
  const after = wall - offset(wall + 86400000, zone2);
  const reads = (time) => {
    const at = local(time, zone2);
    return Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute) === wall;
  };
  const fits = [before, after].filter(reads);
  if (fits.length > 0)
    return Math.min(...fits);
  return before;
}
function plusDays(date, days) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}
var daysBetween = (from, to) => Math.round((Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86400000);
function minutesOf(time, zone2) {
  const at = local(time, zone2);
  return at.hour * 60 + at.minute;
}
function isWeekend(time, zone2) {
  const day = local(time, zone2).weekday;
  return day === 1 || day === 7;
}
function next(every, due, now, zone2, at, weekday) {
  if (every.kind === "minutes" || every.kind === "hours") {
    const period = every.count * (every.kind === "hours" ? 3600000 : 60000);
    return due + (Math.floor((now - due) / period) + 1) * period;
  }
  const days = every.kind === "days" ? every.count : every.kind === "weeks" ? every.count * 7 : 1;
  const minutes = at ?? minutesOf(due, zone2);
  let first = local(due, zone2);
  if (keepsWeekday(every) && weekday !== undefined) {
    const shift = (weekday - local(due, zone2).weekday + 7) % 7;
    first = plusDays(first, shift > 3 ? shift - 7 : shift);
  }
  const missed = daysBetween(first, local(now, zone2));
  let periods = Math.max(1, Math.trunc(missed / days));
  for (let tries = 0;tries < 400; tries++, periods++) {
    const day = plusDays(first, periods * days);
    const time = moment(day.year, day.month, day.day, Math.floor(minutes / 60), minutes % 60, zone2);
    if (time > now && (every.kind !== "weekdays" || !isWeekend(time, zone2)))
      return time;
  }
  return now + days * 86400000;
}
function weekdayOf(time, zone2) {
  return local(time, zone2).weekday;
}
var defaultTopic = "Our regular meeting: where things stand, and what's next.";
function planMeeting(plan, before, zone2, now = Date.now()) {
  if (typeof plan?.next !== "number" || !Number.isFinite(plan.next))
    return "That isn't a meeting.";
  const every = plan.every ?? undefined;
  const repeat = every === undefined ? undefined : parseRepeat(String(every));
  if (every !== undefined && !repeat)
    return `\u201C${every}\u201D isn't how often a meeting can come back.`;
  const time = Math.floor(plan.next / 60) * 60000;
  const kept2 = before && Date.parse(before.next) === time && (before.every ?? undefined) === every ? before : undefined;
  const at = repeat && keepsTimeOfDay(repeat) ? kept2?.at ?? minutesOf(time, zone2) : undefined;
  const weekday = repeat && keepsWeekday(repeat) ? kept2?.weekday ?? weekdayOf(time, zone2) : undefined;
  let when = time;
  if (when <= now && repeat)
    when = next(repeat, when, now, zone2, at, weekday);
  for (let tries = 0;repeat?.kind === "weekdays" && isWeekend(when, zone2) && tries < 7; tries++) {
    const day = plusDays(local(when, zone2), 1);
    const clock = local(when, zone2);
    when = moment(day.year, day.month, day.day, clock.hour, clock.minute, zone2);
  }
  if (when <= now)
    return "That time has passed. Pick one to come.";
  const topic = String(plan.topic ?? "").trim() || defaultTopic;
  return {
    next: new Date(when).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...every !== undefined ? { every } : {},
    topic,
    ...at !== undefined ? { at } : {},
    ...weekday !== undefined ? { weekday } : {}
  };
}

// Agents/src/groups/routes.ts
var json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
var error = (status, message) => json({ message }, status);
async function groupRoutes(runner, store, method, parts2, body) {
  if (!runner || !store)
    return error(404, "Group chats run on the Mac here.");
  const [id, action] = parts2;
  if (!id) {
    if (method === "GET")
      return json({ version: version2, data: runner.list() });
    return error(405, "Not allowed");
  }
  if (id === "settings" && method === "PUT") {
    const value = await body();
    const before = store.settings();
    store.writeSettings({
      personalities: value?.personalities && typeof value.personalities === "object" ? value.personalities : {},
      identityNote: typeof value?.identityNote === "string" ? value.identityNote : "",
      askFirst: value?.askFirst === true,
      denies: Array.isArray(value?.denies) ? value.denies : [],
      timeZone: typeof value?.timeZone === "string" ? value.timeZone : undefined,
      locale: typeof value?.locale === "string" ? value.locale : undefined
    });
    const after = store.settings();
    if (JSON.stringify([before?.askFirst, before?.denies]) !== JSON.stringify([after?.askFirst, after?.denies]))
      runner.rulesChanged();
    return json({});
  }
  if (!/^grp_[a-z0-9]+$/.test(id))
    return error(404, "No such chat.");
  if (!action) {
    if (method === "GET") {
      const chat = runner.get(id);
      return chat ? json({ version: version2, data: chat }) : error(404, "No such chat.");
    }
    if (method === "PUT") {
      const { group, messages, status, replace } = await body();
      if (!isGroup(group, id) || !isMessages(messages ?? []))
        return error(400, "That isn't a group chat.");
      if (!runner.put(group, messages ?? [], status === "active" ? "active" : "held", replace === true))
        return error(409, "That chat is here already.");
      return json({ data: runner.get(id) });
    }
    if (method === "PATCH") {
      const edits2 = await body();
      if (edits2 && "meetingPlan" in edits2) {
        if (edits2.meetingPlan === null) {
          edits2.meeting = null;
        } else {
          const planned = planMeeting(edits2.meetingPlan, runner.get(id)?.group.meeting, store.settings()?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
          if (typeof planned === "string")
            return error(400, planned);
          edits2.meeting = planned;
        }
        delete edits2.meetingPlan;
      }
      if (runner.get(id)?.status === "held" && Object.keys(edits2 ?? {}).some((key) => key !== "viewed"))
        return error(409, "That chat is moving.");
      if (edits2?.meeting !== undefined && edits2.meeting !== null && !isMeeting(edits2.meeting))
        return error(400, "That isn't a meeting.");
      if (edits2?.members !== undefined && !(Array.isArray(edits2.members) && edits2.members.every((member) => typeof member === "string")))
        return error(400, "Those aren't bots.");
      return await runner.update(id, edits2 ?? {}) ? json({ data: runner.get(id) }) : error(404, "No such chat.");
    }
    if (method === "DELETE")
      return await runner.delete(id) ? json({}) : error(404, "No such chat.");
    return error(405, "Not allowed");
  }
  if (method !== "POST")
    return error(405, "Not allowed");
  const found = runner.get(id);
  if (!found)
    return error(404, "No such chat.");
  switch (action) {
    case "activate":
      runner.activate(id);
      return json({ data: runner.get(id) });
    case "hold":
      return json({ data: runner.hold(id) });
    case "release":
      runner.release(id);
      return json({});
  }
  if (found.status !== "active")
    return error(409, "That chat is moving.");
  switch (action) {
    case "send": {
      const { text: text2, named: named2 } = await body();
      const message = typeof text2 === "string" ? runner.send(id, text2, typeof named2 === "string" ? named2 : undefined) : undefined;
      return message ? json({ data: message }) : error(400, "Nothing to send.");
    }
    case "stop":
      runner.stop(id);
      return json({});
    case "keep-going":
      runner.keepGoing(id);
      return json({});
    case "undo": {
      const { message } = await body();
      const text2 = typeof message === "string" ? runner.undo(id, message) : undefined;
      return text2 === undefined ? error(404, "No such message.") : json({ data: { text: text2 } });
    }
    case "start-work": {
      const { wrapUp } = await body();
      if (typeof wrapUp === "string")
        runner.startWork(wrapUp, id);
      return json({});
    }
  }
  return error(404, "Not found");
}

// Agents/src/server.ts
var attempts = new Map;
function cancelSignIns() {
  for (const pending of attempts.values())
    pending.attempt.cancel();
  attempts.clear();
}
setInterval(() => {
  for (const [id, pending] of attempts) {
    if (Date.now() < pending.expires + 60000)
      continue;
    pending.attempt.cancel();
    attempts.delete(id);
  }
}, 60000).unref?.();
var json2 = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
var located = (value) => json2({ location: { directory: process.cwd() }, data: value });
var error2 = (status, message) => json2({ message }, status);
var lastSeen = new Map;
var lastMaintained = new Map;
async function maintainedSoon(agent, fresh) {
  if (!agent.maintenance)
    return;
  let answered = false;
  const asked = agent.maintenance(fresh).then((value2) => {
    const changed = JSON.stringify(lastMaintained.get(agent.providerID)) !== JSON.stringify(value2);
    lastMaintained.set(agent.providerID, value2);
    if (answered && changed)
      emit("integration.updated", { integrationID: agent.providerID });
    return value2;
  }, () => lastMaintained.get(agent.providerID));
  const value = await Promise.race([asked, Bun.sleep(2000).then(() => lastMaintained.get(agent.providerID))]);
  answered = true;
  return value;
}
async function integration(agent, fresh = false, auto) {
  const [account, maintained] = await Promise.all([
    agent.account(fresh).catch((error3) => ({ installed: false, signedIn: false, message: String(error3?.message ?? error3) })),
    maintainedSoon(agent, fresh)
  ]);
  const seen = JSON.stringify([account.installed, account.signedIn, account.label]);
  const before = lastSeen.get(agent.providerID);
  lastSeen.set(agent.providerID, seen);
  if (before !== undefined && before !== seen) {
    agent.forgetModels?.();
    emit("integration.updated", { integrationID: agent.providerID });
    if (account.signedIn && auto?.release(agent.providerID))
      emit("kuvo.auto.updated", {});
  }
  return {
    id: agent.providerID,
    name: agent.name,
    metadata: {
      source: "agent",
      agent: agent.id,
      accountID: agent.instance.id,
      accountLabel: agent.instance.label,
      installed: account.installed,
      message: account.message,
      signInEnded: account.ended ?? false,
      account: account.label,
      install: agent.install,
      signsOut: Boolean(agent.signOut),
      version: maintained?.installed,
      latestVersion: maintained?.latest,
      outdated: maintained ? isOutdated(maintained) : false,
      updateCommand: maintained?.shown,
      updates: Boolean(agent.update && maintained?.command),
      remoteSignIn: Boolean(agent.signIn && agent.signsInRemotely)
    },
    methods: agent.methods(),
    connections: account.signedIn ? [{ type: "agent", label: account.label, method: "oauth", status: { status: "connected", message: account.label ? `Signed in as ${account.label}` : "Signed in" } }] : []
  };
}
async function models(agents) {
  const lists = await Promise.all(agents.map(async (agent) => {
    try {
      const account = await agent.account();
      return account.signedIn ? await agent.models() : [];
    } catch {
      return [];
    }
  }));
  return lists.flat();
}
function page(items2, url) {
  const limit2 = Number(url.searchParams.get("limit") ?? 100) || 100;
  const cursor = url.searchParams.get("cursor");
  let start = 0;
  if (cursor) {
    const after = cursor.split(":")[1];
    const index = items2.findIndex((item) => item.id === after);
    start = index >= 0 ? index + 1 : items2.length;
  }
  const data = items2.slice(start, start + limit2);
  const order = cursor?.split(":", 1)[0] ?? url.searchParams.get("order") ?? "desc";
  const filter = url.searchParams.get("parentID") ?? cursor?.split(":")[2];
  const next2 = start + limit2 < items2.length && data.length ? `${order}:${data[data.length - 1].id}${filter ? `:${filter}` : ""}` : undefined;
  return { data, cursor: { next: next2 } };
}
function handler(context) {
  const expected = "Basic " + Buffer.from(`opencode:${context.password}`).toString("base64");
  const { sessions, roster, auto, link: link2 } = context;
  const agentFor = (id) => roster.find(id);
  return async (request) => {
    if (request.headers.get("authorization") !== expected)
      return error2(401, "Unauthorized");
    const url = new URL(request.url);
    const parts2 = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method;
    const body = async () => request.headers.get("content-type")?.includes("json") ? await request.json().catch(() => ({})) : {};
    try {
      if (parts2[0] !== "api")
        return error2(404, "Not found");
      const [, area, a, b, c, d, e] = parts2;
      if (area === "info")
        return json2({ version: context.version, pid: process.pid });
      if (area === "event")
        return feed();
      if (area === "integration") {
        if (!a) {
          const fresh = url.searchParams.get("fresh") === "1";
          if (fresh)
            await refreshLoginPath();
          return located(await Promise.all(roster.all().map((agent2) => integration(agent2, fresh, auto))));
        }
        const agent = agentFor(a);
        if (!agent)
          return error2(404, `No agent ${a}.`);
        if (!b)
          return located(await integration(agent, true, auto));
        if (b === "connect" && c === "oauth") {
          if (!d && method === "POST") {
            const { methodID, remote } = await body();
            if (!agent.signIn)
              return error2(400, `${agent.name} signs in another way.`);
            if (remote === true && !agent.signsInRemotely)
              return error2(400, `Sign in to ${agent.name} on the computer it runs on: its page comes back there.`);
            const attempt = await agent.signIn(methodID, { remote: remote === true });
            const id = newID("att");
            const created = Date.now();
            const expires = created + 30 * 60000;
            attempts.set(id, { agent, attempt, created, expires });
            return located({ attemptID: id, url: attempt.url, instructions: attempt.instructions, mode: attempt.mode, acceptsCode: attempt.acceptsCode || undefined, userCode: attempt.userCode, time: { created, expires } });
          }
          const pending = d ? attempts.get(d) : undefined;
          if (!pending)
            return error2(404, "That sign-in is over. Start it again.");
          if (method === "GET" && !e) {
            const expired = Date.now() > pending.expires;
            const status = expired ? { status: "expired" } : pending.attempt.status();
            if (expired)
              pending.attempt.cancel();
            if (status.status !== "pending")
              attempts.delete(d);
            return located(status);
          }
          if (method === "POST" && e === "complete") {
            const { code } = await body();
            if (!pending.attempt.complete)
              return error2(400, "This sign-in finishes in the browser.");
            await pending.attempt.complete(String(code ?? ""));
            return json2({});
          }
          if (method === "DELETE") {
            pending.attempt.cancel();
            attempts.delete(d);
            return json2({});
          }
        }
        if (b === "connect" && c === "key" && method === "POST") {
          const { key } = await body();
          if (!agent.signInWithKey)
            return error2(400, `${agent.name} doesn't take a key here.`);
          await agent.signInWithKey(String(key ?? "").trim());
          return json2({});
        }
        if (b === "update" && method === "POST") {
          if (!agent.update)
            return error2(400, `Update ${agent.name} the way you installed it.`);
          const result = await agent.update();
          if (result.updated) {
            for (const each of roster.all())
              if (each.id === agent.id)
                each.programUpdated?.();
            emit("integration.updated", { integrationID: agent.providerID });
            emit("model.updated", {});
          }
          return json2({ data: result });
        }
        if (b === "install" && method === "POST") {
          if (!agent.installProgram)
            return error2(400, `Install ${agent.name} the way its maker says.`);
          const result = await agent.installProgram();
          if (result.installed) {
            for (const each of roster.all())
              if (each.id === agent.id)
                each.programUpdated?.();
            emit("integration.updated", { integrationID: agent.providerID });
            emit("model.updated", {});
          }
          return json2({ data: result });
        }
        if (b === "disconnect" && method === "POST") {
          if (!agent.signOut)
            return error2(400, `Sign out of ${agent.name} where you signed in.`);
          await agent.signOut();
          return json2({});
        }
      }
      if (area === "model") {
        if (a === "default")
          return located(null);
        return located(await models(roster.all()));
      }
      if (area === "agent" || area === "command" || area === "skill" || area === "mcp")
        return located([]);
      if (area === "provider")
        return located([]);
      if (area === "shell") {
        const header2 = request.headers.get("x-opencode-directory");
        const directory = url.searchParams.get("directory") ?? (header2 ? decodeURIComponent(header2) : undefined);
        if (!a && method === "GET")
          return located(shells(directory));
        if (a && !b && method === "GET") {
          const job = shell(a);
          return job ? located(job) : error2(404, "No such command.");
        }
        if (a && b === "output" && method === "GET") {
          const limit2 = url.searchParams.get("limit");
          const read2 = await shellOutput(a, Number(url.searchParams.get("cursor") ?? 0) || 0, limit2 ? Number(limit2) : undefined);
          return read2 ? located(read2) : error2(404, "No such command.");
        }
        if (a && !b && method === "DELETE")
          return await stopShell(a) ? json2({}) : error2(404, "No such command.");
      }
      if (area === "session") {
        if (!a) {
          if (method === "POST")
            return json2({ data: sessions.create(await body()) });
          const directory = url.searchParams.get("directory") ?? undefined;
          const under = url.searchParams.get("parentID") ?? url.searchParams.get("cursor")?.split(":")[2] ?? null;
          const roots = sessions.list(directory, under === null || under === "" ? undefined : under === "null" ? null : under);
          const ordered = url.searchParams.get("cursor")?.startsWith("asc") || url.searchParams.get("order") === "asc" ? [...roots].reverse() : roots;
          return json2(page(ordered, url));
        }
        if (a === "active")
          return json2({ data: Object.fromEntries(sessions.active().map((id2) => [id2, { type: "busy" }])) });
        if (a === "import" && method === "POST")
          return json2({ data: sessions.importSession(await body()) });
        const id = a;
        if (!b) {
          if (method === "GET")
            return json2({ data: sessions.get(id) });
          if (method === "PATCH") {
            sessions.update(id, await body());
            return json2({ data: sessions.get(id) });
          }
          if (method === "DELETE") {
            await sessions.remove(id);
            return json2({});
          }
        }
        switch (b) {
          case "message": {
            const messages = sessions.messages(id);
            const asc = url.searchParams.get("order") === "asc" || url.searchParams.get("cursor")?.startsWith("asc");
            const ordered = asc ? messages : [...messages].reverse();
            if (c) {
              const found = messages.find((message) => message.id === c);
              return found ? json2({ data: found }) : error2(404, "No such message.");
            }
            return json2(page(ordered, url));
          }
          case "inbox":
            if (method === "DELETE" && c) {
              sessions.cancelInput(id, c);
              return json2({});
            }
            if (method === "PATCH" && c) {
              sessions.setDelivery(id, c, (await body()).delivery);
              return json2({});
            }
            return json2({ data: sessions.inbox(id) });
          case "prompt": {
            const input = await body();
            sessions.prompt(id, { id: input.id ?? newID("msg"), text: String(input.text ?? ""), files: input.files ?? [], delivery: input.delivery ?? "steer" });
            return json2({});
          }
          case "fork":
            return json2({ data: sessions.fork(id, String((await body()).before ?? "")) });
          case "revert":
            if (c === "stage" && method === "POST")
              return json2({ data: await sessions.stageRevert(id, String((await body()).messageID ?? "")) });
            if (!c && method === "DELETE") {
              await sessions.clearRevert(id);
              return json2({});
            }
            break;
          case "shell":
            if (method !== "POST")
              break;
            sessions.runShell(id, String((await body()).command ?? ""));
            return json2({});
          case "synthetic": {
            const input = await body();
            sessions.synthetic(id, String(input.text ?? ""), typeof input.description === "string" ? input.description : undefined);
            return json2({});
          }
          case "generate": {
            const prompt = String((await body()).prompt ?? "");
            if (!prompt.trim())
              throw new BadRequest("Say what to write.");
            return json2({ data: { text: await sessions.generate(id, prompt) } });
          }
          case "command": {
            const input = await body();
            const name = String(input.name ?? "");
            const written = String(input.text ?? "");
            const template = name ? await link2.commandTemplate(name, sessions.get(id).location.directory) : undefined;
            const text2 = template ? expandCommand(template, written) : `/${name} ${written}`.trim();
            sessions.prompt(id, { id: newID("msg"), text: text2, files: input.files ?? [], delivery: input.delivery ?? "steer" });
            return json2({});
          }
          case "interrupt":
            return json2({ interrupted: await sessions.interrupt(id, url.searchParams.get("resume") === "true") });
          case "model":
            sessions.selectModel(id, (await body()).model);
            return json2({});
          case "agent":
            sessions.selectAgent(id, (await body()).agent);
            return json2({});
          case "permission":
            if (!c)
              return json2({ data: id === "global" ? [] : sessions.permissions(id) });
            if (d === "reply") {
              const { decision } = await body();
              sessions.replyPermission(id, c, decision);
              return json2({});
            }
            break;
          case "form":
            if (!c)
              return json2({ data: id === "global" ? [] : sessions.forms(id) });
            if (d === "reply") {
              sessions.replyForm(id, c, (await body()).answer ?? {});
              return json2({});
            }
            if (method === "DELETE") {
              sessions.replyForm(id, c, null);
              return json2({});
            }
            break;
          case "view": {
            const { idle } = await body();
            sessions.view(id, Number(idle) || Date.now());
            return json2({});
          }
          case "diff":
            return json2({ data: [] });
        }
      }
      if (area === "kuvo" && a === "accounts") {
        if (method === "POST" && !b) {
          const { agent, label: label2 } = await body();
          if (!kinds.includes(agent))
            return error2(400, "That isn't one of the coding agents.");
          const record = roster.accounts.add(agent, label2);
          roster.sync();
          const added = roster.all().find((each) => each.instance.id === record.id && each.id === agent);
          emit("integration.updated", { integrationID: added.providerID });
          return json2({ data: { providerID: added.providerID } });
        }
        const target = b ? roster.find(b) : undefined;
        if (!target)
          return error2(404, "No such account.");
        if (target.instance.id === "default")
          return error2(400, "That's the agent's own sign-in: sign out of it where you signed in.");
        if (method === "PATCH") {
          roster.accounts.rename(target.providerID, (await body()).label);
          roster.sync();
          emit("integration.updated", { integrationID: target.providerID });
          return json2({});
        }
        if (method === "DELETE") {
          sessions.forgetProvider(target.providerID);
          await target.removeAccount?.().catch(() => {});
          target.shutdown?.();
          roster.accounts.remove(target.providerID);
          roster.sync();
          emit("integration.updated", { integrationID: target.providerID });
          emit("model.updated", {});
          return json2({});
        }
      }
      if (area === "kuvo" && a === "groups")
        return await groupRoutes(context.groups?.runner, context.groups?.store, method, parts2.slice(3), body);
      if (area === "kuvo" && a === "tools" && method === "PUT") {
        const { url: address, token, timeout } = await body();
        setToolServer(typeof address === "string" && address && typeof token === "string" ? { url: address, token, timeout: Number(timeout) || 960000 } : undefined);
        return json2({});
      }
      if (area === "kuvo" && a === "engine" && method === "PUT") {
        const { url: address, password } = await body();
        link2.configure(typeof address === "string" && address ? address : undefined, typeof password === "string" ? password : undefined);
        return json2({});
      }
      if (area === "kuvo" && a === "auto") {
        if (b === "limits" && method === "DELETE") {
          const provider = url.searchParams.get("provider");
          if (provider)
            auto.release(provider);
          else
            auto.clearLimits();
          emit("kuvo.auto.updated", {});
          return json2({});
        }
        if (!b && method === "PUT") {
          const { entries, lists } = await body();
          if (Array.isArray(lists)) {
            try {
              auto.setLists(lists);
            } catch (problem) {
              return error2(400, problem.message);
            }
          } else if (Array.isArray(entries))
            auto.set(entries);
          else
            return error2(400, "Send the lists, or the first one's entries.");
          emit("kuvo.auto.updated", {});
        }
        if (!b && (method === "GET" || method === "PUT"))
          return json2({ data: { entries: auto.list(), lists: auto.all(), limits: auto.limits() } });
      }
      if (area === "experimental" && a === "session" && b) {
        const id = b;
        if (c === "instructions" && d === "entries" && e) {
          sessions.setInstruction(id, e, method === "DELETE" ? undefined : String((await body()).value ?? ""));
          return json2({});
        }
        if (c === "wait") {
          while (sessions.active().includes(id))
            await Bun.sleep(200);
          return json2({});
        }
      }
      return error2(404, "Not available for this agent.");
    } catch (caught) {
      if (caught instanceof NotFound)
        return error2(404, caught.message);
      if (caught instanceof BadRequest)
        return error2(400, caught.message);
      return error2(500, caught instanceof Error ? caught.message : String(caught));
    }
  };
}
function expandCommand(template, written) {
  const all = written.trim();
  const words = all ? all.split(/\s+/) : [];
  const named2 = /\$ARGUMENTS|\$[1-9]/.test(template);
  const highest = Math.max(0, ...[...template.matchAll(/\$([1-9]\d*)/g)].map((match) => Number(match[1])));
  const filled = template.replace(/\$ARGUMENTS|\$([1-9]\d*)/g, (_, index) => {
    if (index === undefined)
      return all;
    return Number(index) === highest ? words.slice(highest - 1).join(" ") : words[Number(index) - 1] ?? "";
  });
  return named2 || !all ? filled.trim() : `${filled.trim()}

${all}`;
}

// Agents/src/store.ts
import { mkdirSync as mkdirSync14, readdirSync as readdirSync7, readFileSync as readFileSync17, renameSync as renameSync6, rmSync as rmSync11, statSync as statSync6, writeFileSync as writeFileSync12 } from "fs";
import { join as join18 } from "path";

class Store {
  root;
  records = new Map;
  pending = new Map;
  constructor(root) {
    this.root = root;
    mkdirSync14(root, { recursive: true });
    for (const id of readdirSync7(root)) {
      try {
        const folder = join18(root, id);
        const session = JSON.parse(readFileSync17(join18(folder, "session.json"), "utf8"));
        let messages = [];
        try {
          messages = JSON.parse(readFileSync17(join18(folder, "messages.json"), "utf8"));
        } catch {}
        let agent = {};
        try {
          agent = JSON.parse(readFileSync17(join18(folder, "agent.json"), "utf8"));
        } catch {}
        this.records.set(session.id, { session, messages, agent });
      } catch {}
    }
  }
  all() {
    return [...this.records.values()].map((record) => record.session);
  }
  get(id) {
    return this.records.get(id);
  }
  writtenAt(id) {
    try {
      return statSync6(join18(this.root, id, "messages.json")).mtimeMs;
    } catch {
      return;
    }
  }
  add(session) {
    this.records.set(session.id, { session, messages: [], agent: {} });
    this.save(session.id, true);
  }
  remove(id) {
    this.records.delete(id);
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
    rmSync11(join18(this.root, id), { recursive: true, force: true });
  }
  save(id, now = false) {
    clearTimeout(this.pending.get(id));
    if (now) {
      this.pending.delete(id);
      this.write(id);
      return;
    }
    this.pending.set(id, setTimeout(() => {
      this.pending.delete(id);
      this.write(id);
    }, 500));
  }
  flush() {
    for (const id of [...this.pending.keys()])
      this.save(id, true);
  }
  write(id) {
    const record = this.records.get(id);
    if (!record)
      return;
    const folder = join18(this.root, id);
    mkdirSync14(folder, { recursive: true });
    for (const [name, value] of [
      ["session.json", record.session],
      ["messages.json", record.messages],
      ["agent.json", record.agent]
    ]) {
      const file = join18(folder, name);
      writeFileSync12(file + ".new", JSON.stringify(value));
      renameSync6(file + ".new", file);
    }
  }
}

// Agents/src/groups/api.ts
function server2(url, password) {
  const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  return {
    async request(method, path, body, timeout = 30000) {
      const response = await fetch(url.replace(/\/$/, "") + path, {
        method,
        headers: { Authorization: authorization, ...body === undefined ? {} : { "Content-Type": "application/json" } },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
      });
      const text2 = await response.text();
      let value;
      try {
        value = text2 ? JSON.parse(text2) : undefined;
      } catch {
        value = text2;
      }
      if (!response.ok) {
        const error3 = new Error(value?.message ?? `It answered ${response.status}.`);
        error3.status = response.status;
        throw error3;
      }
      return value;
    }
  };
}
var at = (id) => "/api/session/" + encodeURIComponent(id);

class SeatAPI {
  requester;
  constructor(requester) {
    this.requester = requester;
  }
  async active() {
    const answer = await this.requester.request("GET", "/api/session/active");
    return new Set(Object.keys(answer?.data ?? {}));
  }
  async sessions() {
    const all = [];
    let query = "limit=100&order=desc";
    for (let pages = 0;pages < 50; pages++) {
      const answer = await this.requester.request("GET", `/api/session?${query}`);
      const data = Array.isArray(answer?.data) ? answer.data : [];
      all.push(...data);
      const next2 = answer?.cursor?.next;
      if (data.length < 100 || !next2)
        break;
      query = `limit=100&cursor=${encodeURIComponent(next2)}`;
    }
    return all;
  }
  async session(id) {
    return (await this.requester.request("GET", at(id)))?.data;
  }
  async account(model2) {
    const [providers, integrations] = await Promise.all([this.requester.request("GET", "/api/provider"), this.requester.request("GET", "/api/integration")]);
    const ready = Array.isArray(providers?.data) ? providers.data.map((each) => each?.id) : [];
    if (!ready.length)
      return;
    const listed2 = Array.isArray(integrations?.data) ? integrations.data : [];
    const provider = listed2.find((each) => each?.id === model2.providerID);
    return { name: String(provider?.name ?? model2.providerID), signedOut: provider !== undefined && !ready.includes(model2.providerID) };
  }
  async create(directory, title, agent, model2, permissions) {
    const body = { title, location: { directory }, permissions };
    if (agent)
      body.agent = agent;
    if (model2)
      body.model = model2;
    return (await this.requester.request("POST", "/api/session", body))?.data;
  }
  async setPermissions(id, rules) {
    await this.requester.request("PATCH", at(id), { permissions: rules });
  }
  async setMetadata(id, metadata) {
    await this.requester.request("PATCH", at(id), { metadata });
  }
  async setInstruction(id, key, text2) {
    await this.requester.request("PUT", `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/${encodeURIComponent(key)}`, { value: text2 });
  }
  async removeInstruction(id, key) {
    await this.requester.request("DELETE", `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/${encodeURIComponent(key)}`);
  }
  async delete(id) {
    await this.requester.request("DELETE", at(id));
  }
  async prompt(id, message, text2, delivery) {
    await this.requester.request("POST", at(id) + "/prompt", { id: message, text: text2, delivery });
  }
  async interrupt(id) {
    await this.requester.request("POST", at(id) + "/interrupt");
  }
  async selectModel(id, model2) {
    await this.requester.request("POST", at(id) + "/model", { model: model2 });
  }
  async selectAgent(id, agent) {
    await this.requester.request("POST", at(id) + "/agent", { agent });
  }
  async setDelivery(id, item, delivery) {
    await this.requester.request("PATCH", `${at(id)}/inbox/${encodeURIComponent(item)}`, { delivery });
  }
  async cancelInbox(id, item) {
    await this.requester.request("DELETE", `${at(id)}/inbox/${encodeURIComponent(item)}`);
  }
  async inbox(id) {
    return (await this.requester.request("GET", at(id) + "/inbox"))?.data ?? [];
  }
  async messages(id, limit2, cursor) {
    const query = cursor ? `limit=${limit2}&cursor=${encodeURIComponent(cursor)}` : `limit=${limit2}&order=desc`;
    const answer = await this.requester.request("GET", `${at(id)}/message?${query}`);
    const data = Array.isArray(answer?.data) ? [...answer.data].reverse() : [];
    return { data, cursor: answer?.cursor?.next ?? answer?.cursor?.previous };
  }
  async permissions(id) {
    return (await this.requester.request("GET", at(id) + "/permission"))?.data ?? [];
  }
  async reject(id, permission, message) {
    await this.requester.request("POST", `${at(id)}/permission/${encodeURIComponent(permission)}/reply`, { decision: "reject", message });
  }
  async forms(id) {
    return (await this.requester.request("GET", at(id) + "/form"))?.data ?? [];
  }
  async dismiss(id, form, message) {
    await this.requester.request("DELETE", `${at(id)}/form/${encodeURIComponent(form)}?message=${encodeURIComponent(message)}`);
  }
}

// Agents/src/groups/runner.ts
var seatKey = "kuvo.seat";
var memoryKey = "kuvo.groups.machine";

class Cancelled extends Error {
}
var sleep = (ms, signal) => new Promise((done, fail) => {
  if (signal?.aborted)
    return fail(new Cancelled);
  const stop = () => {
    clearTimeout(timer);
    fail(new Cancelled);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", stop);
    done();
  }, ms);
  signal?.addEventListener("abort", stop, { once: true });
});
var groupMessageID = () => "gm_" + crypto.randomUUID().toLowerCase();
var reason2 = (error3) => String(error3?.message ?? error3 ?? "it failed").trim();
var runsWithAgents = (model2) => Boolean(model2 && (model2.providerID === autoProvider || parseProvider(model2.providerID)));

class GroupRunner {
  context;
  chats;
  live = new Map;
  seatBase = new Map;
  runs = 0;
  following = new Set;
  declined = new Set;
  seatsChecked = new Set;
  rulesChanged() {
    this.seatsChecked.clear();
  }
  seatTexts = new Map;
  syncs = new Map;
  meetings;
  constructor(context) {
    this.context = context;
    this.chats = context.store.load();
    for (const [id, kept2] of this.chats) {
      if (kept2.talking) {
        kept2.talking = false;
        this.state(id).paused = true;
        context.store.saveGroup(kept2);
      }
      try {
        this.keepAwake(id);
      } catch (error3) {
        console.error(`${id}:`, reason2(error3));
      }
    }
  }
  start() {
    this.resumeWork();
    this.scheduleMeetings(1e4);
    this.dropLeftScratch();
  }
  async dropLeftScratch() {
    const old = Date.now() - 30 * 60000;
    const bridge = this.context.bridge();
    for (const api of [new SeatAPI(this.context.engine), ...bridge ? [new SeatAPI(bridge)] : []]) {
      const sessions = await api.sessions().catch(() => []);
      for (const session of sessions) {
        if (session?.metadata?.kuvo?.seat?.scratch !== true || (session?.time?.updated ?? Date.now()) >= old)
          continue;
        await api.delete(session.id).catch(() => {});
      }
    }
  }
  state(id) {
    let live = this.live.get(id);
    if (!live)
      this.live.set(id, live = { paused: false, asked: 0 });
    return live;
  }
  talk(id) {
    const live = this.state(id);
    return { speaking: live.speaking ?? live.splitting, discussing: live.abort !== undefined, paused: live.paused, ...live.speaking && live.activity ? { activity: live.activity } : {} };
  }
  list() {
    return [...this.chats.values()].map((kept2) => {
      const said3 = kept2.messages.filter((message) => message.kind !== "note");
      return {
        group: kept2.group,
        status: kept2.status,
        state: this.talk(kept2.group.id),
        last: kept2.messages.at(-1),
        said: said3.at(-1),
        fromBot: said3.filter((message) => message.author !== undefined).at(-1)
      };
    });
  }
  get(id) {
    const kept2 = this.chats.get(id);
    return kept2 && { group: kept2.group, status: kept2.status, state: this.talk(id), messages: kept2.messages };
  }
  chat(id) {
    const kept2 = this.chats.get(id);
    return kept2?.status === "active" ? kept2 : undefined;
  }
  bot(id) {
    return id ? this.context.store.bot(id) : undefined;
  }
  name(author) {
    return author === undefined ? "User" : this.bot(author)?.name ?? "A bot that left";
  }
  changed(id) {
    const kept2 = this.chats.get(id);
    if (!kept2)
      return;
    this.context.store.saveGroup(kept2);
    this.keepAwake(id);
    emit("kuvo.group.updated", { id, group: kept2.group, status: kept2.status, state: this.talk(id) });
  }
  told(id) {
    const kept2 = this.chats.get(id);
    if (kept2)
      emit("kuvo.group.updated", { id, group: kept2.group, status: kept2.status, state: this.talk(id) });
  }
  keepAwake(id) {
    const kept2 = this.chats.get(id);
    if (!kept2)
      return;
    const working = kept2.messages.some((message) => message.tasks?.some((task) => task.state === "working" || task.state === "waiting"));
    this.context.store.setAwake(id, kept2.status === "active" && (kept2.group.meeting !== undefined || this.state(id).abort !== undefined || working));
  }
  put(group, messages, status, replace) {
    const existing = this.chats.get(group.id);
    if (existing && !replace)
      return false;
    if (existing)
      this.stop(group.id);
    const kept2 = { group, status, messages };
    this.chats.set(group.id, kept2);
    this.context.store.saveMessages(kept2);
    this.changed(group.id);
    if (status === "active")
      this.began(group.id);
    return true;
  }
  activate(id) {
    const kept2 = this.chats.get(id);
    if (!kept2)
      return false;
    if (kept2.status !== "active") {
      kept2.status = "active";
      this.changed(id);
      this.began(id);
    }
    return true;
  }
  began(id) {
    this.resumeWork(id);
    this.rememberSoon(id);
    this.scheduleMeetings(0);
  }
  hold(id) {
    const kept2 = this.chats.get(id);
    if (!kept2)
      return;
    this.stop(id);
    kept2.status = "held";
    this.changed(id);
    return { group: kept2.group, messages: kept2.messages };
  }
  release(id) {
    const kept2 = this.chats.get(id);
    if (!kept2)
      return false;
    this.stop(id);
    this.chats.delete(id);
    this.live.delete(id);
    this.context.store.trash(id, this.context.trash);
    emit("kuvo.group.deleted", { id });
    for (const bot of kept2.group.members)
      this.remember(bot);
    return true;
  }
  async delete(id) {
    const kept2 = this.chats.get(id);
    if (!kept2)
      return false;
    this.stop(id);
    this.chats.delete(id);
    this.live.delete(id);
    this.context.store.trash(id, this.context.trash);
    emit("kuvo.group.deleted", { id });
    for (const [bot, seat] of Object.entries(kept2.group.seats))
      await this.deleteSeat(seat, kept2.group, bot);
    for (const bot of kept2.group.members)
      await this.remember(bot, { forgetting: id });
    return true;
  }
  async update(id, edits2) {
    const kept2 = this.chats.get(id);
    if (!kept2)
      return false;
    const old = structuredClone(kept2.group);
    const group = kept2.group;
    if (typeof edits2.name === "string" && edits2.name.trim())
      group.name = edits2.name;
    if (edits2.purpose !== undefined)
      group.purpose = edits2.purpose ?? undefined;
    if (edits2.meeting !== undefined)
      group.meeting = edits2.meeting ?? undefined;
    if (typeof edits2.viewed === "string")
      group.viewed = edits2.viewed;
    const leaving = [];
    if (Array.isArray(edits2.members) && edits2.members.every((member) => typeof member === "string")) {
      group.members = [...edits2.members];
      for (const bot of old.members) {
        if (group.members.includes(bot))
          continue;
        const seat = group.seats[bot];
        if (seat)
          leaving.push({ bot, seat });
        delete group.seats[bot];
        delete group.heard[bot];
        if (group.retracted)
          delete group.retracted[bot];
      }
    }
    if (JSON.stringify(group) === JSON.stringify(old))
      return true;
    this.changed(id);
    if (edits2.meeting !== undefined)
      this.scheduleMeetings(0);
    for (const { bot, seat } of leaving)
      await this.deleteSeat(seat, old, bot);
    if (Array.isArray(edits2.members) || edits2.name !== undefined || edits2.purpose !== undefined) {
      for (const bot of new Set([...old.members, ...group.members])) {
        if (group.members.includes(bot))
          await this.remember(bot);
        else
          await this.remember(bot, { changed: id, forgetting: id });
      }
    }
    return true;
  }
  send(id, text2, named2) {
    text2 = trim(text2);
    const kept2 = this.chat(id);
    if (!text2 || !kept2)
      return;
    const message = { id: groupMessageID(), text: text2, time: stamp2(), kind: "message", ...named2 ? { named: named2 } : {} };
    this.append(message, id);
    const live = this.state(id);
    live.asked++;
    live.paused = false;
    if (live.speaking)
      this.steer(live.speaking, id, message);
    if (!live.abort)
      this.begin(id);
    this.told(id);
    return message;
  }
  meet(id, topic) {
    if (!this.chat(id))
      return;
    const message = this.append({ id: groupMessageID(), text: topic, time: stamp2(), kind: "meeting" }, id);
    const live = this.state(id);
    live.asked++;
    live.paused = false;
    live.meeting = message.id;
    if (live.speaking)
      this.steer(live.speaking, id, message);
    if (!live.abort)
      this.begin(id);
    this.told(id);
  }
  meetingEnded(id) {
    const live = this.state(id);
    const start = live.meeting;
    live.meeting = undefined;
    const kept2 = this.chats.get(id);
    if (!start || !kept2)
      return;
    const index = kept2.messages.findIndex((message) => message.id === start);
    const since = index >= 0 ? kept2.messages.slice(index + 1) : [];
    const last2 = [...since].reverse().find((message) => message.author !== undefined && message.kind !== "note");
    emit("kuvo.group.met", { id, name: kept2.group.name, ...last2 ? { last: last2, who: this.name(last2.author) } : {} });
  }
  undo(id, messageID2) {
    const kept2 = this.chat(id);
    if (!kept2)
      return;
    const cut = kept2.messages.findIndex((message) => message.id === messageID2);
    if (cut < 0)
      return;
    this.stop(id);
    const taken = kept2.messages.slice(cut);
    const text2 = kept2.messages[cut].text;
    kept2.messages = kept2.messages.slice(0, cut);
    this.context.store.saveMessages(kept2);
    const retracted = { ...kept2.group.retracted ?? {} };
    for (const bot of kept2.group.members) {
      const heard = kept2.group.heard[bot];
      if (!heard || !taken.some((message) => message.id === heard))
        continue;
      const last2 = kept2.messages.at(-1)?.id;
      if (last2)
        kept2.group.heard[bot] = last2;
      else
        delete kept2.group.heard[bot];
      if (retracted[bot] === undefined)
        retracted[bot] = [...new Intl.Segmenter().segment(text2)].slice(0, 120).map((part) => part.segment).join("");
    }
    kept2.group.retracted = Object.keys(retracted).length > 0 ? retracted : undefined;
    this.changed(id);
    emit("kuvo.group.reset", { id });
    this.rememberSoon(id);
    return text2;
  }
  stop(id) {
    const live = this.state(id);
    live.meeting = undefined;
    live.abort?.abort();
    live.abort = undefined;
    live.run = undefined;
    live.paused = false;
    for (const speaker of [live.speaking, live.splitting]) {
      const kept2 = this.chats.get(id);
      const seat = speaker ? kept2?.group.seats[speaker] : undefined;
      const bot = this.bot(speaker);
      if (seat && bot && kept2)
        this.seatAPI(bot, kept2.group, seat).then((api) => api?.interrupt(seat).catch(() => {}));
    }
    live.speaking = undefined;
    live.activity = undefined;
    live.splitting = undefined;
    this.setTalking(id, false);
    this.told(id);
  }
  keepGoing(id) {
    const live = this.state(id);
    if (live.abort || !this.chat(id))
      return;
    live.paused = false;
    live.asked++;
    this.begin(id);
    this.told(id);
  }
  setTalking(id, talking) {
    const kept2 = this.chats.get(id);
    if (!kept2 || (kept2.talking ?? false) === talking)
      return this.keepAwake(id);
    kept2.talking = talking;
    this.context.store.saveGroup(kept2);
    this.keepAwake(id);
  }
  begin(id) {
    const live = this.state(id);
    const run2 = ++this.runs;
    const abort = new AbortController;
    live.run = run2;
    live.abort = abort;
    this.setTalking(id, true);
    (async () => {
      let epoch;
      do {
        epoch = await this.discuss(id, abort.signal);
      } while (!abort.signal.aborted && this.state(id).asked !== epoch);
      if (this.state(id).run !== run2)
        return;
      live.run = undefined;
      live.abort = undefined;
      live.speaking = undefined;
      live.activity = undefined;
      this.setTalking(id, false);
      this.meetingEnded(id);
      this.told(id);
    })().catch((error3) => console.error("group chat:", error3));
  }
  async discuss(id, signal) {
    const live = this.state(id);
    let epoch = live.asked;
    let turns = 0;
    let quiet2 = new Set;
    let absent = new Set;
    let saidCount = 0;
    const guested = new Set;
    const begun = Math.max(0, (this.chat(id)?.messages ?? []).findLastIndex((message) => message.kind !== "note"));
    while (!signal.aborted) {
      const kept3 = this.chat(id);
      if (!kept3)
        return epoch;
      if (live.asked !== epoch) {
        epoch = live.asked;
        turns = 0;
        quiet2 = new Set;
        absent = new Set;
        saidCount = 0;
      }
      const names = new Map;
      for (const member of kept3.group.members) {
        const bot = this.bot(member);
        if (bot)
          names.set(member, bot.name);
      }
      const members = kept3.group.members.filter((member) => names.has(member) && !absent.has(member));
      const bots = this.context.store.allBots().map((bot) => ({ id: bot.id, name: bot.name }));
      let named2;
      for (let index = begun;index < kept3.messages.length && !named2; index++) {
        const message = kept3.messages[index];
        if (message.kind === "note")
          continue;
        const guest = guests(kept3.messages.slice(0, index + 1), kept3.group.members, bots).find((bot) => !guested.has(message.id + "/" + bot));
        if (guest)
          named2 = { message, guest };
      }
      if (named2) {
        const { message, guest } = named2;
        guested.add(message.id + "/" + guest);
        if (turns >= limit(kept3.group.members.length)) {
          live.paused = true;
          break;
        }
        const outcome2 = await this.turn(guest, id, signal, false, message);
        if (signal.aborted)
          return epoch;
        turns++;
        if (outcome2 === "said") {
          quiet2 = new Set;
          saidCount++;
        }
        continue;
      }
      const speaker = nextSpeaker(kept3.group, kept3.messages, members, quiet2, names);
      if (!speaker)
        break;
      if (turns >= limit(kept3.group.members.length)) {
        live.paused = true;
        break;
      }
      const outcome = await this.turn(speaker, id, signal);
      if (signal.aborted)
        return epoch;
      turns++;
      if (outcome === "said") {
        quiet2 = new Set;
        saidCount++;
      } else if (outcome === "passed") {
        quiet2.add(speaker);
      } else {
        absent.add(speaker);
      }
    }
    const kept2 = this.chat(id);
    const lead = kept2?.group.members[0];
    if (signal.aborted || saidCount === 0 || live.asked !== epoch || !kept2 || !lead || !this.bot(lead))
      return epoch;
    if (saidCount >= (live.meeting !== undefined ? 2 : 3) && kept2.group.members.length >= 2) {
      const before = kept2.messages.at(-1)?.id;
      await this.turn(lead, id, signal, true);
      const wrapUp = this.chat(id)?.messages.at(-1);
      if (wrapUp && wrapUp.id !== before && wrapUp.kind === "wrapUp" && !signal.aborted && live.asked === epoch)
        await this.splitWork(wrapUp.id, id, lead, signal);
    } else {
      const last2 = kept2.messages.at(-1);
      if (last2 && last2.author !== undefined && last2.kind === "message" && last2.report === undefined)
        await this.splitWork(last2.id, id, lead, signal);
    }
    return epoch;
  }
  async turn(botID, id, signal, wrapUp = false, namedIn) {
    const guest = namedIn !== undefined;
    const bot = this.bot(botID);
    if (!bot)
      return "absent";
    const live = this.state(id);
    live.speaking = botID;
    const run2 = live.run;
    this.told(id);
    const going = () => {
      if (signal.aborted)
        throw new Cancelled;
    };
    const left = () => !guest && !this.chat(id)?.group.members.includes(botID);
    let scratch;
    let provider;
    try {
      const kept2 = this.chat(id);
      if (!kept2)
        return "absent";
      const first = await this.seatAPI(bot, kept2.group, kept2.group.seats[botID]);
      going();
      if (!first) {
        this.note(`${bot.name} couldn\u2019t answer: the coding agents aren\u2019t running.`, id);
        return "absent";
      }
      const model2 = await this.model(bot);
      if (model2 && !runsWithAgents(model2)) {
        const account = await new SeatAPI(this.context.engine).account(model2).catch(() => {
          return;
        });
        going();
        provider = account?.name;
        if (account?.signedOut) {
          this.note(`${bot.name} couldn\u2019t answer: ${model2.id} needs a sign-in on this machine: sign in to ${account.name} in Settings \u203A Accounts, or choose another model.`, id);
          return "absent";
        }
      }
      let seat;
      let isNew;
      if (guest) {
        seat = await this.scratch(bot, kept2.group, first, `${bot.name} asked into ${kept2.group.name}`);
        scratch = { seat, api: first };
        isNew = true;
      } else {
        ({ seat, isNew } = await this.seat(bot, id, first));
      }
      going();
      const current = this.chat(id);
      if (!current)
        return "absent";
      const api = guest ? first : await this.seatAPI(bot, current.group, seat);
      going();
      if (!api) {
        this.note(`${bot.name} couldn\u2019t answer: the coding agents aren\u2019t running.`, id);
        return "absent";
      }
      const all = [...current.messages];
      const heard = current.group.heard[botID];
      const start = heard ? all.findIndex((message) => message.id === heard) + 1 : 0;
      const unheard = all.slice(start).filter((message) => message.author !== botID && message.kind !== "note");
      const promptID = newID("msg");
      const retracted = guest ? undefined : current.group.retracted?.[botID];
      const name = (author) => this.name(author);
      const prompt = guest ? guestText(botID, current.group, all, namedIn?.author, name) : isNew ? seatStartText(botID, current.group, all, wrapUp, name, named2(all)) : turnText(botID, current.group, unheard, wrapUp, name, named2(unheard));
      await api.prompt(seat, promptID, prompt, "queue");
      going();
      const last2 = all.at(-1);
      if (last2 && !guest)
        this.setHeard(last2.id, botID, id);
      const now = this.chat(id)?.group;
      if (now && retracted !== undefined && now.retracted?.[botID] === retracted) {
        delete now.retracted[botID];
        if (Object.keys(now.retracted).length === 0)
          now.retracted = undefined;
        this.changed(id);
      }
      const sent = Date.now();
      let thinking = "";
      let streamedAt = 0;
      const show = (now2) => {
        if (live.run !== run2 || live.speaking !== botID || JSON.stringify(now2) === JSON.stringify(live.activity ?? []))
          return;
        const sameKind = live.activity?.[0]?.kind === now2[0]?.kind;
        if (sameKind && Date.now() - streamedAt < 300)
          return;
        live.activity = now2;
        streamedAt = Date.now();
        this.told(id);
      };
      const unlisten = this.context.listen?.(seat, {
        event: (event) => {
          const data = event?.data ?? {};
          if (event?.type === "session.reasoning.started")
            thinking = "";
          else if (event?.type === "session.reasoning.delta") {
            thinking = (thinking + String(data.delta ?? "")).slice(-2000);
            const line = thought(thinking);
            if (line)
              show([{ kind: "thinking", text: line }]);
          } else if (event?.type === "session.text.started" || event?.type === "session.text.delta")
            show([{ kind: "writing" }]);
        },
        reconnected() {}
      });
      try {
        await this.waitForRun(seat, promptID, sent, api, signal, (messages) => {
          const now2 = activity(messages, promptID, sent);
          if (live.run !== run2 || live.speaking !== botID || now2.length === 0 || JSON.stringify(now2) === JSON.stringify(live.activity ?? []))
            return;
          if (Date.now() - streamedAt < 3000)
            return;
          live.activity = now2;
          this.told(id);
        });
      } finally {
        unlisten?.();
      }
      if (left())
        return "absent";
      const reply = await this.reply(seat, promptID, sent, api);
      going();
      if (!guest && reply.size !== undefined) {
        const base = this.seatBase.get(seat) ?? reply.size;
        this.seatBase.set(seat, base);
        const grown = reply.size - base;
        if (grown > seatBudget && outgrew(grown, chatText(botID, current.group, this.chat(id)?.messages ?? all, name))) {
          this.seatBase.delete(seat);
          await this.startOver(botID, id);
        }
      }
      if (!reply.text) {
        if (reply.error) {
          this.note(`${bot.name} couldn\u2019t answer: ${plainError(reply.error, provider)}`, id);
          return "absent";
        }
        return "passed";
      }
      if (!wrapUp && isPass(reply.text))
        return "passed";
      this.append({
        id: groupMessageID(),
        author: botID,
        text: ampersands(reply.text, this.context.store.allBots().map((each) => each.name)),
        time: stamp2(),
        kind: wrapUp ? "wrapUp" : "message",
        ...reply.steps.length ? { steps: reply.steps.map(trimmed) } : {}
      }, id);
      return "said";
    } catch (error3) {
      if (signal.aborted || error3 instanceof Cancelled || left())
        return "absent";
      console.error(`${botID}'s turn in ${id} failed:`, reason2(error3));
      this.note(`${bot.name} couldn\u2019t answer: ${plainError(reason2(error3), provider)}`, id);
      return "absent";
    } finally {
      if (scratch)
        scratch.api.delete(scratch.seat).catch(() => {});
      if (live.speaking === botID && live.run === run2) {
        live.speaking = undefined;
        live.activity = undefined;
      }
      this.told(id);
    }
  }
  async steer(botID, id, message) {
    const kept2 = this.chat(id);
    const bot = this.bot(botID);
    const seat = kept2?.group.seats[botID];
    if (!kept2 || !bot || !seat)
      return;
    const api = await this.seatAPI(bot, kept2.group, seat);
    if (!api || !(await api.active().catch(() => new Set)).has(seat))
      return;
    const text2 = "The user, just now: " + message.text + (message.named ? `

` + message.named : "");
    try {
      await api.prompt(seat, newID("msg"), text2, "steer");
      this.setHeard(message.id, botID, id);
    } catch {}
  }
  async waitForRun(seat, promptID, sent, api, signal, seen, stops) {
    const pace = this.context.pace ?? 1;
    let looked = Date.now();
    let gone = 0;
    let missing = 0;
    let idleSince;
    let woken = false;
    for (;; ) {
      await sleep(600 * pace, signal);
      if (stops?.()) {
        await api.interrupt(seat).catch(() => {});
        throw new Cancelled;
      }
      await this.decline(seat, api);
      if (seen && Date.now() - looked > 1500 * pace) {
        looked = Date.now();
        const page2 = await api.messages(seat, 12).catch(() => {
          return;
        });
        if (page2)
          seen(page2.data);
      }
      const active = await api.active().catch(() => {
        return;
      });
      if (active && !active.has(seat)) {
        const inbox = await api.inbox(seat).catch((error3) => error3?.status === 404 ? null : undefined);
        if (inbox === null) {
          if (++missing >= 3)
            return;
          continue;
        }
        missing = 0;
        if (inbox && !inbox.some((item) => item.id === promptID)) {
          const read2 = await api.messages(seat, 60).catch(() => {
            return;
          });
          const at2 = read2 ? read2.data.findIndex((message) => message?.id === promptID) : -1;
          if (at2 >= 0 ? read2.data.slice(at2 + 1).some((message) => message?.type === "idle") : read2 ? ++gone >= 3 : false)
            return;
          if (at2 >= 0)
            gone = 0;
          idleSince = undefined;
        } else if (inbox) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince > 8000 * pace) {
            if (!woken) {
              woken = true;
              idleSince = Date.now();
              await api.setDelivery(seat, promptID, "steer").catch(() => {});
            } else {
              await api.cancelInbox(seat, promptID).catch(() => {});
              return;
            }
          }
        }
      } else {
        idleSince = undefined;
      }
      if (Date.now() - sent > 600000) {
        await api.interrupt(seat).catch(() => {});
        throw new Error("It took too long, so it was stopped.");
      }
    }
  }
  async decline(seat, api) {
    for (const request of await api.permissions(seat).catch(() => [])) {
      if (this.declined.has(request.id))
        continue;
      this.declined.add(request.id);
      await api.reject(seat, request.id, "Nobody can approve this in a group chat. Carry on without it, or say who should do it.").catch(() => {});
    }
    for (const form of await api.forms(seat).catch(() => [])) {
      if (this.declined.has(form.id))
        continue;
      this.declined.add(form.id);
      await api.dismiss(seat, form.id, "Ask the group in your reply instead.").catch(() => {});
    }
  }
  async reply(seat, promptID, sent, api) {
    const { data } = await api.messages(seat, 60);
    const start = data.findIndex((message) => message?.id === promptID);
    const since = sent - 2000;
    const tokens = [...data].reverse().find((message) => message?.type === "assistant" && message.tokens)?.tokens;
    const size = tokens ? (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) : undefined;
    return { ...said2(start >= 0 ? data.slice(start + 1) : data.filter((message) => (message?.time?.created ?? 0) >= since)), size };
  }
  async splitWork(wrapUpID, id, lead, signal) {
    const kept2 = this.chat(id);
    const bot = this.bot(lead);
    if (!kept2 || !bot)
      return;
    const api = await this.seatAPI(bot, kept2.group, kept2.group.seats[lead]);
    if (!api)
      return;
    const members = kept2.group.members.flatMap((member) => {
      const found2 = this.bot(member);
      return found2 ? [{ id: member, name: found2.name }] : [];
    });
    const all = kept2.messages;
    const found = all.findIndex((message) => message.id === wrapUpID);
    const end = found >= 0 ? found : all.length;
    const before = all.slice(0, end);
    let begin = 0;
    for (let index = before.length - 1;index >= 0; index--) {
      if (before[index].kind === "wrapUp") {
        begin = index + 1;
        break;
      }
    }
    const yours = all.slice(begin, end).filter((message) => message.author === undefined && message.kind === "message").slice(-6).map((message) => [...new Intl.Segmenter().segment(ownWords2(message.text))].slice(0, 800).map((part) => part.segment).join(""));
    const promptID = newID("msg");
    const live = this.state(id);
    const epoch = live.asked;
    live.splitting = lead;
    this.told(id);
    const sent = Date.now();
    let seat;
    try {
      seat = await this.scratch(bot, kept2.group, api, `${bot.name} handing out the work in ${kept2.group.name}`);
      const chat = chatText(lead, kept2.group, all.slice(0, Math.min(end + 1, all.length)), (author) => this.name(author));
      await api.prompt(seat, promptID, chat + `
` + splitText(members.map((member) => member.name), yours), "queue");
      await this.waitForRun(seat, promptID, sent, api, signal, undefined, () => this.state(id).asked !== epoch);
      const reply = await this.reply(seat, promptID, sent, api);
      const { tasks: tasks2, go } = tasks(reply.text, members, () => "gt_" + crypto.randomUUID().toLowerCase());
      if (signal.aborted)
        return;
      if (tasks2.length === 0) {
        if (go)
          this.note(`${bot.name} didn\u2019t say who does what, so no parts were handed out.`, id);
        return;
      }
      this.change(wrapUpID, id, (message) => message.tasks = tasks2);
      if (go && this.state(id).asked === epoch)
        this.startWork(wrapUpID, id);
    } catch (error3) {
      if (signal.aborted || error3 instanceof Cancelled)
        return;
      this.note(`${bot.name} couldn\u2019t hand out the work: ${reason2(error3)}`, id);
    } finally {
      if (seat)
        api.delete(seat).catch(() => {});
      if (live.splitting === lead)
        live.splitting = undefined;
      this.told(id);
    }
  }
  startWork(wrapUpID, id) {
    const tasks2 = this.chat(id)?.messages.find((message) => message.id === wrapUpID)?.tasks;
    if (!tasks2)
      return;
    const proposed = tasks2.filter((task) => task.state === "proposed");
    for (const task of proposed) {
      this.changeTask(task.id, wrapUpID, id, (part) => {
        part.state = (part.after ?? []).length === 0 ? "working" : "waiting";
        part.started = stamp2();
      });
    }
    for (const task of proposed)
      if ((task.after ?? []).length === 0)
        this.handSoon(task.id, wrapUpID, id);
    this.startReady(wrapUpID, id);
  }
  startReady(wrapUpID, id) {
    for (;; ) {
      const tasks2 = this.chat(id)?.messages.find((message) => message.id === wrapUpID)?.tasks;
      if (!tasks2)
        return;
      let changed = false;
      for (const task of tasks2) {
        if (task.state !== "waiting")
          continue;
        const first = tasks2.filter((other) => other.id !== task.id && (task.after ?? []).includes(other.bot));
        const failed = first.find((other) => other.state === "failed");
        if (failed) {
          this.fail(task.id, wrapUpID, id, `${this.bot(failed.bot)?.name ?? "the bot before it"} couldn\u2019t finish its part first`, false);
        } else if (first.every((other) => other.state === "done")) {
          this.changeTask(task.id, wrapUpID, id, (part) => part.state = "working");
          this.handSoon(task.id, wrapUpID, id);
        } else {
          const found = ring(task, tasks2);
          if (!found)
            continue;
          for (const part of found) {
            this.changeTask(part.id, wrapUpID, id, (each) => {
              each.state = "failed";
              each.finished = stamp2();
            });
          }
          const names = new Intl.ListFormat("en", { type: "conjunction" }).format(found.map((part) => this.name(part.bot)));
          this.note(`${names} wait on each other\u2019s parts, so ${found.length === 2 ? "neither" : "none of them"} could start.`, id);
        }
        changed = true;
        break;
      }
      if (!changed)
        return;
    }
  }
  handSoon(taskID, wrapUpID, id) {
    if (this.following.has(taskID))
      return;
    this.following.add(taskID);
    this.hand(taskID, wrapUpID, id).catch((error3) => console.error("group chat part:", error3)).finally(() => this.following.delete(taskID));
  }
  ownAPI(bot) {
    if (!bot.agents)
      return new SeatAPI(this.context.engine);
    const bridge = this.context.bridge();
    return bridge ? new SeatAPI(bridge) : undefined;
  }
  async hand(taskID, wrapUpID, id) {
    const kept2 = this.chat(id);
    const wrapUp = kept2?.messages.find((message) => message.id === wrapUpID);
    const task = wrapUp?.tasks?.find((part) => part.id === taskID);
    if (!kept2 || !wrapUp || !task)
      return;
    const bot = this.bot(task.bot);
    if (!bot)
      return this.fail(taskID, wrapUpID, id, "the bot is gone");
    const api = this.ownAPI(bot);
    if (!api)
      return this.fail(taskID, wrapUpID, id, "the coding agents aren\u2019t running");
    const before = (wrapUp.tasks ?? []).filter((part) => (task.after ?? []).includes(part.bot)).flatMap((part) => {
      const report = [...kept2.messages].reverse().find((message) => message.report === part.id);
      return report ? [{ name: this.name(part.bot), report: report.text }] : [];
    });
    const promptID = newID("msg");
    try {
      const from = this.name(wrapUp.author) + (wrapUp.kind === "wrapUp" ? "'s wrap-up" : "'s last message");
      await api.prompt(bot.sessionID, promptID, compose(task, kept2.group, wrapUp, from, before), "queue");
      this.changeTask(taskID, wrapUpID, id, (part) => part.prompt = promptID);
      await this.awaitReport(taskID, wrapUpID, id);
    } catch (error3) {
      this.fail(taskID, wrapUpID, id, reason2(error3));
    }
  }
  taskState(taskID, wrapUpID, id) {
    return this.chat(id)?.messages.find((message) => message.id === wrapUpID)?.tasks?.find((task) => task.id === taskID);
  }
  async awaitReport(taskID, wrapUpID, id) {
    let misses = 0;
    let stoppedChecks = 0;
    for (;; ) {
      await sleep(3000 * (this.context.pace ?? 1));
      const task = this.taskState(taskID, wrapUpID, id);
      if (!task || task.state !== "working")
        return;
      const bot = this.bot(task.bot);
      if (!bot || !task.prompt)
        return this.fail(taskID, wrapUpID, id, "the bot is gone");
      const api = this.ownAPI(bot);
      if (!api)
        continue;
      const active = await api.active().catch(() => {
        return;
      });
      if (!active || active.has(bot.sessionID))
        continue;
      const queued = await api.inbox(bot.sessionID).catch(() => {
        return;
      });
      if (!queued)
        continue;
      const read2 = await this.messagesFrom(task.prompt, bot.sessionID, task.started, api);
      if (read2.kind !== "found") {
        if (read2.kind === "missing" && !queued.some((item) => item.id === task.prompt)) {
          if (++misses >= 2)
            return this.fail(taskID, wrapUpID, id, `its message was taken back before ${bot.name} read it`);
        } else {
          misses = 0;
        }
        continue;
      }
      misses = 0;
      const run2 = read2.messages.slice(1);
      let end = run2.findIndex((message, index) => {
        if (message?.type !== "idle")
          return false;
        if (message.outcome !== "interrupted")
          return true;
        return run2[index + 1]?.type === "user";
      });
      const lastIndex = run2.length - 1;
      if (end < 0 && lastIndex >= 0 && run2[lastIndex]?.type === "idle" && run2[lastIndex].outcome === "interrupted") {
        if (++stoppedChecks >= 2)
          end = lastIndex;
      } else {
        stoppedChecks = 0;
      }
      const answered = end >= 0 || run2.some((message) => message?.type === "assistant" && message.time?.completed !== undefined);
      if (!answered)
        continue;
      const stillActive = await api.active().catch(() => {
        return;
      });
      if (!stillActive || stillActive.has(bot.sessionID))
        continue;
      const found = said2(end >= 0 ? run2.slice(0, end) : run2);
      let error3 = found.error;
      if (error3 === undefined && end >= 0 && run2[end]?.outcome === "failed")
        error3 = run2[end].error?.message;
      if (this.taskState(taskID, wrapUpID, id)?.state !== "working")
        return;
      if (!found.text)
        return this.fail(taskID, wrapUpID, id, error3 ?? "it stopped without saying what it did");
      this.changeTask(taskID, wrapUpID, id, (part) => {
        part.state = "done";
        part.finished = stamp2();
      });
      this.append({ id: groupMessageID(), author: bot.id, text: found.text, time: stamp2(), kind: "message", report: taskID }, id);
      this.startReady(wrapUpID, id);
      const kept2 = this.chats.get(id);
      if (kept2)
        emit("kuvo.group.done", { id, name: kept2.group.name, bot: bot.id, who: bot.name, text: found.text });
      return;
    }
  }
  async messagesFrom(promptID, session, started, api) {
    let page2;
    try {
      page2 = await api.messages(session, 80);
    } catch {
      return { kind: "unreadable" };
    }
    let messages = page2.data;
    const start = ((started ? Date.parse(started) : 0) / 1000 - 5) * 1000;
    while (!messages.some((message) => message?.id === promptID) && messages.length > 0 && (messages[0]?.time?.created ?? 0) > start && messages.length < 2000 && page2.cursor) {
      let older;
      try {
        older = await api.messages(session, 200, page2.cursor);
      } catch {
        break;
      }
      if (older.data.length === 0 || messages.some((message) => message?.id === older.data.at(-1)?.id))
        break;
      messages = [...older.data, ...messages];
      page2 = older;
    }
    const index = messages.findIndex((message) => message?.id === promptID);
    return index >= 0 ? { kind: "found", messages: messages.slice(index) } : { kind: "missing" };
  }
  fail(taskID, wrapUpID, id, why, thenOthers = true) {
    this.changeTask(taskID, wrapUpID, id, (part) => {
      part.state = "failed";
      part.finished = stamp2();
    });
    const who = this.bot(this.taskState(taskID, wrapUpID, id)?.bot)?.name ?? "A bot";
    const reasonText = trim(why).replace(/^\.+|\.+$/g, "");
    this.note(`${who} couldn\u2019t do its part: ${reasonText}.`, id);
    if (thenOthers)
      this.startReady(wrapUpID, id);
  }
  resumeWork(only) {
    for (const [id, kept2] of this.chats) {
      if (kept2.status !== "active" || only && id !== only)
        continue;
      for (const message of kept2.messages) {
        for (const task of message.tasks ?? []) {
          if (task.state !== "working" || this.following.has(task.id))
            continue;
          if (!task.prompt) {
            this.fail(task.id, message.id, id, "Kuvo Code stopped before it reached the bot");
          } else {
            this.following.add(task.id);
            this.awaitReport(task.id, message.id, id).catch((error3) => console.error("group chat part:", error3)).finally(() => this.following.delete(task.id));
          }
        }
        if (message.tasks?.some((task) => task.state === "waiting"))
          this.startReady(message.id, id);
      }
    }
  }
  scheduleMeetings(delay) {
    if (this.meetings)
      clearTimeout(this.meetings);
    this.meetings = setTimeout(() => {
      this.meetings = undefined;
      try {
        this.meetDue();
      } catch (error3) {
        console.error("group meetings:", error3);
      }
      const soonest = Math.min(...[...this.chats.values()].flatMap((kept2) => kept2.status === "active" && kept2.group.meeting ? [Date.parse(kept2.group.meeting.next)] : []));
      this.scheduleMeetings(Math.min(20000, Math.max(500, Number.isFinite(soonest) ? soonest - Date.now() : 20000)));
    }, delay);
    this.meetings.unref?.();
  }
  meetDue(now = Date.now()) {
    const zone2 = usableZone(this.context.store.settings()?.timeZone);
    for (const [id, kept2] of this.chats) {
      const meeting = kept2.group.meeting;
      if (kept2.status !== "active" || !meeting)
        continue;
      const due = Date.parse(meeting.next);
      if (!(due <= now))
        continue;
      try {
        const missed = due < now - 300000;
        const every = typeof meeting.every === "string" ? parseRepeat(meeting.every) : undefined;
        if (every) {
          const updated = { ...meeting };
          if (keepsTimeOfDay(every) && typeof updated.at !== "number")
            updated.at = minutesOf(due, zone2);
          if (keepsWeekday(every) && typeof updated.weekday !== "number")
            updated.weekday = weekdayOf2(due, zone2);
          const at2 = keepsTimeOfDay(every) ? updated.at : undefined;
          const weekday = keepsWeekday(every) ? updated.weekday : undefined;
          let next2 = next(every, due, now, zone2, at2, weekday);
          if (missed && keepsTimeOfDay(every) && next2 - now < 3 * 3600000)
            next2 = next(every, next2, next2, zone2, at2, weekday);
          updated.next = stamp2(new Date(next2));
          kept2.group.meeting = updated;
        } else {
          kept2.group.meeting = undefined;
        }
      } catch (error3) {
        console.error(`${id}'s meeting:`, reason2(error3));
        kept2.group.meeting = undefined;
      }
      this.changed(id);
      this.meet(id, meeting.topic);
    }
  }
  async seatAPI(bot, group, seat) {
    let onAgents;
    if (seat)
      onAgents = group.agentSeats?.includes(seat) ?? false;
    else
      onAgents = runsWithAgents(await this.model(bot));
    if (!onAgents)
      return new SeatAPI(this.context.engine);
    const bridge = this.context.bridge();
    return bridge ? new SeatAPI(bridge) : undefined;
  }
  async model(bot) {
    const conversation = async () => (await this.ownAPI(bot)?.session(bot.sessionID).catch(() => {
      return;
    }))?.model;
    if (!bot.model)
      return conversation();
    if (runsWithAgents(bot.model))
      return bot.model;
    const account = await new SeatAPI(this.context.engine).account(bot.model).catch(() => {
      return;
    });
    return account?.signedOut ? await conversation() ?? bot.model : bot.model;
  }
  async seat(bot, id, api) {
    const kept2 = this.chat(id);
    if (!kept2)
      throw new Cancelled;
    const same = () => this.chat(id) === kept2;
    const settings = this.context.store.settings();
    const rules = seatRules(bot.folder, settings?.askFirst ?? false, settings?.denies ?? []);
    const text2 = this.seatText(bot, kept2.group);
    const existing = kept2.group.seats[bot.id];
    if (existing) {
      if (!this.seatsChecked.has(existing)) {
        this.seatsChecked.add(existing);
        await api.setPermissions(existing, rules).catch(() => {});
      }
      if (this.seatTexts.get(existing) !== text2) {
        await api.setInstruction(existing, seatKey, text2).catch(() => {});
        this.seatTexts.set(existing, text2);
      }
      if (await this.keepModel(existing, bot, id, api))
        return { seat: existing, isNew: false };
    }
    if (!same())
      throw new Cancelled;
    const current = kept2;
    const model2 = await this.model(bot);
    const onAgents = runsWithAgents(model2);
    const seatAPI = onAgents ? this.context.bridge() ? new SeatAPI(this.context.bridge()) : undefined : new SeatAPI(this.context.engine);
    if (!seatAPI)
      throw new Error("the coding agents aren\u2019t running");
    const agent = onAgents && model2?.providerID.split("@")[0] === "cursor" ? "plan" : undefined;
    const session = await seatAPI.create(bot.directory, `${bot.name} in ${current.group.name}`, agent, model2, rules);
    await seatAPI.setMetadata(session.id, { kuvo: { seat: { group: id, bot: bot.id } } }).catch(() => {});
    await seatAPI.setInstruction(session.id, seatKey, text2);
    this.seatTexts.set(session.id, text2);
    this.seatsChecked.add(session.id);
    const after = kept2;
    if (!same() || !after.group.members.includes(bot.id)) {
      await seatAPI.delete(session.id).catch(() => {});
      throw new Cancelled;
    }
    after.group.seats[bot.id] = session.id;
    if (onAgents)
      after.group.agentSeats = [...new Set([...after.group.agentSeats ?? [], session.id])];
    this.changed(id);
    return { seat: session.id, isNew: true };
  }
  async startOver(botID, id) {
    const kept2 = this.chat(id);
    const seat = kept2?.group.seats[botID];
    if (!kept2 || !seat)
      return;
    await this.deleteSeat(seat, kept2.group, botID);
    if (kept2.group.seats[botID] !== seat)
      return;
    delete kept2.group.seats[botID];
    delete kept2.group.heard[botID];
    this.changed(id);
  }
  async scratch(bot, group, api, title) {
    const settings = this.context.store.settings();
    const rules = seatRules(bot.folder, settings?.askFirst ?? false, settings?.denies ?? []);
    const model2 = await this.model(bot);
    const agent = runsWithAgents(model2) && model2?.providerID.split("@")[0] === "cursor" ? "plan" : undefined;
    const session = await api.create(bot.directory, title, agent, model2, rules);
    await api.setMetadata(session.id, { kuvo: { seat: { group: group.id, bot: bot.id, scratch: true } } }).catch(() => {});
    try {
      await api.setInstruction(session.id, seatKey, this.seatText(bot, group));
    } catch (error3) {
      await api.delete(session.id).catch(() => {});
      throw error3;
    }
    return session.id;
  }
  seatText(bot, group) {
    const settings = this.context.store.settings();
    const others = group.members.filter((member) => member !== bot.id).flatMap((member) => this.bot(member) ?? []);
    const lead = this.bot(group.members[0]);
    const personality = bot.personality ? settings?.personalities[bot.personality] : undefined;
    return seatInstructions(bot, group, others, lead, personality, settings?.identityNote ?? "");
  }
  async keepModel(seat, bot, id, api) {
    const model2 = await this.model(bot);
    if (!model2)
      return true;
    const session = await api.session(seat).catch(() => {
      return;
    });
    if (!session)
      return true;
    if (session.model?.id === model2.id && session.model?.providerID === model2.providerID)
      return true;
    const kept2 = this.chat(id);
    if (!kept2)
      return true;
    const onSeatAgents = kept2.group.agentSeats?.includes(seat) ?? false;
    if (onSeatAgents || !runsWithAgents(model2)) {
      await api.selectModel(seat, model2).catch(() => {});
      if (onSeatAgents)
        await api.selectAgent(seat, model2.providerID.split("@")[0] === "cursor" ? "plan" : "build").catch(() => {});
      return true;
    }
    await this.deleteSeat(seat, kept2.group, bot.id);
    delete kept2.group.seats[bot.id];
    delete kept2.group.heard[bot.id];
    this.changed(id);
    return false;
  }
  async deleteSeat(seat, group, botID) {
    const bot = this.bot(botID);
    const api = bot ? await this.seatAPI(bot, group, seat) : new SeatAPI(this.context.engine);
    await api?.delete(seat).catch(() => {});
    const kept2 = this.chats.get(group.id);
    if (kept2?.group.agentSeats?.includes(seat)) {
      kept2.group.agentSeats = kept2.group.agentSeats.filter((each) => each !== seat);
      this.changed(group.id);
    }
  }
  async remember(botID, options = {}) {
    const bot = this.bot(botID);
    if (!bot)
      return;
    const api = this.ownAPI(bot);
    if (!api)
      return;
    const folder = bot.folder + "/groups";
    if (options.forgetting)
      this.context.store.removeFile(`${folder}/${options.forgetting}.md`);
    const chats = [...this.chats.values()].filter((kept2) => kept2.status === "active" && kept2.group.members.includes(botID) && kept2.messages.length > 0).sort((a, b) => Date.parse(b.messages.at(-1)?.time ?? b.group.created) - Date.parse(a.messages.at(-1)?.time ?? a.group.created));
    if (chats.length === 0) {
      await api.removeInstruction(bot.sessionID, memoryKey).catch(() => {});
      return;
    }
    let text2 = `You also take part in group chats in Kuvo Code, with the user and other bots. You remember them as you would a meeting: ` + `a recap of each is below, newest first, and the whole of each is in a file in "${folder}". When the user mentions one of ` + `these chats, or something talked about there, go by this, and read the file when you need more. What's marked ` + `"${bot.name}" is what you said.`;
    for (const [index, kept2] of chats.entries()) {
      const file = `${folder}/${kept2.group.id}.md`;
      if (!options.changed || options.changed === kept2.group.id) {
        try {
          this.context.store.writeFile(file, this.transcript(kept2));
        } catch {}
      }
      if (index >= 4)
        continue;
      const others = kept2.group.members.filter((member) => member !== botID).flatMap((member) => this.bot(member)?.name ?? []);
      text2 += `

## "${kept2.group.name}"${others.length ? " with " + others.join(", ") : ""}, in ${file}
`;
      text2 += this.recap(kept2);
    }
    await api.setInstruction(bot.sessionID, memoryKey, text2).catch(() => {});
  }
  when(time) {
    const settings = this.context.store.settings();
    try {
      return new Intl.DateTimeFormat(settings?.locale ?? "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: settings?.timeZone }).format(new Date(time));
    } catch {
      return time;
    }
  }
  recap(kept2) {
    const discussions = [];
    for (const message of kept2.messages) {
      if (message.kind === "note")
        continue;
      const current = discussions.at(-1);
      if (!current || message.author === undefined && current.at(-1)?.author !== undefined)
        discussions.push([message]);
      else
        current.push(message);
    }
    return discussions.slice(-3).flatMap((discussion) => {
      let asked = 0;
      while (asked < discussion.length && discussion[asked].author === undefined)
        asked++;
      const rest = discussion.slice(asked);
      const wrapUp = [...rest].reverse().find((message) => message.kind === "wrapUp");
      const shown = wrapUp ? [wrapUp] : rest.slice(-4);
      return [...discussion.slice(0, asked), ...shown].map((message) => {
        const segments2 = [...new Intl.Segmenter().segment(message.text)];
        const words = segments2.length > 500 ? segments2.slice(0, 500).map((part) => part.segment).join("") + "\u2026" : message.text;
        return `${label(message, (author) => this.name(author))} \xB7 ${this.when(message.time)}: ${words}`;
      });
    }).join(`
`);
  }
  transcript(kept2) {
    const names = kept2.group.members.flatMap((member) => this.bot(member)?.name ?? []);
    let text2 = `# ${kept2.group.name}

A group chat in Kuvo Code between the user and ${names.join(", ")}.
`;
    for (const message of kept2.messages) {
      if (message.kind === "note")
        text2 += `
_${message.text}_
`;
      else
        text2 += `
**${label(message, (author) => this.name(author))}** \xB7 ${this.when(message.time)}

${message.text}
`;
    }
    return text2;
  }
  rememberSoon(id) {
    const pending = this.syncs.get(id);
    if (pending)
      clearTimeout(pending);
    const timer = setTimeout(() => {
      this.syncs.delete(id);
      const kept2 = this.chat(id);
      if (!kept2)
        return;
      (async () => {
        for (const bot of kept2.group.members)
          await this.remember(bot, { changed: id });
      })().catch(() => {});
    }, 3000);
    timer.unref?.();
    this.syncs.set(id, timer);
  }
  append(message, id) {
    const kept2 = this.chat(id);
    if (!kept2)
      return message;
    kept2.messages.push(message);
    this.context.store.saveMessages(kept2);
    this.keepAwake(id);
    emit("kuvo.group.message", { id, message });
    this.rememberSoon(id);
    return message;
  }
  note(text2, id) {
    this.append({ id: groupMessageID(), text: text2, time: stamp2(), kind: "note" }, id);
  }
  change(messageID2, id, edit) {
    const kept2 = this.chat(id);
    const message = kept2?.messages.find((each) => each.id === messageID2);
    if (!kept2 || !message)
      return;
    edit(message);
    this.context.store.saveMessages(kept2);
    this.keepAwake(id);
    emit("kuvo.group.message", { id, message });
  }
  changeTask(taskID, messageID2, id, edit) {
    this.change(messageID2, id, (message) => {
      const task = message.tasks?.find((each) => each.id === taskID);
      if (task)
        edit(task);
    });
  }
  setHeard(messageID2, botID, id) {
    const kept2 = this.chat(id);
    if (!kept2)
      return;
    const all = kept2.messages;
    const heard = kept2.group.heard[botID];
    const current = heard ? all.findIndex((message) => message.id === heard) : -1;
    const next2 = all.findIndex((message) => message.id === messageID2);
    if (next2 < 0 || next2 <= current)
      return;
    kept2.group.heard[botID] = messageID2;
    this.context.store.saveGroup(kept2);
  }
}
function named2(unheard) {
  const blocks = unheard.slice(-40).filter((message) => message.author === undefined).map((message) => message.named).filter((block) => typeof block === "string" && block.length > 0);
  if (blocks.length <= 1)
    return blocks[0];
  const lines3 = blocks[0].split(`
`);
  const items2 = [...new Set(blocks.flatMap((block) => block.split(`
`).filter((line) => line.startsWith("- "))))];
  const head = lines3.filter((line) => !line.startsWith("- "));
  return [...head.slice(0, -1), ...items2, head.at(-1)].join(`
`);
}
function usableZone(zone2) {
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone2)
    return own;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone2 });
    return zone2;
  } catch {
    return own;
  }
}
var weekdayOf2 = (time, zone2) => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone2, weekday: "short" }).format(new Date(time));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name) + 1;
};

// Agents/src/main.ts
var version3 = "1";
var home2 = process.env.KUVO_AGENTS_HOME;
var password = onMachine ? process.env.KUVO_AGENTS_PASSWORD : process.env.OPENCODE_PASSWORD;
var enginePID = Number(process.env.KUVO_ENGINE_PID);
if (!home2 || !password || onMachine && (!machineHome || !Number(process.env.KUVO_AGENTS_PORT) || !Number(process.env.KUVO_ENGINE_PORT) || !enginePID)) {
  console.error(onMachine ? "KUVO_AGENTS_HOME, KUVO_HOME, KUVO_AGENTS_PORT, KUVO_AGENTS_PASSWORD, KUVO_ENGINE_PORT and KUVO_ENGINE_PID are needed." : "KUVO_AGENTS_HOME and OPENCODE_PASSWORD are needed.");
  process.exit(2);
}
var machineEngine = onMachine ? { url: `http://127.0.0.1:${process.env.KUVO_ENGINE_PORT}`, password: process.env.OPENCODE_PASSWORD } : undefined;
var port = onMachine ? Number(process.env.KUVO_AGENTS_PORT) : 0;
if (onMachine) {
  setToolProgram(process.env.OPENCODE_CONFIG_CONTENT);
  takeOwnFolders();
  if (home2)
    dropCarriedSignIns(home2);
  process.env.KUVO_BIN = join19(machineHome, "bin");
  process.env.KUVO_BOTS ??= join19(machineHome, "bots");
  process.env.KUVO_WAKES ??= join19(machineHome, "wakes");
  for (const name of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CLIENT", "KUVO_AGENTS_PASSWORD", "KUVO_AGENTS_PORT", "KUVO_ENGINE_PORT", "KUVO_ENGINE_PID"])
    delete process.env[name];
}
var temporary = process.env.TMPDIR?.replace(/\/$/, "") || join19(home2, "tmp");
mkdirSync15(temporary, { recursive: true });
rmSync12(join19(temporary, "antigravity"), { recursive: true, force: true });
try {
  for (const name of readdirSync8(join19(home2, "antigravity")))
    if (name.startsWith(".install-"))
      rmSync12(join19(home2, "antigravity", name), { recursive: true, force: true });
} catch {}
delete process.env.BUN_BE_BUN;
process.env.KUVO_WAKE_VIA = "bridge";
delete process.env.OPENCODE_PASSWORD;
process.on("unhandledRejection", (reason3) => console.error("unhandled:", reason3));
process.on("uncaughtException", (error3) => {
  console.error("uncaught:", error3);
  process.exit(1);
});
var deps = new Deps(join19(home2, "runtime"), join19(home2, "cache"));
if (onMachine) {
  dropOwnPrograms(join19(home2, "runtime"));
  refreshLoginPath();
}
rmSync12(join19(home2, "cache", "install"), { recursive: true, force: true });
var context = { home: home2, temporary, deps };
var roster = new Roster(new Accounts(home2), context);
var store = new Store(join19(home2, "sessions"));
var auto = new Auto(home2);
var link2 = new EngineLink;
if (machineEngine)
  link2.configure(machineEngine.url, machineEngine.password);
setSkillSource(link2, home2);
var engineAgents = new Map;
function engineAgent(providerID2) {
  if (!link2.ready || parseProvider(providerID2))
    return;
  let agent = engineAgents.get(providerID2);
  if (!agent)
    engineAgents.set(providerID2, agent = new EngineAgent(link2, providerID2));
  return agent;
}
var sessions = new Sessions(store, roster, auto, engineAgent, (directory) => link2.policies(directory), (name, directory) => link2.agent(name, directory), new Snapshots(join19(home2, "snapshots")), (directory) => link2.titleModel(directory));
var self;
var groups;
if (onMachine) {
  try {
    const store2 = new GroupStore(join19(machineHome, "groups"), process.env.KUVO_BOTS ?? join19(machineHome, "bots"));
    groups = {
      store: store2,
      runner: new GroupRunner({ store: store2, engine: link2, bridge: () => self, trash: join19(machineHome, "trash"), listen: (session, listener) => link2.listen(session, listener) })
    };
  } catch (error3) {
    console.error("group chats:", error3);
  }
}
var server3;
try {
  server3 = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: handler({ roster, sessions, auto, link: link2, password, version: version3, groups })
  });
} catch (error3) {
  console.error("couldn't listen:", error3?.message ?? error3);
  process.exit(onMachine && /in use|EADDRINUSE/i.test(String(error3?.code ?? error3?.message ?? error3)) ? 98 : 1);
}
console.log(JSON.stringify({ url: `http://127.0.0.1:${server3.port}` }));
self = server2(`http://127.0.0.1:${server3.port}`, password);
try {
  groups?.runner.start();
} catch (error3) {
  console.error("group chats:", error3);
}
var record = onMachine ? join19(machineHome, "run", "bridge.json") : undefined;
if (record) {
  writeFileSync13(record + ".new", JSON.stringify({ pid: process.pid, port: server3.port, password }), { mode: 384 });
  renameSync7(record + ".new", record);
}
var stopping = false;
function stop() {
  if (stopping)
    return;
  stopping = true;
  cancelSignIns();
  try {
    if (record && JSON.parse(readFileSync18(record, "utf8")).pid === process.pid)
      rmSync12(record, { force: true });
  } catch {}
  sessions.closeAll();
  store.flush();
  server3.stop(true);
  process.exit(0);
}
if (onMachine) {
  setInterval(() => {
    try {
      process.kill(enginePID, 0);
    } catch {
      stop();
    }
  }, 5000);
} else {
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// Built from Agents/src 4ab791e82ebdc0a6d4ea5ef87f30f4472e7730d2682f77bcc19bbf6a1a79a77e
