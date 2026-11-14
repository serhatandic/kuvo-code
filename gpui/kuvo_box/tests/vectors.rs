//! The shared cases every client is held to (Packages/KuvoLink/Vectors), as KuvoClient's tests
//! hold the Swift apps: what a sidebar shows from a box's session facts, which keyword a typed text
//! starts with, which texts go to the box at all, and that a box of this version passes the gate.

use std::collections::HashMap;
use std::path::PathBuf;

use kuvo_box::gate::{self, Gate};
use kuvo_box::sessions::{self, Facts, Line, Listing, Project};
use kuvo_box::typed;
use serde_json::Value;

fn vectors(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Packages/KuvoLink/Vectors").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).expect("the vectors are JSON")
}

fn facts_and_projects(case: &Value) -> (HashMap<String, Facts>, HashMap<String, Project>) {
    let sessions: HashMap<String, Facts> = serde_json::from_value(case["expect"]["sessions"].clone()).expect("every fact the box answers is read");
    let projects: HashMap<String, Project> = serde_json::from_value(case["expect"]["projects"].clone()).expect("every project the box answers is read");
    (sessions, projects)
}

#[test]
fn every_case_of_the_box_answer_is_read_whole() {
    let vectors = vectors("session-lists.json");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let (sessions, _) = facts_and_projects(case);
        // Read back as the box wrote it: nothing it says is lost.
        let again = serde_json::to_value(&sessions).unwrap();
        assert_eq!(numbers_as_floats(again), numbers_as_floats(case["expect"]["sessions"].clone()), "{}", case["name"]);
    }
}

/// (Times are numbers: 590 and 590.0 are the same.)
fn numbers_as_floats(value: Value) -> Value {
    match value {
        Value::Number(number) => serde_json::json!(number.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.into_iter().map(numbers_as_floats).collect()),
        Value::Object(fields) => Value::Object(fields.into_iter().map(|(name, value)| (name, numbers_as_floats(value))).collect()),
        other => other,
    }
}

