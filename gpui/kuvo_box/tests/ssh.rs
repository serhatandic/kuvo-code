//! A machine's box over SSH, against a stand-in: an `ssh` that runs what it's given here, with a
//! home of the test's own laid out as a machine's (`~/.kuvo-code/bin/kuvo-link.js`, an engine
//! runtime in `engine/<version>/opencode`), whose stand-in runtime answers `box route` from files.
//! So the script that finds the runtime and runs `box route` there is the one that runs.

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use kuvo_box::follow::{ListUpdate, Timing};
use kuvo_box::{BoxClient, Error, Gate, SshBox};
use serde_json::{Value, json};

struct Machine {
    folder: tempfile::TempDir,
}

impl Machine {
    fn new() -> Machine {
        let folder = support::home();
        let root = folder.path().join("home/.kuvo-code");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        std::fs::create_dir_all(folder.path().join("answers")).unwrap();
        std::fs::write(root.join("bin/kuvo-link.js"), "// stand-in\n").unwrap();
        // Two runtimes: the newest is the one used.
        for version in ["1.9.0", "1.10.2"] {
            let runtime = root.join(format!("engine/{version}/opencode"));
            std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
            executable(&runtime, &engine_script(folder.path(), version));
        }
        executable(&folder.path().join("ssh"), &ssh_script(folder.path()));
        Machine { folder }
    }

    fn path(&self) -> &Path {
        self.folder.path()
    }

    fn client(&self) -> BoxClient {
        BoxClient::machine(SshBox::new("me@devbox.invalid").program(self.path().join("ssh")))
    }

    /// What `box route` prints for a route.
    fn answer(&self, name: &str, status: u16, body: &Value) {
        let printed = json!({ "status": status, "body": body.to_string() });
        std::fs::write(self.path().join("answers").join(name), format!("{printed}\n")).unwrap();
    }

    /// What `box route` was asked, a request a line.
    fn asked(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path().join("asked")).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.path().join(name)).unwrap_or_default()
    }
}

fn executable(path: &Path, script: &str) {
    std::fs::write(path, script).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

/// `ssh`: notes its arguments, then runs the command it was given, as a login shell there would,
/// in the machine's home.
fn ssh_script(folder: &Path) -> String {
    format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{dir}/ssh-arguments'\nfor last; do :; done\ncd '{dir}/home' && HOME='{dir}/home' exec /bin/sh -c \"$last\"\n",
        dir = folder.display()
    )
}

/// The engine's runtime: as `box route`, notes what it ran with and was asked, and prints the
/// answer the test left for that route.
fn engine_script(folder: &Path, version: &str) -> String {
    format!(
        r#"#!/bin/sh
dir='{dir}'
printf '%s %s\n' '{version}' "$*" > "$dir/ran"
printf '%s\n' "$KUVO_HOME" > "$dir/kuvo-home"
asked=$(cat)
printf '%s\n' "$asked" >> "$dir/asked"
case "$asked" in
  *'"path":"kuvo/info"'*) cat "$dir/answers/info" ;;
  *'"path":"kuvo/sessions/list'*) cat "$dir/answers/list" ;;
  *'"path":"kuvo/file'*) printf '%s\n' '{{"status":200,"bodyBase64":"AAEC/w==","type":"image/png"}}' ;;
  *'"path":"kuvo/broken'*) echo 'not an answer' ;;
  *'"path":"kuvo/gone'*) echo 'Connection to devbox closed.' >&2; exit 255 ;;
  *) printf '%s\n' '{{"status":404,"body":"{{}}"}}' ;;
esac
"#,
        dir = folder.display()
    )
}

fn machine_info(features: Value) -> Value {
    json!({ "kind": "machine", "name": "devbox", "bridge": "abc123", "engine": "2.2.6", "features": features, "agents": false, "started": null, "chats": "/home/me/.kuvo-code/chats", "running": true, "stopped": false })
}

fn list() -> Value {
    json!({ "at": "4", "full": true, "sessions": { "ses_m": { "kind": "project", "project": "/home/me/site", "directory": "/home/me/site", "created": 1, "updated": 2, "title": "On the machine" } }, "projects": { "/home/me/site": { "updated": 2 } } })
}

