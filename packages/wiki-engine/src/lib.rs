use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::Utc;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{LazyLock, Once},
    thread,
    time::Duration,
};
use tempfile::NamedTempFile;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const SCHEMA: &str = include_str!("schema.sql");
static VEC_INIT: Once = Once::new();
static WIKILINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[([^\[\]\n]+)\]\]").unwrap());
static SOURCE_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^source:([a-zA-Z0-9-]+)@(\d+)(?:#([LP])(\d+)-([LP])(\d+))?$").unwrap()
});

struct Guard(PathBuf);
impl Guard {
    fn acquire(config: &Path) -> Result<Self> {
        let lock = PathBuf::from(format!("{}.lock", config.display()));
        for _ in 0..500 {
            match fs::create_dir(&lock) {
                Ok(()) => return Ok(Self(lock)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(e.into()),
            }
        }
        bail!("wiki_busy: inspect stale feature lock before retrying")
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

pub fn execute(root: &Path, config: &Path, epoch: u64, input: &Value) -> Result<Value> {
    let _guard = Guard::acquire(config)?;
    check_feature(config, epoch)?;
    let op = required(input, "op")?;
    ensure!(root.is_absolute(), "root_must_be_absolute");
    reject_links(root)?;
    if op == "init" {
        fs::create_dir_all(root.join("objects"))?;
    }
    ensure!(
        root.join("knowledge.sqlite").is_file() || op == "init",
        "wiki_not_initialized"
    );
    let root = root.canonicalize()?;
    reject_links(&root.join("knowledge.sqlite"))?;
    reject_links(&root.join("knowledge.sqlite-wal"))?;
    reject_links(&root.join("knowledge.sqlite-shm"))?;
    reject_links(&root.join("objects"))?;
    VEC_INIT.call_once(|| {
        // Register the statically linked extension; no external library is loaded.
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                *const (),
                unsafe extern "C" fn(
                    *mut rusqlite::ffi::sqlite3,
                    *mut *mut std::ffi::c_char,
                    *const rusqlite::ffi::sqlite3_api_routines,
                ) -> i32,
            >(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
    });
    let write = ![
        "pages",
        "read",
        "search",
        "sources",
        "source_read",
        "links",
        "history",
        "diff",
        "drafts",
        "draft_read",
        "diagnose",
        "embedding_pending",
        "backup",
        "export",
    ]
    .contains(&op);
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let db = Connection::open_with_flags(root.join("knowledge.sqlite"), flags)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA foreign_keys=ON;")?;
    if op == "init" {
        db.execute_batch("PRAGMA journal_mode=WAL;")?;
        db.execute_batch(SCHEMA)?;
    }
    ensure!(
        db.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))? == 1,
        "unsupported_wiki_schema"
    );
    let engine = Wiki { db, root };
    if write {
        engine.db.execute_batch("BEGIN IMMEDIATE")?;
    }
    let mut result = engine.dispatch(op, input);
    if write {
        if result.is_ok() {
            result = check_feature(config, epoch).and(result);
        }
        engine
            .db
            .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })?;
    }
    result
}

fn check_feature(config: &Path, epoch: u64) -> Result<()> {
    ensure!(
        !fs::symlink_metadata(config)?.file_type().is_symlink(),
        "symlink_rejected"
    );
    let feature: Value = serde_json::from_slice(&fs::read(config)?)?;
    ensure!(
        feature["features"]["llm_wiki"]["enabled"] == true,
        "feature_disabled"
    );
    ensure!(
        feature["features"]["llm_wiki"]["epoch"].as_u64() == Some(epoch),
        "wiki_operation_cancelled"
    );
    Ok(())
}

fn required<'a>(input: &'a Value, name: &str) -> Result<&'a str> {
    input[name]
        .as_str()
        .filter(|x| !x.is_empty())
        .with_context(|| format!("{name}_required"))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn normalize_text(text: &str) -> String {
    text.nfkc().flat_map(char::to_lowercase).collect()
}
fn page_display_title(title: &str, path: &str, content: &str) -> String {
    if !title.is_empty() && title != path {
        return title.to_owned();
    }
    let prefix: String = content.chars().take(8192).collect();
    let mut in_heading = false;
    let mut text = String::new();
    for event in Parser::new_ext(&prefix, Options::all()) {
        match event {
            Event::Start(Tag::Heading {
                level: pulldown_cmark::HeadingLevel::H1,
                ..
            }) => in_heading = true,
            Event::End(TagEnd::Heading(pulldown_cmark::HeadingLevel::H1)) if in_heading => {
                let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !title.is_empty() {
                    return title.chars().take(500).collect();
                }
                in_heading = false;
            }
            Event::Text(value) | Event::Code(value) | Event::InlineMath(value) if in_heading => {
                text.push_str(&value)
            }
            Event::SoftBreak | Event::HardBreak if in_heading => text.push(' '),
            _ => (),
        }
    }
    Path::new(path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn reject_links(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for part in path.components() {
        ensure!(!matches!(part, Component::ParentDir), "invalid_path");
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => ensure!(
                !metadata.file_type().is_symlink(),
                "symlink_rejected: {}",
                current.display()
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn page_path(path: &str) -> Result<String> {
    ensure!(
        !path.is_empty()
            && path.len() <= 512
            && !path.contains('\\')
            && !path.contains('\0')
            && !Path::new(path).is_absolute(),
        "invalid_path"
    );
    ensure!(
        Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_))),
        "invalid_path"
    );
    Ok(if path.ends_with(".md") {
        path.into()
    } else {
        format!("{path}.md")
    })
}

#[derive(Clone)]
struct Section {
    heading: String,
    start: usize,
    end: usize,
}
fn sections(text: &str) -> Vec<Section> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut positions = vec![0];
    let mut offset = 0;
    for line in &lines {
        offset += line.len();
        positions.push(offset);
    }
    let mut result = Vec::new();
    for (event, range) in Parser::new_ext(text, Options::all()).into_offset_iter() {
        if let Event::Start(Tag::Heading { .. }) = event {
            let start = positions
                .partition_point(|offset| *offset <= range.start)
                .saturating_sub(1);
            let heading = lines
                .get(start)
                .unwrap_or(&"")
                .trim()
                .trim_start_matches('#')
                .trim()
                .trim_end_matches('#')
                .trim()
                .to_string();
            result.push(Section {
                heading,
                start,
                end: lines.len(),
            });
        }
    }
    for i in 0..result.len().saturating_sub(1) {
        result[i].end = result[i + 1].start;
    }
    if result.first().is_none_or(|s| s.start != 0) {
        result.insert(
            0,
            Section {
                heading: String::new(),
                start: 0,
                end: result.first().map_or(lines.len(), |s| s.start),
            },
        );
    }
    result
}
fn prose(text: &str) -> String {
    let mut bytes = text.as_bytes().to_vec();
    let mut in_code = false;
    for (event, range) in Parser::new_ext(text, Options::all()).into_offset_iter() {
        let mask = match event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code = true;
                true
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code = false;
                true
            }
            Event::Code(_) | Event::Html(_) | Event::InlineHtml(_) => true,
            _ => in_code,
        };
        if mask {
            for b in &mut bytes[range] {
                if *b != b'\n' && *b != b'\r' {
                    *b = b' ';
                }
            }
        }
    }
    String::from_utf8(bytes).expect("masked complete UTF-8 ranges")
}

