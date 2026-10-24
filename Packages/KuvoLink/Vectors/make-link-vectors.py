#!/usr/bin/env python3
"""Writes link.json: addresses, relay messages, link frames and session messages, worked out
here independently of the Swift and JavaScript implementations, which both check against it."""
import base64, hashlib, json, re, struct, urllib.parse

def address(secret):
    return hashlib.sha256(b"kuvo-link address v1" + secret).digest()[:16]

secrets = [bytes(range(32)), bytes([0xff] * 32), hashlib.sha256(b"kuvo").digest()]
addresses = [{"secret": s.hex(), "address": address(s).hex()} for s in secrets]
a, b = address(secrets[0]), address(secrets[1])

relay = [
    {"name": "hello", "from": "device", "bytes": (b"\x01" + secrets[0]).hex()},
    {"name": "welcome", "from": "relay", "address": a.hex(), "bytes": (b"\x01" + a).hex()},
    {"name": "send", "from": "device", "to": b.hex(), "payload": "68656c6c6f", "bytes": (b"\x02" + b + b"hello").hex()},
    {"name": "deliver", "from": "relay", "address": a.hex(), "payload": "68656c6c6f", "bytes": (b"\x02" + a + b"hello").hex()},
    {"name": "unreachable", "from": "relay", "address": b.hex(), "bytes": (b"\x03" + b).hex()},
    {"name": "pushed", "from": "relay", "address": b.hex(), "status": 2, "bytes": (b"\x06" + b + b"\x02").hex()},
]

frames = [
    {"kind": kind, "session": session, "body": body.hex(), "bytes": (bytes([kind]) + struct.pack(">I", session) + body).hex()}
    for kind, session, body in [(1, 1, b"\x00" * 3), (3, 0xDEADBEEF, b"ciphertext"), (4, 42, b""), (5, 0, b"mail")]
]

def message(head, body):
    encoded = json.dumps(head, separators=(",", ":"), sort_keys=True).encode()
    return {"head": head, "body": body.hex(), "bytes": (struct.pack(">H", len(encoded)) + encoded + body).hex()}

messages = [
    message({"t": "req", "id": 1, "m": "GET", "p": "api/session?limit=50", "h": {"x-opencode-directory": "/home/me/p"}, "end": True}, b""),
    message({"t": "res", "id": 1, "s": 200, "h": {"content-type": "application/json"}, "end": True}, b'[{"id":"ses_1"}]'),
    message({"t": "data", "id": 7, "end": False}, b"data: {}\n\n"),
    message({"t": "cancel", "id": 7}, b""),
    message({"t": "ping"}, b""),
]

