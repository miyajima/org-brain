use orgbrain_wiki_engine::execute;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
use tempfile::TempDir;

struct Wiki {
    home: TempDir,
    config: PathBuf,
    root: PathBuf,
}
impl Wiki {
    fn new() -> Self {
        let home = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let config = home.path().join("features.json");
        let root = home.path().join("wiki");
        fs::write(
            &config,
            r#"{"features":{"llm_wiki":{"enabled":true,"epoch":1}}}"#,
        )
        .unwrap();
        let wiki = Self { home, config, root };
        wiki.call(json!({"op":"init"}));
        wiki
    }
    fn call(&self, input: Value) -> Value {
        execute(&self.root, &self.config, 1, &input).unwrap()
    }
    fn fail(&self, input: Value, message: &str) {
        assert!(
            execute(&self.root, &self.config, 1, &input)
                .unwrap_err()
                .to_string()
                .contains(message)
        );
    }
}

#[test]
fn diagnostics_identify_uncited_sources_without_treating_them_as_failed_imports() {
    let w = Wiki::new();
    let unused =
        w.call(json!({"op":"ingest","name":"補助スクリプト.py","text":"print('evidence')\n"}));
    let used = w.call(json!({"op":"ingest","name":"計測結果.md","text":"measured result\n"}));
    let page = w.call(json!({"op":"put","path":"topics/results.md","content":format!("# 計測の比較\n\n[source](source:{}@1#L1-L1)\n", used["source_id"].as_str().unwrap())}));
    w.call(json!({"op":"extraction_put","source_id":unused["source_id"],"version":1,"expected_hash":unused["hash"],"text":"script evidence","extractor":"manual-v1"}));
    w.call(json!({"op":"extraction_put","source_id":used["source_id"],"version":1,"expected_hash":used["hash"],"text":"new measured result","extractor":"manual-v1"}));
    let result = w.call(json!({"op":"diagnose"}));
    let findings = result["findings"].as_array().unwrap();
    let uncited: Vec<_> = findings
        .iter()
        .filter(|f| f["code"] == "unpaged_source")
        .collect();
    assert_eq!(uncited.len(), 1);
    assert_eq!(uncited[0]["details"]["source_id"], unused["source_id"]);
    assert_eq!(uncited[0]["details"]["name"], "補助スクリプト.py");
    assert_eq!(uncited[0]["details"]["version"], 2);
    assert_eq!(
        uncited[0]["details"]["original_path"],
        "raw/補助スクリプト.py"
    );
    let stale = findings
        .iter()
        .find(|f| f["code"] == "stale_source")
        .unwrap();
    assert_eq!(stale["details"]["name"], "計測結果.md");
    assert_eq!(stale["details"]["version"], 1);
    assert_eq!(stale["details"]["latest_version"], 2);
    assert_eq!(
        w.call(json!({"op":"read","page_id":page["page_id"]}))["hash"],
        page["hash"]
    );
    assert_eq!(
        fs::read(
            w.root
                .join("objects")
                .join(unused["hash"].as_str().unwrap())
        )
        .unwrap(),
        b"print('evidence')\n"
    );
    assert_eq!(result["integrity"], "ok");
}

