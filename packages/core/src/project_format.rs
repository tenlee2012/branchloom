use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::core::error::{CoreError, CoreResult};

pub const PROJECT_FORMAT_VERSION: &str = "1.0.0";
pub const ARCHIVE_EXTENSION: &str = "blp";
const MANIFEST_PATH: &str = "branchloom.jsonld";
const PROJECT_PATH: &str = "project.jsonld";
const CONTEXT_PATH: &str = "context/branchloom-v1.jsonld";
const CONTEXT_URI: &str = "https://branchloom.app/context/v1";
const MAX_ARCHIVE_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub const PROJECT_COLLECTIONS: [(&str, &str, &str); 12] = [
    ("people", "people", "Person"),
    ("organizations", "organizations", "Organization"),
    ("careers", "careers", "Career"),
    ("personTitles", "person-titles", "PersonTitle"),
    ("relationships", "relationships", "Relationship"),
    ("events", "events", "Event"),
    ("places", "places", "Place"),
    ("sources", "sources", "Source"),
    ("citations", "citations", "Citation"),
    ("attachments", "attachments", "Attachment"),
    ("attachmentLinks", "attachment-links", "AttachmentLink"),
    ("issues", "manual-issues", "Issue"),
];

const CONTEXT_DOCUMENT: &str = r#"{
  "@context": {
    "@version": 1.1,
    "@vocab": "https://branchloom.app/schema/v1#",
    "id": "@id",
    "type": "@type"
  }
}
"#;

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectData {
    pub project: Value,
    pub collections: BTreeMap<String, Vec<Value>>,
}

impl ProjectData {
    pub fn project_id(&self) -> CoreResult<&str> {
        required_string(&self.project, "id")
    }