# Paths a phone may send an engine, through a Mac or a machine (what each gets: below).
routes = [{"path": p, "allowed": a} for p, a in [
    ("api/session", True), ("api/session?limit=50&order=desc", True), ("api/session/ses_1/prompt", True),
    ("api/session/active", True), ("api/event", True), ("api/event?x=1", True), ("api/info", True),
    ("api/provider", True), ("api/model/default", True), ("api/permission/saved", True), ("api/form", True),
    ("api/experimental/session/ses_1/wait", True), ("api/experimental/session/ses_1/instructions/entries/k", False),
    ("api/credential", False), ("api/credential/anthropic", False), ("api/integration/github/connect/key", False),
    ("api/integration", True), ("api/integration/github-copilot", True),
    ("api/config", False), ("api/config/shell", False), ("api/mcp", False), ("api/plugin", False),
    ("api/fs/list", True), ("api/fs/list?path=Sources", True), ("api/fs/find?query=main", True),
    ("api/fs/read/Sources/main.swift", True), ("api/fs/read", False), ("api/fs/write/x", False), ("api/fs/read/../../etc/hosts", False),
    ("api/fs/list?path=%2E%2E", False), ("api/fs/list?path=..%2F", False), ("api/fs/read/%2e%2e%2fsecret", False),
    ("api/session/%2E%2E/credential", False), ("api/session/%2e%2e/credential", False), ("api/session%2f..%2fcredential", False),
    ("api/session/.\t./.\t./api/credential", False), ("api/session/.\n./.\r./api/config", False), ("api/session/x\x7f", False),
    ("api/session#/../credential", False),
    # A sign joined with a mark after it (one character to some checks): still that sign to URL parsers.
    ("api/experimental/session/import#\u0301/wait", False), ("api/session/ses_1#\u0301/../../credential", False),
    ("api/fs/read/Re\u0301sume\u0301.txt", True),
    # The same, encoded: ".." with a joining mark after it, once decoded.
    ("api/session/%2e%2e\u200d/credential", False), ("api/session/%2e%2e\u0301/credential", False),
    # A space at either end, which URL parsers drop.
    ("api/session/ses_1/prompt ", False), (" api/session", False), ("api/fs/read/a%20b.txt", True),
    ("api/fs/read/..%5c..%5csecret", False), ("api/fs/read/a%5cb", False), ("api/fs/read/bad%E0%A4%A", False),
    ("api/sessions", False), ("api/eventual", False), ("api/session/../credential", False), ("kuvo/info", False), ("", False),
    ("api/pty", True), ("api/pty?location[directory]=x", True), ("api/pty/pty_1", True), ("api/pty/pty_1/connect-token", True),
    ("api/ptys", False), ("api/pty/%2e%2e/x", False), ("api/experimental/persistent-pty/pty_1", False),
    ("api/shell", True), ("api/shell/sh_1", True), ("api/shell/sh_1/output?cursor=0&limit=1", True),
    ("api/shell/../config", False), ("api/shell/sh_1/x", False), ("api/shells", False),
]]
# Commands the engine runs for agents, by method.
routes += [{"path": p, "allowed": a, "method": m} for p, a, m in [
    ("api/shell", False, "POST"), ("api/shell/sh_1", False, "DELETE"), ("api/shell/sh_1/output", True, "GET"),
]]

# Plan accounts and their keys, by method.
routes += [{"path": p, "allowed": a, "method": m} for p, a, m in [
    ("api/integration", True, "GET"), ("api/integration?fresh=1", True, "GET"), ("api/integration/github-copilot", True, "GET"),
    ("api/integration/anthropic/connect/key", True, "POST"), ("api/integration/github-copilot/connect/oauth", True, "POST"),
    ("api/integration/github-copilot/connect/oauth/att_1", True, "GET"), ("api/integration/gitlab/connect/oauth/att_1/complete", True, "POST"),
    ("api/integration/gitlab/connect/oauth/att_1", True, "DELETE"), ("api/credential/cred_1/activate", True, "POST"),
    ("api/credential/cred_1", True, "DELETE"), ("api/integration/openai@work/connect/key", True, "POST"),
    ("api/credential", False, "GET"), ("api/credential/cred_1", False, "GET"), ("api/credential", False, "POST"),
    ("api/credential?x=1", False, "GET"), ("api/credential/cred_1/activate", False, "GET"), ("api/credential/cred_1/x", False, "DELETE"),
    ("api/integration/anthropic/update", False, "POST"), ("api/integration/anthropic/connect/external", False, "POST"),
    ("api/integration/anthropic/connect/%6bey", False, "POST"), ("api/integration/anthropic//connect/key", False, "POST"),
    ("api/integration/./connect/key", False, "POST"), ("api/integration/anthropic/connect/key/x", False, "POST"),
    ("api/integration/anthropic/connect/key?x=1", False, "POST"), ("api/integration/anthropic", False, "DELETE"),
    ("api/integration/anthropic", False, "PATCH"), ("api/integration/anthropic/connect/key", False, "GET"),
    ("api/integration/anthropic/connect/key", False, "PUT"), ("api/integration/../credential", False, "GET"),
    ("api/integration/%2e%2e/credential", False, "GET"), ("api/integration/anthropic/connect/oauth/att_1/complete ", False, "POST"),
    ("api/integration/a#/../../credential", False, "GET"), ("api/credential/.hidden", False, "DELETE"),
]]

# The sockets a phone may open (PROTOCOL.md, "Sockets"): a terminal's.
sockets = [{"path": p, "allowed": a} for p, a in [
    ("api/pty/pty_1/connect", True), ("api/pty/pty_1/connect?cursor=0", True),
    ("api/pty/pty_1", False), ("api/pty", False), ("api/event", False), ("api/pty/pty_1/connect/x", False),
    ("api/pty/a/b/connect", False), ("api/pty/%2e%2e/connect", False), ("api/pty/..%5cx/connect", False),
    ("api/experimental/persistent-pty/pty_1/connect", False), ("api/session/ses_1/connect", False),
    ("api/pty/%2e%2e\u200d/connect", False),
]]

