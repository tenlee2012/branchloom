use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const MANAGED_BY: &str = "app.branchloom.desktop";
const RECEIPT_SCHEMA_VERSION: u32 = 1;
const SKILL_RECEIPT_NAME: &str = ".branchloom-install.json";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    schema_version: u32,
    managed_by: String,
    desktop_version: String,
    cli_version: String,
    contract_version: u64,
    target_triple: String,
    platform: String,
    cli: BundleCli,
    skill: BundleSkill,
}

#[derive(Clone, Debug, Deserialize)]
struct BundleCli {
    file: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
struct BundleSkill {
    directory: String,
    sha256: String,
    files: Vec<FileHash>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct FileHash {
    path: String,
    sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum AiToolComponent {
    Cli,
    Skill,
}

impl AiToolComponent {
    fn label(self) -> &'static str {
        match self {
            Self::Cli => "CLI",
            Self::Skill => "Skill",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiToolsAction {
    Install,
    Update,
    Repair,
    Uninstall,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AiToolComponentState {
    NotInstalled,
    Installed,
    UpdateAvailable,
    Modified,
    Damaged,
    Conflict,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolComponentStatus {
    component: AiToolComponent,
    state: AiToolComponentState,
    path: String,
    installed_version: Option<String>,
    bundled_version: String,
    contract_version: Option<u64>,
    managed: bool,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolsStatus {
    platform: String,
    target_triple: String,
    desktop_version: String,
    contract_version: u64,
    cli: AiToolComponentStatus,
    skill: AiToolComponentStatus,
    compatible: bool,
    path_available: bool,
    path_instruction: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewAiToolsChangeInput {
    action: AiToolsAction,
    components: Vec<AiToolComponent>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAiToolsChangeInput {
    plan_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolsPlanChange {
    component: AiToolComponent,
    operation: String,
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolsPlanPreview {
    plan_id: String,
    action: AiToolsAction,
    changes: Vec<AiToolsPlanChange>,
    warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolsApplyResult {
    status: AiToolsStatus,
    changed: Vec<AiToolComponent>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallReceipt {
    schema_version: u32,
    managed_by: String,
    component: AiToolComponent,
    version: String,
    contract_version: u64,
    content_sha256: String,
    #[serde(default)]
    files: Vec<FileHash>,
}

#[derive(Clone, Debug)]
struct InstallLocations {
    cli: PathBuf,
    skill: PathBuf,
}

#[derive(Clone, Debug)]
struct ComponentInspection {
    status: AiToolComponentStatus,
    receipt: Option<InstallReceipt>,
    fingerprint: String,
}

#[derive(Clone, Debug)]
struct PendingPlan {
    id: String,
    action: AiToolsAction,
    components: Vec<AiToolComponent>,
    fingerprints: HashMap<AiToolComponent, String>,
    preview: AiToolsPlanPreview,
}

#[derive(Debug)]
struct Replacement {
    target: PathBuf,
    staged: Option<PathBuf>,
    backup: PathBuf,
    target_existed: bool,
    committed: bool,
}

pub struct AiToolsState {
    service: AiToolsService,
    pending_plans: Mutex<HashMap<String, PendingPlan>>,
}

struct AiToolsService {
    resource_root: PathBuf,
    locations: InstallLocations,
    verify_execution: bool,
}

impl AiToolsState {
    pub fn from_app(app: &AppHandle) -> Result<Self, String> {
        let resource_root = app
            .path()
            .resource_dir()
            .map_err(|error| format!("无法确定桌面资源目录：{error}"))?
            .join("ai-tools");
        let locations = InstallLocations::discover()?;
        Ok(Self {
            service: AiToolsService {
                resource_root,
                locations,
                verify_execution: true,
            },
            pending_plans: Mutex::new(HashMap::new()),
        })
    }

    fn preview(&self, input: PreviewAiToolsChangeInput) -> Result<AiToolsPlanPreview, String> {
        let plan = self.service.create_plan(input)?;
        let preview = plan.preview.clone();
        let mut pending = self
            .pending_plans
            .lock()
            .map_err(|_| "AI 工具安装计划状态异常，请重试".to_owned())?;
        if pending.len() >= 32 {
            pending.clear();
        }
        pending.insert(plan.id.clone(), plan);
        Ok(preview)
    }

    fn apply(&self, input: ApplyAiToolsChangeInput) -> Result<AiToolsApplyResult, String> {
        let plan = self
            .pending_plans
            .lock()
            .map_err(|_| "AI 工具安装计划状态异常，请重试".to_owned())?
            .remove(&input.plan_id)
            .ok_or_else(|| "安装预览已失效，请重新预览后再确认".to_owned())?;
        self.service.apply_plan(plan)
    }
}

impl InstallLocations {
    fn discover() -> Result<Self, String> {
        let home = home_directory()?;
        #[cfg(target_os = "windows")]
        let cli = {
            let root = absolute_environment_path("LOCALAPPDATA")?
                .unwrap_or_else(|| home.join("AppData").join("Local"));
            root.join("Branchloom").join("bin").join("branchloom.exe")
        };
        #[cfg(not(target_os = "windows"))]
        let cli = home.join(".local").join("bin").join("branchloom");

        let skill = skill_install_path(&home);
        Ok(Self { cli, skill })
    }
}

fn skill_install_path(home: &Path) -> PathBuf {
    home.join(".agents").join("skills").join("branchloom")
}

impl AiToolsService {
    fn manifest(&self) -> Result<BundleManifest, String> {
        let manifest_path = self.resource_root.join("manifest.json");
        let bytes =
            fs::read(&manifest_path).map_err(|error| format!("安装包缺少 AI 工具清单：{error}"))?;
        let manifest: BundleManifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("AI 工具清单格式无效：{error}"))?;
        if manifest.schema_version != 1 || manifest.managed_by != MANAGED_BY {
            return Err("AI 工具清单版本或来源不受支持".to_owned());
        }
        let expected_platform = current_platform()
            .ok_or_else(|| "当前系统或处理器架构不在 Branchloom 支持范围内".to_owned())?;
        if manifest.platform != expected_platform {
            return Err(format!(
                "安装包中的 CLI 平台为 {}，当前平台为 {}",
                manifest.platform, expected_platform
            ));
        }
        self.verify_bundle(&manifest)?;
        Ok(manifest)
    }

    fn verify_bundle(&self, manifest: &BundleManifest) -> Result<(), String> {
        let cli_source = checked_join(&self.resource_root, &manifest.cli.file)?;
        if hash_file(&cli_source)? != manifest.cli.sha256 {
            return Err("安装包内 CLI 校验失败，请重新安装桌面应用".to_owned());
        }
        let skill_root = checked_join(&self.resource_root, &manifest.skill.directory)?;
        let actual_files = hash_declared_files(&skill_root, &manifest.skill.files)?;
        if hash_file_list(&actual_files) != manifest.skill.sha256 {
            return Err("安装包内 Skill 校验失败，请重新安装桌面应用".to_owned());
        }
        Ok(())
    }

    fn status(&self) -> Result<AiToolsStatus, String> {
        let manifest = self.manifest()?;
        let cli = self.inspect_component(AiToolComponent::Cli, &manifest)?;
        let skill = self.inspect_component(AiToolComponent::Skill, &manifest)?;
        let compatible = is_usable_state(cli.status.state)
            && is_usable_state(skill.status.state)
            && cli.status.contract_version == skill.status.contract_version
            && cli.status.contract_version == Some(manifest.contract_version);
        let cli_directory = self
            .locations
            .cli
            .parent()
            .ok_or_else(|| "CLI 安装路径无效".to_owned())?;
        let path_available = directory_in_path(cli_directory);
        Ok(AiToolsStatus {
            platform: manifest.platform,
            target_triple: manifest.target_triple,
            desktop_version: manifest.desktop_version,
            contract_version: manifest.contract_version,
            cli: cli.status,
            skill: skill.status,
            compatible,
            path_available,
            path_instruction: (!path_available).then(|| path_instruction(cli_directory)),
        })
    }

    fn inspect_component(
        &self,
        component: AiToolComponent,
        manifest: &BundleManifest,
    ) -> Result<ComponentInspection, String> {
        match component {
            AiToolComponent::Cli => self.inspect_cli(manifest),
            AiToolComponent::Skill => self.inspect_skill(manifest),
        }
    }

    fn inspect_cli(&self, manifest: &BundleManifest) -> Result<ComponentInspection, String> {
        let target = &self.locations.cli;
        let receipt_path = cli_receipt_path(target)?;
        let fingerprint = combined_fingerprint(&[target, &receipt_path])?;
        let bundled_version = manifest.cli_version.clone();
        let path = display_path(target);
        if path_is_symlink(target)? || path_is_symlink(&receipt_path)? {
            return Ok(inspection(
                AiToolComponent::Cli,
                AiToolComponentState::Conflict,
                path,
                bundled_version,
                false,
                "安装位置是符号链接，Branchloom 不会覆盖它",
                fingerprint,
                None,
            ));
        }
        let receipt = read_receipt(&receipt_path)?;
        if !target.exists() {
            let (state, message, managed) = if receipt.is_some() {
                (
                    AiToolComponentState::Damaged,
                    "CLI 文件缺失，可以执行修复",
                    true,
                )
            } else {
                (AiToolComponentState::NotInstalled, "尚未安装 CLI", false)
            };
            return Ok(inspection(
                AiToolComponent::Cli,
                state,
                path,
                bundled_version,
                managed,
                message,
                fingerprint,
                receipt,
            ));
        }
        if !target.is_file() {
            return Ok(inspection(
                AiToolComponent::Cli,
                AiToolComponentState::Conflict,
                path,
                bundled_version,
                false,
                "CLI 安装位置已被其他目录占用",
                fingerprint,
                receipt,
            ));
        }
        let Some(receipt) = receipt else {
            return Ok(inspection(
                AiToolComponent::Cli,
                AiToolComponentState::Conflict,
                path,
                bundled_version,
                false,
                "安装位置已有非 Branchloom 管理的命令，不会覆盖",
                fingerprint,
                None,
            ));
        };
        if !valid_receipt(&receipt, AiToolComponent::Cli) {
            return Ok(inspection(
                AiToolComponent::Cli,
                AiToolComponentState::Conflict,
                path,
                bundled_version,
                false,
                "CLI 安装记录无效，不会覆盖现有命令",
                fingerprint,
                Some(receipt),
            ));
        }
        let actual_hash = hash_file(target)?;
        let (state, message) = if actual_hash != receipt.content_sha256 {
            (
                AiToolComponentState::Modified,
                "CLI 文件已被修改，可以明确确认后修复",
            )
        } else if receipt.version != manifest.cli_version
            || receipt.content_sha256 != manifest.cli.sha256
        {
            (
                AiToolComponentState::UpdateAvailable,
                "桌面安装包包含较新的 CLI",
            )
        } else {
            (AiToolComponentState::Installed, "CLI 已安装并通过校验")
        };
        Ok(inspection(
            AiToolComponent::Cli,
            state,
            path,
            bundled_version,
            true,
            message,
            fingerprint,
            Some(receipt),
        ))
    }

    fn inspect_skill(&self, manifest: &BundleManifest) -> Result<ComponentInspection, String> {
        let target = &self.locations.skill;
        let receipt_path = target.join(SKILL_RECEIPT_NAME);
        let fingerprint = fingerprint_path(target)?;
        let bundled_version = manifest.cli_version.clone();
        let path = display_path(target);
        if path_is_symlink(target)? {
            return Ok(inspection(
                AiToolComponent::Skill,
                AiToolComponentState::Conflict,
                path,
                bundled_version,
                false,
                "Skill 安装位置是符号链接，Branchloom 不会覆盖它",
                fingerprint,
                None,
            ));
        }
        if !target.exists() {
            return Ok(inspection(
                AiToolComponent::Skill,
                AiToolComponentState::NotInstalled,
                path,
                bundled_version,
                false,
                "尚未安装 Branchloom Skill",
                fingerprint,
                None,
            ));
        }
        if !target.is_dir() {
            return Ok(inspection(
                AiToolComponent::Skill,
                AiToolComponentState::Conflict,
                path,
                bundled_version,
                false,
                "Skill 安装位置已被其他文件占用",
                fingerprint,
                None,
            ));
        }
        let receipt = read_receipt(&receipt_path)?;
        let Some(receipt) = receipt else {
            return Ok(inspection(
                AiToolComponent::Skill,
                AiToolComponentState::Conflict,
                path,
                bundled_version,
                false,
                "安装位置已有非 Branchloom 管理的 Skill，不会覆盖",
                fingerprint,
                None,
            ));
        };
        if !valid_receipt(&receipt, AiToolComponent::Skill) {
            return Ok(inspection(
                AiToolComponent::Skill,
                AiToolComponentState::Conflict,
                path,
                bundled_version,
                false,
                "Skill 安装记录无效，不会覆盖现有内容",
                fingerprint,
                Some(receipt),
            ));
        }
        let current_files = list_actual_files(target, Some(SKILL_RECEIPT_NAME))?;
        let expected_paths = receipt
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<BTreeSet<_>>();
        let actual_paths = current_files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<BTreeSet<_>>();
        let current_hash = hash_file_list(&current_files);
        let (state, message) =
            if expected_paths != actual_paths || current_hash != receipt.content_sha256 {
                (
                    AiToolComponentState::Modified,
                    "Skill 内容已被修改，可以明确确认后修复",
                )
            } else if receipt.version != manifest.cli_version
                || receipt.content_sha256 != manifest.skill.sha256
            {
                (
                    AiToolComponentState::UpdateAvailable,
                    "桌面安装包包含较新的 Skill",
                )
            } else {
                (AiToolComponentState::Installed, "Skill 已安装并通过校验")
            };
        Ok(inspection(
            AiToolComponent::Skill,
            state,
            path,
            bundled_version,
            true,
            message,
            fingerprint,
            Some(receipt),
        ))
    }

    fn create_plan(&self, input: PreviewAiToolsChangeInput) -> Result<PendingPlan, String> {
        if input.components.is_empty() {
            return Err("请至少选择 CLI 或 Skill 中的一项".to_owned());
        }
        let mut seen = BTreeSet::new();
        for component in &input.components {
            if !seen.insert(format!("{component:?}")) {
                return Err("安装计划包含重复组件".to_owned());
            }
        }
        let manifest = self.manifest()?;
        let mut changes = Vec::new();
        let mut warnings = Vec::new();
        let mut fingerprints = HashMap::new();
        let mut components = Vec::new();
        for component in input.components {
            let inspection = self.inspect_component(component, &manifest)?;
            fingerprints.insert(component, inspection.fingerprint.clone());
            let state = inspection.status.state;
            let operation = match input.action {
                AiToolsAction::Install => match state {
                    AiToolComponentState::NotInstalled => "安装",
                    AiToolComponentState::Installed | AiToolComponentState::UpdateAvailable => {
                        continue
                    }
                    AiToolComponentState::Damaged if inspection.status.managed => "修复",
                    _ => return Err(conflict_message(component, state)),
                },
                AiToolsAction::Update => match state {
                    AiToolComponentState::NotInstalled => "安装",
                    AiToolComponentState::UpdateAvailable => "更新",
                    AiToolComponentState::Installed => continue,
                    AiToolComponentState::Damaged if inspection.status.managed => "修复",
                    AiToolComponentState::Modified => {
                        return Err(format!(
                            "{} 已被修改，请使用修复并确认覆盖",
                            component.label()
                        ))
                    }
                    _ => return Err(conflict_message(component, state)),
                },
                AiToolsAction::Repair => match state {
                    AiToolComponentState::Conflict => {
                        return Err(conflict_message(component, state))
                    }
                    AiToolComponentState::Modified => {
                        warnings.push(format!(
                            "{} 中受 Branchloom 管理的内容已被修改，修复会替换这些内容",
                            component.label()
                        ));
                        "修复"
                    }
                    AiToolComponentState::NotInstalled => "安装",
                    _ => "修复",
                },
                AiToolsAction::Uninstall => match state {
                    AiToolComponentState::NotInstalled => continue,
                    AiToolComponentState::Conflict => {
                        return Err(conflict_message(component, state))
                    }
                    AiToolComponentState::Modified => {
                        warnings.push(format!(
                            "{} 中已修改或新增的内容会保留，只移除未修改的受管理内容",
                            component.label()
                        ));
                        "卸载受管理内容"
                    }
                    _ if inspection.status.managed => "卸载",
                    _ => return Err(conflict_message(component, state)),
                },
            };
            changes.push(AiToolsPlanChange {
                component,
                operation: operation.to_owned(),
                path: inspection.status.path,
            });
            components.push(component);
        }
        let id = Uuid::new_v4().to_string();
        let preview = AiToolsPlanPreview {
            plan_id: id.clone(),
            action: input.action,
            changes,
            warnings,
        };
        Ok(PendingPlan {
            id,
            action: input.action,
            components,
            fingerprints,
            preview,
        })
    }

    fn apply_plan(&self, plan: PendingPlan) -> Result<AiToolsApplyResult, String> {
        let manifest = self.manifest()?;
        for component in &plan.components {
            let current = self.inspect_component(*component, &manifest)?;
            if plan.fingerprints.get(component) != Some(&current.fingerprint) {
                return Err(format!(
                    "{} 的安装状态在预览后发生变化，请重新预览",
                    component.label()
                ));
            }
        }
        if plan.components.is_empty() {
            return Ok(AiToolsApplyResult {
                status: self.status()?,
                changed: Vec::new(),
            });
        }

        let mut replacements = match plan.action {
            AiToolsAction::Install | AiToolsAction::Update | AiToolsAction::Repair => {
                self.prepare_install_replacements(&plan.components, &manifest)?
            }
            AiToolsAction::Uninstall => {
                self.prepare_uninstall_replacements(&plan.components, &manifest)?
            }
        };
        if let Err(error) = commit_replacements(&mut replacements) {
            rollback_replacements(&mut replacements);
            cleanup_staged(&replacements);
            return Err(error);
        }
        if plan.action != AiToolsAction::Uninstall
            && plan.components.contains(&AiToolComponent::Cli)
            && self.verify_execution
        {
            if let Err(error) = self.verify_installed_cli(&manifest) {
                rollback_replacements(&mut replacements);
                cleanup_staged(&replacements);
                return Err(error);
            }
        }
        finalize_replacements(&mut replacements)?;
        Ok(AiToolsApplyResult {
            status: self.status()?,
            changed: plan.components,
        })
    }

    fn prepare_install_replacements(
        &self,
        components: &[AiToolComponent],
        manifest: &BundleManifest,
    ) -> Result<Vec<Replacement>, String> {
        let mut replacements = Vec::new();
        let nonce = Uuid::new_v4().to_string();
        if components.contains(&AiToolComponent::Cli) {
            let target = &self.locations.cli;
            ensure_safe_parent(target)?;
            let source = checked_join(&self.resource_root, &manifest.cli.file)?;
            let staged = sibling_path(target, &format!(".branchloom-cli-stage-{nonce}"))?;
            fs::copy(&source, &staged).map_err(|error| format!("无法暂存 CLI：{error}"))?;
            set_executable(&staged)?;
            if hash_file(&staged)? != manifest.cli.sha256 {
                return Err("暂存后的 CLI 校验失败".to_owned());
            }
            let receipt_path = cli_receipt_path(target)?;
            let staged_receipt = sibling_path(
                &receipt_path,
                &format!(".branchloom-cli-receipt-stage-{nonce}"),
            )?;
            write_receipt(
                &staged_receipt,
                &InstallReceipt {
                    schema_version: RECEIPT_SCHEMA_VERSION,
                    managed_by: MANAGED_BY.to_owned(),
                    component: AiToolComponent::Cli,
                    version: manifest.cli_version.clone(),
                    contract_version: manifest.contract_version,
                    content_sha256: manifest.cli.sha256.clone(),
                    files: Vec::new(),
                },
            )?;
            replacements.push(replacement(target.clone(), Some(staged), &nonce)?);
            replacements.push(replacement(receipt_path, Some(staged_receipt), &nonce)?);
        }
        if components.contains(&AiToolComponent::Skill) {
            let target = &self.locations.skill;
            ensure_safe_parent(target)?;
            let staged = sibling_path(target, &format!(".branchloom-skill-stage-{nonce}"))?;
            fs::create_dir(&staged).map_err(|error| format!("无法暂存 Skill：{error}"))?;
            let source_root = checked_join(&self.resource_root, &manifest.skill.directory)?;
            copy_declared_files(&source_root, &staged, &manifest.skill.files)?;
            write_receipt(
                &staged.join(SKILL_RECEIPT_NAME),
                &InstallReceipt {
                    schema_version: RECEIPT_SCHEMA_VERSION,
                    managed_by: MANAGED_BY.to_owned(),
                    component: AiToolComponent::Skill,
                    version: manifest.cli_version.clone(),
                    contract_version: manifest.contract_version,
                    content_sha256: manifest.skill.sha256.clone(),
                    files: manifest.skill.files.clone(),
                },
            )?;
            replacements.push(replacement(target.clone(), Some(staged), &nonce)?);
        }
        Ok(replacements)
    }

    fn prepare_uninstall_replacements(
        &self,
        components: &[AiToolComponent],
        manifest: &BundleManifest,
    ) -> Result<Vec<Replacement>, String> {
        let nonce = Uuid::new_v4().to_string();
        let mut replacements = Vec::new();
        if components.contains(&AiToolComponent::Cli) {
            let inspection = self.inspect_cli(manifest)?;
            let receipt = inspection
                .receipt
                .ok_or_else(|| "CLI 安装记录不存在，无法安全卸载".to_owned())?;
            let target = self.locations.cli.clone();
            if target.exists() && hash_file(&target)? == receipt.content_sha256 {
                replacements.push(replacement(target.clone(), None, &nonce)?);
            }
            let receipt_path = cli_receipt_path(&target)?;
            if receipt_path.exists() {
                replacements.push(replacement(receipt_path, None, &nonce)?);
            }
        }
        if components.contains(&AiToolComponent::Skill) {
            let inspection = self.inspect_skill(manifest)?;
            let receipt = inspection
                .receipt
                .ok_or_else(|| "Skill 安装记录不存在，无法安全卸载".to_owned())?;
            let target = &self.locations.skill;
            let remainder = prepare_skill_remainder(target, &receipt, &nonce)?;
            replacements.push(replacement(target.clone(), remainder, &nonce)?);
        }
        Ok(replacements)
    }

    fn verify_installed_cli(&self, manifest: &BundleManifest) -> Result<(), String> {
        let diagnostic_data =
            env::temp_dir().join(format!("branchloom-ai-tools-diagnostic-{}", Uuid::new_v4()));
        let version = Command::new(&self.locations.cli)
            .args(["version", "--output", "json"])
            .output()
            .map_err(|error| format!("安装后的 CLI 无法启动：{error}"))?;
        if !version.status.success() {
            return Err("安装后的 CLI 版本检查失败".to_owned());
        }
        let version_json: serde_json::Value = serde_json::from_slice(&version.stdout)
            .map_err(|error| format!("CLI 版本输出无效：{error}"))?;
        if version_json["data"]["cliVersion"] != manifest.cli_version
            || version_json["contractVersion"] != manifest.contract_version
        {
            return Err("安装后的 CLI 版本或 contract version 不匹配".to_owned());
        }
        let doctor = Command::new(&self.locations.cli)
            .arg("doctor")
            .arg("--data-dir")
            .arg(&diagnostic_data)
            .args(["--output", "json"])
            .output()
            .map_err(|error| format!("安装后的 CLI 诊断无法启动：{error}"))?;
        let _ = remove_path(&diagnostic_data);
        if !doctor.status.success() {
            return Err("安装后的 CLI 兼容性诊断失败".to_owned());
        }
        let doctor_json: serde_json::Value = serde_json::from_slice(&doctor.stdout)
            .map_err(|error| format!("CLI 诊断输出无效：{error}"))?;
        if doctor_json["contractVersion"] != manifest.contract_version {
            return Err("安装后的 CLI contract version 不兼容".to_owned());
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn get_ai_tools_status(app: AppHandle) -> Result<AiToolsStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AiToolsState>().service.status())
        .await
        .map_err(|error| format!("AI 工具状态检查异常：{error}"))?
}

#[tauri::command]
pub async fn preview_ai_tools_change(
    app: AppHandle,
    input: PreviewAiToolsChangeInput,
) -> Result<AiToolsPlanPreview, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AiToolsState>().preview(input))
        .await
        .map_err(|error| format!("AI 工具安装预览异常：{error}"))?
}

#[tauri::command]
pub async fn apply_ai_tools_change(
    app: AppHandle,
    input: ApplyAiToolsChangeInput,
) -> Result<AiToolsApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<AiToolsState>().apply(input))
        .await
        .map_err(|error| format!("AI 工具安装任务异常：{error}"))?
}

#[allow(clippy::too_many_arguments)]
fn inspection(
    component: AiToolComponent,
    state: AiToolComponentState,
    path: String,
    bundled_version: String,
    managed: bool,
    message: &str,
    fingerprint: String,
    receipt: Option<InstallReceipt>,
) -> ComponentInspection {
    let installed_version = receipt.as_ref().map(|value| value.version.clone());
    let contract_version = receipt.as_ref().map(|value| value.contract_version);
    ComponentInspection {
        status: AiToolComponentStatus {
            component,
            state,
            path,
            installed_version,
            bundled_version,
            contract_version,
            managed,
            message: message.to_owned(),
        },
        receipt,
        fingerprint,
    }
}

fn valid_receipt(receipt: &InstallReceipt, component: AiToolComponent) -> bool {
    receipt.schema_version == RECEIPT_SCHEMA_VERSION
        && receipt.managed_by == MANAGED_BY
        && receipt.component == component
}

fn read_receipt(path: &Path) -> Result<Option<InstallReceipt>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| format!("安装记录无法读取：{}", display_path(path))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取安装记录：{error}")),
    }
}

fn write_receipt(path: &Path, receipt: &InstallReceipt) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(receipt).map_err(|error| format!("无法生成安装记录：{error}"))?;
    let mut file = fs::File::create(path).map_err(|error| format!("无法写入安装记录：{error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法保存安装记录：{error}"))
}

fn conflict_message(component: AiToolComponent, state: AiToolComponentState) -> String {
    format!(
        "{} 当前状态为 {state:?}，为避免覆盖非 Branchloom 内容，无法执行此操作",
        component.label()
    )
}

fn is_usable_state(state: AiToolComponentState) -> bool {
    matches!(
        state,
        AiToolComponentState::Installed | AiToolComponentState::UpdateAvailable
    )
}

fn current_platform() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Some("darwin-arm64");
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return Some("darwin-x64");
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Some("windows-x64");
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return Some("linux-x64");
    #[allow(unreachable_code)]
    None
}

fn home_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let home = absolute_environment_path("USERPROFILE")?;
    #[cfg(not(target_os = "windows"))]
    let home = absolute_environment_path("HOME")?;
    home.ok_or_else(|| "无法确定当前用户目录".to_owned())
}

fn absolute_environment_path(name: &str) -> Result<Option<PathBuf>, String> {
    let Some(value) = env::var_os(name) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("环境变量 {name} 必须是绝对路径"));
    }
    Ok(Some(path))
}

fn directory_in_path(directory: &Path) -> bool {
    let Some(value) = env::var_os("PATH") else {
        return false;
    };
    env::split_paths(&value).any(|candidate| paths_equal(&candidate, directory))
}

#[cfg(target_os = "windows")]
fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(target_os = "windows"))]
fn paths_equal(left: &Path, right: &Path) -> bool {
    left == right
}

fn path_instruction(_directory: &Path) -> String {
    #[cfg(target_os = "windows")]
    return format!(
        "$bin = '{}'; $user = [Environment]::GetEnvironmentVariable('Path', 'User'); [Environment]::SetEnvironmentVariable('Path', \"$user;$bin\", 'User')",
        display_path(_directory).replace('\\', "\\\\").replace('\'', "''")
    );
    #[cfg(not(target_os = "windows"))]
    {
        "export PATH=\"$HOME/.local/bin:$PATH\"".to_owned()
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn checked_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("安装清单包含不安全路径：{relative}"));
    }
    Ok(root.join(path))
}

