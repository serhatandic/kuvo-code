//! A folder's git, as the box runs it (PROTOCOL.md, "Changes"): its changed files grouped as a
//! Changes panel shows them, followed (`git.files`); one file's diff (`git.changes.path`); staging,
//! unstaging, discarding, committing and pushing; its branches, switching them and a new one
//! (`git.branches`); Merge into… (`git.merge`) and Create Pull Request (`git.pull-request`).
//!
//! Every decision is the box's: which group a file is in, the scope its actions take, what a merge
//! or a pull request does and why it can't. A client sends back what the box listed, and shows what
//! it says.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::client::BoxClient;
use crate::error::{Error, Refusal, Result};
use crate::follow::{Follow, Followed, Timing, follow_lines};
use crate::paths;
use crate::transport::Request;

/// Which of a Changes panel's groups a file shows in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Conflicted,
    Staged,
    Unstaged,
    Untracked,
}

/// One changed file, as the box lists it: send it back as it is to stage, unstage or discard it,
/// or read its diff.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Its path in the repository.
    pub path: String,
    /// Where a staged move came from.
    #[serde(default)]
    pub old_path: Option<String>,
    pub group: Group,
    /// What changed (`added`, `deleted`, `modified`, `renamed`), as its actions take it.
    pub status: String,
    /// The scope its actions and its diff take.
    pub scope: String,
    /// git's count of its lines added and removed (none for a binary, new or conflicted file).
    #[serde(default)]
    pub additions: Option<u32>,
    #[serde(default)]
    pub deletions: Option<u32>,
    /// What its discard does (`trash`, `unstaged`, `head`); none for one that isn't discarded (a
    /// conflict, which is resolved).
    #[serde(default)]
    pub discard: Option<String>,
    /// What it was as listed, which its discard sends back: the box refuses once it changed since.
    #[serde(default)]
    pub stamp: Option<String>,
    /// A repository of its own inside this one, whose commits go with it.
    #[serde(default)]
    pub repository: bool,
}

impl ChangedFile {
    /// Its name, without the folders it's in.
    pub fn name(&self) -> &str {
        self.path.trim_end_matches('/').rsplit('/').next().unwrap_or(&self.path)
    }

    /// The folders it's in ("" at the top).
    pub fn folder(&self) -> &str {
        let path = self.path.trim_end_matches('/');
        path.rfind('/').map_or("", |at| &path[..at])
    }

    /// What it's keyed by on screen: a file partly staged is listed twice, once in each group.
    pub fn key(&self) -> String {
        format!("{:?}:{}", self.group, self.path)
    }
}

/// A folder's changed files (`kuvo/git/files`): outside a repository, `repository` false and the
/// rest empty.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct GitFiles {
    pub repository: bool,
    /// The repository's top folder.
    #[serde(default)]
    pub root: Option<String>,
    /// The branch checked out (none on none).
    #[serde(default)]
    pub branch: Option<String>,
    /// In the order they show: conflicts, staged, unstaged, new.
    #[serde(default)]
    pub files: Vec<ChangedFile>,
    #[serde(default)]
    pub uncommitted: bool,
    /// What a commit takes now: `staged` (anywhere in the repository), or `all` of the folder's.
    #[serde(default)]
    pub commits: String,
    /// How many staged files outside the folder a commit takes along.
    #[serde(default, rename = "stagedElsewhere")]
    pub staged_elsewhere: usize,
    /// How many new files past the most the box lists are left out.
    #[serde(default)]
    pub more: usize,
    /// What git is in the middle of: `merging`, `rebasing`, `cherry-picking`, `reverting`.
    #[serde(default)]
    pub underway: Option<String>,
}

impl GitFiles {
    /// Whether a commit now takes only what's staged (the box says), not everything in the folder.
    pub fn commits_staged(&self) -> bool {
        self.commits == "staged"
    }
}

/// One file's diff (`kuvo/git/changes` with `path`): git's unified patch, with the whole file as
/// context; `big` when it's too big to show.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileDiff {
    pub patch: String,
    pub big: bool,
}

/// What a commit did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Committed {
    /// Committed (and pushed, when asked).
    Done,
    /// Committed, but the push didn't go through: offer Push, never the commit again. What git said.
    NotPushed(String),
}