# Paths a phone may send the coding agents' bridge, on a Mac or a machine (`kuvo/agents/api/…`,
# without the prefix), however where the engine is is written.
agent_routes = [{"path": p, "allowed": a, "method": m} for p, a, m in [
    ("api/session/ses_1/prompt", True, "POST"), ("api/session", True, "GET"), ("api/event", True, "GET"),
    ("api/integration", True, "GET"), ("api/integration/claude-code@1f2e/connect/oauth", True, "POST"),
    ("api/kuvo/auto", True, "PUT"), ("api/kuvo/auto/limits", True, "DELETE"), ("api/kuvo/accounts", True, "POST"),
    ("api/kuvo/accounts/codex-cli@9a8b", True, "PATCH"), ("api/model", True, "GET"),
    ("api/kuvo/engine", False, "PUT"), ("api/kuvo/%65ngine", False, "GET"), ("api/kuvo//engine", False, "POST"),
    ("api/integration/claude-code/update", False, "POST"), ("api/integration/claude-code/%75pdate", False, "POST"),
    ("api/integration/claude-code//update", False, "POST"), ("api/integration/claude-code/./update", False, "POST"),
    ("api/integration/claude-code/%2e/update", False, "POST"), ("api/integration//claude-code/update", False, "POST"),
    ("api/integration/claude-code/update/", False, "POST"), ("api/integration/claude-code/update#x", False, "POST"),
    ("api/kuvo/engine#", False, "POST"), ("api/fs/read/../../etc/passwd", False, "GET"), ("api/credential", False, "GET"),
    ("api/config", False, "GET"), ("api/kuvo/other", False, "GET"), ("api/shell", False, "POST"),
    ("api/integration/claude-code/update ", False, "POST"), (" api/kuvo/engine", False, "PUT"),
    ("api/kuvo/engine  ", False, "PUT"),
    # A sign with a mark after it: parts are split on bytes, so "?\u0301" is a query of "%CC%81",
    # sent as that, and "/\u0301" a part of its own.
    ("api/integration/claude-code/update#\u0301", False, "POST"), ("api/integration/claude-code/update?\u0301", False, "POST"),
    ("api/integration/claude-code/update/\u0301", False, "POST"), ("api/kuvo/engine#\u200d", False, "PUT"),
    ("api/integration/claude-code/update%3F\u0301", False, "POST"),
]]

# A paired phone is yours: the engine's whole API, as the app has it (accounts and keys, settings,
# MCP servers, commands included), with only a path that isn't what it seems refused; and the
# same of the coding agents' bridge, but for where the engine is and its group chats' own steps.
# The paths above are kept; what each should get, and what's sent for it (`forwarded`), is worked
# out here, by that rule: the path is written one way only, and that's both what's checked and
# what's sent. Each part between slashes, and each name and value in its query ("+" a space
# there), is percent-decoded once and encoded again as below; empty parts are left out. Refused:
# a fragment or a space at either end, an escape that doesn't decode, a part that holds a
# backslash or a control character, a part between slashes that holds a slash or is "." or "..",
# and a name or value in the query with a ".." between its slashes (only ASCII counts in both, so
# a mark or joiner hides neither).
PATH_PLAIN = "-._~!$&'()*+,;=:@"
QUERY_PLAIN = "-._~!$()*,;:@/?"

def percent_decoded(path):
    if re.search(r"%(?![0-9A-Fa-f]{2})", path):
        return None
    try:
        return urllib.parse.unquote_to_bytes(path).decode("utf-8")
    except UnicodeDecodeError:
        return None

def decoded_part(raw):
    text = percent_decoded(raw)
    if text is None or "\\" in text or any(ord(c) < 0x20 or ord(c) == 0x7F for c in text):
        return None
    return text

def ascii_of(text):
    return "".join(c for c in text if ord(c) < 0x80)