#[test]
fn the_sidebar_follows_from_the_box_facts_alone() {
    let vectors = vectors("session-lists.json");
    let mut checked = 0;
    for case in vectors["cases"].as_array().unwrap() {
        let Some(expected) = case["expect"].get("sidebar").filter(|sidebar| !sidebar.is_null()) else { continue };
        let (sessions, projects) = facts_and_projects(case);
        let sidebar = sessions::sidebar(&sessions, &projects);
        let ids = |value: &Value| -> Vec<String> { serde_json::from_value(value.clone()).unwrap() };
        assert_eq!(sidebar.pinned, ids(&expected["pinned"]), "pinned: {}", case["name"]);
        assert_eq!(sidebar.chats, ids(&expected["chats"]), "chats: {}", case["name"]);
        let drawn: Vec<(String, Vec<String>)> = sidebar.projects.iter().map(|group| (group.directory.clone(), group.sessions.clone())).collect();
        let wanted: Vec<(String, Vec<String>)> = expected["projects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|group| (group["directory"].as_str().unwrap().to_owned(), ids(&group["sessions"])))
            .collect();
        assert_eq!(drawn, wanted, "projects: {}", case["name"]);
        checked += 1;
    }
    assert!(checked > 0, "a case with a sidebar");
}

#[test]
fn a_list_taken_line_by_line_ends_as_the_box_says() {
    let vectors = vectors("session-lists.json");
    let case = &vectors["cases"][0];
    let (sessions, projects) = facts_and_projects(case);
    let whole: Line = serde_json::from_value(serde_json::json!({ "at": "1", "full": true, "sessions": case["expect"]["sessions"], "projects": case["expect"]["projects"] })).unwrap();
    let mut listing = Listing::new();
    assert!(listing.take(whole));
    assert_eq!(listing.sidebar(), sessions::sidebar(&sessions, &projects));

    // One session changed and one deleted: the rest stay as they were.
    let (changed, gone) = {
        let mut ids: Vec<&String> = sessions.keys().collect();
        ids.sort();
        (ids[0].clone(), ids[1].clone())
    };
    let mut facts = sessions[&changed].clone();
    facts.title = Some("Renamed".into());
    facts.updated += 1.0;
    let line: Line = serde_json::from_value(serde_json::json!({ "at": "2", "sessions": { changed.clone(): facts }, "gone": [gone.clone()], "projects": case["expect"]["projects"] })).unwrap();
    assert!(listing.take(line));
    assert_eq!(listing.at(), Some("2"));
    assert_eq!(listing.sessions().len(), sessions.len() - 1);
    assert_eq!(listing.sessions()[&changed].title.as_deref(), Some("Renamed"));
    // What it said of the one let go stays at hand for a row still shown as it goes.
    assert_eq!(listing.facts(&gone), Some(&sessions[&gone]));
    assert!(!listing.sessions().contains_key(&gone));

    // The same again changes nothing.
    let same: Line = serde_json::from_value(serde_json::json!({ "at": "3", "sessions": {}, "projects": case["expect"]["projects"] })).unwrap();
    assert!(!listing.take(same));
    assert_eq!(listing.at(), Some("3"));
}

#[test]
fn a_keyword_is_drawn_as_the_box_reads_it() {
    let vectors = vectors("typed.json");
    for case in vectors["keywords"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let parsed = typed::keyword(text).map(|(keyword, rest)| serde_json::json!({ "keyword": keyword, "rest": rest })).unwrap_or(Value::Null);
        assert_eq!(parsed, case["parsed"], "{text:?}");
    }
}

/// A client answers a text that isn't "/" or "!" itself, without asking, as the box would: kept
/// with a model that can't run, a follow-up in the side thread with its tag on, else sent.
#[test]
fn a_text_the_client_answers_without_asking_is_answered_as_the_box_would() {
    let vectors = vectors("typed.json");
    let mut checked = (0, 0, 0);
    for case in vectors["decide"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        if typed::asks_box(text) {
            continue;
        }
        let facts = &case["facts"];
        let side = facts.get("side") == Some(&Value::Bool(true));
        let refusal = facts.get("refusal").and_then(Value::as_str);
        let decision = &case["decision"];
        match typed::plain_answer(text, side, refusal) {
            None => {
                assert_eq!(decision["send"]["text"].as_str(), Some(text), "{text:?}");
                checked.0 += 1;
            }
            Some(answer) if answer.side_thread == Some(true) => {
                assert_eq!(decision, &serde_json::json!({ "sideThread": true }), "{text:?}");
                checked.1 += 1;
            }
            Some(answer) => {
                let restore = answer.restore.expect("put back");
                assert_eq!(decision, &serde_json::json!({ "restore": { "text": restore.text }, "error": answer.error }), "{text:?}");
                checked.2 += 1;
            }
        }
    }
    assert!(checked.0 > 0 && checked.1 > 0 && checked.2 > 0, "{checked:?}");
    // The box checks the model first (typed/decide.ts): with both, the refusal.
    let both = typed::plain_answer("what now?", true, Some("Sign in to Anthropic again.")).unwrap();
    assert_eq!((both.side_thread, both.error.as_deref()), (None, Some("Sign in to Anthropic again.")));
    // And every text that starts "/" or "!" is the box's to read.
    for case in vectors["decide"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let first = text.trim_start().chars().next();
        assert_eq!(typed::asks_box(text), matches!(first, Some('/' | '!')), "{text:?}");
    }
}

#[test]
fn a_box_of_this_version_passes_the_gate() {
    let vectors = vectors("routes/features.json");
    let expect = &vectors["scenarios"][0]["steps"][0]["expect"];
    for kind in ["mac", "machine"] {
        // A Mac's names what it includes at least; a machine's, its whole list.
        let said = &expect[kind]["json"]["features"];
        let names: Vec<String> = serde_json::from_value(said.get("<includes>").unwrap_or(said).clone()).unwrap();
        assert_eq!(gate::missing(&names), Vec::<String>::new(), "{kind}");
        assert_eq!(Gate::for_features(Some(&names)), Gate::Open);
    }
}

#[test]
fn a_held_box_is_asked_only_what_keeps_work_going() {
    for allowed in [
        "kuvo/info",
        "kuvo/update",
        "kuvo/box/update",
        "kuvo/box/app",
        "kuvo/box/proof",
        "kuvo/box/kept-keys?bot=bot_1",
        "kuvo/agent-tools",
        "api/session/ses_1/message?limit=5",
        "kuvo/agents/api/event",
        "kuvo/asks",
        "kuvo/sandbox/asks/a1",
        "kuvo/vault/asks",
        "kuvo/work/asks/w1",
        "kuvo/sessions/ses_1/decisions",
        "kuvo/sessions/ses_1/asks",
        "kuvo/sessions/ses_1/asks/events",
        "kuvo/sessions/ses_1/asks/per_1",
    ] {
        assert!(gate::is_allowed(allowed), "{allowed}");
    }
    for held in ["kuvo/sessions/list", "kuvo/sessions/ses_1/typed", "kuvo/asksx", "kuvo/work-queue", "kuvo/sessions/ses_1/decisions/x", "kuvo/box/proofs", "kuvo/sessions/ses_1/asks/per_1/more", "kuvo/sessions/ses_1/queue"] {
        assert!(!gate::is_allowed(held), "{held}");
    }
}

/// The gate holds the same boxes as the Swift apps': the names in KuvoClient's `BoxGate.required`.
#[test]
fn the_gate_needs_what_the_swift_clients_need() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Packages/KuvoClient/Sources/ClientSessions/BoxGate.swift");
    let swift = std::fs::read_to_string(path).unwrap();
    let list = swift.split("public static let required: [String] = [").nth(1).and_then(|rest| rest.split(']').next()).expect("BoxGate.required");
    let names: Vec<&str> = list.split(',').map(|name| name.trim().trim_matches('"')).filter(|name| !name.is_empty()).collect();
    assert_eq!(names, gate::REQUIRED);
}

