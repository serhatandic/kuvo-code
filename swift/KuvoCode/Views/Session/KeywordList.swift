import ClientDesign
import ClientNews
import ClientSessions
import OpenCodeKit
import SwiftUI

/// What the "/" list offers: Kuvo Code's keywords first, then the project's own commands.
enum SlashItem: Identifiable, Equatable {
    case keyword(Keyword)
    case command(Command)

    var id: String {
        switch self {
        case .keyword(let keyword): "keyword." + keyword.rawValue
        case .command(let command): "command." + command.name
        }
    }

    static func == (a: SlashItem, b: SlashItem) -> Bool { a.id == b.id }

    /// The keywords then the commands `query` (what follows the "/") matches: names starting
    /// with it first, then names containing it.
    static func matches(_ query: String, keywords: [Keyword], commands: [Command]) -> [SlashItem] {
        let query = query.lowercased()
        let words = keywords.filter { $0.rawValue.hasPrefix(query) } + keywords.filter { !$0.rawValue.hasPrefix(query) && $0.rawValue.contains(query) }
        // `commands` are the project's less those a keyword hides (`Keyword.commands`).
        return words.map(SlashItem.keyword) + SlashCommands.matches(query, in: commands).map(SlashItem.command)
    }

    /// Which of `items` is picked first for `query`: the one named exactly that (a project's
    /// "/view", typed in full, over /review that only has it inside), else the first.
    static func chosen(_ query: String, in items: [SlashItem]) -> Int {
        let query = query.lowercased()
        return items.firstIndex { item in
            switch item {
            case .keyword(let keyword): keyword.rawValue == query
            case .command(let command): command.name.lowercased() == query
            }
        } ?? 0
    }
}

