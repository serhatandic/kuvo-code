/** A path a test makes under a name of its own outside a temporary folder: it may delete it too. */
export declare function ownPath<T extends string>(given: T): T;
export declare function testsFolder(prefix: string): string;
/** This account's own home folder as the system has it, whatever HOME says. */
export declare const accountHome: string | undefined;
/** The coding agents' own folders in a home, which no test reads, writes or starts a program from. */
export declare const AGENT_FOLDERS: string[];
/** For a live test you asked for: the real agents, as you're signed in to them, in this process. */
export declare function allowRealAgents(): void;
/** What this run reached of your real agents (each refused), for the run to fail on. */
export declare function reachedRealAgents(): string[];
