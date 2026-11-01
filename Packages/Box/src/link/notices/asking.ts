// What agents ask you and wait on, kept by the box's long-running process: the vault's asks
// (vault/asks.ts) and the sandbox's (fence/asks.ts). Each waits for your answer from any client (a
// card on the Mac, the phone's), up to a while, then is taken as no; your phones hear of one still
// open after a moment.

import { newID } from "../../shared/text";
import type { Notice } from "./notice";

/** How long an agent waits for you. */
export const PATIENCE = 15 * 60_000;

export interface Asked {
  id: string;
  at: number;
}

export interface AskBook<A extends Asked, R> {
  /** Asks you; the answer comes when a client gives it, or `no` after `patience` (or when `signal`
   * says the agent stopped waiting). `made` hears its id as it's asked. */
  ask(what: Omit<A, "id" | "at">, signal?: AbortSignal, patience?: number, made?: (id: string) => void): Promise<R>;
  /** A client's answer to `id`: false for one that isn't asked (any more). */
  answer(id: string, given: R): boolean;
  /** What's known of `id` since it was asked, added to it while it's asked: false once it isn't. */
  update(id: string, more: Partial<Omit<A, "id" | "at">>): boolean;
  /** What's asked now, oldest first. */
  list(): A[];
  /** Hears each change to what's asked; gives back how to stop hearing. */
  onChanged(listener: () => void): () => void;
  /** Your phones hear of each ask still open a moment after it's made (one answered at once on a
   * Mac never buzzes them); `answered` hears of one told that's no longer asked. */
  watch(notice: (asked: A) => Notice, tell: (notice: Notice) => boolean, answered?: (id: string) => void, after?: number): () => void;
}

/** A book of asks whose ids start with `prefix`, each taken as `no` when nobody answers. */
export function askBook<A extends Asked, R>(prefix: string, no: R): AskBook<A, R> {
  const open = new Map<string, { asked: A; done: (answer: R) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) try { listener(); } catch {}
  };
  const list = () => [...open.values()].map(each => each.asked).sort((a, b) => a.at - b.at);
  const onChanged = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return {
    list,
    onChanged,
    ask(what, signal, patience = PATIENCE, made) {
      const asked = { id: newID(prefix), at: Date.now(), ...what } as A;
      return new Promise(resolve => {
        const finish = (answer: R) => {
          const was = open.get(asked.id);
          if (!was) return;
          clearTimeout(was.timer);
          open.delete(asked.id);
          signal?.removeEventListener("abort", stopped);
          changed();
          resolve(answer);
        };
        const stopped = () => finish(no);
        if (signal?.aborted) return resolve(no);
        signal?.addEventListener("abort", stopped, { once: true });
        open.set(asked.id, { asked, done: finish, timer: setTimeout(() => finish(no), patience) });
        changed();
        made?.(asked.id);
      });
    },
    answer(id, given) {
      const found = open.get(id);
      if (!found) return false;
      found.done(given);
      return true;
    },
    update(id, more) {
      const found = open.get(id);
      if (!found) return false;
      found.asked = { ...found.asked, ...more };
      changed();
      return true;
    },
    watch(notice, tell, answered = () => {}, after = 2000) {
      const told = new Set<string>();
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      const look = () => {
        const now = new Set(list().map(each => each.id));
        for (const id of [...told]) if (!now.has(id)) { told.delete(id); answered(id); }
        for (const [id, timer] of timers) if (!now.has(id)) { clearTimeout(timer); timers.delete(id); }
        for (const asked of list()) {
          if (told.has(asked.id) || timers.has(asked.id)) continue;
          timers.set(asked.id, setTimeout(() => {
            timers.delete(asked.id);
            if (!open.has(asked.id)) return;
            if (tell(notice(asked))) told.add(asked.id);
          }, after));
        }
      };
      return onChanged(look);
    },
  };
}
