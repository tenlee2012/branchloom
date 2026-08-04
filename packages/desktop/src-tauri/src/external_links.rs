const ALLOWED_EXTERNAL_URLS: &[&str] = &[
    "https://github.com/new",
    "https://github.com/settings/personal-access-tokens/new",
    "https://github.com/settings/tokens/new?scopes=repo&description=Branchloom",
    "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
];

#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    if !ALLOWED_EXTERNAL_URLS.contains(&url.as_str()) {
        return Err("不允许打开这个外部链接".to_owned());
    }

    open_external_url_with_system_browser(url).await
}

#[cfg(target_os = "macos")]
async fn open_external_url_with_system_browser(url: String) -> Result<(), String> {
    let status = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/open")
            .args(["-n", "--"])
            .arg(url)
            .status()
    })
    .await
    .map_err(|error| format!("无法启动系统浏览器：{error}"))?
    .map_err(|error| format!("无法启动系统浏览器：{error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("系统浏览器打开链接失败：{status}"))
    }
}

#[cfg(not(target_os = "macos"))]
async fn open_external_url_with_system_browser(url: String) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|error| format!("无法启动系统浏览器：{error}"))
}

#[cfg(test)]
mod tests {
    use super::ALLOWED_EXTERNAL_URLS;

    #[test]
    fn external_url_allowlist_contains_only_the_token_help_destinations() {
        assert_eq!(ALLOWED_EXTERNAL_URLS.len(), 4);
        assert!(ALLOWED_EXTERNAL_URLS.contains(&"https://github.com/new"));
        assert!(!ALLOWED_EXTERNAL_URLS.contains(&"https://github.com/new?redirect=malicious"));
        assert!(!ALLOWED_EXTERNAL_URLS.contains(&"https://example.com"));
    }
}
