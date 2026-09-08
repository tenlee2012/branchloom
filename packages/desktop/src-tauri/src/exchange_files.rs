use std::path::Path;

use tauri::AppHandle;
use tauri_plugin_fs::FilePath;

// Mobile plugin calls wait for the native UI thread. Run file exchange on a worker.
pub async fn run<T: Send + 'static>(
    app: AppHandle,
    operation: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || operation(&app))
        .await
        .map_err(|error| format!("文件交换任务未能完成：{error}"))?
}

fn absolute_path(path: &Path) -> Result<&Path, String> {
    if !path.is_absolute() {
        return Err("导入或导出路径必须是绝对路径".to_owned());
    }
    Ok(path)
}

pub fn import<T>(
    _app: &AppHandle,
    location: FilePath,
    _extension: &str,
    operation: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    match location {
        FilePath::Path(path) => operation(absolute_path(&path)?),
        #[cfg(mobile)]
        FilePath::Url(url) => {
            let cache = mobile::cache_directory(_app)?;
            mobile::with_file(_app, FilePath::Url(url), false, |source| {
                staging::import(&cache, _extension, source, operation)
            })
        }
        #[cfg(desktop)]
        FilePath::Url(_) => Err("导入路径必须是绝对文件路径".to_owned()),
    }
}

pub fn export<T>(
    _app: &AppHandle,
    location: FilePath,
    _extension: &str,
    operation: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    match location {
        FilePath::Path(path) => operation(absolute_path(&path)?),
        #[cfg(mobile)]
        FilePath::Url(url) => {
            let cache = mobile::cache_directory(_app)?;
            staging::export(&cache, _extension, operation, |mut source| {
                mobile::with_file(_app, FilePath::Url(url), true, |mut destination| {
                    std::io::copy(&mut source, &mut destination)
                        .map_err(|error| format!("无法写入所选文件：{error}"))?;
                    Ok(())
                })
            })
        }
        #[cfg(desktop)]
        FilePath::Url(_) => Err("导出路径必须是绝对文件路径".to_owned()),
    }
}

#[cfg(mobile)]
mod mobile {
    use std::fs::File;
    use std::path::PathBuf;

    use tauri::{AppHandle, Manager};
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    pub fn cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
        let cache = app
            .path()
            .app_cache_dir()
            .map_err(|error| format!("无法确定临时文件目录：{error}"))?;
        std::fs::create_dir_all(&cache)
            .map_err(|error| format!("无法创建临时文件目录：{error}"))?;
        Ok(cache)
    }

    pub fn with_file<T>(
        app: &AppHandle,
        location: FilePath,
        write: bool,
        operation: impl FnOnce(File) -> Result<T, String>,
    ) -> Result<T, String> {
        let FilePath::Url(url) = &location else {
            return Err("需要文件选择器返回的文件 URI".to_owned());
        };
        let expected_scheme = if cfg!(target_os = "android") {
            "content"
        } else {
            "file"
        };
        if url.scheme() != expected_scheme {
            return Err("不支持这个文件 URI".to_owned());
        }
        let mut options = OpenOptions::new();
        options.read(!write).write(write).truncate(write);
        let result = app
            .fs()
            .open(location.clone(), options)
            .map_err(|error| format!("无法打开所选文件：{error}"))
            .and_then(operation);
        // Balance the filesystem plugin's security-scoped access, including failures.
        #[cfg(target_os = "ios")]
        let _ = app.fs().stop_accessing_security_scoped_resource(location);
        result
    }
}

#[cfg(any(mobile, test))]
mod staging {
    use std::fs::File;
    use std::io::Read;
    use std::path::Path;

    fn directory(cache: &Path) -> Result<tempfile::TempDir, String> {
        tempfile::Builder::new()
            .prefix("exchange-")
            .tempdir_in(cache)
            .map_err(|error| format!("无法创建交换临时目录：{error}"))
    }

    pub fn import<T>(
        cache: &Path,
        extension: &str,
        mut source: impl Read,
        operation: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let directory = directory(cache)?;
        let path = directory.path().join(format!("project.{extension}"));
        let mut file =
            File::create(&path).map_err(|error| format!("无法创建交换临时文件：{error}"))?;
        std::io::copy(&mut source, &mut file)
            .map_err(|error| format!("无法读取所选文件：{error}"))?;
        drop(file);
        operation(&path)
    }

    pub fn export<T>(
        cache: &Path,
        extension: &str,
        operation: impl FnOnce(&Path) -> Result<T, String>,
        write_destination: impl FnOnce(File) -> Result<(), String>,
    ) -> Result<T, String> {
        let directory = directory(cache)?;
        let path = directory.path().join(format!("project.{extension}"));
        let result = operation(&path)?;
        let source = File::open(&path).map_err(|error| format!("无法读取交换临时文件：{error}"))?;
        // Only open/truncate the user's destination after the core export succeeds.
        write_destination(source)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Read};

    use super::*;

    #[test]
    fn imports_from_a_stream_with_the_required_extension_and_cleans_up() {
        let cache = tempfile::tempdir().unwrap();
        for extension in ["blp", "ged"] {
            let result =
                staging::import(cache.path(), extension, Cursor::new(b"fixture"), |path| {
                    assert!(path.is_absolute());
                    assert_eq!(path.extension().unwrap(), extension);
                    assert_eq!(std::fs::read(path).unwrap(), b"fixture");
                    Ok("imported")
                });
            assert_eq!(result.unwrap(), "imported");
            assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn exports_completed_bytes_to_a_stream_and_cleans_up() {
        let cache = tempfile::tempdir().unwrap();
        let mut output = Vec::new();
        let result = staging::export(
            cache.path(),
            "blp",
            |path| {
                std::fs::write(path, b"complete archive").unwrap();
                Ok("summary")
            },
            |mut source| {
                source.read_to_end(&mut output).unwrap();
                Ok(())
            },
        );
        assert_eq!(result.unwrap(), "summary");
        assert_eq!(output, b"complete archive");
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[test]
    fn failures_clean_up_and_a_failed_export_never_opens_the_destination() {
        let cache = tempfile::tempdir().unwrap();
        let imported: Result<(), _> =
            staging::import(cache.path(), "blp", Cursor::new(b"invalid"), |_| {
                Err("invalid archive".to_owned())
            });
        assert!(imported.is_err());
        let exported: Result<(), _> = staging::export(
            cache.path(),
            "ged",
            |path| {
                std::fs::write(path, b"partial").unwrap();
                Err("invalid project".to_owned())
            },
            |_| panic!("must not open the destination"),
        );
        assert!(exported.is_err());
        let failed_write = staging::export(
            cache.path(),
            "ged",
            |path| {
                std::fs::write(path, b"complete").unwrap();
                Ok(())
            },
            |_| Err("permission denied".to_owned()),
        );
        assert_eq!(failed_write.unwrap_err(), "permission denied");
        assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[test]
    fn relative_paths_and_content_uris_are_not_local_absolute_paths() {
        assert!(absolute_path(Path::new("family.blp")).is_err());
        assert!(absolute_path(Path::new("content://provider/document/123")).is_err());
        let directory = tempfile::tempdir().unwrap();
        assert!(absolute_path(&directory.path().join("family.blp")).is_ok());
        let uri: FilePath = serde_json::from_str("\"content://provider/document/123\"").unwrap();
        assert!(matches!(uri, FilePath::Url(_)));
    }
}
