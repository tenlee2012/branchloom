//! Offline publication of an immutable project snapshot. No UI or database access in the worker.
mod charts;
mod layout;
pub mod plan;
mod render;
mod selection;
#[cfg(test)]
mod tests;
mod typography;

use crate::{
    core::error::{CoreError, CoreResult},
    project_format::ProjectData,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use plan::{invalid, PublicationPlan};
use selection::{Entry, Exclusion, Issue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tempfile::TempDir;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation: String,
    pub project_id: String,
    pub job_id: Option<String>,
    pub plan: Option<PublicationPlan>,
    pub plan_id: Option<String>,
    pub expected_revision: Option<i64>,
    pub attachment_id: Option<String>,
    pub offset: Option<u64>,
    pub length: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub people: usize,
    pub relationships: usize,
    pub branches: usize,
    pub pages: usize,
    pub bytes: u64,
    pub elapsed_ms: u128,
    pub entries: Vec<Entry>,
    pub excluded: Vec<Exclusion>,
    pub issues: Vec<Issue>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    state: String,
    stage: String,
    completed: usize,
    total: usize,
    revision: i64,
    pages: usize,
    bytes: u64,
    error: Option<String>,
}

pub struct Job {
    project_id: String,
    pub(crate) cancel: AtomicBool,
    status: Mutex<Status>,
    report: Mutex<Option<Report>>,
    directory: TempDir,
}

impl Job {
    pub(crate) fn checkpoint(&self, stage: &str, completed: usize, total: usize) -> CoreResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(invalid("编印已取消"));
        }
        let mut status = self
            .status
            .lock()
            .map_err(|_| invalid("编印任务状态不可用，请重新生成"))?;
        status.stage = stage.into();
        status.completed = completed;
        status.total = total;
        Ok(())
    }
    fn output(&self) -> PathBuf {
        self.directory.path().join("publication.pdf")
    }
}

#[derive(Default)]
pub struct Publications {
    jobs: BTreeMap<String, Arc<Job>>,
}

impl Drop for Publications {
    fn drop(&mut self) {
        for job in self.jobs.values() {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }
}

impl Publications {
    pub(crate) fn invalidate(&self, revision: i64) {
        for job in self.jobs.values() {
            if let Ok(status) = job.status.lock() {
                if status.revision != revision {
                    job.cancel.store(true, Ordering::Relaxed);
                    let _ = fs::remove_file(job.output());
                }
            }
        }
    }

