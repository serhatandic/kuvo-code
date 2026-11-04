import ClientDesign
import ClientSessions
import SwiftUI

/// A goal's steps as a list (`GoalTimeline.stages`), read left to right like the timeline: what's
/// done, small and faint; the step under way as a card with its mark, name, its line on what's in
/// it, how far along it is and about how long it has left, two under way one card over the other; then what's ahead, the
/// next a little stronger, and steps that start together under one tall mark, two and a count
/// past three. Before it
/// starts, the first step waits in a grey card. Narrow, the same top to bottom, with what's done
/// folded into one faint line; once it's over, what's done and what it left, one under the other.
/// Three cards at most, those waiting for you first, the rest under way named on a line under them.
/// Names and lines are whole wherever the pane has room for them; past about ten rows they scroll,
/// the pane ending between rows. All of it is decided as it's laid
/// out, from the room it's given, never from a size measured a frame later: the first frame is
/// the one it keeps.
struct GoalStagesView: View {
    let plan: GoalPlan
    let timeline: GoalTimeline
    /// You have the goal paused: what's under way shows paused.
    var isPaused = false
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme
    /// The groups of steps that start together opened past their count, by their first step.
    @State private var opened: Set<String> = []

    static let rowHeight: CGFloat = 26
    /// The most the done column takes; its names are cut at their end past it.
    static let doneWidth: CGFloat = 220
    static let gap: CGFloat = 18
    /// The least a card takes beside the steps ahead (its line cut at its end below its own
    /// width), and the most of the room after what's done.
    static let cardWidth: CGFloat = 200
    static let cardShare: CGFloat = 0.62
    /// The most rows take before they scroll: ten. Every row is `rowHeight` tall, so a pane this
    /// high ends between two; the cards are never in it, so they're always whole.
    static let mostRows: CGFloat = 10 * rowHeight

    private var now: Date { timeline.now }

