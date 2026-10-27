import ClientDesign
import SwiftUI

/// A folder on a machine, chosen as a folder panel chooses one on this Mac: where you are along
/// the top, its folders to go into, and Choose for the one you're in. The machine's box lists
/// them (`kuvo/folders`), so it's its own folders, as they are now.
struct BoxFolderBrowser: View {
    /// The box whose folders these are.
    let box: String
    /// Where it opens; nil, or one that isn't there: the home folder.
    let start: String?
    /// What Choose does, as it chooses (one of yours, from `~/` when it's in your home folder).
    let primary: String
    let choose: (_ path: String, _ home: String) -> Void
    let cancel: () -> Void
    @Environment(AppModel.self) private var app
    @State private var listing: BoxFolderListing?
    /// Why the folder it went to couldn't be read, and which (Try Again reads it again).
    @State private var failure: (path: String?, message: String)?
    /// Where it's going, while that's read.
    @State private var going: String?
    @State private var naming = false
    @State private var newName = ""
    @State private var makeFailure: String?

    var body: some View {
        SettingsDetailPage {
            Section {
                if let listing {
                    PathBar(path: listing.path, home: listing.home) { go(to: $0) }
                }
            }
            Section {
                if let failure {
                    FailureLabel(title: "Couldn’t open \(failure.path.map { ($0 as NSString).lastPathComponent } ?? "your home folder")", detail: failure.message, retrying: "that folder") {
                        go(to: failure.path)
                    }
                }
                if listing == nil, failure == nil {
                    Placeholder(.rows(count: 4), label: "Loading folders", fadesOut: false)
                        .padding(.vertical, 6)
                } else if let listing, listing.folders.isEmpty {
                    Text("No folders in \(listing.path == listing.home ? "your home folder" : (listing.path as NSString).lastPathComponent).")
                        .foregroundStyle(.secondary)
                } else if let listing {
                    ForEach(listing.folders) { folder in
                        let path = (listing.path as NSString).appendingPathComponent(folder.name)
                        Button {
                            go(to: path)
                        } label: {
                            HStack(spacing: 10) {
                                FolderIcon(isOpen: false, size: 17)
                                    .foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                                Text(folder.name)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                if folder.repository == true {
                                    Text("git")
                                        .font(.caption.weight(.medium))
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(.quaternary, in: .capsule)
                                        .accessibilityLabel("a git repository")
                                }
                                Spacer(minLength: 8)
                                if going == path {
                                    Spinner(size: 13)
                                } else {
                                    Image(systemName: "chevron.right")
                                        .foregroundStyle(.secondary)
                                        .accessibilityHidden(true)
                                }
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                        .accessibilityHint("Opens it")
                    }
                }
            }
        } footer: {
            EditorFooter(primary: primary, canDoPrimary: listing != nil && going == nil && failure == nil, onPrimary: {
                if let listing { choose(listing.path, listing.home) }
            }, onCancel: cancel) {
                Button("New Folder…") {
                    newName = ""
                    naming = true
                }
                .buttonStyle(.glass)
                .disabled(listing == nil || failure != nil)
            }
        }
        .alert("New Folder", isPresented: $naming) {
            TextField("Name", text: $newName)
            Button("Create", action: makeFolder)
                .disabled(!isGoodName)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("In \(listing.map { $0.path == $0.home ? "your home folder" : ($0.path as NSString).lastPathComponent } ?? "this folder").")
        }
        .alert("Couldn’t Make the Folder", isPresented: Binding(get: { makeFailure != nil }, set: { if !$0 { makeFailure = nil } })) {
            Button("OK") {}
        } message: {
            Text(makeFailure ?? "")
        }
        .task { await read(start, falling: true) }
    }

    /// A name a folder can have: not empty, no slash, not "." or "..".
    private var isGoodName: Bool {
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && !name.contains("/") && name != "." && name != ".."
    }

    /// The new folder, made in the one you're in, opened.
    private func makeFolder() {
        guard let listing, isGoodName else { return }
        let path = (listing.path as NSString).appendingPathComponent(newName.trimmingCharacters(in: .whitespacesAndNewlines))
        Task {
            do {
                go(to: try await app.box(box).makeFolder(at: path))
            } catch {
                makeFailure = error.localizedDescription
            }
        }
    }

    private func go(to path: String?) {
        guard going == nil else { return }
        going = path
        Task {
            await read(path, falling: false)
            going = nil
        }
    }

    /// The folders in `path`; `falling`: the home folder if it isn't there (where it opens).
    private func read(_ path: String?, falling: Bool) async {
        do {
            let read = try await app.box(box).folders(at: path)
            withAnimation(.ui) {
                listing = read
                failure = nil
            }
        } catch let refusal as BoxRefusal where falling && path != nil && refusal.status == 404 {
            await read(nil, falling: false)
        } catch {
            // Where you were stays, under what went wrong; Choose waits until it's read.
            failure = (path, error.localizedDescription)
        }
    }
}

/// Where a folder is, as a row of the folders it's in: each goes there, the home folder as a house.
private struct PathBar: View {
    let path: String
    let home: String
    let go: (String) -> Void

    /// Each folder along the way, with its path: from the home folder when it's in it.
    private var steps: [(title: String, path: String, isHome: Bool)] {
        let inHome = path == home || path.hasPrefix(home + "/")
        var steps: [(String, String, Bool)] = []
        var at = inHome ? home : "/"
        steps.append(inHome ? ("Home", home, true) : ("/", "/", false))
        let rest = inHome ? String(path.dropFirst(home.count)) : path
        for part in rest.split(separator: "/") {
            at = (at as NSString).appendingPathComponent(String(part))
            steps.append((String(part), at, false))
        }
        return steps
    }

    var body: some View {
        // From the left while it fits; scrolled to its end when it doesn't, where you are.
        ViewThatFits(in: .horizontal) {
            row.frame(maxWidth: .infinity, alignment: .leading)
            ScrollView(.horizontal) { row }
                .scrollIndicators(.never)
                .defaultScrollAnchor(.trailing)
        }
    }

    private var row: some View {
        HStack(spacing: 2) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                if index > 0 {
                    Image(systemName: "chevron.compact.right")
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                Button {
                    go(step.path)
                } label: {
                    if step.isHome {
                        Label(step.title, systemImage: "house")
                    } else {
                        Text(step.title)
                    }
                }
                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: index < steps.count - 1))
                .fontWeight(index == steps.count - 1 ? .medium : .regular)
                .disabled(index == steps.count - 1)
                .accessibilityLabel(step.isHome ? "Home folder" : step.title)
            }
        }
        .lineLimit(1)
        .fixedSize()
    }
}