/// A message's parts as every client reads them, kept with a message or read by its box from one
/// from before; and the fields a client sends, as the box takes them (Vectors/message-parts.json).
#[test]
fn a_messages_parts_are_read_as_the_box_wrote_them() {
    let vectors = vectors("message-parts.json");
    let cases: Vec<&Value> = vectors["compose"].as_array().unwrap().iter().chain(vectors["read"].as_array().unwrap()).collect();
    assert!(cases.len() >= 30);
    for case in cases {
        let metadata = serde_json::json!({ "kuvo": { "parts": case["parts"], "other": 1 } });
        let read = kuvo_box::Parts::kept(Some(&metadata)).unwrap_or_else(|| panic!("{}", case["about"]));
        // Read and written again, the same parts.
        assert_eq!(numbers_as_floats(serde_json::to_value(&read).unwrap()), numbers_as_floats(case["parts"].clone()), "{}", case["about"]);
        // And as the box answers `kuvo/messages/parts`.
        let told: kuvo_box::Parts = serde_json::from_value(case["parts"].clone()).unwrap();
        assert_eq!(told, read, "{}", case["about"]);
    }
    // One with none kept is from before.
    assert_eq!(kuvo_box::Parts::kept(Some(&serde_json::json!({ "kuvo": { "wake": true } }))), None);
}

#[test]
fn a_client_sends_the_fields_the_box_takes() {
    use kuvo_box::parts::{Comment, Notes, Sending, Side};
    let vectors = vectors("message-parts.json");
    for case in vectors["compose"].as_array().unwrap() {
        let fields = &case["fields"];
        let strings = |value: &Value| -> Vec<String> { serde_json::from_value(value.clone()).unwrap_or_default() };
        let sending = Sending {
            words: fields["words"].as_str().unwrap().to_owned(),
            keyword: fields["keyword"].as_str().map(str::to_owned),
            widget: fields["widget"].as_str().map(str::to_owned),
            comments: fields["comments"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|each| Comment {
                    file: each["file"].as_str().unwrap().to_owned(),
                    line: each["line"].as_i64().unwrap(),
                    side: if each["side"] == "old" { Side::Old } else { Side::New },
                    snippet: each["snippet"].as_str().unwrap().to_owned(),
                    text: each["text"].as_str().unwrap().to_owned(),
                })
                .collect(),
            named: strings(&fields["named"]),
            notes: Notes { included: strings(&fields["notes"]["included"]), paths: strings(&fields["notes"]["paths"]), unsent: strings(&fields["notes"]["unsent"]) },
            ..Sending::default()
        };
        assert_eq!(numbers_as_floats(serde_json::to_value(&sending).unwrap()), numbers_as_floats(fields.clone()), "{}", case["about"]);
    }
}