    var body: some View {
        let stages = timeline.stages(paused: isPaused)
        // The columns side by side where what's done, a card at its least and a step ahead each
        // have room for a name; else top to bottom. The wide one asks for that much as its ideal,
        // so the choice is made from the width it's offered.
        // Once it's over there's nothing under way to put between: one list, top to bottom.
        ViewThatFits(in: .horizontal) {
            if !stages.isOver {
                wide(stages)
                    .frame(idealWidth: stages.done.isEmpty ? 400 : 640, maxWidth: .infinity, alignment: .topLeading)
            }
            narrow(stages)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .accessibilityElement(children: .contain)
        // Another goal in the same place: no group opened carries over.
        .onChange(of: plan.id) { opened = [] }
    }

    /// Rows that scroll once they're more than `mostRows` tall. Done ones open on the latest,
    /// nearest the card.
    private func scrolls(from anchor: UnitPoint = .top, @ViewBuilder _ rows: () -> some View) -> some View {
        ScrollView(.vertical) {
            rows().frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .defaultScrollAnchor(anchor)
        // Short, so the pane's end, between rows, fades only their room.
        .fadingScrollEdges(8)
    }

    // MARK: Wide: done, now, ahead

    private func wide(_ stages: GoalStages) -> some View {
        StageColumns(gap: Self.gap) {
            if !stages.done.isEmpty {
                scrolls(from: .bottom) { doneRows(stages) }
                    .layoutValue(key: StageColumns.Column.self, value: .done)
            }
            if !stages.now.isEmpty {
                cards(stages).layoutValue(key: StageColumns.Column.self, value: .cards)
            }
            if !stages.ahead.isEmpty { scrolls { ahead(stages) } }
        }
    }

    // MARK: Narrow: done folded, now, ahead

    private func narrow(_ stages: GoalStages) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if stages.isOver {
                // Once it's over there's no card to come before: what's done shows in full, then
                // what it left.
                scrolls { VStack(alignment: .leading, spacing: 0) { doneRows(stages); ahead(stages) } }
                    .frame(maxHeight: Self.mostRows)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                if !stages.done.isEmpty { doneFold(stages.done) }
                if !stages.now.isEmpty { cards(stages) }
                if !stages.ahead.isEmpty {
                    scrolls { ahead(stages) }
                        .frame(maxHeight: Self.mostRows)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func doneRows(_ stages: GoalStages) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(stages.done) { lane in doneRow(lane, number: stages.number(lane.id)) }
        }
    }

    /// The steps done as one faint line, the latest nearest the card: as many names whole as fit,
    /// the ones before them a count ("+2 · Photo scan engine · RevenueCat paywall"); where even
    /// the latest has no room whole, it's cut at its end.
    private func doneFold(_ done: [GoalTimeline.Lane]) -> some View {
        fold(done.map(\.step.text), mark: .done, countFirst: true)
            .accessibilityLabel(done.count == 1 ? "1 step done" : "\(done.count) steps done")
    }

    /// Names on one faint line after a mark, as many whole as fit and a count for the rest: before
    /// them (`countFirst`, the ones done longest ago) or after them.
    private func fold(_ names: [String], mark: GoalTrack.State, countFirst: Bool) -> some View {
        let line = { (folded: Int) -> String in
            let count: [String] = folded == 0 ? [] : ["+\(folded)"]
            return (countFirst ? count + Array(names.dropFirst(folded)) : Array(names.dropLast(folded)) + count).joined(separator: " · ")
        }
        return ViewThatFits(in: .horizontal) {
            ForEach(0..<names.count, id: \.self) { folded in
                HStack(spacing: 8) {
                    GoalStepMark(mark).frame(width: 14)
                    Text(line(folded)).lineLimit(1).fixedSize()
                }
            }
            HStack(spacing: 8) {
                GoalStepMark(mark).frame(width: 14)
                Text(line(names.count - 1)).lineLimit(1)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.tertiary)
        .frame(height: 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .help(names.joined(separator: "\n"))
        .accessibilityElement(children: .ignore)
        .accessibilityValue(names.joined(separator: ", "))
    }

    // MARK: The cards

    private func cards(_ stages: GoalStages) -> some View {
        let (shown, rest) = stages.cards
        return VStack(alignment: .leading, spacing: 8) {
            ForEach(shown) { card in self.card(card, number: stages.number(card.id)) }
            if !rest.isEmpty {
                fold(rest.map(\.step.text), mark: .running, countFirst: false)
                    .accessibilityLabel(rest.count == 1 ? "1 more under way" : "\(rest.count) more under way")
            }
        }
    }

    private func card(_ card: GoalStages.Card, number: Int) -> some View {
        let step = card.step
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("\(number)")
                    .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                    .foregroundStyle(numberInk(card.look))
                    .frame(width: 18, height: 18)
                    .background {
                        // Waiting for you, a ring rather than a fill: it reads apart from one under
                        // way without its colour.
                        if card.look == .waiting {
                            Circle().strokeBorder(Color.orange, lineWidth: 1.5)
                        } else {
                            Circle().fill(numberFill(card.look))
                        }
                    }
                if GoalPlanWords.mark(of: step) != nil { StepServiceMark(step: step) }
                Text(step.text)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
            }
            if let detail = step.detail {
                Text(detail)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.leading, 26)
            }
            // How far along: filled as far as the bot measured, striped where it couldn't say.
            if card.look != .ready {
                GoalTrack(track(card.look), progress: step.progress)
                    .padding(.leading, 26)
                    .padding(.top, 4)
            }
            if let left = GoalPlanWords.left(card, now: now) {
                Text(left)
                    .font(.system(size: 11.5).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(cardFill(card.look)))
        .contentShape(.rect)
        .help(help(step))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(step.text)
        .accessibilityValue([isPaused && card.look == .paused ? "Paused" : GoalPlanWords.spokenState(of: step, in: plan, now: now), step.detail, GoalPlanWords.left(card, now: now)]
            .compactMap { $0 }.joined(separator: ", "))
    }

    private func track(_ look: GoalStages.Card.Look) -> GoalTrack.State {
        switch look {
        case .doing: .running
        case .waiting: .waiting
        case .paused: .paused
        case .ready: .todo
        }
    }

    private func cardFill(_ look: GoalStages.Card.Look) -> Color {
        switch look {
        case .doing: accent.opacity(scheme == .dark ? 0.2 : 0.12)
        case .waiting: Color.orange.opacity(scheme == .dark ? 0.2 : 0.13)
        case .paused, .ready: Color.primary.opacity(scheme == .dark ? 0.07 : 0.05)
        }
    }

    private func numberFill(_ look: GoalStages.Card.Look) -> Color {
        switch look {
        case .doing: accent
        case .waiting: .clear
        case .paused, .ready: Color.primary.opacity(scheme == .dark ? 0.14 : 0.09)
        }
    }

    private func numberInk(_ look: GoalStages.Card.Look) -> AnyShapeStyle {
        switch look {
        case .doing: AnyShapeStyle(.white)
        case .waiting: AnyShapeStyle(.orange)
        case .paused, .ready: AnyShapeStyle(.secondary)
        }
    }

    // MARK: The rows

    /// Steps that start together under one tall mark, the step's circle drawn as long as they are,
    /// one under another with each name whole. Past `GoalStages.mostCards`, two of them and a count
    /// that opens the rest in place.
    private func ahead(_ stages: GoalStages) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(stages.ahead.enumerated()), id: \.element.first?.id) { index, group in
                aheadGroup(group, stages, isNext: index == 0 && !stages.isOver)
            }
        }
    }

