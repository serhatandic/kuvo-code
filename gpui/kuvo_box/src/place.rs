//! Where this computer's own box is, and how its server is reached (PROTOCOL.md, "This Mac's box",
//! "A home of its own", "The app attached to this Mac's own box").
//!
//! - The app's box in its own folder, `~/Library/Application Support/run.kuvo.code/box`, whose
//!   keeper runs `kuvo-link.js serve` and records where it answers in `run/serve.json`.
//! - This Mac's box once it moved into a home of its own, `~/.kuvo-code` with `box/kind` `mac`,
//!   whose helper keeps its server up, recorded the same way.
//!
//! Either takes Kuvo Code's app as its own client (`x-kuvo-from: app`). The password is read only
//! from that record, as the app reads it, and only sent once the process the record names is the
//! box's server: a record a crash left names a port anyone on this computer could take.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::local::{LocalServer, Speaker};

/// Where a box on this computer keeps its home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeFolder {
    pub folder: PathBuf,
    pub speaker: Speaker,
}

/// The app's own folder for its box (macOS).
pub fn app_box_folder(home: &Path) -> PathBuf {
    home.join("Library/Application Support/run.kuvo.code/box")
}

/// The home of its own a box keeps on any computer.
pub fn own_home_folder(home: &Path) -> PathBuf {
    home.join(".kuvo-code")
}

/// The kind a box in a home of its own recorded (`box/kind`: `mac` once this Mac's box moved
/// there; none, or another word, is a machine's).
pub fn recorded_kind(folder: &Path) -> Option<String> {
    fs::read_to_string(folder.join("box/kind")).ok().map(|kind| kind.trim().to_owned()).filter(|kind| !kind.is_empty())
}

/// This Mac's own box, under `home`: the one that moved into a home of its own when there is one,
/// else the app's box in its folder. None on a computer with neither (Linux has no app's folder:
/// a machine's box there isn't this client's own; see [`crate::BoxClient::machine`]).
pub fn this_mac(home: &Path) -> Option<HomeFolder> {
    let own = own_home_folder(home);
    if recorded_kind(&own).as_deref() == Some("mac") {
        return Some(HomeFolder { folder: own, speaker: Speaker::App });
    }
    let app = app_box_folder(home);
    app.is_dir().then_some(HomeFolder { folder: app, speaker: Speaker::App })
}

/// Where a box's server answers, as its `run/serve.json` says: `{pid, port, password}`.
#[derive(Clone, Deserialize)]
pub struct ServeRecord {
    pub pid: i64,
    pub port: i64,
    pub password: String,
}

impl std::fmt::Debug for ServeRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never its password.
        f.debug_struct("ServeRecord").field("pid", &self.pid).field("port", &self.port).finish_non_exhaustive()
    }
}

/// What "isn't running" says, for this Mac.
const NOT_RUNNING: &str = "Kuvo Code on this Mac isn't running.";

/// The record in `folder`, checked: a whole one, naming a process that runs as the box's server.
pub fn serve_record(folder: &Path, runs_serve: impl Fn(i64) -> bool) -> Result<ServeRecord> {
    let text = fs::read(folder.join("run/serve.json")).map_err(|_| Error::NotRunning(NOT_RUNNING.into()))?;
    let record: ServeRecord = serde_json::from_slice(&text).map_err(|_| Error::NotRunning(NOT_RUNNING.into()))?;
    if record.pid <= 1 || !(1..=65535).contains(&record.port) || record.password.is_empty() {
        return Err(Error::NotRunning(NOT_RUNNING.into()));
    }
    if !runs_serve(record.pid) {
        return Err(Error::NotRunning(NOT_RUNNING.into()));
    }
    Ok(record)
}

/// The server `place` records, for a client to reach: as its record says at each request. Checked
/// now too, so a box that isn't running is said at once.
pub fn server(place: &HomeFolder, label: &str) -> Result<LocalServer> {
    serve_record(&place.folder, runs_serve)?;
    Ok(LocalServer::recorded(place.folder.clone(), place.speaker, label))
}

/// Whether process `pid` runs as a box's server: its command line has `kuvo-link.js serve` (as
/// the box itself believes its record, and the Mac app checks it).
pub fn runs_serve(pid: i64) -> bool {
    arguments_of(pid).is_some_and(|arguments| is_serve_command(&arguments.join(" ")))
}

