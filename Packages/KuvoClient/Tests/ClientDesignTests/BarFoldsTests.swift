import ClientDesign
import Testing

/// The card over the composer: while a card asks something, every bar folds to its line but one
/// you open. Otherwise, once it's full (three bars or more), each folds to its line but the newest
/// change, and opening one folds the others; with fewer, each opens and folds as you leave it.
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

    /// However few bars there are: a goal folds to its line while its bot asks, and something new
    /// in it doesn't open it over the question; opened by you, it stays open; answered, each is as
    /// you left it.
    @Test func aCardAskingFoldsEvenOneBarButOneYouOpen() {
        var folds = BarFolds()
        let bars: [ComposerBar] = [.goal, .review]
        #expect(open(folds, bars, asking: true).isEmpty, "the question gets the room")
        folds.changed(.goal)
        #expect(open(folds, bars, asking: true).isEmpty, "news in it doesn't open it over the question")
        #expect(open(folds, bars) == [.goal, .review], "answered: as you left them")

        var own = false
        folds.set(.goal, hidden: false, among: bars, own: &own)
        #expect(open(folds, bars, asking: true, own: [.goal: own]) == [.goal], "opened by you, it stays open")
        folds.set(.goal, hidden: true, among: bars, own: &own)
        #expect(open(folds, bars, own: [.goal: own]) == [.review], "folded by you while it asked: it stays folded")

        // A goal you'd opened before the question came stays open over it, once.
        folds.askingEnded()
        folds.set(.goal, hidden: false, among: bars, own: &own)
        #expect(open(folds, bars, asking: true, own: [.goal: own]) == [.goal])
        folds.askingEnded()
        #expect(open(folds, bars, asking: true, own: [.goal: own]).isEmpty, "the next question folds it")
    }

    /// A bar you opened while a card asks stays open when something new comes in another, or another
    /// bar comes.
    @Test func whatYouOpenedOverAQuestionStaysOpenWhenAnotherBarHasNews() {
        var folds = BarFolds()
        let bars: [ComposerBar] = [.goal, .review, .sideQuestion]
        var own = false
        folds.set(.goal, hidden: false, among: bars, own: &own)
        folds.news(from: [.review: false], to: [.review: true], asking: true)
        #expect(open(folds, bars, asking: true) == [.goal])
        folds.bars(from: bars, to: bars + [.wakes], asking: true, opens: { _ in true })
        #expect(open(folds, bars + [.wakes], asking: true) == [.goal])
    }

    /// The card going from full while it asks: each keeps what it showed past the question, so
    /// answering brings back the one that was open.
    @Test func aCardNoLongerFullWhileItAsksKeepsWhatItShowedPastTheQuestion() {
        var folds = BarFolds()
        let full: [ComposerBar] = [.goal, .review, .wakes]
        folds.changed(.review)
        var own: [ComposerBar: Bool] = [:]
        folds.update(from: full, to: [.review, .wakes], asking: true, own: { own[$0] ?? false }, keep: { own[$0] = $1 },
                     news: { _ in false }, opens: { _ in true })
        #expect(open(folds, [.review, .wakes], asking: true, own: own).isEmpty)
        #expect(open(folds, [.review, .wakes], own: own) == [.review])
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

    /// A bar going from a full card: the two left keep what the card showed (the open one open,
    /// the folded one folded), rather than both springing open.
    @Test func aCardNoLongerFullKeepsWhatItShowed() {
        var folds = BarFolds()
        let full: [ComposerBar] = [.goal, .review, .wakes]
        folds.changed(.review)
        var own: [ComposerBar: Bool] = [:]
        folds.update(from: full, to: [.review, .wakes], asking: false, own: { own[$0] ?? false }, keep: { own[$0] = $1 },
                     news: { _ in false }, opens: { _ in true })
        #expect(own == [.review: false, .wakes: true])
        #expect(open(folds, [.review, .wakes], own: own) == [.review])
    }

    /// Shown again, the bar with something to see opens; a bar that came opens where it's worth
    /// seeing; something new in a bar opens it.
    @Test func whatHasSomethingToSeeOpens() {
        let bars: [ComposerBar] = [.goal, .review, .sideQuestion]
        var shown = BarFolds()
        shown.update(from: bars, to: bars, asking: false, own: { _ in false }, keep: { _, _ in }, news: { $0 == .goal }, opens: { _ in true })
        #expect(open(shown, bars) == [.goal])

        var came = BarFolds()
        came.update(from: [.goal, .review], to: bars + [.wakes], asking: false, own: { _ in false }, keep: { _, _ in },
                    news: { _ in false }, opens: { $0 != .wakes })
        #expect(open(came, bars + [.wakes]) == [.sideQuestion], "the newest that came and is worth seeing")

        var news = BarFolds()
        news.news(from: [.review: false, .goal: true], to: [.review: true, .goal: true])
        #expect(open(news, bars) == [.review])
    }
}

