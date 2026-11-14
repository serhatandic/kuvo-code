# Files (Zed's project panel)

Shots: `shots/screens-tree-*`, `screens-file-*`. Code: `kuvo/src/panel/files.rs`; the box's `kuvo/folders`
with `files=1` and `kuvo/file`.

## What Zed does

Read: `crates/project_panel/src/project_panel.rs` (`expand_entry`, `collapse_entry`,
`toggle_expanded`, `render_entry`, its indent, how entries are sorted, auto-folded folders).
Behaviour only; nothing copied (GPL).

- A tree of the project, folders first, each level indented; a click folds or opens a folder, or
  opens a file in the editor. Folders' contents are scanned as they open.
- Version control's folders and what settings exclude are left out; ignored files show dimmed.

## What Kuvo takes

- The box lists one folder at a time as it opens (`kuvo/folders?files=1&hidden=1`): its folders,
  then its files, in the order the box gives, hidden ones too; the box leaves out `.git`, `.hg` and
  `.svn` (`files=1`). Open folders are read again as the tab shows again.
- A folder the box can't read says why, as the computer says it ("Permission denied"), with Try
  Again, in its files' place; the top folder unreadable fills the panel. An empty one says Empty.
- A file opens read-only in the panel (`kuvo/file`, at most 2 MB), highlighted and numbered as the
  conversation's code blocks are, its first 3,000 lines; one that isn't text, or is too big, says so.
  Escape or the back button returns to the tree.

## Where we differ, and why

- The task named `folders.tree` (every file at once, git's list). It has no reason for a folder deep
  in the tree, and leaves out what git ignores, so the tree reads `kuvo/folders` a folder at a time,
  as the Mac's Files panel does; `folders.tree` is for the filter, not built yet.
- No filter, Reveal, Copy Path or Open in Editor yet; no icons by file type.
