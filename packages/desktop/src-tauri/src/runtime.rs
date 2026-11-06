use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub mobile: bool,
    pub ai_tools: bool,
    pub scheduled_sync: bool,
}

#[tauri::command]
pub fn runtime_capabilities() -> RuntimeCapabilities {
    RuntimeCapabilities {
        mobile: cfg!(mobile),
        ai_tools: cfg!(desktop),
        scheduled_sync: cfg!(desktop),
    }
}

/// Linux locale overrides take precedence over the webview's preferred language.
/// Other platforms use the webview's native system-language reporting.
#[tauri::command]
pub fn system_locale() -> Option<String> {
    if cfg!(target_os = "linux") {
        crate::locale::locale_from_environment(|key| std::env::var(key).ok())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::runtime_capabilities;

    #[test]
    fn desktop_build_reports_only_desktop_capabilities() {
        let capabilities = runtime_capabilities();

        assert!(!capabilities.mobile);
        assert!(capabilities.ai_tools);
        assert!(capabilities.scheduled_sync);
    }
}
