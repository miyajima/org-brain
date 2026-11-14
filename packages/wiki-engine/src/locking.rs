//! The pathname is permanent: unlinking an unlocked file can split contenders
//! across different inodes. Closing the owning handle (including on process
//! death) releases the kernel lock. No PID/age based recovery is involved.
use crate::reject_links;
use anyhow::{Result, bail, ensure};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

pub(crate) struct Guard {
    _file: File,
}

pub(crate) fn open_config(config: &Path) -> Result<File> {
    validate_config(config)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(config)?;
    ensure!(file.metadata()?.is_file(), "invalid_feature_config");
    validate_config(config)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = file.metadata()?;
        let named = fs::symlink_metadata(config)?;
        ensure!(
            opened.dev() == named.dev() && opened.ino() == named.ino(),
            "config_file_changed"
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            file.metadata()?.file_attributes() & 0x400 == 0,
            "symlink_rejected"
        );
    }
    Ok(file)
}

fn lock_path(config: &Path) -> PathBuf {
    let mut name = config.as_os_str().to_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

pub(crate) fn validate_config(config: &Path) -> Result<()> {
    ensure!(config.is_absolute(), "config_must_be_absolute");
    reject_links(config)?;
    match fs::symlink_metadata(config) {
        Ok(m) => ensure!(m.is_file(), "invalid_feature_config"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

fn validate_lock(lock: &Path) -> Result<()> {
    reject_links(lock)?;
    match fs::symlink_metadata(lock) {
        Ok(m) if m.is_dir() => bail!(
            "wiki_busy: legacy directory lock; stop all clients and follow the documented migration procedure"
        ),
        Ok(m) => ensure!(m.is_file(), "invalid_lock_file"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

fn validate_handle(file: &File, lock: &Path) -> Result<()> {
    validate_lock(lock)?;
    let opened = file.metadata()?;
    ensure!(opened.is_file(), "invalid_lock_file");
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(opened.file_attributes() & 0x400 == 0, "symlink_rejected");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let named = fs::symlink_metadata(lock)?;
        ensure!(
            opened.nlink() == 1 && opened.dev() == named.dev() && opened.ino() == named.ino(),
            "lock_file_changed"
        );
    }
    Ok(())
}

impl Guard {
    pub(crate) fn acquire(config: &Path) -> Result<Self> {
        validate_config(config)?;
        let lock = lock_path(config);
        validate_lock(&lock)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // NONBLOCK also prevents hanging if a FIFO replaces the checked path.
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Do not follow a reparse point swapped in after validation. Keep the
            // inode/handle non-deletable while open (FILE_SHARE_READ | WRITE).
            options.custom_flags(0x00200000).share_mode(0x1 | 0x2);
        }
        let file = options.open(&lock)?;
        validate_handle(&file, &lock)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            // File::try_lock is stable since Rust 1.89; exclusive flock on Unix,
            // LockFileEx on Windows. Not an existence/metadata ownership test.
            match file.try_lock() {
                Ok(()) => {
                    validate_config(config)?;
                    validate_handle(&file, &lock)?;
                    return Ok(Self { _file: file });
                }
                Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(std::fs::TryLockError::WouldBlock) => {
                    bail!("wiki_busy: feature lock is held by an active operation")
                }
                Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn replacement_between_open_and_lock_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().canonicalize().unwrap().join("features.json");
        let lock = lock_path(&config);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&lock)
            .unwrap();
        fs::rename(&lock, dir.path().join("detached")).unwrap();
        fs::write(&lock, b"").unwrap();
        assert!(
            validate_handle(&file, &lock)
                .unwrap_err()
                .to_string()
                .contains("lock_file_changed")
        );
    }
    #[test]
    fn special_files_are_refused_without_blocking() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().canonicalize().unwrap().join("features.json");
        let lock = lock_path(&config);
        let name = CString::new(lock.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let started = Instant::now();
        assert!(
            Guard::acquire(&config)
                .err()
                .unwrap()
                .to_string()
                .contains("invalid_lock_file")
        );
        fs::rename(&lock, &config).unwrap();
        assert!(
            open_config(&config)
                .err()
                .unwrap()
                .to_string()
                .contains("invalid_feature_config")
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
