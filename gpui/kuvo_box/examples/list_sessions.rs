//! Lists a box's sessions as a sidebar would show them.
//!
//! ```sh
//! cargo run -p kuvo_box --example list_sessions -- --stand-in      # a made-up box, nothing real touched
//! cargo run -p kuvo_box --example list_sessions                    # this Mac's own box
//! cargo run -p kuvo_box --example list_sessions -- --ssh me@devbox # a machine's, over SSH
//! cargo run -p kuvo_box --example list_sessions -- --follow        # and again as it changes
//! ```

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use kuvo_box::follow::{ListUpdate, Timing};
use kuvo_box::{BoxClient, Listing, SshBox};

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    // The stand-in, when asked for, lives until the end (its folder and process go with it).
    let stand_in = arguments.iter().any(|argument| argument == "--stand-in").then(StandIn::start);
    if let Err(why) = run(&arguments, stand_in.as_ref()) {
        eprintln!("{why}");
        drop(stand_in);
        std::process::exit(1);
    }
}

fn run(arguments: &[String], stand_in: Option<&StandIn>) -> Result<(), kuvo_box::Error> {
    let follow = arguments.iter().any(|argument| argument == "--follow");
    let value = |name: &str| arguments.iter().position(|argument| argument == name).and_then(|at| arguments.get(at + 1)).cloned();
    let client = if let Some(stand_in) = stand_in {
        BoxClient::this_mac(stand_in.home.path())?
    } else if let Some(destination) = value("--ssh") {
        BoxClient::machine(SshBox::new(destination))
    } else {
        let home = value("--home").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from)).unwrap_or_default();
        BoxClient::this_mac(&home)?
    };

    let info = client.connect()?;
    println!("{} ({}, {})\n", info.name, info.kind, client.describe());

    if !follow {
        let mut listing = Listing::new();
        listing.take(client.session_list(None)?);
        print(&listing);
        return Ok(());
    }
    let follow = client.follow_sessions(Timing::default());
    while let Some(update) = follow.next_blocking() {
        match update {
            ListUpdate::Listing(listing) => print(&listing),
            ListUpdate::Waiting(why) => println!("Loading sessions… {why}"),
            ListUpdate::Held { missing } => println!("{} (it lacks {})", kuvo_box::gate::UPDATING, missing.join(", ")),
            ListUpdate::Failed(error) => println!("{error}"),
        }
    }
    Ok(())
}

fn print(listing: &Listing) {
    let sidebar = listing.sidebar();
    let row = |id: &str| {
        let facts = listing.facts(id);
        let title = facts.and_then(|facts| facts.title.clone()).unwrap_or_else(|| "New Session".into());
        let running = if facts.is_some_and(|facts| facts.is_running()) { "  · working" } else { "" };
        let asked = if facts.is_some_and(|facts| facts.asked.is_some()) { "  · waiting on you" } else { "" };
        format!("    {title}{running}{asked}")
    };
    if !sidebar.pinned.is_empty() {
        println!("Pinned");
        sidebar.pinned.iter().for_each(|id| println!("{}", row(id)));
    }
    for group in &sidebar.projects {
        println!("{}", group.name);
        group.sessions.iter().for_each(|id| println!("{}", row(id)));
    }
    if !sidebar.chats.is_empty() {
        println!("Chats");
        sidebar.chats.iter().for_each(|id| println!("{}", row(id)));
    }
    println!();
}

/// A made-up box, as this Mac's own would be: its server on 127.0.0.1, its record in a folder of
/// its own (gone at the end), naming a process that runs as `kuvo-link.js serve`.
struct StandIn {
    home: tempfile::TempDir,
    process: std::process::Child,
}

impl StandIn {
    fn start() -> StandIn {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let port = listener.local_addr().unwrap().port();
        let mut secret = [0u8; 16];
        getrandom::fill(&mut secret).expect("random bytes");
        let password: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
        let expected = format!("Basic {}", base64::Engine::encode(&base64::engine::general_purpose::STANDARD, format!("opencode:{password}")));
        std::thread::spawn(move || {
            for connection in listener.incoming().flatten() {
                let mut reader = BufReader::new(connection.try_clone().unwrap());
                let mut first = String::new();
                let _ = reader.read_line(&mut first);
                let mut authorized = false;
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                        break;
                    }
                    authorized |= line.trim() == format!("Authorization: {expected}");
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                }
                let _ = reader.take(length).read_to_end(&mut Vec::new());
                let path = first.split_whitespace().nth(1).unwrap_or("/");
                let (status, body) = match (authorized, path.split('?').next().unwrap_or(path)) {
                    (false, _) => (401, String::new()),
                    (true, "/kuvo/info") => (200, serde_json::json!({ "kind": "mac", "name": "Stand-in Mac", "app": "0.0.0", "engine": "0.0.0", "features": kuvo_box::gate::REQUIRED, "agents": false, "started": null, "chats": "/Users/me/.kuvo-code/chats" }).to_string()),
                    (true, "/kuvo/sessions/list") => (200, serde_json::json!({
                        "at": "1", "full": true,
                        "sessions": {
                            "ses_1": { "kind": "project", "project": "/Users/me/website", "directory": "/Users/me/website", "title": "Fix the navigation bar", "created": 1, "updated": 3000, "running": true },
                            "ses_2": { "kind": "project", "project": "/Users/me/website", "directory": "/Users/me/website", "title": "Dark mode", "created": 1, "updated": 2000, "pinned": true },
                            "ses_3": { "kind": "project", "project": "/Users/me/api", "directory": "/Users/me/api", "title": "Rate limits", "created": 1, "updated": 1000, "asked": 900 },
                            "ses_4": { "kind": "chat", "directory": "/Users/me/.kuvo-code/chats", "title": "Recipe ideas", "created": 1, "updated": 500 },
                            "ses_5": { "kind": "subagent", "directory": "/Users/me/website", "created": 1, "updated": 3001, "parent": "ses_1" }
                        },
                        "projects": { "/Users/me/website": { "name": "Website", "updated": 3000 }, "/Users/me/api": { "updated": 1000 }, "/Users/me/notes": {} }
                    }).to_string()),
                    (true, _) => (404, "{}".into()),
                };
                let mut writer = connection;
                let _ = write!(writer, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let home = tempfile::Builder::new().prefix("kuvo-box-example").tempdir().expect("a folder");
        // A process that runs as the box's server, as its record says: it ends when its input closes.
        let mut process = Command::new("/bin/sh")
            .args(["-c", "echo ready; read _", "kuvo-link.js", "serve"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sh");
        BufReader::new(process.stdout.take().unwrap()).read_line(&mut String::new()).unwrap();
        let run = home.path().join("Library/Application Support/run.kuvo.code/box/run");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::write(run.join("serve.json"), serde_json::json!({ "pid": process.id(), "port": port, "password": password }).to_string()).unwrap();
        StandIn { home, process }
    }
}

impl Drop for StandIn {
    fn drop(&mut self) {
        drop(self.process.stdin.take());
        let _ = self.process.wait();
    }
}
