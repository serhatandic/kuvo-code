//! A client of a Kuvo box (Packages/KuvoLink/PROTOCOL.md), for Kuvo's GPUI app and any other Rust
//! client: finding a box and reaching it ([`BoxClient::this_mac`], [`BoxClient::machine`]), its
//! update gate ([`gate`]), its session lists ([`sessions`]), a conversation's messages
//! ([`messages`]) and what a typed text means ([`typed`]), followed live ([`follow`]).
//!
//! The box decides; this only reads its facts, changes them through its routes, and orders what's
//! drawn the way every client does (held to `Packages/KuvoLink/Vectors`). No GPUI here.
//!
//! Nothing here logs. A box's password is read only from its own record (`run/serve.json`), sent
//! only to the box's server once the process that record names is that server, and never shown
//! (`Debug` leaves it out).

pub mod client;
pub mod error;
pub mod follow;
pub mod gate;
pub mod ids;
pub mod info;
pub mod lines;
pub mod local;
pub mod messages;
pub mod parts;
pub mod paths;
pub mod place;
pub mod sessions;
pub mod ssh;
pub mod transport;
pub mod typed;

pub use client::{BoxClient, Draft, Sent, WorkCounts};
pub use parts::{Delivery, Parts, Sending};
pub use error::{Error, Refusal, Result};
pub use follow::{ConversationUpdate, Follow, ListUpdate, Timing};
pub use gate::Gate;
pub use info::BoxInfo;
pub use messages::{Conversation, Message, Where};
pub use sessions::{Listing, Sidebar};
pub use ssh::SshBox;