/// The keywords and commands a "/" matches, above the message field: each keyword with its mark
/// and what it does, then the project's own commands under its name.
struct SlashList: View {
    let items: [SlashItem]
    let selected: Int
    /// The project's name, over its own commands.
    let project: String?
    let choose: (SlashItem) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        // The project's commands under its name, after the keywords.
        let firstCommand = items.firstIndex { if case .command = $0 { true } else { false } }
        VStack(alignment: .leading, spacing: 1) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                // The project's name and its first command, known by its place together, so the
                // name comes into view with it (`ComposerListScroll`).
                VStack(alignment: .leading, spacing: 1) {
                    if index == firstCommand, index > 0, let project {
                        Text(project)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.top, 6)
                            .padding(.bottom, 2)
                            .accessibilityAddTraits(.isHeader)
                    }
                    Button { choose(item) } label: { row(item) }
                        .buttonStyle(ListRowButtonStyle(isSelected: index == selected))
                        .accessibilityAddTraits(index == selected ? .isSelected : [])
                }
                .id(index)
            }
        }
        .padding(.leading, -8)
        .help("↑ ↓ to choose, Return to pick, Escape to close")
    }

    private func row(_ item: SlashItem) -> some View {
        HStack(spacing: 8) {
            switch item {
            case .keyword(let keyword):
                KeywordMark(keyword: keyword)
                Text(keyword.typed)
                    .font(.system(size: 13, weight: .medium))
                // One a recent release brought, until it's used.
                if app.newMarks.isNew("keyword/" + keyword.rawValue) { NewMark() }
                Text(keyword.summary)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            case .command(let command):
                Image(systemName: "doc.text")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(width: 18)
                Text("/" + command.name)
                    .font(.system(size: 13, weight: .medium))
                if let description = command.description {
                    Text(description)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .padding(.horizontal, 8)
        .frame(height: 28)
        .accessibilityElement(children: .combine)
    }
}

/// A keyword's mark, in the list and the bubbles: secondary, the same for every one (Plan's
/// orange is only its mode's, in the composer).
struct KeywordMark: View {
    let keyword: Keyword
    var size: CGFloat = 12

    var body: some View {
        Image(systemName: keyword.symbol)
            .font(.system(size: size))
            .foregroundStyle(.secondary)
            .frame(width: 18)
            .accessibilityHidden(true)
    }
}

/// What "/loop " offers for how often: the usual ones, each with when it first sends, and
/// Custom… for any other.
enum LoopChoice: Identifiable, Equatable {
    case preset(LoopSchedule)
    case custom

    var id: String {
        switch self {
        case .preset(let schedule): schedule.phrase
        case .custom: "custom"
        }
    }

    /// Those whose words start with what's typed after "/loop " (all of them before anything is).
    static func matches(_ typed: String) -> [LoopChoice]? {
        let typed = typed.trimmingCharacters(in: .whitespaces).lowercased()
        let presets = LoopSchedule.presets.filter { typed.isEmpty || $0.phrase.hasPrefix(typed) || $0.title.lowercased().hasPrefix(typed) }
        let all = presets.map(LoopChoice.preset) + (typed.isEmpty || "custom".hasPrefix(typed) ? [.custom] : [])
        return all.isEmpty ? nil : all
    }
}

struct LoopList: View {
    let choices: [LoopChoice]
    let selected: Int
    let choose: (LoopChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("How often")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.bottom, 2)
                .accessibilityAddTraits(.isHeader)
            // When each first sends, as of now: read again each minute.
            TimelineView(.everyMinute) { timeline in
                VStack(spacing: 1) {
                    ForEach(Array(choices.enumerated()), id: \.element.id) { index, choice in
                        Button { choose(choice) } label: { row(choice, now: timeline.date) }
                            .buttonStyle(ListRowButtonStyle(isSelected: index == selected))
                            .accessibilityAddTraits(index == selected ? .isSelected : [])
                            .id(index)
                    }
                }
            }
        }
        .padding(.leading, -8)
        .help("↑ ↓ to choose, Return to pick, Escape to close")
    }

    private func row(_ choice: LoopChoice, now: Date) -> some View {
        HStack(spacing: 8) {
            Image(systemName: choice == .custom ? "clock" : "arrow.clockwise")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            switch choice {
            case .preset(let schedule):
                Text(schedule.title)
                    .font(.system(size: 13, weight: .medium))
                Text(schedule.firstPhrase(now: now))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            case .custom:
                Text("Custom…")
                    .font(.system(size: 13, weight: .medium))
                Text("Any interval, any time")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .padding(.horizontal, 8)
        .frame(height: 28)
        .accessibilityElement(children: .combine)
    }
}

/// A model "/review … with " can name.
enum ReviewerChoice: Identifiable, Equatable {
    /// `note`: "picked last time", or who serves it.
    case reader(ReviewCommand.Reader, note: String)

    var id: String {
        switch self {
        case .reader(let reader, _): reader.ref.providerID + "/" + reader.ref.id
        }
    }
}

/// The models "/review … with " can name: who reads it with fresh eyes.
struct ReviewerList: View {
    let choices: [ReviewerChoice]
    let selected: Int
    let choose: (ReviewerChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Who reads it")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.bottom, 2)
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(choices.enumerated()), id: \.element.id) { index, choice in
                Button { choose(choice) } label: { row(choice) }
                    .buttonStyle(ListRowButtonStyle(isSelected: index == selected))
                    .accessibilityAddTraits(index == selected ? .isSelected : [])
                    .id(index)
            }
        }
        .padding(.leading, -8)
        .help("↑ ↓ to choose, Return to pick, Escape to close")
    }

    private func row(_ choice: ReviewerChoice) -> some View {
        HStack(spacing: 8) {
            // A reviewer reads: the Review bar's own mark.
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 18)
            switch choice {
            case .reader(let reader, let note):
                Text(reader.name)
                    .font(.system(size: 13, weight: .medium))
                Spacer(minLength: 8)
                Text(note).font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, 8)
        .frame(height: 28)
        .accessibilityElement(children: .combine)
    }
}

