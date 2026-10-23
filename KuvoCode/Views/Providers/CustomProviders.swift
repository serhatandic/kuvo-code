import OpenCodeKit
import SwiftUI

/// Providers you add yourself: a company proxy, a self-hosted server, any service that speaks
/// OpenAI's or Anthropic's API. Each is set up in the engine's settings file; its key is added
/// like any other provider's, so it never goes in the file.
struct CustomProvidersSection: View {
    /// Opens a provider's sign-in, to add its key.
    let connect: (Integration) -> Void
    /// Opens a provider's settings in the page's place; nil for a new one.
    let edit: (String?) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    @Environment(\.colorScheme) private var scheme

    static let path = ["providers"]

    private var ids: [String] { (app.config(for: box).value(at: Self.path)?.object?.keys).map { $0.sorted() } ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Your Own").font(.headline)
                Spacer()
                Button("Add Provider…") { edit(nil) }
                    .buttonStyle(.glass)
            }
            if ids.isEmpty {
                Text("For a company proxy, a self-hosted server or any service with an OpenAI- or Anthropic-compatible API.")
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(ids, id: \.self) { id in
                        let integration = catalog.providers.first { $0.id == id }
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(app.config(for: box).value(at: Self.path + [id, "name"])?.string ?? id)
                                Text(app.config(for: box).value(at: Self.path + [id, "settings", "baseURL"])?.string ?? "No address yet")
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer()
                            if let integration {
                                // Once added, a status rather than a button.
                                if integration.isConnected {
                                    Label("Key added", systemImage: "checkmark.circle.fill")
                                        .labelStyle(.titleAndIcon)
                                        .font(.callout)
                                        .foregroundStyle(.green)
                                } else {
                                    Button("Add Key") { connect(integration) }
                                        .buttonStyle(.glass)
                                }
                            }
                            Button("Edit…") { edit(id) }
                                .buttonStyle(.glass)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        if id != ids.last { Divider().padding(.leading, 14) }
                    }
                }
                .background(SettingsMetrics.groupFill(scheme), in: .rect(cornerRadius: SettingsMetrics.groupRadius))
            }
        }
    }
}

struct ProviderEdit: Identifiable {
    /// Nil for a new one.
    var providerID: String?

    init(id: String?) { providerID = id }

    var id: String { providerID ?? "new" }
}