def canonical(path):
    if "#" in path or path.startswith(" ") or path.endswith(" "):
        return None
    head, _, query = path.partition("?")
    parts = []
    for raw in filter(None, head.split("/")):
        part = decoded_part(raw)
        if part is None or "/" in part or ascii_of(part) in (".", ".."):
            return None
        parts.append(urllib.parse.quote(part, safe=PATH_PLAIN))
    fields = []
    for raw in filter(None, query.split("&")):
        halves = [decoded_part(half) for half in raw.replace("+", " ").split("=", 1)]
        if None in halves or any(ascii_of(piece) == ".." for half in halves for piece in half.split("/")):
            return None
        fields.append("=".join(urllib.parse.quote(half, safe=QUERY_PLAIN) for half in halves))
    return "/".join(parts) + ("?" + "&".join(fields) if fields else "")

def phone_may(path):
    sent = canonical(path)
    return sent is not None and re.match(r"api(/|\?|$)", sent) is not None

def agents_may(path):
    return phone_may(path) and re.match(r"api/kuvo/(engine|groups)(/|\?|$)", canonical(path)) is None

agent_routes += [{"path": p, "allowed": False, "method": m} for p, m in [
    ("api/kuvo/groups", "GET"), ("api/kuvo/groups/grp_x/release", "POST"), ("api/kuvo/%67roups", "GET"),
]]
# Written another way, each is sent one way only. Twice-encoded is a name with an escape in it
# (the engine and the agents' bridge decode once), and a slash encoded inside a part is refused.
routes += [{"path": p, "allowed": None} for p in [
    "api/fs/read/%252e%252e/secret", "api/fs/read/%252e%252e%252fsecret", "api/fs/list?path=%252e%252e",
    "api/session%2F..%2Fcredential", "api/session/%2E%2E%2fcredential", "api/fs/read/a%2Fb", "api/fs/read/%2e",
    "api/fs/read/.%2E/secret", "api/fs/list?path=Sources%2F..%2F..", "api/fs/list?path=..", "api/fs/read/a%09b",
    "api/fs/read/a%20", "api/fs/read/100%.txt", "api/fs/read/100%25.txt", "api/fs/read/.hidden/x",
    "api/fs/read/it's (1).txt", "api/integration/%6Fpenai%40work/connect/key", "api/session/ses_1/", "api//session",
    "api/session?", "api/session?limit=50&&order=desc", "api/fs/find?query=a+b&limit=5", "api/fs/find?query=a%2Bb",
    "api/fs/list?path=Sources/App", "api/fs/find?query=it's", "api/fs/find?query=x=y", "%61pi/session",
    # Names with dots or spaces in them, which are names (a Next.js catch-all folder, say).
    "api/fs/read/app/blog/%5B...slug%5D/page.tsx", "api/fs/read/app/blog/[...slug]/page.tsx",
    "api/fs/list?path=app/blog/%5B...slug%5D", "api/fs/find?query=...", "api/fs/read/a..b.txt", "api/fs/list?path=.",
    "api/fs/read/Old%20/a.txt", "api/fs/read/%20notes.txt",
    # ".." with a joiner or a mark around it, which only the ASCII in it counts for.
    "api/fs/read/..%E2%80%8D/x", "api/fs/read/%E2%80%8D../x", "api/fs/list?path=src/..%CC%81", "api/fs/read/%2E%E2%80%8D/x",
]]
agent_routes += [{"path": p, "allowed": None, "method": m} for p, m in [
    ("api/kuvo/%2565ngine", "PUT"), ("api/kuvo/engine%2F", "PUT"), ("api/kuvo%2Fengine", "PUT"), ("api/kuvo/%2e/engine", "PUT"),
    ("api/kuvo/engine/", "PUT"), ("api/kuvo/engine?x=1", "PUT"), ("api/kuvo/%2567roups", "GET"), ("api//kuvo/engine", "PUT"),
]]
sockets += [{"path": p, "allowed": a} for p, a in [
    ("api/pty/pty%5F1/connect", True), ("api/pty//pty_1/connect", True), ("api/pty/a%2Fb/connect", False), ("api/pty/%2e/connect", False),
]]
for item in routes:
    item["allowed"] = phone_may(item["path"])
for item in agent_routes:
    item["allowed"] = agents_may(item["path"])