/// Whether a command line is `… kuvo-link.js serve …`.
pub fn is_serve_command(line: &str) -> bool {
    let mut rest = line;
    while let Some(at) = rest.find("kuvo-link.js serve") {
        let after = &rest[at + "kuvo-link.js serve".len()..];
        if after.is_empty() || after.starts_with(char::is_whitespace) {
            return true;
        }
        rest = after;
    }
    false
}

/// The arguments process `pid` was started with, where this computer can say.
#[cfg(target_os = "linux")]
pub fn arguments_of(pid: i64) -> Option<Vec<String>> {
    use std::os::unix::fs::MetadataExt;
    // Only this user's: another's command line can be read here too, and isn't this user's box.
    // SAFETY: getuid has no preconditions.
    if fs::metadata(format!("/proc/{pid}")).ok()?.uid() != unsafe { libc::getuid() } {
        return None;
    }
    let bytes = fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    let arguments: Vec<String> = bytes.split(|byte| *byte == 0).filter(|part| !part.is_empty()).map(|part| String::from_utf8_lossy(part).into_owned()).collect();
    (!arguments.is_empty()).then_some(arguments)
}

/// The arguments process `pid` was started with (`KERN_PROCARGS2`: its argument count, its
/// executable's path, padding, then each argument), for a process of this user's.
#[cfg(target_os = "macos")]
pub fn arguments_of(pid: i64) -> Option<Vec<String>> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut most: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: `name` names a value of `size` bytes, written into `most`.
    let found = unsafe { libc::sysctl(name.as_mut_ptr(), 2, (&mut most as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0) };
    if found != 0 || most <= 0 {
        return None;
    }
    let mut buffer = vec![0u8; most as usize];
    let mut size = buffer.len();
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    // SAFETY: the kernel writes at most `size` bytes into `buffer`, and says how many.
    let found = unsafe { libc::sysctl(name.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
    if found != 0 || size < std::mem::size_of::<libc::c_int>() {
        return None;
    }
    buffer.truncate(size);
    let count = i32::from_ne_bytes(buffer[..4].try_into().ok()?);
    let mut rest = &buffer[4..];
    // The executable's path, then the padding after it.
    let end = rest.iter().position(|byte| *byte == 0)?;
    rest = &rest[end..];
    let start = rest.iter().position(|byte| *byte != 0)?;
    rest = &rest[start..];
    let arguments: Vec<String> = rest.split(|byte| *byte == 0).take(usize::try_from(count).ok()?).map(|part| String::from_utf8_lossy(part).into_owned()).collect();
    (!arguments.is_empty()).then_some(arguments)
}

/// Elsewhere (Windows, for now) a process's command line isn't read: no record is taken.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn arguments_of(_pid: i64) -> Option<Vec<String>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_box_server_s_command_line_is_taken() {
        for line in ["/opt/bun /home/me/.kuvo-code/bin/kuvo-link.js serve", "bun kuvo-link.js serve --kept", "sh -c read _ kuvo-link.js serve"] {
            assert!(is_serve_command(line), "{line}");
        }
        for line in ["bun kuvo-link.js server", "bun kuvo-link.js serves", "bun kuvo-link.js box route", "kuvo-link.jsserve", ""] {
            assert!(!is_serve_command(line), "{line}");
        }
    }

    #[test]
    fn this_process_isnt_a_box_server() {
        assert!(arguments_of(std::process::id() as i64).is_some());
        assert!(!runs_serve(std::process::id() as i64));
    }

    #[test]
    fn a_record_that_isnt_whole_is_no_server() {
        let made = tempfile::tempdir().unwrap();
        let folder = made.path();
        std::fs::create_dir_all(folder.join("run")).unwrap();
        for record in ["{}", "not json", r#"{"pid": 1, "port": 80, "password": "x"}"#, r#"{"pid": 99, "port": 0, "password": "x"}"#, r#"{"pid": 99, "port": 80, "password": ""}"#] {
            std::fs::write(folder.join("run/serve.json"), record).unwrap();
            assert!(matches!(serve_record(folder, |_| true), Err(Error::NotRunning(_))), "{record}");
        }
        std::fs::write(folder.join("run/serve.json"), r#"{"pid": 99, "port": 80, "password": "secret"}"#).unwrap();
        let record = serve_record(folder, |pid| pid == 99).unwrap();
        // Never its password, wherever it's shown.
        assert!(!format!("{record:?}").contains("secret"));
    }
}
