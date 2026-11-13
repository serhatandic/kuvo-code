//! A machine's box over SSH (PROTOCOL.md, "Settings per box"): `kuvo-link.js box route` there takes
//! `{method, path, body?, headers?}` on its standard input and prints `{status, body}` (or
//! `{status, bodyBase64, type}` for bytes that aren't text), answered as a phone's request is: once,
//! a followed route's first line. So what follows a machine reads it again on a timer.
//!
//! It runs as the Mac app runs it: with the machine's own engine runtime (the newest it has), its
//! home `~/.kuvo-code`, and the script sent as base64 for `sh`, whatever the login shell is there.

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine as _;
use serde::Deserialize;

use crate::error::{Error, Result};
use crate::transport::{Closer, Request, Response, Stream, Transport};

/// One machine, by what `ssh` connects to (`me@devbox`, a `Host` in `~/.ssh/config`).
#[derive(Debug, Clone)]
pub struct SshBox {
    destination: String,
    /// The `ssh` to run: `ssh` on the PATH unless a test names a stand-in.
    program: PathBuf,
    /// The box's home in the machine's home folder.
    root: String,
    /// A folder of this user's alone where connections are shared (`ControlPath`), so each request
    /// costs a round trip rather than a login: the app's own `/tmp/kuvo-ssh-<uid>` (the one place
    /// outside its folders Kuvo Code keeps anything, docs/footprint.md). None: one login each.
    sharing: Option<PathBuf>,
}

impl SshBox {
    pub fn new(destination: impl Into<String>) -> SshBox {
        SshBox { destination: destination.into(), program: PathBuf::from("ssh"), root: ".kuvo-code".into(), sharing: None }
    }

    /// Runs `program` in place of `ssh` (a test's stand-in, or an `ssh` at a path of its own).
    pub fn program(mut self, program: impl Into<PathBuf>) -> SshBox {
        self.program = program.into();
        self
    }

    /// Shares one connection per machine through sockets in `folder`, as the Mac app does
    /// (`/tmp/kuvo-ssh-<uid>`). Taken only while it's this user's alone; otherwise each request
    /// logs in on its own.
    pub fn sharing_connections_in(mut self, folder: impl Into<PathBuf>) -> SshBox {
        self.sharing = Some(folder.into());
        self
    }

    pub fn destination(&self) -> &str {
        &self.destination
    }

    /// For every connection: never a password prompt (there's no terminal to type it in), a time
    /// to connect, and a check that notices a machine gone away. A command or a terminal of the
    /// machine's own in `~/.ssh/config` is left out: ssh refuses a command beside one.
    fn options(&self) -> Vec<String> {
        let mut options: Vec<String> = [
            "-o", "BatchMode=yes",
            "-o", "RemoteCommand=none",
            "-o", "RequestTTY=no",
            "-o", "ConnectTimeout=15",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
        ]
        .iter()
        .map(|option| option.to_string())
        .collect();
        match self.sharing.as_deref().filter(|folder| is_own_private_folder(folder)) {
            Some(folder) => {
                options.extend(["-o".into(), "ControlMaster=auto".into(), "-o".into(), format!("ControlPath={}/%C", folder.display()), "-o".into(), "ControlPersist=120".into()]);
            }
            None => options.extend(["-o", "ControlMaster=no", "-o", "ControlPath=none"].iter().map(|option| option.to_string())),
        }
        options
    }