for item in routes + agent_routes + sockets:
    if item["allowed"]:
        item["forwarded"] = canonical(item["path"])
        # Written once, it stays as it is.
        assert canonical(item["forwarded"]) == item["forwarded"]
# What that rule says of a few, as meant.
assert phone_may("api/credential") and phone_may("api/config") and phone_may("api/shell") and phone_may("api/integration/x/update")
assert not phone_may("api/session/../credential") and not phone_may("kuvo/info") and not phone_may("api/session/%2e%2e\u200d/x")
assert not agents_may("api/kuvo/engine") and not agents_may("api/kuvo/%65ngine") and not agents_may("api/kuvo/groups/x")
assert agents_may("api/integration/claude-code/update") and agents_may("api/integration/claude-code/install") and agents_may("api/kuvo/auto")
assert canonical("api/integration/claude-code/%75pdate") == "api/integration/claude-code/update"
assert canonical("api/fs/read/%252e%252e/x") == "api/fs/read/%252e%252e/x" and canonical("api/fs/find?query=a+b") == "api/fs/find?query=a%20b"
assert canonical("api/pty?location[directory]=x") == "api/pty?location%5Bdirectory%5D=x"
for item in sockets:
    assert (canonical(item["path"]) is not None and re.match(r"api/pty/[^/?]+/connect(\?|$)", canonical(item["path"])) is not None) == item["allowed"], item

# Where a sign-in's page sends the browser back to the computer (`kuvo/sign-in/return`), which
# the phone hands it to load there: only this computer's own address (127.0.0.1, localhost, [::1])
# over http, at a port, with what the page sent back (a query), written plainly and in lowercase,
# in the characters an address may have as it is (RFC 3986), so nothing re-encodes it on the way.
# What's loaded is the address without a fragment, which the browser wouldn't send.
returns = [{"url": u} for u in [
    "http://127.0.0.1:19876/mcp/oauth/callback?code=abc&state=xyz", "http://localhost:1455/auth/callback?code=a.b-c_d~e&state=1",
    "http://[::1]:8080/cb?code=x", "http://127.0.0.1:19876/?code=x", "http://127.0.0.1:19876?code=x", "http://127.0.0.1:65535/cb?error=access_denied",
    "http://127.0.0.1:19876/cb?code=x#_=_", "http://127.0.0.1:19876/cb?code=%2F%3D", "http://127.0.0.1:1/cb?code=x",
    "http://127.0.0.1:19876/cb", "http://127.0.0.1:19876/cb?", "http://127.0.0.1/cb?code=x", "http://127.0.0.1:0/cb?code=x",
    "http://127.0.0.1:65536/cb?code=x", "http://127.0.0.1:019876/cb?code=x", "https://127.0.0.1:19876/cb?code=x", "HTTP://127.0.0.1:19876/cb?code=x",
    "http://LOCALHOST:19876/cb?code=x", "http://127.0.0.2:19876/cb?code=x", "http://example.com:19876/cb?code=x",
    "http://127.0.0.1.example.com:19876/cb?code=x", "http://localhost.example.com:80/cb?code=x", "http://me@127.0.0.1:19876/cb?code=x",
    "http://127.0.0.1:19876@example.com/cb?code=x", "http://127.0.0.1:19876\\@example.com/cb?code=x", "http://127.0.0.1:19876/cb?code=a b",
    "http://127.0.0.1:19876/cb?code=x\n", " http://127.0.0.1:19876/cb?code=x", "http://127.0.0.1:19876/cb?code=x ", "http://127.0.0.1:19876/c\\b?code=x",
    "http://127.0.0.1:19876/cb?code=\u00e9", "http://0x7f000001:19876/cb?code=x", "http://2130706433:19876/cb?code=x", "http://[::ffff:127.0.0.1]:19876/cb?code=x",
    "http://127.0.0.1:19876#?code=x", "http://127.0.0.1:19876/cb#x?code=y", "//127.0.0.1:19876/cb?code=x", "127.0.0.1:19876/cb?code=x", "",
    "http://127.0.0.1:1/cb?code=x#", "http://127.0.0.1:19876/a@b?code=x", "http://127.0.0.1:19876/cb?#x",
    # Only what an address may hold as it is: a `%` with two hex digits after it, no brackets or
    # quotes past the host, which a URL parser would encode (and a `%2F` with them, again).
    "http://127.0.0.1:19876/cb?code=a%2Fb&x=[1]", "http://127.0.0.1:19876/cb?code=a%2Fb&x=1", "http://127.0.0.1:19876/cb?code=50%",
    "http://127.0.0.1:19876/cb?code=%zz", "http://127.0.0.1:19876/cb?code=a|b", "http://127.0.0.1:19876/cb?code={x}", "http://127.0.0.1:19876/cb?code=a^b",
    "http://127.0.0.1:19876/cb?code=`x`", "http://127.0.0.1:19876/cb?code=\"x\"", "http://127.0.0.1:19876/cb?code=<x>", "http://127.0.0.1:19876/c[b]?code=x",
    "http://127.0.0.1:19876/cb?code=a'b(c)*!$,;:@/?~", "http://127.0.0.1:19876/cb?code=x#frag|ment[1]", "http://127.0.0.1:19876/cb%7C?code=x",
    "http://127.0.0.1:19876/cb?code=x" + "a" * 8200,
]]

