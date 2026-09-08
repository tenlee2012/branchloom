use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use branchloom_core::application::{ApplicationService, GedcomImportResult, StatePayload};
use branchloom_core::core::duplicate::DuplicateCandidate;
use branchloom_core::data_location::database_path as shared_database_path;
#[cfg(desktop)]
use branchloom_core::data_location::default_data_directory;
use branchloom_core::sync::{
    load_connection, save_connection, save_sync_baseline, ConflictResolution, GithubConnection,
    GithubRemote, GithubTransferPhase, GithubTransferProgress, ProjectRemote,
    RemoteProjectImportPlan, RemoteProjectImportService, RemoteProjectImportSummary,
    SyncInitializationStrategy, SyncMode, SyncOutcome, SyncPlanSummary, SyncService,
};

use crate::credentials::{
    delete_github_token, is_github_authentication_failure, load_github_token, save_github_token,
    GithubCredentialCache,
};

const GITHUB_CREDENTIAL_UNAVAILABLE_FILE: &str = ".credential-unavailable";
const GITHUB_IMPORT_PREVIEW_TTL: Duration = Duration::from_secs(10 * 60);
const GITHUB_IMPORT_PREVIEW_MAX_BYTES: usize = 64 * 1024 * 1024;
const GITHUB_IMPORT_EVENT_SCOPE: &str = "github-import";

pub struct DesktopProjectSession {
    pub service: Mutex<ApplicationService>,
    github_operation: Mutex<()>,
    github_credentials: Mutex<GithubCredentialCache>,
    github_import_preview: Mutex<Option<CachedGithubImportPreview>>,
}

struct CachedGithubImportPreview {
    owner: String,
    repository: String,
    branch: String,
    placeholder_project_id: Option<String>,
    fingerprint: String,
    created_at: Instant,
    plan: RemoteProjectImportPlan,
}

