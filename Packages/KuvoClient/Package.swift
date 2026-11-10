// swift-tools-version: 6.2

import PackageDescription

// What Kuvo Code's clients (the Mac app, and Kuvo Code for iPhone, which builds against this
// checkout) share: see README.md for what belongs here.
let package = Package(
    name: "KuvoClient",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "ClientText", targets: ["ClientText"]),
        .library(name: "ClientAccounts", targets: ["ClientAccounts"]),
        .library(name: "ClientDesign", targets: ["ClientDesign"]),
        .library(name: "ClientNews", targets: ["ClientNews"]),
        .library(name: "ClientSessions", targets: ["ClientSessions"]),
        .library(name: "ClientChanges", targets: ["ClientChanges"]),
        .library(name: "ClientVault", targets: ["ClientVault"]),
        .library(name: "ClientSandbox", targets: ["ClientSandbox"]),
    ],
    // Textual draws the replies' code blocks in both apps; ClientDesign gives it their colors.
    dependencies: [
        .package(path: "../Textual"),
        .package(path: "../OpenCodeKit"),
        .package(url: "https://github.com/gonzalezreal/swiftui-math", from: "0.1.0"),
    ],
    targets: [
        .target(name: "ClientText"),
        .testTarget(name: "ClientTextTests", dependencies: ["ClientText"]),
        .target(name: "ClientAccounts"),
        .testTarget(name: "ClientAccountsTests", dependencies: ["ClientAccounts"]),
        .target(name: "ClientDesign", dependencies: [
            .product(name: "Textual", package: "textual"),
            .product(name: "SwiftUIMath", package: "swiftui-math"),
        ], resources: [.process("Resources/Marks.xcassets")]),
        .testTarget(name: "ClientDesignTests", dependencies: ["ClientDesign"]),
        .target(name: "ClientNews"),
        .testTarget(name: "ClientNewsTests", dependencies: ["ClientNews"]),
        .target(name: "ClientSessions", dependencies: ["ClientAccounts", .product(name: "OpenCodeKit", package: "OpenCodeKit")]),
        .testTarget(name: "ClientSessionsTests", dependencies: ["ClientSessions", .product(name: "OpenCodeKit", package: "OpenCodeKit")]),
        .target(name: "ClientChanges"),
        .testTarget(name: "ClientChangesTests", dependencies: ["ClientChanges"]),
        .target(name: "ClientVault"),
        .testTarget(name: "ClientVaultTests", dependencies: ["ClientVault"]),
        .target(name: "ClientSandbox"),
        .testTarget(name: "ClientSandboxTests", dependencies: ["ClientSandbox"]),
    ]
)
