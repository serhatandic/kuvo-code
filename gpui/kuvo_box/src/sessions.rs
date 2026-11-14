//! Session lists (PROTOCOL.md, "Session lists", `sessions.list`): what each session is and the
//! project it's filed under, which the box works out, so a client draws its sidebar from facts and
//! works nothing out. What's here is only taking the box's lines in and the drawing's order, held
//! to `protocol/vectors/session-lists.json` as KuvoClient's `SessionLists` is.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

/// The list now (`since`: only what changed after it, where the box can still say).
pub fn route(since: Option<&str>) -> String {
    format!("kuvo/sessions/list{}", query(since))
}

/// The list now, then a line for each change.
pub fn events_route(since: Option<&str>) -> String {
    format!("kuvo/sessions/list/events{}", query(since))
}

fn query(since: Option<&str>) -> String {
    match since.filter(|since| !since.is_empty()) {
        Some(since) => format!("?since={}", crate::paths::query_value(since)),
        None => String::new(),
    }
}

/// What a session is. One a newer box names that this doesn't know shows nowhere.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Kind(pub String);

impl Kind {
    /// A project's session.
    pub fn is_project(&self) -> bool {
        self.0 == "project"
    }
    /// A conversation of no project.
    pub fn is_chat(&self) -> bool {
        self.0 == "chat"
    }
}

/// One session, as its box says.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Facts {
    pub kind: Kind,
    /// The project it's filed under (a project's session's), the folder as its box names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub created: f64,
    /// When it last changed (ms): the lists' order.
    pub updated: f64,
    /// The session it works for (a subagent's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    /// Since when it's waited on you (ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asked: Option<f64>,
    /// This copy isn't its box's own (it moved, or is on its way there).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub away: Option<bool>,
}

impl Facts {
    pub fn is_pinned(&self) -> bool {
        self.pinned == Some(true)
    }
    pub fn is_archived(&self) -> bool {
        self.archived == Some(true)
    }
    pub fn is_running(&self) -> bool {
        self.running == Some(true)
    }
}

/// A project the lists show: its name where its list gives one, and when its newest session
/// changed (none for one with none).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Project {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<f64>,
}

/// A line from the box: whole (`full`), or what changed since the line before.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Line {
    pub at: String,
    #[serde(default)]
    pub full: Option<bool>,
    #[serde(default)]
    pub sessions: HashMap<String, Facts>,
    #[serde(default)]
    pub gone: Option<Vec<String>>,
    #[serde(default)]
    pub projects: HashMap<String, Project>,
    /// What the box couldn't read yet (`bridge`): its sessions are as last read.
    #[serde(default)]
    pub pending: Option<Vec<String>>,
}

/// A box's list as a client keeps it, line after line.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Listing {
    at: Option<String>,
    sessions: HashMap<String, Facts>,
    projects: HashMap<String, Project>,
    /// What it said of sessions it has let go since (deleted there, or moved away), for a row a
    /// client still holds as it goes.
    former: HashMap<String, Facts>,
    pending: Vec<String>,
}

impl Listing {
    pub fn new() -> Listing {
        Listing::default()
    }

    /// Where it's at: given back as `since` to resume after a dropped stream.
    pub fn at(&self) -> Option<&str> {
        self.at.as_deref()
    }

    /// Whether its box has said it yet.
    pub fn is_read(&self) -> bool {
        self.at.is_some()
    }

    pub fn sessions(&self) -> &HashMap<String, Facts> {
        &self.sessions
    }

    pub fn projects(&self) -> &HashMap<String, Project> {
        &self.projects
    }

    /// What the box couldn't read yet (`["bridge"]`): its sessions there are as last read.
    pub fn pending(&self) -> &[String] {
        &self.pending
    }

    /// What its box says of session `id`: as it's listed, else as it was before it was let go.
    pub fn facts(&self, id: &str) -> Option<&Facts> {
        self.sessions.get(id).or_else(|| self.former.get(id))
    }

    /// `line` taken in: a whole one in place of what was, else what changed. Whether anything did.
    pub fn take(&mut self, line: Line) -> bool {
        let was_read = self.at.is_some();
        let before = (self.sessions.clone(), self.projects.clone(), std::mem::take(&mut self.pending));
        self.at = Some(line.at);
        if line.full == Some(true) {
            for (id, facts) in self.sessions.drain() {
                if !line.sessions.contains_key(&id) {
                    self.former.insert(id, facts);
                }
            }
            self.sessions = line.sessions.clone();
        } else {
            for (id, facts) in &line.sessions {
                self.sessions.insert(id.clone(), facts.clone());
            }
            for id in line.gone.iter().flatten() {
                if let Some(facts) = self.sessions.remove(id) {
                    self.former.insert(id.clone(), facts);
                }
            }
        }
        for id in line.sessions.keys() {
            self.former.remove(id);
        }
        if self.former.len() > 500 {
            self.former.clear();
        }
        self.projects = line.projects;
        self.pending = line.pending.unwrap_or_default();
        !was_read || before.0 != self.sessions || before.1 != self.projects || before.2 != self.pending
    }

