//! Reading a followed answer as it comes: a box's JSON lines (`application/x-ndjson`), or the
//! engine's server-sent events (`text/event-stream`, each event's `data:` lines).

use std::io::{self, BufRead};

/// The next line that isn't empty, without its line break; none once the answer ends.
pub fn next_line(reader: &mut dyn BufRead) -> io::Result<Option<String>> {
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if !line.trim().is_empty() {
            return Ok(Some(line.to_owned()));
        }
    }
}

/// The next server-sent event's data (its `data:` lines joined); none once the stream ends. A
/// comment (`:`, a heartbeat) or an event with no data is skipped.
pub fn next_event(reader: &mut dyn BufRead) -> io::Result<Option<String>> {
    let mut data: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(data);
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            if let Some(data) = data.take() {
                return Ok(Some(data));
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("data:") {
            let value = value.strip_prefix(' ').unwrap_or(value);
            match &mut data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => data = Some(value.to_owned()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_and_lines_are_read_as_they_come() {
        let mut stream: &[u8] = b": heartbeat\n\ndata: {\"a\":1}\n\nevent: x\ndata: one\ndata: two\r\n\r\ndata: last";
        assert_eq!(next_event(&mut stream).unwrap().as_deref(), Some("{\"a\":1}"));
        assert_eq!(next_event(&mut stream).unwrap().as_deref(), Some("one\ntwo"));
        assert_eq!(next_event(&mut stream).unwrap().as_deref(), Some("last"));
        assert_eq!(next_event(&mut stream).unwrap(), None);

        let mut lines: &[u8] = b"{\"at\":\"1\"}\n\n  \n{\"at\":\"2\"}";
        assert_eq!(next_line(&mut lines).unwrap().as_deref(), Some("{\"at\":\"1\"}"));
        assert_eq!(next_line(&mut lines).unwrap().as_deref(), Some("{\"at\":\"2\"}"));
        assert_eq!(next_line(&mut lines).unwrap(), None);
    }
}
