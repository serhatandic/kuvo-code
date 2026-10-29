// Whether agents may use the vault on this box: its tools listed and answered, its fills made.
// Only where agents' commands are fenced away from Kuvo Code's own folders, processes and secrets
// (vault/FENCING): until then a command an agent runs could reach what the vault keeps, so the
// vault is yours alone. `KUVO_VAULT_AGENTS=1` opens it for the tests of what agents do with it.

export const agentsUseVault = (): boolean => process.env.KUVO_VAULT_AGENTS === "1";

export const AGENTS_LATER = "The user's vault isn't open to agents on this computer yet. To sign in, use browser_sign_in, and the user signs in.";
