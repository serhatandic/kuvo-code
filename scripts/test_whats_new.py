"""What scripts/whats-new.py reads from a changelog, as people write one: highlights with their
notes, marks on any line (one carried on over lines too), and older releases written before the
apps showed highlights."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("whats_new", Path(__file__).with_name("whats-new.py"))
whats_new = importlib.util.module_from_spec(spec)
spec.loader.exec_module(whats_new)

CHANGELOG = """# Changelog

## Unreleased

### Highlights

- **Goals that keep going**: write `/goal all tests pass`, and **it** keeps at it. <!-- symbol: target; open: settings/worktrees -->

### All Changes

- New keywords after **/**, each with what it does,
  listed first. <!-- new: keyword/loop, keyword/plan -->
- A fix nobody needs to be told about.

## 0.7.2

- Something small. <!-- new: settings/storage -->

## 0.1.0

### Highlights

- **Any model.** Sign in with what you have.
"""


class WhatsNewTests(unittest.TestCase):
    def test_highlights_and_marks(self):
        releases = whats_new.releases(CHANGELOG)
        self.assertEqual([each["version"] for each in releases], ["Unreleased", "0.7.2"])
        self.assertEqual(releases[0]["highlights"], [{
            "title": "Goals that keep going",
            "line": "write `/goal all tests pass`, and **it** keeps at it.",
            "symbol": "target",
            "open": "settings/worktrees",
        }])
        self.assertEqual(releases[0]["marks"], ["keyword/loop", "keyword/plan"])
        self.assertEqual(releases[1], {"version": "0.7.2", "highlights": [], "marks": ["settings/storage"]})

    def test_a_new_highlight_without_its_symbol_is_refused(self):
        with self.assertRaises(SystemExit):
            whats_new.releases(CHANGELOG.replace(" <!-- symbol: target; open: settings/worktrees -->", ""))


if __name__ == "__main__":
    unittest.main()
