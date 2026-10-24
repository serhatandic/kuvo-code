import AppKit
import OpenCodeKit
import SwiftUI

/// Making a group chat, or changing one, in the window's main card: its name, its bots, and
/// which of them leads.
struct GroupEditor: View {
    /// The chat being changed; nil for a new one.
    let group: BotGroup?
    /// Makes a bot, when there aren't enough for a chat.
    let newBot: () -> Void
    /// Back to what was there before.
    let close: () -> Void
    /// Called with the new chat, once it's made.
    var created: (BotGroup) -> Void = { _ in }

    @Environment(Bots.self) private var bots
    @Environment(GroupChats.self) private var groups
    @State private var name: String
    @State private var purpose: String
    /// Its bots, in order: the first leads.
    @State private var members: [String]
    @State private var confirmsDelete = false
    /// Its meeting: whether it has one, when it's next, how often, and what about.
    @State private var meets: Bool
    @State private var meetsAt: Date
    @State private var meetsEvery: Wakes.Repeat?
    @State private var topic: String
    /// Who can be in it, as the computer it lives on says (a machine's: its own bots, and those of
    /// your other computers that take a chat's turns); nil until it's said, or for this Mac's.
    @State private var joinable: [String]?
    @FocusState private var focus: Field?

    private enum Field { case name, purpose, topic }

    /// The repeats to pick from.
    private static let repeats: [Wakes.Repeat?] = [nil, .days(1), .weekdays, .weeks(1)]

    init(group: BotGroup?, newBot: @escaping () -> Void, close: @escaping () -> Void, created: @escaping (BotGroup) -> Void = { _ in }) {
        self.group = group
        self.newBot = newBot
        self.close = close
        self.created = created
        _name = State(initialValue: group?.name ?? "")
        _purpose = State(initialValue: group?.purpose ?? "")
        _members = State(initialValue: group?.members ?? [])
        let meeting = group?.meeting
        _meets = State(initialValue: meeting != nil)
        _meetsAt = State(initialValue: meeting?.next ?? Self.tomorrowAtNine)
        _meetsEvery = State(initialValue: meeting.map { $0.repeats } ?? .weekdays)
        _topic = State(initialValue: meeting?.topic ?? "")
    }

