import Foundation
import Testing
import ClientText

/// Pictures named in a message: "[Image 1]" for its first picture, found as written, and taken out
/// with the later ones a number down when a picture goes.
@Suite struct ImageReferencesTests {
    @Test func namedAndFound() {
        #expect(ImageReferences.name(2) == "[Image 2]")
        let text = "Compare [Image 1] with [Image 2], not [Image 0] or [image 3]."
        #expect(ImageReferences.find(in: text).map(\.number) == [1, 2])
    }

    @Test func aPictureTakenOutTakesItsNameAndTheLaterOnesComeDown() {
        #expect(ImageReferences.removing(1, from: "Compare [Image 1] with [Image 2] please") == "Compare with [Image 1] please")
        #expect(ImageReferences.removing(2, from: "Compare [Image 1] with [Image 2]") == "Compare [Image 1] with")
        #expect(ImageReferences.removing(1, from: "[Image 1] and [Image 1] again") == "and again")
    }
}

/// Web addresses in what you write: those written as one, not words that look like a domain.
@Suite struct WebLinksTests {
    // The "www." cases guard systems whose link detector picks http for them (before macOS 27).
    @Test(arguments: [
        ("See https://example.com/a?b=1 now", ["https://example.com/a?b=1"]),
        ("and http://x.org", ["http://x.org"]),
        ("www.apple.com is it", ["https://www.apple.com"]),
        ("see www.example.org/a?b=1.", ["https://www.example.org/a?b=1"]),
        ("main.swift and README.md", []),
        ("mailto:me@example.com", []),
    ])
    func addresses(text: String, found: [String]) {
        #expect(WebLinks.find(in: text).map(\.url.absoluteString) == found)
    }
}

/// The site a link is on, for its icon: its main domain, never this computer's or its network's.
@Suite struct SiteAddressesTests {
    @Test func aLinksSiteIsItsMainDomain() {
        #expect(SiteAddresses.site(of: URL(string: "https://docs.github.com/en")!) == "github.com")
        #expect(SiteAddresses.site(of: URL(string: "https://news.bbc.co.uk/x")!) == "bbc.co.uk")
        #expect(SiteAddresses.site(of: URL(string: "https://Example.COM./")!) == "example.com")
    }

    @Test(arguments: ["http://localhost:3000/", "http://127.0.0.1:8080/", "http://192.168.1.1/", "http://[::1]:5000/",
                      "http://printer.local/", "http://intranet/", "http://dev.test/", "file:///tmp/a.html"])
    func localAddressesArentAsked(link: String) {
        #expect(SiteAddresses.site(of: URL(string: link)!) == nil)
    }

    @Test func whatAPageDeclares() {
        let html = """
        <link rel="apple-touch-icon" sizes="180x180" href="/touch.png">
        <link rel='icon' type='image/png' sizes='32x32' href='https://cdn.example.com/32.png'>
        <link rel="mask-icon" href="/pin.svg" color="#000">
        <link href=icon-16.png rel=icon sizes=16x16>
        <link rel="icon" href="/logo.svg">
        """
        let page = URL(string: "https://site.example.com/blog/")!
        #expect(SiteAddresses.declaredIcons(in: html, page: page).map(\.absoluteString)
            == ["https://site.example.com/logo.svg", "https://cdn.example.com/32.png", "https://site.example.com/blog/icon-16.png", "https://site.example.com/touch.png"])
        // Where SVG isn't drawn, it isn't offered.
        #expect(SiteAddresses.declaredIcons(in: html, page: page, drawsSVG: false).first?.absoluteString == "https://cdn.example.com/32.png")
    }

    /// A page's sizes are its author's words: any number at all, read without trouble, a size
    /// that can't be one counting as none given.
    @Test func anyNumberAPageGivesForASizeIsReadSafely() {
        let html = """
        <link rel="icon" sizes="-9223372036854775808x1" href="/least.png">
        <link rel="icon" sizes="9223372036854775807x1" href="/most.png">
        <link rel="icon" sizes="64x64" href="/64.png">
        """
        let page = URL(string: "https://site.example.com/")!
        #expect(SiteAddresses.declaredIcons(in: html, page: page).map(\.absoluteString)
            == ["https://site.example.com/64.png", "https://site.example.com/least.png", "https://site.example.com/most.png"])
    }
}

/// A message field keeps every key while the app hands it its draft late: as it was a key or two
/// ago, from before the first key, or the same older words again. A real change from the app (the
/// message sent) still applies. A field as both apps run it: it tells its draft each key, and puts
/// what it's handed in place unless that's an echo.
@Suite struct TypedEchoesTests {
    struct Field {
        var text = ""
        var echoes = TypedEchoes()
        mutating func type(_ new: String) { text = new; echoes.told(new) }
        mutating func handed(_ draft: String) { if !echoes.isEcho(draft) { text = draft } }
    }

    @Test func lateDraftsKeepTheKeysSince() {
        var field = Field()
        for text in ["F", "Fr", "Fri"] { field.type(text) }
        field.handed("Fr")
        #expect(field.text == "Fri")
        field.type("Frid")
        field.handed("Fri")
        field.handed("Frid")
        #expect(field.text == "Frid")
        field.handed("")
        #expect(field.text == "", "the message sent")
    }

    @Test func aTypoFixedWhileBusyStaysFixed() {
        var field = Field()
        for text in ["a", "ab", "a"] { field.type(text) }
        field.handed("a")
        field.handed("ab")
        field.type("ac")
        field.handed("a")
        #expect(field.text == "ac", "the deleted letter stays deleted and the next key stays")
    }

