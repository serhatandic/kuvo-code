/** A path a test makes under a name of its own outside a temporary folder: it may delete it too. */
export declare function ownPath<T extends string>(given: T): T;
export declare function testsFolder(prefix: string): string;
/** This account's own home folder as the system has it, whatever HOME says. */
export declare const accountHome: string | undefined;
