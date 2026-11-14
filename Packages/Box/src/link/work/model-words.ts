// What a session's model being ready means for a composer, and its words (PROTOCOL.md, "A session's
// model"): whether a message on it is refused and the sentence saying why, whether the model must be
// chosen (the chip asks for one, and Send waits), and what to offer doing about it. Decided here
// once, so no client words or decides it; held to Packages/KuvoLink/Vectors/model-readiness.json.
// Product words only: no computer's name (the conversation shows where it is), no settings page.

import type { ModelAction, SessionModel } from "../../shared/routes/sessions";
import type { ModelState } from "./model-rule";

export type Readiness = Pick<SessionModel, "refusal" | "choose" | "action">;

/** "an" before a name said starting with a vowel ("an OpenAI key", "an xAI key", said "ex-A-I"),
 * else "a" ("a Xiaomi key"). */
export function article(word: string): "a" | "an" {
  const first = word.toLowerCase()[0];
  return (first && "aeiou".includes(first)) || word.startsWith("xA") ? "an" : "a";
}

/** What `state` (said of `model`, none for none to run on) means for a composer. `known`: the name
 * last listed for a model gone from its list. Nothing for a model that runs. */
export function readiness(model: { providerID: string; id: string } | null, state: ModelState, known?: string): Readiness {
  if (state.runs && !state.missing) return {};
  const name = state.name ?? known ?? model?.id ?? "This model";
  const account = state.account?.name ?? model?.providerID ?? "its account";
  const choose = (help: string): ModelAction => ({ do: "choose", label: "Choose a Model", help });
  switch (state.missing) {
    case "signIn":
      return { refusal: `${name} needs a sign-in to ${account}: sign in, or choose another model.`, action: { do: "signIn", label: "Sign In", help: `Sign in to ${account}` } };
    case "key": {
      const plan = state.plan;
      const key = `${article(account)} ${account} key`;
      return plan
        ? {
            refusal: `${name} needs ${key}: add one, or choose another model (with ${article(plan.name)} ${plan.name} plan, one under ${plan.agent}).`,
            action: { do: "addKey", label: "Add Key", help: `Add ${key} (with ${article(plan.name)} ${plan.name} plan, choose a model under ${plan.agent} instead)` },
          }
        : { refusal: `${name} needs ${key}: add one, or choose another model.`, action: { do: "addKey", label: "Add Key", help: `Add ${key}` } };
    }
    case "install":
      return { refusal: `${name} needs ${account} installed: install it, or choose another model.`, action: { do: "install", label: "Install", help: `Install ${account}` } };
    case "gone":
      return {
        refusal: state.account ? `${name} is no longer among ${state.account.name}’s models: choose another model.` : `${name} is no longer available: choose another model.`,
        choose: true,
        action: choose("Choose another model"),
      };
    default:
      // None to run on (`model`), or (never said) one that can't run with nothing missing.
      return { refusal: "Choose a model to send it.", choose: true, action: choose("Choose a model") };
  }
}
