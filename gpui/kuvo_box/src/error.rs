//! What can go wrong reaching a box, in words a client can show.

use std::fmt;

/// Why a request to a box didn't give what was asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Nothing answers where the box was looked for: no record of its server, a record a stopped
    /// server left, or nothing listening there. Kuvo Code on this computer isn't running (yet).
    NotRunning(String),
    /// The box couldn't be reached at all (SSH failed, the connection dropped).
    Unreachable(String),
    /// The box answered, and said no: its status and its words.
    Refused(Refusal),
    /// The box is older than this client needs (PROTOCOL.md, "The update gate"): it lacks these
    /// features, and is asked nothing but what keeps work under way going until it's updated.
    NeedsUpdating { missing: Vec<String> },
    /// The box answered something this client can't read.
    BadAnswer(String),
}

/// What a box said when it said no.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    /// Its words (`{"message"}`), or what a client says when it gave none.
    pub message: String,
    /// Why, as a word a client maps (`{"reason"}`).
    pub reason: Option<String>,
    /// The box hasn't the route at all (`404` with nothing said): one from before it.
    pub older_box: bool,
}

impl Refusal {
    /// What a box from before a route says, in words.
    pub const OLDER_BOX: &'static str = "Its computer needs a newer Kuvo Code for this.";

    /// A refusal as a box sends it: `{"message", "reason"?}`, else a short line of text for a 4xx,
    /// else "It said no (status)". Never a page, nor what went wrong on the way (5xx bodies).
    pub fn from_answer(status: u16, body: &[u8]) -> Refusal {
        let said: Option<serde_json::Value> = serde_json::from_slice(body).ok();
        let object = said.as_ref().and_then(|value| value.as_object());
        let message = object.and_then(|o| o.get("message")).and_then(|m| m.as_str()).map(str::to_owned);
        let reason = object.and_then(|o| o.get("reason")).and_then(|r| r.as_str()).map(str::to_owned);
        let older_box = status == 404 && message.is_none();
        let plain = if said.is_none() && (400..500).contains(&status) {
            std::str::from_utf8(body)
                .ok()
                .map(str::trim)
                .filter(|text| !text.is_empty() && text.chars().count() <= 300 && !text.starts_with('<') && !text.contains('\n'))
                .map(str::to_owned)
        } else {
            None
        };
        let message = message
            .or_else(|| older_box.then(|| Self::OLDER_BOX.to_owned()))
            .or(plain)
            .unwrap_or_else(|| format!("It said no ({status})."));
        Refusal { status, message, reason, older_box }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotRunning(why) | Error::Unreachable(why) | Error::BadAnswer(why) => f.write_str(why),
            Error::Refused(refusal) => f.write_str(&refusal.message),
            Error::NeedsUpdating { .. } => f.write_str(crate::gate::UPDATING),
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    /// The box's own refusal, when it was one.
    pub fn refusal(&self) -> Option<&Refusal> {
        match self {
            Error::Refused(refusal) => Some(refusal),
            _ => None,
        }
    }

    /// The status the box answered with, when it answered.
    pub fn status(&self) -> Option<u16> {
        self.refusal().map(|refusal| refusal.status)
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_says_what_the_box_said() {
        let said = Refusal::from_answer(409, br#"{"message":"Only the main computer adds.","reason":"mainOnly"}"#);
        assert_eq!((said.message.as_str(), said.reason.as_deref(), said.older_box), ("Only the main computer adds.", Some("mainOnly"), false));
        assert!(Refusal::from_answer(404, b"{}").older_box);
        assert_eq!(Refusal::from_answer(404, b"{}").message, Refusal::OLDER_BOX);
        assert_eq!(Refusal::from_answer(403, b"That isn't available over the link.").message, "That isn't available over the link.");
        // Never a page, nor what went wrong on the way.
        assert_eq!(Refusal::from_answer(400, b"<html>oops</html>").message, "It said no (400).");
        assert_eq!(Refusal::from_answer(502, b"upstream broke").message, "It said no (502).");
    }
}
