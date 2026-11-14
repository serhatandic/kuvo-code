//! The stand-in box's git and folders: made-up repositories answered as the box answers them
//! (`kuvo/git/files` and its events, a file's diff, staging, committing, branches, Merge into…,
//! pull requests) and a project's folders and files (`kuvo/folders?files=1`, `kuvo/file`). Nothing
//! real is read or run: every answer is a fixture here.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};

use super::HOME;

/// The website project's own folder (its sessions work in it, on a branch of their own).
pub fn website() -> String {
    format!("{HOME}/Projects/website")
}

/// The dark mode session's worktree of the website.
pub fn dark_mode_tree() -> String {
    format!("{HOME}/.kuvo-code/worktrees/website-dark-mode")
}

/// The API project's folder: a repository with nothing changed.
pub fn api() -> String {
    format!("{HOME}/Projects/api")
}

/// One made-up repository.
pub struct Repo {
    pub branch: Option<String>,
    pub branches: Vec<String>,
    /// As `kuvo/git/files` lists them.
    pub files: Vec<Value>,
    /// Where Merge into… takes it (a worktree's).
    pub into: Option<String>,
    /// Each file's diff, by its path.
    pub patches: HashMap<String, String>,
    /// Staged files outside the folder, and what git is in the middle of.
    pub staged_elsewhere: usize,
    pub underway: Option<&'static str>,
}

/// A folder's folders and files, or why it can't be read.
pub type Listing = Result<(Vec<&'static str>, Vec<&'static str>), &'static str>;

/// The stand-in's repositories by their top folders, and its folders' listings.
pub struct Git {
    pub repos: BTreeMap<String, Repo>,
    /// Each folder's folders and files, as `kuvo/folders?files=1` lists them; a folder that can't be
    /// read, as `Err(reason)`.
    pub folders: HashMap<String, Listing>,
    /// Files' bytes, by their full paths.
    pub contents: HashMap<String, Vec<u8>>,
    /// The next push fails after its commit lands.
    pub push_fails: bool,
    /// A merge stops on these files.
    pub conflicts: Vec<String>,
}

fn file(path: &str, group: &str, status: &str, lines: Option<(u32, u32)>) -> Value {
    let scope = match group {
        "staged" => "staged",
        "conflicted" => "uncommitted",
        _ => "unstaged",
    };
    let discard = match (group, status) {
        ("conflicted", _) => None,
        (_, "added") => Some("trash"),
        ("staged", _) => Some("head"),
        _ => Some("unstaged"),
    };
    let mut file = json!({ "path": path, "group": group, "status": status, "scope": scope });
    if let Some(discard) = discard {
        file["discard"] = json!(discard);
        file["stamp"] = json!(format!("{group}:{path}:1"));
    }
    if let Some((added, removed)) = lines {
        file["additions"] = json!(added);
        file["deletions"] = json!(removed);
    }
    file
}

impl Default for Git {
    fn default() -> Git {
        Git::new()
    }
}

