//! What the stand-in box says of the rail's areas: its bots and group chats, the Work Queue's
//! categories, the machines it runs sessions on, the accounts' limits, and what waits on you.
//!
//! It also says what #711 is to add to the box (each marked `BOX-NEEDED` where the app reads it):
//! what a bot is doing now, the queue's counts, a ring's share and level, and `kuvo/waiting`. With
//! [`Areas::before_711`] it answers as a box does today, without them.

use serde_json::{Value, json};

use super::{DAY, HOUR, MINUTE};

/// How the stand-in answers for the areas.
#[derive(Clone, Copy, Debug, Default)]
pub struct Areas {
    /// As a box from before #711: none of what it's to add.
    pub before_711: bool,
    /// A first run: no bots, chats, machines or accounts.
    pub empty: bool,
}

/// Its answer to `method route`, if it's one of the areas' routes. `asked`: its sessions waiting on
/// you, each with since when (ms), as its list says them.
pub fn answer(areas: Areas, method: &str, route: &str, now: f64, asked: &[(String, f64)]) -> Option<(u16, Value)> {
    if method != "GET" {
        return None;
    }
    let full = !areas.before_711;
    let answer = match route {
        "kuvo/bots" => json!({ "bots": if areas.empty { Vec::new() } else { bots(full) } }),
        "kuvo/groups" => json!({ "groups": if areas.empty { Vec::new() } else { groups(now) } }),
        "kuvo/work-queue" => {
            let mut queue = json!({ "owner": "all", "categories": categories(), "items": [], "owners": [], "removed": [], "computers": [] });
            if full {
                queue["counts"] = if areas.empty {
                    json!({ "inProgress": 0, "categories": {} })
                } else {
                    json!({ "inProgress": 2, "categories": { "next": 6, "later": 6, "cat_design": 3, "parked": 4, "done": 31 } })
                };
            }
            queue
        }
        "kuvo/machines" => json!({ "machines": if areas.empty { Vec::new() } else { machines() }, "hosts": [] }),
        "kuvo/agents/api/kuvo/limits" => json!({ "data": { "accounts": [], "services": ["claude", "codex", "copilot", "grok", "openrouter"], "rows": if areas.empty { Vec::new() } else { accounts(now, full) } } }),
        "kuvo/waiting" if full => {
            let mut waiting: Vec<&(String, f64)> = asked.iter().collect();
            waiting.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let needs: Vec<Value> = waiting.iter().map(|(session, _)| json!({ "session": session, "asks": asks_of(session) })).collect();
            json!({ "sessions": needs.len(), "bots": if areas.empty { 0 } else { 2 }, "queue": 0, "needsYou": needs })
        }
        _ => return None,
    };
    Some((200, answer))
}

/// What a session waiting on you asks, as the box words it.
fn asks_of(session: &str) -> &'static str {
    match session {
        "ses_limits" => "asks to run a command",
        "ses_cms" => "has a question for you",
        _ => "waits on you",
    }
}

fn bots(full: bool) -> Vec<Value> {
    let bot = |id: &str, name: &str, color: &str, shape: &str, job: &str, now: Value| {
        let mut bot = json!({
            "id": id, "session": format!("ses_{}", id.trim_start_matches("bot_")), "name": name,
            "look": { "color": color, "shape": shape, "face": "calm" },
            "job": job, "jobDetails": "", "paused": false, "watching": 0, "agents": false,
            "folder": format!("{}/.kuvo-code/bots/{}", super::HOME, id.trim_start_matches("bot_")),
        });
        if full {
            bot["now"] = now;
        }
        bot
    };
    vec![
        bot("bot_mira", "Mira", "sky", "round", "Looks after the website", json!({ "working": 1, "asking": 1, "words": "1 at work, 1 waiting on you" })),
        bot("bot_inbox", "Inbox Helper", "coral", "squircle", "Drafts replies to support mail", json!({ "working": 0, "asking": 1, "words": "Waiting on you" })),
        bot("bot_release", "Release Captain", "lime", "pebble", "Ships a beta every Friday", json!({ "working": 0, "asking": 0, "words": "Wakes up Fri 09:00" })),
        bot("bot_docs", "Docs Keeper", "violet", "gem", "Keeps the docs matching the code", json!({ "working": 0, "asking": 0, "words": "Finished 3h ago" })),
    ]
}