/// What a session's model being ready means for a composer, as its box words it
/// (`Vectors/model-readiness.json`, which the box's words and KuvoClient's `SessionModelState` are
/// held to too): read as `kuvo/sessions/models` answers it, and drawn as it says, nothing worded here.
#[test]
fn a_models_readiness_is_drawn_as_its_box_words_it() {
    let vectors = vectors("model-readiness.json");
    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() >= 10);
    for case in cases {
        let about = case["about"].as_str().unwrap_or_default();
        let mut answer = case["state"].clone();
        let readiness = case["readiness"].as_object().expect("readiness");
        for (key, value) in readiness {
            answer[key] = value.clone();
        }
        let state: kuvo_box::models::ModelState = serde_json::from_value(answer).expect("the box's answer is read");
        assert_eq!(state.refusal.as_deref(), readiness.get("refusal").and_then(Value::as_str), "{about}");
        assert_eq!(state.choose, readiness.get("choose").and_then(Value::as_bool).unwrap_or(false), "{about}");
        let action = readiness.get("action");
        assert_eq!(state.action.as_ref().map(|action| action.kind.as_str()), action.and_then(|action| action["do"].as_str()), "{about}");
        assert_eq!(state.action.as_ref().map(|action| action.label.as_str()), action.and_then(|action| action["label"].as_str()), "{about}");
        assert_eq!(state.action.as_ref().map(|action| action.help.as_str()), action.and_then(|action| action["help"].as_str()), "{about}");
        // A plain message on it is kept, saying why in the box's words, as the box would (typed/decide.ts).
        let kept = kuvo_box::typed::plain_answer("fix it", false, state.refusal.as_deref());
        assert_eq!(kept.and_then(|answer| answer.error), state.refusal.clone(), "{about}");
    }
}

/// A value of `shape` as the box's route shapes write them (`Vectors/routes/shapes/answers.json`):
/// every field there, optional ones too, and the first of what may be one of several.
fn sample(shape: &Value) -> Value {
    use serde_json::json;
    match shape {
        Value::String(kind) => match kind.as_str() {
            "string" => json!("words"),
            "number" => json!(1),
            "bool" => json!(true),
            _ => Value::Null,
        },
        Value::Object(shape) => {
            if let Some(literal) = shape.get("literal") {
                literal.clone()
            } else if let Some(list) = shape.get("list") {
                json!([sample(list)])
            } else if let Some(one_of) = shape.get("oneOf").and_then(Value::as_array) {
                one_of.iter().find(|each| each.as_str() != Some("null")).map(sample).unwrap_or(Value::Null)
            } else if let Some(fields) = shape.get("object").and_then(Value::as_object) {
                Value::Object(fields.iter().map(|(name, field)| (name.trim_end_matches('?').to_owned(), sample(field))).collect())
            } else {
                Value::Null
            }
        }
        _ => Value::Null,
    }
}

/// Every kind of ask the box words reads as that kind; one missing any field doesn't keep the rest
/// from showing.
#[test]
fn every_ask_the_box_words_is_read_and_one_amiss_spoils_none_of_the_rest() {
    use kuvo_box::asks::{Ask, Asks};
    let answers = vectors("routes/shapes/answers.json");
    let route = answers["routes"].as_array().unwrap().iter().find(|route| route["route"] == "GET kuvo/sessions/:id/asks").expect("the asks route's shape");
    let kinds = route["answers"]["200"]["object"]["asks"]["list"]["oneOf"].as_array().expect("each kind of ask");
    let samples: Vec<Value> = kinds.iter().map(sample).collect();
    assert_eq!(samples.len(), 3, "permission, question, other");
    let asks: Asks = serde_json::from_value(serde_json::json!({ "asks": samples })).unwrap();
    assert!(matches!(asks.asks.as_slice(), [Ask::Permission(_), Ask::Question(_), Ask::Other { .. }]), "{asks:?}");
    for (n, kind) in samples.iter().enumerate() {
        for field in kind.as_object().unwrap().keys().filter(|field| *field != "kind") {
            let mut amiss = samples.clone();
            amiss[n].as_object_mut().unwrap().remove(field);
            let asks: Asks = serde_json::from_value(serde_json::json!({ "asks": amiss })).unwrap();
            assert_eq!(asks.asks.len(), 3);
            let read = asks.asks.iter().filter(|ask| **ask != Ask::Unknown).count();
            assert!(read >= 2, "without {field}, one ask spoiled the others: {asks:?}");
        }
    }
}