#[test]
fn disabled_never_creates_a_wiki_and_epochs_cancel_old_jobs() {
    let t = tempfile::tempdir().unwrap();
    let config = t.path().join("features.json");
    let root = t.path().join("wiki");
    fs::write(
        &config,
        r#"{"features":{"llm_wiki":{"enabled":false,"epoch":2}}}"#,
    )
    .unwrap();
    assert!(
        execute(&root, &config, 1, &json!({"op":"init"}))
            .unwrap_err()
            .to_string()
            .contains("feature_disabled")
    );
    assert!(!root.exists());
    fs::write(
        &config,
        r#"{"features":{"llm_wiki":{"enabled":true,"epoch":3}}}"#,
    )
    .unwrap();
    assert!(
        execute(&root, &config, 1, &json!({"op":"init"}))
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
    assert!(!root.exists());
}

#[test]
fn configuration_disabled_before_commit_rolls_back_a_waiting_write() {
    let w = Wiki::new();
    let page = w.call(json!({"op":"put","path":"one.md","content":"original"}));
    let db = rusqlite::Connection::open(w.root.join("knowledge.sqlite")).unwrap();
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    let root = w.root.clone();
    let config = w.config.clone();
    let request = json!({"op":"put","page_id":page["page_id"],"expected_hash":page["hash"],"content":"must roll back"});
    let worker = std::thread::spawn(move || execute(&root, &config, 1, &request));
    let lock = PathBuf::from(format!("{}.lock", w.config.display()));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !lock.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(lock.exists());
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(!worker.is_finished());
    fs::write(
        &w.config,
        r#"{"features":{"llm_wiki":{"enabled":false,"epoch":2}}}"#,
    )
    .unwrap();
    db.execute_batch("COMMIT").unwrap();
    assert!(
        worker
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("feature_disabled")
    );
    let content: String = db
        .query_row(
            "SELECT content FROM pages WHERE id=?1",
            [page["page_id"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(content, "original");
}

#[test]
fn readable_titles_follow_markdown_headings_without_changing_stored_pages() {
    let w = Wiki::new();
    let body = "---\nsource: original\n---\n\n```md\n# Not a title\n```\n\n# 日本語の **わかりやすい** [タイトル](https://example.com)\n\n## Details\n検索の根拠\n";
    let page =
        w.call(json!({"op":"put","path":"wiki/topics/0192-long-machine-name.md","content":body}));
    let read = w.call(json!({"op":"read","page_id":page["page_id"],"section":"Details"}));
    assert_eq!(read["display_title"], "日本語の わかりやすい タイトル");
    assert_eq!(read["hash"], page["hash"]);
    let listed = w.call(json!({"op":"pages"}));
    assert_eq!(listed["pages"][0]["display_title"], read["display_title"]);
    assert!(listed["pages"][0].get("content").is_none());
    let hit = w.call(json!({"op":"search","query":"根拠"}));
    assert_eq!(hit["hits"][0]["display_title"], read["display_title"]);
    let full = w.call(json!({"op":"read","page_id":page["page_id"]}));
    assert_eq!(full["content"], body);
    assert_eq!(full["title"], "wiki/topics/0192-long-machine-name.md");
    let custom = w.call(json!({"op":"put","path":"custom.md","title":"利用者が付けたタイトル","content":"# Different heading\n[[wiki/topics/0192-long-machine-name.md]]"}));
    assert_eq!(
        w.call(json!({"op":"read","page_id":custom["page_id"]}))["display_title"],
        "利用者が付けたタイトル"
    );
    assert_eq!(
        w.call(json!({"op":"links","page_id":custom["page_id"]}))["outlinks"][0]["display_title"],
        read["display_title"]
    );
    let fallback = w.call(json!({"op":"put","path":"wiki/short-note.md","content":"No heading"}));
    assert_eq!(
        w.call(json!({"op":"read","page_id":fallback["page_id"]}))["display_title"],
        "short-note"
    );
}

#[test]
fn revisions_conflicts_patch_drafts_and_rename_keep_identity() {
    let w = Wiki::new();
    let a = w.call(json!({"op":"put","path":"topics/a.md","title":"A","content":"# A\n\n## Details\noriginal\n"}));
    w.fail(
        json!({"op":"put","page_id":a["page_id"],"content":"lost"}),
        "expected_hash_required",
    );
    let b = w.call(json!({"op":"put","path":"b.md","content":"[[topics/a.md]]"}));
    w.call(
        json!({"op":"rename","page_id":a["page_id"],"path":"renamed.md","expected_hash":a["hash"]}),
    );
    assert_eq!(
        w.call(json!({"op":"links","page_id":b["page_id"]}))["outlinks"][0]["target_id"],
        a["page_id"]
    );
    let a = w.call(json!({"op":"read","path":"topics/a.md"}));
    let updated = w.call(json!({"op":"patch","page_id":a["page_id"],"section":"Details","content":"changed\n","expected_hash":a["hash"]}));
    assert!(
        w.call(json!({"op":"read","page_id":a["page_id"]}))["content"]
            .as_str()
            .unwrap()
            .contains("# A")
    );
    w.fail(json!({"op":"patch","page_id":a["page_id"],"section":"missing","content":"x","expected_hash":updated["hash"]}), "section_not_found");
    let draft = w.call(json!({"op":"draft","page_id":a["page_id"],"content":"new draft","expected_hash":updated["hash"]}));
    w.call(json!({"op":"put","page_id":a["page_id"],"content":"newer","expected_hash":updated["hash"]}));
    w.fail(
        json!({"op":"approve","draft_id":draft["draft_id"],"expected_hash":updated["hash"]}),
        "page_conflict",
    );
    assert!(
        w.call(json!({"op":"history","page_id":a["page_id"]}))["revisions"]
            .as_array()
            .unwrap()
            .len()
            >= 3
    );
}

#[test]
fn sources_are_byte_exact_and_versioned_citations_drive_staleness() {
    let w = Wiki::new();
    let source_file = w.home.path().join("source.md");
    fs::write(&source_file, b"first\r\nsecond\r\n").unwrap();
    let s = w.call(json!({"op":"ingest","file":source_file,"name":"source.md"}));
    let raw = fs::read(w.root.join("objects").join(s["hash"].as_str().unwrap())).unwrap();
    assert_eq!(raw, b"first\r\nsecond\r\n");
    assert_eq!(
        w.call(json!({"op":"ingest","file":source_file}))["source_id"],
        s["source_id"]
    );
    let content = format!(
        "Fact [evidence](source:{}@1#L1-L2)",
        s["source_id"].as_str().unwrap()
    );
    w.call(json!({"op":"put","path":"fact.md","content":content}));
    let invalid = format!(
        "[evidence](source:{}@1#L1-L99)",
        s["source_id"].as_str().unwrap()
    );
    w.fail(
        json!({"op":"put","path":"invalid.md","content":invalid}),
        "citation_out_of_bounds",
    );
    assert_eq!(
        w.call(json!({"op":"pages"}))["pages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fs::write(&source_file, "new version\n").unwrap();
    w.call(json!({"op":"ingest","file":source_file,"source_id":s["source_id"]}));
    assert!(
        w.call(json!({"op":"diagnose"}))["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["code"] == "stale_source")
    );
}

#[test]
fn japanese_short_queries_incremental_embeddings_and_backup_restore() {
    let w = Wiki::new();
    let p = w.call(json!({"op":"put","path":"search.md","content":"# 検索\n\n## 日本語\n全文検索を試す\n\n## English\nlocal knowledge\n"}));
    for query in ["検索", "全", "全文検索", "LOCAL"] {
        assert!(
            !w.call(json!({"op":"search","query":query}))["hits"]
                .as_array()
                .unwrap()
                .is_empty(),
            "{query}"
        );
    }
    assert!(
        w.call(json!({"op":"search","query":"nonexistent"}))["hits"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let pending = w.call(json!({"op":"embedding_pending","model":"test-model"}));
    let items: Vec<Value> = pending["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| json!({"hash":x["hash"],"vector":[1.0,0.0]}))
        .collect();
    w.call(json!({"op":"embedding_put","model":"test-model","items":items}));
    assert!(
        w.call(json!({"op":"embedding_pending","model":"test-model"}))["chunks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(!w.call(json!({"op":"search","query":"different phrasing","vector":[1.0,0.0],"model":"test-model","mode":"hybrid"}))["hits"].as_array().unwrap().is_empty());
    let backup = w.home.path().join("backup");
    w.call(json!({"op":"backup","output":backup}));
    w.call(json!({"op":"delete","page_id":p["page_id"],"expected_hash":p["hash"]}));
    w.call(json!({"op":"restore_backup","from":backup}));
    assert_eq!(
        w.call(json!({"op":"read","page_id":p["page_id"]}))["hash"],
        p["hash"]
    );
}

#[test]
fn traversal_symlinks_and_source_hash_damage_are_rejected() {
    let w = Wiki::new();
    w.fail(
        json!({"op":"put","path":"../outside.md","content":"x"}),
        "invalid_path",
    );
    let s = w.call(json!({"op":"ingest","name":"a.md","text":"evidence"}));
    fs::write(
        w.root.join("objects").join(s["hash"].as_str().unwrap()),
        "tampered",
    )
    .unwrap();
    assert!(
        w.call(json!({"op":"diagnose"}))["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["code"] == "source_corrupt")
    );
    #[cfg(unix)]
    {
        let t = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(t.path(), w.root.join("objects/redirect")).unwrap();
        w.fail(
            json!({"op":"export","output":w.root.join("objects/redirect/export")}),
            "symlink",
        );
    }
}

#[test]
fn metadata_changes_cancel_stale_writes_and_empty_pages_are_valid() {
    let w = Wiki::new();
    let p = w.call(json!({"op":"put","path":"one.md","content":"same"}));
    let renamed = w.call(
        json!({"op":"rename","page_id":p["page_id"],"path":"two.md","expected_hash":p["hash"]}),
    );
    assert_ne!(renamed["hash"], p["hash"]);
    w.fail(
        json!({"op":"put","page_id":p["page_id"],"content":"overwrite","expected_hash":p["hash"]}),
        "page_conflict",
    );
    w.call(json!({"op":"delete","page_id":p["page_id"],"expected_hash":renamed["hash"]}));
    w.fail(json!({"op":"put","page_id":p["page_id"],"content":"resurrect","expected_hash":renamed["hash"]}),"page_conflict");
    let empty = w.call(json!({"op":"put","path":"empty.md","content":""}));
    assert_eq!(
        w.call(json!({"op":"read","page_id":empty["page_id"]}))["content"],
        ""
    );
}

#[test]
fn long_line_read_cursor_reconstructs_the_exact_page() {
    let w = Wiki::new();
    let body = format!("{}\nlast", "日本語".repeat(200));
    let p = w.call(json!({"op":"put","path":"long.md","content":body}));
    let mut offset = 0;
    let mut reconstructed = String::new();
    loop {
        let part = w
            .call(json!({"op":"read","page_id":p["page_id"],"char_offset":offset,"max_chars":128}));
        reconstructed.push_str(part["content"].as_str().unwrap());
        assert_eq!(part["hash"], p["hash"]);
        if part["truncated"] == false {
            break;
        }
        let next = part["next_char_offset"].as_u64().unwrap();
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(reconstructed, body);
}

#[test]
fn extraction_creates_an_immutable_source_version() {
    let w = Wiki::new();
    let s = w.call(json!({"op":"ingest","name":"image.bin","base64":"AP8="}));
    let extracted=w.call(json!({"op":"extraction_put","source_id":s["source_id"],"version":1,"expected_hash":s["hash"],"text":"line one\nline two","extractor":"manual-v1"}));
    assert_eq!(extracted["version"], 2);
    assert_eq!(
        w.call(json!({"op":"source_read","source_id":s["source_id"],"version":1}))["text"],
        ""
    );
    let content = format!(
        "[evidence](source:{}@2#L1-L2)",
        s["source_id"].as_str().unwrap()
    );
    w.call(json!({"op":"put","path":"fact.md","content":content}));
    w.call(json!({"op":"extraction_put","source_id":s["source_id"],"version":2,"expected_hash":s["hash"],"text":"different","extractor":"manual-v2"}));
    assert_eq!(
        w.call(json!({"op":"source_read","source_id":s["source_id"],"version":2}))["text"],
        "line one\nline two"
    );
}

#[test]
fn unchanged_sections_keep_index_ids_and_relative_links_resolve() {
    let w = Wiki::new();
    let p=w.call(json!({"op":"put","path":"topics/a.md","content":"# A\nbase\n## Stable\nunique stable passage\n## Changed\nold\n"}));
    let before =
        w.call(json!({"op":"search","query":"unique stable"}))["hits"][0]["chunk_id"].clone();
    w.call(json!({"op":"put","page_id":p["page_id"],"expected_hash":p["hash"],"content":"# A\nbase\n## Added\nfresh\n## Stable\nunique stable passage\n## Changed\nnew\n"}));
    assert_eq!(
        w.call(json!({"op":"search","query":"unique stable"}))["hits"][0]["chunk_id"],
        before
    );
    let b = w.call(json!({"op":"put","path":"topics/nested/b.md","content":"[a](../a.md) [[a]]"}));
    let links = w.call(json!({"op":"links","page_id":b["page_id"]}));
    assert!(
        links["outlinks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|l| l["target_id"] == p["page_id"])
    );
}

#[test]
fn explicit_migration_and_export_preserve_originals_and_portable_links() {
    use sha2::{Digest, Sha256};
    let w = Wiki::new();
    let vault = w.home.path().join("old-vault");
    fs::create_dir_all(vault.join(".llm-wiki/sources")).unwrap();
    fs::create_dir_all(vault.join("raw")).unwrap();
    fs::create_dir_all(vault.join("wiki/topics")).unwrap();
    let original = b"first\r\nsecond\r\n";
    fs::write(vault.join("raw/source.txt"), original).unwrap();
    fs::write(
        vault.join(".llm-wiki/sources/source.json"),
        serde_json::to_vec(
            &json!({"path":"raw/source.txt","sha256":format!("{:x}",Sha256::digest(original))}),
        )
        .unwrap(),
    )
    .unwrap();
    fs::write(
        vault.join("wiki/topics/a.md"),
        "# A\n[[raw/source.txt]] [[b]]\n",
    )
    .unwrap();
    fs::write(vault.join("wiki/topics/b.md"), "# B\nEvidence").unwrap();
    let preview = w.call(json!({"op":"migrate","from":vault,"dry_run":true}));
    assert_eq!(preview["pages"], 2);
    assert!(
        w.call(json!({"op":"pages"}))["pages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    w.call(json!({"op":"migrate","from":vault}));
    assert_eq!(fs::read(vault.join("raw/source.txt")).unwrap(), original);
    let a = w.call(json!({"op":"read","path":"wiki/topics/a.md"}));
    assert_eq!(
        w.call(json!({"op":"links","page_id":a["page_id"]}))["citations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let export = w.home.path().join("export");
    w.call(json!({"op":"export","output":export}));
    let content = fs::read_to_string(export.join("wiki/wiki/topics/a.md")).unwrap();
    assert!(!content.contains("[["));
    assert!(content.contains("b.md"));
    assert!(content.contains("raw/"));
    let s = w.call(json!({"op":"sources"}))["sources"][0].clone();
    let raw = export
        .join("raw")
        .join(format!("{}-1-source.txt", s["source_id"].as_str().unwrap()));
    assert_eq!(fs::read(raw).unwrap(), original);
}

#[test]
fn paged_lists_and_draft_approval_require_the_current_read_hash() {
    let w = Wiki::new();
    let p = w.call(json!({"op":"put","path":"a.md","content":"one"}));
    w.call(json!({"op":"put","path":"b.md","content":"two"}));
    let first = w.call(json!({"op":"pages","limit":1}));
    assert_eq!(first["pages"].as_array().unwrap().len(), 1);
    assert_eq!(first["next_offset"], 1);
    assert_eq!(
        w.call(json!({"op":"pages","limit":1,"offset":first["next_offset"]}))["pages"][0]["path"],
        "b.md"
    );
    let d = w.call(
        json!({"op":"draft","page_id":p["page_id"],"expected_hash":p["hash"],"content":"draft"}),
    );
    w.fail(
        json!({"op":"approve","draft_id":d["draft_id"]}),
        "expected_hash_required",
    );
    assert_eq!(
        w.call(json!({"op":"draft_read","draft_id":d["draft_id"]}))["content"],
        "draft"
    );
    w.call(json!({"op":"approve","draft_id":d["draft_id"],"expected_hash":p["hash"]}));
}

#[test]
fn moving_a_page_keeps_outbound_identity_and_mixed_citation_ranges_are_invalid() {
    let w = Wiki::new();
    let a = w.call(json!({"op":"put","path":"folder/a.md","content":"# A\nevidence"}));
    let b = w.call(json!({"op":"put","path":"folder/nested/b.md","content":"[A](../a.md)"}));
    w.call(json!({"op":"rename","page_id":b["page_id"],"path":"b.md","expected_hash":b["hash"]}));
    assert_eq!(
        w.call(json!({"op":"links","page_id":b["page_id"]}))["outlinks"][0]["target_id"],
        a["page_id"]
    );
    let s = w.call(json!({"op":"ingest","name":"s.txt","text":"one\ntwo\n"}));
    w.fail(json!({"op":"put","path":"bad.md","content":format!("[s](source:{}@1#L1-P2)",s["source_id"].as_str().unwrap())}),"invalid_citation");
}
