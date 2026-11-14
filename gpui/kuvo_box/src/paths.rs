//! Writing a route's path: each part between slashes, and each query value, percent-encoded with
//! only the unreserved characters left as they are (RFC 3986), as the box reads them back
//! (PROTOCOL.md, "Messages in a session": a host writes the path one way only).

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

/// Everything but `A–Z a–z 0–9 - . _ ~`.
const ESCAPED: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

/// One part of a path (a session's id), escaped so it stays one part.
pub fn segment(part: &str) -> String {
    utf8_percent_encode(part, ESCAPED).to_string()
}

/// A value in a query.
pub fn query_value(value: &str) -> String {
    utf8_percent_encode(value, ESCAPED).to_string()
}
