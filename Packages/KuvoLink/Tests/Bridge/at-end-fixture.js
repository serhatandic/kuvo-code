// A test file for at-end.test.js, run on its own by it (`AT_END_FIXTURE` says which way it
// cleans up, `AT_END_FOLDER` is its folder): a process it starts, as a box would be, and a server.
import { test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { atEnd, removeAtEnd } from "./at-end.js";

const folder = process.env.AT_END_FOLDER;
const how = process.env.AT_END_FIXTURE;
removeAtEnd(folder);
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
// Runs until it's stopped, writing in the folder as it starts.
const child = spawn(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(path.join(folder, "run", "pid"))}, String(process.pid)); process.stdin.resume()`], { env, stdio: ["pipe", "ignore", "ignore"] });
const server = http.createServer((request, response) => response.end());
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

if (how === "clean") {
  atEnd(() => child.kill());
  atEnd(() => server.close());
} else if (how === "a step fails") {
  atEnd(() => new Promise(resolve => { child.once("close", resolve); child.kill(); }));
  // (Between the two: whichever way they run, one comes after it.)
  atEnd(() => { throw new Error("a step that fails"); });
  atEnd(() => server.close());
} else if (how === "held") {
  atEnd(() => new Promise(resolve => { child.once("close", resolve); child.kill(); }));
  atEnd(() => server.close());
  // A socket server, like a stand-in for the browser's keeper, and a process the file doesn't hold
  // (one a box started on its own, say) connected to it: closing the server leaves the connection.
  const keeper = net.createServer(() => {});
  const socket = path.join(folder, "run", "keeper.sock");
  await new Promise(resolve => keeper.listen(socket, resolve));
  const connected = new Promise(resolve => keeper.once("connection", resolve));
  const stray = spawn(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(path.join(folder, "stray"))}, String(process.pid)); require("net").createConnection(${JSON.stringify(socket)})`], { env, detached: true, stdio: "ignore" });
  stray.unref();
  await connected;
  atEnd(() => keeper.close());
}
// "left": neither stopped.

test("it started", async () => {
  while (!fs.existsSync(path.join(folder, "run", "pid"))) await new Promise(resolve => setImmediate(resolve));
});