impl Git {
    pub fn new() -> Git {
        let mut repos = BTreeMap::new();
        repos.insert(
            website(),
            Repo {
                branch: Some("fix/signup-taken-email".into()),
                branches: ["fix/signup-taken-email", "main", "feature/blog-cms", "perf/lighthouse", "kuvo/dark-mode-settings"].map(String::from).to_vec(),
                files: vec![
                    file("src/components/SignupForm.tsx", "staged", "modified", Some((9, 3))),
                    file("src/components/SignupForm.tsx", "unstaged", "modified", Some((2, 1))),
                    file("src/lib/validate.ts", "unstaged", "modified", Some((7, 1))),
                    file("src/styles/legacy.css", "unstaged", "deleted", Some((0, 6))),
                    file("src/components/SignupForm.test.tsx", "untracked", "added", None),
                ],
                into: None,
                patches: website_patches(),
                staged_elsewhere: 0,
                underway: None,
            },
        );
        repos.insert(
            dark_mode_tree(),
            Repo {
                branch: Some("kuvo/dark-mode-settings".into()),
                branches: ["kuvo/dark-mode-settings", "main", "fix/signup-taken-email"].map(String::from).to_vec(),
                files: vec![file("src/pages/settings.tsx", "unstaged", "modified", Some((4, 2))), file("src/styles/theme.css", "unstaged", "modified", Some((12, 0)))],
                into: Some("main".into()),
                patches: HashMap::new(),
                staged_elsewhere: 0,
                underway: None,
            },
        );
        repos.insert(api(), Repo { branch: Some("main".into()), branches: vec!["main".into(), "rate-limits".into()], files: Vec::new(), into: None, patches: HashMap::new(), staged_elsewhere: 0, underway: None });
        let at = |path: &str| format!("{}/{path}", website()).trim_end_matches('/').to_owned();
        let mut folders = HashMap::new();
        folders.insert(website(), Ok((vec![".github", "public", "secrets", "src"], vec![".env.example", ".gitignore", "README.md", "package.json", "tsconfig.json"])));
        folders.insert(at(".github"), Ok((vec!["workflows"], vec![])));
        folders.insert(at(".github/workflows"), Ok((vec![], vec!["ci.yml"])));
        folders.insert(at("public"), Ok((vec![], vec!["favicon.png", "robots.txt"])));
        folders.insert(at("secrets"), Err("Permission denied"));
        folders.insert(at("src"), Ok((vec!["components", "lib", "pages", "styles"], vec!["main.tsx"])));
        folders.insert(at("src/components"), Ok((vec![], vec!["Button.tsx", "SignupForm.test.tsx", "SignupForm.tsx"])));
        folders.insert(at("src/lib"), Ok((vec![], vec!["api.ts", "validate.ts"])));
        folders.insert(at("src/pages"), Ok((vec![], vec!["index.tsx", "signup.tsx"])));
        folders.insert(at("src/styles"), Ok((vec![], vec![])));
        let mut contents = HashMap::new();
        contents.insert(at("src/components/SignupForm.tsx"), SIGNUP_FORM.as_bytes().to_vec());
        contents.insert(at("src/lib/validate.ts"), VALIDATE.as_bytes().to_vec());
        contents.insert(at("README.md"), b"# Website\n\nThe marketing site and sign-up flow.\n\n```sh\nnpm install\nnpm run dev\n```\n".to_vec());
        contents.insert(at("package.json"), b"{\n  \"name\": \"website\",\n  \"private\": true,\n  \"scripts\": {\n    \"dev\": \"vite\",\n    \"test\": \"vitest\"\n  }\n}\n".to_vec());
        contents.insert(at("public/favicon.png"), vec![0x89, b'P', b'N', b'G', 0, 0, 0, 0x0d]);
        Git { repos, folders, contents, push_fails: false, conflicts: Vec::new() }
    }

    /// The repository `directory` is in, by its top folder.
    pub fn repo_of(&self, directory: &str) -> Option<&str> {
        self.repos.keys().find(|root| directory == root.as_str() || directory.starts_with(&format!("{root}/"))).map(String::as_str)
    }

    /// `kuvo/git/files` for `directory`.
    pub fn files(&self, directory: &str) -> Value {
        match self.repo_of(directory) {
            Some(root) => {
                let repo = &self.repos[root];
                let commits = if repo.files.iter().any(|file| file["group"] == json!("staged")) { "staged" } else { "all" };
                let commits = if repo.staged_elsewhere > 0 { "staged" } else { commits };
                let mut answer = json!({ "repository": true, "root": root, "branch": repo.branch, "files": repo.files, "uncommitted": !repo.files.is_empty(), "commits": commits, "stagedElsewhere": repo.staged_elsewhere });
                if let Some(underway) = repo.underway {
                    answer["underway"] = json!(underway);
                }
                answer
            }
            None => json!({ "repository": false }),
        }
    }

