use std::path::{Path, PathBuf};

pub fn validate_uid(uid: &str) -> Result<String, String> {
    let upper = uid.trim().to_ascii_uppercase();
    if upper.len() != 16 || !upper.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Enter a 16-character hex UID.".into());
    }
    if !upper.starts_with("E00403") {
        return Err("UID must start with E00403.".into());
    }
    Ok(upper)
}

pub fn reverse_hex_bytes(hex: &str) -> Result<String, String> {
    let upper = hex.trim().to_ascii_uppercase();
    if upper.len() != 16 || !upper.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Expected 16 hex characters.".into());
    }
    let mut reversed = String::with_capacity(upper.len());
    for pair in upper.as_bytes().chunks(2).rev() {
        reversed.push(pair[0] as char);
        reversed.push(pair[1] as char);
    }
    Ok(reversed)
}

/// Byte-reverse a figure UID into the 16-character name used on the card.
pub fn reverse_uid(uid: &str) -> Result<String, String> {
    let uid = validate_uid(uid)?;
    reverse_hex_bytes(&uid)
}

pub fn content_parts(uid: &str) -> Result<(String, String), String> {
    let reversed = reverse_uid(uid)?;
    Ok((reversed[..8].to_string(), reversed[8..].to_string()))
}

pub fn content_file(content_dir: &Path, uid: &str) -> Result<PathBuf, String> {
    let (dir, file) = content_parts(uid)?;
    Ok(content_dir.join(dir).join(file))
}

pub fn uid_from_content_path(path: &Path) -> Result<String, String> {
    let file = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Missing file name.".to_string())?;
    let dir = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Missing directory name.".to_string())?;
    reverse_hex_bytes(&format!("{dir}{file}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reverses_the_documented_uid() {
        assert_eq!(
            reverse_uid("E0040312345678AB").unwrap(),
            "AB785634120304E0"
        );
        let (dir, file) = content_parts("E0040312345678AB").unwrap();
        assert_eq!(dir, "AB785634");
        assert_eq!(file, "120304E0");
    }

    #[test]
    fn accepts_lowercase_paste() {
        assert_eq!(
            reverse_uid("e0040312345678ab").unwrap(),
            "AB785634120304E0"
        );
    }

    #[test]
    fn round_trips_a_content_path() {
        let path = Path::new(r"E:\CONTENT\AB785634\120304E0");
        assert_eq!(uid_from_content_path(path).unwrap(), "E0040312345678AB");
    }

    #[test]
    fn rejects_a_short_or_foreign_uid() {
        assert!(reverse_uid("E00403").is_err());
        assert!(reverse_uid("E0050312345678AB").is_err());
        assert!(reverse_uid("E0040312345678ZZ").is_err());
    }
}
