//! Times as the screens say them.

/// How long ago `then` was, at `now` (both ms since 1970), as a sidebar row says it: "now", "5m",
/// "3h", "2d", "1w", "1mo", "1y".
pub fn ago(then: f64, now: f64) -> String {
    let seconds = ((now - then) / 1000.0).max(0.0);
    let minutes = seconds / 60.0;
    let hours = minutes / 60.0;
    let days = hours / 24.0;
    if minutes < 1.0 {
        "now".into()
    } else if hours < 1.0 {
        format!("{}m", minutes as u64)
    } else if days < 1.0 {
        format!("{}h", hours as u64)
    } else if days < 7.0 {
        format!("{}d", days as u64)
    } else if days < 30.0 {
        format!("{}w", (days / 7.0) as u64)
    } else if days < 365.0 {
        format!("{}mo", (days / 30.0) as u64)
    } else {
        format!("{}y", (days / 365.0) as u64)
    }
}

/// A turn's length: "Worked for 25s", "Worked for 3m 10s", "Worked for 1h 5m".
pub fn worked_for(ms: f64) -> String {
    let seconds = (ms / 1000.0).round().max(1.0) as u64;
    let length = if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        match seconds % 60 {
            0 => format!("{}m", seconds / 60),
            rest => format!("{}m {rest}s", seconds / 60),
        }
    } else {
        match (seconds % 3600) / 60 {
            0 => format!("{}h", seconds / 3600),
            rest => format!("{}h {rest}m", seconds / 3600),
        }
    };
    format!("Worked for {length}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_as_a_sidebar_says_them() {
        let now = 1_000_000_000_000.0;
        let ago_ = |ms: f64| ago(now - ms, now);
        assert_eq!(ago_(10_000.0), "now");
        assert_eq!(ago_(5.0 * 60_000.0), "5m");
        assert_eq!(ago_(3.0 * 3_600_000.0), "3h");
        assert_eq!(ago_(2.0 * 86_400_000.0), "2d");
        assert_eq!(ago_(8.0 * 86_400_000.0), "1w");
        assert_eq!(ago_(45.0 * 86_400_000.0), "1mo");
        assert_eq!(worked_for(25_000.0), "Worked for 25s");
        assert_eq!(worked_for(190_000.0), "Worked for 3m 10s");
        assert_eq!(worked_for(3_900_000.0), "Worked for 1h 5m");
    }
}
