use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::blocking::{Client, RequestBuilder};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::application::ApplicationService;
use crate::core::error::{CoreError, CoreResult};
use crate::core::project::ProjectRecord;
use crate::project_format::ProjectTree;

const DEFAULT_GITHUB_API: &str = "https://api.github.com";
const DEFAULT_GITHUB_LFS: &str = "https://github.com";
const USER_AGENT: &str = "Branchloom/0.1";
const GITHUB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const GITHUB_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const SYNC_STATE_FILE: &str = "connection.json";
const SYNC_BASE_FILE: &str = "base.blp";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubConnection {
    pub owner: String,
    pub repository: String,
    #[serde(default = "default_branch")]
    pub branch: String,
    pub last_synced_commit: Option<String>,
}

impl GithubConnection {
    pub fn validate(&self) -> CoreResult<()> {
        validate_github_name(&self.owner, "owner")?;
        validate_github_name(&self.repository, "repository")?;
        if self.branch.is_empty()
            || self.branch.starts_with('/')
            || self.branch.ends_with('/')
            || self.branch.contains("..")
            || self.branch.contains('\\')
            || self
                .branch
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte == b' ')
        {
            return Err(CoreError::Validation(format!(
                "invalid GitHub branch: {}",
                self.branch
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncMode {
    PullOnly,
    PullThenPush,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncInitializationStrategy {
    Remote,
    Local,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteProject {
    pub commit: Option<String>,
    pub tree: Option<ProjectTree>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub path: String,
    pub field: String,
    pub base: Option<Value>,
    pub ours: Option<Value>,
    pub theirs: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolution {
    pub path: String,
    pub field: String,
    pub choice: ResolutionChoice,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolutionChoice {
    Base,
    Ours,
    Theirs,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MergeResult {
    pub tree: Option<ProjectTree>,
    pub conflicts: Vec<SyncConflict>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub status: String,
    pub pulled_commit: Option<String>,
    pub pushed_commit: Option<String>,
    pub changed_local: bool,
    pub baseline_updated: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlanSummary {
    pub pulled_commit: Option<String>,
    pub changed_local: bool,
    pub will_push: bool,
    pub conflicts: Vec<SyncConflict>,
    pub fingerprint: String,
}

pub struct SyncPlan {
    summary: SyncPlanSummary,
    data_revision: i64,
    local_tree: ProjectTree,
    remote: RemoteProject,
    merged: Option<ProjectTree>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProjectImportSummary {
    pub project_id: String,
    pub project_name: String,
    pub project_description: String,
    pub commit: Option<String>,
    pub record_counts: BTreeMap<String, usize>,
    pub replaces_project_id: Option<String>,
    pub already_exists: bool,
    pub fingerprint: String,
}

pub struct RemoteProjectImportPlan {
    summary: RemoteProjectImportSummary,
    data_revision: i64,
    tree: ProjectTree,
}

impl RemoteProjectImportPlan {
    pub fn summary(&self) -> &RemoteProjectImportSummary {
        &self.summary
    }

    pub fn tree(&self) -> &ProjectTree {
        &self.tree
    }
}

pub struct RemoteProjectImportService<'a, R: ProjectRemote> {
    application: &'a mut ApplicationService,
    remote: &'a R,
}

impl<'a, R: ProjectRemote> RemoteProjectImportService<'a, R> {
    pub fn new(application: &'a mut ApplicationService, remote: &'a R) -> Self {
        Self {
            application,
            remote,
        }
    }

    pub fn plan(
        &self,
        placeholder_project_id: Option<&str>,
    ) -> CoreResult<RemoteProjectImportPlan> {
        let data_revision = self.application.data_revision()?;
        let remote = self.remote.pull()?;
        let tree = remote.tree.ok_or_else(|| {
            CoreError::Validation(
                "GitHub repository does not contain a Branchloom project".to_owned(),
            )
        })?;
        let data = tree.parse_project_data()?;
        let project_id = data.project_id()?.to_owned();
        let project_name = data
            .project
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| CoreError::Validation("remote project name is required".to_owned()))?
            .to_owned();
        let project_description = data
            .project
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();

        if let Some(placeholder_project_id) = placeholder_project_id {
            self.application.get_project(placeholder_project_id)?;
            if placeholder_project_id == project_id {
                return Err(CoreError::Validation(
                    "GitHub project is already the current local project; use synchronization"
                        .to_owned(),
                ));
            }
            if !self
                .application
                .project_is_empty_for_replacement(placeholder_project_id)?
            {
                return Err(CoreError::Conflict(
                    "local project is not empty and cannot be replaced by a GitHub project"
                        .to_owned(),
                ));
            }
        }

        let already_exists = self
            .application
            .list_projects()?
            .iter()
            .any(|project| project.id == project_id);
        let record_counts = data
            .collections
            .iter()
            .map(|(collection, records)| (collection.clone(), records.len()))
            .collect::<BTreeMap<_, _>>();
        let fingerprint = format!(
            "github-import.v1.{}",
            sha256_hex(
                json!({
                    "localRevision": data_revision,
                    "remoteCommit": remote.commit.as_deref(),
                    "remoteTree": tree_digest(&tree),
                    "placeholderProjectId": placeholder_project_id,
                    "projectId": project_id.as_str(),
                })
                .to_string()
                .as_bytes(),
            )
        );
        Ok(RemoteProjectImportPlan {
            summary: RemoteProjectImportSummary {
                project_id,
                project_name,
                project_description,
                commit: remote.commit,
                record_counts,
                replaces_project_id: placeholder_project_id.map(str::to_owned),
                already_exists,
                fingerprint,
            },
            data_revision,
            tree,
        })
    }

    pub fn apply(&mut self, plan: RemoteProjectImportPlan) -> CoreResult<ProjectRecord> {
        if plan.summary.already_exists {
            return Err(CoreError::Conflict(format!(
                "project already exists: {}",
                plan.summary.project_id
            )));
        }
        if let Some(placeholder_project_id) = plan.summary.replaces_project_id.as_deref() {
            self.application
                .replace_empty_project_with_tree_if_revision(
                    placeholder_project_id,
                    &plan.tree,
                    plan.data_revision,
                )
        } else {
            self.application
                .import_project_tree_if_revision(&plan.tree, false, plan.data_revision)
        }
    }
}

impl SyncPlan {
    pub fn summary(&self) -> &SyncPlanSummary {
        &self.summary
    }
}

pub trait ProjectRemote {
    fn pull(&self) -> CoreResult<RemoteProject>;
    fn push(&self, expected_commit: Option<&str>, tree: &ProjectTree) -> CoreResult<String>;
}

pub struct SyncService<'a, R: ProjectRemote> {
    application: &'a mut ApplicationService,
    remote: &'a R,
    state_directory: PathBuf,
    connection: GithubConnection,
}

impl<'a, R: ProjectRemote> SyncService<'a, R> {
    pub fn new(
        application: &'a mut ApplicationService,
        remote: &'a R,
        state_directory: impl AsRef<Path>,
        connection: GithubConnection,
    ) -> CoreResult<Self> {
        connection.validate()?;
        Ok(Self {
            application,
            remote,
            state_directory: state_directory.as_ref().to_path_buf(),
            connection,
        })
    }

    pub fn run(&mut self, project_id: &str, mode: SyncMode) -> CoreResult<SyncOutcome> {
        let plan = self.plan(project_id, mode)?;
        self.apply(plan, mode)
    }

    pub fn plan(&self, project_id: &str, mode: SyncMode) -> CoreResult<SyncPlan> {
        self.plan_with_resolutions(project_id, mode, &[])
    }

    pub fn plan_with_resolutions(
        &self,
        project_id: &str,
        mode: SyncMode,
        resolutions: &[ConflictResolution],
    ) -> CoreResult<SyncPlan> {
        self.plan_with_resolutions_and_initialization(project_id, mode, resolutions, None)
    }

    pub fn plan_with_resolutions_and_initialization(
        &self,
        project_id: &str,
        mode: SyncMode,
        resolutions: &[ConflictResolution],
        initialization_strategy: Option<SyncInitializationStrategy>,
    ) -> CoreResult<SyncPlan> {
        let data_revision = self.application.data_revision()?;
        let local_tree = self.application.export_project_tree(project_id)?;
        let remote = self.remote.pull()?;
        if let Some(remote_tree) = remote.tree.as_ref() {
            let remote_data = remote_tree.parse_project_data()?;
            let remote_project_id = remote_data.project_id()?;
            if remote_project_id != project_id {
                return Err(CoreError::Conflict(format!(
                    "remote project id {remote_project_id} does not match local project id {project_id}; import the remote project as a separate local project before synchronization"
                )));
            }
        }
        let base = self.load_base()?;
        let initialization_required = self.connection.last_synced_commit != remote.commit
            && base.is_none()
            && remote
                .tree
                .as_ref()
                .is_some_and(|remote_tree| remote_tree != &local_tree);

        if initialization_required && initialization_strategy.is_none() {
            return Err(CoreError::Conflict(
                "remote project has history but no local synchronization baseline".to_owned(),
            ));
        }

        if initialization_strategy.is_some() && !initialization_required {
            return Err(CoreError::Validation(
                "synchronization initialization is not required; preview again without an initialization strategy"
                    .to_owned(),
            ));
        }
        if initialization_strategy.is_some() && !resolutions.is_empty() {
            return Err(CoreError::Validation(
                "synchronization initialization cannot include conflict resolutions".to_owned(),
            ));
        }
        if initialization_strategy == Some(SyncInitializationStrategy::Local)
            && mode == SyncMode::PullOnly
        {
            return Err(CoreError::Validation(
                "using the local project for synchronization initialization requires full synchronization"
                    .to_owned(),
            ));
        }

        let merge = match initialization_strategy {
            Some(SyncInitializationStrategy::Remote) => MergeResult {
                tree: remote.tree.clone(),
                conflicts: Vec::new(),
            },
            Some(SyncInitializationStrategy::Local) => MergeResult {
                tree: Some(local_tree.clone()),
                conflicts: Vec::new(),
            },
            None => merge_project_trees_with_resolutions(
                base.as_ref(),
                Some(&local_tree),
                remote.tree.as_ref(),
                resolutions,
            )?,
        };
        let changed_local = merge
            .tree
            .as_ref()
            .is_some_and(|merged| merged != &local_tree);
        let will_push =
            mode == SyncMode::PullThenPush && merge.tree.as_ref() != remote.tree.as_ref();
        let fingerprint = sync_fingerprint(
            &local_tree,
            remote.commit.as_deref(),
            merge.tree.as_ref(),
            &merge.conflicts,
            mode,
            initialization_strategy,
        );
        Ok(SyncPlan {
            summary: SyncPlanSummary {
                pulled_commit: remote.commit.clone(),
                changed_local,
                will_push,
                conflicts: merge.conflicts,
                fingerprint,
            },
            data_revision,
            local_tree,
            remote,
            merged: merge.tree,
        })
    }

    pub fn apply(&mut self, plan: SyncPlan, mode: SyncMode) -> CoreResult<SyncOutcome> {
        if !plan.summary.conflicts.is_empty() {
            return Err(CoreError::Conflict(serde_json::to_string(
                &plan.summary.conflicts,
            )?));
        }
        let merged = plan.merged.ok_or_else(|| {
            CoreError::Validation("synchronization produced an empty project".to_owned())
        })?;
        let should_change_local = merged != plan.local_tree;

        match mode {
            SyncMode::PullOnly => {
                let changed_local = if should_change_local {
                    self.application.import_project_tree_if_revision(
                        &merged,
                        true,
                        plan.data_revision,
                    )?;
                    true
                } else {
                    false
                };
                if let Some(remote_tree) = plan.remote.tree.as_ref() {
                    if let Err(error) = self.save_base(remote_tree, plan.remote.commit.clone()) {
                        return Ok(SyncOutcome {
                            status: "localAppliedBaselineFailed".to_owned(),
                            pulled_commit: plan.remote.commit,
                            pushed_commit: None,
                            changed_local,
                            baseline_updated: false,
                            error: Some(error.to_string()),
                        });
                    }
                }
                Ok(SyncOutcome {
                    status: "pulled".to_owned(),
                    pulled_commit: plan.remote.commit,
                    pushed_commit: None,
                    changed_local,
                    baseline_updated: true,
                    error: None,
                })
            }
            SyncMode::PullThenPush => {
                if plan.remote.tree.as_ref() == Some(&merged) {
                    let changed_local = if should_change_local {
                        self.application.import_project_tree_if_revision(
                            &merged,
                            true,
                            plan.data_revision,
                        )?;
                        true
                    } else {
                        false
                    };
                    if let Err(error) = self.save_base(&merged, plan.remote.commit.clone()) {
                        return Ok(SyncOutcome {
                            status: "localAppliedBaselineFailed".to_owned(),
                            pulled_commit: plan.remote.commit,
                            pushed_commit: None,
                            changed_local,
                            baseline_updated: false,
                            error: Some(error.to_string()),
                        });
                    }
                    return Ok(SyncOutcome {
                        status: "upToDate".to_owned(),
                        pulled_commit: plan.remote.commit,
                        pushed_commit: None,
                        changed_local,
                        baseline_updated: true,
                        error: None,
                    });
                }
                // Push before changing local data. If push fails, the database and
                // baseline remain untouched and the error is a true all-or-nothing failure.
                let pushed_commit = self.remote.push(plan.remote.commit.as_deref(), &merged)?;
                let changed_local = if should_change_local {
                    match self.application.import_project_tree_if_revision(
                        &merged,
                        true,
                        plan.data_revision,
                    ) {
                        Ok(_) => true,
                        Err(error) => {
                            return Ok(SyncOutcome {
                                status: "remotePushedLocalFailed".to_owned(),
                                pulled_commit: plan.remote.commit,
                                pushed_commit: Some(pushed_commit),
                                changed_local: false,
                                baseline_updated: false,
                                error: Some(error.to_string()),
                            });
                        }
                    }
                } else {
                    false
                };
                if let Err(error) = self.save_base(&merged, Some(pushed_commit.clone())) {
                    return Ok(SyncOutcome {
                        status: "changesAppliedBaselineFailed".to_owned(),
                        pulled_commit: plan.remote.commit,
                        pushed_commit: Some(pushed_commit),
                        changed_local,
                        baseline_updated: false,
                        error: Some(error.to_string()),
                    });
                }
                Ok(SyncOutcome {
                    status: "synchronized".to_owned(),
                    pulled_commit: plan.remote.commit,
                    pushed_commit: Some(pushed_commit),
                    changed_local,
                    baseline_updated: true,
                    error: None,
                })
            }
        }
    }

    fn load_base(&self) -> CoreResult<Option<ProjectTree>> {
        let path = self.state_directory.join(SYNC_BASE_FILE);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(ProjectTree::read_archive(&path)?))
    }

    fn save_base(&mut self, tree: &ProjectTree, commit: Option<String>) -> CoreResult<()> {
        save_sync_baseline(&self.state_directory, tree, &mut self.connection, commit)
    }
}

fn sync_fingerprint(
    local: &ProjectTree,
    remote_commit: Option<&str>,
    merged: Option<&ProjectTree>,
    conflicts: &[SyncConflict],
    mode: SyncMode,
    initialization_strategy: Option<SyncInitializationStrategy>,
) -> String {
    let value = json!({
        "local": tree_digest(local),
        "remoteCommit": remote_commit,
        "merged": merged.map(tree_digest),
        "conflicts": conflicts,
        "initializationStrategy": initialization_strategy,
        "mode": match mode {
            SyncMode::PullOnly => "pull",
            SyncMode::PullThenPush => "sync",
        }
    });
    format!("sync.v2.{}", sha256_hex(value.to_string().as_bytes()))
}

fn tree_digest(tree: &ProjectTree) -> String {
    let mut hasher = Sha256::new();
    for (path, bytes) in tree.files() {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn save_connection(directory: &Path, connection: &GithubConnection) -> CoreResult<()> {
    connection.validate()?;
    fs::create_dir_all(directory)?;
    let final_path = directory.join(SYNC_STATE_FILE);
    let temporary_path = directory.join(format!("connection-{}.json", Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(connection)?;
    bytes.push(b'\n');
    fs::write(&temporary_path, bytes)?;
    replace_file(&temporary_path, &final_path)
}

pub fn load_connection(directory: &Path) -> CoreResult<GithubConnection> {
    let connection: GithubConnection =
        serde_json::from_slice(&fs::read(directory.join(SYNC_STATE_FILE))?)?;
    connection.validate()?;
    Ok(connection)
}

pub fn save_sync_baseline(
    directory: &Path,
    tree: &ProjectTree,
    connection: &mut GithubConnection,
    commit: Option<String>,
) -> CoreResult<()> {
    fs::create_dir_all(directory)?;
    let final_archive = directory.join(SYNC_BASE_FILE);
    let temporary_archive = directory.join(format!("base-{}.blp", Uuid::new_v4()));
    tree.write_archive(&temporary_archive)?;
    replace_file(&temporary_archive, &final_archive)?;

    connection.last_synced_commit = commit;
    save_connection(directory, connection)
}

pub fn merge_project_trees(
    base: Option<&ProjectTree>,
    ours: Option<&ProjectTree>,
    theirs: Option<&ProjectTree>,
) -> CoreResult<MergeResult> {
    merge_project_trees_with_resolutions(base, ours, theirs, &[])
}

pub fn merge_project_trees_with_resolutions(
    base: Option<&ProjectTree>,
    ours: Option<&ProjectTree>,
    theirs: Option<&ProjectTree>,
    resolutions: &[ConflictResolution],
) -> CoreResult<MergeResult> {
    let resolution_map = resolutions
        .iter()
        .map(|resolution| {
            (
                (resolution.path.clone(), resolution.field.clone()),
                resolution.choice,
            )
        })
        .collect::<BTreeMap<_, _>>();
    if resolution_map.len() != resolutions.len() {
        return Err(CoreError::Validation(
            "conflict resolutions contain duplicate path and field pairs".to_owned(),
        ));
    }
    let mut used_resolutions = BTreeSet::new();
    let base_files = base.map(ProjectTree::files);
    let our_files = ours.map(ProjectTree::files);
    let their_files = theirs.map(ProjectTree::files);
    let paths = base_files
        .into_iter()
        .flat_map(|files| files.keys())
        .chain(our_files.into_iter().flat_map(|files| files.keys()))
        .chain(their_files.into_iter().flat_map(|files| files.keys()))
        .filter(|path| path.as_str() != "branchloom.jsonld")
        .cloned()
        .collect::<BTreeSet<_>>();

    let mut merged_files = BTreeMap::new();
    let mut conflicts = Vec::new();
    for path in paths {
        let base_value = base.and_then(|tree| tree.files().get(&path));
        let our_value = ours.and_then(|tree| tree.files().get(&path));
        let their_value = theirs.and_then(|tree| tree.files().get(&path));
        match merge_file(
            &path,
            base_value,
            our_value,
            their_value,
            &resolution_map,
            &mut used_resolutions,
        )? {
            FileMerge::Value(Some(bytes)) => {
                merged_files.insert(path, bytes);
            }
            FileMerge::Value(None) => {}
            FileMerge::Conflicts(mut found) => conflicts.append(&mut found),
        }
    }

    if !conflicts.is_empty() {
        return Ok(MergeResult {
            tree: None,
            conflicts,
        });
    }
    if used_resolutions.len() != resolution_map.len() {
        let unused = resolution_map
            .keys()
            .filter(|key| !used_resolutions.contains(*key))
            .map(|(path, field)| format!("{path}#{field}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(CoreError::Validation(format!(
            "conflict resolutions do not match current conflicts: {unused}"
        )));
    }
    if merged_files.is_empty() {
        return Ok(MergeResult {
            tree: None,
            conflicts,
        });
    }
    Ok(MergeResult {
        tree: Some(ProjectTree::rebuild_manifest(merged_files)?),
        conflicts,
    })
}

enum FileMerge {
    Value(Option<Vec<u8>>),
    Conflicts(Vec<SyncConflict>),
}

fn merge_file(
    path: &str,
    base: Option<&Vec<u8>>,
    ours: Option<&Vec<u8>>,
    theirs: Option<&Vec<u8>>,
    resolutions: &BTreeMap<(String, String), ResolutionChoice>,
    used_resolutions: &mut BTreeSet<(String, String)>,
) -> CoreResult<FileMerge> {
    if ours == theirs {
        return Ok(FileMerge::Value(ours.cloned()));
    }
    if ours == base {
        return Ok(FileMerge::Value(theirs.cloned()));
    }
    if theirs == base {
        return Ok(FileMerge::Value(ours.cloned()));
    }

    if path.ends_with(".json") || path.ends_with(".jsonld") {
        if let (Some(base), Some(ours), Some(theirs)) = (base, ours, theirs) {
            let base_json: Value = serde_json::from_slice(base)?;
            let our_json: Value = serde_json::from_slice(ours)?;
            let their_json: Value = serde_json::from_slice(theirs)?;
            let mut conflicts = Vec::new();
            let mut context = JsonMergeContext {
                path,
                resolutions,
                used_resolutions,
                conflicts: &mut conflicts,
            };
            let merged = merge_json_value(
                "",
                Some(&base_json),
                Some(&our_json),
                Some(&their_json),
                &mut context,
            );
            if conflicts.is_empty() {
                let mut bytes = serde_json::to_vec_pretty(
                    &merged.expect("three present JSON values produce a value"),
                )?;
                bytes.push(b'\n');
                return Ok(FileMerge::Value(Some(bytes)));
            }
            return Ok(FileMerge::Conflicts(conflicts));
        }
    }

    let conflict = SyncConflict {
        path: path.to_owned(),
        field: String::new(),
        base: bytes_for_conflict(base),
        ours: bytes_for_conflict(ours),
        theirs: bytes_for_conflict(theirs),
    };
    if let Some(choice) = resolution_choice(resolutions, used_resolutions, path, "") {
        return Ok(FileMerge::Value(match choice {
            ResolutionChoice::Base => base.cloned(),
            ResolutionChoice::Ours => ours.cloned(),
            ResolutionChoice::Theirs => theirs.cloned(),
        }));
    }
    Ok(FileMerge::Conflicts(vec![conflict]))
}

struct JsonMergeContext<'a> {
    path: &'a str,
    resolutions: &'a BTreeMap<(String, String), ResolutionChoice>,
    used_resolutions: &'a mut BTreeSet<(String, String)>,
    conflicts: &'a mut Vec<SyncConflict>,
}

fn merge_json_value(
    pointer: &str,
    base: Option<&Value>,
    ours: Option<&Value>,
    theirs: Option<&Value>,
    context: &mut JsonMergeContext<'_>,
) -> Option<Value> {
    if ours == theirs {
        return ours.cloned();
    }
    if ours == base {
        return theirs.cloned();
    }
    if theirs == base {
        return ours.cloned();
    }

    if let (Some(Value::Object(base)), Some(Value::Object(ours)), Some(Value::Object(theirs))) =
        (base, ours, theirs)
    {
        let keys = base
            .keys()
            .chain(ours.keys())
            .chain(theirs.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut merged = Map::new();
        for key in keys {
            let child_pointer = format!("{pointer}/{}", escape_pointer(&key));
            if let Some(value) = merge_json_value(
                &child_pointer,
                base.get(&key),
                ours.get(&key),
                theirs.get(&key),
                context,
            ) {
                merged.insert(key, value);
            }
        }
        return Some(Value::Object(merged));
    }

    let field = if pointer.is_empty() {
        "/".to_owned()
    } else {
        pointer.to_owned()
    };
    if let Some(choice) = resolution_choice(
        context.resolutions,
        context.used_resolutions,
        context.path,
        &field,
    ) {
        return match choice {
            ResolutionChoice::Base => base.cloned(),
            ResolutionChoice::Ours => ours.cloned(),
            ResolutionChoice::Theirs => theirs.cloned(),
        };
    }
    context.conflicts.push(SyncConflict {
        path: context.path.to_owned(),
        field,
        base: base.cloned(),
        ours: ours.cloned(),
        theirs: theirs.cloned(),
    });
    ours.cloned()
}

fn resolution_choice(
    resolutions: &BTreeMap<(String, String), ResolutionChoice>,
    used: &mut BTreeSet<(String, String)>,
    path: &str,
    field: &str,
) -> Option<ResolutionChoice> {
    let key = (path.to_owned(), field.to_owned());
    resolutions.get(&key).copied().inspect(|_| {
        used.insert(key);
    })
}

fn bytes_for_conflict(value: Option<&Vec<u8>>) -> Option<Value> {
    value.map(|bytes| {
        Value::String(format!(
            "sha256:{}",
            Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ))
    })
}

fn escape_pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

pub struct GithubRemote {
    client: Client,
    connection: GithubConnection,
    token: String,
    api_base: String,
    lfs_base: String,
}

impl GithubRemote {
    pub fn new(connection: GithubConnection, token: impl Into<String>) -> CoreResult<Self> {
        Self::with_endpoints(connection, token, DEFAULT_GITHUB_API, DEFAULT_GITHUB_LFS)
    }

    pub fn with_endpoints(
        connection: GithubConnection,
        token: impl Into<String>,
        api_base: impl Into<String>,
        lfs_base: impl Into<String>,
    ) -> CoreResult<Self> {
        connection.validate()?;
        let token = token.into();
        if token.trim().is_empty() {
            return Err(CoreError::Validation(
                "GitHub access token is required".to_owned(),
            ));
        }
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(GITHUB_CONNECT_TIMEOUT)
            .timeout(GITHUB_REQUEST_TIMEOUT)
            .build()
            .map_err(remote_error)?;
        Ok(Self {
            client,
            connection,
            token,
            api_base: api_base.into().trim_end_matches('/').to_owned(),
            lfs_base: lfs_base.into().trim_end_matches('/').to_owned(),
        })
    }

    pub fn repository_exists(&self) -> CoreResult<bool> {
        let response = self
            .request(Method::GET, &self.repository_path())
            .send()
            .map_err(remote_error)?;
        match response.status() {
            StatusCode::OK => Ok(true),
            StatusCode::NOT_FOUND => Ok(false),
            _ => Err(response_error(response)),
        }
    }

    pub fn create_private_repository(&self) -> CoreResult<()> {
        if self.repository_exists()? {
            return Err(CoreError::Conflict(format!(
                "GitHub repository already exists: {}/{}",
                self.connection.owner, self.connection.repository
            )));
        }
        let user: UserResponse = self.get_json("/user")?;
        let create_path = if user.login.eq_ignore_ascii_case(&self.connection.owner) {
            "/user/repos".to_owned()
        } else {
            format!("/orgs/{}/repos", self.connection.owner)
        };
        let response = self
            .request(Method::POST, &create_path)
            .json(&json!({
                "name": self.connection.repository,
                "private": true,
                "auto_init": true,
                "description": "Branchloom genealogy project"
            }))
            .send()
            .map_err(remote_error)?;
        if response.status() != StatusCode::CREATED {
            return Err(response_error(response));
        }
        let created: RepositoryResponse = response.json().map_err(remote_error)?;
        let expected = format!("{}/{}", self.connection.owner, self.connection.repository);
        if !created.full_name.eq_ignore_ascii_case(&expected) {
            return Err(CoreError::Remote(format!(
                "GitHub created {0}, but {expected} was requested",
                created.full_name
            )));
        }
        Ok(())
    }

    pub fn initialize_created_repository(&self, tree: &ProjectTree) -> CoreResult<String> {
        let repository: RepositoryResponse = self.get_json(&self.repository_path())?;
        let default_commit = self
            .pull_branch_head(&repository.default_branch)?
            .ok_or_else(|| {
                CoreError::Remote(
                    "GitHub has not finished initializing the new repository".to_owned(),
                )
            })?;

        if self.connection.branch != repository.default_branch {
            if self.pull_head()?.is_some() {
                return Err(CoreError::Conflict(format!(
                    "GitHub branch already exists while initializing the repository: {}",
                    self.connection.branch
                )));
            }
            let _: RefResponse = self.post_json(
                &format!("{}/git/refs", self.repository_path()),
                &json!({
                    "ref": format!("refs/heads/{}", self.connection.branch),
                    "sha": default_commit
                }),
                StatusCode::CREATED,
            )?;
        }

        self.push_tree(Some(&default_commit), tree)
    }

    fn pull_head(&self) -> CoreResult<Option<String>> {
        self.pull_branch_head(&self.connection.branch)
    }

    fn pull_branch_head(&self, branch: &str) -> CoreResult<Option<String>> {
        let path = format!("{}/git/ref/heads/{}", self.repository_path(), branch);
        let response = self
            .request(Method::GET, &path)
            .send()
            .map_err(remote_error)?;
        match response.status() {
            StatusCode::OK => {
                let reference: RefResponse = response.json().map_err(remote_error)?;
                Ok(Some(reference.object.sha))
            }
            StatusCode::NOT_FOUND => Ok(None),
            _ => Err(response_error(response)),
        }
    }

    fn load_tree(&self, commit_sha: &str) -> CoreResult<ProjectTree> {
        let commit: CommitResponse = self.get_json(&format!(
            "{}/git/commits/{commit_sha}",
            self.repository_path()
        ))?;
        let tree: TreeResponse = self.get_json(&format!(
            "{}/git/trees/{}?recursive=1",
            self.repository_path(),
            commit.tree.sha
        ))?;
        if tree.truncated {
            return Err(CoreError::Remote(
                "GitHub returned a truncated project tree".to_owned(),
            ));
        }
        let mut files = BTreeMap::new();
        for item in tree.tree {
            if item.kind != "blob" {
                continue;
            }
            let blob: BlobResponse = self.get_json(&format!(
                "{}/git/blobs/{}",
                self.repository_path(),
                item.sha
            ))?;
            if blob.encoding != "base64" {
                return Err(CoreError::Remote(format!(
                    "unsupported GitHub blob encoding for {}",
                    item.path
                )));
            }
            let encoded = blob.content.replace(['\r', '\n'], "");
            let mut bytes = BASE64.decode(encoded).map_err(|error| {
                CoreError::Remote(format!("invalid GitHub blob for {}: {error}", item.path))
            })?;
            if item.path.starts_with("media/") {
                if let Some(pointer) = LfsPointer::parse(&bytes)? {
                    bytes = self.download_lfs(&pointer)?;
                }
            }
            files.insert(item.path, bytes);
        }
        let tree = ProjectTree::new(files)?;
        tree.validate_manifest()?;
        Ok(tree)
    }

    fn push_tree(&self, expected_commit: Option<&str>, tree: &ProjectTree) -> CoreResult<String> {
        let current_commit = self.pull_head()?;
        if current_commit.as_deref() != expected_commit {
            return Err(CoreError::Conflict(
                "GitHub changed after pull; pull and merge again before push".to_owned(),
            ));
        }

        let mut entries = Vec::new();
        for (path, bytes) in tree.files() {
            let blob_bytes = if path.starts_with("media/") {
                let pointer = self.upload_lfs(bytes)?;
                pointer.to_bytes()
            } else {
                bytes.clone()
            };
            let blob: ShaResponse = self.post_json(
                &format!("{}/git/blobs", self.repository_path()),
                &json!({
                    "content": BASE64.encode(blob_bytes),
                    "encoding": "base64"
                }),
                StatusCode::CREATED,
            )?;
            entries.push(json!({
                "path": path,
                "mode": "100644",
                "type": "blob",
                "sha": blob.sha
            }));
        }
        let tree_response: ShaResponse = self.post_json(
            &format!("{}/git/trees", self.repository_path()),
            &json!({ "tree": entries }),
            StatusCode::CREATED,
        )?;
        let mut commit_body = json!({
            "message": "Synchronize Branchloom project",
            "tree": tree_response.sha
        });
        if let Some(parent) = expected_commit {
            commit_body["parents"] = json!([parent]);
        }
        let commit: ShaResponse = self.post_json(
            &format!("{}/git/commits", self.repository_path()),
            &commit_body,
            StatusCode::CREATED,
        )?;

        if expected_commit.is_some() {
            let response = self
                .request(
                    Method::PATCH,
                    &format!(
                        "{}/git/refs/heads/{}",
                        self.repository_path(),
                        self.connection.branch
                    ),
                )
                .json(&json!({ "sha": commit.sha, "force": false }))
                .send()
                .map_err(remote_error)?;
            if response.status() != StatusCode::OK {
                return Err(response_error(response));
            }
        } else {
            let _: RefResponse = self.post_json(
                &format!("{}/git/refs", self.repository_path()),
                &json!({
                    "ref": format!("refs/heads/{}", self.connection.branch),
                    "sha": commit.sha
                }),
                StatusCode::CREATED,
            )?;
        }
        Ok(commit.sha)
    }

    fn upload_lfs(&self, bytes: &[u8]) -> CoreResult<LfsPointer> {
        let pointer = LfsPointer::from_bytes(bytes);
        let object = self.lfs_batch("upload", &pointer)?;
        if let Some(action) = object.actions.get("upload") {
            let mut request = self.client.put(&action.href);
            request = apply_action_headers(request, &action.header)?;
            let response = request.body(bytes.to_vec()).send().map_err(remote_error)?;
            if !response.status().is_success() {
                return Err(response_error(response));
            }
        }
        if let Some(action) = object.actions.get("verify") {
            let mut request = self.client.post(&action.href);
            request = apply_action_headers(request, &action.header)?;
            let response = request
                .json(&json!({ "oid": pointer.oid, "size": pointer.size }))
                .send()
                .map_err(remote_error)?;
            if !response.status().is_success() {
                return Err(response_error(response));
            }
        }
        Ok(pointer)
    }

    fn download_lfs(&self, pointer: &LfsPointer) -> CoreResult<Vec<u8>> {
        let object = self.lfs_batch("download", pointer)?;
        let action = object.actions.get("download").ok_or_else(|| {
            CoreError::Remote(format!("Git LFS object is unavailable: {}", pointer.oid))
        })?;
        let mut request = self.client.get(&action.href);
        request = apply_action_headers(request, &action.header)?;
        let response = request.send().map_err(remote_error)?;
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        let bytes = response.bytes().map_err(remote_error)?.to_vec();
        let actual = LfsPointer::from_bytes(&bytes);
        if actual != *pointer {
            return Err(CoreError::Remote(format!(
                "Git LFS object checksum does not match: {}",
                pointer.oid
            )));
        }
        Ok(bytes)
    }

    fn lfs_batch(&self, operation: &str, pointer: &LfsPointer) -> CoreResult<LfsObject> {
        let url = format!(
            "{}/{}/{}.git/info/lfs/objects/batch",
            self.lfs_base, self.connection.owner, self.connection.repository
        );
        let basic = BASE64.encode(format!("x-access-token:{}", self.token));
        let response = self
            .client
            .post(url)
            .header("Authorization", format!("Basic {basic}"))
            .header("Accept", "application/vnd.git-lfs+json")
            .header("Content-Type", "application/vnd.git-lfs+json")
            .json(&json!({
                "operation": operation,
                "transfers": ["basic"],
                "objects": [{ "oid": pointer.oid, "size": pointer.size }]
            }))
            .send()
            .map_err(remote_error)?;
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        let batch: LfsBatchResponse = response.json().map_err(remote_error)?;
        let object = batch
            .objects
            .into_iter()
            .next()
            .ok_or_else(|| CoreError::Remote("Git LFS returned no object".to_owned()))?;
        if let Some(error) = object.error {
            return Err(CoreError::Remote(format!(
                "Git LFS rejected {}: {}",
                pointer.oid, error.message
            )));
        }
        Ok(object)
    }

    fn repository_path(&self) -> String {
        format!(
            "/repos/{}/{}",
            self.connection.owner, self.connection.repository
        )
    }

    fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{}", self.api_base, path))
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2026-03-10")
    }

    fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> CoreResult<T> {
        let response = self
            .request(Method::GET, path)
            .send()
            .map_err(remote_error)?;
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        response.json().map_err(remote_error)
    }

    fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &Value,
        expected_status: StatusCode,
    ) -> CoreResult<T> {
        let response = self
            .request(Method::POST, path)
            .json(body)
            .send()
            .map_err(remote_error)?;
        if response.status() != expected_status {
            return Err(response_error(response));
        }
        response.json().map_err(remote_error)
    }
}

impl ProjectRemote for GithubRemote {
    fn pull(&self) -> CoreResult<RemoteProject> {
        if !self.repository_exists()? {
            return Err(CoreError::Remote(format!(
                "GitHub repository does not exist: {}/{}",
                self.connection.owner, self.connection.repository
            )));
        }
        let commit = self.pull_head()?;
        let tree = commit
            .as_deref()
            .map(|sha| self.load_tree(sha))
            .transpose()?;
        Ok(RemoteProject { commit, tree })
    }

    fn push(&self, expected_commit: Option<&str>, tree: &ProjectTree) -> CoreResult<String> {
        self.push_tree(expected_commit, tree)
    }
}

#[derive(Debug, Deserialize)]
struct RepositoryResponse {
    full_name: String,
    default_branch: String,
}

#[derive(Debug, Deserialize)]
struct UserResponse {
    login: String,
}

#[derive(Debug, Deserialize)]
struct RefResponse {
    object: ShaResponse,
}

#[derive(Debug, Deserialize)]
struct ShaResponse {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct CommitResponse {
    tree: ShaResponse,
}

#[derive(Debug, Deserialize)]
struct TreeResponse {
    tree: Vec<TreeItem>,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct TreeItem {
    path: String,
    sha: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct BlobResponse {
    content: String,
    encoding: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LfsPointer {
    oid: String,
    size: u64,
}

impl LfsPointer {
    fn from_bytes(bytes: &[u8]) -> Self {
        use sha2::Digest;
        let oid = sha2::Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Self {
            oid,
            size: bytes.len() as u64,
        }
    }

    fn parse(bytes: &[u8]) -> CoreResult<Option<Self>> {
        let Ok(text) = std::str::from_utf8(bytes) else {
            return Ok(None);
        };
        if !text.starts_with("version https://git-lfs.github.com/spec/v1\n") {
            return Ok(None);
        }
        let mut oid = None;
        let mut size = None;
        for line in text.lines() {
            if let Some(value) = line.strip_prefix("oid sha256:") {
                oid = Some(value.to_owned());
            } else if let Some(value) = line.strip_prefix("size ") {
                size =
                    Some(value.parse::<u64>().map_err(|_| {
                        CoreError::Remote("invalid Git LFS pointer size".to_owned())
                    })?);
            }
        }
        let pointer = Self {
            oid: oid.ok_or_else(|| CoreError::Remote("Git LFS pointer has no oid".to_owned()))?,
            size: size
                .ok_or_else(|| CoreError::Remote("Git LFS pointer has no size".to_owned()))?,
        };
        if pointer.oid.len() != 64 || !pointer.oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CoreError::Remote(
                "Git LFS pointer has an invalid oid".to_owned(),
            ));
        }
        Ok(Some(pointer))
    }

    fn to_bytes(&self) -> Vec<u8> {
        format!(
            "version https://git-lfs.github.com/spec/v1\noid sha256:{}\nsize {}\n",
            self.oid, self.size
        )
        .into_bytes()
    }
}

#[derive(Debug, Deserialize)]
struct LfsBatchResponse {
    objects: Vec<LfsObject>,
}

#[derive(Debug, Deserialize)]
struct LfsObject {
    #[serde(default)]
    actions: BTreeMap<String, LfsAction>,
    error: Option<LfsError>,
}

#[derive(Debug, Deserialize)]
struct LfsAction {
    href: String,
    #[serde(default)]
    header: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct LfsError {
    message: String,
}

fn apply_action_headers(
    mut request: RequestBuilder,
    headers: &BTreeMap<String, String>,
) -> CoreResult<RequestBuilder> {
    for (key, value) in headers {
        request = request.header(key.as_str(), value.as_str());
    }
    Ok(request)
}

fn validate_github_name(value: &str, label: &str) -> CoreResult<()> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(CoreError::Validation(format!(
            "invalid GitHub {label}: {value}"
        )));
    }
    Ok(())
}

fn replace_file(source: &Path, destination: &Path) -> CoreResult<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::PermissionDenied
            ) && destination.is_file() =>
        {
            fs::remove_file(destination)?;
            fs::rename(source, destination)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn default_branch() -> String {
    "main".to_owned()
}

fn remote_error(error: reqwest::Error) -> CoreError {
    CoreError::Remote(error.to_string())
}

fn response_error(response: reqwest::blocking::Response) -> CoreError {
    let status = response.status();
    let message = response
        .text()
        .unwrap_or_else(|_| "unable to read response body".to_owned());
    CoreError::Remote(format!("GitHub returned {status}: {message}"))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn merges_changes_to_different_fields() {
        let base = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alice",
            "note": ""
        }));
        let ours = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alice Smith",
            "note": ""
        }));
        let theirs = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alice",
            "note": "Research"
        }));

        let result =
            merge_project_trees(Some(&base), Some(&ours), Some(&theirs)).expect("merge trees");
        assert!(result.conflicts.is_empty());
        let merged = result.tree.expect("merged tree");
        let person: Value = serde_json::from_slice(
            merged
                .files()
                .get("data/people/pe/person-test.jsonld")
                .expect("person file"),
        )
        .expect("parse person");
        assert_eq!(person["name"], "Alice Smith");
        assert_eq!(person["note"], "Research");
    }

    #[test]
    fn reports_same_field_and_delete_modify_conflicts() {
        let base = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alice"
        }));
        let ours = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alicia"
        }));
        let theirs = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alison"
        }));
        let result =
            merge_project_trees(Some(&base), Some(&ours), Some(&theirs)).expect("merge trees");
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].field, "/name");

        let deleted = remove_person(&ours);
        let result = merge_project_trees(Some(&base), Some(&deleted), Some(&theirs))
            .expect("merge delete and modify");
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(
            result.conflicts[0].path,
            "data/people/pe/person-test.jsonld"
        );
    }

    #[test]
    fn applies_structured_conflict_resolutions() {
        let base = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alice"
        }));
        let ours = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alicia"
        }));
        let theirs = json_file_tree(json!({
            "id": "person-test",
            "projectId": "project-test",
            "name": "Alison"
        }));
        let result = merge_project_trees_with_resolutions(
            Some(&base),
            Some(&ours),
            Some(&theirs),
            &[ConflictResolution {
                path: "data/people/pe/person-test.jsonld".to_owned(),
                field: "/name".to_owned(),
                choice: ResolutionChoice::Theirs,
            }],
        )
        .expect("resolve conflict");

        assert!(result.conflicts.is_empty());
        let person: Value = serde_json::from_slice(
            result
                .tree
                .expect("resolved tree")
                .files()
                .get("data/people/pe/person-test.jsonld")
                .expect("person file"),
        )
        .expect("parse person");
        assert_eq!(person["name"], "Alison");
    }

    #[test]
    fn requires_an_explicit_initialization_strategy_without_a_shared_baseline() {
        let directory = tempdir().expect("create temporary directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut application =
            ApplicationService::open(&database).expect("open application service");
        application
            .create_project_with_id(
                "project-test".to_owned(),
                crate::core::project::NewProject {
                    name: "Local".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let local = application
            .export_project_tree("project-test")
            .expect("export local project");
        let remote = FakeRemote::new(RemoteProject {
            commit: Some("commit-remote".to_owned()),
            tree: Some(replace_project_name(&local, "Remote")),
        });
        let connection = GithubConnection {
            owner: "alice".to_owned(),
            repository: "family".to_owned(),
            branch: "main".to_owned(),
            last_synced_commit: None,
        };
        let service = SyncService::new(
            &mut application,
            &remote,
            directory.path().join("sync"),
            connection,
        )
        .expect("create sync service");

        let error = service
            .plan("project-test", SyncMode::PullThenPush)
            .err()
            .expect("initialization choice must be required");

        assert!(error
            .to_string()
            .contains("remote project has history but no local synchronization baseline"));
        assert_eq!(remote.calls.borrow().as_slice(), ["pull"]);
    }

    #[test]
    fn imports_a_remote_project_with_its_stable_id_without_pushing() {
        let source_directory = tempdir().expect("create source directory");
        let mut source =
            ApplicationService::open(source_directory.path().join("branchloom.sqlite3"))
                .expect("open source application");
        source
            .create_project_with_id(
                "project-remote".to_owned(),
                crate::core::project::NewProject {
                    name: "Remote family".to_owned(),
                    description: "Shared archive".to_owned(),
                },
            )
            .expect("create remote project");
        let remote_tree = source
            .export_project_tree("project-remote")
            .expect("export remote project");
        let remote = FakeRemote::new(RemoteProject {
            commit: Some("commit-remote".to_owned()),
            tree: Some(remote_tree),
        });

        let target_directory = tempdir().expect("create target directory");
        let mut application =
            ApplicationService::open(target_directory.path().join("branchloom.sqlite3"))
                .expect("open target application");
        let mut service = RemoteProjectImportService::new(&mut application, &remote);
        let plan = service.plan(None).expect("plan remote import");
        assert_eq!(plan.summary().project_id, "project-remote");
        assert_eq!(plan.summary().project_name, "Remote family");
        assert!(!plan.summary().already_exists);

        let imported = service.apply(plan).expect("apply remote import");

        assert_eq!(imported.id, "project-remote");
        assert!(remote.pushed.borrow().is_none());
        assert_eq!(remote.calls.borrow().as_slice(), ["pull"]);
    }

    #[test]
    fn replaces_an_empty_placeholder_with_the_remote_stable_project() {
        let source_directory = tempdir().expect("create source directory");
        let mut source =
            ApplicationService::open(source_directory.path().join("branchloom.sqlite3"))
                .expect("open source application");
        source
            .create_project_with_id(
                "project-remote".to_owned(),
                crate::core::project::NewProject {
                    name: "Remote family".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create remote project");
        let remote = FakeRemote::new(RemoteProject {
            commit: Some("commit-remote".to_owned()),
            tree: Some(
                source
                    .export_project_tree("project-remote")
                    .expect("export remote project"),
            ),
        });

        let target_directory = tempdir().expect("create target directory");
        let mut application =
            ApplicationService::open(target_directory.path().join("branchloom.sqlite3"))
                .expect("open target application");
        application
            .create_project_with_id(
                "project-placeholder".to_owned(),
                crate::core::project::NewProject {
                    name: "Temporary".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create placeholder");
        let mut service = RemoteProjectImportService::new(&mut application, &remote);
        let plan = service
            .plan(Some("project-placeholder"))
            .expect("plan placeholder replacement");
        assert_eq!(
            plan.summary().replaces_project_id.as_deref(),
            Some("project-placeholder")
        );

        let imported = service.apply(plan).expect("replace placeholder");

        assert_eq!(imported.id, "project-remote");
        assert!(matches!(
            application.get_project("project-placeholder"),
            Err(CoreError::NotFound { .. })
        ));
        assert!(remote.pushed.borrow().is_none());
    }

    #[test]
    fn refuses_to_replace_a_placeholder_that_contains_business_records() {
        let source_directory = tempdir().expect("create source directory");
        let mut source =
            ApplicationService::open(source_directory.path().join("branchloom.sqlite3"))
                .expect("open source application");
        source
            .create_project_with_id(
                "project-remote".to_owned(),
                crate::core::project::NewProject {
                    name: "Remote family".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create remote project");
        let remote = FakeRemote::new(RemoteProject {
            commit: Some("commit-remote".to_owned()),
            tree: Some(
                source
                    .export_project_tree("project-remote")
                    .expect("export remote project"),
            ),
        });

        let target_directory = tempdir().expect("create target directory");
        let mut application =
            ApplicationService::open(target_directory.path().join("branchloom.sqlite3"))
                .expect("open target application");
        application
            .create_project_with_id(
                "project-placeholder".to_owned(),
                crate::core::project::NewProject {
                    name: "Local family".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create local project");
        application
            .put_record(
                crate::storage::Resource::Person,
                "person-local",
                "project-placeholder",
                &json!({
                    "id": "person-local",
                    "projectId": "project-placeholder",
                    "names": [],
                    "updatedAt": "2026-01-01T00:00:00Z"
                }),
            )
            .expect("create local person");
        let service = RemoteProjectImportService::new(&mut application, &remote);

        let error = service
            .plan(Some("project-placeholder"))
            .err()
            .expect("non-empty replacement must fail");

        assert!(error
            .to_string()
            .contains("local project is not empty and cannot be replaced"));
        assert!(application
            .get_record(crate::storage::Resource::Person, "person-local")
            .expect("read local person")
            .is_some());
        assert!(remote.pushed.borrow().is_none());
    }

    #[test]
    fn rejects_a_remote_project_with_a_different_stable_id() {
        let directory = tempdir().expect("create temporary directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut application =
            ApplicationService::open(&database).expect("open application service");
        application
            .create_project_with_id(
                "project-local".to_owned(),
                crate::core::project::NewProject {
                    name: "Same name".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let local = application
            .export_project_tree("project-local")
            .expect("export local project");
        let remote = FakeRemote::new(RemoteProject {
            commit: Some("commit-remote".to_owned()),
            tree: Some(replace_project_id(&local, "project-remote")),
        });
        let connection = GithubConnection {
            owner: "alice".to_owned(),
            repository: "family".to_owned(),
            branch: "main".to_owned(),
            last_synced_commit: None,
        };
        let service = SyncService::new(
            &mut application,
            &remote,
            directory.path().join("sync"),
            connection,
        )
        .expect("create sync service");

        let error = service
            .plan_with_resolutions_and_initialization(
                "project-local",
                SyncMode::PullThenPush,
                &[],
                Some(SyncInitializationStrategy::Remote),
            )
            .err()
            .expect("different project ids must be rejected");

        assert!(error.to_string().contains(
            "remote project id project-remote does not match local project id project-local"
        ));
        assert!(!directory.path().join("sync/base.blp").exists());
        assert!(remote.pushed.borrow().is_none());
    }

    #[test]
    fn initializes_from_the_remote_project_only_after_preview_and_apply() {
        let directory = tempdir().expect("create temporary directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut application =
            ApplicationService::open(&database).expect("open application service");
        application
            .create_project_with_id(
                "project-test".to_owned(),
                crate::core::project::NewProject {
                    name: "Local".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let local = application
            .export_project_tree("project-test")
            .expect("export local project");
        let remote_tree = replace_project_name(&local, "Remote");
        let remote = FakeRemote::new(RemoteProject {
            commit: Some("commit-remote".to_owned()),
            tree: Some(remote_tree.clone()),
        });
        let state_directory = directory.path().join("sync");
        let connection = GithubConnection {
            owner: "alice".to_owned(),
            repository: "family".to_owned(),
            branch: "main".to_owned(),
            last_synced_commit: None,
        };
        let mut service = SyncService::new(&mut application, &remote, &state_directory, connection)
            .expect("create sync service");

        let plan = service
            .plan_with_resolutions_and_initialization(
                "project-test",
                SyncMode::PullThenPush,
                &[],
                Some(SyncInitializationStrategy::Remote),
            )
            .expect("preview remote initialization");
        assert!(plan.summary().changed_local);
        assert!(!plan.summary().will_push);
        assert!(plan.summary().conflicts.is_empty());
        assert!(plan.summary().fingerprint.starts_with("sync.v2."));

        let outcome = service
            .apply(plan, SyncMode::PullThenPush)
            .expect("apply remote initialization");
        assert_eq!(outcome.status, "upToDate");
        assert!(outcome.changed_local);
        assert!(outcome.baseline_updated);
        drop(service);

        assert_eq!(
            application
                .get_project("project-test")
                .expect("read initialized project")
                .name,
            "Remote"
        );
        assert_eq!(remote.calls.borrow().as_slice(), ["pull"]);
        assert!(remote.pushed.borrow().is_none());
        assert_eq!(
            load_connection(&state_directory)
                .expect("load initialized connection")
                .last_synced_commit
                .as_deref(),
            Some("commit-remote")
        );
        assert_eq!(
            ProjectTree::read_archive(&state_directory.join(SYNC_BASE_FILE))
                .expect("read synchronization baseline"),
            remote_tree
        );
    }

    #[test]
    fn initializes_from_the_local_project_only_after_preview_and_apply() {
        let directory = tempdir().expect("create temporary directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut application =
            ApplicationService::open(&database).expect("open application service");
        application
            .create_project_with_id(
                "project-test".to_owned(),
                crate::core::project::NewProject {
                    name: "Local".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let local = application
            .export_project_tree("project-test")
            .expect("export local project");
        let remote = FakeRemote::new(RemoteProject {
            commit: Some("commit-remote".to_owned()),
            tree: Some(replace_project_name(&local, "Remote")),
        });
        let state_directory = directory.path().join("sync");
        let connection = GithubConnection {
            owner: "alice".to_owned(),
            repository: "family".to_owned(),
            branch: "main".to_owned(),
            last_synced_commit: None,
        };
        let mut service = SyncService::new(&mut application, &remote, &state_directory, connection)
            .expect("create sync service");

        let plan = service
            .plan_with_resolutions_and_initialization(
                "project-test",
                SyncMode::PullThenPush,
                &[],
                Some(SyncInitializationStrategy::Local),
            )
            .expect("preview local initialization");
        assert!(!plan.summary().changed_local);
        assert!(plan.summary().will_push);
        assert!(plan.summary().conflicts.is_empty());

        let outcome = service
            .apply(plan, SyncMode::PullThenPush)
            .expect("apply local initialization");
        assert_eq!(outcome.status, "synchronized");
        assert!(!outcome.changed_local);
        assert!(outcome.baseline_updated);
        drop(service);

        assert_eq!(remote.calls.borrow().as_slice(), ["pull", "push"]);
        assert_eq!(remote.pushed.borrow().as_ref(), Some(&local));
        assert_eq!(
            load_connection(&state_directory)
                .expect("load initialized connection")
                .last_synced_commit
                .as_deref(),
            Some("commit-new")
        );
        assert_eq!(
            ProjectTree::read_archive(&state_directory.join(SYNC_BASE_FILE))
                .expect("read synchronization baseline"),
            local
        );
    }

    #[test]
    fn synchronization_always_pulls_before_it_pushes() {
        let directory = tempdir().expect("create temporary directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut application =
            ApplicationService::open(&database).expect("open application service");
        application
            .create_project_with_id(
                "project-test".to_owned(),
                crate::core::project::NewProject {
                    name: "Family".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let local = application
            .export_project_tree("project-test")
            .expect("export project");
        let remote = FakeRemote::new(RemoteProject {
            commit: None,
            tree: None,
        });
        let connection = GithubConnection {
            owner: "alice".to_owned(),
            repository: "family".to_owned(),
            branch: "main".to_owned(),
            last_synced_commit: None,
        };
        let mut service = SyncService::new(
            &mut application,
            &remote,
            directory.path().join("sync"),
            connection,
        )
        .expect("create sync service");
        let outcome = service
            .run("project-test", SyncMode::PullThenPush)
            .expect("synchronize project");

        assert_eq!(remote.calls.borrow().as_slice(), ["pull", "push"]);
        assert_eq!(remote.pushed.borrow().as_ref(), Some(&local));
        assert_eq!(outcome.pushed_commit.as_deref(), Some("commit-new"));
        assert!(outcome.baseline_updated);
        assert!(outcome.error.is_none());
    }

    #[test]
    fn failed_push_does_not_apply_remote_changes_locally() {
        let directory = tempdir().expect("create temporary directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut application =
            ApplicationService::open(&database).expect("open application service");
        application
            .create_project_with_id(
                "project-test".to_owned(),
                crate::core::project::NewProject {
                    name: "Local".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let base = application
            .export_project_tree("project-test")
            .expect("export base project");
        let state_directory = directory.path().join("sync");
        let mut connection = GithubConnection {
            owner: "alice".to_owned(),
            repository: "family".to_owned(),
            branch: "main".to_owned(),
            last_synced_commit: None,
        };
        save_sync_baseline(
            &state_directory,
            &base,
            &mut connection,
            Some("commit-base".to_owned()),
        )
        .expect("save baseline");
        application
            .update_project(
                "project-test",
                crate::core::project::ProjectPatch {
                    name: "Local".to_owned(),
                    description: "local change".to_owned(),
                },
            )
            .expect("change local project");
        let remote_tree = replace_project_name(&base, "Remote");
        let remote = FailingPushRemote {
            pulled: RemoteProject {
                commit: Some("commit-remote".to_owned()),
                tree: Some(remote_tree),
            },
        };
        let mut service = SyncService::new(&mut application, &remote, &state_directory, connection)
            .expect("create sync service");

        let error = service
            .run("project-test", SyncMode::PullThenPush)
            .expect_err("push must fail");
        assert!(error.to_string().contains("push failed"));
        drop(service);
        assert_eq!(
            application
                .get_project("project-test")
                .expect("read local project")
                .name,
            "Local"
        );
    }

    #[test]
    fn successful_push_followed_by_stale_local_plan_reports_partial_success() {
        let directory = tempdir().expect("create temporary directory");
        let database = directory.path().join("branchloom.sqlite3");
        let mut application =
            ApplicationService::open(&database).expect("open application service");
        application
            .create_project_with_id(
                "project-test".to_owned(),
                crate::core::project::NewProject {
                    name: "Local".to_owned(),
                    description: String::new(),
                },
            )
            .expect("create project");
        let base = application
            .export_project_tree("project-test")
            .expect("export base project");
        let state_directory = directory.path().join("sync");
        let mut connection = GithubConnection {
            owner: "alice".to_owned(),
            repository: "family".to_owned(),
            branch: "main".to_owned(),
            last_synced_commit: None,
        };
        save_sync_baseline(
            &state_directory,
            &base,
            &mut connection,
            Some("commit-base".to_owned()),
        )
        .expect("save baseline");
        application
            .update_project(
                "project-test",
                crate::core::project::ProjectPatch {
                    name: "Local".to_owned(),
                    description: "local change".to_owned(),
                },
            )
            .expect("change local project");
        let remote = FakeRemote::new(RemoteProject {
            commit: Some("commit-remote".to_owned()),
            tree: Some(replace_project_name(&base, "Remote")),
        });
        let mut service = SyncService::new(&mut application, &remote, &state_directory, connection)
            .expect("create sync service");
        let plan = service
            .plan("project-test", SyncMode::PullThenPush)
            .expect("plan sync");
        let mut concurrent = ApplicationService::open(&database).expect("open concurrent service");
        concurrent
            .update_project(
                "project-test",
                crate::core::project::ProjectPatch {
                    name: "Concurrent".to_owned(),
                    description: String::new(),
                },
            )
            .expect("change local revision");

        let outcome = service
            .apply(plan, SyncMode::PullThenPush)
            .expect("partial success is explicit");
        assert_eq!(outcome.status, "remotePushedLocalFailed");
        assert_eq!(outcome.pushed_commit.as_deref(), Some("commit-new"));
        assert!(!outcome.changed_local);
        assert!(!outcome.baseline_updated);
        assert!(outcome
            .error
            .as_deref()
            .is_some_and(|error| error.contains("revision")));
    }

    struct FakeRemote {
        pulled: RemoteProject,
        calls: RefCell<Vec<&'static str>>,
        pushed: RefCell<Option<ProjectTree>>,
    }

    impl FakeRemote {
        fn new(pulled: RemoteProject) -> Self {
            Self {
                pulled,
                calls: RefCell::new(Vec::new()),
                pushed: RefCell::new(None),
            }
        }
    }

    impl ProjectRemote for FakeRemote {
        fn pull(&self) -> CoreResult<RemoteProject> {
            self.calls.borrow_mut().push("pull");
            Ok(self.pulled.clone())
        }

        fn push(&self, _expected_commit: Option<&str>, tree: &ProjectTree) -> CoreResult<String> {
            self.calls.borrow_mut().push("push");
            *self.pushed.borrow_mut() = Some(tree.clone());
            Ok("commit-new".to_owned())
        }
    }

    struct FailingPushRemote {
        pulled: RemoteProject,
    }

    impl ProjectRemote for FailingPushRemote {
        fn pull(&self) -> CoreResult<RemoteProject> {
            Ok(self.pulled.clone())
        }

        fn push(&self, _expected_commit: Option<&str>, _tree: &ProjectTree) -> CoreResult<String> {
            Err(CoreError::Conflict("push failed".to_owned()))
        }
    }

    fn replace_project_name(tree: &ProjectTree, name: &str) -> ProjectTree {
        let mut files = tree.clone().into_files();
        let mut project: Value =
            serde_json::from_slice(files.get("project.jsonld").expect("project document"))
                .expect("parse project document");
        project["name"] = json!(name);
        files.insert(
            "project.jsonld".to_owned(),
            serde_json::to_vec_pretty(&project).expect("serialize project document"),
        );
        ProjectTree::rebuild_manifest(files).expect("rebuild project manifest")
    }

    fn replace_project_id(tree: &ProjectTree, project_id: &str) -> ProjectTree {
        let mut files = tree.clone().into_files();
        let mut project: Value =
            serde_json::from_slice(files.get("project.jsonld").expect("project document"))
                .expect("parse project document");
        project["id"] = json!(project_id);
        files.insert(
            "project.jsonld".to_owned(),
            serde_json::to_vec_pretty(&project).expect("serialize project document"),
        );
        ProjectTree::rebuild_manifest(files).expect("rebuild project manifest")
    }

    fn json_file_tree(person: Value) -> ProjectTree {
        let base = base_files();
        let mut files = ProjectTree::rebuild_manifest(base)
            .expect("build base tree")
            .into_files();
        files.insert(
            "data/people/pe/person-test.jsonld".to_owned(),
            serde_json::to_vec_pretty(&person).expect("serialize person"),
        );
        ProjectTree::rebuild_manifest(files).expect("build project tree")
    }

    fn base_files() -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([
            (
                "project.jsonld".to_owned(),
                serde_json::to_vec_pretty(&json!({
                    "id": "project-test",
                    "name": "Family"
                }))
                .expect("serialize project"),
            ),
            ("context/branchloom-v1.jsonld".to_owned(), b"{}".to_vec()),
        ])
    }

    fn remove_person(tree: &ProjectTree) -> ProjectTree {
        let mut files = tree.clone().into_files();
        files.remove("data/people/pe/person-test.jsonld");
        ProjectTree::rebuild_manifest(files).expect("rebuild without person")
    }
}
