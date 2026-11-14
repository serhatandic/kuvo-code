#!/usr/bin/env python3
"""Reads what's new from CHANGELOG.md into the whats-new.json an app carries (ClientNews reads it).

    scripts/whats-new.py            writes swift/KuvoCode/Resources/whats-new.json
    scripts/whats-new.py --check    says whether it's what CHANGELOG.md gives, as CI checks
    scripts/whats-new.py --changelog ../kuvo-code-ios/CHANGELOG.md --out <file>   another app's

In a release's section, the items under "### Highlights" are what the sheet after an update shows:

    - **Goals that keep going**: `/goal all tests pass`, and it keeps at it. <!-- symbol: target -->

with a note after it, which GitHub and the update window don't show: `symbol` (an SF Symbol,
needed), `open` (where Try It goes: `settings/<page>` or a web address) and `picture` (an image
the app carries). Any item in the section can say what carries a "New" mark until it's used:
`<!-- new: keyword/goal, settings/worktrees -->`.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ITEM = re.compile(r"^- \*\*(?P<title>.+?)\*\*[:.]?\s*(?P<line>.*)$")
NOTE = re.compile(r"\s*<!--(?P<note>.*?)-->\s*")


def notes(text):
    """The `key: value` pairs in an item's notes, and the item without them."""
    found = {}
    for match in NOTE.finditer(text):
        for part in match.group("note").split(";"):
            if ":" in part:
                key, value = part.split(":", 1)
                found[key.strip()] = value.strip()
    return found, NOTE.sub(" ", text).strip()


def releases(changelog):
    """Each release with highlights or marks, newest first."""
    found = []
    release = None
    heading = None
    item = None

    def finish_item():
        nonlocal item
        if item is None or release is None:
            item = None
            return
        found_notes, text = notes(item)
        for mark in filter(None, (word.strip() for word in found_notes.get("new", "").split(","))):
            if mark not in release["marks"]:
                release["marks"].append(mark)
        if heading == "highlights":
            match = ITEM.match(text)
            if not match or "symbol" not in found_notes:
                # Older releases' highlights were written before the apps showed them: only the
                # newest release's must be ones they can.
                if release is found[0]:
                    sys.exit(f"A highlight needs **its title**, a line, and <!-- symbol: … -->: {item}")
                item = None
                return
            # "**Title**: write …" reads as a sentence of its own under the title: "Write …".
            line = match["line"].strip()
            line = line[:1].upper() + line[1:]
            highlight = {"title": match["title"].rstrip(".:"), "line": line, "symbol": found_notes["symbol"]}
            for key in ("open", "picture"):
                if found_notes.get(key):
                    highlight[key] = found_notes[key]
            release["highlights"].append(highlight)
        item = None

    for raw in changelog.splitlines():
        line = raw.rstrip()
        if line.startswith("## "):
            finish_item()
            release = {"version": line[3:].strip(), "highlights": [], "marks": []}
            found.append(release)
            heading = None
        elif line.startswith("### "):
            finish_item()
            heading = line[4:].strip().lower()
        elif line.startswith("- "):
            finish_item()
            item = line
        elif item is not None and line.startswith("  "):
            # An item carried on over lines.
            item += " " + line.strip()
        else:
            finish_item()
    finish_item()
    return [each for each in found if each["highlights"] or each["marks"]]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--changelog", default=ROOT / "CHANGELOG.md", type=Path)
    parser.add_argument("--out", default=ROOT / "swift/KuvoCode/Resources/whats-new.json", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = json.dumps({"releases": releases(args.changelog.read_text())}, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not args.out.exists() or args.out.read_text() != text:
            sys.exit(f"{args.out} isn't what {args.changelog.name} gives: run scripts/whats-new.py and commit it.")
        return
    args.out.write_text(text)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