// The bars tucked into one line: they stay tucked as you left them, whatever comes; what came or
// changed meanwhile is marked; bringing them back clears the marks; once none are left, the next
// ones show.
@Test func tuckedBarsStayTuckedMarkingWhatChanged() {
    var tuck = BarTuck<String>()
    #expect(!tuck.isOn(among: ["goal", "wakes"]))
    tuck.hide()
    #expect(tuck.isOn(among: ["goal", "wakes"]))
    // A side question asked, the goal met: still tucked, both marked.
    tuck.bars(from: ["goal", "wakes"], to: ["goal", "sideQuestion", "wakes"])
    tuck.changed("goal")
    #expect(tuck.isOn(among: ["goal", "sideQuestion", "wakes"]))
    #expect(tuck.marked == ["sideQuestion", "goal"])
    // Brought back: shown, nothing marked; tucked again, nothing marked yet.
    tuck.show()
    #expect(!tuck.isOn(among: ["goal", "sideQuestion", "wakes"]))
    tuck.hide()
    #expect(tuck.marked.isEmpty)
    // A change while shown isn't marked for later.
    tuck.show()
    tuck.changed("wakes")
    tuck.hide()
    #expect(tuck.marked.isEmpty)
    // All gone: the next bar shows, rather than coming tucked.
    tuck.bars(from: ["goal", "sideQuestion", "wakes"], to: [])
    tuck.bars(from: [], to: ["review"])
    #expect(!tuck.isOn(among: ["review"]))
}

@Test func writingTucksAndFinishingRestoresTheCard() {
    var tuck = BarTuck<String>()
    let bars = ["work", "wakes"]
    tuck.writing(focused: true, hasText: false)
    #expect(tuck.isOn(among: bars))
    tuck.writing(focused: false, hasText: true)
    #expect(tuck.isOn(among: bars), "a draft keeps it tucked after leaving the field")
    tuck.writing(focused: false, hasText: false)
    #expect(!tuck.isOn(among: bars))
    tuck.hide()
    tuck.writing(focused: true, hasText: true)
    tuck.sent()
    #expect(tuck.isOn(among: bars), "a manually tucked card stays tucked")
}

@Test func openingWhileWritingLastsUntilDone() {
    var tuck = BarTuck<String>()
    tuck.writing(focused: true, hasText: false)
    tuck.show()
    tuck.writing(focused: true, hasText: true)
    tuck.changed("work")
    #expect(!tuck.isOn(among: ["work"]))
    tuck.writing(focused: false, hasText: false)
    tuck.writing(focused: true, hasText: false)
    #expect(tuck.isOn(among: ["work"]))
}

@Test func sendingRestoresEvenWhenTheComposerKeepsFocus() {
    var tuck = BarTuck<String>()
    tuck.writing(focused: true, hasText: true)
    tuck.sent()
    tuck.writing(focused: true, hasText: false)
    #expect(!tuck.isOn(among: ["work"]))
    tuck.writing(focused: true, hasText: true)
    #expect(tuck.isOn(among: ["work"]))
}

@Test func typingDoesNotChangeIndividualBarFolds() {
    var folds = BarFoldsTests.BarFolds()
    let bars: [BarFoldsTests.ComposerBar] = [.goal, .wakes]
    var own = false
    folds.set(.goal, hidden: true, among: bars, own: &own)
    let left = folds
    var tuck = BarTuck<BarFoldsTests.ComposerBar>()
    tuck.writing(focused: true, hasText: true)
    tuck.sent()
    #expect(folds == left)
    #expect(folds.isHidden(.goal, among: bars, asking: false, own: own))
    #expect(!folds.isHidden(.wakes, among: bars, asking: false, own: false))
    #expect(!tuck.isOn(among: bars))
}

@Test func newsWhileWritingIsMarkedAndOpenWhenTheCardComesBack() {
    var folds = BarFoldsTests.BarFolds()
    let bars: [BarFoldsTests.ComposerBar] = [.goal, .review, .wakes]
    folds.changed(.goal)
    var tuck = BarTuck<BarFoldsTests.ComposerBar>()
    tuck.writing(focused: false, hasText: true)
    for bar in folds.news(from: [.review: false], to: [.review: true]) { tuck.changed(bar) }
    #expect(tuck.marked == [.review])
    tuck.sent()
    tuck.writing(focused: false, hasText: false)
    #expect(!tuck.isOn(among: bars))
    #expect(tuck.marked.isEmpty)
    #expect(!folds.isHidden(.review, among: bars, asking: false, own: false))
    #expect(folds.isHidden(.goal, among: bars, asking: false, own: false))
}

@Test func barsArrivingWhileWritingTuckWithoutAnExplicitOpening() {
    var tuck = BarTuck<String>()
    tuck.writing(focused: true, hasText: false)
    tuck.bars(from: ["work"], to: [])
    tuck.bars(from: [], to: ["wakes"])
    #expect(tuck.isOn(among: ["wakes"]))
}
