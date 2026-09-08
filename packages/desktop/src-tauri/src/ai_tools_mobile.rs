use serde_json::Value;

fn unavailable<T>() -> Result<T, String> {
    Err("移动端不提供 AI Skill 或 CLI 管理能力".to_owned())
}

#[tauri::command]
pub fn get_ai_tools_status() -> Result<Value, String> {
    unavailable()
}

#[tauri::command]
pub fn preview_ai_tools_change(_input: Value) -> Result<Value, String> {
    unavailable()
}

#[tauri::command]
pub fn apply_ai_tools_change(_input: Value) -> Result<Value, String> {
    unavailable()
}
