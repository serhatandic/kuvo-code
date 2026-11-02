import ClientDesign
import ClientText
import OpenCodeKit
import SwiftUI

/// A conversation's waiting wake-ups and watches (a bot's in Edit Bot, a session's from the bar
/// over its composer), each with a way to cancel it, and one of yours to add.
struct WakeList: View {
    let owner: WakeUps.Owner
    /// Who wakes up, as it's written: a bot's name, or "the agent".
    let name: String
    @Environment(AppModel.self) private var app
    /// The wake-up you're adding, while you are.
    @State private var draft: Draft?
    @State private var failure: String?
    @State private var isAdding = false
    /// What a watch's check printed when you tried it, by its letters; nil while it runs.
    @State private var tried: [String: String?] = [:]
    /// The wake-ups sent with Wake Up Now, by their ids: each goes once while the sheet is open,
    /// so a second click doesn't have the bot do its job twice.
    @State private var wokenNow: Set<String> = []
    @FocusState private var noteFocused: Bool
    @Environment(\.isInPopover) private var isInPopover

    private struct Draft {
        var due = Draft.nextHour
        var every: Wakes.Repeat?
        var note = ""

        /// The next hour on the hour, at least a quarter of an hour away.
        static var nextHour: Date {
            let hour = Calendar.current.dateInterval(of: .hour, for: .now)?.end ?? .now.addingTimeInterval(3600)
            return hour.timeIntervalSinceNow < 15 * 60 ? hour.addingTimeInterval(3600) : hour
        }
    }

    /// The repeats to pick from.
    private static let repeats: [Wakes.Repeat?] = [nil, .hours(1), .days(1), .weekdays, .weeks(1)]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            list
            if draft != nil {
                form
            } else if let failure {
                // Waking, canceling or pausing on a machine that couldn’t be reached (adding says so by its buttons).
                Text(failure)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .animation(.ui, value: draft == nil)
        #if DEBUG
        // KUVO_DEMO_ADD_WAKE=<note>: opens adding a wake-up, every day, with that note;
        // KUVO_DEMO_ADD_WAKE_NOW adds it too.
        .task {
            let environment = ProcessInfo.processInfo.environment
            guard let note = environment["KUVO_DEMO_ADD_WAKE"] else { return }
            draft = Draft(every: .days(1), note: note)
            if environment["KUVO_DEMO_ADD_WAKE_NOW"] != nil {
                try? await Task.sleep(for: .seconds(1))
                add()
            }
        }
        #endif
    }