    /// Answers `kuvo/git/…` and the folders' routes, and says which repository changed (for its
    /// followers), if one did.
    pub fn answer(&mut self, method: &str, route: &str, query: impl Fn(&str) -> Option<String>, body: &Value) -> Option<(u16, Value, Option<String>)> {
        let text = |name: &str| body.get(name).and_then(Value::as_str).unwrap_or("").to_owned();
        let found = |status: u16, value: Value| Some((status, value, None));
        match (method, route) {
            ("GET", "kuvo/git/files") => found(200, self.files(&query("directory").unwrap_or_default())),
            ("POST", "kuvo/git/changes") => {
                let directory = text("directory");
                let Some(root) = self.repo_of(&directory).map(str::to_owned) else { return found(200, json!({ "repository": false })) };
                let path = text("path");
                let patch = self.repos[&root].patches.get(&path).cloned().unwrap_or_else(|| default_patch(&path));
                found(200, json!({ "repository": true, "root": root, "against": "HEAD", "patch": patch, "untracked": [], "hashes": {}, "uncommitted": true }))
            }
            ("POST", "kuvo/git/stage" | "kuvo/git/unstage" | "kuvo/git/discard") => {
                let root = text("root");
                let path = text("path");
                let scope = text("scope");
                let repo = self.repos.get_mut(&root)?;
                let at = repo.files.iter().position(|file| file["path"] == json!(path) && file["scope"] == json!(scope));
                let Some(at) = at else { return found(422, json!({ "message": format!("git couldn’t find {path}.") })) };
                // A discard of what it was shown, only: changed since, refused.
                if route == "kuvo/git/discard" && body.get("stamp").is_some() && body["stamp"] != repo.files[at]["stamp"] {
                    return found(409, json!({ "message": format!("{path} changed since it was listed. Look at it again before you discard it.") }));
                }
                let mut moved = repo.files.remove(at);
                match route {
                    "kuvo/git/stage" => {
                        // In what's staged, once: a partly staged file's two rows become one.
                        repo.files.retain(|file| !(file["path"] == json!(path) && file["group"] == json!("staged")));
                        moved["group"] = json!("staged");
                        moved["scope"] = json!("staged");
                        if moved["status"] != json!("added") {
                            moved["discard"] = json!("head");
                        }
                        repo.files.push(moved);
                    }
                    "kuvo/git/unstage" => {
                        repo.files.retain(|file| !(file["path"] == json!(path) && file["group"] == json!("unstaged")));
                        let new = moved["status"] == json!("added");
                        moved["group"] = json!(if new { "untracked" } else { "unstaged" });
                        moved["scope"] = json!("unstaged");
                        moved["discard"] = json!(if new { "trash" } else { "unstaged" });
                        repo.files.push(moved);
                    }
                    // Back to the last commit (staged), or to what's staged.
                    _ if scope == "staged" => repo.files.retain(|file| file["path"] != json!(path)),
                    _ => {}
                }
                sort(&mut repo.files);
                Some((200, json!({}), Some(root)))
            }
            ("POST", "kuvo/git/commit") => {
                let directory = text("directory");
                if text("message").trim().is_empty() {
                    return found(400, json!({ "message": "Write a commit message." }));
                }
                let root = self.repo_of(&directory)?.to_owned();
                let push_fails = std::mem::take(&mut self.push_fails) && body["push"] == json!(true);
                let repo = self.repos.get_mut(&root)?;
                let staged = repo.files.iter().any(|file| file["group"] == json!("staged"));
                repo.files.retain(|file| staged && file["group"] != json!("staged"));
                if push_fails {
                    return Some((422, json!({ "message": "Committed, but the push didn’t go through:\nfatal: could not read Username for 'https://github.com': terminal prompts disabled", "committed": true, "pushed": false }), Some(root)));
                }
                Some((200, json!({}), Some(root)))
            }
            ("POST", "kuvo/git/push") => found(200, json!({})),
            ("POST", "kuvo/git/branches") => {
                let directory = text("directory");
                let Some(root) = self.repo_of(&directory) else { return found(200, json!({ "repository": false })) };
                let repo = &self.repos[root];
                let mut answer = json!({ "repository": true, "root": root, "current": repo.branch, "branches": repo.branches });
                if let Some(into) = &repo.into {
                    answer["worktree"] = json!({ "into": into });
                }
                found(200, answer)
            }
            ("POST", "kuvo/git/switch") => {
                let directory = text("directory");
                let branch = text("branch");
                let root = self.repo_of(&directory)?.to_owned();
                let repo = self.repos.get_mut(&root)?;
                if body["create"] == json!(true) {
                    if repo.branches.contains(&branch) {
                        return found(422, json!({ "message": format!("fatal: a branch named '{branch}' already exists") }));
                    }
                    repo.branches.insert(0, branch.clone());
                } else if !repo.branches.contains(&branch) {
                    return found(422, json!({ "message": format!("fatal: invalid reference: {branch}") }));
                }
                repo.branch = Some(branch);
                Some((200, json!({}), Some(root)))
            }
            ("POST", "kuvo/git/merge") => {
                let directory = text("directory");
                let into = self.repo_of(&directory).and_then(|root| self.repos[root].into.clone());
                let Some(into) = into else { return found(409, json!({ "message": "Only a worktree’s branch is merged here. Create a pull request instead." })) };
                if !self.conflicts.is_empty() {
                    let named = self.conflicts.join(", ");
                    return found(409, json!({ "message": format!("{into} changed some of the same lines: {named}. Nothing was merged."), "conflicts": self.conflicts, "into": into }));
                }
                found(200, json!({ "into": into }))
            }
            ("POST", "kuvo/git/pull-request/draft") => {
                let directory = text("directory");
                let branch = self.repo_of(&directory).and_then(|root| self.repos[root].branch.clone()).unwrap_or_default();
                if branch == "main" {
                    return found(409, json!({ "message": "main is the branch a pull request goes into. Make one from a branch of its own." }));
                }
                found(200, json!({ "branch": branch, "base": "main", "title": "Keep the sign-up form when an email is taken", "body": "- Keep what was typed when the email is taken\n- Say so beside the email field", "host": "github", "creates": true }))
            }
            ("POST", "kuvo/git/pull-request") => found(200, json!({ "url": "https://github.com/sam/website/pull/42" })),
            ("GET", "kuvo/folders") => {
                let path = query("path").unwrap_or_default();
                match self.folders.get(&path) {
                    Some(Ok((folders, files))) => found(200, json!({ "path": path, "home": HOME, "parent": null, "folders": folders.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>(), "files": files })),
                    Some(Err(reason)) => found(403, json!({ "message": format!("{path} can't be read here."), "reason": reason })),
                    None => found(404, json!({ "message": format!("There's no folder {path} here."), "reason": "No such folder" })),
                }
            }
            _ => None,
        }
    }

