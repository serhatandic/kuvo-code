import ClientText
import Foundation
import OpenCodeKit
import UniformTypeIdentifiers

/// One picture in a conversation, as both apps find it: one a message of yours carried, one an
/// agent made or took of a page to show you, or a file it showed you (`show_file`).
public struct ConversationPicture: Hashable, Sendable, Identifiable {
    public enum Source: Hashable, Sendable {
        /// One a message carries: its bytes, or where they are.
        case attachment(Message.User.Attachment)
        /// One a step brought back: a file on the conversation's computer (`file://…`), or its own
        /// bytes (`data:…`).
        case file(uri: String, mime: String)
        /// A file the agent showed, by its path on the computer the conversation runs on.
        case shown(path: String)
        /// A file a message of yours sent as a path for the agent to open (its model couldn't take
        /// it as it was), by its path on the computer the conversation runs on.
        case path(String)
    }

    /// The same for as long as the conversation has it, in both apps (`ConversationPictures.id`):
    /// "<message>#<n>" for a message's nth file, "<message>@<path>" for one it sent as a path,
    /// "<step>-<n>" for a step's nth output, "<step>-shown" for a file shown.
    public var id: String
    public var source: Source
    /// Its name, as the message or the step gives it; nil where neither does.
    public var name: String?
    /// The words the agent showed it with.
    public var caption: String?
    /// The message it's in.
    public var message: String
    /// The step that brought it; nil for a message's.
    public var step: String?

    public init(id: String, source: Source, name: String?, caption: String? = nil, message: String, step: String? = nil) {
        self.id = id
        self.source = source
        self.name = name
        self.caption = caption
        self.message = message
        self.step = step
    }
}

/// Every picture of a conversation, in the order it shows them: what a picture opens among, to go
/// to the one before or after it, wherever it opens (the conversation, the side panel, the
/// composer). Your messages' pictures and the ones an agent made, showed you or took of a page to
/// show you; a step's own screenshots (folded in the step) and pictures in a reply's words aren't
/// among them.
public enum ConversationPictures {
    /// Every picture in `messages`, in order, up to an undo waiting to be kept (`revert`, the
    /// session's `revert.messageID`): what's after it doesn't show.
    public static func all(in messages: [Message], undoneFrom revert: String? = nil) -> [ConversationPicture] {
        ShownMessages.before(undo: revert, in: messages).flatMap { message -> [ConversationPicture] in
            switch message {
            case .user(let user): pictures(of: user)
            case .assistant(let step): step.content.flatMap { block -> [ConversationPicture] in
                guard case .tool(let call) = block else { return [] }
                return pictures(of: call, in: step.id)
            }
            default: []
            }
        }
    }

    /// The pictures `steps` brought to show you, in order: a group chat's message, whose bot's
    /// steps come with it (`message`: its id).
    public static func pictures(of steps: [Message.ToolCall], in message: String) -> [ConversationPicture] {
        steps.flatMap { pictures(of: $0, in: message) }
    }

    /// The pictures a message of yours carried, in the order it carried them, then those it sent
    /// as paths (its note of attached files names them).
    public static func pictures(of message: Message.User) -> [ConversationPicture] {
        let files = message.files ?? []
        let carried = files.enumerated().compactMap { index, file -> ConversationPicture? in
            guard isPicture(file) else { return nil }
            return ConversationPicture(id: id(message: message.id, file: index), source: .attachment(file), name: file.name ?? file.fileURL?.lastPathComponent, message: message.id)
        }
        let own = Set(files.compactMap { $0.fileURL?.path })
        var seen = Set<String>()
        let paths = AttachedFilesNote.split(message.text).paths.compactMap { path -> ConversationPicture? in
            guard isPicture(path: path), !own.contains(path), seen.insert(path).inserted else { return nil }
            return ConversationPicture(id: id(message: message.id, path: path), source: .path(path), name: (path as NSString).lastPathComponent, message: message.id)
        }
        return carried + paths
    }