    pub fn validate(&self) -> CoreResult<()> {
        let project_id = self.project_id()?;
        validate_identifier(project_id, "project id")?;
        for (collection, _, _) in PROJECT_COLLECTIONS {
            let entities = self.collections.get(collection).ok_or_else(|| {
                CoreError::Validation(format!("project collection is missing: {collection}"))
            })?;
            let mut ids = BTreeSet::new();
            for entity in entities {
                let id = required_string(entity, "id")?;
                validate_identifier(id, "entity id")?;
                if !ids.insert(id.to_owned()) {
                    return Err(CoreError::Validation(format!(
                        "duplicate id in {collection}: {id}"
                    )));
                }
                if required_string(entity, "projectId")? != project_id {
                    return Err(CoreError::Validation(format!(
                        "{collection}/{id} belongs to a different project"
                    )));
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectTree {
    files: BTreeMap<String, Vec<u8>>,
}

impl ProjectTree {
    pub fn new(files: BTreeMap<String, Vec<u8>>) -> CoreResult<Self> {
        for path in files.keys() {
            validate_relative_path(path)?;
        }
        Ok(Self { files })
    }

    pub fn files(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.files
    }

    pub fn into_files(self) -> BTreeMap<String, Vec<u8>> {
        self.files
    }

    pub fn rebuild_manifest(mut files: BTreeMap<String, Vec<u8>>) -> CoreResult<Self> {
        files.remove(MANIFEST_PATH);
        let project = parse_jsonld_record(
            files
                .get(PROJECT_PATH)
                .ok_or_else(|| {
                    CoreError::Validation(format!("project file is missing: {PROJECT_PATH}"))
                })?
                .as_slice(),
        )?;
        let project_id = required_string(&project, "id")?.to_owned();
        let checksums = files
            .iter()
            .map(|(path, bytes)| (path.clone(), sha256_hex(bytes)))
            .collect::<BTreeMap<_, _>>();
        files.insert(
            MANIFEST_PATH.to_owned(),
            canonical_pretty_json(&serde_json::to_value(ProjectManifest::new(
                project_id, checksums,
            ))?)?,
        );
        let tree = Self::new(files)?;
        tree.validate_manifest()?;
        Ok(tree)
    }

    pub fn from_project_data(data: &ProjectData, attachments_root: &Path) -> CoreResult<Self> {
        data.validate()?;
        let project_id = data.project_id()?;
        let mut files = BTreeMap::new();
        files.insert(
            CONTEXT_PATH.to_owned(),
            CONTEXT_DOCUMENT.as_bytes().to_vec(),
        );
        files.insert(
            PROJECT_PATH.to_owned(),
            canonical_pretty_json(&jsonld_entity(&data.project, "Project", project_id))?,
        );

        for (collection, directory, entity_type) in PROJECT_COLLECTIONS {
            let entities = data
                .collections
                .get(collection)
                .expect("project collections validated");
            for entity in entities {
                let id = required_string(entity, "id")?;
                let prefix = identifier_prefix(id);
                let path = format!("data/{directory}/{prefix}/{id}.jsonld");
                files.insert(
                    path,
                    canonical_pretty_json(&jsonld_entity(entity, entity_type, id))?,
                );
            }
        }

        add_attachment_content(&mut files, data, attachments_root, project_id)?;
        files.insert(
            ".gitattributes".to_owned(),
            b"*.json text eol=lf\n*.jsonld text eol=lf\nmedia/** filter=lfs diff=lfs merge=lfs -text\n"
                .to_vec(),
        );

        let checksums = files
            .iter()
            .map(|(path, bytes)| (path.clone(), sha256_hex(bytes)))
            .collect::<BTreeMap<_, _>>();
        let manifest = ProjectManifest::new(project_id.to_owned(), checksums);
        files.insert(
            MANIFEST_PATH.to_owned(),
            canonical_pretty_json(&serde_json::to_value(manifest)?)?,
        );
        Self::new(files)
    }

    pub fn parse_project_data(&self) -> CoreResult<ProjectData> {
        self.validate_manifest()?;
        let manifest: ProjectManifest = serde_json::from_slice(self.required_file(MANIFEST_PATH)?)?;
        let project = parse_jsonld_record(self.required_file(PROJECT_PATH)?)?;
        let project_id = required_string(&project, "id")?.to_owned();
        if manifest.project_id != project_id {
            return Err(CoreError::Validation(
                "manifest and project file use different project ids".to_owned(),
            ));
        }
        let mut collections = BTreeMap::new();

        for (collection, directory, _) in PROJECT_COLLECTIONS {
            let prefix = format!("data/{directory}/");
            let mut entities = Vec::new();
            for (path, bytes) in self.files.range(prefix.clone()..) {
                if !path.starts_with(&prefix) {
                    break;
                }
                if !path.ends_with(".jsonld") {
                    return Err(CoreError::Validation(format!(
                        "unexpected file in {prefix}: {path}"
                    )));
                }
                let entity = parse_jsonld_record(bytes)?;
                if required_string(&entity, "projectId")? != project_id {
                    return Err(CoreError::Validation(format!(
                        "record belongs to a different project: {path}"
                    )));
                }
                entities.push(entity);
            }
            entities.sort_by(|left, right| value_string(left, "id").cmp(value_string(right, "id")));
            collections.insert(collection.to_owned(), entities);
        }

        let data = ProjectData {
            project,
            collections,
        };
        data.validate()?;
        Ok(data)
    }

    pub fn validate_manifest(&self) -> CoreResult<()> {
        let manifest: ProjectManifest = serde_json::from_slice(self.required_file(MANIFEST_PATH)?)?;
        if manifest.format_version != PROJECT_FORMAT_VERSION {
            return Err(CoreError::Validation(format!(
                "unsupported project format version: {}",
                manifest.format_version
            )));
        }
        if manifest.context != CONTEXT_URI
            || manifest.entity_type != "BranchloomRepository"
            || manifest.id != format!("urn:branchloom:repository:{}", manifest.project_id)
        {
            return Err(CoreError::Validation(
                "project manifest identity is invalid".to_owned(),
            ));
        }
        validate_identifier(&manifest.project_id, "project id")?;

        let actual_paths = self
            .files
            .keys()
            .filter(|path| path.as_str() != MANIFEST_PATH)
            .cloned()
            .collect::<BTreeSet<_>>();
        let expected_paths = manifest.files.keys().cloned().collect::<BTreeSet<_>>();
        if actual_paths != expected_paths {
            return Err(CoreError::Validation(
                "project manifest file list does not match the package".to_owned(),
            ));
        }
        for (path, expected_hash) in manifest.files {
            let bytes = self.required_file(&path)?;
            if sha256_hex(bytes) != expected_hash {
                return Err(CoreError::Validation(format!(
                    "project file checksum does not match: {path}"
                )));
            }
        }
        Ok(())
    }

    pub fn write_directory(&self, directory: &Path) -> CoreResult<()> {
        if directory.exists() {
            return Err(CoreError::Validation(format!(
                "destination already exists: {}",
                directory.display()
            )));
        }
        fs::create_dir_all(directory)?;
        let write_result = (|| -> CoreResult<()> {
            for (relative_path, bytes) in &self.files {
                let path = directory.join(relative_path);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                write_new_file(&path, bytes)?;
            }
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_dir_all(directory);
        }
        write_result
    }

    pub fn read_directory(directory: &Path) -> CoreResult<Self> {
        if !directory.is_dir() {
            return Err(CoreError::Validation(format!(
                "project directory does not exist: {}",
                directory.display()
            )));
        }
        let mut files = BTreeMap::new();
        read_directory_files(directory, directory, &mut files)?;
        let tree = Self::new(files)?;
        tree.validate_manifest()?;
        Ok(tree)
    }

    pub fn write_archive(&self, destination: &Path) -> CoreResult<()> {
        if destination.extension().and_then(|value| value.to_str()) != Some(ARCHIVE_EXTENSION) {
            return Err(CoreError::Validation(format!(
                "project archive must use .{ARCHIVE_EXTENSION}"
            )));
        }
        if destination.exists() {
            return Err(CoreError::Validation(format!(
                "destination already exists: {}",
                destination.display()
            )));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary_path =
            destination.with_extension(format!("{ARCHIVE_EXTENSION}.pending-{}", Uuid::new_v4()));
        let write_result = (|| -> CoreResult<()> {
            let file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary_path)?;
            let mut writer = ZipWriter::new(file);
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o600);
            for (path, bytes) in &self.files {
                writer.start_file(path, options).map_err(zip_error)?;
                writer.write_all(bytes)?;
            }
            let file = writer.finish().map_err(zip_error)?;
            file.sync_all()?;
            fs::rename(&temporary_path, destination)?;
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        write_result
    }

    pub fn read_archive(source: &Path) -> CoreResult<Self> {
        if source.extension().and_then(|value| value.to_str()) != Some(ARCHIVE_EXTENSION) {
            return Err(CoreError::Validation(format!(
                "project archive must use .{ARCHIVE_EXTENSION}"
            )));
        }
        let file = File::open(source)?;
        let mut archive = ZipArchive::new(file).map_err(zip_error)?;
        let mut files = BTreeMap::new();
        let mut total_bytes = 0_u64;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(zip_error)?;
            if entry.is_dir() {
                continue;
            }
            if entry.size() > MAX_ARCHIVE_ENTRY_BYTES {
                return Err(CoreError::Validation(format!(
                    "archive entry is too large: {}",
                    entry.name()
                )));
            }
            total_bytes = total_bytes
                .checked_add(entry.size())
                .ok_or_else(|| CoreError::Validation("archive size overflow".to_owned()))?;
            if total_bytes > MAX_ARCHIVE_TOTAL_BYTES {
                return Err(CoreError::Validation(
                    "archive expands beyond the supported size".to_owned(),
                ));
            }
            let path = entry
                .enclosed_name()
                .ok_or_else(|| {
                    CoreError::Validation(format!("unsafe archive path: {}", entry.name()))
                })?
                .to_string_lossy()
                .replace('\\', "/");
            validate_relative_path(&path)?;
            if files.contains_key(&path) {
                return Err(CoreError::Validation(format!(
                    "duplicate archive entry: {path}"
                )));
            }
            let mut bytes = Vec::with_capacity(
                usize::try_from(entry.size())
                    .map_err(|_| CoreError::Validation("archive entry is too large".to_owned()))?,
            );
            entry.read_to_end(&mut bytes)?;
            files.insert(path, bytes);
        }
        let tree = Self::new(files)?;
        tree.validate_manifest()?;
        Ok(tree)
    }

    pub fn install_attachments(
        &self,
        attachments_root: &Path,
        project_id: &str,
    ) -> CoreResult<InstalledAttachments> {
        validate_identifier(project_id, "project id")?;
        let destination_root = attachments_root.join(project_id);
        fs::create_dir_all(&destination_root)?;
        let staging = TempDir::new_in(attachments_root)?;
        let mut staged = Vec::new();

        for (path, bytes) in &self.files {
            let Some(hash) = media_hash_from_path(path)? else {
                continue;
            };
            if sha256_hex(bytes) != hash {
                return Err(CoreError::Validation(format!(
                    "attachment checksum does not match its path: {path}"
                )));
            }
            let final_path = destination_root.join(&hash);
            if final_path.exists() {
                if sha256_hex(&fs::read(&final_path)?) != hash {
                    return Err(CoreError::Validation(format!(
                        "existing attachment content is invalid: {hash}"
                    )));
                }
                continue;
            }
            let staged_path = staging.path().join(&hash);
            write_new_file(&staged_path, bytes)?;
            staged.push((staged_path, final_path));
        }

        let mut created = Vec::new();
        for (staged_path, final_path) in staged {
            fs::rename(staged_path, &final_path)?;
            created.push(final_path);
        }
        Ok(InstalledAttachments { created })
    }

    fn required_file(&self, path: &str) -> CoreResult<&[u8]> {
        self.files
            .get(path)
            .map(Vec::as_slice)
            .ok_or_else(|| CoreError::Validation(format!("project file is missing: {path}")))
    }
}

#[derive(Debug)]
pub struct InstalledAttachments {
    created: Vec<PathBuf>,
}

impl InstalledAttachments {
    pub fn commit(mut self) {
        self.created.clear();
    }
}

impl Drop for InstalledAttachments {
    fn drop(&mut self) {
        for path in &self.created {
            let _ = fs::remove_file(path);
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectManifest {
    #[serde(rename = "@context")]
    context: String,
    #[serde(rename = "@id")]
    id: String,
    #[serde(rename = "@type")]
    entity_type: String,
    format_version: String,
    project_id: String,
    files: BTreeMap<String, String>,
}

impl ProjectManifest {
    fn new(project_id: String, files: BTreeMap<String, String>) -> Self {
        Self {
            context: CONTEXT_URI.to_owned(),
            id: format!("urn:branchloom:repository:{project_id}"),
            entity_type: "BranchloomRepository".to_owned(),
            format_version: PROJECT_FORMAT_VERSION.to_owned(),
            project_id,
            files,
        }
    }
}

fn add_attachment_content(
    files: &mut BTreeMap<String, Vec<u8>>,
    data: &ProjectData,
    attachments_root: &Path,
    project_id: &str,
) -> CoreResult<()> {
    let attachments = data
        .collections
        .get("attachments")
        .expect("attachment collection validated");
    for attachment in attachments {
        let Some(content_hash) = attachment.get("contentHash").and_then(Value::as_str) else {
            continue;
        };
        validate_hash(content_hash)?;
        let source = attachments_root.join(project_id).join(content_hash);
        let bytes = fs::read(&source).map_err(|error| {
            CoreError::Validation(format!(
                "attachment content is missing or unreadable ({}): {error}",
                source.display()
            ))
        })?;
        if sha256_hex(&bytes) != content_hash {
            return Err(CoreError::Validation(format!(
                "attachment content checksum does not match: {content_hash}"
            )));
        }
        files
            .entry(format!(
                "media/sha256/{}/{}",
                &content_hash[0..2],
                content_hash
            ))
            .or_insert(bytes);
    }
    Ok(())
}

fn jsonld_entity(value: &Value, entity_type: &str, id: &str) -> Value {
    let mut object = value.as_object().cloned().unwrap_or_default();
    object.insert("@context".to_owned(), Value::String(CONTEXT_URI.to_owned()));
    object.insert("@id".to_owned(), Value::String(format!("urn:uuid:{id}")));
    object.insert("@type".to_owned(), Value::String(entity_type.to_owned()));
    Value::Object(object)
}

fn parse_jsonld_record(bytes: &[u8]) -> CoreResult<Value> {
    let mut value: Value = serde_json::from_slice(bytes)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| CoreError::Validation("JSON-LD record must be an object".to_owned()))?;
    object.remove("@context");
    object.remove("@id");
    object.remove("@type");
    Ok(value)
}

fn canonical_pretty_json(value: &Value) -> CoreResult<Vec<u8>> {
    let canonical = canonical_value(value);
    let mut bytes = serde_json::to_vec_pretty(&canonical)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_value).collect()),
        Value::Object(object) => {
            let sorted = object
                .iter()
                .map(|(key, value)| (key.clone(), canonical_value(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(sorted.into_iter().collect::<Map<_, _>>())
        }
        _ => value.clone(),
    }
}

fn read_directory_files(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> CoreResult<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(CoreError::Validation(format!(
                "project tree must not contain symlinks: {}",
                path.display()
            )));
        }
        if file_type.is_dir() {
            if entry.file_name() == ".git" {
                continue;
            }
            read_directory_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| CoreError::Validation("invalid project tree path".to_owned()))?
                .to_string_lossy()
                .replace('\\', "/");
            validate_relative_path(&relative)?;
            files.insert(relative, fs::read(path)?);
        }
    }
    Ok(())
}

fn media_hash_from_path(path: &str) -> CoreResult<Option<String>> {
    let Some(rest) = path.strip_prefix("media/sha256/") else {
        return Ok(None);
    };
    let mut components = rest.split('/');
    let prefix = components.next().unwrap_or_default();
    let hash = components.next().unwrap_or_default();
    if components.next().is_some() || prefix.len() != 2 || !hash.starts_with(prefix) {
        return Err(CoreError::Validation(format!(
            "invalid attachment path: {path}"
        )));
    }
    validate_hash(hash)?;
    Ok(Some(hash.to_owned()))
}

fn validate_hash(value: &str) -> CoreResult<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(CoreError::Validation(format!(
            "invalid SHA-256 value: {value}"
        )));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> CoreResult<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(CoreError::Validation(format!("invalid {label}: {value}")));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> CoreResult<()> {
    if value.is_empty() || value.contains('\\') {
        return Err(CoreError::Validation(format!(
            "invalid project path: {value}"
        )));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(CoreError::Validation(format!(
            "unsafe project path: {value}"
        )));
    }
    Ok(())
}

fn required_string<'a>(value: &'a Value, key: &str) -> CoreResult<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Validation(format!("record field must be a string: {key}")))
}

fn value_string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn identifier_prefix(value: &str) -> String {
    value
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric())
        .take(2)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn write_new_file(path: &Path, bytes: &[u8]) -> CoreResult<()> {
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn zip_error(error: zip::result::ZipError) -> CoreError {
    CoreError::Validation(format!("invalid project archive: {error}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn archive_round_trip_matches_the_github_tree() {
        let directory = tempdir().expect("create temporary directory");
        let attachments_root = directory.path().join("attachments");
        fs::create_dir_all(attachments_root.join("project-test"))
            .expect("create attachment directory");
        let attachment_bytes = b"family photo";
        let attachment_hash = sha256_hex(attachment_bytes);
        fs::write(
            attachments_root.join("project-test").join(&attachment_hash),
            attachment_bytes,
        )
        .expect("write attachment");

        let data = test_project_data(&attachment_hash);
        let tree =
            ProjectTree::from_project_data(&data, &attachments_root).expect("create project tree");
        let archive = directory.path().join("family.blp");
        tree.write_archive(&archive).expect("write project archive");
        let decoded = ProjectTree::read_archive(&archive).expect("read project archive");

        assert_eq!(decoded, tree);
        assert_eq!(
            decoded.parse_project_data().expect("parse project data"),
            data
        );
        assert_eq!(
            decoded
                .files()
                .get(&format!(
                    "media/sha256/{}/{}",
                    &attachment_hash[0..2],
                    attachment_hash
                ))
                .expect("attachment in archive"),
            attachment_bytes
        );
    }

    #[test]
    fn rejects_archive_paths_outside_the_project_root() {
        let directory = tempdir().expect("create temporary directory");
        let archive = directory.path().join("unsafe.blp");
        let file = File::create(&archive).expect("create archive");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("../outside", SimpleFileOptions::default())
            .expect("start unsafe entry");
        writer.write_all(b"bad").expect("write unsafe entry");
        writer.finish().expect("finish archive");

        assert!(ProjectTree::read_archive(&archive).is_err());
    }

    fn test_project_data(attachment_hash: &str) -> ProjectData {
        let mut collections = PROJECT_COLLECTIONS
            .iter()
            .map(|(collection, _, _)| ((*collection).to_owned(), Vec::new()))
            .collect::<BTreeMap<_, _>>();
        collections
            .get_mut("people")
            .expect("people collection")
            .push(json!({
                "id": "person-test",
                "projectId": "project-test",
                "names": ["Alice"],
                "updatedAt": "2026-01-01T00:00:00Z"
            }));
        collections
            .get_mut("attachments")
            .expect("attachment collection")
            .push(json!({
                "id": "attachment-test",
                "projectId": "project-test",
                "contentHash": attachment_hash,
                "name": "photo.jpg",
                "updatedAt": "2026-01-01T00:00:00Z"
            }));
        ProjectData {
            project: json!({
                "id": "project-test",
                "name": "Family",
                "description": "",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z"
            }),
            collections,
        }
    }
}
