//! The rail's areas: the big switches (Sessions, Bots, Work Queue, Computers, Settings), each with
//! its own sidebar beside the rail and its own main view. ⌃1 to ⌃5 switch between them (⌘1 to ⌘8
//! are the tabs' keys, as on the Mac).

use gpui::{App, KeyBinding, actions};
use kuvo_ui::IconName;

actions!(area, [ShowSessions, ShowBots, ShowQueue, ShowComputers, ShowSettings, ShowUsage, ShowAccounts, OpenHelp, Back, Forward]);

/// Where Help goes: Kuvo Code's documentation.
pub const HELP: &str = "https://www.kuvo.run/code/docs/";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Area {
    Sessions,
    Bots,
    Queue,
    Computers,
    Settings,
}

impl Area {
    pub const ALL: [Area; 5] = [Area::Sessions, Area::Bots, Area::Queue, Area::Computers, Area::Settings];

    pub fn name(self) -> &'static str {
        match self {
            Area::Sessions => "Sessions",
            Area::Bots => "Bots",
            Area::Queue => "Work Queue",
            Area::Computers => "Computers",
            Area::Settings => "Settings",
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            Area::Sessions => IconName::Message,
            Area::Bots => IconName::Bot,
            Area::Queue => IconName::Queue,
            Area::Computers => IconName::Computer,
            Area::Settings => IconName::Settings,
        }
    }

    /// Its key, as its tooltip shows it.
    pub fn keys(self) -> &'static str {
        match self {
            Area::Sessions => "⌃1",
            Area::Bots => "⌃2",
            Area::Queue => "⌃3",
            Area::Computers => "⌃4",
            Area::Settings => "⌃5",
        }
    }

    /// What its sidebar's search says before anything's typed.
    pub fn slug(self) -> &'static str {
        match self {
            Area::Sessions => "sessions",
            Area::Bots => "bots",
            Area::Queue => "queue",
            Area::Computers => "computers",
            Area::Settings => "settings",
        }
    }
}

pub fn bind_keys(cx: &mut App) {
    let workspace = Some("Workspace");
    cx.bind_keys([
        KeyBinding::new("ctrl-1", ShowSessions, workspace),
        KeyBinding::new("ctrl-2", ShowBots, workspace),
        KeyBinding::new("ctrl-3", ShowQueue, workspace),
        KeyBinding::new("ctrl-4", ShowComputers, workspace),
        KeyBinding::new("ctrl-5", ShowSettings, workspace),
        // Back and forward, as a browser's and Xcode's.
        KeyBinding::new("cmd-[", Back, workspace),
        KeyBinding::new("cmd-]", Forward, workspace),
    ]);
}
