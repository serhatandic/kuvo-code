// The engine's sessions, as a box tells them apart.

/** A session as the engine lists it, as far as a box reads it here. */
interface SessionMetadata {
  metadata?: { kuvo?: { engineFor?: unknown; seat?: unknown } } | null;
}

// Kept out of sight, as the Mac keeps them: an engine run a coding agents' session started (Auto on
// one of the engine's models), whose news the agents' bridge tells as its session's; and a bot's
// seat in a group chat, whose chat tells what matters.
export const isHiddenRun = (session: SessionMetadata | null | undefined) => Boolean(session?.metadata?.kuvo?.engineFor || session?.metadata?.kuvo?.seat);