    /// The sidebar a client draws from it ([`sidebar`]).
    pub fn sidebar(&self) -> Sidebar {
        sidebar(&self.sessions, &self.projects)
    }

    /// How many sessions wait on you, of those a client shows.
    pub fn waiting_on_you(&self) -> usize {
        self.sessions.values().filter(|facts| place(Some(facts)).is_some() && facts.asked.is_some()).count()
    }
}

/// Where a session shows in the lists: under its project, or in Chats.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Place {
    Project(String),
    Chat,
}

/// Where `facts`' session shows: a project's session under its project, a chat in Chats, unless
/// its box says it's archived; any other kind, or one its box hasn't listed, nowhere.
pub fn place(facts: Option<&Facts>) -> Option<Place> {
    let facts = facts?;
    if facts.is_archived() {
        return None;
    }
    if facts.kind.is_project() {
        Some(Place::Project(facts.project.clone().unwrap_or_else(|| facts.directory.clone())))
    } else if facts.kind.is_chat() {
        Some(Place::Chat)
    } else {
        None
    }
}

/// What a client's sidebar shows, as the box's facts say: pinned and Chats newest first; the
/// projects by their newest session shown, those with none last, ties by name (its list's name,
/// else its folder's last part; Finder's order); each project's sessions newest first.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Sidebar {
    pub pinned: Vec<String>,
    pub chats: Vec<String>,
    pub projects: Vec<ProjectGroup>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectGroup {
    pub directory: String,
    pub name: String,
    pub sessions: Vec<String>,
}

/// The sidebar for `sessions` and `projects` as a box lists them.
pub fn sidebar(sessions: &HashMap<String, Facts>, projects: &HashMap<String, Project>) -> Sidebar {
    let shown: Vec<(&String, &Facts, Place)> = sessions.iter().filter_map(|(id, facts)| place(Some(facts)).map(|place| (id, facts, place))).collect();
    let newest = |mut rows: Vec<(&String, &Facts)>| -> Vec<String> {
        rows.sort_by(|a, b| b.1.updated.partial_cmp(&a.1.updated).unwrap_or(Ordering::Equal).then_with(|| a.0.cmp(b.0)));
        rows.into_iter().map(|(id, _)| id.clone()).collect()
    };
    let pinned = newest(shown.iter().filter(|(_, facts, _)| facts.is_pinned()).map(|(id, facts, _)| (*id, *facts)).collect());
    let chats = newest(shown.iter().filter(|(_, _, place)| *place == Place::Chat).map(|(id, facts, _)| (*id, *facts)).collect());

    let mut grouped: BTreeMap<String, Vec<(&String, &Facts)>> = BTreeMap::new();
    for (id, facts, place) in &shown {
        if let Place::Project(directory) = place {
            grouped.entry(directory.clone()).or_default().push((id, facts));
        }
    }
    for directory in projects.keys() {
        grouped.entry(directory.clone()).or_default();
    }
    let mut groups: Vec<(f64, ProjectGroup)> = grouped
        .into_iter()
        .map(|(directory, rows)| {
            let top = rows.iter().map(|(_, facts)| facts.updated).fold(None, |most: Option<f64>, updated| Some(most.map_or(updated, |most| most.max(updated))));
            let name = project_name(&directory, projects);
            (top.unwrap_or(0.0), ProjectGroup { name, sessions: newest(rows), directory })
        })
        .collect();
    groups.sort_by(|(left, a), (right, b)| {
        right.partial_cmp(left).unwrap_or(Ordering::Equal).then_with(|| finder_order(&a.name, &b.name)).then_with(|| a.directory.cmp(&b.directory))
    });
    Sidebar { pinned, chats, projects: groups.into_iter().map(|(_, group)| group).collect() }
}

/// A project's name: as its box's list names it, else its folder's.
pub fn project_name(directory: &str, projects: &HashMap<String, Project>) -> String {
    if let Some(name) = projects.get(directory).and_then(|project| project.name.clone()) {
        return name;
    }
    let trimmed = directory.trim_end_matches('/');
    trimmed.rsplit('/').next().filter(|last| !last.is_empty()).unwrap_or(directory).to_owned()
}

/// Finder's order for names: case-insensitive, numbers by their value ("web2" before "web10").
pub fn finder_order(a: &str, b: &str) -> Ordering {
    let (mut left, mut right) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (left.peek().copied(), right.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let number = |chars: &mut std::iter::Peekable<std::str::Chars<'_>>| {
                    let mut digits = String::new();
                    while let Some(digit) = chars.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(digit);
                        chars.next();
                    }
                    digits.trim_start_matches('0').to_owned()
                };
                let (x, y) = (number(&mut left), number(&mut right));
                let order = x.len().cmp(&y.len()).then_with(|| x.cmp(&y));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                left.next();
                right.next();
            }
        }
    }
}
