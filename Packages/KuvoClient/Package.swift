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
    ],
    targets: [
        .target(name: "ClientText"),
        .testTarget(name: "ClientTextTests", dependencies: ["ClientText"]),
        .target(name: "ClientAccounts"),
        .testTarget(name: "ClientAccountsTests", dependencies: ["ClientAccounts"]),
    ]
)
