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
