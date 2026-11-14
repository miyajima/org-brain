//! Feature administration shares the engine's lock, without opening a Wiki DB.
use crate::{
    locking::{Guard, open_config, validate_config},
    reject_links,
};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};
use tempfile::NamedTempFile;

const MAX_EPOCH: u64 = 9_007_199_254_740_991;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Update {
    enabled: bool,
    auto_maintenance: Option<bool>,
}

pub(crate) fn safe_epoch(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && (0.0..=MAX_EPOCH as f64).contains(n))
        .map(|n| n as u64)
}

fn settings(value: &Value) -> Result<Value> {
    ensure!(value.is_object(), "invalid_feature_config");
    let features = &value["features"];
    ensure!(
        features.is_null() || features.is_object(),
        "invalid_feature_config"
    );
    let wiki = &features["llm_wiki"];
    if wiki.is_null() {
        return Ok(json!({"enabled":false,"epoch":0,"auto_maintenance":false}));
    }
    ensure!(
        wiki.is_object() && wiki["enabled"].is_boolean(),
        "invalid_feature_config"
    );
    let epoch = safe_epoch(&wiki["epoch"]).context("invalid_feature_config")?;
    Ok(
        json!({"enabled":wiki["enabled"],"epoch":epoch,"auto_maintenance":wiki["auto_maintenance"] == true}),
    )
}

pub fn set_feature(config: &Path, input: &Value) -> Result<Value> {
    ensure!(
        input.is_object() && input.get("auto_maintenance").is_none_or(Value::is_boolean),
        "invalid_feature_config"
    );
    let update: Update = serde_json::from_value(input.clone()).context("invalid_feature_config")?;
    validate_config(config)?;
    let parent = config.parent().context("invalid_path")?;
    reject_links(parent)?;
    let mut dirs = fs::DirBuilder::new();
    dirs.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dirs.mode(0o700);
    }
    dirs.create(parent)?;
    let _guard = Guard::acquire(config)?;
    #[cfg(test)]
    tests::pause_if_requested(config);
    let mut bytes = Vec::new();
    let mut value = match open_config(config) {
        Ok(file) => {
            file.take(65_537).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 65_536, "invalid_feature_config");
            serde_json::from_slice(&bytes).context("invalid_feature_config")?
        }
        Err(e)
            if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            json!({})
        }
        Err(e) => return Err(e),
    };
    let before = settings(&value)?;
    let epoch = before["epoch"].as_u64().unwrap();
    ensure!(epoch < MAX_EPOCH, "invalid_feature_config: epoch exhausted");
    if value["features"].is_null() {
        value["features"] = json!({});
    }
    if value["features"]["llm_wiki"].is_null() {
        value["features"]["llm_wiki"] = json!({});
    }
    let wiki = &mut value["features"]["llm_wiki"];
    wiki["enabled"] = json!(update.enabled);
    wiki["epoch"] = json!(epoch + 1);
    wiki["auto_maintenance"] = json!(
        update
            .auto_maintenance
            .unwrap_or(before["auto_maintenance"] == true)
    );
    let bytes = serde_json::to_vec_pretty(&value)?;
    ensure!(bytes.len() <= 65_536, "invalid_feature_config");
    // NamedTempFile is create_new/private (0600 on Unix), on the same filesystem.
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    validate_config(config)?;
    temporary.persist(config)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    settings(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        thread,
        time::Duration,
    };
    pub(super) fn pause_if_requested(config: &Path) {
        if std::env::var_os("ORGBRAIN_TEST_FEATURE_OWNER").as_deref() == Some(config.as_os_str()) {
            fs::write(config.with_extension("ready"), b"locked").unwrap();
            thread::sleep(Duration::from_secs(30));
        }
    }
    #[test]
    fn feature_owner_child() {
        if let Some(config) = std::env::var_os("ORGBRAIN_TEST_FEATURE_OWNER") {
            set_feature(Path::new(&config), &json!({"enabled":true})).unwrap();
        }
    }
    #[test]
    fn killed_feature_owner_releases_without_removing_file() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().canonicalize().unwrap().join("features.json");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "feature::tests::feature_owner_child"])
            .env("ORGBRAIN_TEST_FEATURE_OWNER", &config)
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..500 {
            if config.with_extension("ready").exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let ready = config.with_extension("ready").exists();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(ready, "child must own the real Guard before termination");
        let lock = config.with_extension("json.lock");
        assert!(lock.is_file());
        assert!(!config.exists());
        assert_eq!(
            set_feature(&config, &json!({"enabled":false})).unwrap()["epoch"],
            1
        );
        assert!(lock.is_file());
    }
}
