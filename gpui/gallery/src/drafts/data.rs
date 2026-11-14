//! The drafts' fixed sample data: made-up projects, sessions, bots, queue items, computers and
//! accounts. Nothing here comes from a box.

/// What a session is doing, as its row shows it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Doing {
    Idle,
    Working,
    /// Waiting on you: a question or a permission.
    Asked,
}

pub struct Session {
    pub id: &'static str,
    pub title: &'static str,
    pub when: &'static str,
    pub doing: Doing,
}

pub struct Project {
    pub name: &'static str,
    pub sessions: &'static [Session],
    /// Its sums, as the box would state them: sessions waiting on you, and whether one works.
    pub asking: usize,
    pub working: bool,
    /// Folded in the compact draft, to show what a folded project sums up.
    pub folded_in_c: bool,
}

pub const PROJECTS: &[Project] = &[
    Project {
        name: "Website",
        sessions: &[
            Session { id: "signup", title: "Fix the sign-up form wiping on a taken email", when: "2m", doing: Doing::Working },
            Session { id: "dark", title: "Dark mode for the settings page", when: "2h", doing: Doing::Idle },
            Session { id: "blog", title: "Move the blog to the new CMS", when: "1d", doing: Doing::Asked },
            Session { id: "lighthouse", title: "Get the Lighthouse score above 90", when: "3d", doing: Doing::Idle },
        ],
        asking: 1,
        working: true,
        folded_in_c: false,
    },
    Project {
        name: "API",
        sessions: &[
            Session { id: "rate", title: "Rate limits per API key", when: "20m", doing: Doing::Asked },
            Session { id: "webhook", title: "Flaky webhook retry test", when: "5h", doing: Doing::Idle },
        ],
        asking: 1,
        working: false,
        folded_in_c: false,
    },
    Project {
        name: "Mobile",
        sessions: &[
            Session { id: "push", title: "Push notifications on Android", when: "2d", doing: Doing::Working },
        ],
        asking: 0,
        working: true,
        folded_in_c: true,
    },
    Project { name: "Infra", sessions: &[], asking: 0, working: false, folded_in_c: true },
];

pub const CHATS: &[Session] = &[
    Session { id: "recipes", title: "Recipe ideas for the weekend", when: "4h", doing: Doing::Idle },
    Session { id: "lifetimes", title: "Explain Rust lifetimes with an example", when: "1w", doing: Doing::Idle },
];

/// The sessions waiting on you, across projects, newest first, as the box would list them for
/// "Needs you" (a listing it doesn't serve yet): session, project, what it asks, when.
pub const NEEDS_YOU: &[(&str, &str, &str, &str)] = &[
    ("rate", "Rate limits per API key", "API · asks to edit 3 files", "20m"),
    ("blog", "Move the blog to the new CMS", "Website · asks to run a command", "1d"),
];

/// How many sessions wait on you, and bots, as the rail's badges show: the box's word.
pub const SESSIONS_WAITING: usize = 2;
pub const BOTS_WAITING: usize = 2;

pub struct Bot {
    pub name: &'static str,
    pub job: &'static str,
    /// What it's doing now, in a few words.
    pub now: &'static str,
    pub working: bool,
    pub asking: usize,
    /// Its look, as the box sends it (`look`): a tint and a form. Drawn still.
    pub tint: u32,
    pub round: bool,
}

// The tints stand for `BotLook.Tint`'s (KuvoClient's ClientDesign/BotAvatar.swift): sky, coral,
// lime and violet.
pub const BOTS: &[Bot] = &[
    Bot { name: "Mira", job: "Looks after the website", now: "1 at work, 1 waiting on you", working: true, asking: 1, tint: 0x4F9CF5, round: true },
    Bot { name: "Inbox Helper", job: "Drafts replies to support mail", now: "Waiting on you", working: false, asking: 1, tint: 0xF2735C, round: false },
    Bot { name: "Release Captain", job: "Ships a beta every Friday", now: "Wakes up Fri 09:00", working: false, asking: 0, tint: 0x8CCC4F, round: false },
    Bot { name: "Docs Keeper", job: "Keeps the docs matching the code", now: "Finished 3h ago", working: false, asking: 0, tint: 0x8A5CF5, round: true },
];

pub struct Category {
    pub id: &'static str,
    pub name: &'static str,
    pub count: usize,
}

pub const CATEGORIES: &[Category] = &[
    Category { id: "next", name: "Next", count: 6 },
    Category { id: "later", name: "Later", count: 6 },
    Category { id: "cat_design", name: "Design", count: 3 },
    Category { id: "parked", name: "Parked", count: 4 },
    Category { id: "done", name: "Done", count: 31 },
];

pub struct Item {
    pub number: u32,
    pub title: &'static str,
    pub owner: &'static str,
    pub working: bool,
}

