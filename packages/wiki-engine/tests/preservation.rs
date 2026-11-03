use orgbrain_wiki_engine::execute;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use tempfile::TempDir;

struct Wiki {
    _home: TempDir,
    root: PathBuf,
    config: PathBuf,
}
impl Wiki {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(home.path()).unwrap();
        let config = base.join("features.json");
        fs::write(
            &config,
            r#"{"features":{"llm_wiki":{"enabled":true,"epoch":1}}}"#,
        )
        .unwrap();
        let w = Self {
            root: base.join("wiki"),
            config,
            _home: home,
        };
        w.call(json!({"op":"init"}));
        w
    }
    fn call(&self, input: Value) -> Value {
        execute(&self.root, &self.config, 1, &input).unwrap()
    }
}

#[test]
fn capture_retains_omitted_numbers_conditions_and_reported_state() {
    let w = Wiki::new();
    let original = "# 検証\n\nNode146件、Python42件成功。\nただし配備は未実施。\n理由は予算不足。\n条件は同じ版であること。\n";
    let audit = w.call(json!({"op":"capture_audit","text":original,"summary":"テスト成功。"}));
    assert!(audit["missing_count"].as_u64().unwrap() >= 4);
    let result = w.call(json!({"op":"capture","path":"reports/a.md","name":"report.md","text":original,"summary":"# 結果\nテスト成功。","origin":{"session_id":"session-a","turn_id":"turn-1","recorded_at":"2026-10-31T12:00:00Z"}}));
    assert_eq!(result["coverage"]["missing_count"], 0);
    assert_eq!(result["verification_state"], "reported_unverified");
    let page = w.call(json!({"op":"read","page_id":result["page_id"]}));
    for fragment in [
        "146",
        "42",
        "配備は未実施",
        "予算不足",
        "同じ版",
        "session-a",
        "2026-10-31",
    ] {
        assert!(
            page["content"].as_str().unwrap().contains(fragment),
            "missing {fragment}"
        );
    }
    let source = w.call(
        json!({"op":"source_read","source_id":result["source_id"],"version":result["version"]}),
    );
    assert_eq!(source["text"], original);
    let inventory = w.call(json!({"op":"source_read","source_id":result["inventory_source_id"],"version":result["inventory_version"]}));
    let manifest: Value = serde_json::from_str(inventory["text"].as_str().unwrap()).unwrap();
    assert_eq!(manifest["origin"]["recorded_at"], "2026-10-31T12:00:00Z");
    assert_eq!(manifest["original"]["source_id"], result["source_id"]);
    assert!(
        !w.call(json!({"op":"search","scope":"sources","query":"Python42件"}))["hits"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn capture_checks_originals_and_hash_conflicts_without_partial_database_writes() {
    let w = Wiki::new();
    let a = w.call(json!({"op":"capture","path":"a.md","name":"a.txt","text":"12件成功。未配備。","summary":"成功。"}));
    let before = w.call(json!({"op":"sources"}))["sources"]
        .as_array()
        .unwrap()
        .len();
    assert!(execute(&w.root,&w.config,1,&json!({"op":"capture","path":"a.md","name":"b.txt","text":"99件。","summary":"変更。","expected_hash":"0".repeat(64)})).is_err());
    assert_eq!(
        w.call(json!({"op":"sources"}))["sources"]
            .as_array()
            .unwrap()
            .len(),
        before
    );
    assert_eq!(
        w.call(json!({"op":"read","page_id":a["page_id"]}))["hash"],
        a["hash"]
    );
    assert!(execute(&w.root,&w.config,1,&json!({"op":"capture","path":"x.md","name":"x.txt","text":"12件成功。","summary":"成功。","origin":{"recorded_at":"yesterday"}})).is_err());
}

#[test]
fn audit_reports_mechanical_gaps_without_claiming_semantic_completeness() {
    let w = Wiki::new();
    let result = w.call(json!({"op":"capture_audit","text":"決定は案A。\n理由は保守性。\n未確認。\n訂正：以前の報告は誤り。","summary":"決定は案A。"}));
    assert_eq!(result["semantic_completeness_verified"], false);
    assert!(
        result["missing"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["text"].as_str().unwrap().contains("未確認"))
    );
    let no_signal =
        w.call(json!({"op":"capture_audit","text":"普通の説明です。","summary":"説明。"}));
    assert_eq!(no_signal["semantic_completeness_verified"], false);
}
