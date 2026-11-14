import ClientDesign
import CoreImage.CIFilterBuiltins
import KuvoLink
import SwiftUI

/// Phone: pairing Kuvo Code for iPhone with this Mac (a QR code to scan), and the phones you've
/// paired. Shown while the phone link is switched on. (The relay they meet through isn't yours to
/// change here; `PhoneLink.relay` says how a test points elsewhere.)
struct PhoneSettings: View {
    @Environment(AppModel.self) private var app
    @State private var removing: PhoneLink.Phone?
    /// Making a pairing link (this Mac's box makes it).
    @State private var isPairing = false

    private var link: PhoneLink { app.phoneLink }

    var body: some View {
        ScrollingSettingsForm {
            Section {
                // A code can't work once the background service has given up: it says so instead.
                if let pairing = link.pairing, app.box.failure == nil {
                    VStack(spacing: 12) {
                        QRCode(text: pairing.url.absoluteString)
                            .frame(width: 200, height: 200)
                        Text("Scan this with Kuvo Code on your iPhone. It works once, for ten minutes.")
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                        // The code reaches this Mac only through the relay: until it's connected,
                        // scanning it would fail, so it says so.
                        if case .failed = link.status {
                            HStack(spacing: 6) {
                                Image(systemName: "exclamationmark.triangle")
                                Text(waitingText)
                            }
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityElement(children: .combine)
                        } else if link.status != .connected {
                            ConnectingLink(waitingText)
                                .font(.callout)
                        }
                        Button("Done") { link.endPairing() }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                } else {
                    // This Mac's box holds the link: stopped for good, it says why, and starts again.
                    if let failure = app.box.failure {
                        FailureLabel(title: "Your phones can’t reach this Mac", detail: failure, retrying: "this Mac’s link",
                                     retryLabel: "Start Kuvo Code’s background service again") {
                            Task { await app.box.startAgain() }
                        }
                    }
                    HStack(spacing: 8) {
                        Button("Pair a Phone…") {
                            isPairing = true
                            Task {
                                await link.beginPairing()
                                isPairing = false
                            }
                        }
                        .disabled(isPairing || app.box.failure != nil)
                        if isPairing { Spinner(size: 16) }
                    }
                    if let problem = link.pairingProblem {
                        Text(problem)
                            .font(.callout)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
            } header: {
                Text("Pair")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    // A pairing code says how the link stands under it.
                    if app.box.failure == nil, link.pairing == nil { Text(statusText) }
                    Text("Your phones reach this Mac through Kuvo Code’s relay. Everything between them is encrypted end to end, so the relay only passes along what it can’t read.")
                }
                .foregroundStyle(.secondary)
            }

            Section {
                // A phone removed here that can still reach this Mac, for now.
                if let problem = link.removalProblem {
                    Label {
                        Text(problem)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                    }
                    .font(.callout)
                    .foregroundStyle(.secondary)
                }
                if link.phones.isEmpty {
                    Text("None yet.").foregroundStyle(.secondary)
                }
                ForEach(link.phones) { phone in
                    HStack(spacing: 12) {
                        Image(systemName: "iphone")
                            .font(.system(size: 18))
                            .foregroundStyle(.secondary)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(phone.name.isEmpty ? "iPhone" : phone.name)
                            Text("Paired \(phone.added.formatted(.relative(presentation: .named)))")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        Button("Remove…") { removing = phone }
                    }
                }
            } header: {
                Text("Phones")
            } footer: {
                Text("A phone you remove can’t reach this Mac again until you pair it again.")
                    .foregroundStyle(.secondary)
            }
        }
        .onDisappear { link.endPairing() }
        .onChange(of: app.box.failure) { _, failure in
            if failure != nil { link.endPairing() }
        }
        .confirmationDialog("Remove \(removing?.name ?? "this phone")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { phone in
            Button("Remove", role: .destructive) { link.remove(phone) }
        } message: { _ in
            Text("It won’t reach this Mac or your machines any more. A machine that’s off drops it when it’s next connected.")
        }
    }

    /// Under a pairing code while this Mac isn't on the relay yet.
    private var waitingText: String {
        if case .failed(let message) = link.status { return "Not connected yet, so scanning it won’t work. \(message)" }
        return "Connecting to the relay. Scan it once this Mac is connected."
    }

    private var statusText: String {
        switch link.status {
        // Nothing needs the relay yet: a pairing connects it.
        case .off: link.phones.isEmpty ? "Pair a phone to reach this Mac from it." : "Connects to the relay when a phone needs it."
        case .connecting: "Connecting to the relay…"
        case .connected: "Ready for your phones."
        case .failed(let message): message
        }
    }
}

/// A plain QR code, sharp at any size.
private struct QRCode: View {
    let text: String

    var body: some View {
        if let image = Self.image(text) {
            Image(nsImage: image)
                .interpolation(.none)
                .resizable()
                .padding(10)
                .background(.white, in: .rect(cornerRadius: 10))
                .accessibilityLabel("Pairing code")
        }
    }

    private static func image(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let representation = NSCIImageRep(ciImage: output)
        let image = NSImage(size: representation.size)
        image.addRepresentation(representation)
        return image
    }
}
