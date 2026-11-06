pub(crate) fn locale_from_environment(
    mut read: impl FnMut(&str) -> Option<String>,
) -> Option<String> {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|key| read(key))
        .find(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::locale_from_environment;

    #[test]
    fn message_locale_obeys_posix_precedence_and_ignores_empty_values() {
        let values = [
            ("LC_ALL", ""),
            ("LC_MESSAGES", "C.UTF-8"),
            ("LANG", "zh_CN.UTF-8"),
        ];
        assert_eq!(
            locale_from_environment(|key| values
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| (*value).to_owned())),
            Some("C.UTF-8".to_owned())
        );
        assert_eq!(locale_from_environment(|_| None), None);
        assert_eq!(
            locale_from_environment(|key| (key == "LC_ALL").then(|| "zh_TW.UTF-8".to_owned())),
            Some("zh_TW.UTF-8".to_owned())
        );
    }
}