struct Wiki {
    db: Connection,
    root: PathBuf,
}
impl Wiki {
    fn dispatch(&self, op: &str, v: &Value) -> Result<Value> {
        match op {
            "init" => Ok(json!({"initialized":true,"wiki_id":"personal","schema_version":1})),
            "pages" => self.listing(v,"pages","SELECT id AS page_id,path,title,substr(content,1,8192) AS title_content,hash,project_id,deleted FROM pages WHERE deleted=0 ORDER BY path"),
            "put" => self.put(v),
            "read" => self.read(v),
            "patch" => self.patch(v),
            "ingest" => self.ingest(v),
            "extraction_put" => self.extraction_put(v),
            "sources" => self.listing(v,"sources","SELECT source_id,version,name,hash,url,original_path,extractor FROM source_versions ORDER BY source_id,version DESC"),
            "source_read" => self.source_read(v),
            "search" => self.search(v),
            "links" => self.links(v),
            "rename" => self.rename(v),
            "delete" => self.delete(v),
            "history" => self.history(v),
            "diff" => self.diff(v),
            "restore_revision" => self.restore_revision(v),
            "draft" => self.draft(v),
            "approve" => self.approve(v),
            "drafts" => self.listing(v,"drafts","SELECT id AS draft_id,page_id,expected_hash,created_at FROM drafts ORDER BY created_at DESC"),
            "draft_read" => {let d=self.rows("SELECT id AS draft_id,page_id,content,expected_hash,created_at FROM drafts WHERE id=?",[required(v,"draft_id")?])?.into_iter().next().context("draft_not_found")?;Ok(d)},
            "diagnose" => self.diagnose(),
            "embedding_pending" => self.embedding_pending(v),
            "embedding_put" => self.embedding_put(v),
            "backup" => self.backup(v),
            "restore_backup" => self.restore_backup(v),
            "export" => self.export(v),
            "migrate" => self.migrate(v),
            _ => bail!("unknown_wiki_operation"),
        }
    }
    fn rows<P: rusqlite::Params>(&self, sql: &str, params: P) -> Result<Vec<Value>> {
        let mut stmt = self.db.prepare(sql)?;
        let names: Vec<String> = stmt.column_names().iter().map(|n| n.to_string()).collect();
        Ok(stmt
            .query_map(params, |row| {
                let mut value = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    let item = match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(x) => json!(x),
                        rusqlite::types::ValueRef::Real(x) => json!(x),
                        rusqlite::types::ValueRef::Text(x) => json!(String::from_utf8_lossy(x)),
                        rusqlite::types::ValueRef::Blob(_) => Value::Null,
                    };
                    value.insert(name.clone(), item);
                }
                if let (Some(title), Some(path), Some(content)) = (
                    value.get("title").and_then(Value::as_str),
                    value.get("path").and_then(Value::as_str),
                    value
                        .get("title_content")
                        .or_else(|| value.get("content"))
                        .and_then(Value::as_str),
                ) {
                    let title = page_display_title(title, path, content);
                    value.insert("display_title".into(), json!(title));
                }
                value.remove("title_content");
                Ok(Value::Object(value))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    fn listing(&self, v: &Value, key: &str, sql: &str) -> Result<Value> {
        let limit = v["limit"].as_i64().unwrap_or(100).clamp(1, 500);
        let offset = v["offset"].as_i64().unwrap_or(0);
        ensure!(offset >= 0, "invalid_offset");
        let mut rows = self.rows(
            &format!("{sql} LIMIT ? OFFSET ?"),
            params![limit + 1, offset],
        )?;
        let more = rows.len() > limit as usize;
        if more {
            rows.pop();
        }
        let mut result =
            json!({"truncated":more,"next_offset":if more{Some(offset+limit)}else{None}});
        result[key] = json!(rows);
        Ok(result)
    }
    fn page(&self, v: &Value) -> Result<Value> {
        let id = if let Some(id) = v["page_id"].as_str() {
            id.to_string()
        } else {
            let path = page_path(required(v, "path")?)?;
            self.db
                .query_row("SELECT page_id FROM aliases WHERE path=?", [&path], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?
                .context("page_not_found")?
        };
        self.rows(
            "SELECT id AS page_id,path,title,content,hash,deleted,project_id FROM pages WHERE id=?",
            [&id],
        )?
        .into_iter()
        .next()
        .context("page_not_found")
    }
    fn check_hash(&self, page: &Value, v: &Value) -> Result<()> {
        ensure!(
            v["expected_hash"].as_str().is_some(),
            "expected_hash_required"
        );
        ensure!(page["hash"] == v["expected_hash"], "page_conflict");
        Ok(())
    }
    fn put(&self, v: &Value) -> Result<Value> {
        let content = v["content"].as_str().context("content_required")?;
        ensure!(content.len() <= 2_000_000, "page_too_large");
        let existing = if v["page_id"].is_string() {
            Some(self.page(v)?)
        } else {
            let path = page_path(required(v, "path")?)?;
            if self
                .db
                .query_row("SELECT 1 FROM aliases WHERE path=?", [&path], |_| Ok(true))
                .optional()?
                .unwrap_or(false)
            {
                Some(self.page(v)?)
            } else {
                None
            }
        };
        if let Some(page) = &existing {
            self.check_hash(page, v)?;
        } else {
            ensure!(v["expected_hash"].is_null(), "page_not_found");
        }
        let id = existing
            .as_ref()
            .and_then(|p| p["page_id"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let path = if let Some(page) = &existing {
            required(page, "path")?.to_owned()
        } else {
            page_path(required(v, "path")?)?
        };
        let title = v["title"]
            .as_str()
            .or_else(|| existing.as_ref().and_then(|p| p["title"].as_str()))
            .unwrap_or(&path);
        ensure!(title.len() <= 500, "title_too_long");
        let project = v["project_id"]
            .as_str()
            .or_else(|| existing.as_ref().and_then(|p| p["project_id"].as_str()));
        let revision = Uuid::new_v4().to_string();
        let hash = digest(
            serde_json::to_vec(&json!([revision, path, title, content, project]))?.as_slice(),
        );
        self.validate_citations(content)?;
        self.db.execute("INSERT INTO pages(id,path,title,content,hash,deleted,project_id) VALUES(?,?,?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,hash=excluded.hash,deleted=0,project_id=excluded.project_id", params![id,path,title,content,hash,project])?;
        self.db.execute(
            "INSERT OR IGNORE INTO aliases(path,page_id) VALUES(?,?)",
            params![path, id],
        )?;
        self.db.execute("INSERT INTO revisions(id,page_id,content,hash,title,path,deleted,created_at) VALUES(?,?,?,?,?,?,0,?)", params![revision,id,content,hash,title,path,Utc::now().to_rfc3339()])?;
        self.index(&id, "page", 0, title, content, project)?;
        self.index_links(&id, content)?;
        self.resolve_links()?;
        Ok(
            json!({"page_id":id,"path":path,"hash":hash,"content_hash":digest(content.as_bytes()),"revision_id":revision,"created":existing.is_none()}),
        )
    }
    fn read(&self, v: &Value) -> Result<Value> {
        let mut page = self.page(v)?;
        ensure!(page["deleted"] == 0, "page_deleted");
        let content = page["content"].as_str().unwrap();
        let lines: Vec<&str> = content.split_inclusive('\n').collect();
        let headings: Vec<Value> = sections(content)
            .iter()
            .map(|s| json!({"heading":s.heading,"start_line":s.start+1,"end_line":s.end}))
            .collect();
        let (start, end) = if let Some(heading) = v["section"].as_str() {
            let candidates: Vec<Section> = sections(content)
                .into_iter()
                .filter(|s| s.heading == heading)
                .collect();
            ensure!(!candidates.is_empty(), "section_not_found");
            ensure!(candidates.len() == 1, "ambiguous_section");
            (candidates[0].start, candidates[0].end)
        } else {
            (
                v["start_line"].as_u64().unwrap_or(1).saturating_sub(1) as usize,
                v["end_line"].as_u64().map_or(lines.len(), |n| n as usize),
            )
        };
        ensure!(
            start <= lines.len() && end >= start && end <= lines.len(),
            "invalid_line_range"
        );
        let limit = v["max_chars"].as_u64().unwrap_or(16000).clamp(128, 64000) as usize;
        let range = lines[start..end].concat();
        let offset = v["char_offset"].as_u64().unwrap_or(0) as usize;
        let total = range.chars().count();
        ensure!(offset <= total, "invalid_char_offset");
        let body: String = range.chars().skip(offset).take(limit).collect();
        let next = offset + body.chars().count();
        let truncated = next < total;
        let before = range.chars().take(offset).filter(|c| *c == '\n').count();
        let after = before + body.chars().filter(|c| *c == '\n').count();
        page["content_hash"] = json!(digest(content.as_bytes()));
        page["content"] = json!(body);
        page["headings"] = json!(headings);
        page["truncated"] = json!(truncated);
        page["next_line"] = if truncated {
            json!(start + after + 1)
        } else {
            Value::Null
        };
        page["next_char_offset"] = if truncated { json!(next) } else { Value::Null };
        page["start_line"] = json!(start + before + 1);
        page["end_line"] = json!(start + after + 1);
        Ok(page)
    }
    fn patch(&self, v: &Value) -> Result<Value> {
        let page = self.page(v)?;
        self.check_hash(&page, v)?;
        let text = page["content"].as_str().unwrap();
        let lines: Vec<&str> = text.split_inclusive('\n').collect();
        let (start, end) = if let Some(heading) = v["section"].as_str() {
            let matches: Vec<Section> = sections(text)
                .into_iter()
                .filter(|s| s.heading == heading)
                .collect();
            ensure!(!matches.is_empty(), "section_not_found");
            ensure!(matches.len() == 1, "ambiguous_section");
            (
                matches[0].start + usize::from(!heading.is_empty()),
                matches[0].end,
            )
        } else {
            (
                v["start_line"]
                    .as_u64()
                    .context("start_line_required")?
                    .saturating_sub(1) as usize,
                v["end_line"].as_u64().context("end_line_required")? as usize,
            )
        };
        ensure!(start <= end && end <= lines.len(), "invalid_line_range");
        let replacement = v["content"].as_str().context("content_required")?;
        let content = format!(
            "{}{}{}",
            lines[..start].concat(),
            replacement,
            lines[end..].concat()
        );
        self.put(&json!({"page_id":page["page_id"],"content":content,"expected_hash":page["hash"]}))
    }
    fn index(
        &self,
        owner: &str,
        kind: &str,
        version: i64,
        title: &str,
        content: &str,
        project: Option<&str>,
    ) -> Result<()> {
        self.db.execute_batch("CREATE TEMP TABLE IF NOT EXISTS index_seen(id INTEGER PRIMARY KEY);DELETE FROM index_seen;")?;
        let lines: Vec<&str> = content.split_inclusive('\n').collect();
        for section in sections(content) {
            let mut buffer = String::new();
            let mut size = 0;
            let mut start = section.start;
            for (i, line) in lines
                .iter()
                .enumerate()
                .take(section.end)
                .skip(section.start)
            {
                if !buffer.is_empty() && size + line.encode_utf16().count() > 2800 {
                    self.chunk(
                        owner,
                        kind,
                        version,
                        title,
                        &section.heading,
                        start + 1,
                        i,
                        &buffer,
                        project,
                    )?;
                    buffer.clear();
                    size = 0;
                    start = i;
                }
                for c in line.chars() {
                    if size + c.len_utf16() > 2800 {
                        self.chunk(
                            owner,
                            kind,
                            version,
                            title,
                            &section.heading,
                            start + 1,
                            i + 1,
                            &buffer,
                            project,
                        )?;
                        buffer.clear();
                        size = 0;
                        start = i;
                    }
                    buffer.push(c);
                    size += c.len_utf16();
                }
            }
            if !buffer.trim().is_empty() {
                self.chunk(
                    owner,
                    kind,
                    version,
                    title,
                    &section.heading,
                    start + 1,
                    section.end,
                    &buffer,
                    project,
                )?;
            }
        }
        self.db.execute("DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE owner=? AND kind=? AND id NOT IN (SELECT id FROM index_seen))",params![owner,kind])?;
        self.db.execute(
            "DELETE FROM chunks WHERE owner=? AND kind=? AND id NOT IN (SELECT id FROM index_seen)",
            params![owner, kind],
        )?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    fn chunk(
        &self,
        owner: &str,
        kind: &str,
        version: i64,
        title: &str,
        heading: &str,
        start: usize,
        end: usize,
        body: &str,
        project: Option<&str>,
    ) -> Result<()> {
        let embedding = format!(
            "{}\n{}\n{}",
            title.chars().take(200).collect::<String>(),
            heading.chars().take(200).collect::<String>(),
            body
        );
        let hash = digest(embedding.as_bytes());
        let normalized = normalize_text(&format!("{title}\n{heading}\n{body}"));
        let existing:Option<i64>=self.db.query_row("SELECT id FROM chunks WHERE owner=? AND kind=? AND hash=? AND title=? AND heading=? AND body=? AND id NOT IN (SELECT id FROM index_seen) LIMIT 1",params![owner,kind,hash,title,heading,body],|r|r.get(0)).optional()?;
        if let Some(id) = existing {
            self.db.execute(
                "UPDATE chunks SET version=?,start_line=?,end_line=?,project_id=? WHERE id=?",
                params![version, start as i64, end as i64, project, id],
            )?;
            self.db
                .execute("INSERT INTO index_seen(id) VALUES(?)", [id])?;
            return Ok(());
        }
        self.db.execute("INSERT INTO chunks(owner,kind,version,title,heading,start_line,end_line,body,normalized,hash,embedding_text,project_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", params![owner,kind,version,title,heading,start as i64,end as i64,body,normalized,hash,embedding,project])?;
        let id = self.db.last_insert_rowid();
        self.db
            .execute("INSERT INTO index_seen(id) VALUES(?)", [id])?;
        self.db.execute(
            "INSERT INTO chunk_fts(rowid,title,heading,normalized) VALUES(?,?,?,?)",
            params![
                id,
                normalize_text(title),
                normalize_text(heading),
                normalized
            ],
        )?;
        let chars: Vec<char> = normalized.chars().collect();
        let mut grams = BTreeSet::new();
        for i in 0..chars.len() {
            grams.insert(chars[i].to_string());
            if i + 1 < chars.len() {
                grams.insert(format!("{}{}", chars[i], chars[i + 1]));
            }
        }
        let mut statement = self
            .db
            .prepare("INSERT INTO short_grams(gram,chunk_id) VALUES(?,?)")?;
        for gram in grams {
            statement.execute(params![gram, id])?;
        }
        Ok(())
    }
    fn search(&self, v: &Value) -> Result<Value> {
        let query = normalize_text(required(v, "query")?);
        ensure!(query.len() <= 2000, "query_too_long");
        let scope = v["scope"].as_str().unwrap_or("wiki");
        ensure!(
            ["wiki", "sources", "all"].contains(&scope),
            "invalid_search_scope"
        );
        let kind = match scope {
            "wiki" => "page",
            "sources" => "source",
            _ => "",
        };
        let limit = v["limit"].as_u64().unwrap_or(20).clamp(1, 100) as usize;
        let project = v["project_id"].as_str();
        let filter = " AND (?='' OR c.kind=?) AND (? IS NULL OR c.project_id=?) AND (c.kind!='page' OR EXISTS(SELECT 1 FROM pages p WHERE p.id=c.owner AND p.deleted=0))";
        let cols = "c.id AS chunk_id,c.owner AS owner_id,c.kind,c.version,c.title,c.heading,c.start_line,c.end_line,c.body AS snippet,c.hash";
        let lexical = if query.chars().count() < 3 {
            self.rows(&format!("SELECT {cols},0.0 AS rank FROM short_grams g JOIN chunks c ON c.id=g.chunk_id WHERE g.gram=?{filter} ORDER BY c.title,c.id LIMIT 201"), params![query,kind,kind,project,project])?
        } else {
            let escaped = format!("\"{}\"", query.replace('"', "\"\""));
            self.rows(&format!("SELECT {cols},bm25(chunk_fts,2,2,1) AS rank FROM chunk_fts JOIN chunks c ON c.id=chunk_fts.rowid WHERE chunk_fts MATCH ?{filter} ORDER BY rank,c.id LIMIT 201"), params![escaped,kind,kind,project,project])?
        };
        let mut ranked = BTreeMap::<i64, (f64, Value)>::new();
        for (rank, mut hit) in lexical.into_iter().enumerate() {
            let id = hit["chunk_id"].as_i64().unwrap();
            hit["matched_by"] = json!(["lexical"]);
            ranked.insert(id, (1.0 / (60.0 + rank as f64 + 1.0), hit));
        }
        let mut mode = "lexical";
        let mut fallback = Value::Null;
        if v["mode"] == "hybrid" && v["vector"].is_array() {
            let model = required(v, "model")?;
            let bytes = self.vector(&v["vector"])?;
            let dimension: Option<i64> = self
                .db
                .query_row(
                    "SELECT dimensions FROM embedding_models WHERE model=?",
                    [model],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(dimension) = dimension {
                ensure!(
                    dimension as usize * 4 == bytes.len(),
                    "vector_dimension_mismatch"
                );
                let vector_hits = self.rows(&format!("SELECT {cols},vec_distance_cosine(e.vector,?) AS distance FROM chunks c JOIN embeddings e ON e.hash=c.hash AND e.model=? WHERE 1=1{filter} ORDER BY distance,c.id LIMIT 200"), params![bytes,model,kind,kind,project,project])?;
                for (rank, mut hit) in vector_hits.into_iter().enumerate() {
                    let id = hit["chunk_id"].as_i64().unwrap();
                    let score = 1.0 / (60.0 + rank as f64 + 1.0);
                    if let Some((total, old)) = ranked.get_mut(&id) {
                        *total += score;
                        old["matched_by"] = json!(["lexical", "vector"]);
                    } else {
                        hit["matched_by"] = json!(["vector"]);
                        ranked.insert(id, (score, hit));
                    }
                }
                mode = "hybrid";
            } else {
                fallback = json!("embedding_index_unavailable");
            }
        }
        let mut hits: Vec<(f64, Value)> = ranked.into_values().collect();
        hits.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then_with(|| a.1["chunk_id"].as_i64().cmp(&b.1["chunk_id"].as_i64()))
        });
        let mut per_owner = BTreeMap::<String, usize>::new();
        let mut output = Vec::new();
        let mut truncated = false;
        for (score, mut hit) in hits {
            let owner = hit["owner_id"].as_str().unwrap().to_owned();
            let count = per_owner.entry(owner).or_default();
            if *count >= 2 {
                truncated = true;
                continue;
            }
            *count += 1;
            if output.len() >= limit {
                truncated = true;
                break;
            }
            hit["score"] = json!(score);
            if hit["kind"] == "page" {
                let page = self.rows("SELECT path,title,substr(content,1,8192) AS title_content FROM pages WHERE id=?",[hit["owner_id"].as_str().unwrap()])?;
                if let Some(page) = page.first() {
                    hit["display_title"] = page["display_title"].clone();
                }
            }
            hit["snippet"] = json!(
                hit["snippet"]
                    .as_str()
                    .unwrap()
                    .chars()
                    .take(1000)
                    .collect::<String>()
            );
            output.push(hit);
        }
        Ok(
            json!({"hits":output,"mode":mode,"fallback":fallback,"truncated":truncated,"index_status":"ready"}),
        )
    }
    fn store_object(&self, bytes: &[u8]) -> Result<String> {
        let hash = digest(bytes);
        let target = self.root.join("objects").join(&hash);
        reject_links(&target)?;
        if target.exists() {
            ensure!(digest(&fs::read(target)?) == hash, "source_corrupt");
        } else {
            let mut file = NamedTempFile::new_in(self.root.join("objects"))?;
            file.write_all(bytes)?;
            file.as_file().sync_all()?;
            file.persist_noclobber(target)?;
        }
        Ok(hash)
    }
    fn ingest(&self, v: &Value) -> Result<Value> {
        let (bytes, name) = if let Some(file) = v["file"].as_str() {
            let path = Path::new(file);
            reject_links(path)?;
            ensure!(fs::metadata(path)?.len() <= 64_000_000, "source_too_large");
            (
                fs::read(path)?,
                v["name"].as_str().map(str::to_owned).unwrap_or_else(|| {
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                }),
            )
        } else if let Some(encoded) = v["base64"].as_str() {
            (STANDARD.decode(encoded)?, required(v, "name")?.to_string())
        } else {
            (
                v["text"]
                    .as_str()
                    .context("source_content_required")?
                    .as_bytes()
                    .to_vec(),
                required(v, "name")?.to_string(),
            )
        };
        ensure!(
            !name.is_empty()
                && name.len() <= 500
                && Path::new(&name)
                    .components()
                    .all(|c| matches!(c, Component::Normal(_)))
                && !name.contains('\\'),
            "invalid_source_name"
        );
        let hash = self.store_object(&bytes)?;
        let requested = v["source_id"].as_str();
        let duplicate=self.rows("SELECT source_id,version,hash,name FROM source_versions WHERE hash=? AND (? IS NULL OR source_id=?) ORDER BY version DESC LIMIT 1",params![hash,requested,requested])?;
        if let Some(found) = duplicate.first() {
            return Ok(found.clone());
        }
        let id = requested
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        if requested.is_some() {
            ensure!(
                self.db
                    .query_row(
                        "SELECT 1 FROM source_versions WHERE source_id=? LIMIT 1",
                        [&id],
                        |_| Ok(true)
                    )
                    .optional()?
                    .unwrap_or(false),
                "source_not_found"
            );
        }
        let version: i64 = self.db.query_row(
            "SELECT COALESCE(MAX(version),0)+1 FROM source_versions WHERE source_id=?",
            [&id],
            |r| r.get(0),
        )?;
        let text = String::from_utf8(bytes)
            .ok()
            .filter(|s| !s.contains('\0'))
            .unwrap_or_default();
        let original_path = v["original_path"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("raw/{name}"));
        self.db.execute("INSERT INTO source_versions(source_id,version,name,hash,url,original_path,text,extractor,page_count,created_at) VALUES(?,?,?,?,?,?,?,'original-utf8',0,?)",params![id,version,name,hash,v["url"].as_str(),original_path,text,Utc::now().to_rfc3339()])?;
        self.index(&id, "source", version, &name, &text, None)?;
        Ok(
            json!({"source_id":id,"version":version,"hash":hash,"name":name,"original_path":original_path}),
        )
    }
    fn extraction_put(&self, v: &Value) -> Result<Value> {
        let id = required(v, "source_id")?;
        let version = v["version"].as_i64().context("version_required")?;
        let source = self.source(id, version)?;
        ensure!(source["hash"] == v["expected_hash"], "source_conflict");
        let text = required(v, "text")?;
        let extractor = required(v, "extractor")?;
        ensure!(text.len() <= 8_000_000, "extraction_too_large");
        let latest: i64 = self.db.query_row(
            "SELECT MAX(version) FROM source_versions WHERE source_id=?",
            [id],
            |r| r.get(0),
        )?;
        ensure!(latest == version, "source_conflict");
        let next = version + 1;
        self.db.execute("INSERT INTO source_versions(source_id,version,name,hash,url,original_path,text,extractor,page_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![id,next,source["name"].as_str(),source["hash"].as_str(),source["url"].as_str(),source["original_path"].as_str(),text,extractor,v["page_count"].as_i64().unwrap_or(0),Utc::now().to_rfc3339()])?;
        self.index(
            id,
            "source",
            next,
            source["name"].as_str().unwrap(),
            text,
            None,
        )?;
        Ok(
            json!({"source_id":id,"version":next,"hash":source["hash"],"extraction_hash":digest(text.as_bytes()),"based_on_version":version}),
        )
    }
    fn source(&self, id: &str, version: i64) -> Result<Value> {
        self.rows(
            "SELECT * FROM source_versions WHERE source_id=? AND version=?",
            params![id, version],
        )?
        .into_iter()
        .next()
        .context("source_not_found")
    }
    fn source_read(&self, v: &Value) -> Result<Value> {
        let id = required(v, "source_id")?;
        let version = if let Some(n) = v["version"].as_i64() {
            n
        } else {
            self.db
                .query_row(
                    "SELECT MAX(version) FROM source_versions WHERE source_id=?",
                    [id],
                    |r| r.get::<_, Option<i64>>(0),
                )?
                .context("source_not_found")?
        };
        let mut source = self.source(id, version)?;
        let path = self.root.join("objects").join(required(&source, "hash")?);
        reject_links(&path)?;
        let bytes = fs::read(path)?;
        ensure!(
            digest(&bytes) == source["hash"].as_str().unwrap(),
            "source_corrupt"
        );
        let start = v["offset"].as_u64().unwrap_or(0) as usize;
        ensure!(start <= bytes.len(), "invalid_byte_range");
        let end = (start + v["length"].as_u64().unwrap_or(1_000_000).min(1_000_000) as usize)
            .min(bytes.len());
        if v["raw"] == true {
            source["base64"] = json!(STANDARD.encode(&bytes[start..end]));
        }
        let text = source["text"].as_str().unwrap();
        let offset = v["char_offset"].as_u64().unwrap_or(0) as usize;
        let total = text.chars().count();
        ensure!(offset <= total, "invalid_char_offset");
        let part: String = text
            .chars()
            .skip(offset)
            .take(v["max_chars"].as_u64().unwrap_or(16000).clamp(128, 64000) as usize)
            .collect();
        let next = offset + part.chars().count();
        source["extraction_hash"] = json!(digest(text.as_bytes()));
        source["text"] = json!(part);
        source["truncated"] = json!(next < total);
        source["next_char_offset"] = if next < total {
            json!(next)
        } else {
            Value::Null
        };
        source["size"] = json!(bytes.len());
        source["offset"] = json!(start);
        source["next_offset"] = if end < bytes.len() {
            json!(end)
        } else {
            Value::Null
        };
        Ok(source)
    }
    fn validate_citations(&self, content: &str) -> Result<()> {
        for event in Parser::new_ext(content, Options::all()) {
            if let Event::Start(Tag::Link { dest_url, .. }) = event
                && dest_url.starts_with("source:")
            {
                let capture = SOURCE_REF.captures(&dest_url).context("invalid_citation")?;
                let version: i64 = capture[2].parse()?;
                let source = self.source(&capture[1], version)?;
                if let (Some(kind), Some(start), Some(end)) =
                    (capture.get(3), capture.get(4), capture.get(6))
                {
                    ensure!(capture[3] == capture[5], "invalid_citation");
                    let start: usize = start.as_str().parse()?;
                    let end: usize = end.as_str().parse()?;
                    let maximum = if kind.as_str() == "L" {
                        source["text"].as_str().unwrap_or_default().lines().count()
                    } else {
                        source["page_count"].as_u64().unwrap_or(0) as usize
                    };
                    ensure!(
                        start > 0 && end >= start && end <= maximum,
                        "citation_out_of_bounds"
                    );
                }
            }
        }
        Ok(())
    }
    fn index_links(&self, id: &str, content: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM links WHERE from_page=?", [id])?;
        self.db
            .execute("DELETE FROM citations WHERE page_id=?", [id])?;
        let clean = prose(content);
        let mut targets: BTreeSet<String> = WIKILINK
            .captures_iter(&clean)
            .map(|c| c[1].split('|').next().unwrap().to_string())
            .collect();
        for event in Parser::new_ext(content, Options::all()) {
            if let Event::Start(Tag::Link { dest_url, .. }) = event {
                targets.insert(dest_url.into_string());
            }
        }
        for target in targets {
            if target.starts_with("source:") {
                let c = SOURCE_REF.captures(&target).context("invalid_citation")?;
                self.db.execute(
                    "INSERT INTO citations(page_id,source_id,version,locator) VALUES(?,?,?,?)",
                    params![id, &c[1], c[2].parse::<i64>()?, target],
                )?;
            } else if target.starts_with("raw/") {
                let path = target.split('#').next().unwrap();
                if let Some(source)=self.rows("SELECT source_id,version FROM source_versions WHERE original_path=? ORDER BY version LIMIT 1",[path])?.first() {
                    self.db.execute("INSERT INTO citations(page_id,source_id,version,locator) VALUES(?,?,?,?)",params![id,source["source_id"].as_str(),source["version"].as_i64(),target])?;
                }
            } else if (!target.contains(':') || target.starts_with("page:"))
                && !target.starts_with('#')
                && !target.starts_with("mailto:")
            {
                let (path, anchor) = target.split_once('#').unwrap_or((&target, ""));
                let resolved = self.resolve_target(id, path)?;
                self.db.execute(
                    "INSERT INTO links(from_page,target_id,target_text,anchor) VALUES(?,?,?,?)",
                    params![id, resolved, path, anchor],
                )?;
            }
        }
        Ok(())
    }
    fn resolve_links(&self) -> Result<()> {
        for link in self.rows(
            "SELECT rowid AS row_id,from_page,target_text FROM links WHERE target_id IS NULL",
            [],
        )? {
            let target = self.resolve_target(
                required(&link, "from_page")?,
                required(&link, "target_text")?,
            )?;
            self.db.execute(
                "UPDATE links SET target_id=? WHERE rowid=?",
                params![target, link["row_id"].as_i64()],
            )?;
        }
        Ok(())
    }
    fn resolve_target(&self, from: &str, target: &str) -> Result<Option<String>> {
        if let Some(id) = target.strip_prefix("page:") {
            return Ok(Some(id.to_owned()));
        }
        if let Ok(path) = page_path(target)
            && let Some(id) = self
                .db
                .query_row("SELECT page_id FROM aliases WHERE path=?", [path], |r| {
                    r.get(0)
                })
                .optional()?
        {
            return Ok(Some(id));
        }
        let page = self.page(&json!({"page_id":from}))?;
        let mut relative = PathBuf::from(required(&page, "path")?)
            .parent()
            .unwrap_or(Path::new(""))
            .to_path_buf();
        for part in Path::new(target).components() {
            match part {
                Component::Normal(name) => relative.push(name),
                Component::CurDir => (),
                Component::ParentDir => {
                    if !relative.pop() {
                        return Ok(None);
                    }
                }
                _ => return Ok(None),
            }
        }
        if let Ok(path) = page_path(&relative.to_string_lossy())
            && let Some(id) = self
                .db
                .query_row("SELECT page_id FROM aliases WHERE path=?", [path], |r| {
                    r.get(0)
                })
                .optional()?
        {
            return Ok(Some(id));
        }
        if !target.contains('/') {
            let filename = page_path(target)?;
            let matches=self.rows("SELECT DISTINCT page_id FROM aliases WHERE path=? OR substr(path,-length(?)-1)='/'||?",params![filename,filename,filename])?;
            if matches.len() == 1 {
                return Ok(matches[0]["page_id"].as_str().map(str::to_owned));
            }
        }
        Ok(None)
    }
    fn links(&self, v: &Value) -> Result<Value> {
        let p = self.page(v)?;
        let id = required(&p, "page_id")?;
        let out=self.rows("SELECT l.target_id,l.target_text,l.anchor,p.path,p.title,substr(p.content,1,8192) AS title_content,p.deleted FROM links l LEFT JOIN pages p ON p.id=l.target_id WHERE l.from_page=?",[id])?;
        let backlinks=self.rows("SELECT p.id AS page_id,p.path,p.title,substr(p.content,1,8192) AS title_content FROM links l JOIN pages p ON p.id=l.from_page WHERE l.target_id=? AND p.deleted=0",[id])?;
        let citations=self.rows("SELECT c.source_id,c.version,c.locator,s.name FROM citations c JOIN source_versions s USING(source_id,version) WHERE c.page_id=?",[id])?;
        let depth = v["depth"].as_u64().unwrap_or(1).clamp(1, 3);
        let mut seen = BTreeSet::from([id.to_string()]);
        let mut queue = vec![id.to_string()];
        let mut neighbors = Vec::new();
        for _ in 0..depth {
            let mut next = Vec::new();
            for current in queue {
                for row in self.rows("SELECT DISTINCT p.id AS page_id,p.path,p.title,substr(p.content,1,8192) AS title_content FROM links l JOIN pages p ON p.id=CASE WHEN l.from_page=? THEN l.target_id ELSE l.from_page END WHERE (l.from_page=? OR l.target_id=?) AND p.deleted=0 LIMIT 50",params![current,current,current])? {let target=required(&row,"page_id")?.to_string();if seen.len()<51 && seen.insert(target.clone()){next.push(target);neighbors.push(row);}}
            }
            queue = next;
        }
        Ok(
            json!({"outlinks":out,"backlinks":backlinks,"citations":citations,"neighbors":neighbors}),
        )
    }
    fn rename(&self, v: &Value) -> Result<Value> {
        let p = self.page(v)?;
        self.check_hash(&p, v)?;
        let path = page_path(required(v, "path")?)?;
        let id = required(&p, "page_id")?;
        let old_links=self.rows("SELECT target_id,target_text,anchor FROM links WHERE from_page=? AND target_id IS NOT NULL",[id])?;
        let collision: Option<String> = self
            .db
            .query_row("SELECT page_id FROM aliases WHERE path=?", [&path], |r| {
                r.get(0)
            })
            .optional()?;
        ensure!(collision.is_none_or(|old| old == id), "path_exists");
        self.db
            .execute("UPDATE pages SET path=? WHERE id=?", params![path, id])?;
        self.db.execute(
            "INSERT OR IGNORE INTO aliases(path,page_id) VALUES(?,?)",
            params![path, id],
        )?;
        self.resolve_links()?;
        let saved=self.put(&json!({"page_id":id,"content":p["content"],"expected_hash":p["hash"],"title":v["title"].as_str().unwrap_or(p["title"].as_str().unwrap())}))?;
        for link in old_links {
            self.db.execute(
                "UPDATE links SET target_id=? WHERE from_page=? AND target_text=? AND anchor=?",
                params![
                    link["target_id"].as_str(),
                    id,
                    link["target_text"].as_str(),
                    link["anchor"].as_str()
                ],
            )?;
        }
        Ok(saved)
    }
    fn delete(&self, v: &Value) -> Result<Value> {
        let p = self.page(v)?;
        self.check_hash(&p, v)?;
        let id = required(&p, "page_id")?;
        let revision = Uuid::new_v4().to_string();
        let hash = digest(format!("{}:{revision}:deleted", p["hash"]).as_bytes());
        self.db.execute(
            "UPDATE pages SET deleted=1,hash=? WHERE id=?",
            params![hash, id],
        )?;
        self.db.execute("INSERT INTO revisions(id,page_id,content,hash,title,path,deleted,created_at) VALUES(?,?,?,?,?,?,1,?)",params![revision,id,p["content"].as_str(),hash,p["title"].as_str(),p["path"].as_str(),Utc::now().to_rfc3339()])?;
        Ok(json!({"page_id":id,"deleted":true,"hash":hash,"revision_id":revision}))
    }
    fn history(&self, v: &Value) -> Result<Value> {
        let p = self.page(v)?;
        Ok(
            json!({"revisions":self.rows("SELECT id AS revision_id,hash,title,path,deleted,created_at FROM revisions WHERE page_id=? ORDER BY rowid DESC LIMIT 100",[required(&p,"page_id")?])?}),
        )
    }
    fn revision(&self, v: &Value) -> Result<Value> {
        self.rows(
            "SELECT * FROM revisions WHERE id=?",
            [required(v, "revision_id")?],
        )?
        .into_iter()
        .next()
        .context("revision_not_found")
    }
    fn diff(&self, v: &Value) -> Result<Value> {
        let r = self.revision(v)?;
        let p = self.page(&json!({"page_id":r["page_id"]}))?;
        Ok(
            json!({"before":r["content"],"after":p["content"],"before_hash":r["hash"],"after_hash":p["hash"]}),
        )
    }
    fn restore_revision(&self, v: &Value) -> Result<Value> {
        let r = self.revision(v)?;
        self.put(&json!({"page_id":r["page_id"],"content":r["content"],"title":r["title"],"expected_hash":v["expected_hash"]}))
    }
    fn draft(&self, v: &Value) -> Result<Value> {
        let p = self.page(v)?;
        self.check_hash(&p, v)?;
        let content = v["content"].as_str().context("content_required")?;
        ensure!(content.len() <= 2_000_000, "page_too_large");
        self.validate_citations(content)?;
        let id = Uuid::new_v4().to_string();
        self.db.execute(
            "INSERT INTO drafts(id,page_id,content,expected_hash,created_at) VALUES(?,?,?,?,?)",
            params![
                id,
                p["page_id"].as_str(),
                content,
                p["hash"].as_str(),
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(json!({"draft_id":id,"hash":digest(content.as_bytes())}))
    }
    fn approve(&self, v: &Value) -> Result<Value> {
        let id = required(v, "draft_id")?;
        let d = self
            .rows("SELECT * FROM drafts WHERE id=?", [id])?
            .into_iter()
            .next()
            .context("draft_not_found")?;
        let p = self.page(&json!({"page_id":d["page_id"]}))?;
        self.check_hash(&p, v)?;
        ensure!(d["expected_hash"] == v["expected_hash"], "page_conflict");
        let saved=self.put(&json!({"page_id":d["page_id"],"content":d["content"],"expected_hash":d["expected_hash"]}))?;
        self.db.execute("DELETE FROM drafts WHERE id=?", [id])?;
        Ok(saved)
    }
    fn vector(&self, v: &Value) -> Result<Vec<u8>> {
        let values = v.as_array().context("invalid_vector")?;
        ensure!(!values.is_empty() && values.len() <= 4096, "invalid_vector");
        let mut result = Vec::new();
        let mut norm = 0.0;
        for value in values {
            let f = value.as_f64().context("invalid_vector")? as f32;
            ensure!(f.is_finite(), "invalid_vector");
            norm += f * f;
            result.extend(f.to_le_bytes());
        }
        ensure!(norm > 0.0 && norm.is_finite(), "invalid_vector");
        Ok(result)
    }
    fn embedding_pending(&self, v: &Value) -> Result<Value> {
        Ok(
            json!({"chunks":self.rows("SELECT DISTINCT hash,embedding_text FROM chunks c WHERE NOT EXISTS(SELECT 1 FROM embeddings e WHERE e.hash=c.hash AND e.model=?) ORDER BY hash LIMIT ?",params![required(v,"model")?,v["limit"].as_i64().unwrap_or(100).clamp(1,100)])?}),
        )
    }
    fn embedding_put(&self, v: &Value) -> Result<Value> {
        let model = required(v, "model")?;
        let items = v["items"].as_array().context("items_required")?;
        ensure!(items.len() <= 100, "batch_too_large");
        for item in items {
            let hash = required(item, "hash")?;
            ensure!(
                self.db
                    .query_row("SELECT 1 FROM chunks WHERE hash=? LIMIT 1", [hash], |_| Ok(
                        true
                    ))
                    .optional()?
                    .unwrap_or(false),
                "chunk_changed"
            );
            let bytes = self.vector(&item["vector"])?;
            let dims = bytes.len() / 4;
            self.db.execute(
                "INSERT OR IGNORE INTO embedding_models(model,dimensions) VALUES(?,?)",
                params![model, dims as i64],
            )?;
            let current: i64 = self.db.query_row(
                "SELECT dimensions FROM embedding_models WHERE model=?",
                [model],
                |r| r.get(0),
            )?;
            ensure!(current as usize == dims, "vector_dimension_mismatch");
            self.db.execute(
                "INSERT OR REPLACE INTO embeddings(hash,model,vector) VALUES(?,?,?)",
                params![hash, model, bytes],
            )?;
        }
        Ok(json!({"indexed":items.len()}))
    }
    fn diagnose(&self) -> Result<Value> {
        let mut findings = Vec::new();
        for s in self.rows(
            "SELECT source_id,version,hash,name,original_path FROM source_versions",
            [],
        )? {
            let path = self.root.join("objects").join(required(&s, "hash")?);
            if reject_links(&path).is_err()
                || fs::read(&path)
                    .map(|b| digest(&b) != s["hash"].as_str().unwrap())
                    .unwrap_or(true)
            {
                findings.push(json!({"code":"source_corrupt","source_id":s["source_id"],"version":s["version"],"name":s["name"],"original_path":s["original_path"]}));
            }
        }
        for row in self.rows("SELECT DISTINCT c.page_id,c.source_id,c.version,s.name,s.original_path,(SELECT MAX(version) FROM source_versions latest WHERE latest.source_id=c.source_id) AS latest_version FROM citations c JOIN source_versions s ON s.source_id=c.source_id AND s.version=c.version WHERE c.version<(SELECT MAX(version) FROM source_versions latest WHERE latest.source_id=c.source_id)",[])?{findings.push(json!({"code":"stale_source","details":row}));}
        for row in self.rows("SELECT source_id,version,name,original_path FROM source_versions s WHERE version=(SELECT MAX(version) FROM source_versions latest WHERE latest.source_id=s.source_id) AND NOT EXISTS(SELECT 1 FROM citations c WHERE c.source_id=s.source_id)",[])?{findings.push(json!({"code":"unpaged_source","details":row}));}
        for row in self.rows("SELECT from_page,target_text FROM links l LEFT JOIN pages p ON p.id=l.target_id WHERE l.target_id IS NULL OR p.id IS NULL OR p.deleted=1",[])?{findings.push(json!({"code":"unresolved_link","details":row}));}
        for row in self.rows("SELECT id AS page_id,path FROM pages p WHERE deleted=0 AND NOT EXISTS(SELECT 1 FROM links l WHERE l.target_id=p.id OR l.from_page=p.id)",[])?{findings.push(json!({"code":"orphan_page","details":row}));}
        for p in self.rows(
            "SELECT id AS page_id,content FROM pages WHERE deleted=0",
            [],
        )? {
            if let Err(e) = self.validate_citations(p["content"].as_str().unwrap_or_default()) {
                findings.push(json!({"code":"invalid_citation","page_id":p["page_id"],"message":e.to_string()}));
            }
        }
        for l in self.rows("SELECT from_page,target_id,anchor,p.content FROM links l JOIN pages p ON p.id=l.target_id WHERE l.anchor!='' AND p.deleted=0",[])? {
            let anchor=required(&l,"anchor")?;if !sections(l["content"].as_str().unwrap()).iter().any(|s|s.heading==anchor || normalize_text(&s.heading).replace(' ',"-")==anchor){findings.push(json!({"code":"missing_anchor","page_id":l["from_page"],"target_id":l["target_id"],"anchor":anchor}));}
        }
        Ok(
            json!({"findings":findings,"integrity":self.db.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0))?}),
        )
    }
    fn output_dir(&self, v: &Value) -> Result<PathBuf> {
        let path = PathBuf::from(required(v, "output")?);
        ensure!(path.is_absolute(), "output_must_be_absolute");
        reject_links(&path)?;
        ensure!(!path.starts_with(&self.root), "output_must_be_outside_wiki");
        ensure!(!path.exists(), "output_exists");
        fs::create_dir_all(&path)?;
        Ok(path)
    }
    fn backup(&self, v: &Value) -> Result<Value> {
        let output = self.output_dir(v)?;
        let mut target = Connection::open(output.join("knowledge.sqlite"))?;
        rusqlite::backup::Backup::new(&self.db, &mut target)?.run_to_completion(
            1000,
            Duration::from_millis(1),
            None,
        )?;
        fs::create_dir(output.join("objects"))?;
        for s in self.rows("SELECT DISTINCT hash FROM source_versions", [])? {
            let hash = required(&s, "hash")?;
            let origin = self.root.join("objects").join(hash);
            reject_links(&origin)?;
            let bytes = fs::read(origin)?;
            ensure!(digest(&bytes) == hash, "source_corrupt");
            fs::write(output.join("objects").join(hash), bytes)?;
        }
        fs::write(
            output.join("manifest.json"),
            serde_json::to_vec_pretty(
                &json!({"schema_version":1,"created_at":Utc::now().to_rfc3339(),"database_hash":digest(&fs::read(output.join("knowledge.sqlite"))?)}),
            )?,
        )?;
        Ok(json!({"output":output,"backup":true}))
    }
    fn restore_backup(&self, v: &Value) -> Result<Value> {
        let origin = PathBuf::from(required(v, "from")?);
        reject_links(&origin)?;
        reject_links(&origin.join("knowledge.sqlite"))?;
        reject_links(&origin.join("knowledge.sqlite-wal"))?;
        reject_links(&origin.join("knowledge.sqlite-shm"))?;
        reject_links(&origin.join("manifest.json"))?;
        let manifest: Value = serde_json::from_slice(&fs::read(origin.join("manifest.json"))?)?;
        ensure!(
            manifest["database_hash"] == digest(&fs::read(origin.join("knowledge.sqlite"))?),
            "backup_corrupt"
        );
        let src = Connection::open_with_flags(
            origin.join("knowledge.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        ensure!(
            src.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))? == "ok",
            "backup_corrupt"
        );
        ensure!(
            src.pragma_query_value::<i64, _>(None, "user_version", |r| r.get(0))? == 1,
            "unsupported_wiki_schema"
        );
        ensure!(
            src.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))? == 0,
            "backup_corrupt"
        );
        let hashes = src
            .prepare("SELECT DISTINCT hash FROM source_versions")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for hash in hashes {
            ensure!(
                hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid_source_hash"
            );
            let file = origin.join("objects").join(&hash);
            reject_links(&file)?;
            let bytes = fs::read(file)?;
            ensure!(digest(&bytes) == hash, "backup_corrupt");
            self.store_object(&bytes)?;
        }
        // Copy validated rows inside the current transaction, retaining no external path attachment.
        self.db.execute(
            "ATTACH DATABASE ? AS incoming",
            [origin.join("knowledge.sqlite").to_string_lossy().as_ref()],
        )?;
        self.db.execute_batch("DELETE FROM drafts;DELETE FROM citations;DELETE FROM links;DELETE FROM aliases;DELETE FROM revisions;DELETE FROM chunk_fts;DELETE FROM chunks;DELETE FROM embeddings;DELETE FROM embedding_models;DELETE FROM pages;DELETE FROM source_versions;")?;
        for table in [
            "pages",
            "aliases",
            "source_versions",
            "revisions",
            "links",
            "citations",
            "chunks",
            "short_grams",
            "embedding_models",
            "embeddings",
            "drafts",
        ] {
            self.db.execute_batch(&format!(
                "INSERT INTO {table} SELECT * FROM incoming.{table};"
            ))?;
        }
        self.db.execute_batch("INSERT INTO chunk_fts(rowid,title,heading,normalized) SELECT id,title,heading,normalized FROM chunks;")?;
        Ok(json!({"restored":true}))
    }
    fn export(&self, v: &Value) -> Result<Value> {
        let output = self.output_dir(v)?;
        fs::create_dir(output.join("wiki"))?;
        fs::create_dir(output.join("raw"))?;
        let pages = self.rows(
            "SELECT id AS page_id,path,title,hash,content FROM pages WHERE deleted=0",
            [],
        )?;
        for p in &pages {
            let path = output.join("wiki").join(page_path(required(p, "path")?)?);
            fs::create_dir_all(path.parent().unwrap())?;
            fs::write(path, self.export_content(p)?)?;
        }
        let sources = self.rows("SELECT * FROM source_versions", [])?;
        for s in &sources {
            let hash = required(s, "hash")?;
            ensure!(
                hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid_source_hash"
            );
            let file = self.root.join("objects").join(hash);
            reject_links(&file)?;
            let bytes = fs::read(file)?;
            ensure!(digest(&bytes) == hash, "source_corrupt");
            let name = self.export_source_name(s)?;
            fs::write(output.join("raw").join(name), bytes)?;
        }
        fs::write(
            output.join("pages.json"),
            serde_json::to_vec_pretty(&pages)?,
        )?;
        fs::write(
            output.join("aliases.json"),
            serde_json::to_vec_pretty(&self.rows("SELECT * FROM aliases", [])?)?,
        )?;
        fs::write(
            output.join("sources.json"),
            serde_json::to_vec_pretty(&sources)?,
        )?;
        Ok(json!({"output":output,"exported":true}))
    }
    fn export_source_name(&self, source: &Value) -> Result<String> {
        let id = required(source, "source_id")?;
        Uuid::parse_str(id).context("invalid_source_id")?;
        let name = Path::new(required(source, "name")?)
            .file_name()
            .context("invalid_source_name")?
            .to_string_lossy();
        Ok(format!("{id}-{}-{name}", source["version"]))
    }
    fn export_link(&self, page: &Value, target: &str) -> Result<Option<String>> {
        let (base, anchor) = target.split_once('#').unwrap_or((target, ""));
        let destination = if base.starts_with("source:") {
            let c = SOURCE_REF.captures(base).context("invalid_citation")?;
            Some(
                PathBuf::from("raw")
                    .join(self.export_source_name(&self.source(&c[1], c[2].parse()?)?)?),
            )
        } else if base.starts_with("raw/") {
            self.rows(
                "SELECT * FROM source_versions WHERE original_path=? ORDER BY version LIMIT 1",
                [base],
            )?
            .first()
            .map(|s| {
                self.export_source_name(s)
                    .map(|name| PathBuf::from("raw").join(name))
            })
            .transpose()?
        } else if !base.is_empty() && (!base.contains(':') || base.starts_with("page:")) {
            self.resolve_target(required(page, "page_id")?, base)?
                .and_then(|id| self.page(&json!({"page_id":id})).ok())
                .filter(|p| p["deleted"] == 0)
                .map(|p| PathBuf::from("wiki").join(p["path"].as_str().unwrap()))
        } else {
            None
        };
        if let Some(destination) = destination {
            let from = PathBuf::from("wiki").join(required(page, "path")?);
            let parent = from.parent().unwrap();
            let a: Vec<_> = parent.components().collect();
            let b: Vec<_> = destination.components().collect();
            let common = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
            let mut relative = PathBuf::new();
            for _ in common..a.len() {
                relative.push("..");
            }
            for part in b.iter().skip(common) {
                relative.push(part.as_os_str());
            }
            let mut href = relative
                .to_string_lossy()
                .replace('\\', "/")
                .replace(' ', "%20")
                .replace('(', "%28")
                .replace(')', "%29");
            if !anchor.is_empty() {
                href.push('#');
                href.push_str(anchor);
            }
            return Ok(Some(href));
        }
        Ok(None)
    }
    fn export_content(&self, page: &Value) -> Result<String> {
        let content = page["content"].as_str().unwrap_or_default();
        let clean = prose(content);
        let mut changes = Vec::new();
        for c in WIKILINK.captures_iter(&clean) {
            let whole = c.get(0).unwrap();
            let (target, label) = c[1].split_once('|').unwrap_or((&c[1], &c[1]));
            if let Some(href) = self.export_link(page, target)? {
                changes.push((
                    whole.range(),
                    format!(
                        "[{}]({href})",
                        label.replace('[', "\\[").replace(']', "\\]")
                    ),
                ));
            }
        }
        for (event, range) in Parser::new_ext(content, Options::all()).into_offset_iter() {
            if let Event::Start(Tag::Link { dest_url, .. }) = event {
                let fragment = &content[range.clone()];
                if fragment.starts_with("[[") {
                    continue;
                }
                if let Some(href) = self.export_link(page, &dest_url)?
                    && let Some(start) = fragment.rfind(dest_url.as_ref())
                {
                    changes.push((
                        range.start + start..range.start + start + dest_url.len(),
                        href,
                    ));
                }
            }
        }
        changes.sort_by_key(|b| std::cmp::Reverse(b.0.start));
        let mut output = content.to_owned();
        let mut boundary = content.len();
        for (range, text) in changes {
            if range.end <= boundary {
                boundary = range.start;
                output.replace_range(range, &text);
            }
        }
        Ok(output)
    }
    fn migrate(&self, v: &Value) -> Result<Value> {
        let vault = PathBuf::from(required(v, "from")?);
        ensure!(vault.is_absolute(), "vault_must_be_absolute");
        reject_links(&vault)?;
        let manifests = vault.join(".llm-wiki/sources");
        reject_links(&manifests)?;
        ensure!(manifests.is_dir(), "invalid_vault");
        let mut imported = 0;
        let mut source_hashes = Vec::new();
        let mut inputs = Vec::new();
        let dry = v["dry_run"] == true;
        for entry in fs::read_dir(manifests)? {
            let file = entry?.path();
            reject_links(&file)?;
            let manifest: Value = serde_json::from_slice(&fs::read(&file)?)?;
            let relative = required(&manifest, "path")?;
            ensure!(
                relative.starts_with("raw/")
                    && Path::new(relative)
                        .components()
                        .all(|p| matches!(p, Component::Normal(_))),
                "invalid_path"
            );
            let origin = vault.join(relative);
            reject_links(&origin)?;
            let hash = digest(&fs::read(&origin)?);
            ensure!(manifest["sha256"] == hash, "source_corrupt");
            source_hashes.push((origin.clone(), hash));
            inputs.push(json!({"file":origin,"name":Path::new(relative).file_name().unwrap_or_default().to_string_lossy(),"original_path":relative,"url":manifest["source_url"]}));
        }
        let mut queue = vec![vault.join("wiki")];
        let mut pages = Vec::new();
        while let Some(dir) = queue.pop() {
            reject_links(&dir)?;
            for entry in fs::read_dir(dir)? {
                let path = entry?.path();
                reject_links(&path)?;
                if path.is_dir() {
                    queue.push(path);
                } else if path.extension().is_some_and(|x| x == "md") {
                    let content = fs::read_to_string(&path)?;
                    pages.push((path, content));
                }
            }
        }
        if dry {
            return Ok(
                json!({"dry_run":true,"pages":pages.len(),"sources":inputs.len(),"source_vault_unchanged":true}),
            );
        }
        for input in &inputs {
            self.ingest(input)?;
        }
        for (path, content) in &pages {
            let relative = path.strip_prefix(&vault)?.to_string_lossy();
            self.put(&json!({"path":relative,"content":content}))?;
            imported += 1;
        }
        for (path, hash) in source_hashes {
            ensure!(
                digest(&fs::read(path)?) == hash,
                "vault_changed_during_migration"
            );
        }
        for (path, content) in pages {
            ensure!(
                fs::read_to_string(path)? == content,
                "vault_changed_during_migration"
            );
        }
        Ok(
            json!({"imported_pages":imported,"imported_sources":inputs.len(),"source_vault_unchanged":true,"diagnostics":self.diagnose()?}),
        )
    }
}
