#!/usr/bin/env python3
"""Prints every crate the gpui workspace builds on this Mac, with its licence, as markdown.

Usage: cargo metadata --format-version 1 --filter-platform aarch64-apple-darwin | scripts/deps-licenses.py
"""
import json
import sys

meta = json.load(sys.stdin)
packages = {p["id"]: p for p in meta["packages"]}
nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
seen, stack = set(), list(meta["workspace_members"])
while stack:
    node = stack.pop()
    if node in seen:
        continue
    seen.add(node)
    stack.extend(d["pkg"] for d in nodes[node]["deps"])

rows = sorted(
    (packages[i]["name"], packages[i]["version"], packages[i].get("license") or "see its licence file")
    for i in seen
    if packages[i]["name"] not in ("kuvo", "kuvo_ui", "kuvo_box", "kuvo_gallery")
)
print("| Crate | Version | Licence |")
print("|---|---|---|")
for name, version, licence in rows:
    print(f"| {name} | {version} | {licence} |")
