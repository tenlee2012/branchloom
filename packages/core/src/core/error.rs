use thiserror::Error;

pub type CoreResult<T> = Result<T, CoreError>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("{entity} not found: {id}")]
    NotFound { entity: &'static str, id: String },
    #[error("database schema version {found} is newer than supported version {supported}")]
    UnsupportedVersion { found: i64, supported: i64 },
    #[error("failed to format a UTC timestamp: {0}")]
    Timestamp(#[from] time::error::Format),
    #[error("file operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("storage operation failed: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("invalid JSON data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("remote operation failed: {0}")]
    Remote(String),
    #[error("project data conflict: {0}")]
    Conflict(String),
    #[error("data revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: i64, actual: i64 },
}
