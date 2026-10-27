import ClientDesign
import Testing

/// The card over the composer, once it's full: with three bars or more, each folds to its line
/// but the one that most needs you (the newest change; none while a card asks something), and
/// opening one folds the others. With fewer, each opens and folds as you leave it.
@Suite struct BarFoldsTests {
    /// Some bars, as an app has them.
    enum ComposerBar: Hashable { case goal, review, sideQuestion, wakes }
    typealias BarFolds = ClientDesign.BarFolds<ComposerBar>

    /// Which bars show open.
    private func open(_ folds: BarFolds, _ bars: [ComposerBar], asking: Bool = false, own: [ComposerBar: Bool] = [:]) -> [ComposerBar] {
        bars.filter { !folds.isHidden($0, among: bars, asking: asking, own: own[$0] ?? false) }
    }

    @Test func fewerThanThreeEachAsYouLeftIt() {
        var folds = BarFolds()
        let bars: [ComposerBar] = [.review, .sideQuestion]
        #expect(open(folds, bars) == [.review, .sideQuestion])
        // Folded by you: as you left it, the other still open.
        var own = false
        folds.set(.review, hidden: true, among: bars, own: &own)
        #expect(own)
        #expect(open(folds, bars, own: [.review: own]) == [.sideQuestion])
    }

    @Test func aFullCardShowsTheNewestChangeAndOpeningOneFoldsTheOthers() {
        var folds = BarFolds()
        let bars: [ComposerBar] = [.goal, .review, .sideQuestion, .wakes]
        #expect(open(folds, bars).isEmpty, "nothing has changed yet: every bar on its line")

        folds.changed(.review)
        #expect(open(folds, bars) == [.review])
        // Another opened by you: the review folds.
        var own = false
        folds.set(.sideQuestion, hidden: false, among: bars, own: &own)
        #expect(open(folds, bars) == [.sideQuestion])
        // Folded by you: all on their lines.
        folds.set(.sideQuestion, hidden: true, among: bars, own: &own)
        #expect(open(folds, bars).isEmpty)
    }

    @Test func aCardAskingFoldsThemAllButOneYouOpen() {
        var folds = BarFolds()
        let bars: [ComposerBar] = [.goal, .review, .sideQuestion]
        folds.changed(.review)
        #expect(open(folds, bars, asking: true).isEmpty, "the card asking is what needs you")
        #expect(open(folds, bars) == [.review], "answered: the newest change shows again")

        // Opened by you while it asks: it stays open.
        var own = false
        folds.set(.goal, hidden: false, among: bars, own: &own)
        #expect(open(folds, bars, asking: true) == [.goal])
    }

    @Test func aBarThatWentIsntOpenAndTheNewestThatCameOpens() {
        var folds = BarFolds()
        let three: [ComposerBar] = [.goal, .review, .sideQuestion]
        folds.changed(.review)
        // The review put away, another bar came: it's the newest change.
        folds.bars(from: three, to: [.goal, .sideQuestion, .wakes], opens: { _ in true })
        #expect(open(folds, [.goal, .sideQuestion, .wakes]) == [.wakes])
        // The open one went, and what came is nothing to see yet: none open, none left over.
        folds.bars(from: [.goal, .sideQuestion, .wakes], to: [.goal, .sideQuestion, .review], opens: { $0 != .review })
        #expect(open(folds, [.goal, .sideQuestion, .review]).isEmpty)
    }

    @Test func shownAgainItOpensWhatHasSomethingToSee() {
        var folds = BarFolds()
        let bars: [ComposerBar] = [.goal, .review, .sideQuestion]
        folds.start(bars, opens: { $0 == .review })
        #expect(open(folds, bars) == [.review])
        // One open already stays.
        folds.start(bars, opens: { $0 == .sideQuestion })
        #expect(open(folds, bars) == [.review])
    }

    @Test func openedFromElsewhereStaysOpenWhileACardAsks() {
        var folds = BarFolds()
        let bars: [ComposerBar] = [.goal, .review, .sideQuestion]
        folds.opened(.sideQuestion)
        #expect(open(folds, bars, asking: true) == [.sideQuestion])
    }
}