impl CachedGithubImportPreview {
    fn matches(&self, input: &GithubProjectImportInput, expected_fingerprint: &str) -> bool {
        self.created_at.elapsed() <= GITHUB_IMPORT_PREVIEW_TTL
            && self.owner == input.owner
            && self.repository == input.repository
            && self.branch == input.branch
            && self.placeholder_project_id == input.placeholder_project_id
            && self.fingerprint == expected_fingerprint
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GithubTokenOrigin {
    Provided,
    Stored,
}

impl GithubTokenOrigin {
    fn uses_stored_credential(self) -> bool {
        self == Self::Stored
    }

    fn persist_if_provided<E>(self, persist: impl FnOnce() -> Result<(), E>) -> Result<(), E> {
        match self {
            Self::Provided => persist(),
            Self::Stored => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceStateInput {
    pub state_json: String,
    pub snapshot_payloads_json: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopMutationInput {
    pub method: String,
    pub args: Value,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedStatePayload {
    pub state_json: String,
    pub snapshot_payloads_json: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStateSnapshot {
    pub revision: i64,
    pub state: Option<NormalizedStatePayload>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAttachmentInput {
    pub project_id: String,
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub expected_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentLocationInput {
    pub project_id: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLocalAttachmentInput {
    pub project_id: String,
    pub target_type: String,
    pub target_id: String,
    pub role: String,
    pub name: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchiveInput {
    pub project_id: String,
    pub path: tauri_plugin_fs::FilePath,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualSnapshotInput {
    pub project_id: String,
    pub note: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidatesInput {
    pub project_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArchiveImportResult {
    pub project_id: String,
    pub state: NormalizedStatePayload,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GedcomDesktopImportResult {
    pub project_id: String,
    pub state: NormalizedStatePayload,
    pub summary: branchloom_core::gedcom::GedcomSummary,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectionInput {
    #[serde(default)]
    pub operation_id: String,
    pub project_id: String,
    pub owner: String,
    pub repository: String,
    #[serde(default = "default_github_branch")]
    pub branch: String,
    pub token: String,
    #[serde(default)]
    pub create_if_missing: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectionResult {
    pub repository_existed: bool,
    pub private_repository_created: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnectionStatus {
    pub owner: String,
    pub repository: String,
    pub branch: String,
    pub last_synced_commit: Option<String>,
    pub credential_stored: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubProjectImportInput {
    #[serde(default)]
    pub operation_id: String,
    pub placeholder_project_id: Option<String>,
    pub owner: String,
    pub repository: String,
    #[serde(default = "default_github_branch")]
    pub branch: String,
    pub token: String,
    pub expected_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubProjectImportResult {
    pub project_id: String,
    pub replaced_project_id: Option<String>,
    pub baseline_updated: bool,
    pub credential_stored: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubOperationProgress<'a> {
    operation_id: &'a str,
    project_id: &'a str,
    operation: &'a str,
    phase: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSyncInput {
    #[serde(default)]
    pub operation_id: String,
    pub project_id: String,
    pub token: String,
    #[serde(default)]
    pub pull_only: bool,
    #[serde(default)]
    pub resolutions: Vec<ConflictResolution>,
    pub initialization_strategy: Option<SyncInitializationStrategy>,
    pub expected_fingerprint: Option<String>,
}

impl From<StatePayload> for NormalizedStatePayload {
    fn from(value: StatePayload) -> Self {
        Self {
            state_json: value.state_json,
            snapshot_payloads_json: value.snapshot_payloads_json,
        }
    }
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(shared_database_path(app_data_directory(app)?))
}

#[cfg(desktop)]
fn app_data_directory(_app: &AppHandle) -> Result<PathBuf, String> {
    let directory =
        default_data_directory().map_err(|error| format!("无法确定应用数据目录：{error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory)
}

#[cfg(mobile)]
fn app_data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定移动端应用数据目录：{error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建移动端应用数据目录：{error}"))?;
    Ok(directory)
}

pub fn open_desktop_project_session(app: &AppHandle) -> Result<DesktopProjectSession, String> {
    let service = open_application_service(app)?;
    Ok(DesktopProjectSession {
        service: Mutex::new(service),
        github_operation: Mutex::new(()),
        github_credentials: Mutex::new(GithubCredentialCache::default()),
        github_import_preview: Mutex::new(None),
    })
}

fn open_application_service(app: &AppHandle) -> Result<ApplicationService, String> {
    ApplicationService::open(database_path(app)?)
        .map_err(|error| format!("无法打开本地数据库：{error}"))
}

fn lock_session<'a>(
    state: &'a State<'_, DesktopProjectSession>,
) -> Result<std::sync::MutexGuard<'a, ApplicationService>, String> {
    state
        .service
        .lock()
        .map_err(|_| "本地数据库会话异常，请重新启动应用".to_owned())
}

async fn run_github_operation<T, F>(app: AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopProjectSession>();
        let _operation = state
            .github_operation
            .try_lock()
            .map_err(|_| "另一项 GitHub 操作正在进行，请稍后再试".to_owned())?;
        operation(&app)
    })
    .await
    .map_err(|error| format!("GitHub 后台任务异常：{error}"))?
}

fn emit_github_progress(
    app: &AppHandle,
    operation_id: &str,
    project_id: &str,
    operation: &str,
    phase: &str,
    message: &str,
) {
    let _ = app.emit(
        "github-sync-progress",
        GithubOperationProgress {
            operation_id,
            project_id,
            operation,
            phase,
            message,
            completed: None,
            total: None,
        },
    );
}

fn emit_github_transfer_progress(
    app: &AppHandle,
    operation_id: &str,
    project_id: &str,
    operation: &str,
    progress: GithubTransferProgress,
) {
    let (phase, message) = match progress.phase {
        GithubTransferPhase::ListingFiles => ("listing-files", "正在读取仓库文件清单…".to_owned()),
        GithubTransferPhase::DownloadingFiles => (
            "downloading-files",
            format!(
                "正在读取 GitHub 资料 {} / {}…",
                progress.completed, progress.total
            ),
        ),
        GithubTransferPhase::DownloadingAttachments => (
            "downloading-attachments",
            format!(
                "正在下载项目附件 {} / {}…",
                progress.completed, progress.total
            ),
        ),
        GithubTransferPhase::ValidatingProject => {
            ("validating-project", "正在验证项目完整性…".to_owned())
        }
    };
    let _ = app.emit(
        "github-sync-progress",
        GithubOperationProgress {
            operation_id,
            project_id,
            operation,
            phase,
            message: &message,
            completed: (progress.total > 0).then_some(progress.completed),
            total: (progress.total > 0).then_some(progress.total),
        },
    );
}

fn github_remote_with_progress(
    app: &AppHandle,
    connection: GithubConnection,
    token: String,
    operation_id: &str,
    project_id: &str,
    operation: &str,
) -> Result<GithubRemote, String> {
    let progress_app = app.clone();
    let progress_operation_id = operation_id.to_owned();
    let progress_project_id = project_id.to_owned();
    let progress_operation = operation.to_owned();
    GithubRemote::new(connection, token)
        .map(|remote| {
            remote.with_progress(move |progress| {
                emit_github_transfer_progress(
                    &progress_app,
                    &progress_operation_id,
                    &progress_project_id,
                    &progress_operation,
                    progress,
                );
            })
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_normalized_state(
    state: State<'_, DesktopProjectSession>,
) -> Result<NativeStateSnapshot, String> {
    lock_session(&state)?
        .load_state_snapshot()
        .map(|snapshot| NativeStateSnapshot {
            revision: snapshot.revision,
            state: snapshot.state.map(NormalizedStatePayload::from),
        })
        .map_err(|error| format!("无法读取本地资料：{error}"))
}

#[tauri::command]
pub fn data_revision(state: State<'_, DesktopProjectSession>) -> Result<i64, String> {
    lock_session(&state)?
        .data_revision()
        .map_err(|error| format!("无法读取本地资料版本：{error}"))
}

#[tauri::command]
pub fn list_duplicate_candidates(
    state: State<'_, DesktopProjectSession>,
    input: DuplicateCandidatesInput,
) -> Result<Vec<DuplicateCandidate>, String> {
    lock_session(&state)?
        .list_duplicate_candidates(&input.project_id)
        .map_err(|error| format!("无法分析重复人物候选：{error}"))
}

#[tauri::command]
pub fn synchronize_normalized_state(
    state: State<'_, DesktopProjectSession>,
    input: ReplaceStateInput,
) -> Result<i64, String> {
    lock_session(&state)?
        .synchronize_state_if_revision(
            &input.state_json,
            &input.snapshot_payloads_json,
            input.expected_revision,
        )
        .map_err(|error| format!("无法保存本地资料：{error}"))
}

#[tauri::command]
pub fn apply_desktop_mutation(
    state: State<'_, DesktopProjectSession>,
    input: DesktopMutationInput,
) -> Result<branchloom_core::application::DesktopMutationResult, String> {
    lock_session(&state)?
        .apply_desktop_mutation_if_revision(&input.method, &input.args, input.expected_revision)
        .map_err(|error| format!("无法保存本地资料：{error}"))
}

#[tauri::command]
pub fn import_attachment(
    state: State<'_, DesktopProjectSession>,
    input: ImportAttachmentInput,
) -> Result<branchloom_core::application::ImportedAttachmentContent, String> {
    lock_session(&state)?
        .import_attachment_bytes(
            &input.project_id,
            &input.name,
            &input.mime_type,
            &input.bytes,
            input.expected_hash.as_deref(),
        )
        .map_err(|error| format!("无法导入本地附件：{error}"))
}

#[tauri::command]
pub fn attachment_exists(
    state: State<'_, DesktopProjectSession>,
    input: AttachmentLocationInput,
) -> Result<bool, String> {
    lock_session(&state)?
        .attachment_exists(&input.project_id, &input.content_hash)
        .map_err(|error| format!("无法检查本地附件：{error}"))
}

#[tauri::command]
pub fn set_local_attachment(
    state: State<'_, DesktopProjectSession>,
    input: SetLocalAttachmentInput,
) -> Result<branchloom_core::application::LocalAttachmentResult, String> {
    let mut service = lock_session(&state)?;
    let revision = service
        .data_revision()
        .map_err(|error| format!("无法读取本地资料版本：{error}"))?;
    service
        .set_local_attachment_bytes_if_revision(
            &input.project_id,
            &input.target_type,
            &input.target_id,
            &input.role,
            &input.name,
            &input.mime_type,
            &input.bytes,
            &Uuid::new_v4().to_string(),
            &Uuid::new_v4().to_string(),
            revision,
        )
        .map_err(|error| format!("无法保存本地附件：{error}"))
}

#[tauri::command]
pub fn read_attachment(
    state: State<'_, DesktopProjectSession>,
    input: AttachmentLocationInput,
) -> Result<Vec<u8>, String> {
    lock_session(&state)?
        .read_attachment(&input.project_id, &input.content_hash)
        .map_err(|error| format!("无法读取本地附件：{error}"))
}

#[tauri::command]
pub async fn export_project_archive(
    app: AppHandle,
    input: ProjectArchiveInput,
) -> Result<(), String> {
    crate::exchange_files::run(app, move |app| {
        crate::exchange_files::export(app, input.path, "blp", |path| {
            lock_session(&app.state::<DesktopProjectSession>())?
                .export_project_archive(&input.project_id, path)
                .map_err(|error| format!("无法导出 Branchloom 项目包：{error}"))
        })
    })
    .await
}

#[tauri::command]
pub async fn import_project_archive(
    app: AppHandle,
    input: ProjectArchiveInput,
) -> Result<ProjectArchiveImportResult, String> {
    crate::exchange_files::run(app, move |app| {
        crate::exchange_files::import(app, input.path, "blp", |path| {
            let session = app.state::<DesktopProjectSession>();
            let mut service = lock_session(&session)?;
            let imported = service
                .import_project_archive(path, input.overwrite)
                .map_err(|error| format!("无法导入 Branchloom 项目包：{error}"))?;
            let state = service
                .load_state()
                .map_err(|error| format!("无法读取导入后的本地资料：{error}"))?
                .map(NormalizedStatePayload::from)
                .ok_or_else(|| "导入后未找到项目资料".to_owned())?;
            Ok(ProjectArchiveImportResult {
                project_id: imported.id,
                state,
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn export_project_gedcom(
    app: AppHandle,
    input: ProjectArchiveInput,
) -> Result<branchloom_core::gedcom::GedcomSummary, String> {
    crate::exchange_files::run(app, move |app| {
        crate::exchange_files::export(app, input.path, "ged", |path| {
            lock_session(&app.state::<DesktopProjectSession>())?
                .export_project_gedcom(&input.project_id, path)
                .map_err(|error| format!("无法导出 GEDCOM 文件：{error}"))
        })
    })
    .await
}

#[tauri::command]
pub async fn import_project_gedcom(
    app: AppHandle,
    input: ProjectArchiveInput,
) -> Result<GedcomDesktopImportResult, String> {
    crate::exchange_files::run(app, move |app| {
        crate::exchange_files::import(app, input.path, "ged", |path| {
            let session = app.state::<DesktopProjectSession>();
            let mut service = lock_session(&session)?;
            let GedcomImportResult { project, summary } = service
                .import_project_gedcom(path, input.overwrite)
                .map_err(|error| format!("无法导入 GEDCOM 文件：{error}"))?;
            let state = service
                .load_state()
                .map_err(|error| format!("无法读取导入后的本地资料：{error}"))?
                .map(NormalizedStatePayload::from)
                .ok_or_else(|| "导入后未找到项目资料".to_owned())?;
            Ok(GedcomDesktopImportResult {
                project_id: project.id,
                state,
                summary,
            })
        })
    })
    .await
}

#[tauri::command]
pub fn create_manual_snapshot(
    state: State<'_, DesktopProjectSession>,
    input: ManualSnapshotInput,
) -> Result<branchloom_core::application::ManualSnapshotResult, String> {
    lock_session(&state)?
        .create_manual_snapshot(&input.project_id, &input.note)
        .map_err(|error| format!("无法创建手动快照：{error}"))
}

#[tauri::command]
pub async fn connect_github(
    app: AppHandle,
    input: GithubConnectionInput,
) -> Result<GithubConnectionResult, String> {
    run_github_operation(app, move |app| connect_github_blocking(app, input)).await
}

fn connect_github_blocking(
    app: &AppHandle,
    input: GithubConnectionInput,
) -> Result<GithubConnectionResult, String> {
    emit_github_progress(
        app,
        &input.operation_id,
        &input.project_id,
        "connect",
        "reading-local",
        "正在读取本地项目和连接设置…",
    );
    let application = open_application_service(app)?;
    application
        .get_project(&input.project_id)
        .map_err(|error| format!("无法连接未知项目：{error}"))?;
    let state_directory = github_state_directory(app, &input.project_id)?;
    let previous = load_connection(&state_directory).ok();
    let mut connection = GithubConnection {
        owner: input.owner,
        repository: input.repository,
        branch: input.branch,
        last_synced_commit: None,
    };
    if let Some(previous) = previous {
        if previous.owner == connection.owner
            && previous.repository == connection.repository
            && previous.branch == connection.branch
        {
            connection.last_synced_commit = previous.last_synced_commit;
        }
    }
    let (token, token_origin) = resolve_github_token(app, &input.project_id, &input.token)?;
    let remote = github_remote_with_progress(
        app,
        connection.clone(),
        token.clone(),
        &input.operation_id,
        &input.project_id,
        "connect",
    )?;
    emit_github_progress(
        app,
        &input.operation_id,
        &input.project_id,
        "connect",
        "checking-repository",
        "正在验证 GitHub 权限并检查远端仓库…",
    );
    let repository_existed = match remote.repository_exists() {
        Ok(existed) => existed,
        Err(error) => {
            let message = error.to_string();
            forget_invalid_stored_credential(app, &input.project_id, token_origin, Some(&message));
            return Err(message);
        }
    };
    if !repository_existed {
        if !input.create_if_missing {
            return Err("GitHub 仓库不存在，需要用户确认后才能创建私有仓库".to_owned());
        }
        emit_github_progress(
            app,
            &input.operation_id,
            &input.project_id,
            "connect",
            "creating-repository",
            "正在创建 GitHub 私有仓库…",
        );
        remote
            .create_private_repository()
            .map_err(|error| error.to_string())?;
        let tree = application
            .export_project_tree(&input.project_id)
            .map_err(|error| error.to_string())?;
        emit_github_progress(
            app,
            &input.operation_id,
            &input.project_id,
            "connect",
            "uploading-project",
            "仓库已创建，正在上传当前项目…",
        );
        let commit = remote
            .initialize_created_repository(&tree)
            .map_err(|error| error.to_string())?;
        save_sync_baseline(&state_directory, &tree, &mut connection, Some(commit))
            .map_err(|error| error.to_string())?;
    } else {
        emit_github_progress(
            app,
            &input.operation_id,
            &input.project_id,
            "connect",
            "saving-connection",
            "仓库验证成功，正在保存连接设置…",
        );
        save_connection(&state_directory, &connection).map_err(|error| error.to_string())?;
    }
    // A stored token has already been read into the process cache. Writing the same
    // secret back would make macOS authorize a redundant Keychain read and update.
    token_origin
        .persist_if_provided(|| save_session_github_token(app, &input.project_id, &token))?;
    Ok(GithubConnectionResult {
        repository_existed,
        private_repository_created: !repository_existed,
    })
}

#[tauri::command]
pub async fn get_github_connection(
    app: AppHandle,
    project_id: String,
) -> Result<Option<GithubConnectionStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || get_github_connection_blocking(&app, &project_id))
        .await
        .map_err(|error| format!("GitHub 凭据后台任务异常：{error}"))?
}

fn get_github_connection_blocking(
    app: &AppHandle,
    project_id: &str,
) -> Result<Option<GithubConnectionStatus>, String> {
    let state_directory = github_state_directory(app, project_id)?;
    if !state_directory.join("connection.json").is_file() {
        return Ok(None);
    }
    let connection = load_connection(&state_directory).map_err(|error| error.to_string())?;
    let credential_stored = github_credential_reported_stored(&state_directory);
    Ok(Some(GithubConnectionStatus {
        owner: connection.owner,
        repository: connection.repository,
        branch: connection.branch,
        last_synced_commit: connection.last_synced_commit,
        credential_stored,
    }))
}

#[tauri::command]
pub async fn preview_github_project_import(
    app: AppHandle,
    input: GithubProjectImportInput,
) -> Result<RemoteProjectImportSummary, String> {
    run_github_operation(app, move |app| {
        preview_github_project_import_blocking(app, input)
    })
    .await
}

fn preview_github_project_import_blocking(
    app: &AppHandle,
    input: GithubProjectImportInput,
) -> Result<RemoteProjectImportSummary, String> {
    let (token, token_origin) =
        resolve_github_import_token(app, input.placeholder_project_id.as_deref(), &input.token)?;
    let project_scope = input.placeholder_project_id.clone();
    let event_scope = project_scope
        .as_deref()
        .unwrap_or(GITHUB_IMPORT_EVENT_SCOPE)
        .to_owned();
    emit_github_progress(
        app,
        &input.operation_id,
        &event_scope,
        "previewImport",
        "checking-repository",
        "正在验证仓库、分支和读取权限…",
    );
    *app.state::<DesktopProjectSession>()
        .github_import_preview
        .lock()
        .map_err(|_| "GitHub 导入预览缓存异常，请重新启动应用".to_owned())? = None;
    let result = (|| {
        let connection = GithubConnection {
            owner: input.owner.clone(),
            repository: input.repository.clone(),
            branch: input.branch.clone(),
            last_synced_commit: None,
        };
        let remote = github_remote_with_progress(
            app,
            connection,
            token,
            &input.operation_id,
            &event_scope,
            "previewImport",
        )?;
        let mut application = open_application_service(app)?;
        let service = RemoteProjectImportService::new(&mut application, &remote);
        let plan = service
            .plan(input.placeholder_project_id.as_deref())
            .map_err(|error| error.to_string())?;
        emit_github_progress(
            app,
            &input.operation_id,
            &event_scope,
            "previewImport",
            "preparing-preview",
            "资料读取完成，正在生成导入预览…",
        );
        let summary = plan.summary().clone();
        let cached_bytes = plan
            .tree()
            .files()
            .values()
            .fold(0usize, |total, bytes| total.saturating_add(bytes.len()));
        if cached_bytes <= GITHUB_IMPORT_PREVIEW_MAX_BYTES {
            *app.state::<DesktopProjectSession>()
                .github_import_preview
                .lock()
                .map_err(|_| "GitHub 导入预览缓存异常，请重新启动应用".to_owned())? =
                Some(CachedGithubImportPreview {
                    owner: input.owner.clone(),
                    repository: input.repository.clone(),
                    branch: input.branch.clone(),
                    placeholder_project_id: input.placeholder_project_id.clone(),
                    fingerprint: summary.fingerprint.clone(),
                    created_at: Instant::now(),
                    plan,
                });
        }
        Ok(summary)
    })();
    if let Some(project_id) = project_scope.as_deref() {
        forget_invalid_stored_credential(app, project_id, token_origin, result.as_ref().err());
    }
    result
}

#[tauri::command]
pub async fn apply_github_project_import(
    app: AppHandle,
    input: GithubProjectImportInput,
) -> Result<GithubProjectImportResult, String> {
    run_github_operation(app, move |app| {
        apply_github_project_import_blocking(app, input)
    })
    .await
}

fn apply_github_project_import_blocking(
    app: &AppHandle,
    input: GithubProjectImportInput,
) -> Result<GithubProjectImportResult, String> {
    let expected = input
        .expected_fingerprint
        .as_deref()
        .ok_or_else(|| "缺少 GitHub 导入预览标识，请重新预览".to_owned())?;
    let (token, token_origin) =
        resolve_github_import_token(app, input.placeholder_project_id.as_deref(), &input.token)?;
    let project_scope = input.placeholder_project_id.clone();
    let event_scope = project_scope
        .as_deref()
        .unwrap_or(GITHUB_IMPORT_EVENT_SCOPE)
        .to_owned();
    emit_github_progress(
        app,
        &input.operation_id,
        &event_scope,
        "applyImport",
        "validating-preview",
        "正在确认本地资料和 GitHub 提交没有变化…",
    );
    let result = (|| {
        let mut connection = GithubConnection {
            owner: input.owner.clone(),
            repository: input.repository.clone(),
            branch: input.branch.clone(),
            last_synced_commit: None,
        };
        let remote = github_remote_with_progress(
            app,
            connection.clone(),
            token.clone(),
            &input.operation_id,
            &event_scope,
            "applyImport",
        )?;
        let mut application = open_application_service(app)?;
        let mut service = RemoteProjectImportService::new(&mut application, &remote);
        let cached = app
            .state::<DesktopProjectSession>()
            .github_import_preview
            .lock()
            .map_err(|_| "GitHub 导入预览缓存异常，请重新启动应用".to_owned())?
            .take()
            .filter(|cached| cached.matches(&input, expected));
        let plan = if let Some(cached) = cached {
            let current_commit = remote.head().map_err(|error| error.to_string())?;
            if current_commit != cached.plan.summary().commit {
                return Err("GitHub 导入预览已经过期，请重新预览后再确认".to_owned());
            }
            emit_github_progress(
                app,
                &input.operation_id,
                &event_scope,
                "applyImport",
                "using-preview-cache",
                "预览资料仍然有效，正在直接导入…",
            );
            cached.plan
        } else {
            service
                .plan(input.placeholder_project_id.as_deref())
                .map_err(|error| error.to_string())?
        };
        if plan.summary().fingerprint != expected {
            return Err("GitHub 导入预览已经过期，请重新预览后再确认".to_owned());
        }
        let summary = plan.summary().clone();
        let tree = plan.tree().clone();
        let project = service.apply(plan).map_err(|error| error.to_string())?;

        let mut warnings = Vec::new();
        let state_directory = github_state_directory(app, &project.id)?;
        let baseline_updated = match save_sync_baseline(
            &state_directory,
            &tree,
            &mut connection,
            summary.commit.clone(),
        ) {
            Ok(()) => true,
            Err(error) => {
                warnings.push(format!("项目已导入，但同步基线保存失败：{error}"));
                false
            }
        };
        let credential_stored = match save_session_github_token(app, &project.id, &token) {
            Ok(()) => true,
            Err(error) => {
                warnings.push(format!("项目已导入，但 GitHub Token 保存失败：{error}"));
                false
            }
        };

        if let Some(replaced_project_id) = summary.replaces_project_id.as_deref() {
            if credential_stored {
                if let Err(error) = delete_session_github_token(app, replaced_project_id) {
                    warnings.push(format!("旧项目凭据清理失败：{error}"));
                }
            }
            if baseline_updated {
                let previous_state_directory = github_state_directory(app, replaced_project_id)?;
                if previous_state_directory.exists() {
                    if let Err(error) = fs::remove_dir_all(&previous_state_directory) {
                        warnings.push(format!("旧项目同步设置清理失败：{error}"));
                    }
                }
            }
        }

        Ok(GithubProjectImportResult {
            project_id: project.id,
            replaced_project_id: summary.replaces_project_id,
            baseline_updated,
            credential_stored,
            warnings,
        })
    })();
    if let Some(project_id) = project_scope.as_deref() {
        forget_invalid_stored_credential(app, project_id, token_origin, result.as_ref().err());
    }
    result
}

#[tauri::command]
pub async fn preview_github_sync(
    app: AppHandle,
    input: GithubSyncInput,
) -> Result<SyncPlanSummary, String> {
    run_github_operation(app, move |app| preview_github_sync_blocking(app, input)).await
}

fn preview_github_sync_blocking(
    app: &AppHandle,
    input: GithubSyncInput,
) -> Result<SyncPlanSummary, String> {
    let operation = if input.pull_only {
        "previewPull"
    } else {
        "previewFull"
    };
    emit_github_progress(
        app,
        &input.operation_id,
        &input.project_id,
        operation,
        "reading-local",
        "正在读取本地项目和同步基线…",
    );
    let state_directory = github_state_directory(app, &input.project_id)?;
    let connection = load_connection(&state_directory).map_err(|error| error.to_string())?;
    let (token, token_origin) = resolve_github_token(app, &input.project_id, &input.token)?;
    let remote = github_remote_with_progress(
        app,
        connection.clone(),
        token,
        &input.operation_id,
        &input.project_id,
        operation,
    )?;
    let mut application = open_application_service(app)?;
    let sync = SyncService::new(&mut application, &remote, state_directory, connection)
        .map_err(|error| error.to_string())?;
    emit_github_progress(
        app,
        &input.operation_id,
        &input.project_id,
        operation,
        "fetching-remote",
        "正在下载 GitHub 远端资料并生成差异…",
    );
    let result = sync
        .plan_with_resolutions_and_initialization(
            &input.project_id,
            sync_mode(&input),
            &input.resolutions,
            input.initialization_strategy,
        )
        .map(|plan| plan.summary().clone())
        .map_err(|error| error.to_string());
    forget_invalid_stored_credential(app, &input.project_id, token_origin, result.as_ref().err());
    result
}

#[tauri::command]
pub async fn apply_github_sync(
    app: AppHandle,
    input: GithubSyncInput,
) -> Result<SyncOutcome, String> {
    run_github_operation(app, move |app| apply_github_sync_blocking(app, input)).await
}

fn apply_github_sync_blocking(
    app: &AppHandle,
    input: GithubSyncInput,
) -> Result<SyncOutcome, String> {
    let operation = if input.pull_only {
        "applyPull"
    } else {
        "applyFull"
    };
    emit_github_progress(
        app,
        &input.operation_id,
        &input.project_id,
        operation,
        "validating-preview",
        "正在重新检查本地与 GitHub 状态…",
    );
    let expected = input
        .expected_fingerprint
        .as_deref()
        .ok_or_else(|| "缺少同步预览标识，请重新预览".to_owned())?;
    let (token, token_origin) = resolve_github_token(app, &input.project_id, &input.token)?;
    let result = (|| {
        let state_directory = github_state_directory(app, &input.project_id)?;
        let connection = load_connection(&state_directory).map_err(|error| error.to_string())?;
        let remote = github_remote_with_progress(
            app,
            connection.clone(),
            token,
            &input.operation_id,
            &input.project_id,
            operation,
        )?;
        let mut application = open_application_service(app)?;
        let mut service = SyncService::new(&mut application, &remote, state_directory, connection)
            .map_err(|error| error.to_string())?;
        let mode = sync_mode(&input);
        let plan = service
            .plan_with_resolutions_and_initialization(
                &input.project_id,
                mode,
                &input.resolutions,
                input.initialization_strategy,
            )
            .map_err(|error| error.to_string())?;
        if plan.summary().fingerprint != expected {
            return Err("同步预览已经过期，请重新预览后再确认".to_owned());
        }
        emit_github_progress(
            app,
            &input.operation_id,
            &input.project_id,
            operation,
            "applying-sync",
            match input.initialization_strategy {
                Some(SyncInitializationStrategy::Remote) => {
                    "检查完成，正在使用 GitHub 版本建立首次同步基线…"
                }
                Some(SyncInitializationStrategy::Local) => {
                    "检查完成，正在使用本地版本更新 GitHub 并建立首次同步基线…"
                }
                None if input.pull_only => "检查完成，正在应用 GitHub 资料…",
                None => "检查完成，正在合并并上传同步结果…",
            },
        );
        service.apply(plan, mode).map_err(|error| error.to_string())
    })();
    forget_invalid_stored_credential(app, &input.project_id, token_origin, result.as_ref().err());
    result
}

fn resolve_github_token(
    app: &AppHandle,
    project_id: &str,
    provided: &str,
) -> Result<(String, GithubTokenOrigin), String> {
    if !provided.trim().is_empty() {
        return Ok((provided.to_owned(), GithubTokenOrigin::Provided));
    }
    if let Some(token) = cached_github_token(app, project_id)? {
        return Ok((token, GithubTokenOrigin::Stored));
    }
    let state_directory = github_state_directory(app, project_id)?;
    if !github_credential_reported_stored(&state_directory) {
        return Err("没有找到已保存的 GitHub Token，请重新输入并连接仓库".to_owned());
    }
    match load_github_token(project_id)? {
        Some(token) => {
            remember_github_token(app, project_id, &token)?;
            mark_github_credential_available(app, project_id);
            Ok((token, GithubTokenOrigin::Stored))
        }
        None => {
            mark_github_credential_unavailable(app, project_id);
            Err("没有找到已保存的 GitHub Token，请重新输入并连接仓库".to_owned())
        }
    }
}

fn resolve_github_import_token(
    app: &AppHandle,
    placeholder_project_id: Option<&str>,
    provided: &str,
) -> Result<(String, GithubTokenOrigin), String> {
    if !provided.trim().is_empty() {
        return Ok((provided.to_owned(), GithubTokenOrigin::Provided));
    }
    let project_id = placeholder_project_id
        .ok_or_else(|| "从 GitHub 导入项目时必须输入 GitHub Token".to_owned())?;
    resolve_github_token(app, project_id, provided)
}

fn forget_invalid_stored_credential(
    app: &AppHandle,
    project_id: &str,
    token_origin: GithubTokenOrigin,
    error: Option<&String>,
) {
    if token_origin.uses_stored_credential()
        && error.is_some_and(|message| is_github_authentication_failure(message))
    {
        invalidate_session_github_token(app, project_id);
    }
}

fn cached_github_token(app: &AppHandle, project_id: &str) -> Result<Option<String>, String> {
    app.state::<DesktopProjectSession>()
        .github_credentials
        .lock()
        .map_err(|_| "GitHub 凭据会话异常，请重新启动应用".to_owned())
        .map(|cache| cache.get(project_id))
}

fn remember_github_token(app: &AppHandle, project_id: &str, token: &str) -> Result<(), String> {
    let state = app.state::<DesktopProjectSession>();
    let mut cache = state
        .github_credentials
        .lock()
        .map_err(|_| "GitHub 凭据会话异常，请重新启动应用".to_owned())?;
    cache.remember(project_id, token);
    Ok(())
}

fn forget_cached_github_token(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let state = app.state::<DesktopProjectSession>();
    let mut cache = state
        .github_credentials
        .lock()
        .map_err(|_| "GitHub 凭据会话异常，请重新启动应用".to_owned())?;
    cache.forget(project_id);
    Ok(())
}

fn save_session_github_token(app: &AppHandle, project_id: &str, token: &str) -> Result<(), String> {
    if let Err(error) = save_github_token(project_id, token) {
        mark_github_credential_unavailable(app, project_id);
        return Err(error);
    }
    remember_github_token(app, project_id, token)?;
    mark_github_credential_available(app, project_id);
    Ok(())
}

fn delete_session_github_token(app: &AppHandle, project_id: &str) -> Result<(), String> {
    invalidate_session_github_token(app, project_id);
    delete_github_token(project_id)
}

fn invalidate_session_github_token(app: &AppHandle, project_id: &str) {
    let _ = forget_cached_github_token(app, project_id);
    mark_github_credential_unavailable(app, project_id);
}

fn github_credential_reported_stored(state_directory: &std::path::Path) -> bool {
    // Avoid opening Keychain merely to render connection status. Existing connections are
    // treated as available until an actual GitHub operation proves the credential is missing.
    !state_directory
        .join(GITHUB_CREDENTIAL_UNAVAILABLE_FILE)
        .is_file()
}

fn mark_github_credential_available(app: &AppHandle, project_id: &str) {
    let Ok(state_directory) = github_state_directory(app, project_id) else {
        return;
    };
    let marker = state_directory.join(GITHUB_CREDENTIAL_UNAVAILABLE_FILE);
    if marker.is_file() {
        let _ = fs::remove_file(marker);
    }
}

fn mark_github_credential_unavailable(app: &AppHandle, project_id: &str) {
    let Ok(state_directory) = github_state_directory(app, project_id) else {
        return;
    };
    if fs::create_dir_all(&state_directory).is_ok() {
        let _ = fs::write(
            state_directory.join(GITHUB_CREDENTIAL_UNAVAILABLE_FILE),
            b"credential unavailable\n",
        );
    }
}

fn github_state_directory(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    if project_id.is_empty()
        || !project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("项目标识无效".to_owned());
    }
    Ok(app_data_directory(app)?.join("sync").join(project_id))
}

fn sync_mode(input: &GithubSyncInput) -> SyncMode {
    if input.pull_only {
        SyncMode::PullOnly
    } else {
        SyncMode::PullThenPush
    }
}

fn default_github_branch() -> String {
    "main".to_owned()
}

#[cfg(test)]
mod tests {
    use super::GithubTokenOrigin;

    #[test]
    fn reconnect_only_persists_an_explicitly_provided_token() {
        let mut persistence_calls = 0;

        GithubTokenOrigin::Stored
            .persist_if_provided(|| {
                persistence_calls += 1;
                Ok::<(), ()>(())
            })
            .expect("stored token reuse should succeed without persistence");
        GithubTokenOrigin::Provided
            .persist_if_provided(|| {
                persistence_calls += 1;
                Ok::<(), ()>(())
            })
            .expect("provided token should be persisted");

        assert_eq!(persistence_calls, 1);
        assert!(!GithubTokenOrigin::Provided.uses_stored_credential());
        assert!(GithubTokenOrigin::Stored.uses_stored_credential());
    }
}
