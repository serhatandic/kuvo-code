// Kuvo Code's SSH agent, as OpenSSH's own tools use it: `ssh-add -l` lists the keys a conversation
// may use, and `ssh-keygen -Y sign` signs through it (as `ssh` and git over SSH do), with a key in
// each of the formats `ssh-keygen` writes. Its keys come from the vault in the box; here, from the
// files `ssh-keygen` made, with the vault's say on each signature stood in for.
import "./safety"
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { type AgentKey, privateKeyOf, serveAgent } from "../src/link/vault/ssh-agent";

// A short path: a socket's is at most 104 bytes on macOS.
const root = fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? "/tmp" : os.tmpdir(), "kv-ssh-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const envOf = (env: Record<string, string>) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ...env });
const ssh = (tool: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(tool, args, { env: envOf(env), encoding: "utf8" });
// Run while the agent answers, in this same process: never blocking it.
function sshNow(tool: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(tool, args, { env: envOf(env) });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };

// A key as `ssh-keygen` makes it: its private key's text, and its public key's file.
function made(name: string, ...args: string[]): { text: string; pub: string } {
  const file = path.join(root, name);
  const run = ssh("ssh-keygen", ["-q", "-N", "", "-C", name, "-f", file, ...args]);
  expect(run.status, run.stderr).toBe(0);
  const pub = path.join(root, `${name}-only.pub`);
  fs.renameSync(`${file}.pub`, pub);
  const text = fs.readFileSync(file, "utf8");
  fs.rmSync(file);
  return { text, pub };
}

const keys = {
  ed25519: made("ed25519", "-t", "ed25519"),
  rsa: made("rsa", "-t", "rsa", "-b", "2048"),
  ecdsa256: made("ecdsa256", "-t", "ecdsa", "-b", "256"),
  ecdsa384: made("ecdsa384", "-t", "ecdsa", "-b", "384"),
  ecdsa521: made("ecdsa521", "-t", "ecdsa", "-b", "521"),
  rsaPEM: made("rsa-pem", "-t", "rsa", "-b", "2048", "-m", "PEM"),
};

function agentFor(names: (keyof typeof keys)[], allowed: (key: AgentKey) => boolean = () => true) {
  const socket = path.join(root, `agent-${Math.random().toString(36).slice(2, 8)}.sock`);
  const offered: AgentKey[] = names.map(name => ({ id: name, name, ...privateKeyOf(keys[name].text) }));
  const asked: string[] = [];
  const server = serveAgent(socket, {
    keys: async () => offered,
    allow: async key => { asked.push(key.name); return allowed(key); },
  });
  return { socket, asked, ready: new Promise(resolve => server.once("listening", resolve)), close: () => new Promise(resolve => server.close(resolve)) };
}

// Signs a file through the agent, by the public key alone, and checks the signature as anyone would.
async function signs(socket: string, name: keyof typeof keys): Promise<boolean> {
  const file = path.join(root, `signed-${name}`);
  fs.writeFileSync(file, "a commit\n");
  const signed = await sshNow("ssh-keygen", ["-Y", "sign", "-n", "git", "-f", keys[name].pub, file], { SSH_AUTH_SOCK: socket });
  if (signed.status !== 0) return false;
  const signers = path.join(root, `allowed-${name}`);
  fs.writeFileSync(signers, `kuvo@test ${fs.readFileSync(keys[name].pub, "utf8").split(" ").slice(0, 2).join(" ")}\n`);
  const checked = await sshNow("ssh-keygen", ["-Y", "verify", "-f", signers, "-I", "kuvo@test", "-n", "git", "-s", `${file}.sig`], {}, "a commit\n");
  fs.rmSync(`${file}.sig`, { force: true });
  return checked.status === 0;
}

test("ssh-add lists the conversation's keys, by the same fingerprints ssh-keygen gives them", async () => {
  const agent = agentFor(["ed25519", "rsa", "ecdsa256"]);
  await agent.ready;
  try {
    const listed = await sshNow("ssh-add", ["-l"], { SSH_AUTH_SOCK: agent.socket });
    expect(listed.status, listed.stderr).toBe(0);
    for (const name of ["ed25519", "rsa", "ecdsa256"] as const) {
      const fingerprint = ssh("ssh-keygen", ["-l", "-f", keys[name].pub]).stdout.split(" ")[1];
      expect(listed.stdout).toContain(fingerprint);
    }
    expect(agent.asked).toEqual([]);
  } finally {
    await agent.close();
  }
});

test("each kind of key ssh-keygen makes signs through it, and the signature checks out", async () => {
  const names = Object.keys(keys) as (keyof typeof keys)[];
  const agent = agentFor(names);
  await agent.ready;
  try {
    const signed: Record<string, boolean> = {};
    for (const name of names) signed[name] = await signs(agent.socket, name);
    expect(signed).toEqual(Object.fromEntries(names.map(name => [name, true])));
  } finally {
    await agent.close();
  }
});

test("a key the vault doesn't let it use now signs nothing, and one it doesn't offer isn't there", async () => {
  const agent = agentFor(["ed25519"], () => false);
  await agent.ready;
  try {
    expect(await signs(agent.socket, "ed25519")).toBe(false);
    expect(agent.asked).toEqual(["ed25519"]);
    expect(await signs(agent.socket, "rsa")).toBe(false);
    expect((await sshNow("ssh-add", ["-D"], { SSH_AUTH_SOCK: agent.socket })).status).not.toBe(0);
  } finally {
    await agent.close();
  }
});

test("a key with a passphrase, or that isn't a key, says what to do", () => {
  const file = path.join(root, "locked");
  ssh("ssh-keygen", ["-q", "-N", "a passphrase", "-t", "ed25519", "-f", file]);
  expect(() => privateKeyOf(fs.readFileSync(file, "utf8"))).toThrow(/passphrase/);
  expect(() => privateKeyOf("not a key")).toThrow(/isn't a private key/);
});

test("a command that sends a flood of sign requests is cut off, rather than asking the user for each", async () => {
  const agent = agentFor(["ed25519"]);
  await agent.ready;
  try {
    const { blob } = privateKeyOf(keys.ed25519.text);
    const one = (() => {
      const parts = [Buffer.from([13]), u32(blob.length), blob, u32(4), Buffer.from("data"), u32(0)];
      const body = Buffer.concat(parts);
      return Buffer.concat([u32(body.length), body]);
    })();
    const replies = await new Promise<number>(resolve => {
      const connection = net.connect(agent.socket, () => connection.write(Buffer.concat(Array(500).fill(one))));
      let got = 0;
      connection.on("data", chunk => { got += chunk.length; });
      connection.on("error", () => {});
      // (Ended by the agent: Bun's client hears the end before it gives up what it still had to write.)
      connection.on("end", () => { resolve(got); connection.destroy(); });
      connection.on("close", () => resolve(got));
    });
    expect(agent.asked.length).toBeLessThanOrEqual(4);
    expect(replies).toBeLessThan(500 * 8);
    // And the agent still answers the next command.
    expect(await signs(agent.socket, "ed25519")).toBe(true);
  } finally {
    await agent.close();
  }
});

test("its socket is yours alone from the moment it's there, never for a moment anyone's", async () => {
  const agent = agentFor(["ed25519"]);
  expect(fs.statSync(agent.socket).mode & 0o777).toBe(0o600);
  await agent.ready;
  await agent.close();
});

// The launcher looks for the agent's socket by its name; what waits for it by watching its folder (as
// the vault's own tests do) hears of it on macOS too, which never tells a watch of a socket being
// bound there. Closed, its socket is gone, so no command is handed one nothing answers.
test("a watch on its folder hears of its socket, and a closed agent leaves none behind", async () => {
  const folder = fs.mkdtempSync(path.join(root, "w-"));
  const socket = path.join(folder, "agent.sock");
  const heard = new Set<string>();
  let changed = () => {};
  const watch = fs.watch(folder, (_, name) => {
    heard.add(String(name));
    changed();
  });
  const heardOf = (name: string) => new Promise<void>(resolve => {
    const look = () => (heard.has(name) ? resolve() : void (changed = look));
    look();
  });
  // (A watch starts a moment after it's made: once it hears a file of the test's, it's watching.)
  fs.writeFileSync(path.join(folder, "probe"), "");
  await heardOf("probe");
  fs.rmSync(path.join(folder, "probe"));
  const server = serveAgent(socket, { keys: async () => [], allow: async () => false });
  await new Promise(resolve => server.once("listening", resolve));
  await heardOf("agent.sock");
  watch.close();
  expect(fs.statSync(socket).isSocket()).toBe(true);
  expect(fs.readdirSync(folder)).toEqual(["agent.sock"]);
  await new Promise(resolve => server.close(resolve));
  expect(fs.readdirSync(folder)).toEqual([]);
});

test("a socket the agent can't open is an error on it, never a crash of the box", async () => {
  const server = serveAgent(path.join(root, "x".repeat(200) + ".sock"), { keys: async () => [], allow: async () => false });
  const error = await new Promise<Error>(resolve => server.once("error", resolve));
  expect(error.message).toMatch(/can't be this long/);
  const missing = serveAgent(path.join(root, "no-such-folder", "a.sock"), { keys: async () => [], allow: async () => false });
  expect((await new Promise<Error & { code?: string }>(resolve => missing.once("error", resolve))).code).toBe("ENOENT");
});
