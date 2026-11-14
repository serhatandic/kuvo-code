// The page Create Pull Request opens when the box can't make one with gh: on the remote's host,
// whichever way the remote is written, and never with the name, password or port it may carry.

import "./safety"
import { expect, test } from "bun:test";
import { comparePage } from "../src/link/areas/changes";

test.each([
  ["git@github.com:acme/app.git", "https://github.com/acme/app/compare/main...dark-mode?expand=1&title=Dark+mode"],
  ["https://github.com/acme/app.git", "https://github.com/acme/app/compare/main...dark-mode?expand=1&title=Dark+mode"],
  ["https://me:ghp_secret@github.com/acme/app", "https://github.com/acme/app/compare/main...dark-mode?expand=1&title=Dark+mode"],
  ["ssh://git@gitlab.com:22/group/sub/app.git", "https://gitlab.com/group/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=dark-mode&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=Dark+mode"],
  ["/local/path/repo", null],
])("%s", (remote, page) => {
  expect(comparePage(remote, "dark-mode", "main", "Dark mode")).toBe(page)
})
