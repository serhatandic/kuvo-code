/** A path a test makes under a name of its own outside a temporary folder: it may delete it too. */
export function ownPath<T extends string>(given: T): T;
export function testsFolder(prefix: string): string;
/** This account's own home folder as the system has it, whatever HOME says. */
export const accountHome: string | undefined;
