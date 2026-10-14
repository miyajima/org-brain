//! Bounded folder import. The catalog and source write commit together; rerunning
//! after interruption reuses completed files and versions, without a sidecar DB.
use super::*;
use ignore::gitignore::{Gitignore, GitignoreBuilder};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS folder_catalog(
 folder_id TEXT NOT NULL,root TEXT NOT NULL,path TEXT NOT NULL,format TEXT NOT NULL,
 status TEXT NOT NULL,reason TEXT,bytes INTEGER NOT NULL,source_id TEXT,version INTEGER,
 hash TEXT,checked_at TEXT NOT NULL,PRIMARY KEY(folder_id,path));";
const MAX_ENTRIES: usize = 10_000;
const MAX_FILE_BYTES: u64 = 1_000_000;
const MAX_BATCH_BYTES: u64 = 8_000_000;
const GENERATED: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "Library",
    "Temp",
    "obj",
    "__pycache__",
];

struct Entry {
    file: PathBuf,
    path: String,
    reason: Option<&'static str>,
    bytes: u64,
    modified: String,
}

fn walk(
    dir: &Path,
    root: &Path,
    wiki: &Path,
    parents: &[Gitignore],
    entries: &mut Vec<Entry>,
    visited: &mut usize,
    depth: usize,
) -> Result<()> {
    ensure!(depth <= 64, "folder_depth_exceeded");
    reject_links(dir)?;
    let mut builder = GitignoreBuilder::new(dir);
    for name in [".gitignore", ".orgbrainignore"] {
        let path = dir.join(name);
        if path.exists() {
            reject_links(&path)?;
            ensure!(
                fs::metadata(&path)?.len() <= 65_536,
                "ignore_file_too_large"
            );
            if let Some(error) = builder.add(path) {
                return Err(error.into());
            }
        }
    }
    let mut matchers = parents.to_vec();
    matchers.push(builder.build()?);
    let mut children = fs::read_dir(dir)?
        .take(MAX_ENTRIES + 1)
        .collect::<std::io::Result<Vec<_>>>()?;
    ensure!(children.len() <= MAX_ENTRIES, "folder_entry_limit_exceeded");
    children.sort_by_key(|e| e.file_name());
    for child in children {
        *visited += 1;
        ensure!(*visited <= MAX_ENTRIES, "folder_entry_limit_exceeded");
        let file = child.path();
        let metadata = fs::symlink_metadata(&file)?;
        let is_dir = metadata.is_dir();
        let name = child.file_name();
        let name = name.to_string_lossy();
        let mut ignored = false;
        for matcher in &matchers {
            let matched = matcher.matched_path_or_any_parents(&file, is_dir);
            if matched.is_ignore() {
                ignored = true;
            }
            if matched.is_whitelist() {
                ignored = false;
            }
        }
        let reason = if metadata.file_type().is_symlink() {
            Some("symlink")
        } else if file.starts_with(wiki) {
            Some("wiki_storage")
        } else if name.starts_with('.') {
            Some("hidden")
        } else if is_dir && GENERATED.contains(&name.as_ref()) {
            Some("generated_directory")
        } else if ignored {
            Some("ignore_rule")
        } else if !is_dir && !metadata.is_file() {
            Some("not_regular_file")
        } else if file.to_str().is_none() {
            Some("non_utf8_path")
        } else if name.contains('\\') {
            Some("invalid_source_name")
        } else {
            None
        };
        if is_dir && reason.is_none() {
            walk(&file, root, wiki, &matchers, entries, visited, depth + 1)?;
        } else {
            entries.push(Entry {
                path: file
                    .strip_prefix(root)?
                    .to_string_lossy()
                    .replace('\\', "/"),
                file,
                reason,
                bytes: if is_dir { 0 } else { metadata.len() },
                modified: format!("{:?}", metadata.modified().ok()),
            });
        }
    }
    Ok(())
}

