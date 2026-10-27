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
    ],
    // Textual draws the replies' code blocks in both apps; ClientDesign gives it their colors.
    dependencies: [
        .package(path: "../Textual"),
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
        ]),
        .testTarget(name: "ClientDesignTests", dependencies: ["ClientDesign"]),
    ]
)
