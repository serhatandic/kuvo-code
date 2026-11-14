// Group chats across your computers (PROTOCOL.md, "Peers": `seat`), as a box's two programs say
// them to each other: the coding agents' bridge (src/agents/groups/post.ts) and the link
// (src/link/peers/seats.ts), which carries the bridge's mail to your other computers and says who
// they are. The mail itself is the bridge's (`SeatMail`, src/agents/groups/peer.ts); the link
// reads only its kind, and for what a bot remembers, whose it is. The bridge's plan limits go the
// same way, as mail of their own (`limits`, src/agents/limits-peers.ts).

import type { BotLook } from "./routes/bots";

/** The kinds of mail between two computers' bridges for their group chats. */
export const SEAT_MAIL_KINDS = ["turn", "state", "result", "steer", "stop", "drop", "work", "held", "report", "memory"] as const;
export type SeatMailKind = (typeof SEAT_MAIL_KINDS)[number];

/** One line of what the bridge sends (`GET /api/kuvo/peers/mail`): its `mail` for the computer
 * `to` (its key), and whether it mustn't be lost (`durable`). */
export interface SeatLine<Mail> {
  id: string;
  to: string;
  mail: Mail;
  durable: boolean;
}

/** One of your other computers, as the link tells the bridge (`PUT /api/kuvo/peers`): whether it
 * takes a chat's turns. */
export interface SeatBox {
  key: string;
  name: string;
  seats: boolean;
  /** One of this box's peers that isn't one of your own computers for plan limits' resets, Always
   * Allow and usage totals: this box or it is a machine two people's Macs share, or it follows
   * another setup (PROTOCOL.md, "Plan limits", "Across your computers"). */
  apart?: true;
}

/** A bot on another of your computers, as the link tells the bridge: its computer (`box`, by key),
 * its own conversation there, and how it looks. */
export interface SeatBot {
  id: string;
  name: string;
  job: string;
  box: string;
  session: string;
  look?: BotLook;
}

/** Who can be in this box's group chats from your other computers (`PUT /api/kuvo/peers`), and
 * this box itself, as its peers name it (its key, and its name: what its plan limits' rows call it). */
export interface SeatPeers {
  self?: { key: string; name: string };
  /** Boxes a peer knows that aren't this box's peers (another Mac's, beside a machine two Macs share): for plan limits alone. */
  also?: { key: string; name: string }[];
  boxes: SeatBox[];
  bots: SeatBot[];
  /** The setup this box follows now, by its id (PROTOCOL.md, "Your setup"); `null` once it's
   * settled that it follows none (a machine Macs share, a setup set aside); not said while it can't
   * say yet (its keys not read as its link starts, none made yet) or by a link from before this,
   * which the bridge takes as neither. The usage panel's settings go only between boxes of the
   * same setup. */
  setup?: string | null;
  /** This box is a machine set up by Macs that aren't all in one setup (`sharedMachine`, #701). */
  shared?: true;
}