    @Test func wordsFromBeforeTheFirstKeyAndRepeatsAreKept() {
        var field = Field()
        field.handed("")
        field.type("Y")
        field.handed("")
        #expect(field.text == "Y")
        field.type("Ye")
        field.type("Yes")
        field.handed("Y")
        field.handed("Y")
        #expect(field.text == "Yes")
        field.handed("Yes")
        field.handed("")
        #expect(field.text == "", "the message sent")
    }

    /// "y" and Return before the app has caught up: the message sent empties the field, though the
    /// field was empty before the key too. ↑ brings back words typed a moment ago: they show.
    @Test func wordsTheAppPutsInOnAKeyApply() {
        var field = Field()
        field.handed("")
        field.type("y")
        field.handed("")
        field.echoes.changing(to: "")
        field.handed("")
        #expect(field.text == "", "the message sent")
        field.type("y")
        field.type("")
        field.echoes.changing(to: "y")
        field.handed("y")
        #expect(field.text == "y", "the message brought back")
    }

    @Test func aDraftBroughtBackApplies() {
        var field = Field()
        field.type("h")
        field.handed("h")
        field.handed("Earlier words")
        #expect(field.text == "Earlier words")
        field.type("Earlier words!")
        field.handed("Earlier words")
        #expect(field.text == "Earlier words!", "words brought back become where the next typing starts")
    }
}

/// A file named for the box as its disk has it: "ş" stays one letter, as a Linux machine's disk
/// spells it, not "s" and a mark, which is another name there.
@Suite struct FileAddressesTests {
    @Test func aNameWithLettersBeyondASCIIKeepsThemAsWritten() {
        let uri = FileAddresses.uri("/home/alex/notes/şeker.md")
        #expect(uri == "file:///home/alex/notes/%C5%9Feker.md")
        #expect(!uri.contains("%CC%A7"), "ş should not come apart into s and a combining mark")
    }

    /// The routes the box reads back to each file (its own test reads the same vectors).
    @Test func theRoutesTheBoxReads() throws {
        struct Vectors: Decodable {
            struct Address: Decodable { var name: String; var encoded: String }
            var addresses: [Address]
        }
        let file = URL(filePath: #filePath).deletingLastPathComponent()
            .appending(path: "../../../KuvoLink/Vectors/file-addresses/addresses.json").standardized
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: file))
        #expect(!vectors.addresses.isEmpty)
        for address in vectors.addresses {
            #expect(FileAddresses.route("/folder/" + address.name) == "kuvo/file?uri=file:///folder/" + address.encoded, "\(address.name)")
        }
    }

    @Test func spacesAndQueryCharactersStayInsideTheRoute() {
        #expect(FileAddresses.uri("/tmp/a b#1.txt") == "file:///tmp/a%20b%231.txt")
        // "&" is a path's own letter, but would end the query's value.
        #expect(FileAddresses.route("/tmp/a&b.txt", max: 100) == "kuvo/file?uri=file:///tmp/a%26b.txt&max=100")
    }
}

/// The words in a message field changed by the app: the caret goes where you'd go on typing.
@Suite struct TextChangeTests {
    @Test func aDraftBroughtBackIntoAnEmptyFieldPutsTheCaretAfterIt() {
        let change = TextChange(from: "", to: "Check the long break")
        #expect(change.caret(movedFrom: 0) == 20)
    }

    @Test func aNamePickedFromTheListPutsTheCaretAfterItsSpace() {
        let change = TextChange(from: "Ask &Fi", to: "Ask &Finance ")
        #expect(change.range == NSRange(location: 7, length: 0))
        #expect(change.replacement == "nance ")
        #expect(change.caret(movedFrom: 7) == 13)
    }

    @Test func wordsPutBackInFrontKeepTheCaretWhereYouWereTyping() {
        // Edit, Undo, a message that didn't go: it comes back ahead of what's written.
        let change = TextChange(from: "and the docs", to: "Fix the build\n\nand the docs")
        #expect(change.caret(movedFrom: 12) == 27)
        #expect(change.caret(movedFrom: 4) == 19)
    }

    @Test func aCaretBeforeTheChangeStaysAndOneInItGoesAfterWhatCameIn() {
        let change = TextChange(from: "one [Image 1] two", to: "one  two")
        #expect(change.caret(movedFrom: 2) == 2)
        #expect(change.caret(movedFrom: 8) == 4)
        #expect(change.caret(movedFrom: 15) == 6)
    }
}


/// The words a search found, in bold in its result: wherever they are, as the box matched them.
@Suite struct SearchMatchesTests {
    private func marked(_ query: String, _ text: String) -> [String] {
        SearchMatches.ranges(of: query, in: text).map { String(text[$0]) }
    }

    @Test func everyPlaceTheWordsAreInAnyCaseOrAccents() {
        #expect(marked("cafe", "…the Café opens; the cafe closes…") == ["Café", "cafe"])
        #expect(marked("RETRY", "a retry, then retrying") == ["retry", "retry"])
    }

    @Test func aSnippetBoldsOnlyWhatWasFound() {
        let shown = SearchMatches.snippet("…the Café opens; the cafe closes…", found: "cafe")
        let bold = shown.runs.filter { $0.inlinePresentationIntent == .stronglyEmphasized }.map { String(shown[$0.range].characters) }
        #expect(bold == ["Café", "cafe"])
        #expect(String(shown.characters) == "…the Café opens; the cafe closes…")
    }

    @Test func thePhraseAsTheBoxSearchedIt() {
        #expect(marked("  deploy   the   site ", "…we deploy the site tonight") == ["deploy the site"])
        #expect(marked("**fix** it", "…then fix it now") == ["fix it"])
        #expect(marked("site deploy", "deploy the site").isEmpty)
    }

    @Test func nothingToMarkForEmptyWords() {
        #expect(marked("  ", "anything").isEmpty)
        #expect(marked("**", "a ** b").isEmpty)
    }
}
