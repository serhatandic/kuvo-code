import ClientDesign
import ClientSessions
import SwiftUI

/// A goal's steps as a list (`GoalTimeline.stages`), read left to right like the timeline: what's
/// done, small and faint; the step under way as a card with its mark, name, its line on what's in
/// it, how far along it is and about how long it has left, two under way one card over the other; then what's ahead, the
/// next a little stronger, and steps that start together side by side on one row. Before it
/// starts, the first step waits in a grey card. Narrow, the same top to bottom, with what's done
/// folded into one faint line. Names and lines are whole wherever the pane has room for them; many
/// rows scroll, cut between rows.
struct GoalStagesView: View {
    let plan: GoalPlan
    let timeline: GoalTimeline
    /// You have the goal paused: what's under way shows paused.
    var isPaused = false
    @State private var width: CGFloat = 0
    @State private var height: CGFloat = 0
    /// Where each row and card sits, top to bottom, so the pane ends between them.
    @State private var pieces: [Piece.Span] = []
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme

    static let rowHeight: CGFloat = 26
    /// The most the done column takes; its names are cut at their end past it.
    static let doneWidth: CGFloat = 220
    static let gap: CGFloat = 18
    /// The least a card takes beside steps side by side (its line cut at its end below its own
    /// width), and the most of the room after what's done.
    static let cardWidth: CGFloat = 200
    static let cardShare: CGFloat = 0.62
    static let aheadSpacing: CGFloat = 14
    /// The most it takes before it scrolls: about ten rows, and the cards whole beside or among
    /// them.
    static let mostHeight: CGFloat = 10 * 28

    private var now: Date { timeline.now }

