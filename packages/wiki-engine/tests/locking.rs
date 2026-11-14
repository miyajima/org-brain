use orgbrain_wiki_engine::{execute, set_feature};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::tempdir;

fn start(config: &Path, input: Value) -> Child {
    let mut child = Command::new(env!("CARGO_BIN_EXE_orgbrain-wiki-engine"))
        .args(["--feature-set", config.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    write!(child.stdin.take().unwrap(), "{input}").unwrap();
    child
}
fn output(child: Child) -> Value {
    let out = child.wait_with_output().unwrap();
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(out.status.success(), "{value}");
    value
}

#[test]
fn feature_admin_is_atomic_private_bounded_and_preserves_settings() {
    let dir = tempdir().unwrap();
    let home = dir.path().canonicalize().unwrap();
    let config = home.join("nested/features.json");
    assert_eq!(
        set_feature(&config, &json!({"enabled":false})).unwrap(),
        json!({"enabled":false,"epoch":1,"auto_maintenance":false})
    );
    fs::write(&config, r#"{"custom":17,"features":{"other":{"x":1},"llm_wiki":{"enabled":false,"epoch":7,"auto_maintenance":true,"extra":"keep"}}}"#).unwrap();
    assert_eq!(
        set_feature(&config, &json!({"enabled":true})).unwrap(),
        json!({"enabled":true,"epoch":8,"auto_maintenance":true})
    );
    let value: Value = serde_json::from_slice(&fs::read(&config).unwrap()).unwrap();
    assert_eq!(value["custom"], 17);
    assert_eq!(value["features"]["other"]["x"], 1);
    assert_eq!(value["features"]["llm_wiki"]["extra"], "keep");
    assert!(!home.join("wiki").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(config.with_extension("json.lock"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(config.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    fs::write(
        &config,
        r#"{"features":{"llm_wiki":{"enabled":true,"epoch":1e0}}}"#,
    )
    .unwrap();
    assert_eq!(
        set_feature(&config, &json!({"enabled":true})).unwrap()["epoch"],
        2
    );
    for invalid in [
        json!([]),
        json!({"features":[]}),
        json!({"features":{"llm_wiki":{"enabled":true,"epoch":-1}}}),
        json!({"features":{"llm_wiki":{"enabled":true,"epoch":9007199254740991u64}}}),
    ] {
        let bytes = serde_json::to_vec(&invalid).unwrap();
        fs::write(&config, &bytes).unwrap();
        assert!(set_feature(&config, &json!({"enabled":true})).is_err());
        assert_eq!(fs::read(&config).unwrap(), bytes);
    }
    for input in [
        json!({"enabled":1}),
        json!({}),
        json!([true]),
        json!({"enabled":true,"auto_maintenance":null}),
        json!({"enabled":true,"auto_maintenance":"yes"}),
    ] {
        fs::write(&config, "{}").unwrap();
        assert!(set_feature(&config, &input).is_err());
        assert_eq!(fs::read_to_string(&config).unwrap(), "{}");
    }
    fs::write(&config, " ".repeat(65537)).unwrap();
    assert!(
        set_feature(&config, &json!({"enabled":true}))
            .unwrap_err()
            .to_string()
            .contains("invalid_feature_config")
    );
}

#[test]
fn live_lock_is_bounded_not_stolen_and_legacy_is_not_reaped() {
    let dir = tempdir().unwrap();
    let config = dir.path().canonicalize().unwrap().join("features.json");
    set_feature(&config, &json!({"enabled":true})).unwrap();
    let lock_path = config.with_extension("json.lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .unwrap();
    lock.lock().unwrap();
    let started = Instant::now();
    let child = start(&config, json!({"enabled":false}));
    let out = child.wait_with_output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("wiki_busy"));
    assert!(
        started.elapsed() >= Duration::from_secs(4) && started.elapsed() < Duration::from_secs(9)
    );
    assert!(matches!(
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap()
            .try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    lock.unlock().unwrap();
    let before = fs::metadata(&lock_path).unwrap();
    assert_eq!(output(start(&config, json!({"enabled":false})))["epoch"], 2);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(fs::metadata(&lock_path).unwrap().ino(), before.ino());
    }
    drop(lock);
    // Only this isolated fixture is converted into legacy format for rejection.
    fs::remove_file(&lock_path).unwrap();
    fs::create_dir(&lock_path).unwrap();
    assert!(
        set_feature(&config, &json!({"enabled":true}))
            .unwrap_err()
            .to_string()
            .contains("legacy directory lock")
    );
    assert!(lock_path.is_dir());
}

#[test]
fn concurrent_feature_processes_keep_all_epochs_and_share_storage_guard() {
    let dir = tempdir().unwrap();
    let home = dir.path().canonicalize().unwrap();
    let config = home.join("features.json");
    let children: Vec<_> = (0..12)
        .map(|_| start(&config, json!({"enabled":true})))
        .collect();
    let mut epochs: Vec<_> = children
        .into_iter()
        .map(|c| output(c)["epoch"].as_u64().unwrap())
        .collect();
    epochs.sort();
    assert_eq!(epochs, (1..=12).collect::<Vec<_>>());
    let root = home.join("wiki");
    execute(&root, &config, 12, &json!({"op":"init"})).unwrap();
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(config.with_extension("json.lock"))
        .unwrap();
    lock.lock().unwrap();
    let other_root = root.clone();
    let other_config = config.clone();
    let writer = thread::spawn(move || {
        execute(
            &other_root,
            &other_config,
            12,
            &json!({"op":"put","path":"late.md","content":"late"}),
        )
    });
    thread::sleep(Duration::from_millis(100));
    assert!(!writer.is_finished());
    lock.unlock().unwrap();
    set_feature(&config, &json!({"enabled":false})).unwrap();
    // A queued writer either committed before OFF, or was cancelled by it, never
    // commits after the completed disable while retaining the previous epoch.
    let _ = writer.join().unwrap();
    assert!(
        execute(
            &root,
            &config,
            12,
            &json!({"op":"put","path":"after.md","content":"after"})
        )
        .unwrap_err()
        .to_string()
        .contains("feature_disabled")
    );
    set_feature(&config, &json!({"enabled":true})).unwrap();
    assert!(
        execute(
            &root,
            &config,
            12,
            &json!({"op":"put","path":"after.md","content":"after"})
        )
        .unwrap_err()
        .to_string()
        .contains("wiki_operation_cancelled")
    );
}

#[cfg(unix)]
#[test]
fn rejects_symlinks_ancestors_non_regular_and_hardlinked_locks() {
    use std::os::unix::fs::symlink;
    let dir = tempdir().unwrap();
    let home = dir.path().canonicalize().unwrap();
    let config = home.join("features.json");
    let outside = home.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("config"), "{}").unwrap();
    symlink(outside.join("config"), &config).unwrap();
    assert!(
        set_feature(&config, &json!({"enabled":true}))
            .unwrap_err()
            .to_string()
            .contains("symlink_rejected")
    );
    fs::remove_file(&config).unwrap();
    symlink(&outside, home.join("alias")).unwrap();
    assert!(
        set_feature(&home.join("alias/new.json"), &json!({"enabled":true}))
            .unwrap_err()
            .to_string()
            .contains("symlink_rejected")
    );
    let lock = config.with_extension("json.lock");
    symlink(outside.join("config"), &lock).unwrap();
    assert!(
        set_feature(&config, &json!({"enabled":true}))
            .unwrap_err()
            .to_string()
            .contains("symlink_rejected")
    );
    fs::remove_file(&lock).unwrap();
    fs::hard_link(outside.join("config"), &lock).unwrap();
    assert!(
        set_feature(&config, &json!({"enabled":true}))
            .unwrap_err()
            .to_string()
            .contains("lock_file_changed")
    );
    assert_eq!(fs::read_to_string(outside.join("config")).unwrap(), "{}");
    assert!(
        set_feature(Path::new("relative.json"), &json!({"enabled":true}))
            .unwrap_err()
            .to_string()
            .contains("config_must_be_absolute")
    );
    assert!(
        set_feature(&home.join("../escape.json"), &json!({"enabled":true}))
            .unwrap_err()
            .to_string()
            .contains("invalid_path")
    );
}
