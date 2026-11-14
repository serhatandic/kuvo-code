// The ways to sign in to an account, in the order and words every client offers them, and what a
// client says of a sign-in that didn't work, as the box decides them (areas/sign-in.ts), held to the
// cases clients are held to too (protocol/vectors/sign-in.json).

import "./safety"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { failureWords, signInMethods } from "../src/link/areas/sign-in"

const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/sign-in.json", import.meta.url), "utf8"))

test.each(vectors.methods.map((each: any, at: number) => [`${each.provider} #${at}`, each]))("%s: the ways offered, in order, with their words", (_, each: any) => {
  expect(signInMethods({ id: each.provider, name: each.name, methods: each.methods, connections: each.connections ?? [] })).toEqual(each.offered)
})

test.each(vectors.failures.map((each: any) => [`${each.status} ${JSON.stringify(each.message ?? null)}`, each]))("%s: what a client says", (_, each: any) => {
  expect(failureWords(each.status, each.message)).toBe(each.failure)
})