def loads(url):
    # Worked out apart from the bridge's and the Mac's pattern: split as URL parsers do, then held
    # to the rule above.
    if len(url) > 8192 or any(not ("!" <= c <= "~") or c == "\\" for c in url) or not url.startswith("http://"):
        return None
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "http" or "@" in parts.netloc or not parts.query:
        return None
    plain = lambda text: re.fullmatch(r"(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*", text) is not None
    if not plain(parts.path) or not plain(parts.query):
        return None
    host, _, port = parts.netloc.rpartition(":")
    if host not in ("127.0.0.1", "localhost", "[::1]") or not re.fullmatch(r"[1-9][0-9]{0,4}", port) or int(port) > 65535:
        return None
    return urllib.parse.urlunsplit(("http", parts.netloc, parts.path, parts.query, ""))

for item in returns:
    item["loads"] = loads(item["url"])
assert loads("http://127.0.0.1:19876/cb?code=x#_=_") == "http://127.0.0.1:19876/cb?code=x"
assert loads("http://[::1]:8080/cb?code=x") and loads("http://127.0.0.1:19876?code=x") == "http://127.0.0.1:19876?code=x"
assert not loads("http://127.0.0.1:19876/cb") and not loads("http://me@127.0.0.1:19876/cb?code=x") and not loads("http://127.0.0.1/cb?code=x")
assert loads("http://127.0.0.1:19876/cb?code=a%2Fb&x=1") and not loads("http://127.0.0.1:19876/cb?code=a%2Fb&x=[1]") and not loads("http://127.0.0.1:19876/cb?code=50%")

# A box's paired phones (PROTOCOL.md, "Paired phones"): a pairing adds one, and a removal, from a
# phone on the list or a Mac that set the box up, takes its pairing off for good. Only a pairing of
# its own (a new pairing id) lets a removed phone back in; nobody removes a Mac. Each Mac's list adds
# and removes only the phones it listed. Worked out here, step by step, apart from the bridge's and
# the Mac's.
KEY = re.compile(r"[A-Za-z0-9_-]{43}")
PAIRING = re.compile(r"[A-Za-z0-9_-]{0,32}")
MOST_AT_ONCE, MOST_KEPT = 16, 256

def k(name):
    return base64.urlsafe_b64encode(hashlib.sha256(name.encode()).digest()).decode().rstrip("=")

def removed_already(book, key, pairing):
    return any(r == {"key": key, "pairing": pairing} for r in book["removed"])

def note_removed(book, key, pairing):
    if not removed_already(book, key, pairing):
        book["removed"].append({"key": key, "pairing": pairing})
        book["removed"] = book["removed"][-MOST_KEPT:]

def take_off(book, key, pairing):
    current = next((p for p in book["phones"] if p["key"] == key), None)
    pairing = current["pairing"] if pairing is None and current else (pairing or "")
    note_removed(book, key, pairing)
    # One paired again since (another pairing) stays.
    if current and current["pairing"] == pairing:
        book["phones"] = [p for p in book["phones"] if p["key"] != key]

def fits(entry, macs):
    return KEY.fullmatch(entry.get("key") or "") and entry["key"] not in macs and PAIRING.fullmatch(entry.get("pairing") or "")