impl Wiki {
    pub(super) fn ingest_folder(&self, v: &Value) -> Result<Value> {
        let folder = Path::new(required(v, "folder")?);
        ensure!(folder.is_absolute(), "folder_must_be_absolute");
        reject_links(folder)?;
        let root = folder.canonicalize()?;
        ensure!(root.is_dir(), "folder_required");
        ensure!(!root.starts_with(&self.root), "wiki_storage_rejected");
        let root_text = root.to_str().context("non_utf8_path")?;
        let folder_id = digest(root_text.as_bytes());
        let mut entries = Vec::new();
        walk(&root, &root, &self.root, &[], &mut entries, &mut 0, 0)?;
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        let scan_id = digest(
            serde_json::to_string(
                &entries
                    .iter()
                    .map(|e| (&e.path, e.bytes, &e.modified, e.reason))
                    .collect::<Vec<_>>(),
            )?
            .as_bytes(),
        );
        if let Some(previous) = v["scan_id"].as_str() {
            ensure!(
                previous == scan_id,
                "folder_changed: rerun import from the beginning"
            );
        }
        let offset = v["offset"].as_u64().unwrap_or(0) as usize;
        ensure!(offset <= entries.len(), "invalid_offset");
        let limit = v["limit"].as_u64().unwrap_or(50).clamp(1, 100) as usize;
        let dry_run = v["dry_run"] == true;
        if !dry_run {
            self.db.execute_batch(SCHEMA)?;
        }
        let mut results = Vec::new();
        let mut read_bytes = 0;
        for entry in entries.iter().skip(offset).take(limit) {
            if read_bytes + entry.bytes.min(MAX_FILE_BYTES) > MAX_BATCH_BYTES {
                break;
            }
            let ext = entry
                .file
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            let format = match ext.as_str() {
                "md" | "markdown" => "markdown",
                "txt" | "text" => "text",
                _ => "unsupported",
            };
            let mut reason = entry.reason;
            if reason.is_none() && format == "unsupported" {
                reason = Some("unsupported_format");
            }
            if reason.is_none() && entry.bytes > MAX_FILE_BYTES {
                reason = Some("file_too_large");
            }
            if reason.is_none() && entry.file.file_name().unwrap().to_string_lossy().len() > 500 {
                reason = Some("name_too_long");
            }
            // UUID-shaped deterministic identity also satisfies source export contracts.
            let identity = Sha256::digest(format!("{folder_id}\0{}", entry.path).as_bytes());
            let source_id = Uuid::from_bytes(identity[..16].try_into().unwrap()).to_string();
            let mut result = json!({"path":entry.path,"format":format,"bytes":entry.bytes,"status":"skipped","reason":reason});
            if reason.is_none() {
                // Repeat path checks immediately before reading; never follow selected links.
                reject_links(&entry.file)?;
                ensure!(fs::metadata(&entry.file)?.is_file(), "folder_changed");
                let bytes = {
                    use std::io::Read;
                    let mut bytes = Vec::new();
                    fs::File::open(&entry.file)?
                        .take(MAX_FILE_BYTES + 1)
                        .read_to_end(&mut bytes)?;
                    bytes
                };
                read_bytes += bytes.len() as u64;
                reason = if bytes.len() as u64 > MAX_FILE_BYTES {
                    Some("file_too_large")
                } else if bytes.contains(&0) {
                    Some("binary_content")
                } else if std::str::from_utf8(&bytes).is_err() {
                    Some("invalid_utf8")
                } else {
                    None
                };
                result["reason"] = json!(reason);
                if reason.is_none() {
                    let latest = self.rows("SELECT version,hash FROM source_versions WHERE source_id=? ORDER BY version DESC LIMIT 1", [&source_id])?;
                    let hash = digest(&bytes);
                    let unchanged = latest.first().is_some_and(|row| row["hash"] == hash);
                    if dry_run {
                        result["status"] = json!(if unchanged {
                            "unchanged"
                        } else {
                            "would_import"
                        });
                        result["source_id"] = json!(source_id);
                        result["hash"] = json!(hash);
                    } else {
                        let receipt = self.ingest_original(
                            &bytes,
                            entry
                                .file
                                .file_name()
                                .unwrap()
                                .to_str()
                                .context("non_utf8_path")?,
                            Some(&source_id),
                            entry.file.to_str().unwrap(),
                            None,
                            true,
                        )?;
                        for field in ["source_id", "version", "hash"] {
                            result[field] = receipt[field].clone();
                        }
                        result["status"] = json!(if unchanged { "unchanged" } else { "imported" });
                    }
                }
            }
            if !dry_run {
                self.db.execute("INSERT INTO folder_catalog(folder_id,root,path,format,status,reason,bytes,source_id,version,hash,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(folder_id,path) DO UPDATE SET format=excluded.format,status=excluded.status,reason=excluded.reason,bytes=excluded.bytes,source_id=COALESCE(excluded.source_id,folder_catalog.source_id),version=COALESCE(excluded.version,folder_catalog.version),hash=COALESCE(excluded.hash,folder_catalog.hash),checked_at=excluded.checked_at", params![folder_id,root_text,entry.path,format,result["status"].as_str(),result["reason"].as_str(),i64::try_from(entry.bytes)?,result["source_id"].as_str(),result["version"].as_i64(),result["hash"].as_str(),Utc::now().to_rfc3339()])?;
            }
            results.push(result);
        }
        let next = offset + results.len();
        // Originals remain immutable and searchable even when their external file
        // disappears. The catalog reports that distinction rather than deleting evidence.
        if !dry_run && next == entries.len() {
            let existing = self.rows(
                "SELECT path FROM folder_catalog WHERE folder_id=?",
                [&folder_id],
            )?;
            let paths: BTreeSet<_> = entries.iter().map(|e| e.path.as_str()).collect();
            for row in existing {
                let path = row["path"].as_str().unwrap();
                if !paths.contains(path) {
                    self.db.execute("UPDATE folder_catalog SET status='missing',reason='not_in_latest_scan',checked_at=? WHERE folder_id=? AND path=?", params![Utc::now().to_rfc3339(),folder_id,path])?;
                }
            }
        }
        Ok(
            json!({"folder_id":folder_id,"scan_id":scan_id,"dry_run":dry_run,"total_entries":entries.len(),"entries":results,"next_offset":if next < entries.len(){Some(next)}else{None},"truncated":next < entries.len()}),
        )
    }