/// A folder's repository's branches (`kuvo/git/branches`).
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct Branches {
    pub repository: bool,
    /// Its top folder: none with no checkout there.
    #[serde(default)]
    pub root: Option<String>,
    /// The branch checked out.
    #[serde(default)]
    pub current: Option<String>,
    /// Its local branches, the latest commit first.
    #[serde(default)]
    pub branches: Vec<String>,
    /// A worktree whose branch Merge into… takes back (`git.branches.worktree`).
    #[serde(default)]
    pub worktree: Option<Worktree>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Worktree {
    /// Where Merge into… takes it without a branch named (its base, else the project's).
    pub into: Option<String>,
}

/// Create Pull Request's confirmation (`kuvo/git/pull-request/draft`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PullRequestDraft {
    pub branch: String,
    #[serde(default)]
    pub base: Option<String>,
    pub title: String,
    pub body: String,
    /// `github`, `gitlab` or `other`.
    pub host: String,
    /// Create makes it on the box (GitHub's `gh` there and signed in); else it opens the host's page.
    pub creates: bool,
    /// On GitHub without `creates`, why: `signed-out` or `missing`.
    #[serde(default)]
    pub gh: Option<String>,
}

/// A pull request made (`url`), or the page that makes one (`compare_url`); neither on a host the
/// box doesn't know, where the branch was pushed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct PullRequest {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default, rename = "compareURL")]
    pub compare_url: Option<String>,
}

/// `kuvo/git/files?directory=…`.
pub fn files_route(directory: &str) -> String {
    format!("kuvo/git/files?directory={}", paths::query_value(directory))
}

impl BoxClient {
    /// `directory`'s changed files, grouped as a Changes panel shows them.
    pub fn git_files(&self, directory: &str) -> Result<GitFiles> {
        self.get(&files_route(directory))
    }

    /// Follows `directory`'s changed files: now, and again as they change.
    pub fn follow_git_files(&self, directory: &str, timing: Timing) -> Follow<Followed<GitFiles>> {
        let route = files_route(directory);
        let events = route.replacen("kuvo/git/files?", "kuvo/git/files/events?", 1);
        follow_lines(self, "kuvo-box git files", events, route, timing)
    }

    /// One file's diff, in its repository (`root`), in the scope the box listed it with.
    pub fn file_diff(&self, root: &str, file: &ChangedFile) -> Result<FileDiff> {
        #[derive(Deserialize)]
        struct Answer {
            #[serde(default)]
            patch: String,
            #[serde(default)]
            big: bool,
        }
        let mut body = json!({ "directory": root, "scope": file.scope, "path": file.path });
        if let Some(old) = &file.old_path {
            body["oldPath"] = json!(old);
        }
        let answer: Answer = self.value(&Request::post("kuvo/git/changes", body))?;
        Ok(FileDiff { patch: answer.patch, big: answer.big })
    }

    /// Stages a file the box listed as unstaged, new or in conflict (marking it resolved).
    pub fn stage(&self, root: &str, file: &ChangedFile) -> Result<()> {
        self.file_action("stage", root, file)
    }

    /// Takes a staged file out of what's staged.
    pub fn unstage(&self, root: &str, file: &ChangedFile) -> Result<()> {
        self.file_action("unstage", root, file)
    }

    /// Discards a file's changes in its scope (a staged one's, back to the last commit; an unstaged
    /// one's, back to what's staged); a new file goes to the Trash.
    pub fn discard(&self, root: &str, file: &ChangedFile) -> Result<()> {
        self.file_action("discard", root, file)
    }

    fn file_action(&self, action: &str, root: &str, file: &ChangedFile) -> Result<()> {
        let mut body = json!({ "root": root, "path": file.path, "status": file.status, "scope": file.scope });
        if let Some(old) = &file.old_path {
            body["oldPath"] = json!(old);
        }
        // A discard says what it was shown, so the box never throws away what came after.
        if action == "discard"
            && let Some(stamp) = &file.stamp
        {
            body["stamp"] = json!(stamp);
        }
        done(self.send(&Request::post(format!("kuvo/git/{action}"), body))?)
    }