    pub fn start(
        &mut self,
        project_id: String,
        revision: i64,
        plan: PublicationPlan,
        data: ProjectData,
        assets: BTreeMap<String, PathBuf>,
    ) -> CoreResult<Value> {
        plan.validate()?;
        if self.jobs.len() >= 4 {
            return Err(invalid("已有四份编印任务，请关闭旧预览后重试"));
        }
        if self.jobs.values().any(|job| {
            job.status
                .lock()
                .map(|s| s.state == "running")
                .unwrap_or(true)
        }) {
            return Err(invalid("正在生成另一份族谱，请等待完成或取消该任务"));
        }
        let id = Uuid::new_v4().to_string();
        let job = Arc::new(Job {
            project_id,
            cancel: AtomicBool::new(false),
            status: Mutex::new(Status {
                state: "running".into(),
                stage: "整理资料".into(),
                completed: 0,
                total: 0,
                revision,
                pages: 0,
                bytes: 0,
                error: None,
            }),
            report: Mutex::new(None),
            directory: tempfile::Builder::new()
                .prefix("branchloom-publication-")
                .tempdir()?,
        });
        let worker = job.clone();
        std::thread::Builder::new()
            .name("branchloom-publication".into())
            .spawn(move || {
                let started = std::time::Instant::now();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    render::generate(&data, &plan, &assets, &worker)
                }))
                .unwrap_or_else(|_| Err(invalid("排版引擎无法处理这份资料，请检查附件后重试")));
                if let Ok(mut status) = worker.status.lock() {
                    match result {
                        Ok((bytes, mut report)) if !worker.cancel.load(Ordering::Relaxed) => {
                            let saved = fs::write(worker.output(), &bytes);
                            if let Err(error) = saved {
                                status.state = "failed".into();
                                status.error = Some(error.to_string());
                            } else {
                                report.bytes = bytes.len() as u64;
                                report.elapsed_ms = started.elapsed().as_millis();
                                status.state = "ready".into();
                                status.stage = "可校对与保存".into();
                                status.pages = report.pages;
                                status.bytes = report.bytes;
                                if let Ok(mut stored) = worker.report.lock() {
                                    *stored = Some(report);
                                }
                            }
                        }
                        outcome => {
                            let cancelled = worker.cancel.load(Ordering::Relaxed);
                            status.state = if cancelled { "cancelled" } else { "failed" }.into();
                            status.stage = if cancelled {
                                "已取消"
                            } else {
                                "生成失败"
                            }
                            .into();
                            status.error = outcome.err().map(|error| error.to_string());
                        }
                    }
                    if status.state != "ready" {
                        let _ = fs::remove_file(worker.output());
                    }
                }
            })?;
        self.jobs.insert(id.clone(), job);
        Ok(json!({"jobId":id,"revision":revision}))
    }

    fn job(&self, project_id: &str, id: &str) -> CoreResult<Arc<Job>> {
        self.jobs
            .get(id)
            .filter(|job| job.project_id == project_id)
            .cloned()
            .ok_or_else(|| CoreError::NotFound {
                entity: "publication",
                id: id.into(),
            })
    }

    pub fn request(&mut self, request: &Request, revision: i64) -> CoreResult<Value> {
        let id = request
            .job_id
            .as_deref()
            .ok_or_else(|| invalid("缺少编印任务 ID"))?;
        let job = self.job(&request.project_id, id)?;
        if request.operation == "release" {
            job.cancel.store(true, Ordering::Relaxed);
            self.jobs.remove(id);
            return Ok(Value::Null);
        }
        if request.operation == "cancel" {
            job.cancel.store(true, Ordering::Relaxed);
            return Ok(Value::Null);
        }
        let status = job
            .status
            .lock()
            .map_err(|_| invalid("编印任务状态不可用"))?
            .clone();
        if request.operation == "status" {
            let mut value = serde_json::to_value(&status)?;
            value["stale"] = json!(revision != status.revision);
            return Ok(value);
        }
        if status.state != "ready" {
            return Err(invalid("编印尚未完成"));
        }
        if revision != status.revision {
            return Err(invalid("资料已更新，请重新生成族谱"));
        }
        match request.operation.as_str() {
            "report" => Ok(serde_json::to_value(
                &*job.report.lock().map_err(|_| invalid("校对报告不可用"))?,
            )?),
            "read" => {
                let offset = request.offset.ok_or_else(|| invalid("缺少读取位置"))?;
                let length = request.length.ok_or_else(|| invalid("缺少读取长度"))?;
                if length == 0 || length > 1_048_576 || offset > status.bytes {
                    return Err(invalid("PDF 读取范围无效（每次最多 1 MiB）"));
                }
                let mut file = File::open(job.output())?;
                file.seek(SeekFrom::Start(offset))?;
                let mut bytes = vec![0; length.min((status.bytes - offset) as usize)];
                file.read_exact(&mut bytes)?;
                Ok(json!({"data":STANDARD.encode(bytes)}))
            }
            _ => Err(invalid("未知的编印操作")),
        }
    }

    pub fn save(
        &self,
        project_id: &str,
        id: &str,
        revision: i64,
        destination: &Path,
    ) -> CoreResult<()> {
        let job = self.job(project_id, id)?;
        let status = job
            .status
            .lock()
            .map_err(|_| invalid("编印任务状态不可用"))?;
        if status.state != "ready" || status.revision != revision {
            return Err(invalid("资料已更新或 PDF 尚未完成，请重新生成"));
        }
        if !destination.is_absolute() {
            return Err(invalid("保存位置必须是绝对路径"));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| invalid("保存位置无效"))?;
        let mut staging = tempfile::NamedTempFile::new_in(parent)?;
        std::io::copy(&mut File::open(job.output())?, &mut staging)?;
        staging.flush()?;
        staging.as_file().sync_all()?;
        staging.persist_noclobber(destination).map_err(|error| {
            invalid(format!(
                "无法保存文件；如文件已存在，请选择新名称：{}",
                error.error
            ))
        })?;
        Ok(())
    }
}

pub fn read_asset(path: &Path, hash: &str) -> CoreResult<Vec<u8>> {
    use sha2::{Digest, Sha256};
    if fs::metadata(path)?.len() > 100 * 1024 * 1024 {
        return Err(invalid("附件超过 100 MiB，无法编印"));
    }
    let bytes = fs::read(path)?;
    if format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err(invalid("附件内容校验失败，请重新定位原文件"));
    }
    Ok(bytes)
}

pub fn inspect_pdf(bytes: Vec<u8>) -> CoreResult<Arc<krilla::pdf::Pdf>> {
    // Reject encryption even when its user password happens to be empty.
    let pdf = krilla::pdf::Pdf::new(bytes)
        .map_err(|_| invalid("PDF 已加密、损坏或格式不受支持，请选择可正常打开且未加密的 PDF"))?;
    if pdf.len() > 200_000 || pdf.pages().len() > 10_000 {
        return Err(invalid("PDF 资源或页数超过编印限制"));
    }
    for object in pdf.objects() {
        if let Some(dict) = object.into_dict() {
            if dict.contains_key(b"Filter")
                && dict.contains_key(b"O")
                && dict.contains_key(b"U")
                && dict.contains_key(b"P")
            {
                return Err(invalid("加密 PDF 不能收入附录，请先提供未加密的文件"));
            }
        }
    }
    for page in pdf.pages().iter() {
        if page.raw().contains_key(b"Contents") && page.page_stream().is_none() {
            return Err(invalid("PDF 页面内容损坏，不能以空白页替代"));
        }
        if page
            .page_stream()
            .is_some_and(|stream| stream.len() > 32 * 1024 * 1024)
        {
            return Err(invalid("PDF 单页内容超过 32 MiB，请优化原文件后重试"));
        }
    }
    Ok(Arc::new(pdf))
}
