//! Ids a client makes, in the engine's format, so they sort among the engine's own: a prefix, 12
//! hex digits of (milliseconds × 4096 + a counter), then 14 random base62 characters.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

static LAST: Mutex<(u64, u64)> = Mutex::new((0, 0));

/// A new message's id (`msg_…`), also a send's own id for `typed`.
pub fn message() -> String {
    format!("msg_{}", ascending())
}

fn ascending() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_millis() as u64).unwrap_or(0);
    let counter = {
        let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.0 != now {
            *last = (now, 0);
        }
        last.1 += 1;
        last.1
    };
    let value = (now.wrapping_mul(0x1000).wrapping_add(counter)) & 0xFFFF_FFFF_FFFF;
    let mut random = [0u8; 14];
    // (No randomness here is no id at all: say so loudly rather than send a guessable one.)
    getrandom::fill(&mut random).expect("this computer gives no random bytes");
    let tail: String = random.iter().map(|byte| ALPHABET[(*byte as usize) % ALPHABET.len()] as char).collect();
    format!("{value:012x}{tail}")
}