fn groups(now: f64) -> Vec<Value> {
    vec![
        json!({ "id": "grp_launch", "name": "Launch crew", "members": [], "discussing": false, "paused": false, "unread": true, "last": { "id": "m1", "text": "Shipped.", "time": now - HOUR, "kind": "message" } }),
        json!({ "id": "grp_design", "name": "Design review", "members": [], "discussing": false, "paused": false, "unread": false, "last": { "id": "m2", "text": "Agreed.", "time": now - 2.0 * DAY, "kind": "message" } }),
    ]
}

fn categories() -> Vec<Value> {
    vec![
        json!({ "id": "next", "name": "Next", "builtIn": true }),
        json!({ "id": "later", "name": "Later", "builtIn": true }),
        json!({ "id": "cat_design", "name": "Design", "builtIn": false }),
        json!({ "id": "parked", "name": "Parked", "builtIn": true }),
        json!({ "id": "done", "name": "Done", "builtIn": true }),
    ]
}

fn machines() -> Vec<Value> {
    vec![
        json!({ "id": "devbox", "name": "devbox", "otherAddresses": [], "connection": "connected", "status": "Connected · Ubuntu 24.04" }),
        json!({ "id": "studio", "name": "studio-mini", "otherAddresses": [], "connection": "failed", "status": "Can’t be reached", "failure": "No route to host" }),
    ]
}

fn accounts(now: f64, full: bool) -> Vec<Value> {
    let window = |id: &str, used: f64, resets: f64, minutes: Option<u32>, model: Option<&str>, name: Option<&str>| {
        let mut window = json!({ "id": id, "used": used, "resetsAt": now + resets, "read": now - MINUTE, "source": "usage" });
        if let Some(minutes) = minutes {
            window["minutes"] = json!(minutes);
        }
        if let Some(model) = model {
            window["model"] = json!(model);
        }
        if let Some(name) = name {
            window["name"] = json!(name);
        }
        if full {
            window["level"] = json!(level(used));
        }
        window
    };
    let row = |service: &str, label: &str, plan: &str, windows: Vec<Value>| {
        let mut row = json!({ "service": service, "label": label, "plan": plan, "windows": windows.clone(), "checked": now - MINUTE });
        if full {
            // The fullest window that hasn't started over, as the box will say it.
            let used = windows.iter().filter_map(|window| window["used"].as_f64()).fold(0.0, f64::max);
            row["ring"] = json!({ "used": used, "level": level(used) });
        }
        row
    };
    vec![
        row("claude", "Work", "Max 20x", vec![window("five_hour", 0.46, 3.7 * HOUR, Some(300), None, None), window("seven_day", 0.38, 4.0 * DAY, Some(10080), None, None), window("seven_day_sonnet", 0.12, 4.0 * DAY, Some(10080), Some("Sonnet"), None)]),
        row("claude", "Personal", "Pro", vec![window("five_hour", 0.18, 4.1 * HOUR, Some(300), None, None), window("seven_day", 0.22, 2.0 * DAY, Some(10080), None, None)]),
        row("codex", "ChatGPT", "Pro", vec![window("primary", 0.74, 52.0 * MINUTE, Some(300), None, None), window("secondary", 0.41, 5.0 * DAY, Some(10080), None, None)]),
        row("copilot", "GitHub", "Pro+", vec![window("premium", 0.35, 17.0 * DAY, None, None, Some("Premium requests"))]),
        row("grok", "xAI", "SuperGrok", vec![window("week", 0.12, 3.0 * DAY, Some(10080), None, None)]),
        row("openrouter", "Team key", "Credits", vec![window("credits", 0.58, 20.0 * DAY, None, None, Some("Credits"))]),
    ]
}

fn level(used: f64) -> &'static str {
    if used >= 0.9 {
        "over"
    } else if used >= 0.7 {
        "near"
    } else {
        "calm"
    }
}
