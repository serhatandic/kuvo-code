#!/bin/sh
# Kuvo Code's browser and side-panel tools as an MCP server over stdio, for a coding agent
# running in one of its terminals (omp, say): add it to the agent's MCP settings, as Kuvo Code's
# panel says. Each line the agent writes goes to the app's local server, and its answer comes back.
# The terminal's environment has where the server is (KUVO_MCP_URL) and its token (KUVO_MCP_TOKEN).

if [ -z "$KUVO_MCP_URL" ] || [ -z "$KUVO_MCP_TOKEN" ]; then
  echo "kuvo-mcp: KUVO_MCP_URL and KUVO_MCP_TOKEN are set in the terminals of Kuvo Code; run the agent there." >&2
  exit 1
fi

while IFS= read -r line; do
  [ -n "$line" ] || continue
  # A tool that asks the user (a sign-in, a code) waits for them, so no time limit but theirs.
  reply=$(printf '%s' "$line" | curl -sS --fail-with-body \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json' \
    -H "Authorization: Bearer $KUVO_MCP_TOKEN" \
    -H 'X-Kuvo-Terminal: 1' \
    --data-binary @- "$KUVO_MCP_URL") || {
    echo "kuvo-mcp: Kuvo Code didn't answer (is it still open, and is this terminal one of its own?)" >&2
    exit 1
  }
  if [ -n "$reply" ]; then printf '%s\n' "$reply"; fi
done