    /// The script that answers one request there.
    fn script(&self) -> String {
        format!(
            r#"K="$HOME/{root}"
[ -f "$K/bin/kuvo-link.js" ] || {{ echo "Kuvo Code isn't set up on this machine." >&2; exit 3; }}
E=$(for d in "$K"/engine/*/; do [ -x "${{d}}opencode" ] && basename "$d"; done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
[ -n "$E" ] || {{ echo "Kuvo Code's engine isn't on this machine." >&2; exit 3; }}
export XDG_DATA_HOME="$K/data" XDG_CONFIG_HOME="$K/config" XDG_STATE_HOME="$K/state" XDG_CACHE_HOME="$K/cache" KUVO_INTEGRATIONS="$K/integrations" TMPDIR="$K/tmp"
cd "$K/workspace" 2>/dev/null || cd "$K" || exit 1
export KUVO_HOME="$K" BUN_BE_BUN=1 BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
exec "$K/engine/$E/opencode" --config=/dev/null --no-env-file "$K/bin/kuvo-link.js" box route"#,
            root = self.root
        )
    }

    /// The command line for the machine's login shell that runs `script` with `sh`: as base64, which
    /// no shell changes (fish reads backslashes in quotes its own way). Without a working `base64`
    /// there it fails (127) rather than running nothing and saying it's done.
    pub fn command_line(script: &str) -> String {
        let encoded = base64::engine::general_purpose::STANDARD.encode(script);
        format!("exec sh -c 'kuvo_script=$(printf %s {encoded} | base64 -d) || exit 127; eval \"$kuvo_script\"'")
    }

    fn run(&self, input: &[u8]) -> Result<String> {
        let mut command = Command::new(&self.program);
        command.args(self.options()).arg(&self.destination).arg(Self::command_line(&self.script()));
        // Nothing of a Kuvo Code process's own goes along (ssh sends a machine only `LANG` and
        // `LC_*`, but a stand-in runs here).
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("KUVO_") {
                command.env_remove(name);
            }
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| Error::Unreachable(format!("Couldn't start ssh to reach {} ({}).", self.destination, error.kind())))?;
        if let Some(mut stdin) = child.stdin.take() {
            // (A machine that doesn't read it all has failed, which its status says.)
            let _ = stdin.write_all(input);
        }
        let output = child.wait_with_output().map_err(|error| Error::Unreachable(format!("Couldn't reach {} ({}).", self.destination, error.kind())))?;
        if !output.status.success() {
            let said = String::from_utf8_lossy(&output.stderr);
            let said = said.lines().map(str::trim).rfind(|line| !line.is_empty()).unwrap_or("").chars().take(300).collect::<String>();
            return Err(match output.status.code() {
                Some(255) | None => Error::Unreachable(format!("Couldn't reach {}.{}", self.destination, if said.is_empty() { String::new() } else { format!(" {said}") })),
                Some(_) if !said.is_empty() => Error::Unreachable(said),
                Some(code) => Error::Unreachable(format!("Kuvo Code on {} didn't answer ({code}).", self.destination)),
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// What `box route` prints: its status, and its body as text or (bytes) base64.
#[derive(Deserialize)]
struct Routed {
    status: u16,
    body: Option<String>,
    #[serde(rename = "bodyBase64")]
    body_base64: Option<String>,
    #[serde(rename = "type")]
    content_type: Option<String>,
}

impl Transport for SshBox {
    fn send(&self, request: &Request) -> Result<Response> {
        let mut asked = serde_json::json!({ "method": request.method.to_ascii_uppercase(), "path": request.path.trim_start_matches('/') });
        if let Some(body) = &request.body {
            asked["body"] = body.clone();
        }
        // The folder a request is about, as a phone's request names it; the rest are the engine's
        // password's and the link's own, which `box route` adds itself.
        let headers: serde_json::Map<String, serde_json::Value> = request
            .headers
            .iter()
            .filter(|(name, _)| name == "x-opencode-directory")
            .map(|(name, value)| (name.clone(), serde_json::Value::String(value.clone())))
            .collect();
        if !headers.is_empty() {
            asked["headers"] = serde_json::Value::Object(headers);
        }
        let output = self.run(&serde_json::to_vec(&asked).unwrap_or_default())?;
        let last = output.lines().map(str::trim).rfind(|line| !line.is_empty()).unwrap_or("");
        let routed: Routed = serde_json::from_str(last)
            .map_err(|_| Error::BadAnswer(format!("Kuvo Code on {} didn't answer as it should: {}", self.destination, last.chars().take(200).collect::<String>())))?;
        let body = match (routed.body_base64, routed.body) {
            (Some(encoded), _) => base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| Error::BadAnswer(format!("Kuvo Code on {} sent bytes that couldn't be read.", self.destination)))?,
            (None, Some(text)) => text.into_bytes(),
            (None, None) => Vec::new(),
        };
        Ok(Response { status: routed.status, content_type: routed.content_type.or_else(|| Some("application/json".into())), body })
    }

    fn open(&self, request: &Request) -> Result<Stream> {
        let response = self.send(request)?;
        Ok(Stream { status: response.status, content_type: response.content_type, reader: Box::new(Cursor::new(response.body)), closer: Closer::nothing() })
    }

    fn streams(&self) -> bool {
        false
    }

    fn describe(&self) -> String {
        self.destination.clone()
    }
}

/// Whether `folder` is a folder of this user's that no one else can reach: one another account
/// made first could hold a socket of its own, which ssh would hand what it sends.
#[cfg(unix)]
fn is_own_private_folder(folder: &Path) -> bool {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    // Made private in one step (a umask only takes bits away).
    let _ = std::fs::DirBuilder::new().mode(0o700).create(folder);
    let Ok(metadata) = std::fs::symlink_metadata(folder) else { return false };
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    metadata.is_dir() && metadata.uid() == uid && metadata.mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn is_own_private_folder(_folder: &Path) -> bool {
    false
}

/// The Mac app's folder for shared SSH connections, `/tmp/kuvo-ssh-<uid>`.
#[cfg(unix)]
pub fn app_sharing_folder() -> PathBuf {
    // SAFETY: getuid has no preconditions.
    PathBuf::from(format!("/tmp/kuvo-ssh-{}", unsafe { libc::getuid() }))
}