    var body: some View {
        let stages = timeline.stages(paused: isPaused)
        ScrollView(.vertical) {
            Group {
                if isNarrow(stages) { narrow(stages) } else { wide(stages) }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .coordinateSpace(.named(Piece.space))
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { height = $0 }
            .onPreferenceChange(Piece.self) { pieces = $0 }
        }
        .scrollDisabled(height <= shownHeight(stages))
        .scrollIndicators(height > shownHeight(stages) ? .automatic : .never)
        // Short, so the pane's end, between rows, fades only their room.
        .fadingScrollEdges(8)
        .frame(height: shownHeight(stages))
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
        .accessibilityElement(children: .contain)
    }

    /// All of it, or up to the last row or card that ends within about ten rows and has none cut
    /// beside it: the pane never ends inside a row.
    private func shownHeight(_ stages: GoalStages) -> CGFloat {
        let cards = pieces.filter(\.isCard).map { $0.range.upperBound - $0.range.lowerBound }
        // Stacked in the narrow layout, the cards come on top of the rows; beside them in the
        // wide one, the most is at least as tall as they are.
        let most = isNarrow(stages)
            ? Self.mostHeight + cards.reduce(0, +)
            : max(Self.mostHeight, cards.reduce(0, +) + 8 * CGFloat(max(0, cards.count - 1)))
        guard height > most else { return height }
        let cuts = pieces.map(\.range.upperBound).filter { cut in
            cut <= most && !pieces.contains { $0.range.lowerBound < cut - 0.5 && $0.range.upperBound > cut + 0.5 }
        }
        return cuts.max() ?? most
    }

    /// Too narrow for the columns side by side: what's done, a card at its least and a step ahead
    /// each need room for a name.
    private func isNarrow(_ stages: GoalStages) -> Bool {
        width > 0 && width < (stages.done.isEmpty ? 400 : 640)
    }

    // MARK: Wide: done, now, ahead

    private func wide(_ stages: GoalStages) -> some View {
        StageColumns(gap: Self.gap) {
            if !stages.done.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(stages.done) { lane in doneRow(lane, number: stages.number(lane.id)) }
                }
                .layoutValue(key: StageColumns.Column.self, value: .done)
            }
            if !stages.now.isEmpty {
                cards(stages).layoutValue(key: StageColumns.Column.self, value: .cards)
            }
            if !stages.ahead.isEmpty { ahead(stages) }
        }
    }

    // MARK: Narrow: done folded, now, ahead

    private func narrow(_ stages: GoalStages) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Once it's over there's no card to come before: what's done shows in full.
            if stages.isOver {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(stages.done) { lane in doneRow(lane, number: stages.number(lane.id)) }
                }
            } else if !stages.done.isEmpty {
                doneFold(stages.done)
            }
            if !stages.now.isEmpty { cards(stages) }
            if !stages.ahead.isEmpty { ahead(stages) }
        }
    }

    /// The steps done as one faint line, the latest nearest the card: as many names whole as fit,
    /// the ones before them a count ("+2 · Photo scan engine · RevenueCat paywall"); where even
    /// the latest has no room whole, it's cut at its end.
    private func doneFold(_ done: [GoalTimeline.Lane]) -> some View {
        let names = done.map(\.step.text)
        let line = { (folded: Int) in ((folded == 0 ? [] : ["+\(folded)"]) + names.dropFirst(folded)).joined(separator: " · ") }
        return ViewThatFits(in: .horizontal) {
            ForEach(0..<names.count, id: \.self) { folded in
                HStack(spacing: 8) {
                    GoalStepMark(.done).frame(width: 14)
                    Text(line(folded)).lineLimit(1).fixedSize()
                }
            }
            HStack(spacing: 8) {
                GoalStepMark(.done).frame(width: 14)
                Text(line(names.count - 1)).lineLimit(1)
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.tertiary)
        .frame(height: 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .reportsPiece()
        .help(names.joined(separator: "\n"))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(done.count == 1 ? "1 step done" : "\(done.count) steps done")
        .accessibilityValue(names.joined(separator: ", "))
    }

    // MARK: The cards

    private func cards(_ stages: GoalStages) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(stages.now) { card in self.card(card, number: stages.number(card.id)) }
        }
    }

    private func card(_ card: GoalStages.Card, number: Int) -> some View {
        let step = card.step
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("\(number)")
                    .font(.system(size: 10.5, weight: .semibold).monospacedDigit())
                    .foregroundStyle(card.look == .doing || card.look == .waiting ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
                    .frame(width: 18, height: 18)
                    .background(Circle().fill(numberFill(card.look)))
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
        .reportsPiece(isCard: true)
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
        case .waiting: .orange
        case .paused, .ready: Color.primary.opacity(scheme == .dark ? 0.14 : 0.09)
        }
    }

    // MARK: The rows

    /// Steps that start together side by side, each name whole, in as few rows as they fit (three
    /// to a row at most), each group on its own; more of them wrap onto the rows under, still side
    /// by side. Where even one to a row has no room, names are cut at their end.
    private func ahead(_ stages: GoalStages) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(stages.ahead.enumerated()), id: \.element.first?.id) { index, group in
                ViewThatFits(in: .horizontal) {
                    ForEach([3, 2, 1].filter { $0 == 1 || $0 <= group.count }, id: \.self) { most in
                        aheadGroup(group, stages, isNext: index == 0, most: most, whole: true)
                    }
                    aheadGroup(group, stages, isNext: index == 0, most: 1, whole: false)
                }
            }
        }
    }

    private func aheadGroup(_ group: [GoalTimeline.Lane], _ stages: GoalStages, isNext: Bool, most: Int, whole: Bool) -> some View {
        let rows = stride(from: 0, to: group.count, by: most).map { Array(group[$0..<min($0 + most, group.count)]) }
        return Grid(alignment: .leading, horizontalSpacing: Self.aheadSpacing, verticalSpacing: 0) {
            ForEach(rows, id: \.first?.id) { row in
                GridRow {
                    ForEach(row) { lane in
                        aheadRow(lane, number: stages.number(lane.id), isNext: isNext && !stages.isOver, isOver: stages.isOver)
                            .fixedSize(horizontal: whole, vertical: false)
                    }
                }
            }
        }
    }

    private func doneRow(_ lane: GoalTimeline.Lane, number: Int) -> some View {
        row(lane, number: number, mark: lane.step.state == .skipped ? .skipped : .done, spacing: 6)
            .font(.system(size: 12))
            .foregroundStyle(.tertiary)
    }

    /// A step ahead: the next a little stronger than the rest; once the goal is over, what it left.
    private func aheadRow(_ lane: GoalTimeline.Lane, number: Int, isNext: Bool, isOver: Bool) -> some View {
        row(lane, number: number, mark: isOver ? .skipped : .todo, spacing: 8)
            .font(.system(size: 12.5, weight: isNext ? .medium : .regular))
            .foregroundStyle(isOver ? AnyShapeStyle(.tertiary) : isNext ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
    }

    private func row(_ lane: GoalTimeline.Lane, number: Int, mark: GoalTrack.State, spacing: CGFloat) -> some View {
        let step = lane.step
        return HStack(spacing: spacing) {
            GoalStepMark(mark).frame(width: 14)
            // As wide as the plan's longest number, so the names line up.
            Text("\(number)")
                .monospacedDigit()
                .frame(width: plan.steps.count < 10 ? 11 : plan.steps.count < 100 ? 18 : 25, alignment: .leading)
            if GoalPlanWords.mark(of: step) != nil { StepServiceMark(step: step) }
            Text(step.text)
                .lineLimit(1)
        }
        .frame(height: Self.rowHeight)
        .reportsPiece()
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
/// `GoalStagesView.doneWidth`), what's ahead as wide as its steps side by side with their names
/// whole (that's what says which run together), and the cards as wide as their names and lines
/// in what's left: they give way first, down to `cardWidth`. Where even that leaves too little for
/// the steps side by side, those stack and the cards take up to `cardShare` of the rest.
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

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? subviews.reduce(0) { $0 + $1.sizeThatFits(.unspecified).width } + gap * CGFloat(max(0, subviews.count - 1))
        let heights = zip(subviews, widths(width, subviews)).map { $0.sizeThatFits(ProposedViewSize(width: $1, height: nil)).height }
        return CGSize(width: width, height: heights.max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        for (subview, width) in zip(subviews, widths(bounds.width, subviews)) {
            subview.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: ProposedViewSize(width: width, height: nil))
            x += width + gap
        }
    }
}

/// Where a row or card of the list sits, top to bottom.
private struct Piece: PreferenceKey {
    struct Span: Equatable {
        let range: ClosedRange<CGFloat>
        let isCard: Bool
    }

    static let space = "goal-stages"
    static let defaultValue: [Span] = []
    static func reduce(value: inout [Span], nextValue: () -> [Span]) { value += nextValue() }
}

private extension View {
    func reportsPiece(isCard: Bool = false) -> some View {
        background {
            GeometryReader { proxy in
                let frame = proxy.frame(in: .named(Piece.space))
                Color.clear.preference(key: Piece.self, value: [Piece.Span(range: frame.minY...max(frame.minY, frame.maxY), isCard: isCard)])
            }
        }
    }
}
