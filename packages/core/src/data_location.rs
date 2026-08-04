use std::path::{Path, PathBuf};

use crate::core::error::{CoreError, CoreResult};

pub const APP_IDENTIFIER: &str = "app.branchloom.desktop";
pub const DATABASE_FILE_NAME: &str = "branchloom.sqlite3";

pub fn default_data_directory() -> CoreResult<PathBuf> {
    dirs::data_dir()
        .map(|directory| directory.join(APP_IDENTIFIER))
        .ok_or_else(|| {
            CoreError::Validation("unable to resolve the platform data directory".to_owned())
        })
}

pub fn profile_data_directory(profile: &str) -> CoreResult<PathBuf> {
    validate_profile(profile)?;
    Ok(default_data_directory()?.join("profiles").join(profile))
}

pub fn database_path(data_directory: impl AsRef<Path>) -> PathBuf {
    data_directory.as_ref().join(DATABASE_FILE_NAME)
}

pub fn validate_profile(profile: &str) -> CoreResult<()> {
    if profile.is_empty()
        || !profile
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(CoreError::Validation("invalid profile name".to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_paths_are_isolated_below_the_shared_application_directory() {
        let default = default_data_directory().expect("resolve default data directory");
        assert_eq!(
            profile_data_directory("test-profile").expect("resolve profile"),
            default.join("profiles").join("test-profile")
        );
        assert!(profile_data_directory("../escape").is_err());
    }

    #[test]
    fn database_path_uses_the_canonical_file_name() {
        assert_eq!(
            database_path(Path::new("/tmp/branchloom-test")),
            Path::new("/tmp/branchloom-test").join(DATABASE_FILE_NAME)
        );
    }
}