    /// Commits what's staged, or everything in `directory` when nothing is, and pushes if asked.
    pub fn commit(&self, directory: &str, message: &str, push: bool) -> Result<Committed> {
        let response = self.send(&Request::post("kuvo/git/commit", json!({ "directory": directory, "message": message, "push": push })))?;
        if response.is_success() {
            return Ok(Committed::Done);
        }
        let said: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        if response.status == 422 && said.get("committed") == Some(&Value::Bool(true)) {
            let refusal = Refusal::from_answer(response.status, &response.body);
            return Ok(Committed::NotPushed(refusal.message));
        }
        Err(Error::Refused(Refusal::from_answer(response.status, &response.body)))
    }

    /// Pushes what `directory` has checked out.
    pub fn push(&self, directory: &str) -> Result<()> {
        done(self.send(&Request::post("kuvo/git/push", json!({ "directory": directory })))?)
    }

    /// `directory`'s repository's branches.
    pub fn branches(&self, directory: &str) -> Result<Branches> {
        self.value(&Request::post("kuvo/git/branches", json!({ "directory": directory })))
    }

    /// Switches `directory`'s repository to `branch`, or (`create`) to a new one from where it is.
    pub fn switch_branch(&self, directory: &str, branch: &str, create: bool) -> Result<()> {
        done(self.send(&Request::post("kuvo/git/switch", json!({ "directory": directory, "branch": branch, "create": create })))?)
    }

    /// Merge into…: what's committed on a worktree's branch merged into the branch the box takes it
    /// to. The branch it went into; a merge that would conflict is refused, naming the files.
    pub fn merge(&self, directory: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct Answer {
            #[serde(default)]
            into: String,
        }
        let answer: Answer = self.value(&Request::post("kuvo/git/merge", json!({ "directory": directory })))?;
        Ok(answer.into)
    }

    /// Create Pull Request's confirmation: the branch, its base, a title and a description.
    pub fn pull_request_draft(&self, directory: &str) -> Result<PullRequestDraft> {
        self.value(&Request::post("kuvo/git/pull-request/draft", json!({ "directory": directory })))
    }

    /// Create Pull Request, from `session` (the one in view): the branch pushed, and the pull request
    /// made, or the page that makes one.
    pub fn create_pull_request(&self, directory: &str, title: &str, body: &str, session: Option<&str>) -> Result<PullRequest> {
        let mut asked = json!({ "directory": directory, "title": title, "body": body });
        if let Some(session) = session {
            asked["session"] = json!(session);
        }
        self.value(&Request::post("kuvo/git/pull-request", asked))
    }
}

/// `200 {}`, else what the box said.
fn done(response: crate::transport::Response) -> Result<()> {
    if response.is_success() { Ok(()) } else { Err(Error::Refused(Refusal::from_answer(response.status, &response.body))) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_listed_twice_is_two_rows_and_named_by_its_folder() {
        let listed: GitFiles = serde_json::from_str(
            r#"{"repository":true,"root":"/r","branch":"main","uncommitted":true,"commits":"staged","files":[
              {"path":"app/Form.tsx","group":"staged","status":"modified","scope":"staged","additions":1,"deletions":1},
              {"path":"app/Form.tsx","group":"unstaged","status":"modified","scope":"unstaged","additions":2,"deletions":0},
              {"path":"app/new.ts","oldPath":"app/old.ts","group":"staged","status":"renamed","scope":"staged"},
              {"path":"README.md","group":"untracked","status":"added","scope":"unstaged"}]}"#,
        )
        .unwrap();
        assert!(listed.commits_staged());
        assert_ne!(listed.files[0].key(), listed.files[1].key());
        assert_eq!((listed.files[0].name(), listed.files[0].folder()), ("Form.tsx", "app"));
        assert_eq!((listed.files[3].name(), listed.files[3].folder()), ("README.md", ""));
        assert_eq!(listed.files[2].old_path.as_deref(), Some("app/old.ts"));
        let outside: GitFiles = serde_json::from_str(r#"{"repository":false}"#).unwrap();
        assert!(!outside.repository && outside.files.is_empty());
    }
}