    /// How many of a group of `count` that start together show: all of them up to
    /// `GoalStages.mostCards`, or once opened; else two, and a count for the rest.
    static func shownTogether(_ count: Int, opened: Bool) -> Int {
        opened || count <= GoalStages.mostCards ? count : GoalStages.mostCards - 1
    }

    private func aheadGroup(_ group: [GoalTimeline.Lane], _ stages: GoalStages, isNext: Bool) -> some View {
        let id = group.first?.id ?? ""
        let shown = Self.shownTogether(group.count, opened: opened.contains(id))
        let rows = shown + (shown < group.count ? 1 : 0)
        return HStack(alignment: .top, spacing: 8) {
            Group {
                if group.count == 1 {
                    GoalStepMark(stages.isOver ? .skipped : .todo).frame(height: Self.rowHeight)
                } else {
                    // The step's circle, as tall as the steps that share its start.
                    Capsule()
                        .strokeBorder(Color.primary.opacity(stages.isOver ? (scheme == .dark ? 0.2 : 0.16) : (scheme == .dark ? 0.32 : 0.26)), lineWidth: 1.2)
                        .frame(width: 12.5, height: CGFloat(rows) * Self.rowHeight - 13)
                        .padding(.vertical, 6.5)
                        .accessibilityHidden(true)
                }
            }
            .frame(width: 14)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(group.prefix(shown)) { lane in
                    aheadRow(lane, number: stages.number(lane.id), isNext: isNext, isOver: stages.isOver)
                }
                if shown < group.count {
                    more(group.count - shown, isNext: isNext) {
                        withAnimation(.ui) { _ = opened.insert(id) }
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// "+8": the rest of the steps that start together, opened in place.
    private func more(_ count: Int, isNext: Bool, open: @escaping () -> Void) -> some View {
        Button(action: open) {
            Text("+\(count)")
                .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                .foregroundStyle(isNext ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .padding(.horizontal, 7)
                .frame(height: 19)
                .background(Capsule().fill(Color.primary.opacity(scheme == .dark ? 0.1 : 0.065)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .fixedSize()
        .frame(height: Self.rowHeight)
        .help("Show \(count) more that start at the same time")
        .accessibilityLabel("Show \(count) more")
        .accessibilityHint("Steps that start at the same time")
    }

    private func doneRow(_ lane: GoalTimeline.Lane, number: Int) -> some View {
        row(lane, number: number, mark: lane.step.state == .skipped ? .skipped : .done, spacing: 6)
            .font(.system(size: 12))
            .foregroundStyle(.tertiary)
    }

    /// A step ahead, its mark the group's: the next a little stronger than the rest; once the goal
    /// is over, what it left.
    private func aheadRow(_ lane: GoalTimeline.Lane, number: Int, isNext: Bool, isOver: Bool) -> some View {
        row(lane, number: number, mark: nil, spacing: 8)
            .font(.system(size: 12.5, weight: isNext ? .medium : .regular))
            .foregroundStyle(isOver ? AnyShapeStyle(.tertiary) : isNext ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
    }

    private func row(_ lane: GoalTimeline.Lane, number: Int, mark: GoalTrack.State?, spacing: CGFloat) -> some View {
        let step = lane.step
        return HStack(spacing: spacing) {
            if let mark { GoalStepMark(mark).frame(width: 14) }
            // As wide as the plan's longest number, so the names line up.
            Text("\(number)")
                .monospacedDigit()
                .frame(width: plan.steps.count < 10 ? 11 : plan.steps.count < 100 ? 18 : 25, alignment: .leading)
            if GoalPlanWords.mark(of: step) != nil { StepServiceMark(step: step) }
            Text(step.text)
                .lineLimit(1)
        }
        .frame(height: Self.rowHeight)
        .contentShape(.rect)
        .help(help(step))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(step.text)
        .accessibilityValue(GoalPlanWords.spokenState(of: step, in: plan, now: now))
    }

    /// Under the pointer: the step's name in full, where it stands, and when it ran.
    private func help(_ step: GoalPlan.Step) -> String {
        var lines = [step.text]
        if let said = GoalPlanWords.state(of: step, in: plan, now: now).text { lines.append(said) }
        if let began = step.began.map({ Date(timeIntervalSince1970: $0 / 1000) }) {
            let time = { (date: Date) in GoalSteps.time(date, now: now) }
            lines.append(step.ended.map { "\(time(began)) – \(time(Date(timeIntervalSince1970: $0 / 1000)))" } ?? "Since \(time(began))")
        }
        return lines.joined(separator: "\n")
    }
}

/// The list's columns side by side, as wide as each asks: what's done as wide as its names (up to
/// `GoalStagesView.doneWidth`), what's ahead as wide as its names whole, and the cards as wide as their names and lines
/// in what's left: they give way first, down to `cardWidth`. Where even that leaves too little for
/// the names ahead, those are cut and the cards take up to `cardShare` of the rest. The rows'
/// columns are as tall as their rows up to `mostRows`, or the cards' height rounded up to a whole
/// row, and scroll past it: each ends between two rows.
private struct StageColumns: Layout {
    enum Role { case done, cards, ahead }
    struct Column: LayoutValueKey { static let defaultValue = Role.ahead }
    let gap: CGFloat

    private func widths(_ width: CGFloat, _ subviews: Subviews) -> [CGFloat] {
        let ideal = subviews.map { $0.sizeThatFits(.unspecified).width }
        let columns = subviews.map { $0[Column.self] }
        var widths = Array(repeating: CGFloat(0), count: subviews.count)
        var rest = width - gap * CGFloat(max(0, subviews.count - 1))
        if let done = columns.firstIndex(of: .done) {
            widths[done] = min(ideal[done], GoalStagesView.doneWidth)
            rest -= widths[done]
        }
        rest = max(0, rest)
        if let cards = columns.firstIndex(of: .cards) {
            if let ahead = columns.firstIndex(of: .ahead) {
                let full = min(max(ideal[cards], GoalStagesView.cardWidth), max(GoalStagesView.cardWidth, rest * GoalStagesView.cardShare))
                let besideAhead = rest - ideal[ahead]
                widths[cards] = min(rest, besideAhead >= full ? full : besideAhead >= GoalStagesView.cardWidth ? besideAhead : full)
            } else {
                // The last column: as wide as its lines, up to all the room.
                widths[cards] = min(ideal[cards], rest)
            }
            rest = max(0, rest - widths[cards])
        }
        if let ahead = columns.firstIndex(of: .ahead) { widths[ahead] = rest }
        return widths
    }

    private func heights(_ widths: [CGFloat], _ subviews: Subviews) -> [CGFloat] {
        let full = zip(subviews, widths).map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
        let row = GoalStagesView.rowHeight
        let cards = zip(subviews, full).first { $0.0[Column.self] == .cards }?.1 ?? 0
        let most = max(GoalStagesView.mostRows, (cards / row).rounded(.up) * row)
        return zip(subviews, full).map { $0[Column.self] == .cards ? $1 : min($1, most) }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width } + gap * CGFloat(max(0, subviews.count - 1))
        return CGSize(width: width, height: heights(widths(width, subviews), subviews).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        let widths = widths(bounds.width, subviews)
        for (subview, (width, height)) in zip(subviews, zip(widths, heights(widths, subviews))) {
            subview.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: ProposedViewSize(width: width, height: height))
            x += width + gap
        }
    }
}
