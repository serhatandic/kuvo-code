#if canImport(AppKit)
import AppKit
#endif
import Testing
@testable import ClientDesign

/// A file reads as the same kind in both apps, and each kind draws a symbol that exists.
struct FileKindTests {
    @Test func aFileIsTheKindItsNameSays() {
        #expect(FileKind(name: "src/timer.js") == .code)
        #expect(FileKind(name: "README.md") == .text)
        #expect(FileKind(name: "Package.resolved") == .data)
        #expect(FileKind(name: "config/.eslintrc.json") == .data)
        #expect(FileKind(name: "Report.CSV") == .table)
        #expect(FileKind(name: "icon@2x.png") == .picture)
        #expect(FileKind(name: "spec.pdf") == .document)
        #expect(FileKind(name: "build.tar.gz") == .archive)
        #expect(FileKind(name: "Makefile") == .code)
        #expect(FileKind(name: "LICENSE") == .text)
        #expect(FileKind(name: ".gitignore") == .text)
        #expect(FileKind(name: "notes") == .other)
        #expect(FileKind(name: "data.unknownext") == .other)
    }

    #if canImport(AppKit)
    @Test func everyKindDrawsASymbolThatExists() {
        for kind in FileKind.allCases {
            #expect(NSImage(systemSymbolName: kind.symbol, accessibilityDescription: nil) != nil, "\(kind): \(kind.symbol)")
        }
    }
    #endif
}