    /// A file's bytes as `kuvo/file` sends them.
    pub fn bytes(&self, uri: &str) -> Option<Vec<u8>> {
        self.contents.get(&super::percent_decode(uri.trim_start_matches("file://"))).cloned()
    }
}

/// In the order the box lists them: conflicts, staged, unstaged, new; by path in each.
fn sort(files: &mut [Value]) {
    let rank = |file: &Value| ["conflicted", "staged", "unstaged", "untracked"].iter().position(|group| file["group"] == json!(group)).unwrap_or(4);
    files.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a["path"].as_str().cmp(&b["path"].as_str())));
}

/// A small change to any file the fixtures don't spell out.
fn default_patch(path: &str) -> String {
    format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line 2\n line three\n")
}

const SIGNUP_FORM: &str = include_str!("fixtures/SignupForm.tsx");
const VALIDATE: &str = include_str!("fixtures/validate.ts");

/// The website's diffs: the sign-up form's whole file as context (as the box sends it), so its
/// unchanged stretches fold.
fn website_patches() -> HashMap<String, String> {
    let mut patches = HashMap::new();
    patches.insert("src/components/SignupForm.tsx".to_owned(), include_str!("fixtures/SignupForm.patch").to_owned());
    patches.insert("src/lib/validate.ts".to_owned(), include_str!("fixtures/validate.patch").to_owned());
    patches.insert(
        "src/styles/legacy.css".to_owned(),
        "diff --git a/src/styles/legacy.css b/src/styles/legacy.css\ndeleted file mode 100644\n--- a/src/styles/legacy.css\n+++ /dev/null\n@@ -1,6 +0,0 @@\n-.signup-form {\n-  display: grid;\n-  gap: 12px;\n-}\n-.signup-form .error { color: #c00; }\n-.signup-form input { width: 100%; }\n".to_owned(),
    );
    patches.insert(
        "src/components/SignupForm.test.tsx".to_owned(),
        "diff --git a/src/components/SignupForm.test.tsx b/src/components/SignupForm.test.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/src/components/SignupForm.test.tsx\n@@ -0,0 +1,12 @@\n+import { render, screen } from \"@testing-library/react\";\n+import userEvent from \"@testing-library/user-event\";\n+import { SignupForm } from \"./SignupForm\";\n+\n+test(\"keeps what was typed when the email is taken\", async () => {\n+  render(<SignupForm />);\n+  await userEvent.type(screen.getByLabelText(\"Name\"), \"Sam\");\n+  await userEvent.type(screen.getByLabelText(\"Email\"), \"taken@example.com\");\n+  await userEvent.click(screen.getByRole(\"button\", { name: \"Sign up\" }));\n+  expect(screen.getByLabelText(\"Name\")).toHaveValue(\"Sam\");\n+  expect(await screen.findByText(\"That email is taken.\")).toBeVisible();\n+});\n".to_owned(),
    );
    patches
}
