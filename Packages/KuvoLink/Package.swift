// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "KuvoLink",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "KuvoLink", targets: ["KuvoLink"]),
    ],
    targets: [
        // The machines' side of the link, in JavaScript, which the Mac app puts on each machine, and
        // the words a box makes its bots with, which go beside it.
        .target(name: "KuvoLink", resources: [.copy("Resources/kuvo-link.js"), .copy("Resources/bot-words.json")]),
        .testTarget(name: "KuvoLinkTests", dependencies: ["KuvoLink"]),
    ]
)
