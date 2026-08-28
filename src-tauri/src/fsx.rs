//! One tmp-then-rename file write for every store that publishes a file
//! atomically. Callers state their durability tier explicitly, so the level
//! of crash protection is a visible decision at each call site rather than an
//! accident of which module the code was copied from.

use std::io::Write;
use std::path::Path;

#[cfg(not(windows))]
use std::fs::File;

/// How hard a write tries to survive power loss.
#[derive(Clone, Copy)]
pub enum Durability {
    /// Plain tmp write + rename; a crash can lose the write but never
    /// publishes a torn file.
    BestEffort,
    /// fsync the tmp file, then a plain rename.
    Fsync,
    /// create_new tmp (no clobber of a concurrent writer), fsync, then a
    /// write-through rename (MOVEFILE_WRITE_THROUGH on Windows, rename plus
    /// directory fsync elsewhere).
    WriteThrough,
}

/// Writes `bytes` to `path` via a same-directory temporary named
/// `{filename}.{pid}.tmp`. The final `.tmp` extension is load bearing: stale
/// tmp sweepers match on it. The temporary is removed best-effort when the
/// write or rename fails.
pub fn write_atomic(path: &Path, bytes: &[u8], durability: Durability) -> Result<(), String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "write target has no file name".to_string())?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    let result = write_tmp_then_rename(path, &tmp, bytes, durability);
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn write_tmp_then_rename(
    path: &Path,
    tmp: &Path,
    bytes: &[u8],
    durability: Durability,
) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    match durability {
        Durability::WriteThrough => {
            options.create_new(true);
        }
        Durability::BestEffort | Durability::Fsync => {
            options.create(true).truncate(true);
        }
    }
    let mut file = options.open(tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    if !matches!(durability, Durability::BestEffort) {
        file.sync_all().map_err(|e| e.to_string())?;
    }
    drop(file);
    match durability {
        Durability::WriteThrough => durable_rename(tmp, path),
        Durability::BestEffort | Durability::Fsync => {
            std::fs::rename(tmp, path).map_err(|e| e.to_string())
        }
    }
}

pub fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows does not provide POSIX directory fsync semantics through
        // std::fs. Every publication rename uses MOVEFILE_WRITE_THROUGH in
        // durable_rename, which flushes the rename before returning.
        let _ = path;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())
    }
}

pub fn durable_rename(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

        let from_wide = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let to_wide = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe {
            MoveFileExW(
                PCWSTR(from_wide.as_ptr()),
                PCWSTR(to_wide.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(from, to).map_err(|error| error.to_string())?;
        let parent = to
            .parent()
            .ok_or_else(|| "rename target has no parent".to_string())?;
        sync_directory(parent)
    }
}