/// "/review "'s lists, as "/loop "'s "How often": what it reads, a commit or a folder for it (or
/// your own words), and what it looks for.
struct ReviewChoiceList: View {
    let list: ReviewList
    let selected: Int
    let choose: (ReviewList.Row) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(list.title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.bottom, 2)
                .accessibilityAddTraits(.isHeader)
            ForEach(Array(list.rows.enumerated()), id: \.element.id) { index, row in
                Button { choose(row) } label: { label(row) }
                    .buttonStyle(ListRowButtonStyle(isSelected: index == selected))
                    .accessibilityAddTraits(index == selected ? .isSelected : [])
                    .id(index)
            }
        }
        .padding(.leading, -8)
        .help("↑ ↓ to choose, Return to pick, Escape to close")
    }

    private func label(_ row: ReviewList.Row) -> some View {
        HStack(spacing: 8) {
            Image(systemName: row.symbol)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 18)
                .accessibilityHidden(true)
            Text(row.title)
                .font(.system(size: 13, weight: .medium))
                .layoutPriority(1)
            if let note = row.note {
                Text(note)
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(row.warns ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .padding(.horizontal, 8)
        .frame(height: 28)
        .accessibilityElement(children: .combine)
    }
}

/// Custom…'s row, in place of the list: every so many minutes, hours or days, or weekdays, at a
/// time of day for days and weekdays. Use writes it after "/loop ", as if typed.
struct CustomLoopRow: View {
    let use: (LoopSchedule) -> Void
    let cancel: () -> Void

    enum Unit: String, CaseIterable, Identifiable {
        case minutes, hours, days, weekdays
        var id: String { rawValue }
        var title: String {
            switch self {
            case .minutes: "minutes"
            case .hours: "hours"
            case .days: "days"
            case .weekdays: "weekday"
            }
        }
    }

    @State private var count = 2
    @State private var unit = Unit.hours
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: .now) ?? .now
    @FocusState private var countFocused: Bool

    /// What's picked, as a wake-up takes it; nil while the number isn't one it can.
    private var schedule: LoopSchedule? {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: time)
        switch unit {
        case .minutes: return Wakes.Repeat("\(count)m").map { LoopSchedule(every: $0) }
        case .hours: return Wakes.Repeat("\(count)h").map { LoopSchedule(every: $0) }
        case .days: return Wakes.Repeat("\(count)d").map { LoopSchedule(every: $0, hour: parts.hour, minute: parts.minute) }
        case .weekdays: return LoopSchedule(every: .weekdays, hour: parts.hour, minute: parts.minute)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("How often")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .accessibilityAddTraits(.isHeader)
            // On one line where there's room; in a narrow window, the buttons go under it.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    controls
                    Spacer(minLength: 8)
                    buttons
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) { controls }
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)
                        buttons
                    }
                }
            }
            .font(.system(size: 13))
            if schedule == nil {
                Text(problem)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear { countFocused = true }
    }

    /// Why Use waits.
    private var problem: String {
        if count < 1 { return "At least 1." }
        if unit == .minutes, count < 5 { return "At least every 5 minutes." }
        return "That’s more than a wake-up can wait."
    }

    @ViewBuilder private var controls: some View {
        Text("Every")
        if unit != .weekdays {
            TextField("Number", value: $count, format: .number)
                .textFieldStyle(.plain)
                .multilineTextAlignment(.center)
                .frame(width: 44)
                .padding(.vertical, 4)
                .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 6))
                .focused($countFocused)
                .onSubmit(pick)
                .accessibilityLabel("How many")
        }
        Picker("Unit", selection: $unit) {
            ForEach(Unit.allCases) { Text($0.title).tag($0) }
        }
        .labelsHidden()
        .fixedSize()
        if unit == .days || unit == .weekdays {
            Text("at")
            DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                .labelsHidden()
                .datePickerStyle(.field)
                .fixedSize()
        }
    }

    @ViewBuilder private var buttons: some View {
        Button("Cancel", action: cancel)
            .buttonStyle(.glass)
            .keyboardShortcut(.cancelAction)
        Button("Use", action: pick)
            .buttonStyle(.glassProminent)
            .disabled(schedule == nil)
    }

    private func pick() {
        guard let schedule else { return }
        use(schedule)
    }
}

/// Under the message field while a keyword is typed: why what's typed can't be done as it is (a
/// /loop whose "how often" can't be read), in a line.
struct KeywordProblem: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: "exclamationmark.circle")
                .accessibilityHidden(true)
            Text(text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .transition(.opacity)
    }
}