def book_pair(book, step):
    # A new pairing: what removed the phone's others still keeps them out.
    book["phones"] = [p for p in book["phones"] if p["key"] != step["key"]] + [{"key": step["key"], "pairing": step["pairing"], "from": "pair"}]
    return True

def book_remove(book, step):
    allowed = {p["key"] for p in book["phones"]} | set(book["macs"])
    entries = step["phones"]
    if step["by"] not in allowed or not entries or len(entries) > MOST_AT_ONCE or not all(fits(e, book["macs"]) for e in entries):
        return False
    for e in entries:
        take_off(book, e["key"], e.get("pairing"))
    return True

def book_mac_doc(book, step):
    # A Mac's phones document, newer than the one before (PROTOCOL.md, "Documents"): its phones, and
    # the removals it knows of, which this box notes as its own.
    book.setdefault("docs", {})[step["by"]] = {"phones": step["phones"], "removed": step.get("removed", [])}
    fold_phones(book)
    return True

def fold_phones(book):
    macs = book["macs"]
    for doc in book["docs"].values():
        for r in doc["removed"]:
            if fits(r, macs) and isinstance(r.get("pairing"), str):
                note_removed(book, r["key"], r["pairing"])
    listed = []
    def add(p):
        if fits(p, macs) and not removed_already(book, p["key"], p.get("pairing") or "") and all(q["key"] != p["key"] for q in listed):
            listed.append(p)
    for mac in macs:
        doc = book["docs"].get(mac)
        if doc is None:
            # A Mac that signs none yet: its phones as it listed them before.
            for p in book["phones"]:
                if p["from"] == "mac" and p.get("mac") == mac:
                    add(p)
        else:
            for p in doc["phones"]:
                add({"key": p["key"], "pairing": p.get("pairing") or "", "from": "mac", "mac": mac})
    if not book["docs"]:
        # One from before Macs were named: kept until a Mac signs its phones.
        for p in book["phones"]:
            if p["from"] == "mac" and p.get("mac") is None:
                add(p)
    for p in book["phones"]:
        if p["from"] == "pair":
            add(p)
    book["phones"] = listed

def phone(key, pairing, came="mac", mac=k("MAC")):
    entry = {"key": k(key), "pairing": pairing, "from": came}
    if came == "mac" and mac:
        entry["mac"] = mac
    return entry

def e(key, pairing=None):
    return {"key": k(key)} if pairing is None else {"key": k(key), "pairing": pairing}

