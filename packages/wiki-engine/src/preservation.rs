use super::*;

impl Wiki {
    fn preservation_items(&self, text: &str) -> Result<Vec<Value>> {
        ensure!(
            !text.trim().is_empty() && text.len() <= 256_000,
            "invalid_capture_text"
        );
        let rules = [
            ("number_or_identifier", r"[0-9０-９]"),
            (
                "decision_or_reason",
                r"(?i)決定|採用|理由|原因|判断|because|reason|decision",
            ),
            (
                "condition",
                r"(?i)条件|場合|ただし|限り|対象|例外|only if|unless|condition",
            ),
            (
                "state",
                r"(?i)未確認|未検証|未実施|未配備|保留|待ち|不明|成功|完了|失敗|保存済|pending|unverified|unknown|not deployed",
            ),
            (
                "correction",
                r"(?i)訂正|修正|取り消|変更|以前|当時|correction|supersed",
            ),
        ];
        let rules = rules
            .into_iter()
            .map(|(name, pattern)| Ok((name, Regex::new(pattern)?)))
            .collect::<Result<Vec<_>>>()?;
        let lines: Vec<&str> = text.lines().collect();
        let mut selected = BTreeSet::new();
        for (i, line) in lines.iter().enumerate() {
            if rules.iter().any(|(_, r)| r.is_match(line)) {
                selected.insert(i);
                // Preserve the adjacent explanation/qualification with the signal.
                if i > 0 && !lines[i - 1].trim().is_empty() {
                    selected.insert(i - 1);
                }
                if i + 1 < lines.len() && !lines[i + 1].trim().is_empty() {
                    selected.insert(i + 1);
                }
            }
        }
        ensure!(selected.len() <= 512, "capture_inventory_too_large");
        Ok(selected
            .into_iter()
            .map(|i| {
                let categories: Vec<&str> = rules
                    .iter()
                    .filter(|(_, r)| r.is_match(lines[i]))
                    .map(|(name, _)| *name)
                    .collect();
                json!({"start_line":i+1,"end_line":i+1,"text":lines[i],"categories":categories})
            })
            .collect())
    }

    pub(super) fn capture_audit(&self, v: &Value) -> Result<Value> {
        let text = required(v, "text")?;
        let summary = v["summary"].as_str().context("summary_required")?;
        let items = self.preservation_items(text)?;
        let normalized = normalize_text(summary);
        let missing: Vec<Value> = items
            .iter()
            .filter(|item| !normalized.contains(&normalize_text(item["text"].as_str().unwrap())))
            .cloned()
            .collect();
        Ok(
            json!({"inventory_count":items.len(),"missing_count":missing.len(),"missing":missing,
            "items":items,"basis":"rule_selected_source_lines_with_adjacent_context",
            "semantic_completeness_verified":false,"original_hash":digest(text.as_bytes())}),
        )
    }

    pub(super) fn capture(&self, v: &Value) -> Result<Value> {
        let text = if let Some(file) = v["file"].as_str() {
            let file = Path::new(file);
            reject_links(file)?;
            ensure!(fs::metadata(file)?.len() <= 256_000, "invalid_capture_text");
            fs::read_to_string(file)?
        } else {
            required(v, "text")?.to_owned()
        };
        let summary = v["summary"].as_str().context("summary_required")?;
        ensure!(summary.len() <= 256_000, "capture_summary_too_large");
        let origin = &v["origin"];
        ensure!(
            origin.is_null() || origin.is_object(),
            "invalid_capture_origin"
        );
        if let Some(fields) = origin.as_object() {
            for (name, value) in fields {
                ensure!(
                    ["session_id", "turn_id", "recorded_at"].contains(&name.as_str())
                        && value
                            .as_str()
                            .is_some_and(|s| !s.is_empty() && s.len() <= 256),
                    "invalid_capture_origin"
                );
            }
            if let Some(time) = origin["recorded_at"].as_str() {
                chrono::DateTime::parse_from_rfc3339(time)
                    .context("invalid_capture_origin_time")?;
            }
        }
        let audit = self.capture_audit(&json!({"text":text,"summary":summary}))?;
        let mut ingest = v.clone();
        if ingest["name"].is_null()
            && let Some(file) = v["file"].as_str()
        {
            ingest["name"] = json!(
                Path::new(file)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .context("name_required")?
            );
        }
        ingest.as_object_mut().unwrap().remove("file");
        ingest["text"] = json!(text);
        let source = self.ingest(&ingest)?;
        let sid = source["source_id"].as_str().unwrap();
        let version = source["version"].as_i64().unwrap();
        let manifest = json!({"schema":"wiki-report-preservation/v1","origin":origin,"original":{"source_id":sid,"version":version,"hash":source["hash"]},"verification_state":"reported_unverified","items":audit["items"],"semantic_completeness_verified":false});
        let manifest_text = serde_json::to_string_pretty(&manifest)?;
        let inventory = self.ingest_original(
            manifest_text.as_bytes(),
            "report-inventory.json",
            None,
            &format!(
                "raw/report-inventory-{}.json",
                digest(manifest_text.as_bytes())
            ),
            None,
            false,
        )?;
        let mut content = format!(
            "{summary}\n\n## 保存した原文と出典\n\n[原本](source:{sid}@{version})\n[重要事項と出典位置](source:{}@{})\n\n状態: reported_unverified（過去の報告。実行成功の独立した証明ではない）\n",
            inventory["source_id"].as_str().unwrap(),
            inventory["version"]
        );
        if !origin.is_null() {
            content.push_str(&format!(
                "\n出典位置:\n```json\n{}\n```\n",
                serde_json::to_string(origin)?
            ));
        }
        let fence = "`".repeat(
            text.split(|c| c != '`')
                .map(str::len)
                .max()
                .unwrap_or(0)
                .max(2)
                + 1,
        );
        for item in audit["missing"].as_array().unwrap() {
            // A longer fence keeps original Markdown links/headings inert without altering text.
            content.push_str(&format!(
                "\n[原文 L{}](source:{sid}@{version}#L{}-L{})\n\n{fence}\n{}\n{fence}\n",
                item["start_line"],
                item["start_line"],
                item["end_line"],
                item["text"].as_str().unwrap()
            ));
        }
        let coverage = self.capture_audit(&json!({"text":text,"summary":content}))?;
        let mut put = v.clone();
        put["content"] = json!(content);
        let mut saved = self.put(&put)?;
        saved["source_id"] = source["source_id"].clone();
        saved["version"] = source["version"].clone();
        saved["original_hash"] = source["hash"].clone();
        saved["original_retained"] = json!(true);
        saved["inventory_source_id"] = inventory["source_id"].clone();
        saved["inventory_version"] = inventory["version"].clone();
        saved["verification_state"] = json!("reported_unverified");
        saved["coverage"] = json!({"inventory_count":coverage["inventory_count"],"missing_count":coverage["missing_count"],"supplemented_count":audit["missing_count"],"semantic_completeness_verified":false});
        Ok(saved)
    }
}