    pub(super) fn folder_catalog(&self, v: &Value) -> Result<Value> {
        let exists: bool = self.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='folder_catalog')", [], |r| r.get(0))?;
        if !exists {
            return Ok(json!({"entries":[],"summary":[],"truncated":false,"next_offset":null}));
        }
        let limit = v["limit"].as_i64().unwrap_or(50).clamp(1, 100);
        let offset = v["offset"].as_i64().unwrap_or(0);
        ensure!(offset >= 0, "invalid_offset");
        let folder = v["folder_id"].as_str();
        let cols = "c.folder_id,c.root,c.path,c.format,c.status,c.reason,c.bytes,c.source_id,c.version,c.hash,c.checked_at,(SELECT MAX(version) FROM source_versions WHERE source_id=c.source_id) AS latest_source_version,EXISTS(SELECT 1 FROM chunks WHERE owner=c.source_id AND kind='source') AS searchable";
        let mut entries = self.rows(&format!("SELECT {cols} FROM folder_catalog c WHERE (? IS NULL OR folder_id=?) ORDER BY folder_id,path LIMIT ? OFFSET ?"), params![folder,folder,limit+1,offset])?;
        let more = entries.len() > limit as usize;
        if more {
            entries.pop();
        }
        for entry in &mut entries {
            entry["searchable"] = json!(entry["searchable"] == 1);
        }
        let mut summary = self.rows("SELECT folder_id,root,format,status,COUNT(*) AS count,SUM(bytes) AS bytes FROM folder_catalog WHERE (? IS NULL OR folder_id=?) GROUP BY folder_id,root,format,status ORDER BY folder_id,format,status LIMIT 101", params![folder,folder])?;
        let summary_truncated = summary.len() > 100;
        summary.truncate(100);
        Ok(
            json!({"entries":entries,"summary":summary,"summary_truncated":summary_truncated,"truncated":more,"next_offset":if more{Some(offset+limit)}else{None}}),
        )
    }
}
