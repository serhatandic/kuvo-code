/// What the engine's built-in agents do, in Kuvo Code's words, in both apps. The engine's own
/// descriptions are written for the model ("Executes tools based on configured permissions."),
/// and Explore's runs to two lines with a glob in it. An agent of yours keeps its own.
public enum AgentWords {
    public static func builtIn(_ id: String) -> String? {
        switch id {
        case "build": "The default agent: it can change files and run commands."
        case "plan": "Plans and answers without changing files."
        case "general": "Researches questions and runs multi-step tasks for another agent."
        case "explore": "Finds files and code quickly, without changing anything."
        default: nil
        }
    }
}
