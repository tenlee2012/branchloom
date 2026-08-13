mod ai_tools;
mod commands;
mod credentials;
mod external_links;

pub use branchloom_core::{core, storage};

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let session = commands::open_desktop_project_session(app.handle())
                .map_err(std::io::Error::other)?;
            app.manage(session);
            let ai_tools =
                ai_tools::AiToolsState::from_app(app.handle()).map_err(std::io::Error::other)?;
            app.manage(ai_tools);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_normalized_state,
            commands::data_revision,
            commands::list_duplicate_candidates,
            commands::synchronize_normalized_state,
            commands::apply_desktop_mutation,
            commands::import_attachment,
            commands::attachment_exists,
            commands::set_local_attachment,
            commands::read_attachment,
            commands::export_project_archive,
            commands::import_project_archive,
            commands::export_project_gedcom,
            commands::import_project_gedcom,
            commands::create_manual_snapshot,
            commands::connect_github,
            commands::get_github_connection,
            commands::preview_github_project_import,
            commands::apply_github_project_import,
            commands::preview_github_sync,
            commands::apply_github_sync,
            ai_tools::get_ai_tools_status,
            ai_tools::preview_ai_tools_change,
            ai_tools::apply_ai_tools_change,
            external_links::open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Branchloom");
}