book_cases = [
    ("a paired phone removes a lost one, which can't change anything after, nor come back in a Mac's document",
     [phone("P1", "a"), phone("P2", "b")],
     [{"op": "remove", "by": k("P1"), "phones": [e("P2", "b")]},
      {"op": "remove", "by": k("P2"), "phones": [e("P1", "a")]},
      {"op": "macDoc", "by": k("MAC"), "phones": [e("P1", "a"), e("P2", "b")]}]),
    ("nobody removes a Mac, nor does a stranger remove anyone, nor an empty removal, too many at once, or ones that aren't keys",
     [phone("P1", "a"), phone("P2", "b")],
     [{"op": "remove", "by": k("P1"), "phones": [{"key": k("MAC2"), "pairing": ""}, e("P2", "b")]},
      {"op": "remove", "by": k("S"), "phones": [e("P1", "a")]},
      {"op": "remove", "by": k("P1"), "phones": []},
      {"op": "remove", "by": k("P1"), "phones": [e("X%d" % i) for i in range(MOST_AT_ONCE + 1)]},
      {"op": "remove", "by": k("P1"), "phones": [{"key": "not a key"}]},
      {"op": "remove", "by": k("P1"), "phones": [{"key": k("P2"), "pairing": "not a pairing!"}]}]),
    ("pairing it again on the Mac lets a removed phone back in",
     [phone("P1", "a"), phone("P2", "b")],
     [{"op": "remove", "by": k("P1"), "phones": [e("P2", "b")]},
      {"op": "macDoc", "by": k("MAC"), "phones": [e("P1", "a"), e("P2", "c")]}]),
    ("pairing it here lets a removed phone back in",
     [phone("P1", "a", "pair"), phone("P2", "b", "pair")],
     [{"op": "remove", "by": k("P2"), "phones": [e("P1", "a")]},
      {"op": "pair", "key": k("P1"), "pairing": "d"}]),
    ("a phone a Mac's document no longer lists goes, not for good, and its removals are noted here",
     [phone("P1", "a"), phone("P2", "b"), phone("P3", "c", "pair")],
     [{"op": "macDoc", "by": k("MAC"), "phones": [e("P1", "a")], "removed": [e("P3", "c")]}]),
    ("a removal of an older pairing leaves the newer one; one of a phone not heard of yet keeps it out",
     [phone("P1", "a"), phone("P2", "y")],
     [{"op": "remove", "by": k("P1"), "phones": [e("P2", "x"), e("P9", "z")]},
      {"op": "macDoc", "by": k("MAC"), "phones": [e("P1", "a"), e("P2", "y"), e("P9", "z")]},
      {"op": "macDoc", "by": k("MAC"), "phones": [e("P1", "a"), e("P2", "y"), e("P9", "w")]}]),
    ("a Mac removes any phone, and a phone itself; a removal without a pairing takes the one there",
     [phone("P1", "a"), phone("P2", "b", "pair"), phone("P3", "c")],
     [{"op": "remove", "by": k("MAC"), "phones": [e("P2")]},
      {"op": "remove", "by": k("P3"), "phones": [e("P3", "c")]}]),
    ("two Macs set up the same machine: each lists its own phones, and neither takes off the other's",
     [phone("P1", "a"), phone("P2", "b", mac=k("MAC2"))],
     [{"op": "macDoc", "by": k("MAC"), "phones": [e("P1", "a")]},
      {"op": "macDoc", "by": k("MAC2"), "phones": [e("P2", "b")]},
      {"op": "macDoc", "by": k("MAC"), "phones": []},
      {"op": "remove", "by": k("MAC2"), "phones": [{"key": k("MAC"), "pairing": ""}]}]),
    ("ones from before Macs were named stay until a Mac signs its phones, and go then, not for good",
     [phone("P1", "", mac=None), phone("P2", "", mac=None)],
     [{"op": "macDoc", "by": k("MAC"), "phones": [e("P1", "")]},
      {"op": "macDoc", "by": k("MAC2"), "phones": [e("P2", "")]}]),
]
books = []
for name, phones, steps in book_cases:
    book = {"macs": [k("MAC"), k("MAC2")], "phones": [dict(p) for p in phones], "removed": [], "docs": {}}
    for step in steps:
        step["ok"] = {"pair": book_pair, "remove": book_remove, "macDoc": book_mac_doc}[step["op"]](book, step)
        step["phones"] = step.get("phones", [])
        step["after"] = {"phones": sorted(({"key": p["key"], "pairing": p["pairing"], "from": p["from"]} for p in book["phones"]), key=lambda p: p["key"]),
                         "removed": sorted((dict(r) for r in book["removed"]), key=lambda r: (r["key"], r["pairing"]))}
    books.append({"name": name, "macs": [k("MAC"), k("MAC2")], "phones": phones, "steps": steps})
keys = lambda case, step: [p["key"] for p in books[case]["steps"][step]["after"]["phones"]]
assert [s["ok"] for s in books[1]["steps"]] == [False] * 6
assert keys(0, 2) == [k("P1")]
assert sorted(keys(2, 1)) == sorted([k("P1"), k("P2")])
assert sorted(keys(5, 1)) == sorted([k("P1"), k("P2")])
assert sorted(keys(5, 2)) == sorted([k("P1"), k("P2"), k("P9")])
assert sorted(keys(7, 1)) == sorted([k("P1"), k("P2")]) and keys(7, 2) == [k("P2")] and not books[7]["steps"][3]["ok"]
assert keys(8, 0) == [k("P1")] and sorted(keys(8, 1)) == sorted([k("P1"), k("P2")]) and books[8]["steps"][1]["after"]["removed"] == []

json.dump({"addresses": addresses, "relay": relay, "frames": frames, "messages": messages, "routes": routes, "sockets": sockets,
           "agentRoutes": agent_routes, "signInReturns": returns, "phoneBooks": books}, open("link.json", "w"), indent=2)