    private var list: some View {
        let wakeUps = app.wakeUps
        let wakes = wakeUps.wakes[owner.key] ?? []
        let watches = wakeUps.watches[owner.key] ?? []
        return WellGroup {
            WellRow {
                Image(systemName: "pause.circle")
            } content: {
                Toggle(isOn: Binding(get: { wakeUps.paused.contains(owner.key) }, set: { pause in attempt { try await wakeUps.setPaused(pause, owner) } })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Pause Wake-Ups")
                        Text("Missed ones go when you resume.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    // The switch at the row's end.
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .toggleStyle(.switch)
                .accessibilityLabel("Pause Wake-Ups")
                .padding(.vertical, 8)
            }
            WellDivider()
            if wakes.isEmpty && watches.isEmpty {
                WellRow {
                    Image(systemName: "alarm")
                } content: {
                    // What only a bot's list would leave you wondering: who fills it.
                    Text(owner.isBot ? "\(name) schedules these itself, and you can add one." : "None waiting")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(Array(watches.enumerated()), id: \.element.id) { index, watch in
                if index > 0 { WellDivider() }
                WellRow {
                    Image(systemName: "eye")
                } content: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Watches " + (Wakes.Repeat(watch.every)?.words ?? "every \(watch.every)") + ", and wakes when this changes")
                                .font(.system(size: 13, weight: .medium))
                            Text(watch.check)
                                .font(.system(.callout, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text(watch.note)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            if let result = tried[watch.letters] {
                                Group {
                                    if let output = result {
                                        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
                                        Text(trimmed.isEmpty ? "It printed nothing." : trimmed)
                                            .font(.system(.callout, design: .monospaced))
                                            .textSelection(.enabled)
                                            .lineLimit(6)
                                    } else {
                                        HStack(spacing: 6) {
                                            Spinner(size: 11)
                                            Text("Checking…")
                                        }
                                        .font(.callout)
                                        .foregroundStyle(.secondary)
                                    }
                                }
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .recessedWell(RoundedRectangle(cornerRadius: 8))
                                .padding(.top, 4)
                            }
                        }
                        .padding(.vertical, 8)
                        Spacer(minLength: 8)
                        Button("Check Now") {
                            tried[watch.letters] = .some(nil)
                            Task { tried[watch.letters] = .some(await wakeUps.tryCheck(watch, of: owner)) }
                        }
                        .buttonStyle(TextButtonStyle())
                        .disabled(tried[watch.letters] == .some(nil))
                        .help("Run its check now, without waking \(name)")
                        Button("Stop Watching", systemImage: "minus.circle.fill") {
                            attempt { try await wakeUps.cancel(watch, of: owner) }
                        }
                        .labelStyle(.iconOnly)
                        .buttonStyle(RemoveButtonStyle())
                        .help("Stop this watch")
                    }
                }
            }
            if !watches.isEmpty && !wakes.isEmpty { WellDivider() }
            ForEach(Array(wakes.enumerated()), id: \.element.id) { index, wake in
                if index > 0 { WellDivider() }
                WellRow {
                    Image(systemName: wake.every == nil ? "alarm" : "repeat")
                } content: {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(wake.due, format: .dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())\(wake.every.map { ", then \($0.words)" } ?? "")")
                                .font(.system(size: 13, weight: .medium))
                            Text(wake.note)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 8)
                        Spacer(minLength: 8)
                        Button(wokenNow.contains(wake.id) ? "Woken Up" : "Wake Up Now") {
                            wokenNow.insert(wake.id)
                            failure = nil
                            Task {
                                do { try await wakeUps.wakeNow(wake, of: owner) } catch {
                                    // Not sent: it can be tried again.
                                    wokenNow.remove(wake.id)
                                    failure = error.localizedDescription
                                }
                            }
                        }
                        .buttonStyle(TextButtonStyle())
                        .disabled(wokenNow.contains(wake.id))
                        .help(wake.every == nil ? "Send it now" : "Send it now; it still comes back at its time")
                        Button("Cancel Wake-Up", systemImage: "minus.circle.fill") {
                            attempt { try await wakeUps.cancel(wake, of: owner) }
                        }
                        .labelStyle(.iconOnly)
                        .buttonStyle(RemoveButtonStyle())
                        .help("Cancel this wake-up")
                    }
                }
            }
            if draft == nil {
                WellDivider()
                HStack {
                    Button {
                        draft = Draft()
                        failure = nil
                        noteFocused = true
                    } label: {
                        Label("Add Wake-Up…", systemImage: "plus")
                    }
                    .buttonStyle(TextButtonStyle(outset: true))
                    Spacer()
                }
                .padding(.horizontal, isInPopover ? 0 : 12)
                .padding(.vertical, 8)
            }
        }
        .task {
            await app.wakeUps.read(owner)
            #if DEBUG
            // KUVO_DEMO_TRY_WATCH: Check Now on its first watch.
            if ProcessInfo.processInfo.environment["KUVO_DEMO_TRY_WATCH"] != nil, let watch = app.wakeUps.watches[owner.key]?.first {
                tried[watch.letters] = .some(await app.wakeUps.tryCheck(watch, of: owner))
            }
            #endif
        }
    }

    /// When, how often, and what the bot does then.
    private var form: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Closed with its ✕, so Cancel and Save stay the editor's own.
            HStack {
                Text("New Wake-Up")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Don’t Add", systemImage: "xmark") { draft = nil }
                    .buttonStyle(IconButtonStyle())
                    .help("Don’t add it")
            }
            // A field: its well stays, in a popover too.
            WellGroup(isFocused: noteFocused) {
                WellRow {
                    Image(systemName: "clock")
                } content: {
                    ScheduleRow(date: Binding(get: { draft?.due ?? .now }, set: { draft?.due = $0 }), from: .now,
                                every: Binding(get: { draft?.every }, set: { draft?.every = $0 }), choices: Self.repeats, label: "When")
                }
                WellDivider()
                TextField("What to do", text: Binding(get: { draft?.note ?? "" }, set: { draft?.note = $0 }),
                          prompt: Text(owner.isBot ? "What \(name) does then, like Send me the morning digest" : "What \(name) does then, like Check whether the build passed"), axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(2...10)
                    .focused($noteFocused)
                    .padding(12)
            }
            .environment(\.isInPopover, false)
            HStack {
                if let failure {
                    Text(failure)
                        .font(.callout)
                        .foregroundStyle(.red)
                }
                Spacer()
                Button("Add Wake-Up", action: add)
                    .buttonStyle(.glassProminent)
                    .disabled(isAdding || (draft?.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true))
            }
        }
        .transition(.opacity.combined(with: .offset(y: -6)))
    }

