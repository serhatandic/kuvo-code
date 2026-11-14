#!/bin/sh
# Sets up signing for what remote machines run (box releases), once. The first time, it makes the
# Ed25519 key and keeps it in your login keychain, as "Kuvo Code box signing key" (beside the
# app's update key); it uploads it as KUVO_BOX_SIGNING_KEY for the release workflow; and it prints
# the public key, which kuvo-link.js pins (UPDATE_KEYS). From then on, every release signs what
# machines run by itself. Run it again on a new Mac, or if the secret is lost: it uploads the same
# key from your keychain. Given a key file you made with openssl, it keeps that one instead.
#   scripts/set-box-key.sh [key.pem]
set -eu
# The key file as you named it, from the folder you ran this in.
GIVEN=${1:-}
case "$GIVEN" in "" | /*) ;; *) GIVEN="$PWD/$GIVEN" ;; esac
if [ -n "$GIVEN" ] && [ ! -f "$GIVEN" ]; then
    echo "There's no key file at $GIVEN." >&2
    exit 1
fi
cd "$(dirname "$0")/.."

REPO=${REPO:-serhatandic/kuvo-code}
SERVICE="Kuvo Code box signing key"
ACCOUNT=kuvo-box
# Where the box's link pins it, in its sources (box/src): change it there, then run
# scripts/build-box.sh.
PINS=$(grep -rl 'export const UPDATE_KEYS' box/src | head -n 1)
[ -n "$PINS" ] || { echo "No UPDATE_KEYS in box/src: where the box's link pins its key has moved." >&2; exit 1; }

if ! command -v gh >/dev/null 2>&1; then
    echo "GitHub's command line tool isn't installed: brew install gh, then gh auth login." >&2
    exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
    echo "gh isn't signed in: run gh auth login, then this again." >&2
    exit 1
fi

umask 077
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if KEY=$(security find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w 2>/dev/null); then
    printf '%s' "$KEY" | base64 -d > "$TMP/key.pem"
    if [ -n "$GIVEN" ] && ! cmp -s "$GIVEN" "$TMP/key.pem"; then
        echo "Your keychain has another box signing key already. Nothing was changed." >&2
        exit 1
    fi
    echo "Using the box signing key in your keychain."
else
    if [ -n "$GIVEN" ]; then
        if ! openssl pkey -in "$GIVEN" -noout -text 2>/dev/null | head -n 1 | grep -qi "ED25519"; then
            echo "$GIVEN isn't an Ed25519 private key. Nothing was changed." >&2
            exit 1
        fi
        cp "$GIVEN" "$TMP/key.pem"
    elif grep -q 'UPDATE_KEYS = \["' "$PINS"; then
        # A new key wouldn't be the one machines trust.
        echo "The box's link pins a key that isn't in your keychain: give its .pem file (scripts/set-box-key.sh path/to/key.pem). Nothing was changed." >&2
        exit 1
    elif ! openssl genpkey -algorithm ed25519 -out "$TMP/key.pem" 2>/dev/null; then
        echo "This openssl can't make Ed25519 keys: brew install openssl, then this again." >&2
        exit 1
    fi
    # Through security's own command input, so the key is never on a command line.
    KEY=$(base64 < "$TMP/key.pem" | tr -d '\n')
    printf 'add-generic-password -s "%s" -a %s -l "%s" -j "%s" -w %s\n' "$SERVICE" "$ACCOUNT" "$SERVICE" \
        "Signs what Kuvo Code's remote machines run (box releases). The release workflow has it as KUVO_BOX_SIGNING_KEY." "$KEY" | security -i >/dev/null
    if ! security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
        echo "The key couldn't be kept in your keychain. Nothing was uploaded." >&2
        exit 1
    fi
    if [ -n "$GIVEN" ]; then
        echo "Kept $(basename "$GIVEN") in your login keychain, as \"$SERVICE\". You can delete the file now."
    else
        echo "Made a box signing key and kept it in your login keychain, as \"$SERVICE\"."
    fi
fi

PUBLIC=$(openssl pkey -in "$TMP/key.pem" -pubout -outform DER | tail -c 32 | base64)
if [ "$(printf '%s' "$PUBLIC" | base64 -d | wc -c | tr -d ' ')" != 32 ]; then
    echo "The key in your keychain isn't an Ed25519 key. Nothing was uploaded." >&2
    exit 1
fi

gh secret set KUVO_BOX_SIGNING_KEY --repo "$REPO" < "$TMP/key.pem"
echo "Set KUVO_BOX_SIGNING_KEY on $REPO."
if grep -q "\"$PUBLIC\"" "$PINS"; then
    echo "The box's link pins its public key already: releases carry what machines run, signed."
else
    echo "Its public key, for UPDATE_KEYS in $PINS (then run scripts/build-box.sh):"
    echo "  $PUBLIC"
fi
