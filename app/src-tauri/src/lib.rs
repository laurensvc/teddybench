mod uid;

use serde::Deserialize;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Figure {
    uid: String,
    path: String,
    audio_id: String,
    time: String,
    chapters: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentListing {
    dir: String,
    figures: Vec<Figure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UidPreview {
    uid: String,
    directory: String,
    file: String,
    full_path: String,
    exists: bool,
}

#[derive(Deserialize)]
struct TeddyInfo {
    audio_id: Option<String>,
    time: Option<String>,
    chapters: Option<Vec<u64>>,
}

fn teddy_exe(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(path) = app
        .path()
        .resolve("teddy/Teddy.exe", BaseDirectory::Resource)
    {
        candidates.push(path);
    }
    if let Ok(path) = app
        .path()
        .resolve("resources/teddy/Teddy.exe", BaseDirectory::Resource)
    {
        candidates.push(path);
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("teddy")
            .join("Teddy.exe"),
    );

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            "Teddy.exe is missing. Publish it with npm run publish:teddy in the app folder.".into()
        })
}

fn append_log(log: &Arc<Mutex<String>>, app: &AppHandle, emit: bool, bytes: &[u8]) {
    let chunk = String::from_utf8_lossy(bytes);
    let mut text = log.lock().expect("log lock");
    text.push_str(&chunk);
    if emit {
        let _ = app.emit("teddy://log", text.clone());
    }
}

struct TeddyRun {
    log: String,
}

fn run_teddy(app: &AppHandle, args: &[String], emit: bool) -> Result<TeddyRun, String> {
    let exe = teddy_exe(app)?;
    let mut cmd = Command::new(&exe);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("Could not start {}: {err}", exe.display()))?;
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let log = Arc::new(Mutex::new(String::new()));

    let log_err = log.clone();
    let app_err = app.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = [0u8; 512];
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => append_log(&log_err, &app_err, emit, &buf[..n]),
            }
        }
    });

    let mut buf = [0u8; 512];
    loop {
        match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => append_log(&log, app, emit, &buf[..n]),
        }
    }

    let _ = child.wait().map_err(|err| err.to_string())?;
    let _ = stderr_thread.join();
    let text = log.lock().expect("log lock").clone();
    Ok(TeddyRun { log: text })
}

fn teddy_args(mode: &str, extra: &[String]) -> Vec<String> {
    let mut args = vec![
        "-m".into(),
        mode.into(),
        "-j".into(),
        "skip-catalog".into(),
    ];
    args.extend(extra.iter().cloned());
    args
}

fn extract_json_objects(text: &str) -> Vec<serde_json::Value> {
    let bytes = text.as_bytes();
    let mut objects = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'{' {
            let start = index;
            let mut depth = 0;
            let mut in_string = false;
            let mut escaped = false;
            while index < bytes.len() {
                let ch = bytes[index];
                if in_string {
                    if escaped {
                        escaped = false;
                    } else if ch == b'\\' {
                        escaped = true;
                    } else if ch == b'"' {
                        in_string = false;
                    }
                } else if ch == b'"' {
                    in_string = true;
                } else if ch == b'{' {
                    depth += 1;
                } else if ch == b'}' {
                    depth -= 1;
                    if depth == 0 {
                        if let Ok(value) = serde_json::from_slice(&bytes[start..=index]) {
                            objects.push(value);
                        }
                        break;
                    }
                }
                index += 1;
            }
        }
        index += 1;
    }
    objects
}

fn chapter_count(chapters: Option<Vec<u64>>) -> u32 {
    chapters
        .map(|items| items.len().saturating_sub(1) as u32)
        .unwrap_or(0)
}

fn resolve_content_dir(path: &Path) -> PathBuf {
    let nested = path.join("CONTENT");
    if !folder_has_figures(path) && nested.is_dir() {
        nested
    } else {
        path.to_path_buf()
    }
}

fn folder_has_figures(path: &Path) -> bool {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry.path().is_dir()
                && fs::read_dir(entry.path())
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(|file| file.ok())
                    .any(|file| {
                        file.file_name()
                            .to_string_lossy()
                            .to_ascii_uppercase()
                            .ends_with("0304E0")
                    })
        })
}

