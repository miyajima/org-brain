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
    fn fails(&self, input: Value, message: &str) {
        assert!(
            execute(&self.root, &self.config, 1, &input)
                .unwrap_err()
                .to_string()
                .contains(message)
        );
    }
}

#[test]
fn all_and_any_terms_preserve_default_phrase_and_ignore_citation_identifiers() {
    let w = Wiki::new();
    let s = w.call(json!({"op":"ingest","name":"evidence.txt","text":"original evidence"}));
    let a = w.call(
        json!({"op":"put","path":"a.md","content":"# 原本\n調査を省いて再利用する。1件確認。"}),
    );
    w.call(json!({"op":"put","path":"b.md","content":format!("# 別資料\n[出典](source:{}@1)\nabc82def",s["source_id"].as_str().unwrap())}));
    assert!(
        w.call(json!({"op":"search","query":"原本 再利用"}))["hits"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let all = w.call(json!({"op":"search","query":"原本 再利用","match_mode":"all"}));
    assert_eq!(all["hits"][0]["owner_id"], a["page_id"]);
    assert_eq!(
        w.call(json!({"op":"search","query":"不存在 再利用","match_mode":"any"}))["hits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        w.call(json!({"op":"search","query":"1","match_mode":"all"}))["hits"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        w.call(json!({"op":"search","query":"82","match_mode":"all"}))["hits"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn filters_and_per_owner_limit_apply_before_ranking() {
    let w = Wiki::new();
    let a = w.call(json!({"op":"put","path":"topic/a.md","project_id":"one","content":"# Start\nneedle\n## Later\nneedle\n## Final\nneedle"}));
    w.call(json!({"op":"put","path":"topic2/b.md","project_id":"two","content":"# Later\nneedle"}));
    let filtered = w.call(json!({"op":"search","query":"needle","path_prefix":"topic/","heading":"Later","project_id":"one"}));
    assert_eq!(filtered["hits"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["hits"][0]["owner_id"], a["page_id"]);
    assert_eq!(
        w.call(json!({"op":"search","query":"needle","page_id":a["page_id"],"per_owner_limit":10}))
            ["hits"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(
        w.call(json!({"op":"search","query":"needle","path_prefix":"topic/%"}))["hits"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn recorded_time_filters_use_half_open_instants_not_business_dates() {
    let w = Wiki::new();
    let a = w.call(json!({"op":"put","path":"a.md","content":"needle"}));
    let b = w.call(json!({"op":"put","path":"b.md","content":"needle"}));
    let db = rusqlite::Connection::open(w.root.join("knowledge.sqlite")).unwrap();
    db.execute(
        "UPDATE revisions SET created_at=? WHERE page_id=?",
        ["2026-10-01T00:00:00+00:00", a["page_id"].as_str().unwrap()],
    )
    .unwrap();
    db.execute(
        "UPDATE revisions SET created_at=? WHERE page_id=?",
        ["2026-11-01T00:00:00+00:00", b["page_id"].as_str().unwrap()],
    )
    .unwrap();
    let result = w.call(json!({"op":"search","query":"needle","since":"2026-10-01T09:00:00+09:00","until":"2026-11-01T00:00:00Z"}));
    assert_eq!(result["hits"].as_array().unwrap().len(), 1);
    assert_eq!(result["hits"][0]["owner_id"], a["page_id"]);
    w.fails(
        json!({"op":"search","query":"needle","since":"yesterday"}),
        "invalid_since",
    );
    w.fails(json!({"op":"search","query":"needle","since":"2026-11-01T00:00:00Z","until":"2026-10-01T00:00:00Z"}),"invalid_time_range");
}

#[test]
fn project_source_search_only_exposes_originals_cited_by_live_matching_pages() {
    let w = Wiki::new();
    let s = w.call(json!({"op":"ingest","name":"first.txt","text":"needle first"}));
    let other = w.call(json!({"op":"ingest","name":"other.txt","text":"needle other"}));
    let p = w.call(json!({"op":"put","path":"p.md","project_id":"one","content":format!("[e](source:{}@1)",s["source_id"].as_str().unwrap())}));
    w.call(json!({"op":"put","path":"other.md","project_id":"two","content":format!("[e](source:{}@1)",other["source_id"].as_str().unwrap())}));
    let result = w.call(json!({"op":"search","scope":"sources","query":"needle","project_id":"one","page_id":p["page_id"]}));
    assert_eq!(result["hits"].as_array().unwrap().len(), 1);
    assert_eq!(result["hits"][0]["owner_id"], s["source_id"]);
    assert!(w.call(json!({"op":"search","scope":"sources","query":"needle","source_id":other["source_id"],"project_id":"one"}))["hits"].as_array().unwrap().is_empty());
    w.call(json!({"op":"delete","page_id":p["page_id"],"expected_hash":p["hash"]}));
    assert!(w.call(json!({"op":"search","scope":"sources","query":"needle","project_id":"one"}))["hits"].as_array().unwrap().is_empty());
}

#[test]
fn source_query_reads_matching_tail_with_exact_original_version_and_cursor() {
    let w = Wiki::new();
    let text = format!(
        "# Background\n{}\n## Result\n前置き。\n提案は採用未確認で保存。\n32件、情報不足は保留。\n",
        "filler\n".repeat(1000)
    );
    let s = w.call(json!({"op":"ingest","name":"result.md","text":text}));
    w.call(json!({"op":"ingest","source_id":s["source_id"],"name":"result.md","text":"# Replacement\nnew result"}));
    let result = w.call(json!({"op":"source_read","source_id":s["source_id"],"version":1,"query":"採用未確認 保留","match_mode":"all","max_chars":128,"context_lines":1}));
    assert!(result["text"].as_str().unwrap().contains("採用未確認"));
    assert!(result["text"].as_str().unwrap().contains("保留"));
    assert!(result["start_line"].as_u64().unwrap() > 1000);
    assert_eq!(result["hash"], s["hash"]);
    let section = w.call(
        json!({"op":"source_read","source_id":s["source_id"],"version":1,"section":"Result"}),
    );
    assert!(section["text"].as_str().unwrap().starts_with("## Result"));
    w.fails(
        json!({"op":"source_read","source_id":s["source_id"],"version":1,"query":"nonexistent"}),
        "query_not_found",
    );
    assert_eq!(
        w.call(json!({"op":"source_read","source_id":s["source_id"],"version":1}))["hash"],
        s["hash"]
    );
}

#[test]
fn hybrid_search_keeps_filters_and_rejects_malformed_filter_values() {
    let w = Wiki::new();
    let a = w.call(json!({"op":"put","path":"topic/a.md","project_id":"one","content":"# Keep\nallowed semantic passage"}));
    w.call(json!({"op":"put","path":"topic/b.md","project_id":"two","content":"# Keep\nneedle"}));
    let pending = w.call(json!({"op":"embedding_pending","model":"m","limit":20}));
    let items: Vec<Value> = pending["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| json!({"hash":c["hash"],"vector":[1.0,0.0]}))
        .collect();
    w.call(json!({"op":"embedding_put","model":"m","items":items}));
    let result = w.call(json!({"op":"search","query":"needle","mode":"hybrid","model":"m","vector":[1.0,0.0],"project_id":"one","path_prefix":"topic/","heading":"Keep"}));
    assert_eq!(result["hits"].as_array().unwrap().len(), 1);
    assert_eq!(result["hits"][0]["owner_id"], a["page_id"]);
    w.fails(
        json!({"op":"search","query":"needle","since":42}),
        "invalid_since",
    );
    w.fails(
        json!({"op":"search","query":"needle","match_mode":42}),
        "invalid_match_mode",
    );
    w.fails(
        json!({"op":"search","query":"needle","per_owner_limit":0}),
        "invalid_per_owner_limit",
    );
}

#[test]
fn source_query_centers_long_lines_and_line_ranges_cannot_escape_a_section() {
    let w = Wiki::new();
    let body = format!(
        "# Intro\n{}採用未確認、32件保存。{}\n## Other\nprivate other section",
        "前文".repeat(3000),
        "後文".repeat(3000)
    );
    let s = w.call(json!({"op":"ingest","name":"long.md","text":body}));
    let result = w.call(
        json!({"op":"source_read","source_id":s["source_id"],"query":"採用未確認","max_chars":128}),
    );
    assert!(
        result["text"]
            .as_str()
            .unwrap()
            .contains("採用未確認、32件保存")
    );
    assert!(result["char_offset"].as_u64().unwrap() > 1000);
    let next = w.call(json!({"op":"source_read","source_id":s["source_id"],"query":"採用未確認","max_chars":128,"char_offset":result["next_char_offset"]}));
    assert!(
        next["text"].as_str().unwrap().starts_with("後文")
            || next["text"].as_str().unwrap().starts_with("文後")
    );
    w.fails(
        json!({"op":"source_read","source_id":s["source_id"],"section":"Other","start_line":1}),
        "invalid_line_range",
    );
}
