// What a route's answer looks like, written once as data (`shared/routes`): the contract suite holds
// every answer both boxes give to it (Vectors/routes/shapes, which scripts/route-shapes.sh writes
// from these), and the box's own code gets its types from the same definitions (`Infer`).
//
// A shape is JSON itself, so both runners read it: the bridge's (contract-runner.js) and the Mac's
// (RouteContractTests.swift), each held to Vectors/routes/shapes/cases.json.

/** One shape: a kind of value, a list or a map of one shape, an object with these fields and no
 * others (a field whose name ends in "?" may be left out), one of several shapes, or one value. */
export type Shape =
  | "string"
  | "number"
  | "bool"
  | "null"
  | "any"
  | { readonly list: Shape }
  | { readonly map: Shape }
  | { readonly object: { readonly [field: string]: Shape } }
  | { readonly oneOf: readonly Shape[] }
  | { readonly literal: string | number | boolean };

export const string = "string";
export const number = "number";
export const bool = "bool";
/** Anything: what's passed on as it came (a settings file, an engine's own record). */
export const any = "any";
export const list = <S extends Shape>(of: S) => ({ list: of }) as const;
/** An object of any keys, each value of one shape. */
export const map = <S extends Shape>(of: S) => ({ map: of }) as const;
export const object = <F extends { readonly [field: string]: Shape }>(fields: F) => ({ object: fields }) as const;
export const oneOf = <const S extends readonly Shape[]>(...of: S) => ({ oneOf: of }) as const;
export const literal = <const L extends string | number | boolean>(value: L) => ({ literal: value }) as const;
/** One of these words. */
export const words = <const W extends readonly string[]>(...each: W) => ({ oneOf: each.map(word => ({ literal: word })) as { [I in keyof W]: { readonly literal: W[I] } } }) as const;
export const nullable = <S extends Shape>(shape: S) => oneOf(shape, "null");
/** An answer that says nothing more than that it's done: `{}`. */
export const NOTHING = object({});

type RequiredFields<F> = { [K in keyof F as K extends `${string}?` ? never : K]: Infer<F[K]> };
type OptionalFields<F> = { [K in keyof F as K extends `${infer Name}?` ? Name : never]?: Infer<F[K]> };
type Flat<T> = { [K in keyof T]: T[K] } & {};

/** The type of a value of shape `S`. */
export type Infer<S> = S extends "string" ? string
  : S extends "number" ? number
  : S extends "bool" ? boolean
  : S extends "null" ? null
  : S extends "any" ? unknown
  : S extends { readonly list: infer Of } ? readonly Infer<Of>[]
  : S extends { readonly map: infer Of } ? Record<string, Infer<Of>>
  : S extends { readonly object: infer F } ? Flat<RequiredFields<F> & OptionalFields<F>>
  : S extends { readonly oneOf: infer Of extends readonly unknown[] } ? Infer<Of[number]>
  : S extends { readonly literal: infer L } ? L
  : never;

/** What a non-JSON answer is: bytes as they are (a file, a line of text). */
export const BYTES = "bytes";

/** A route's answers by status: a shape for its JSON, or `BYTES`. */
export interface RouteShape {
  /** `METHOD path`, a `:name` part standing for any one part (`GET kuvo/wakes/:session`). A HEAD
   * is held to its GET's shape, or has no body. */
  readonly route: string;
  readonly answers: { readonly [status: number]: Shape | typeof BYTES };
}