fn ensure_safe_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "安装路径缺少父目录".to_owned())?;
    let mut missing = Vec::new();
    let mut cursor = parent;
    while !cursor.exists() {
        missing.push(cursor.to_path_buf());
        cursor = cursor
            .parent()
            .ok_or_else(|| "安装路径无法定位到现有目录".to_owned())?;
    }
    let mut prefix = PathBuf::new();
    for component in cursor.components() {
        prefix.push(component.as_os_str());
        if prefix.exists()
            && fs::symlink_metadata(&prefix)
                .map_err(|error| format!("无法检查安装目录：{error}"))?
                .file_type()
                .is_symlink()
        {
            return Err("安装目录经过符号链接，已停止操作".to_owned());
        }
    }
    for directory in missing.iter().rev() {
        fs::create_dir(directory).map_err(|error| format!("无法创建安装目录：{error}"))?;
    }
    if path_is_symlink(parent)? {
        return Err("安装目录是符号链接，已停止操作".to_owned());
    }
    Ok(())
}

fn path_is_symlink(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.file_type().is_symlink()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法检查路径：{error}")),
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取文件进行校验：{error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn hash_declared_files(root: &Path, files: &[FileHash]) -> Result<Vec<FileHash>, String> {
    let mut actual = Vec::with_capacity(files.len());
    for file in files {
        let path = checked_join(root, &file.path)?;
        let hash = hash_file(&path)?;
        if hash != file.sha256 {
            return Err(format!("Skill 文件校验失败：{}", file.path));
        }
        actual.push(FileHash {
            path: file.path.clone(),
            sha256: hash,
        });
    }
    actual.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(actual)
}

fn hash_file_list(files: &[FileHash]) -> String {
    let mut digest = Sha256::new();
    for file in files {
        digest.update(file.path.as_bytes());
        digest.update([0]);
        digest.update(file.sha256.as_bytes());
        digest.update(b"\n");
    }
    format!("{:x}", digest.finalize())
}

fn list_actual_files(root: &Path, excluded_name: Option<&str>) -> Result<Vec<FileHash>, String> {
    fn walk(
        root: &Path,
        current: &Path,
        excluded_name: Option<&str>,
        files: &mut Vec<FileHash>,
    ) -> Result<(), String> {
        let entries =
            fs::read_dir(current).map_err(|error| format!("无法读取 Skill 目录：{error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("无法读取 Skill 内容：{error}"))?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| format!("无法检查 Skill 内容：{error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("Skill 目录包含符号链接，已停止操作".to_owned());
            }
            if metadata.is_dir() {
                walk(root, &entry.path(), excluded_name, files)?;
            } else if metadata.is_file() {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| "Skill 路径越界".to_owned())?
                    .to_path_buf();
                if relative.components().count() == 1
                    && excluded_name.is_some_and(|name| relative == Path::new(name))
                {
                    continue;
                }
                files.push(FileHash {
                    path: relative.to_string_lossy().replace('\\', "/"),
                    sha256: hash_file(&entry.path())?,
                });
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, root, excluded_name, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn copy_declared_files(source: &Path, target: &Path, files: &[FileHash]) -> Result<(), String> {
    for file in files {
        let source_file = checked_join(source, &file.path)?;
        if hash_file(&source_file)? != file.sha256 {
            return Err(format!("Skill 来源文件校验失败：{}", file.path));
        }
        let target_file = checked_join(target, &file.path)?;
        if let Some(parent) = target_file.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建 Skill 目录：{error}"))?;
        }
        fs::copy(source_file, target_file)
            .map_err(|error| format!("无法复制 Skill 文件：{error}"))?;
    }
    Ok(())
}

fn combined_fingerprint(paths: &[&Path]) -> Result<String, String> {
    let mut digest = Sha256::new();
    for path in paths {
        digest.update(display_path(path).as_bytes());
        digest.update([0]);
        digest.update(fingerprint_path(path)?.as_bytes());
        digest.update(b"\n");
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn fingerprint_path(path: &Path) -> Result<String, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("missing".to_owned()),
        Err(error) => Err(format!("无法检查安装目标：{error}")),
        Ok(metadata) if metadata.file_type().is_symlink() => Ok("symlink".to_owned()),
        Ok(metadata) if metadata.is_file() => hash_file(path),
        Ok(metadata) if metadata.is_dir() => {
            let files = list_actual_files(path, None)?;
            Ok(hash_file_list(&files))
        }
        Ok(_) => Ok("unsupported".to_owned()),
    }
}

fn cli_receipt_path(cli: &Path) -> Result<PathBuf, String> {
    let name = cli
        .file_name()
        .ok_or_else(|| "CLI 安装路径缺少文件名".to_owned())?;
    let mut receipt_name = OsString::from(name);
    receipt_name.push(".branchloom-install.json");
    Ok(cli.with_file_name(receipt_name))
}

fn sibling_path(target: &Path, name: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "安装路径缺少父目录".to_owned())?;
    Ok(parent.join(name))
}

fn replacement(
    target: PathBuf,
    staged: Option<PathBuf>,
    nonce: &str,
) -> Result<Replacement, String> {
    let file_name = target
        .file_name()
        .ok_or_else(|| "安装目标缺少文件名".to_owned())?
        .to_string_lossy();
    let backup = sibling_path(&target, &format!(".{file_name}.branchloom-backup-{nonce}"))?;
    Ok(Replacement {
        target,
        staged,
        backup,
        target_existed: false,
        committed: false,
    })
}

fn commit_replacements(replacements: &mut [Replacement]) -> Result<(), String> {
    for replacement in replacements {
        replacement.target_existed = replacement.target.exists();
        if replacement.target_existed {
            fs::rename(&replacement.target, &replacement.backup)
                .map_err(|error| format!("无法备份现有安装：{error}"))?;
        }
        replacement.committed = true;
        if let Some(staged) = &replacement.staged {
            fs::rename(staged, &replacement.target)
                .map_err(|error| format!("无法启用新安装：{error}"))?;
        }
    }
    Ok(())
}

fn rollback_replacements(replacements: &mut [Replacement]) {
    for replacement in replacements.iter_mut().rev() {
        if !replacement.committed {
            continue;
        }
        let _ = remove_path(&replacement.target);
        if replacement.target_existed {
            let _ = fs::rename(&replacement.backup, &replacement.target);
        }
        replacement.committed = false;
    }
}

fn finalize_replacements(replacements: &mut [Replacement]) -> Result<(), String> {
    for replacement in replacements {
        if replacement.backup.exists() {
            remove_path(&replacement.backup)
                .map_err(|error| format!("安装已完成，但旧版本清理失败：{error}"))?;
        }
        replacement.committed = false;
    }
    Ok(())
}

fn cleanup_staged(replacements: &[Replacement]) {
    for replacement in replacements {
        if let Some(staged) = &replacement.staged {
            let _ = remove_path(staged);
        }
    }
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
        }
        Ok(_) => fs::remove_file(path),
    }
}

fn prepare_skill_remainder(
    target: &Path,
    receipt: &InstallReceipt,
    nonce: &str,
) -> Result<Option<PathBuf>, String> {
    let actual = list_actual_files(target, Some(SKILL_RECEIPT_NAME))?;
    let managed = receipt
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    let preserved = actual
        .iter()
        .filter(|file| managed.get(file.path.as_str()).copied() != Some(file.sha256.as_str()))
        .collect::<Vec<_>>();
    if preserved.is_empty() {
        return Ok(None);
    }
    let staged = sibling_path(target, &format!(".branchloom-skill-remainder-{nonce}"))?;
    fs::create_dir(&staged).map_err(|error| format!("无法暂存保留的 Skill 内容：{error}"))?;
    for file in preserved {
        let source = checked_join(target, &file.path)?;
        let destination = checked_join(&staged, &file.path)?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法暂存保留的 Skill 目录：{error}"))?;
        }
        fs::copy(source, destination)
            .map_err(|error| format!("无法保留已修改的 Skill 内容：{error}"))?;
    }
    Ok(Some(staged))
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("无法读取 CLI 权限：{error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("无法设置 CLI 执行权限：{error}"))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_fixture_bundle(root: &Path) -> BundleManifest {
        let cli_name = if cfg!(target_os = "windows") {
            "branchloom-cli.exe"
        } else {
            "branchloom-cli"
        };
        let cli_path = root.join("cli").join(cli_name);
        fs::create_dir_all(cli_path.parent().expect("CLI parent")).expect("create CLI fixture");
        fs::write(&cli_path, b"fixture-cli").expect("write CLI fixture");
        let skill_root = root.join("skills").join("branchloom");
        fs::create_dir_all(skill_root.join("references")).expect("create skill fixture");
        fs::write(skill_root.join("SKILL.md"), b"---\nname: branchloom\n---\n")
            .expect("write skill fixture");
        fs::write(
            skill_root.join("references/cli-reference.md"),
            b"contract 3\n",
        )
        .expect("write reference fixture");
        let skill_files = list_actual_files(&skill_root, None).expect("hash skill fixture");
        let manifest = BundleManifest {
            schema_version: 1,
            managed_by: MANAGED_BY.to_owned(),
            desktop_version: "0.1.1".to_owned(),
            cli_version: "0.1.1".to_owned(),
            contract_version: 3,
            target_triple: "test-target".to_owned(),
            platform: current_platform()
                .expect("supported test platform")
                .to_owned(),
            cli: BundleCli {
                file: format!("cli/{cli_name}"),
                sha256: hash_file(&cli_path).expect("hash CLI fixture"),
            },
            skill: BundleSkill {
                directory: "skills/branchloom".to_owned(),
                sha256: hash_file_list(&skill_files),
                files: skill_files,
            },
        };
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).expect("encode manifest"),
        )
        .expect("write manifest");
        manifest
    }

    impl Serialize for BundleManifest {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Serializable<'a> {
                schema_version: u32,
                managed_by: &'a str,
                desktop_version: &'a str,
                cli_version: &'a str,
                contract_version: u64,
                target_triple: &'a str,
                platform: &'a str,
                cli: SerializableCli<'a>,
                skill: SerializableSkill<'a>,
            }
            #[derive(Serialize)]
            struct SerializableCli<'a> {
                file: &'a str,
                sha256: &'a str,
            }
            #[derive(Serialize)]
            struct SerializableSkill<'a> {
                directory: &'a str,
                sha256: &'a str,
                files: &'a [FileHash],
            }
            Serializable {
                schema_version: self.schema_version,
                managed_by: &self.managed_by,
                desktop_version: &self.desktop_version,
                cli_version: &self.cli_version,
                contract_version: self.contract_version,
                target_triple: &self.target_triple,
                platform: &self.platform,
                cli: SerializableCli {
                    file: &self.cli.file,
                    sha256: &self.cli.sha256,
                },
                skill: SerializableSkill {
                    directory: &self.skill.directory,
                    sha256: &self.skill.sha256,
                    files: &self.skill.files,
                },
            }
            .serialize(serializer)
        }
    }

    fn fixture_service() -> (tempfile::TempDir, tempfile::TempDir, AiToolsService) {
        let bundle = tempdir().expect("bundle directory");
        write_fixture_bundle(bundle.path());
        let home = tempdir().expect("install directory");
        let install_root = home
            .path()
            .canonicalize()
            .expect("canonical install directory");
        let executable = if cfg!(target_os = "windows") {
            "branchloom.exe"
        } else {
            "branchloom"
        };
        let service = AiToolsService {
            resource_root: bundle.path().to_path_buf(),
            locations: InstallLocations {
                cli: install_root.join("bin").join(executable),
                skill: skill_install_path(&install_root),
            },
            verify_execution: false,
        };
        (bundle, home, service)
    }

    #[test]
    fn uses_the_shared_agents_skill_directory() {
        let home = PathBuf::from("example-home");
        assert_eq!(
            skill_install_path(&home),
            home.join(".agents").join("skills").join("branchloom")
        );
    }

    #[test]
    fn installs_updates_and_uninstalls_both_tools_without_touching_other_files() {
        let (_bundle, home, service) = fixture_service();
        let plan = service
            .create_plan(PreviewAiToolsChangeInput {
                action: AiToolsAction::Install,
                components: vec![AiToolComponent::Cli, AiToolComponent::Skill],
            })
            .expect("preview install");
        let result = service.apply_plan(plan).expect("apply install");
        assert_eq!(result.status.cli.state, AiToolComponentState::Installed);
        assert_eq!(result.status.skill.state, AiToolComponentState::Installed);
        assert!(service.locations.cli.exists());
        assert!(service.locations.skill.join("SKILL.md").exists());

        fs::write(service.locations.skill.join("notes.txt"), b"keep me")
            .expect("write unknown skill file");
        let modified = service.status().expect("modified status");
        assert_eq!(modified.skill.state, AiToolComponentState::Modified);
        let plan = service
            .create_plan(PreviewAiToolsChangeInput {
                action: AiToolsAction::Uninstall,
                components: vec![AiToolComponent::Cli, AiToolComponent::Skill],
            })
            .expect("preview uninstall");
        service.apply_plan(plan).expect("apply uninstall");
        assert!(!service.locations.cli.exists());
        assert!(!service.locations.skill.join("SKILL.md").exists());
        assert_eq!(
            fs::read(service.locations.skill.join("notes.txt")).expect("preserved file"),
            b"keep me"
        );
        assert!(!home.path().join("branchloom.sqlite3").exists());
    }

    #[test]
    fn refuses_to_overwrite_unmanaged_targets() {
        let (_bundle, _home, service) = fixture_service();
        fs::create_dir_all(service.locations.cli.parent().expect("CLI parent"))
            .expect("create CLI parent");
        fs::write(&service.locations.cli, b"another command").expect("write unmanaged CLI");
        let status = service.status().expect("status");
        assert_eq!(status.cli.state, AiToolComponentState::Conflict);
        let error = service
            .create_plan(PreviewAiToolsChangeInput {
                action: AiToolsAction::Install,
                components: vec![AiToolComponent::Cli],
            })
            .expect_err("unmanaged CLI must be refused");
        assert!(error.contains("无法执行"));
        assert_eq!(
            fs::read(&service.locations.cli).expect("unmanaged CLI remains"),
            b"another command"
        );
    }

    #[test]
    fn updates_cli_and_skill_together_when_the_desktop_bundle_version_changes() {
        let (bundle, _home, service) = fixture_service();
        let install = service
            .create_plan(PreviewAiToolsChangeInput {
                action: AiToolsAction::Install,
                components: vec![AiToolComponent::Cli, AiToolComponent::Skill],
            })
            .expect("preview install");
        service.apply_plan(install).expect("apply install");

        let manifest_path = bundle.path().join("manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("read fixture manifest"))
                .expect("decode fixture manifest");
        manifest["desktopVersion"] = serde_json::json!("0.1.2");
        manifest["cliVersion"] = serde_json::json!("0.1.2");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).expect("encode updated manifest"),
        )
        .expect("write updated manifest");

        let outdated = service.status().expect("outdated status");
        assert_eq!(outdated.cli.state, AiToolComponentState::UpdateAvailable);
        assert_eq!(outdated.skill.state, AiToolComponentState::UpdateAvailable);
        let update = service
            .create_plan(PreviewAiToolsChangeInput {
                action: AiToolsAction::Update,
                components: vec![AiToolComponent::Cli, AiToolComponent::Skill],
            })
            .expect("preview update");
        let updated = service.apply_plan(update).expect("apply update");
        assert_eq!(updated.status.cli.state, AiToolComponentState::Installed);
        assert_eq!(updated.status.skill.state, AiToolComponentState::Installed);
        assert_eq!(
            updated.status.cli.installed_version.as_deref(),
            Some("0.1.2")
        );
        assert_eq!(
            updated.status.skill.installed_version.as_deref(),
            Some("0.1.2")
        );
    }

    #[test]
    fn rejects_a_plan_when_the_target_changes_after_preview() {
        let (_bundle, _home, service) = fixture_service();
        let plan = service
            .create_plan(PreviewAiToolsChangeInput {
                action: AiToolsAction::Install,
                components: vec![AiToolComponent::Cli],
            })
            .expect("preview install");
        fs::create_dir_all(service.locations.cli.parent().expect("CLI parent"))
            .expect("create CLI parent");
        fs::write(&service.locations.cli, b"appeared after preview").expect("change target");
        let error = service.apply_plan(plan).expect_err("stale plan must fail");
        assert!(error.contains("发生变化"));
    }
}
