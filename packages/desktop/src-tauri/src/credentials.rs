use std::collections::HashMap;

use keyring::v1::{Entry, Error};

const GITHUB_TOKEN_SERVICE: &str = "app.branchloom.desktop.github";

#[derive(Default)]
pub struct GithubCredentialCache {
    // Tokens stay only in the desktop process and disappear when the app exits.
    tokens: HashMap<String, String>,
}

impl GithubCredentialCache {
    pub fn get(&self, project_id: &str) -> Option<String> {
        self.tokens.get(project_id).cloned()
    }

    pub fn remember(&mut self, project_id: &str, token: &str) {
        self.tokens.insert(project_id.to_owned(), token.to_owned());
    }

    pub fn forget(&mut self, project_id: &str) {
        self.tokens.remove(project_id);
    }
}

fn github_token_account(project_id: &str) -> String {
    format!("project:{project_id}")
}

fn github_token_entry(project_id: &str) -> Result<Entry, String> {
    Entry::new(GITHUB_TOKEN_SERVICE, &github_token_account(project_id))
        .map_err(|error| format!("无法访问系统安全凭据存储：{error}"))
}

pub fn save_github_token(project_id: &str, token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("GitHub Token 不能为空".to_owned());
    }
    github_token_entry(project_id)?
        .set_password(token)
        .map_err(|error| format!("无法将 GitHub Token 保存到系统安全凭据存储：{error}"))
}

pub fn load_github_token(project_id: &str) -> Result<Option<String>, String> {
    match github_token_entry(project_id)?.get_password() {
        Ok(token) if token.trim().is_empty() => Ok(None),
        Ok(token) => Ok(Some(token)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("无法从系统安全凭据存储读取 GitHub Token：{error}")),
    }
}

pub fn delete_github_token(project_id: &str) -> Result<(), String> {
    match github_token_entry(project_id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法从系统安全凭据存储删除 GitHub Token：{error}")),
    }
}

pub fn is_github_authentication_failure(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("401")
        || normalized.contains("unauthorized")
        || normalized.contains("bad credentials")
}

#[cfg(test)]
mod tests {
    use super::{github_token_account, is_github_authentication_failure, GithubCredentialCache};

    #[test]
    fn credential_account_is_scoped_to_the_project() {
        assert_eq!(github_token_account("project-one"), "project:project-one");
        assert_ne!(
            github_token_account("project-one"),
            github_token_account("project-two")
        );
    }

    #[test]
    fn detects_github_authentication_failures_without_matching_other_errors() {
        assert!(is_github_authentication_failure(
            "GitHub returned 401 Unauthorized: Bad credentials"
        ));
        assert!(!is_github_authentication_failure(
            "GitHub returned 503 Service Unavailable"
        ));
    }

    #[test]
    fn session_cache_reuses_and_forgets_project_credentials() {
        let mut cache = GithubCredentialCache::default();

        cache.remember("project-one", "token-one");

        assert_eq!(cache.get("project-one").as_deref(), Some("token-one"));
        assert_eq!(cache.get("project-two"), None);

        cache.forget("project-one");
        assert_eq!(cache.get("project-one"), None);
    }
}