#[test]
fn a_machines_box_answers_through_box_route_over_ssh() {
    let machine = Machine::new();
    machine.answer("info", 200, &machine_info(support::current_features()));
    machine.answer("list", 200, &list());
    let client = machine.client();
    assert!(!client.streams());

    let info = client.connect().expect("kuvo/info over SSH");
    assert_eq!((info.kind.as_str(), info.name.as_str()), ("machine", "devbox"));
    assert_eq!(client.gate(), Gate::Open);
    let line = client.session_list(Some("3")).unwrap();
    assert_eq!(line.sessions["ses_m"].title.as_deref(), Some("On the machine"));

    // Asked as the Mac asks: the newest runtime there, `box route`, the box's home, the request on
    // its input.
    assert_eq!(machine.read("ran").trim(), format!("1.10.2 --config=/dev/null --no-env-file {}/home/.kuvo-code/bin/kuvo-link.js box route", machine.path().display()));
    assert_eq!(PathBuf::from(machine.read("kuvo-home").trim()), machine.path().join("home/.kuvo-code"));
    assert_eq!(machine.asked(), vec![json!({ "method": "GET", "path": "kuvo/info" }), json!({ "method": "GET", "path": "kuvo/sessions/list?since=3" })]);
    // Never a password prompt, nor a terminal; the machine as it was named.
    let arguments = machine.read("ssh-arguments");
    for option in ["BatchMode=yes", "RequestTTY=no", "RemoteCommand=none"] {
        assert!(arguments.lines().any(|line| line == option), "{option}");
    }
    assert!(arguments.lines().any(|line| line == "me@devbox.invalid"));
}

#[test]
fn what_a_machine_says_wrong_is_said_plainly() {
    let machine = Machine::new();
    machine.answer("info", 200, &machine_info(support::current_features()));
    let client = machine.client();

    // Bytes that aren't text come as base64.
    let response = client.send(&kuvo_box::transport::Request::get("kuvo/file?uri=x")).unwrap();
    assert_eq!((response.status, response.body.as_slice(), response.content_type.as_deref()), (200, &[0u8, 1, 2, 255][..], Some("image/png")));
    assert!(matches!(client.send(&kuvo_box::transport::Request::get("kuvo/broken")), Err(Error::BadAnswer(_))));
    match client.send(&kuvo_box::transport::Request::get("kuvo/gone")) {
        Err(Error::Unreachable(why)) => assert!(why.contains("devbox"), "{why}"),
        other => panic!("unreachable, not {other:?}"),
    }
    assert_eq!(client.send(&kuvo_box::transport::Request::get("kuvo/nothing")).unwrap().status, 404);

    // A machine Kuvo Code was never set up on.
    std::fs::remove_file(machine.path().join("home/.kuvo-code/bin/kuvo-link.js")).unwrap();
    match machine.client().connect() {
        Err(Error::Unreachable(why)) => assert_eq!(why, "Kuvo Code isn't set up on this machine."),
        other => panic!("not set up, not {other:?}"),
    }
}

#[test]
fn an_older_machine_is_held() {
    let machine = Machine::new();
    machine.answer("info", 200, &machine_info(json!(["sessions.list"])));
    machine.answer("list", 200, &list());
    let client = machine.client();
    assert!(matches!(client.session_list(None), Err(Error::NeedsUpdating { .. })));
    // Asked only what it is.
    assert_eq!(machine.asked().len(), 1);
}

#[test]
fn a_machines_list_is_followed_by_reading_it_again() {
    let machine = Machine::new();
    machine.answer("info", 200, &machine_info(support::current_features()));
    machine.answer("list", 200, &list());
    let follow = machine.client().follow_sessions(Timing { retry_after: Duration::ZERO, ..Timing::default() });
    let ListUpdate::Listing(listing) = follow.next_blocking().unwrap() else { panic!("the list") };
    assert_eq!(listing.sidebar().projects[0].sessions, vec!["ses_m"]);
    assert_eq!(listing.at(), Some("4"));
    // Read whole, not followed: a machine over SSH answers once.
    assert!(machine.asked().iter().any(|asked| asked["path"] == json!("kuvo/sessions/list")));
}