/// One provider's settings, in the Accounts page's place. A new one is named first; after that,
/// changes are saved as you make them.
struct CustomProviderEditor: View {
    @State var id: String?
    let done: () -> Void
    /// Removes this entry, once it's closed.
    let remove: ([String]) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.settingsBox) private var box
    @Environment(Catalog.self) private var catalog
    @State private var name = ""
    @State private var newModel = ""
    @State private var problem: String?
    @State private var confirmsRemoval = false

    private var config: EngineConfig { app.config(for: box) }

    /// Which of the engine's built-in API kinds it speaks.
    static let kinds: [(package: String, title: String)] = [
        ("@opencode/ai/providers/openai-compatible", "OpenAI-compatible (Chat Completions)"),
        ("@opencode/ai/providers/openai-compatible/responses", "OpenAI-compatible (Responses)"),
        ("@opencode/ai/providers/anthropic-compatible", "Anthropic-compatible (Messages)"),
    ]

    var body: some View {
        SettingsDetailPage {
            if let id {
                editor(id)
            } else {
                Section {
                    SettingsTextRow(title: "Name") {
                        TextField("Name", text: $name, prompt: Text("My Company, or Local Server"))
                            .onSubmit(create)
                            .onChange(of: name) { problem = nil }
                    }
                } footer: {
                    if let problem {
                        Text(problem).foregroundStyle(.red)
                    } else if !name.trimmingCharacters(in: .whitespaces).isEmpty && Self.providerID(for: name).isEmpty {
                        // Its id is made of them.
                        Text("A name needs a letter or a number.")
                    }
                }
            }
        } footer: {
            SettingsEditorButtons(create: id == nil ? "Create" : nil, canCreate: !Self.providerID(for: name).isEmpty, onCreate: create,
                                  remove: "Remove Provider…", onRemove: { confirmsRemoval = true }, done: done)
        }
        .settingsDetailTitle(id.flatMap { config.value(at: CustomProvidersSection.path + [$0, "name"])?.string } ?? "New Provider")
        .confirmationDialog("Remove this provider?", isPresented: $confirmsRemoval) {
            Button("Remove", role: .destructive) {
                remove(CustomProvidersSection.path + [id ?? ""])
            }
        } message: {
            Text("Its models go away from the model menu, and its key or sign-in is removed, here and on your machines. Sessions that used them need another model.")
        }
    }

    @ViewBuilder private func editor(_ id: String) -> some View {
        let path = CustomProvidersSection.path + [id]
        Group {
            Section {
                ConfigTextField(title: "Name", path: path + ["name"], prompt: id)
                Picker("API", selection: Binding(
                    get: { config.value(at: path + ["package"])?.string ?? Self.kinds[0].package },
                    set: { config.set(.string($0), at: path + ["package"]) }
                )) {
                    ForEach(Self.kinds, id: \.package) { Text($0.title).tag($0.package) }
                }
                ConfigTextField(title: "Address", path: path + ["settings", "baseURL"], prompt: "https://api.example.com/v1")
            } footer: {
                Text("Add its API key in Accounts once it's set up; it's kept with your other credentials, not in the settings file.")
                    .foregroundStyle(.secondary)
            }
            Section {
                let models = (config.value(at: path + ["models"])?.object?.keys).map { $0.sorted() } ?? []
                // Column titles, since a filled-in number no longer shows its prompt. Laid out
                // like the rows below, with the remove button's room kept.
                if !models.isEmpty {
                    HStack {
                        Text("Model")
                            .frame(width: 170, alignment: .leading)
                        Text("Name")
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text("Context")
                            .frame(width: 90, alignment: .trailing)
                        Text("Output")
                            .frame(width: 80, alignment: .trailing)
                        Image(systemName: "minus.circle.fill")
                            .font(.body)
                            .hidden()
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                ForEach(models, id: \.self) { model in
                    HStack {
                        // A long ID wraps, all of it in view.
                        Text(model)
                            .fontDesign(.monospaced)
                            .frame(width: 170, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                        ConfigTextField(title: "Name", path: path + ["models", model, "name"], prompt: "Name")
                            .labelsHidden()
                        ConfigNumberField(title: "Context", path: path + ["models", model, "limit", "context"], prompt: "Context")
                            .labelsHidden()
                            .frame(width: 90)
                        ConfigNumberField(title: "Output", path: path + ["models", model, "limit", "output"], prompt: "Output")
                            .labelsHidden()
                            .frame(width: 80)
                        Button {
                            config.set(nil, at: path + ["models", model])
                        } label: {
                            Image(systemName: "minus.circle.fill")
                        }
                        .buttonStyle(RemoveButtonStyle())
                        .help("Remove Model")
                    }
                }
                HStack {
                    TextField("Model ID", text: $newModel, prompt: Text("A model ID, as the service names it"))
                        .labelsHidden()
                        .onSubmit(addModel)
                    Button("Add", action: addModel)
                        .disabled(newModel.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            } header: {
                Text("Models")
            } footer: {
                Text("Context and output are the most tokens a model takes in and writes; empty means 200,000 and 32,000.")
                    .foregroundStyle(.secondary)
            }
            Section {
                ConfigKeyValueList(path: path + ["headers"], keyPrompt: "Header", valuePrompt: "Value")
            } header: {
                Text("Headers")
            } footer: {
                Text("Sent with every request, if the service needs more than a key. Write {env:NAME} to use an environment variable.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// The id a provider named `name` gets: its words in plain lowercase letters and digits,
    /// joined by hyphens ("Şirket Proxy" is sirket-proxy), which every client can name it by.
    nonisolated static func providerID(for name: String) -> String {
        let plain = name.applyingTransform(StringTransform(rawValue: "Any-Latin; Latin-ASCII; Lower"), reverse: false) ?? name.lowercased()
        return plain.split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }.joined(separator: "-")
    }

    private func create() {
        let title = name.trimmingCharacters(in: .whitespaces)
        let slug = Self.providerID(for: title)
        guard !slug.isEmpty else { return }
        // Not one the engine already has: that would change it instead.
        guard config.value(at: CustomProvidersSection.path + [slug]) == nil, !catalog.providers.contains(where: { $0.id == slug }) else {
            problem = "There's already a provider called that."
            return
        }
        config.set(.object([
            "name": .string(title),
            "package": .string(Self.kinds[0].package),
            "models": .object([:]),
        ]), at: CustomProvidersSection.path + [slug])
        Analytics.shared.track("custom_provider_added")
        id = slug
    }

    private func addModel() {
        guard let id else { return }
        let model = newModel.trimmingCharacters(in: .whitespaces)
        guard !model.isEmpty else { return }
        config.set(.object(["name": .string(model)]), at: CustomProvidersSection.path + [id, "models", model])
        newModel = ""
    }
}
