// The box's link's version (`kuvo/info`'s `bridge`, a machine's `run/link.version`).

// Goes up with every change, so `setup` replaces a running bridge that's older. Clients don't
// compare it: they check `FEATURES`.
export const BRIDGE_VERSION = "0.9.212";
