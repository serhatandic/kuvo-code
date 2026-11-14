// The box's link's version (`kuvo/info`'s `bridge`, a machine's `run/link.version`): a hash of the
// link as built, which scripts/build-box.sh writes in place of this one. So it changes with every
// change to the link, and no branch bumps it by hand. `setup` replaces a running bridge whose
// version isn't this one. Clients don't compare it: they check `FEATURES`. Run from its sources
// (as `bun test` does), it stays as written here.
export const BRIDGE_VERSION: string = "0.0.0-from-its-sources";
