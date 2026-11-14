// This Mac's notices for your phones (PROTOCOL.md, "kuvo/attention")

import fs from "node:fs";
import { finishUsage } from "../notices/usage-delivery";
import { writePrivate } from "../files";
import { HELD_FILE, NoticeHold } from "../notices/hold";
import { sendToPhones } from "../notices/push";
import type { Notice } from "../notices/notice";
import { macLink, readLink } from "../state";

// This Mac's notices for your phones (PROTOCOL.md, "kuvo/attention"): held a little while you're at
// a computer (the app says when, as "mac"), then sealed here for each paired phone that's said where
// it is and pushed on the link's connection; kept for a box that starts again, as a machine's are.
// `clock`: a test's own (NoticeHold's `now`, `setTimer`, `clearTimer`).
export function macNoticeHold(clock = {}) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(HELD_FILE, "utf8")); } catch {}
  return new NoticeHold({
    ...clock,
    send: notice => {
      // Not told yet whether the phone link's on (the app hasn't said, as it starts): held.
      if (!macLink.config) return false;
      if (!macLink.config.phones) return true;
      // Gone out to one at least, or held to try again (a connection closing as it's sent).
      return sendToPhones(macLink.host, readLink(), notice);
    },
    held,
    save: entries => {
      try {
        if (entries.length) writePrivate(HELD_FILE, JSON.stringify(entries));
        else fs.rmSync(HELD_FILE, { force: true });
      } catch {}
    },
  });
}

// A notice of this Mac's for your phones (its news, its app's own asks): held and sent while the
// phone link's on, or until its app says whether it is (as it starts); none while it's off.
export function macTell(notice: Notice): boolean {
  // Off: let go now, so turning it on later never sends what came while it was off.
  if (macLink.config && !macLink.config.phones) { finishUsage(notice); return true; }
  if (!macLink.hold) return false;
  return macLink.hold.tell(notice);
}