fn tonie_files(content_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let entries = fs::read_dir(content_dir)
        .map_err(|err| format!("Could not read {}: {err}", content_dir.display()))?;
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok(children) = fs::read_dir(&path) {
            for child in children.filter_map(|child| child.ok()) {
                let child_path = child.path();
                if child_path.is_file()
                    && child
                        .file_name()
                        .to_string_lossy()
                        .to_ascii_uppercase()
                        .ends_with("0304E0")
                {
                    files.push(child_path);
                    break;
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

fn figure_for_path(path: &Path, info: Option<&TeddyInfo>) -> Result<Figure, String> {
    let uid = uid::uid_from_content_path(path)?;
    Ok(Figure {
        uid,
        path: path.display().to_string(),
        audio_id: info
            .and_then(|item| item.audio_id.clone())
            .unwrap_or_default(),
        time: info.and_then(|item| item.time.clone()).unwrap_or_default(),
        chapters: info
            .map(|item| chapter_count(item.chapters.clone()))
            .unwrap_or(0),
    })
}

fn inspect_files(app: &AppHandle, files: &[PathBuf]) -> Result<Vec<Figure>, String> {
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let mut extra = vec!["-f".into(), "json".into()];
    extra.extend(files.iter().map(|path| path.display().to_string()));
    let run = run_teddy(app, &teddy_args("info", &extra), false)?;
    let objects = extract_json_objects(&run.log);
    let mut figures = Vec::new();
    for path in files {
        let uid = uid::uid_from_content_path(path).unwrap_or_default();
        let info = objects.iter().find_map(|value| {
            let json_uid = value
                .get("uid")
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .to_ascii_uppercase();
            if json_uid != uid {
                return None;
            }
            serde_json::from_value(value.clone()).ok()
        });
        figures.push(figure_for_path(path, info.as_ref())?);
    }
    Ok(figures)
}

fn remove_dir_if_empty(dir: &Path) -> Result<(), String> {
    let mut children = fs::read_dir(dir).map_err(|err| err.to_string())?;
    if children.next().is_none() {
        fs::remove_dir(dir).map_err(|err| format!("Could not remove {}: {err}", dir.display()))?;
    }
    Ok(())
}

fn audio_files(files: &[String]) -> Result<Vec<String>, String> {
    if files.is_empty() {
        return Err("Add at least one MP3 or Ogg file.".into());
    }
    for file in files {
        let path = Path::new(file);
        if !path.is_file() {
            return Err(format!("File not found: {file}"));
        }
        let name = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if name != "mp3" && name != "ogg" {
            return Err(format!("{file} is not an MP3 or Ogg file."));
        }
    }
    Ok(files.to_vec())
}

#[cfg(windows)]
fn list_ready_drives() -> Vec<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(root: *const u16) -> u32;
    }
    use std::os::windows::ffi::OsStrExt;

    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;

    let mut found = Vec::new();
    for letter in b'C'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        let wide: Vec<u16> = std::ffi::OsStr::new(&root)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        if kind != DRIVE_REMOVABLE && kind != DRIVE_FIXED && kind != DRIVE_REMOTE {
            continue;
        }
        let content = PathBuf::from(&root).join("CONTENT");
        if content.is_dir() {
            found.push(content.display().to_string());
        }
    }
    found
}

#[cfg(not(windows))]
fn list_ready_drives() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
fn list_drives() -> Vec<String> {
    list_ready_drives()
}

#[tauri::command]
async fn list_content(app: AppHandle, content_dir: String) -> Result<ContentListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resolve_content_dir(Path::new(&content_dir));
        if !dir.is_dir() {
            return Err(format!("{} is not a folder.", dir.display()));
        }
        let files = tonie_files(&dir)?;
        let figures = inspect_files(&app, &files)?;
        Ok(ContentListing {
            dir: dir.display().to_string(),
            figures,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn preview_uid(content_dir: String, uid: String) -> Result<UidPreview, String> {
    let uid = uid::validate_uid(&uid)?;
    let (directory, file) = uid::content_parts(&uid)?;
    let full = uid::content_file(Path::new(&content_dir), &uid)?;
    Ok(UidPreview {
        uid,
        directory,
        file,
        exists: full.is_file(),
        full_path: full.display().to_string(),
    })
}

#[tauri::command]
async fn encode_to_uid(
    app: AppHandle,
    content_dir: String,
    uid: String,
    files: Vec<String>,
    bitrate: u32,
) -> Result<Figure, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let uid = uid::validate_uid(&uid)?;
        let sources = audio_files(&files)?;
        if !(16..=320).contains(&bitrate) {
            return Err("Bitrate must be between 16 and 320 kbps.".into());
        }
        let content = resolve_content_dir(Path::new(&content_dir));
        let destination = uid::content_file(&content, &uid)?;

        let temp_dir = std::env::temp_dir().join(format!(
            "teddybench-encode-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&temp_dir).map_err(|err| err.to_string())?;
        let temp_file = temp_dir.join("content.bin");

        let mut extra = vec![
            "-o".into(),
            temp_file.display().to_string(),
            "-b".into(),
            bitrate.to_string(),
        ];
        extra.extend(sources);
        let run = run_teddy(&app, &teddy_args("encode", &extra), true);
        let failed = match &run {
            Ok(output) => {
                !temp_file.is_file() || output.log.contains("[ERROR]") || output.log.contains("Failed to encode")
            }
            Err(_) => true,
        };
        if failed {
            let detail = run
                .map(|output| output.log)
                .unwrap_or_else(|err| err);
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(if detail.trim().is_empty() {
                "Encoding failed.".into()
            } else {
                detail
            });
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Could not create {}: {err}", parent.display()))?;
        }
        fs::copy(&temp_file, &destination).map_err(|err| {
            format!("Could not write {}: {err}", destination.display())
        })?;
        let _ = fs::remove_dir_all(&temp_dir);
        let figures = inspect_files(&app, &[destination])?;
        figures
            .into_iter()
            .next()
            .ok_or_else(|| "Encoded file could not be read back.".to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn move_uid(content_dir: String, from_uid: String, to_uid: String) -> Result<Figure, String> {
    let from_uid = uid::validate_uid(&from_uid)?;
    let to_uid = uid::validate_uid(&to_uid)?;
    let content = resolve_content_dir(Path::new(&content_dir));
    let source = uid::content_file(&content, &from_uid)?;
    let destination = uid::content_file(&content, &to_uid)?;
    if !source.is_file() {
        return Err(format!("No audio file for {from_uid}."));
    }
    if source == destination {
        return figure_for_path(&source, None);
    }
    if destination.exists() {
        return Err(format!(
            "UID {to_uid} already has a file on this card."
        ));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create {}: {err}", parent.display()))?;
    }
    fs::rename(&source, &destination).map_err(|err| format!("Could not move the file: {err}"))?;
    if let Some(old_dir) = source.parent() {
        if old_dir != destination.parent().unwrap_or(old_dir) {
            let _ = remove_dir_if_empty(old_dir);
        }
    }
    figure_for_path(&destination, None)
}

#[tauri::command]
fn delete_content(content_dir: String, uid: String) -> Result<(), String> {
    let uid = uid::validate_uid(&uid)?;
    let content = resolve_content_dir(Path::new(&content_dir));
    let file = uid::content_file(&content, &uid)?;
    if !file.is_file() {
        return Err(format!("No audio file for {uid}."));
    }
    fs::remove_file(&file).map_err(|err| format!("Could not delete {}: {err}", file.display()))?;
    if let Some(dir) = file.parent() {
        remove_dir_if_empty(dir)?;
    }
    Ok(())
}

fn ogg_files(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = fs::read_dir(dir)
        .map_err(|err| err.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("ogg"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

#[tauri::command]
async fn export_ogg(
    app: AppHandle,
    tonie_path: String,
    output_dir: String,
    into_temp: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = if into_temp {
            let uid = uid::uid_from_content_path(Path::new(&tonie_path)).unwrap_or_else(|_| "figure".into());
            std::env::temp_dir().join("teddybench-listen").join(uid)
        } else {
            PathBuf::from(&output_dir)
        };
        if into_temp && output.exists() {
            let _ = fs::remove_dir_all(&output);
        }
        fs::create_dir_all(&output)
            .map_err(|err| format!("Could not create {}: {err}", output.display()))?;
        let before = ogg_files(&output)?;
        let extra = vec![
            "-s".into(),
            "-o".into(),
            output.display().to_string(),
            tonie_path,
        ];
        let run = run_teddy(&app, &teddy_args("decode", &extra), true)?;
        if run.log.contains("[ERROR]") {
            return Err(run.log);
        }
        let after = ogg_files(&output)?;
        let written = after
            .iter()
            .find(|path| !before.iter().any(|existing| existing == *path))
            .cloned()
            .or_else(|| after.last().cloned())
            .ok_or_else(|| {
                if run.log.trim().is_empty() {
                    "Decode finished without an Ogg file.".to_string()
                } else {
                    run.log.clone()
                }
            })?;
        Ok(written.display().to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            list_drives,
            list_content,
            preview_uid,
            encode_to_uid,
            move_uid,
            delete_content,
            export_ogg
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