    /// A message's nth file's id (counted among all its files).
    public static func id(message: String, file index: Int) -> String { "\(message)#\(index)" }

    /// The id of a file a message sent as a path.
    public static func id(message: String, path: String) -> String { "\(message)@\(path)" }

    /// A step's nth output's id (counted among all its output).
    public static func id(step: String, output index: Int) -> String { "\(step)-\(index)" }

    /// The id of the file a step showed.
    public static func shownID(step: String) -> String { "\(step)-shown" }

    /// The pictures a finished step brought to show you: the file it showed, if it's a picture;
    /// the images it made, or the screenshot it took to show you. None for any other step, nor one
    /// still at work or failed. (`message`: the step's message.)
    public static func pictures(of call: Message.ToolCall, in message: String = "") -> [ConversationPicture] {
        guard isMade(call), case .completed(let input, let output, _) = call.state else { return [] }
        let caption = input["caption"]?.string.flatMap { $0.isEmpty ? nil : $0 }
        if isShownFile(call) {
            guard let path = input["path"]?.string, isPicture(path: path) else { return [] }
            return [ConversationPicture(id: shownID(step: call.id), source: .shown(path: path), name: (path as NSString).lastPathComponent, caption: caption, message: message, step: call.id)]
        }
        return output.enumerated().compactMap { index, part in
            guard case .file(let uri, let mime, let name) = part, mime.lowercased().hasPrefix("image/") else { return nil }
            return ConversationPicture(id: id(step: call.id, output: index), source: .file(uri: uri, mime: mime), name: name, caption: caption, message: message, step: call.id)
        }
    }

    /// A step that brings a picture to show you, in the conversation's flow: an image it made
    /// (`generate_image`, whichever agent's), a file it showed you, a page's screenshot it took to
    /// show you.
    public static func isMade(_ call: Message.ToolCall) -> Bool {
        call.name == "generate_image" || isShownFile(call) || isShownPage(call)
    }

    /// Kuvo Code's `show_file`.
    public static func isShownFile(_ call: Message.ToolCall) -> Bool {
        call.name == "kuvo-browser_show_file"
    }

    /// A screenshot of the page the agent took to show you (`browser_screenshot`'s `show`); one it
    /// takes for itself stays in its step.
    public static func isShownPage(_ call: Message.ToolCall) -> Bool {
        call.name == "kuvo-browser_browser_screenshot" && call.state.input?["show"]?.bool == true
    }

    /// A file that's a picture, by its name.
    public static func isPicture(path: String) -> Bool {
        let ext = (path as NSString).pathExtension
        return !ext.isEmpty && UTType(filenameExtension: ext)?.conforms(to: .image) == true
    }

    /// A file a message carries that's a picture: by its type, or by its name where the type says
    /// nothing more than "data".
    public static func isPicture(_ file: Message.User.Attachment) -> Bool {
        let mime = file.mime.lowercased()
        if mime.hasPrefix("image/") { return true }
        if case .uri(let uri)? = file.source, uri.prefix(11).lowercased() == "data:image/" { return true }
        let declared = UTType(mimeType: mime)
        guard declared == nil || declared == .data || declared?.isDynamic == true else { return false }
        guard let name = file.name ?? file.fileURL?.lastPathComponent else { return false }
        return isPicture(path: name)
    }

    /// Where the picture `id` is among `pictures`, to open them on it.
    public static func index(of id: String, in pictures: [ConversationPicture]) -> Int? {
        pictures.firstIndex { $0.id == id }
    }
}

/// A conversation's messages as it shows them: an undo waiting to be kept ends it at its message,
/// by where it is (a message queued during a run is older than that run's later steps).
public enum ShownMessages {
    public static func before(undo revert: String?, in all: [Message]) -> [Message] {
        guard let revert else { return all }
        let cut = all.firstIndex { $0.id == revert } ?? all.firstIndex { $0.id >= revert } ?? all.count
        return Array(all[..<cut])
    }
}
