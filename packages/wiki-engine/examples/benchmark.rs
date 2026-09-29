use anyhow::Result;
use orgbrain_wiki_engine::execute;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{fs, time::Instant};

fn main() -> Result<()> {
    for count in [1_000usize, 10_000, 100_000] {
        let home = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir())?)?;
        let config = home.path().join("features.json");
        let root = home.path().join("wiki");
        fs::write(
            &config,
            r#"{"features":{"llm_wiki":{"enabled":true,"epoch":1}}}"#,
        )?;
        let call = |v: Value| execute(&root, &config, 1, &v);
        call(json!({"op":"init"}))?;
        let start = Instant::now();
        let mut saved = Value::Null;
        let mut last = String::new();
        for p in 0..count / 100 {
            let text = (0..100)
                .map(|c| {
                    format!(
                        "## Topic {}\n日本語検索とローカル knowledge evidence marker_{p}_{c}\n",
                        p * 100 + c
                    )
                })
                .collect::<String>();
            saved = call(
                json!({"op":"put","path":format!("page-{p}.md"),"title":format!("Page {p}"),"content":text}),
            )?;
            last = text;
        }
        let seed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let db = Connection::open(root.join("knowledge.sqlite"))?;
        let chunks: i64 = db.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))?;
        assert_eq!(chunks, count as i64);
        let mut queries = Vec::new();
        for query in [
            "日本語検索",
            "検索",
            "語",
            "knowledge",
            "marker_0_1",
            "notpresent",
        ] {
            let mut ms = Vec::new();
            for _ in 0..21 {
                let start = Instant::now();
                let result = call(json!({"op":"search","query":query}))?;
                assert!(result["hits"].as_array().is_some());
                ms.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            ms.sort_by(f64::total_cmp);
            queries.push(json!({"query":query,"p50_ms":ms[10],"p95_ms":ms[19]}));
        }
        let start = Instant::now();
        call(
            json!({"op":"put","page_id":saved["page_id"],"expected_hash":saved["hash"],"content":last.replace("marker_", "updated_marker_")}),
        )?;
        let update_ms = start.elapsed().as_secs_f64() * 1000.0;
        let indexed = call(json!({"op":"read","page_id":saved["page_id"]}))?;
        let start = Instant::now();
        call(
            json!({"op":"put","page_id":saved["page_id"],"expected_hash":indexed["hash"],"content":indexed["content"]}),
        )?;
        let unchanged_ms = start.elapsed().as_secs_f64() * 1000.0;
        println!(
            "{}",
            json!({"chunks":chunks,"seed_ms":seed_ms,"search":queries,"changed_page_ms":update_ms,"unchanged_page_ms":unchanged_ms,"database_bytes":fs::metadata(root.join("knowledge.sqlite"))?.len(),"timing":"Rust service including connection and feature guard; release build; 21 warm calls; no LLM/embedding network"})
        );
    }
    Ok(())
}