pub const NEXT_ITEMS: &[Item] = &[
    Item { number: 214, title: "Keep what was typed when the sign-up email is taken", owner: "Fix the sign-up form wiping on a taken email", working: true },
    Item { number: 209, title: "Say which field is wrong, under the field", owner: "Fix the sign-up form wiping on a taken email", working: false },
    Item { number: 203, title: "Rate limits per API key, with a header saying what's left", owner: "Rate limits per API key", working: false },
    Item { number: 198, title: "Move the blog's 42 posts to the new CMS", owner: "Mira", working: false },
    Item { number: 190, title: "Push notifications on Android 15", owner: "Push notifications on Android", working: true },
    Item { number: 188, title: "Lighthouse above 90 on the pricing page", owner: "Get the Lighthouse score above 90", working: false },
];

pub enum Reach {
    Connected,
    Unreachable,
}

pub struct Computer {
    pub name: &'static str,
    pub detail: &'static str,
    pub mac: bool,
    pub reach: Reach,
    pub working: usize,
}

pub const COMPUTERS: &[Computer] = &[
    Computer { name: "This Mac", detail: "Kuvo Code 1.42", mac: true, reach: Reach::Connected, working: 1 },
    Computer { name: "devbox", detail: "Ubuntu 24.04 · through SSH", mac: false, reach: Reach::Connected, working: 1 },
    Computer { name: "studio-mini", detail: "Can't be reached", mac: true, reach: Reach::Unreachable, working: 0 },
];

/// One window of a plan's limits, as the box reads it.
pub struct Window {
    pub name: &'static str,
    pub used: f32,
    pub resets: &'static str,
}

/// A signed-in account, with its plan's windows.
pub struct Account {
    /// The ring's share, 0 to 1: the box's word for how close the account is to a limit (its
    /// fullest window that hasn't started over), never worked out here.
    pub used: f32,
    /// The service's mark stands here as a letter; the real marks are the box's `service`.
    pub mark: &'static str,
    pub service: &'static str,
    pub label: &'static str,
    pub plan: &'static str,
    pub windows: &'static [Window],
}

pub const ACCOUNTS: &[Account] = &[
    Account {
        used: 0.46,
        mark: "C",
        service: "Claude",
        label: "Work",
        plan: "Max 20x",
        windows: &[
            Window { name: "5-hour", used: 0.46, resets: "Resets in 3 h 40 min" },
            Window { name: "Week", used: 0.38, resets: "Resets Thu 09:00" },
            Window { name: "Sonnet week", used: 0.12, resets: "Resets Thu 09:00" },
        ],
    },
    Account {
        used: 0.22,
        mark: "C",
        service: "Claude",
        label: "Personal",
        plan: "Pro",
        windows: &[
            Window { name: "5-hour", used: 0.18, resets: "Resets in 4 h 05 min" },
            Window { name: "Week", used: 0.22, resets: "Resets Mon 14:00" },
        ],
    },
    Account {
        used: 0.74,
        mark: "O",
        service: "Codex",
        label: "ChatGPT",
        plan: "Pro",
        windows: &[
            Window { name: "5-hour", used: 0.74, resets: "Resets in 52 min" },
            Window { name: "Week", used: 0.41, resets: "Resets Sat 11:00" },
        ],
    },
    Account {
        used: 0.35,
        mark: "G",
        service: "Copilot",
        label: "GitHub",
        plan: "Pro+",
        windows: &[Window { name: "Premium requests", used: 0.35, resets: "Resets Dec 1" }],
    },
];

/// More accounts than the rail shows: they wait behind its "+2".
pub const MORE_ACCOUNTS: &[Account] = &[
    Account {
        used: 0.12,
        mark: "X",
        service: "Grok",
        label: "xAI",
        plan: "SuperGrok",
        windows: &[Window { name: "Week", used: 0.12, resets: "Resets Tue 08:00" }],
    },
    Account {
        used: 0.58,
        mark: "R",
        service: "OpenRouter",
        label: "Team key",
        plan: "Credits",
        windows: &[Window { name: "Credits", used: 0.58, resets: "$42 of $100 left" }],
    },
];

/// The Work account near its limit, for the scene that shows it.
pub const WORK_NEAR_LIMIT: Account = Account {
    used: 0.93,
    mark: "C",
    service: "Claude",
    label: "Work",
    plan: "Max 20x",
    windows: &[
        Window { name: "5-hour", used: 0.93, resets: "Resets in 1 h 12 min" },
        Window { name: "Week", used: 0.64, resets: "Resets Thu 09:00" },
        Window { name: "Sonnet week", used: 0.30, resets: "Resets Thu 09:00" },
    ],
};

/// Settings' sections, in their groups, as the Mac's.
pub const SETTINGS: &[(&str, &[&str])] = &[
    ("Application", &["General", "Appearance", "Notifications", "Keyboard Shortcuts", "Phone"]),
    ("Models & Providers", &["Accounts", "Custom Auto", "Usage"]),
    ("Agents & Tools", &["Agents", "Permissions", "Commands", "Skills", "Integrations", "Vault", "MCP Servers", "Engine"]),
    ("Projects", &["Git", "Worktrees", "Machines"]),
    ("Side Panel", &["Panel", "Browser"]),
    ("Privacy & Data", &["Privacy", "Storage", "Archived Sessions"]),
];
