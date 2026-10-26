// swift-tools-version: 6.2
import PackageDescription

// Voice input for Kuvo Code on the Mac and the iPhone: what you say, heard on the device you're
// holding and written as you speak, with how loud you are for the motion that answers your voice.
// One speech core for every way the apps show it (in the composer, or the voice field).
let package = Package(
    name: "KuvoVoice",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "KuvoVoice", targets: ["KuvoVoice"]),
    ],
    targets: [
        .target(name: "KuvoVoice"),
        .testTarget(name: "KuvoVoiceTests", dependencies: ["KuvoVoice"]),
    ]
)
