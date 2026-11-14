<!--
The title becomes the commit message on main: one plain sentence saying what
the change does, e.g. "Stop the sidebar from growing past its maximum width".
-->

Fixes #<!-- issue number -->

## Summary

<!-- What changed, and why? -->

## Validation

- [ ] The app builds without new warnings, and I tried the change in it
- [ ] `swift test` passes in `swift/OpenCodeKit` and `swift/UsageKit`, if I changed them
- [ ] If dependencies or copied code changed, I ran `./scripts/third-party-licenses.sh`
- [ ] If the change is user-facing, I noted what the docs at kuvo.run/code need
- [ ] If the change is user-facing, I added it to `CHANGELOG.md` under Unreleased

## Hygiene

- [ ] This change contains no credentials, personal paths, generated build
      output, or tool attribution and session metadata.

## Contribution license

- [ ] I have read and accept the
      [Contributor License Agreement](https://github.com/serhatandic/kuvo-code/blob/main/CONTRIBUTOR_LICENSE_AGREEMENT.md)
      for the contributions in this pull request, and I have authority to
      grant those rights.