    /// A change to its wake-ups, and what went wrong if it didn't happen.
    private func attempt(_ change: @escaping @MainActor () async throws -> Void) {
        failure = nil
        Task {
            do { try await change() } catch { failure = error.localizedDescription }
        }
    }

    private func add() {
        guard let draft, !isAdding else { return }
        isAdding = true
        Task {
            defer { isAdding = false }
            do {
                try await app.wakeUps.add(to: owner, at: draft.due, every: draft.every, note: draft.note)
                self.draft = nil
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}

/// A session's wake-ups and watches, in a bar over its composer like the others that say what
/// goes on out of sight: one line with when it wakes next (or what it watches), and under it
/// each one, to wake it now or cancel it; All opens them in full, to add one or pause them.
/// (A bot's are in Edit Bot, and its row in the sidebar.)
struct WakeBar: View {
    let owner: WakeUps.Owner
    @Binding var isHidden: Bool
    @Environment(AppModel.self) private var app

    /// The conversation's folder as its notes write it (a machine's, its own path).
    private var noteFolder: String { RemoteFolder.parse(owner.directory)?.1 ?? owner.directory }
    @State private var showsAll = false
    @State private var failure: String?

    private enum Item: Identifiable {
        case wake(Wakes.Pending), watch(Wakes.Watch)
        var id: String {
            switch self {
            case .wake(let wake): "wake-" + wake.letters
            case .watch(let watch): "watch-" + watch.letters
            }
        }
    }

    var body: some View {
        let wakes = app.wakeUps.wakes[owner.key] ?? []
        let watches = app.wakeUps.watches[owner.key] ?? []
        // Kept current: "in 2 minutes", then, once it's due and on its way, "Waking up…".
        TimelineView(.periodic(from: .now, by: 15)) { context in
            WorkBar(items: watches.map(Item.watch) + wakes.map(Item.wake), title: title(wakes: wakes, watches: watches, now: context.date),
                    detail: (wakes.first?.note ?? watches.first?.note).map { Text(WakeNote.shown($0, folder: noteFolder).replacingOccurrences(of: "\n", with: " ")) },
                    symbol: wakes.isEmpty ? "eye" : "alarm", accessory: AnyView(all),
                    showHelp: "Show when it wakes up, and what it watches", hideHelp: "Hide them: this line stays while any wait", isHidden: $isHidden) { item in
                row(item)
            }
        }
    }

    /// Them all in full, to add one, wake it now or pause them.
    private var all: some View {
        Button("All") { showsAll = true }
            .buttonStyle(TextButtonStyle())
            .font(.system(size: 13))
            .help("All wake-ups and watches")
            .closesWhenKept($showsAll)
            .popover(isPresented: $showsAll, arrowEdge: .top) {
                ScrollView {
                    WakeList(owner: owner, name: "the agent")
                        .padding(16)
                }
                .popoverContent()
                .frame(width: 440)
                .frame(maxHeight: 520)
            }
    }

    /// In a few words, for the card's line once its bars are tucked away: when it wakes next.
    static func headline(paused: Bool, wakes: [Wakes.Pending], watches: [Wakes.Watch], now: Date) -> String {
        if paused { return "Wake-ups paused" }
        guard !wakes.isEmpty else { return "Watching" }
        return wakes.filter { $0.due > now }.min { $0.due < $1.due }.map { "Wakes " + $0.due.formatted(Date.RelativeFormatStyle(presentation: .named, unitsStyle: .wide)) } ?? "Waking up…"
    }

    private func title(wakes: [Wakes.Pending], watches: [Wakes.Watch], now: Date) -> String {
        if app.wakeUps.paused.contains(owner.key) { return "Wake-ups paused" }
        let watching = watches.isEmpty ? "" : watches.count == 1 ? "watching 1 thing" : "watching \(watches.count) things"
        guard !wakes.isEmpty else { return watching.prefix(1).uppercased() + watching.dropFirst() }
        let next = wakes.first { $0.due > now }
        let when = next.map { "Wakes " + $0.due.formatted(Date.RelativeFormatStyle(presentation: .named, unitsStyle: .wide)) } ?? "Waking up…"
        return when + (wakes.count > 1 ? " (\(wakes.count) waiting)" : "") + (watching.isEmpty ? "" : ", " + watching)
    }

    @ViewBuilder private func row(_ item: Item) -> some View {
        if let putAways, let text = putAways.text(.wake(item.id)) {
            UndoLine(text: text, undo: putAways.canUndo(.wake(item.id)) ? { putAways.undo(.wake(item.id)) } : nil, isRow: true)
        } else {
            line(item)
        }
    }

    /// The conversation's: a wake-up canceled here waits for Undo's moment.
    private var putAways: PutAways<PutAway>? { app.workspace.model(for: owner.session)?.putAways }

    /// Canceled once Undo's moment is over; its row says so until it's gone.
    private func cancel(_ item: Item, saying text: String, _ change: @escaping @MainActor () async throws -> Void) {
        guard let putAways else { return attempt(change) }
        putAways.put(.wake(item.id), text: text, lingers: true, done: {
            attempt {
                defer { putAways.gone(.wake(item.id)) }
                try await change()
            }
        })
    }

    @ViewBuilder private func line(_ item: Item) -> some View {
        HStack(spacing: 10) {
            switch item {
            case .wake(let wake):
                Image(systemName: wake.every == nil ? "alarm" : "repeat")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Text("\(Text(wake.due, format: .dateTime.weekday(.abbreviated).hour().minute()).foregroundStyle(.secondary))\(wake.every.map { Text(", then \($0.words)").foregroundStyle(.secondary) } ?? Text(""))  \(WakeNote.shown(wake.note, folder: noteFolder).replacingOccurrences(of: "\n", with: " "))")
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help(wake.note)
                Button("Now") { attempt { try await app.wakeUps.wakeNow(wake, of: owner) } }
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13))
                    .help(wake.every == nil ? "Wake it up now" : "Wake it up now; it still comes back at its time")
                Button("Cancel") { cancel(item, saying: "Wake-up canceled") { try await app.wakeUps.cancel(wake, of: owner) } }
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13))
                    .help("Cancel this wake-up")
            case .watch(let watch):
                Image(systemName: "eye")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Text("\(Text((Wakes.Repeat(watch.every)?.words ?? "every \(watch.every)").capitalizedFirst).foregroundStyle(.secondary))  \(WakeNote.shown(watch.note, folder: noteFolder).replacingOccurrences(of: "\n", with: " "))")
                    .font(.system(size: 12))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .help(watch.check + "\n\n" + watch.note)
                Button("Stop") { cancel(item, saying: "Watch stopped") { try await app.wakeUps.cancel(watch, of: owner) } }
                    .buttonStyle(TextButtonStyle())
                    .font(.system(size: 13))
                    .help("Stop this watch")
            }
        }
    }

    /// A change to them; what went wrong shows over the composer, as other failures do.
    private func attempt(_ change: @escaping @MainActor () async throws -> Void) {
        Task {
            do { try await change() } catch { app.workspace.model(for: owner.session)?.failure = error.localizedDescription }
        }
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