    /// A first meeting's time: nine tomorrow morning.
    private static var tomorrowAtNine: Date {
        let calendar = Calendar.current
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: .now) ?? .now
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }

    /// The meeting to save: its next time after now (a repeating one's next round, if the one
    /// picked has passed; on weekdays, a weekday). With its time and repeat as they were, it keeps
    /// the time of day (and a week's day) it had, whatever daylight saving or a new time zone did
    /// to its next time; a time picked here is the one it keeps from then on.
    private var meeting: BotGroup.Meeting? {
        guard meets else { return nil }
        // A one-off whose time has passed: as picked, so Save stays off and says why.
        return BotGroup.Meeting.planned(at: meetsAt, every: meetsEvery, topic: topic, before: group?.meeting)
            ?? BotGroup.Meeting(next: meetsAt, every: nil, topic: topic, at: nil, weekday: nil)
    }

    private var isNew: Bool { group == nil }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var picked: [Bot] { members.compactMap { bots.bot($0) } }
    /// The bots it can have: those the computer it lives on says can join; until it's said, a
    /// machine's own (this Mac's chats can have any).
    private var choices: [Bot] {
        guard let machine = group.flatMap({ groups.machine(of: $0.id) }) else { return bots.list }
        if let joinable { return bots.list.filter { joinable.contains($0.id) || members.contains($0.id) } }
        return bots.list.filter { $0.machine == machine }
    }

    /// What the bots section says: a machine's chat that can have bots of your other computers says
    /// where each takes its turn.
    private var botsNote: String {
        guard let machine = group.flatMap({ groups.machine(of: $0.id) }) else {
            return "Pick two or more. They answer one at a time, and each remembers the chat in its own conversation."
        }
        if choices.contains(where: { $0.machine != machine }) {
            return "Pick two or more. They answer one at a time, each on its own computer, and each remembers the chat in its own conversation."
        }
        return "Pick two or more of the bots on \(machine), where this chat lives. They answer one at a time, and each remembers the chat in its own conversation."
    }
    private var canSave: Bool { !trimmedName.isEmpty && picked.count >= 2 && (meeting.map { $0.next > .now } ?? true) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                form
                    .frame(maxWidth: 600)
                    .padding(.horizontal, Metrics.gutter + 8)
                    .padding(.top, 24)
                    .padding(.bottom, 8)
                    .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            footer
                .frame(maxWidth: 600)
                .padding(.horizontal, Metrics.gutter + 8)
                .padding(.top, 12)
                .padding(.bottom, 20)
                .frame(maxWidth: .infinity)
        }
        .onAppear { if isNew { focus = .name } }
        .task(id: group?.id) {
            guard let group else { return }
            joinable = await groups.joinable(for: group.id)
        }
        .alert("Delete \(group?.name ?? "This Group Chat")?", isPresented: $confirmsDelete) {
            Button("Delete", role: .destructive) {
                guard let group else { return }
                close()
                Task { await groups.delete(group) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its messages are deleted, and its bots stop remembering it. This can’t be undone.")
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Its picture and who's in it, beside its name and what it's for, as a bot's editor has
            // its face beside its name and job.
            HStack(alignment: .center, spacing: 18) {
                VStack(spacing: 8) {
                    Group {
                        if picked.isEmpty {
                            Image(systemName: "person.2")
                                .font(.system(size: 30, weight: .light))
                                .foregroundStyle(.tertiary)
                        } else {
                            GroupAvatar(faces: picked.map { GroupAvatar.Face(look: $0.look) }, size: 76)
                        }
                    }
                    .frame(width: 76, height: 76)
                    Text(picked.isEmpty ? "No bots yet" : picked.count.counting("bot"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
                .frame(width: 92)
                .animation(.ui, value: members)
                WellGroup(isActive: focus != nil) {
                    WellRow(isActive: focus == .name) {
                        Image(systemName: "bubble.left.and.bubble.right")
                    } content: {
                        // Both wrap, so a narrow card shows all of what's in them, prompts too.
                        TextField("Name", text: $name, prompt: Text("Name, like Release Planning"), axis: .vertical)
                            .textFieldStyle(.plain)
                            .font(.system(size: 15, weight: .medium))
                            .lineLimit(1...3)
                            .focused($focus, equals: .name)
                            .padding(.vertical, 12)
                    }
                    WellDivider()
                    WellRow(isActive: focus == .purpose) {
                        Image(systemName: "target")
                    } content: {
                        TextField("Purpose", text: $purpose, prompt: Text("What it's for, like Plan each week's release"), axis: .vertical)
                            .textFieldStyle(.plain)
                            .lineLimit(1...6)
                            .focused($focus, equals: .purpose)
                            .padding(.vertical, 12)
                    }
                }
                // The rows keep their height; the picture beside them is taller.
                .fixedSize(horizontal: false, vertical: true)
            }

            section("Bots", note: botsNote) {
                WellGroup {
                    ForEach(Array(choices.enumerated()), id: \.element.id) { index, bot in
                        if index > 0 { WellDivider() }
                        MemberRow(bot: bot, isOn: members.contains(bot.id)) {
                            withAnimation(.ui) {
                                if let index = members.firstIndex(of: bot.id) { members.remove(at: index) } else { members.append(bot.id) }
                            }
                        }
                    }
                    if bots.list.count < 2 {
                        if !bots.list.isEmpty { WellDivider() }
                        Button(action: newBot) {
                            WellRow {
                                Image(systemName: "plus.circle")
                            } content: {
                                Text(bots.list.isEmpty ? "Make a Bot" : "Make Another Bot")
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(WellRowButtonStyle())
                    }
                }
            }

            if picked.count >= 2 {
                section("Leads", note: "The lead speaks first, keeps it on track and sums up at the end.") {
                    WellGroup {
                        leadMenu
                    }
                }
            }

            section("Meets", note: meets ? (meeting.map { $0.next > .now } == false ? "That time has passed. Pick one to come, or how often it repeats." : "At its time, the topic goes to the chat and the bots talk it through; if you’re away, you get the lead’s sum-up. It meets while Kuvo Code is open.") : nil) {
                meetingRows
            }
        }
    }

    /// When the chat meets on its own, like a standup every weekday at 9.
    private var meetingRows: some View {
        WellGroup(isActive: focus == .topic) {
            WellRow {
                Image(systemName: "calendar")
            } content: {
                Toggle(isOn: $meets.animation(.ui)) {
                    Text("Meets on a Schedule")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .toggleStyle(.switch)
                .padding(.vertical, 8)
            }
            if meets {
                WellDivider()
                WellRow {
                    Image(systemName: "clock")
                } content: {
                    ScheduleRow(date: $meetsAt, from: nil, every: $meetsEvery, choices: Self.repeats, label: "Next meeting")
                }
                WellDivider()
                TextField("Topic", text: $topic, prompt: Text("What to go over, like What changed since yesterday, and what’s in the way"), axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($focus, equals: .topic)
                    .padding(12)
            }
        }
    }

    private var leadMenu: some View {
        NativeMenuButton(opensBelow: true) {
            let menu = NSMenu()
            for bot in picked {
                menu.addItem(ActionItem(bot.name, subtitle: bot.job.isEmpty ? nil : bot.job, checked: bot.id == members.first) {
                    withAnimation(.ui) {
                        members.removeAll { $0 == bot.id }
                        members.insert(bot.id, at: 0)
                    }
                })
            }
            return menu
        } label: {
            WellRow {
                if let lead = picked.first { BotAvatar(look: lead.look, size: 22, animates: false) } else { Image(systemName: "star") }
            } content: {
                HStack(spacing: 8) {
                    Text(picked.first?.name ?? "")
                        .foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    MenuChevron()
                }
            }
            .contentShape(.rect)
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if !isNew {
                Button("Delete Group Chat…", role: .destructive) { confirmsDelete = true }
                    .buttonStyle(.glass)
            }
            Spacer()
            Button("Cancel", role: .cancel, action: close)
                .keyboardShortcut(.cancelAction)
                .buttonStyle(.glass)
            Button(isNew ? "Start Group Chat" : "Save", action: save)
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.glassProminent)
                .disabled(!canSave)
        }
        .controlSize(.large)
    }

    private func save() {
        guard canSave else { return }
        let members = picked.map(\.id)
        let purpose = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        if let editing = group {
            // Onto the chat as it is now: its seats and what each heard moved on while you edited.
            var group = groups.group(editing.id) ?? editing
            group.name = trimmedName
            group.purpose = purpose.isEmpty ? nil : purpose
            group.members = members
            group.meeting = meeting
            Task { await groups.update(group) }
            close()
        } else {
            created(groups.create(name: trimmedName, purpose: purpose.isEmpty ? nil : purpose, members: members, meeting: meeting))
        }
    }

    private func section(_ title: String, note: String? = nil, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content()
            if let note {
                Text(note)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A bot to have in the chat or not: its face, name and job, and a check when it's in.
private struct MemberRow: View {
    let bot: Bot
    let isOn: Bool
    let toggle: () -> Void
    @State private var isHovering = false

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 12) {
                BotAvatar(look: bot.look, size: 26, noticed: isHovering, animates: false)
                    .overlay(alignment: .bottomTrailing) {
                        if let machine = bot.machine { MachineBadge(machine: machine, size: 12).offset(x: 3, y: 3) }
                    }
                VStack(alignment: .leading, spacing: 1) {
                    Text(bot.name)
                    if !bot.job.isEmpty {
                        Text(bot.job)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 17))
                    .foregroundStyle(isOn ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 50)
            .background(isHovering ? Pressable.hoverFill : .clear)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }
}
