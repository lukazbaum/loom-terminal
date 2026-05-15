/// Crash-safe replacement for `std::fs::write`. Writes to a temp file in
/// the same directory and atomically renames it into place, so a crash or
/// power loss either leaves the previous file intact or fully writes the
/// new one — never a half-written truncated file.
///
/// Hardening beyond a plain create+rename:
///  - Tempfile is opened with `mode 0o600` (NamedTempFile's default via
///    mkstemp) so secrets that may live in settings.json aren't briefly
///    world-readable under a permissive umask.
///  - Refuses to write through a symlink at the destination: an attacker
///    with write access to the parent dir could otherwise pre-plant a
///    symlink to redirect the new contents at an arbitrary path.
///  - fsyncs the parent directory after the rename so the dirent is
///    durably on disk — without it, the rename's "atomic" guarantee is
///    only against process crashes, not power loss.
///
/// Uses `tempfile::NamedTempFile` for tempfile creation: the suffix
/// comes from the OS RNG via mkstemp, the tempfile is unlinked
/// automatically on Drop if `persist()` isn't called, and the
/// boilerplate for "open + write + chmod 0600" collapses into one
/// well-tested call.
use std::fs;
use std::io::Write;
use std::path::Path;

pub fn write<P: AsRef<Path>>(path: P, contents: &[u8]) -> std::io::Result<()> {
    let path = path.as_ref();
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent dir"))?;

    // Refuse to write through a symlink. `fs::rename` would clobber the
    // link (replacing it with our new regular file) which is mostly OK,
    // but if the existing settings file is a symlink the *read* path
    // upstream just followed it and may have surfaced contents of an
    // unrelated file in error messages. Either way, an unexpected
    // symlink is a signal something is off — fail loud.
    //
    // The same call also tells us whether a regular file already exists
    // at the destination, so we can preserve its mode after rename —
    // without that, every Loom rewrite would clamp the user's existing
    // 0644 config.toml to our tempfile's 0600 default.
    let existing_mode: Option<u32> = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "atomic_write: refusing to overwrite symlink at {}",
                    path.display()
                ),
            ));
        }
        #[cfg(unix)]
        Ok(meta) => {
            use std::os::unix::fs::PermissionsExt as _;
            Some(meta.permissions().mode() & 0o777)
        }
        #[cfg(not(unix))]
        Ok(_) => None,
        Err(_) => None,
    };

    // NamedTempFile::new_in creates a unique tempfile in `parent` via
    // mkstemp on Unix (OS-RNG suffix, 0o600 default mode). The handle
    // unlinks the file on Drop if we never call `persist()`, so a panic
    // between write_all and rename doesn't leak `.tmp.*` files in the
    // user's config directory.
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    let tmp_path = tmp.path().to_path_buf();
    // `persist` does the atomic rename. On error it returns a
    // `PersistError` which holds the original handle (so the Drop still
    // unlinks the tempfile); unwrap to the io::Error for our return.
    tmp.persist(path).map_err(|e| {
        // The tempfile handle was consumed by persist; remove_file the
        // residual path defensively — under normal failure modes the
        // PersistError's Drop already did this, but the rename can
        // race with another process and our path can outlast it.
        let _ = fs::remove_file(&tmp_path);
        e.error
    })?;

    #[cfg(unix)]
    if let Some(mode) = existing_mode {
        use std::os::unix::fs::PermissionsExt as _;
        // Best-effort: if chmod fails the file's still readable, just
        // possibly with tighter perms than the user had.
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }

    // fsync the parent directory so the rename's dirent is durably on
    // disk. Without this, a power loss between the rename returning and
    // the kernel flushing the parent's metadata can leave the file
    // missing entirely (old version unlinked, new dirent not persisted).
    // Best-effort: some filesystems return EINVAL on dir-fsync; we
    // don't promote that to a write failure.
    #[cfg(unix)]
    {
        if let Ok(d) = fs::File::open(parent) {
            let _ = d.sync_all();
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn writes_a_fresh_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        write(&path, b"hello").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello");
    }

    #[test]
    fn overwrites_existing_regular_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, b"old").unwrap();
        write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn new_files_land_at_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("secret.json");
        write(&path, b"sensitive").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "fresh files written via atomic_write must end up 0600"
        );
    }

    #[cfg(unix)]
    #[test]
    fn overwrites_preserve_existing_mode() {
        // A user with `chmod 0644 ~/.codex/config.toml` shouldn't see
        // Loom silently clamp it to 0600 on every launch. Verify the
        // overwrite path restores the pre-existing mode.
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, b"old contents").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write(&path, b"new contents").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o644, "existing file mode must survive");
        assert_eq!(fs::read(&path).unwrap(), b"new contents");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_overwrite_an_existing_symlink_at_destination() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("target");
        fs::write(&target, b"sensitive").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let err = write(&link, b"new").expect_err("must refuse symlink dest");
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);

        // Target was NOT clobbered.
        assert_eq!(
            fs::read(&target).unwrap(),
            b"sensitive",
            "symlink target must be left intact"
        );
    }
}
