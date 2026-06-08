use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// ffmpeg / ffprobe / curl 等の外部バイナリの絶対パスを解決する。
/// macOS の .app から起動すると shell の PATH を継承しないため、
/// Homebrew や MacPorts の既知パスを先に探し、無ければ PATH から検索、
/// それでも無ければプログラム名のままフォールバック（エラーメッセージ用）。
fn resolve_binary(name: &str) -> PathBuf {
    // Windows では通常 PATH が効くが、一応 .exe 名で探す
    #[cfg(target_os = "windows")]
    let exe_name = if name.ends_with(".exe") {
        name.to_string()
    } else {
        format!("{}.exe", name)
    };
    #[cfg(not(target_os = "windows"))]
    let exe_name = name.to_string();

    // macOS / Linux 用の既知パス（Homebrew、MacPorts、システム）
    #[cfg(target_os = "macos")]
    let known_dirs: &[&str] = &[
        "/opt/homebrew/bin",  // Apple Silicon Homebrew
        "/usr/local/bin",     // Intel Homebrew / 汎用
        "/opt/local/bin",     // MacPorts
        "/usr/bin",
        "/bin",
    ];
    #[cfg(target_os = "linux")]
    let known_dirs: &[&str] = &[
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ];
    #[cfg(target_os = "windows")]
    let known_dirs: &[&str] = &[
        "C:\\ffmpeg\\bin",
        "C:\\Program Files\\ffmpeg\\bin",
    ];

    for dir in known_dirs {
        let p = PathBuf::from(dir).join(&exe_name);
        if p.exists() {
            return p;
        }
    }

    // PATH 環境変数から検索
    if let Ok(path_env) = std::env::var("PATH") {
        let sep = if cfg!(target_os = "windows") { ';' } else { ':' };
        for dir in path_env.split(sep) {
            if dir.is_empty() {
                continue;
            }
            let p = PathBuf::from(dir).join(&exe_name);
            if p.exists() {
                return p;
            }
        }
    }

    // 最終フォールバック: プログラム名のまま（Command::new で PATH 検索に任せる）
    PathBuf::from(&exe_name)
}

fn hidden_cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    // "ffmpeg" / "ffprobe" / "curl" 等の短い名前は絶対パスに解決
    let program_str = program.as_ref().to_string_lossy().to_string();
    let path = if program_str.contains('/') || program_str.contains('\\') {
        // 既に絶対/相対パスなので解決不要
        PathBuf::from(&program_str)
    } else {
        resolve_binary(&program_str)
    };
    let mut cmd = Command::new(&path);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

fn templates_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = shorts-script-gen/src-tauri/
    let cargo_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // project root = shorts-script-gen/
    cargo_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("templates")
}


/// セッションで生成した TTS ファイルを templates/audio/{template_id}/ に
/// 永続コピーして返す（ファイル名はユニークにする）
#[tauri::command]
fn save_template_narration(
    template_id: String,
    layer_id: String,
    source_path: String,
) -> Result<String, String> {
    let dir = templates_dir().join("audio").join(&template_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let src = PathBuf::from(&source_path);
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("wav")
        .to_string();
    let target = dir.join(format!("{}_{}.{}", layer_id, stamp, ext));
    std::fs::copy(&src, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_templates() -> Result<Vec<String>, String> {
    let dir = templates_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        out.push(content);
    }
    Ok(out)
}

#[tauri::command]
fn save_template(id: String, json: String) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid template id".into());
    }
    let dir = templates_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let path = dir.join(format!("{id}.json"));

    // 同一 id を持つ別名ファイルを掃除（一覧の重複表示を防ぐ）。
    // curio-gen 由来の `template_<テーマ名>_*.json` 等を編集すると、auto-save が
    // `<id>.json` を新たに作って同じ id のファイルが 2 個並ぶ問題があった。
    // 書き出し前に「同じ id を持つ別名 JSON」を削除して、ファイル名 ↔ 内部id を
    // 1 対 1 に正規化する（`<id>.json` 自身はこの後の write で上書きされる）。
    if dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p == path {
                    continue; // 本来書く先はスキップ（後段で上書き）
                }
                if p.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let content = match std::fs::read_to_string(&p) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let matches = serde_json::from_str::<serde_json::Value>(&content)
                    .ok()
                    .and_then(|v| v.get("id").and_then(|i| i.as_str().map(String::from)))
                    .map(|file_id| file_id == id)
                    .unwrap_or(false);
                if matches {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }

    std::fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
fn delete_template(id: String) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid template id".into());
    }
    let dir = templates_dir();

    // 1) <id>.json を直接削除（アプリの save_template はこの名前で書き出す）。
    let direct = dir.join(format!("{id}.json"));
    if direct.exists() {
        std::fs::remove_file(&direct).map_err(|e| format!("remove: {e}"))?;
    }

    // 2) ファイル名が <id>.json でないテンプレも削除する。
    //    curio-gen 生成 / パック取込のテンプレは `template_<テーマ名>_simple.json` の
    //    ようにテーマ名ベースのファイル名で、内部 id（curiogen_xxxx 等）と一致しない。
    //    list_templates は中身を返すだけなので id からファイル名を逆引きできず、
    //    従来は <id>.json が無い → 無言で no-op → 「削除できないテンプレ」になっていた。
    //    そこで全 .json を走査し、JSON 内の "id" が一致するファイルを消す。
    if dir.exists() {
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path == direct {
                continue; // 1) で処理済み
            }
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let matches = serde_json::from_str::<serde_json::Value>(&content)
                .ok()
                .and_then(|v| v.get("id").and_then(|i| i.as_str().map(String::from)))
                .map(|file_id| file_id == id)
                .unwrap_or(false);
            if matches {
                std::fs::remove_file(&path)
                    .map_err(|e| format!("remove {}: {e}", path.display()))?;
            }
        }
    }

    Ok(())
}

/// レイヤープリセットの保存ディレクトリ
fn presets_dir() -> PathBuf {
    templates_dir().join("presets")
}

#[tauri::command]
fn list_presets() -> Result<Vec<String>, String> {
    let dir = presets_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(content) = std::fs::read_to_string(&path) {
                out.push(content);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn save_preset(id: String, json: String) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid preset id".into());
    }
    let dir = presets_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let path = dir.join(format!("{id}.json"));
    std::fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
fn delete_preset(id: String) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid preset id".into());
    }
    let path = presets_dir().join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
    }
    Ok(())
}

/// テンプレート（json）と参照している素材ファイル群を 1 つの .zip にまとめて書き出す。
///
/// 引数:
/// - output_zip_path: 出力先の .zip 絶対パス
/// - template_json: テンプレの json 文字列（layer.source は既に "assets/xxx" のような
///   zip 内相対パスに書き換えられている前提）
/// - assets: [(zip 内相対パス, 元の絶対パス)] の配列
#[tauri::command]
fn pack_template_to_zip(
    output_zip_path: String,
    template_json: String,
    assets: Vec<(String, String)>,
) -> Result<(), String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let file =
        std::fs::File::create(&output_zip_path).map_err(|e| format!("create zip: {e}"))?;
    let mut zw = zip::ZipWriter::new(file);

    // テンプレ本体
    let opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    zw.start_file("template.json", opts)
        .map_err(|e| format!("zip start template.json: {e}"))?;
    zw.write_all(template_json.as_bytes())
        .map_err(|e| format!("zip write template.json: {e}"))?;

    // 素材。画像/動画/音声は圧縮しても効果薄なので Stored にして書き込み高速化
    for (zip_rel, abs_path) in assets {
        let bytes = match std::fs::read(&abs_path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[pack] skip missing asset {}: {}", abs_path, e);
                continue;
            }
        };
        let entry_opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o644);
        zw.start_file(&zip_rel, entry_opts)
            .map_err(|e| format!("zip start {zip_rel}: {e}"))?;
        zw.write_all(&bytes)
            .map_err(|e| format!("zip write {zip_rel}: {e}"))?;
    }

    zw.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(())
}

/// .zip パックを展開して、template.json と assets を permanent フォルダに配置する。
///
/// - assets は `{templates_dir}/assets/{template_id}/` 配下にコピー
/// - template.json 内の layer.source が "assets/xxx" 形式の相対パスになっているので、
///   展開後のアセットの絶対パスに書き換えて返す
/// - 戻り値: 書き換え済み template.json の文字列
#[tauri::command]
fn unpack_template_zip(zip_path: String) -> Result<String, String> {
    use std::io::Read;

    let file = std::fs::File::open(&zip_path).map_err(|e| format!("open zip: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;

    // まず template.json を読み込む
    let mut template_json = String::new();
    {
        let mut entry = archive
            .by_name("template.json")
            .map_err(|e| format!("zip has no template.json: {e}"))?;
        entry
            .read_to_string(&mut template_json)
            .map_err(|e| format!("read template.json: {e}"))?;
    }

    // template.id を抽出（assets の配置先ディレクトリ名に使う）
    let template_id: String = {
        let v: serde_json::Value = serde_json::from_str(&template_json)
            .map_err(|e| format!("parse template.json: {e}"))?;
        v.get("id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("imported_{}", chrono_like_ts()))
    };
    // パス安全性チェック
    if template_id.contains('/')
        || template_id.contains('\\')
        || template_id.contains("..")
        || template_id.is_empty()
    {
        return Err(format!("invalid template id in pack: {}", template_id));
    }

    // 素材の展開先（アプリ管理フォルダ）
    let assets_root = templates_dir().join("assets").join(&template_id);
    std::fs::create_dir_all(&assets_root).map_err(|e| format!("mkdir assets: {e}"))?;

    // assets/ 配下のエントリを全部展開
    // （zip crate の API 上、エントリを列挙するには index でループする）
    let mut absolute_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip index {i}: {e}"))?;
        let name = entry.name().to_string();
        if name == "template.json" {
            continue;
        }
        if name.ends_with('/') {
            continue;
        }
        // パス traversal 防止
        if name.contains("..") {
            return Err(format!("zip entry has '..': {}", name));
        }
        // "assets/xxx.png" → 展開先 {assets_root}/xxx.png
        let rel = name
            .strip_prefix("assets/")
            .map(|s| s.to_string())
            .unwrap_or_else(|| name.clone());
        let dest_path = assets_root.join(&rel);
        if let Some(parent) = dest_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
        }
        let mut out = std::fs::File::create(&dest_path)
            .map_err(|e| format!("create {}: {e}", dest_path.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("copy to {}: {e}", dest_path.display()))?;
        absolute_map.insert(name, dest_path.to_string_lossy().into_owned());
    }

    // template.json 内の source 相対パスを絶対パスへ書き換え
    let mut v: serde_json::Value = serde_json::from_str(&template_json)
        .map_err(|e| format!("parse template.json: {e}"))?;
    if let Some(layers) = v.get_mut("layers").and_then(|x| x.as_array_mut()) {
        for layer in layers.iter_mut() {
            if let Some(src) = layer.get("source").and_then(|x| x.as_str()) {
                if let Some(abs) = absolute_map.get(src) {
                    layer["source"] = serde_json::Value::String(abs.clone());
                }
            }
        }
    }

    let rewritten = serde_json::to_string_pretty(&v)
        .map_err(|e| format!("serialize template.json: {e}"))?;
    Ok(rewritten)
}

/// UNIX 風タイムスタンプ（秒）— chrono を追加せず簡易に
fn chrono_like_ts() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

struct VoicevoxChild(Mutex<Option<std::process::Child>>);

fn find_voicevox() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        let base = PathBuf::from(local).join("Programs").join("VOICEVOX");
        // エンジン単体（GUIなし）を優先
        let engine = base.join("vv-engine").join("run.exe");
        if engine.exists() { return Some(engine); }
        let gui = base.join("VOICEVOX.exe");
        if gui.exists() { return Some(gui); }
    }
    #[cfg(target_os = "macos")]
    {
        let candidate = PathBuf::from("/Applications/VOICEVOX.app/Contents/MacOS/VOICEVOX");
        if candidate.exists() { return Some(candidate); }
    }
    None
}

fn is_voicevox_running() -> bool {
    std::net::TcpStream::connect("127.0.0.1:50021").is_ok()
}
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

const EDGE_TRUSTED_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_GEC_VERSION: &str = "1-130.0.2849.68";

fn generate_sec_ms_gec() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Python の edge-tts に合わせ Windows FILETIME (1601-01-01) ベースを使う
    // WIN_EPOCH = 1601-01-01 から 1970-01-01 までの秒数 = 11_644_473_600
    // 1 tick = 100ns = 10^-7 秒
    let win_epoch: u64 = 11_644_473_600;
    let ticks: u64 = (win_epoch + secs) * 10_000_000;
    // 5分単位に丸める（3_000_000_000 ticks = 300秒）
    let ticks = ticks - (ticks % 3_000_000_000);
    let input = format!("{}{}", ticks, EDGE_TRUSTED_TOKEN);
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{:02X}", b));
    }
    hex
}

fn output_base_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("生成動画");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn session_asset_dir(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let dir = output_base_dir(app)?.join(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn get_media_dir(app: tauri::AppHandle) -> Result<String, String> {
    output_base_dir(&app).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn save_audio_base64(
    app: tauri::AppHandle,
    session_id: String,
    base64_data: String,
    filename: String,
    extension: String,
) -> Result<String, String> {
    let dir = session_asset_dir(&app, &session_id)?;
    let ext = if extension.is_empty() {
        "mp3".to_string()
    } else {
        extension
    };
    let audio_path = dir.join(format!("{}.{}", filename, ext));
    let bytes = general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("base64 decode: {}", e))?;
    std::fs::write(&audio_path, bytes).map_err(|e| e.to_string())?;
    Ok(audio_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn save_overlay_png(
    app: tauri::AppHandle,
    session_id: String,
    base64_data: String,
    filename: String,
) -> Result<String, String> {
    let dir = session_asset_dir(&app, &session_id)?;
    let png_path = dir.join(format!("{}.png", filename));
    let bytes = general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("base64 decode: {}", e))?;
    std::fs::write(&png_path, bytes).map_err(|e| e.to_string())?;
    Ok(png_path.to_string_lossy().into_owned())
}

/// レイヤー単位でアニメーションを 30fps の透過動画 (.mov / qtrle alpha) に焼く。
/// JS 側で frame_NNNNN.png を全部 base64 で渡してきたら、Rust 側で保存して
/// `ffmpeg -framerate 30 -i frame_%05d.png -c:v qtrle out.mov` で合成する。
/// qtrle は ffmpeg 標準ビルドに必ず含まれるロスレス透過コーデック。
#[tauri::command]
async fn encode_layer_animation_video(
    app: tauri::AppHandle,
    session_id: String,
    filename: String,
    base64_frames: Vec<String>,
    fps: u32,
) -> Result<String, String> {
    if base64_frames.is_empty() {
        return Err("encode_layer_animation_video: no frames".into());
    }
    let dir = session_asset_dir(&app, &session_id)?;
    let frames_dir = dir.join(format!("{}_frames", filename));
    // 既存のフレームディレクトリは消してやり直す（前回の残骸対策）
    let _ = std::fs::remove_dir_all(&frames_dir);
    std::fs::create_dir_all(&frames_dir).map_err(|e| e.to_string())?;

    for (i, b64) in base64_frames.iter().enumerate() {
        let p = frames_dir.join(format!("frame_{:05}.png", i));
        let bytes = general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("base64 decode frame {}: {}", i, e))?;
        std::fs::write(&p, bytes).map_err(|e| format!("write frame {}: {}", i, e))?;
    }

    let output_path = dir.join(format!("{}.mov", filename));
    let _ = std::fs::remove_file(&output_path);
    let frame_pattern = frames_dir.join("frame_%05d.png");

    // qtrle = QuickTime Animation。RGB+alpha ロスレス、ffmpeg 標準。VP9 alpha より互換性が高い。
    let output = hidden_cmd("ffmpeg")
        .args(["-y"])
        .args(["-framerate", &fps.to_string()])
        .arg("-i")
        .arg(&frame_pattern)
        .args(["-c:v", "qtrle"])
        .args(["-pix_fmt", "argb"])
        .arg(&output_path)
        .output()
        .map_err(|e| format!("ffmpeg encode failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg encode_layer_animation failed: {}", stderr));
    }

    // フレームディレクトリは消す（合成後は不要）
    let _ = std::fs::remove_dir_all(&frames_dir);

    Ok(output_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn voicevox_tts(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    speaker: i32,
    filename: String,
) -> Result<String, String> {
    let base_url = "http://localhost:50021";

    let query_url = format!(
        "{}/audio_query?text={}&speaker={}",
        base_url,
        urlencoding_encode(&text),
        speaker
    );
    let query_res = reqwest_post_empty(&query_url).await
        .map_err(|e| format!("VOICEVOX audio_query 失敗（起動中？）: {}", e))?;

    let synth_url = format!("{}/synthesis?speaker={}", base_url, speaker);
    let wav_bytes = reqwest_post_json(&synth_url, &query_res).await
        .map_err(|e| format!("VOICEVOX synthesis 失敗: {}", e))?;

    let dir = session_asset_dir(&app, &session_id)?;
    let wav_path = dir.join(format!("{}.wav", filename));
    std::fs::write(&wav_path, wav_bytes).map_err(|e| e.to_string())?;

    // Live2D リップシンク用に audio_query JSON を sidecar 保存。
    // accent_phrases[].moras[].vowel と vowel_length / consonant_length を持つので、
    // 後段で「時刻 t にどの母音が鳴っているか」を引ける。
    let query_path = dir.join(format!("{}.query.json", filename));
    let _ = std::fs::write(&query_path, query_res.as_bytes());

    Ok(wav_path.to_string_lossy().into_owned())
}

/// OpenAI TTS API (tts-1 / tts-1-hd) を呼んで MP3 を保存する
#[tauri::command]
async fn openai_tts(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    voice: String,
    model: String,
    api_key: String,
    filename: String,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("OpenAI API キーが設定されていません".into());
    }
    let m = if model.trim().is_empty() {
        "tts-1"
    } else {
        model.trim()
    };
    let v = if voice.trim().is_empty() {
        "alloy"
    } else {
        voice.trim()
    };
    let body = format!(
        r#"{{"model":"{}","voice":"{}","input":{},"response_format":"mp3"}}"#,
        m,
        v,
        serde_json::to_string(&text).map_err(|e| e.to_string())?
    );

    // curl で POST。ステータスだけ確認するため -s -f -w 組み合わせ
    use std::io::Write;
    use std::process::Stdio;
    let mut child = hidden_cmd("curl")
        .args([
            "-s",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {}", api_key),
            "--data-binary",
            "@-",
            "https://api.openai.com/v1/audio/speech",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl spawn: {}", e))?;
    {
        let stdin = child.stdin.as_mut().ok_or("no stdin")?;
        stdin
            .write_all(body.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("curl wait: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "OpenAI TTS curl failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    // 先頭が JSON エラーなら拒否
    if output.stdout.starts_with(b"{") {
        return Err(format!(
            "OpenAI TTS エラー応答: {}",
            String::from_utf8_lossy(&output.stdout)
        ));
    }
    let dir = session_asset_dir(&app, &session_id)?;
    let mp3_path = dir.join(format!("{}.mp3", filename));
    std::fs::write(&mp3_path, &output.stdout).map_err(|e| e.to_string())?;
    Ok(mp3_path.to_string_lossy().into_owned())
}

/// SofTalk.exe をサブプロセス起動して WAV を生成（ゆっくり霊夢/魔理沙系）
/// 必要な引数: /W:"text" /R:"out.wav" /X:<voice_index> /T:1 /Q:1
#[tauri::command]
async fn softalk_tts(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    voice: i32,
    filename: String,
    softalk_path: String,
) -> Result<String, String> {
    if softalk_path.trim().is_empty() {
        return Err("SofTalk.exe のパスが設定されていません（設定 → SofTalk）".into());
    }
    let dir = session_asset_dir(&app, &session_id)?;
    let wav_path = dir.join(format!("{}.wav", filename));
    let wav_path_str = wav_path.to_string_lossy().into_owned();

    // 出力先に日本語パスが含まれると SofTalk が書き込めない場合があるため一時ディレクトリを使う
    let temp_wav = std::env::temp_dir().join(format!("st_{}.wav", filename));
    let _ = std::fs::remove_file(&temp_wav);
    let temp_wav_str = temp_wav.to_string_lossy().into_owned();

    // SofTalk は GUI アプリのため CREATE_NO_WINDOW を使わず直接起動する
    let output = std::process::Command::new(&softalk_path)
        .args([
            &format!("/W:{}", text),
            &format!("/R:{}", temp_wav_str),
            &format!("/X:{}", voice),
            "/T:1",
            "/Q:1",
        ])
        .output()
        .map_err(|e| format!("SofTalk 起動失敗: {}", e))?;

    // ファイルシステムの書き込み完了を少し待つ
    std::thread::sleep(std::time::Duration::from_millis(500));

    if !temp_wav.exists() {
        return Err(format!(
            "SofTalk が WAV を生成しませんでした (終了コード: {})\nstdout: {}\nstderr: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        ));
    }

    std::fs::copy(&temp_wav, &wav_path)
        .map_err(|e| format!("WAV コピー失敗: {}", e))?;
    let _ = std::fs::remove_file(&temp_wav);
    Ok(wav_path_str)
}

fn urlencoding_encode(s: &str) -> String {
    let mut encoded = String::with_capacity(s.len() * 3);
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

async fn reqwest_post_empty(url: &str) -> Result<String, String> {
    use std::process::Stdio;
    let child = hidden_cmd("curl")
        .args(["-s", "-f", "-X", "POST", "-H", "Content-Type: application/json"])
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl spawn: {}", e))?;
    let output = child.wait_with_output().map_err(|e| format!("curl wait: {}", e))?;
    if !output.status.success() {
        return Err(format!("curl failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn reqwest_post_json(url: &str, json_body: &str) -> Result<Vec<u8>, String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = hidden_cmd("curl")
        .args([
            "-s",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
        ])
        .arg(url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl spawn: {}", e))?;
    {
        let stdin = child.stdin.as_mut().ok_or("no stdin")?;
        stdin.write_all(json_body.as_bytes()).map_err(|e| e.to_string())?;
    }
    let output = child.wait_with_output().map_err(|e| format!("curl wait: {}", e))?;
    if !output.status.success() {
        return Err(format!("curl failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(output.stdout)
}

#[tauri::command]
async fn edge_tts(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    voice: String,
    filename: String,
) -> Result<String, String> {
    let audio_bytes = edge_tts_synthesize(&text, &voice)
        .await
        .map_err(|e| format!("edge_tts: {}", e))?;

    let dir = session_asset_dir(&app, &session_id)?;
    let mp3_path = dir.join(format!("{}.mp3", filename));
    std::fs::write(&mp3_path, &audio_bytes).map_err(|e| e.to_string())?;

    let wav_path = dir.join(format!("{}.wav", filename));
    let output = hidden_cmd("ffmpeg")
        .args(["-y", "-i"])
        .arg(&mp3_path)
        .arg(&wav_path)
        .output()
        .map_err(|e| format!("ffmpeg mp3->wav: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg mp3->wav failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let _ = std::fs::remove_file(&mp3_path);
    Ok(wav_path.to_string_lossy().into_owned())
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn gen_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut s = format!("{:x}", nanos);
    while s.len() < 32 {
        s.push_str(&format!("{:x}", nanos.wrapping_mul(s.len() as u128 + 1)));
    }
    s.chars().take(32).collect()
}

async fn edge_tts_synthesize(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    timeout(Duration::from_secs(30), edge_tts_inner(text, voice))
        .await
        .map_err(|_| "Edge TTS: 30秒以内に応答がありませんでした".to_string())?
}

async fn edge_tts_inner(text: &str, voice: &str) -> Result<Vec<u8>, String> {
    let connect_id = gen_id();
    let sec_ms_gec = generate_sec_ms_gec();
    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken={tok}&Sec-MS-GEC={gec}&Sec-MS-GEC-Version={ver}&ConnectionId={cid}",
        tok = EDGE_TRUSTED_TOKEN,
        gec = sec_ms_gec,
        ver = EDGE_GEC_VERSION,
        cid = connect_id,
    );

    let mut request = url
        .into_client_request()
        .map_err(|e| format!("build request: {}", e))?;
    let headers = request.headers_mut();
    headers.insert(
        "Origin",
        "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
            .parse()
            .unwrap(),
    );
    headers.insert(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
            .parse()
            .unwrap(),
    );

    let (ws_stream, _) = connect_async(request)
        .await
        .map_err(|e| format!("connect: {}", e))?;
    let (mut write, mut read) = ws_stream.split();

    let timestamp = chrono_iso();

    let config_msg = format!(
        "X-Timestamp:{}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{}",
        timestamp,
        r#"{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}"#
    );
    write
        .send(Message::Text(config_msg))
        .await
        .map_err(|e| format!("send config: {}", e))?;

    let request_id = gen_id();
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ja-JP'><voice name='{}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>{}</prosody></voice></speak>",
        voice,
        escape_xml(text)
    );
    let ssml_msg = format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}\r\nPath:ssml\r\n\r\n{}",
        request_id, timestamp, ssml
    );
    write
        .send(Message::Text(ssml_msg))
        .await
        .map_err(|e| format!("send ssml: {}", e))?;

    let mut audio = Vec::new();
    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Binary(data)) => {
                if data.len() < 2 {
                    continue;
                }
                let header_len = ((data[0] as usize) << 8) | (data[1] as usize);
                let start = 2 + header_len;
                if start < data.len() {
                    audio.extend_from_slice(&data[start..]);
                }
            }
            Ok(Message::Text(t)) => {
                if t.contains("Path:turn.end") {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(e) => return Err(format!("ws recv: {}", e)),
        }
    }

    if audio.is_empty() {
        return Err("no audio returned（認証トークン期限切れかサーバ拒否）".into());
    }
    Ok(audio)
}

fn chrono_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() as i64;
    let ms = (d.subsec_millis()) as i64;
    let days_since_epoch = secs / 86400;
    let secs_today = secs % 86400;
    let hours = secs_today / 3600;
    let mins = (secs_today % 3600) / 60;
    let seconds = secs_today % 60;

    let (year, month, day) = days_to_ymd(days_since_epoch);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hours, mins, seconds, ms
    )
}

fn days_to_ymd(days: i64) -> (i64, i64, i64) {
    let days = days + 719468;
    let era = if days >= 0 { days / 146097 } else { (days - 146096) / 146097 };
    let doe = (days - era * 146097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let _ = days;
    (y, m, d)
}

#[tauri::command]
async fn generate_tts(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    voice: String,
    filename: String,
) -> Result<String, String> {
    let dir = session_asset_dir(&app, &session_id)?;
    let aiff_path = dir.join(format!("{}.aiff", filename));
    let wav_path = dir.join(format!("{}.wav", filename));

    let say_voice = if voice.is_empty() { "Kyoko".to_string() } else { voice };

    let output = hidden_cmd("say")
        .args(["-v", &say_voice, "-o"])
        .arg(&aiff_path)
        .arg(&text)
        .output()
        .map_err(|e| format!("say command failed: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "say failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let output = hidden_cmd("ffmpeg")
        .args(["-y", "-i"])
        .arg(&aiff_path)
        .arg(&wav_path)
        .output()
        .map_err(|e| format!("ffmpeg conversion failed: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "ffmpeg (aiff->wav) failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let _ = std::fs::remove_file(&aiff_path);
    Ok(wav_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn list_se_files(app: tauri::AppHandle, dir: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let se_dir = match dir {
        Some(d) if !d.is_empty() => std::path::PathBuf::from(d),
        _ => {
            // 同梱リソース内の SE フォルダを優先
            let bundled = app
                .path()
                .resource_dir()
                .ok()
                .map(|p| p.join("SE"))
                .filter(|p| p.exists());
            if let Some(p) = bundled {
                p
            } else {
                // フォールバック: ユーザーのDocuments\SE
                let home = std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_default();
                std::path::PathBuf::from(home).join("Documents").join("SE")
            }
        }
    };
    if !se_dir.exists() {
        return Ok(vec![]);
    }
    let audio_exts = ["mp3", "wav", "m4a", "ogg", "aac", "flac"];
    let mut files: Vec<serde_json::Value> = std::fs::read_dir(&se_dir)
        .map_err(|e| format!("SEフォルダ読み取り失敗: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if !path.is_file() { return None; }
            let ext = path.extension()?.to_str()?.to_lowercase();
            if !audio_exts.contains(&ext.as_str()) { return None; }
            let name = path.file_stem()?.to_string_lossy().into_owned();
            let full = path.to_string_lossy().into_owned();
            Some(serde_json::json!({ "name": name, "path": full, "ext": ext }))
        })
        .collect();
    files.sort_by(|a, b| {
        a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(files)
}

#[tauri::command]
async fn download_bgm(
    app: tauri::AppHandle,
    session_id: String,
    url: String,
) -> Result<String, String> {
    let dir = session_asset_dir(&app, &session_id)?;
    let path = dir.join("bgm.mp3");
    let status = hidden_cmd("curl")
        .args(["-L", "-f", "-s", "-o"])
        .arg(&path)
        .arg(&url)
        .status()
        .map_err(|e| format!("curl failed: {}", e))?;
    if !status.success() {
        return Err(format!("BGMダウンロード失敗: {}", url));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// フロントエンドが WebCodecs 等でレンダリングしたバイト列をセッションのアセットディレクトリに保存する。
/// Live2D キャラレイヤーをエクスポート前に WebM (VP9 + alpha) として焼き出すのに使う。
#[tauri::command]
async fn save_render_chunk(
    app: tauri::AppHandle,
    session_id: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let dir = session_asset_dir(&app, &session_id)?;
    let out_path = dir.join(&filename);
    std::fs::write(&out_path, &bytes)
        .map_err(|e| format!("save_render_chunk write: {}", e))?;
    Ok(out_path.to_string_lossy().into_owned())
}

/// WebCodecs ベースの完全エクスポート経路の最終 mp4 を出力ディレクトリ（生成動画/）直下に保存する。
/// 既存 ffmpeg 経路の `compose_template_video` と同じ出力先になるので運用上互換。
///
/// `append=false`（最初のチャンク）: ファイルを新規作成（truncate）
/// `append=true`（後続チャンク）: 既存ファイルに追記
///
/// Tauri IPC は JSON 経由なので 数百 MB の Uint8Array を一度に送ると
/// `Array.from() → JSON.stringify` で `Invalid array length` (RangeError) が出る。
/// JS 側で 8〜16MB チャンクに分割して順次呼ぶ。
#[tauri::command]
async fn save_final_video(
    app: tauri::AppHandle,
    filename: String,
    bytes: Vec<u8>,
    append: bool,
) -> Result<String, String> {
    let dir = output_base_dir(&app)?;
    let out_path = dir.join(&filename);
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&out_path)
        .map_err(|e| format!("save_final_video open: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("save_final_video write: {}", e))?;
    Ok(out_path.to_string_lossy().into_owned())
}

/// 任意パス (絶対) のテキストファイルを UTF-8 で読み込む。
/// 主に VOICEVOX query JSON sidecar のような「絶対パスで指された小さなテキスト」を
/// フロントエンドが読みたい場合に使う。
/// 見つからない場合は Ok(None) を返す (リップシンクのフォールバック判定用)。
#[tauri::command]
async fn read_voicevox_query(path: String) -> Result<Option<String>, String> {
    if !std::path::Path::new(&path).exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("read_voicevox_query: {}", e))
}

#[tauri::command]
async fn get_audio_duration(audio_path: String) -> Result<f64, String> {
    let output = hidden_cmd("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(&audio_path)
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let s = String::from_utf8_lossy(&output.stdout);
    s.trim()
        .parse::<f64>()
        .map_err(|e| format!("parse duration: {}", e))
}

// ========================================================================
// 素材取り込み（templates/assets/{template_id}/ 配下にコピー）
// ========================================================================

fn sanitize_basename(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    if cleaned.len() > 60 {
        cleaned.chars().take(60).collect()
    } else {
        cleaned
    }
}

/// 素材ファイルを templates/assets/{template_id}/{kind}/ にコピーして取り込む。
/// 同じ内容のファイルが既に存在する場合は再コピーせず、そのパスを返す。
/// 戻り値はコピー先の絶対パス（layer.source にそのまま入れる）。
#[tauri::command]
fn import_asset(
    template_id: String,
    source_path: String,
    kind: String,
) -> Result<String, String> {
    if template_id.is_empty()
        || template_id.contains('/')
        || template_id.contains('\\')
        || template_id.contains("..")
    {
        return Err("invalid template_id".into());
    }
    let allowed = ["images", "videos", "audio"];
    if !allowed.contains(&kind.as_str()) {
        return Err(format!(
            "invalid kind: {} (許可: {})",
            kind,
            allowed.join("/")
        ));
    }
    let src = PathBuf::from(&source_path);
    if !src.exists() {
        return Err(format!("元ファイルが存在しません: {}", source_path));
    }

    // SHA256（先頭 8 文字）でハッシュ化
    let bytes = std::fs::read(&src).map_err(|e| format!("読み取り失敗: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let hash8: String = digest
        .iter()
        .take(4)
        .map(|b| format!("{:02x}", b))
        .collect();

    let original_stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("asset");
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("bin")
        .to_lowercase();
    let safe_stem = sanitize_basename(original_stem);
    let filename = format!("{}_{}.{}", hash8, safe_stem, ext);

    let dest_dir = templates_dir()
        .join("assets")
        .join(&template_id)
        .join(&kind);
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("ディレクトリ作成失敗: {}", e))?;
    let dest_path = dest_dir.join(&filename);

    // 既存ファイルがあれば内容比較して同一ならスキップ
    if dest_path.exists() {
        if let Ok(existing) = std::fs::read(&dest_path) {
            if existing == bytes {
                return Ok(dest_path.to_string_lossy().into_owned());
            }
        }
    }
    std::fs::write(&dest_path, &bytes).map_err(|e| format!("書き込み失敗: {}", e))?;
    Ok(dest_path.to_string_lossy().into_owned())
}

/// ディレクトリを再帰コピー (シンプル実装)。
/// 既存の同名ファイルは上書きする。シンボリックリンクは追従しない。
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&src_path, &dst_path)?;
        }
        // symlink 等は無視
    }
    Ok(())
}

/// グローバル Live2D ライブラリのルート: `templates/live2d/`
/// テンプレ非依存で、一度登録したモデルは全テンプレから使える。
fn live2d_library_dir() -> PathBuf {
    templates_dir().join("live2d")
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Live2DModelMeta {
    /// モデルの登録名 (フォルダ名と同じ)
    pub name: String,
    /// 主 .model3.json への絶対パス
    pub model_path: String,
    /// 制作者名
    #[serde(default)]
    pub author: Option<String>,
    /// 配布元 URL
    #[serde(default)]
    pub source_url: Option<String>,
    /// 動画概要欄に貼る指定クレジット文
    #[serde(default)]
    pub required_credit_text: Option<String>,
    /// 登録日時 (UNIX エポック秒)
    #[serde(default)]
    pub registered_at: i64,
}

/// 1 モデル分のメタを {model_dir}/_meta.json に書き出す
fn write_model_meta(model_dir: &std::path::Path, meta: &Live2DModelMeta) -> std::io::Result<()> {
    let meta_path = model_dir.join("_meta.json");
    let json = serde_json::to_string_pretty(meta).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::Other, format!("serialize meta: {}", e))
    })?;
    std::fs::write(meta_path, json)
}

/// 1 モデル分のメタを {model_dir}/_meta.json から読む。失敗時は最小限の meta を返す
fn read_model_meta(model_dir: &std::path::Path, fallback_name: &str) -> Live2DModelMeta {
    let meta_path = model_dir.join("_meta.json");
    if let Ok(text) = std::fs::read_to_string(&meta_path) {
        if let Ok(parsed) = serde_json::from_str::<Live2DModelMeta>(&text) {
            return parsed;
        }
    }
    // model3.json を探してそのパスを model_path にする
    let model_path = std::fs::read_dir(model_dir)
        .ok()
        .and_then(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .find(|p| {
                    p.to_str()
                        .map(|s| s.to_lowercase().ends_with(".model3.json"))
                        .unwrap_or(false)
                })
        })
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    Live2DModelMeta {
        name: fallback_name.to_string(),
        model_path,
        author: None,
        source_url: None,
        required_credit_text: None,
        registered_at: 0,
    }
}

/// グローバルライブラリにモデルを追加する。
/// `templates/live2d/{model_name}/` に sister files 含めて再帰コピー。
/// 既に同名モデルがあれば上書き (内容差し替え) する。
#[tauri::command]
fn import_live2d_global(
    source_model3_json_path: String,
    author: Option<String>,
    source_url: Option<String>,
    required_credit_text: Option<String>,
) -> Result<Live2DModelMeta, String> {
    let src_json = PathBuf::from(&source_model3_json_path);
    if !src_json.exists() {
        return Err(format!("元ファイルが存在しません: {}", source_model3_json_path));
    }
    let src_dir = src_json
        .parent()
        .ok_or_else(|| "model3.json の親ディレクトリが取れません".to_string())?
        .to_path_buf();
    let model_name_raw = src_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("live2d_model");
    let model_name = sanitize_basename(model_name_raw);

    let dest_dir = live2d_library_dir().join(&model_name);
    copy_dir_recursive(&src_dir, &dest_dir)
        .map_err(|e| format!("Live2D モデルのコピー失敗: {}", e))?;

    let json_filename = src_json
        .file_name()
        .ok_or_else(|| "model3.json のファイル名が取れません".to_string())?;
    let dest_json = dest_dir.join(json_filename);
    if !dest_json.exists() {
        return Err(format!(
            "コピーは成功したが {} が見つかりません",
            dest_json.display()
        ));
    }

    let meta = Live2DModelMeta {
        name: model_name.clone(),
        model_path: dest_json.to_string_lossy().into_owned(),
        author,
        source_url,
        required_credit_text,
        registered_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0),
    };
    write_model_meta(&dest_dir, &meta).map_err(|e| format!("meta 保存失敗: {}", e))?;
    Ok(meta)
}

/// グローバルライブラリに登録されたモデル一覧を取得 (登録日時降順)
#[tauri::command]
fn list_live2d_models() -> Result<Vec<Live2DModelMeta>, String> {
    let lib = live2d_library_dir();
    if !lib.exists() {
        return Ok(Vec::new());
    }
    let mut metas: Vec<Live2DModelMeta> = Vec::new();
    let entries = std::fs::read_dir(&lib).map_err(|e| format!("read_dir: {}", e))?;
    for ent in entries.flatten() {
        let path = ent.path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }
        let meta = read_model_meta(&path, &name);
        // model_path が指す .model3.json が存在しないモデルは除外 (壊れたエントリ)
        if !std::path::Path::new(&meta.model_path).exists() {
            continue;
        }
        metas.push(meta);
    }
    // 登録日時降順 (新しい順)
    metas.sort_by(|a, b| b.registered_at.cmp(&a.registered_at));
    Ok(metas)
}

/// グローバルライブラリから 1 モデルを削除する (フォルダごと)
#[tauri::command]
fn delete_live2d_model(name: String) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err("invalid name".into());
    }
    let dir = live2d_library_dir().join(&name);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("削除失敗: {}", e))?;
    Ok(())
}

/// 既存モデルのメタ情報 (クレジット等) を更新する。フォルダ内容には触れない。
#[tauri::command]
fn update_live2d_model_meta(
    name: String,
    author: Option<String>,
    source_url: Option<String>,
    required_credit_text: Option<String>,
) -> Result<Live2DModelMeta, String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
    {
        return Err("invalid name".into());
    }
    let dir = live2d_library_dir().join(&name);
    if !dir.exists() {
        return Err(format!("モデルが見つかりません: {}", name));
    }
    let mut meta = read_model_meta(&dir, &name);
    meta.author = author;
    meta.source_url = source_url;
    meta.required_credit_text = required_credit_text;
    write_model_meta(&dir, &meta).map_err(|e| format!("meta 保存失敗: {}", e))?;
    Ok(meta)
}

/// Live2D モデルのフォルダ全体を templates/assets/{template_id}/live2d/{model_name}/ に
/// 再帰コピーする。.model3.json から見える sister files 一式を丸ごと持っていくので
/// 別 PC へテンプレを移しても動く (モデルがアプリ管理下に入る)。
#[tauri::command]
fn import_live2d_model(
    template_id: String,
    source_model3_json_path: String,
) -> Result<String, String> {
    if template_id.is_empty()
        || template_id.contains('/')
        || template_id.contains('\\')
        || template_id.contains("..")
    {
        return Err("invalid template_id".into());
    }
    let src_json = PathBuf::from(&source_model3_json_path);
    if !src_json.exists() {
        return Err(format!("元ファイルが存在しません: {}", source_model3_json_path));
    }
    let src_dir = src_json
        .parent()
        .ok_or_else(|| "model3.json の親ディレクトリが取れません".to_string())?
        .to_path_buf();
    let model_name_raw = src_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("live2d_model");
    let model_name = sanitize_basename(model_name_raw);

    let dest_dir = templates_dir()
        .join("assets")
        .join(&template_id)
        .join("live2d")
        .join(&model_name);

    // 既に同名フォルダがあれば中身を上書きするが、削除はしない (副作用最小)
    copy_dir_recursive(&src_dir, &dest_dir)
        .map_err(|e| format!("Live2D モデルのコピー失敗: {}", e))?;

    // コピー後の .model3.json パスを返す
    let json_filename = src_json
        .file_name()
        .ok_or_else(|| "model3.json のファイル名が取れません".to_string())?;
    let dest_json = dest_dir.join(json_filename);
    if !dest_json.exists() {
        return Err(format!(
            "コピーは成功したが {} が見つかりません",
            dest_json.display()
        ));
    }
    Ok(dest_json.to_string_lossy().into_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub kind: String,
    pub path: String,
    pub filename: String,
    pub size: u64,
    /// ファイルの最終更新時刻 (UNIX epoch 秒)
    pub modified_unix: i64,
}

/// テンプレートに紐づく素材一覧を返す
#[tauri::command]
fn list_template_assets(template_id: String) -> Result<Vec<AssetInfo>, String> {
    if template_id.is_empty()
        || template_id.contains('/')
        || template_id.contains('\\')
        || template_id.contains("..")
    {
        return Err("invalid template_id".into());
    }
    let root = templates_dir().join("assets").join(&template_id);
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out: Vec<AssetInfo> = Vec::new();
    for kind in ["images", "videos", "audio"] {
        let dir = root.join(kind);
        if !dir.exists() {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let filename = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("?")
                .to_string();
            let meta = std::fs::metadata(&path);
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified_unix = meta
                .as_ref()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push(AssetInfo {
                kind: kind.to_string(),
                path: path.to_string_lossy().into_owned(),
                filename,
                size,
                modified_unix,
            });
        }
    }
    // 新しい順
    out.sort_by(|a, b| b.modified_unix.cmp(&a.modified_unix));
    Ok(out)
}

/// 指定の素材ファイルを削除する
#[tauri::command]
fn delete_template_asset(
    template_id: String,
    kind: String,
    filename: String,
) -> Result<(), String> {
    if template_id.is_empty()
        || template_id.contains('/')
        || template_id.contains('\\')
        || template_id.contains("..")
    {
        return Err("invalid template_id".into());
    }
    if !["images", "videos", "audio"].contains(&kind.as_str()) {
        return Err("invalid kind".into());
    }
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("invalid filename".into());
    }
    let path = templates_dir()
        .join("assets")
        .join(&template_id)
        .join(&kind)
        .join(&filename);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("削除失敗: {}", e))?;
    }
    Ok(())
}

/// base64 エンコードされたバイナリ素材をテンプレ管理下に保存する
/// （Canvas で生成したパターン背景の webm 等を保存するのに使う）
#[tauri::command]
fn save_template_asset_base64(
    template_id: String,
    kind: String,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    if template_id.is_empty()
        || template_id.contains('/')
        || template_id.contains('\\')
        || template_id.contains("..")
    {
        return Err("invalid template_id".into());
    }
    if !["images", "videos", "audio"].contains(&kind.as_str()) {
        return Err("invalid kind".into());
    }
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err("invalid filename".into());
    }
    let bytes = general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("base64 decode 失敗: {}", e))?;

    let dest_dir = templates_dir()
        .join("assets")
        .join(&template_id)
        .join(&kind);
    std::fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("ディレクトリ作成失敗: {}", e))?;
    let dest_path = dest_dir.join(&filename);
    std::fs::write(&dest_path, &bytes).map_err(|e| format!("書き込み失敗: {}", e))?;
    Ok(dest_path.to_string_lossy().into_owned())
}

/// テンプレID 変更時（仮 ID → 確定 ID）に、assets フォルダをリネームする。
/// 既存の `templates/assets/{old_id}/` を `templates/assets/{new_id}/` に移動する。
/// `old_id` 側のフォルダが存在しないか、`new_id` 側が既にあるなら no-op（エラーにしない）。
#[tauri::command]
fn rename_template_assets(old_id: String, new_id: String) -> Result<(), String> {
    for id in [&old_id, &new_id] {
        if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
            return Err(format!("invalid template id: {}", id));
        }
    }
    if old_id == new_id {
        return Ok(());
    }
    let from = templates_dir().join("assets").join(&old_id);
    if !from.exists() {
        return Ok(());
    }
    let to = templates_dir().join("assets").join(&new_id);
    if to.exists() {
        // 既に存在するなら、安全のためにマージしない（呼び出し側で対処）
        return Err(format!(
            "destination already exists: {}",
            to.to_string_lossy()
        ));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    std::fs::rename(&from, &to).map_err(|e| format!("rename failed: {}", e))?;
    Ok(())
}

/// 旧バージョンの `templates/audio/{tid}/` 配下のファイルを
/// `templates/assets/{tid}/audio/` に移動する。
/// 同時に `templates/template_*.json` 内のパス文字列も書き換える。
/// 完了後 `templates/audio/` ディレクトリは削除される。
/// 戻り値: 移動できた tid の数。
#[tauri::command]
fn migrate_legacy_audio_dirs() -> Result<u32, String> {
    let templates_root = templates_dir();
    let legacy_audio_root = templates_root.join("audio");
    if !legacy_audio_root.exists() {
        return Ok(0);
    }

    // 1. ファイル移動
    let entries = std::fs::read_dir(&legacy_audio_root)
        .map_err(|e| format!("read legacy audio: {}", e))?;
    let mut migrated_tids: Vec<String> = vec![];
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let tid = match p.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if tid.is_empty() || tid.contains('/') || tid.contains('\\') || tid.contains("..") {
            continue;
        }
        let new_dir = templates_root.join("assets").join(&tid).join("audio");
        std::fs::create_dir_all(&new_dir)
            .map_err(|e| format!("create new dir for {}: {}", tid, e))?;

        let inner = match std::fs::read_dir(&p) {
            Ok(it) => it,
            Err(_) => continue,
        };
        let mut moved_any = false;
        for f in inner.flatten() {
            let from = f.path();
            if !from.is_file() {
                continue;
            }
            let to = new_dir.join(f.file_name());
            if to.exists() {
                // 既に同名ファイルが移行先にある（再実行 or 別経路で移動済み）→ 元を削除して進む
                let _ = std::fs::remove_file(&from);
                continue;
            }
            // try rename, fall back to copy + remove
            let mv = std::fs::rename(&from, &to);
            if mv.is_err() {
                if let Err(e) = std::fs::copy(&from, &to) {
                    return Err(format!("copy {} → {}: {}", from.display(), to.display(), e));
                }
                let _ = std::fs::remove_file(&from);
            }
            moved_any = true;
        }
        if moved_any {
            migrated_tids.push(tid);
        }
        let _ = std::fs::remove_dir(&p);
    }
    let _ = std::fs::remove_dir(&legacy_audio_root);

    if migrated_tids.is_empty() {
        return Ok(0);
    }

    // 2. テンプレ JSON 内のパス文字列を書き換える。
    //    JSON ファイルなので Windows 路径は `\\` でエスケープされている。
    //    `\\templates\\audio\\{tid}\\` → `\\templates\\assets\\{tid}\\audio\\`
    //    Unix 系 `/templates/audio/{tid}/` → `/templates/assets/{tid}/audio/` にも対応。
    let json_entries = std::fs::read_dir(&templates_root)
        .map_err(|e| format!("read templates dir: {}", e))?;
    for entry in json_entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut new_content = content.clone();
        for tid in &migrated_tids {
            // Windows 形式（JSON エスケープで \\ になっている）
            let win_from = format!(r"\\templates\\audio\\{}\\", tid);
            let win_to = format!(r"\\templates\\assets\\{}\\audio\\", tid);
            new_content = new_content.replace(&win_from, &win_to);
            // Unix 形式
            let unix_from = format!("/templates/audio/{}/", tid);
            let unix_to = format!("/templates/assets/{}/audio/", tid);
            new_content = new_content.replace(&unix_from, &unix_to);
        }
        if new_content != content {
            std::fs::write(&path, new_content)
                .map_err(|e| format!("write {}: {}", path.display(), e))?;
        }
    }

    Ok(migrated_tids.len() as u32)
}

/// 指定テンプレ ID の素材フォルダを丸ごと削除する（テンプレ削除時に呼ぶ）
#[tauri::command]
fn delete_template_assets(template_id: String) -> Result<(), String> {
    if template_id.is_empty()
        || template_id.contains('/')
        || template_id.contains('\\')
        || template_id.contains("..")
    {
        return Err("invalid template_id".into());
    }
    let dir = templates_dir().join("assets").join(&template_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("削除失敗: {}", e))?;
    }
    Ok(())
}

/// URL パーセントエンコード（OAuth 用の最小実装）
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// OAuth コールバック待ちの結果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackResult {
    pub code: String,
    pub redirect_uri: String,
}

/// Google OAuth 認可フローを開始する。
/// - ローカルで空きポートを取得し、ブラウザを Google 認可画面に飛ばす
/// - ユーザが許可すると `http://127.0.0.1:{port}/callback?code=...` にリダイレクトされるので、
///   それをローカルサーバで受け取り認可コードを返す
/// - 得た code と使った redirect_uri は TS 側でトークン交換に使われる
#[tauri::command]
async fn youtube_oauth_flow(
    app: tauri::AppHandle,
    client_id: String,
) -> Result<OAuthCallbackResult, String> {
    // 1. 空きポートを確保
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("addr: {}", e))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    // 2. Google 認可エンドポイント URL を組み立て
    let scope = "https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly";
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        url_encode(&client_id),
        url_encode(&redirect_uri),
        url_encode(scope),
    );

    // 3. ブラウザを開く
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("open browser: {}", e))?;

    // 4. コールバック待ち（最大 5 分）
    let code = tokio::time::timeout(Duration::from_secs(300), wait_for_oauth_callback(listener))
        .await
        .map_err(|_| "認証がタイムアウトしました（5分以内にブラウザで許可してください）".to_string())?
        .map_err(|e| format!("callback: {}", e))?;

    Ok(OAuthCallbackResult { code, redirect_uri })
}

/// 1 回の HTTP GET を読んで code= パラメータを取り出す。ブラウザには完了画面を返す
async fn wait_for_oauth_callback(listener: TcpListener) -> Result<String, String> {
    let (mut stream, _) = listener.accept().await.map_err(|e| format!("accept: {}", e))?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| format!("read: {}", e))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // 最初の行: "GET /callback?code=XXX&scope=... HTTP/1.1"
    let first_line = request.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err("invalid HTTP request".to_string());
    }
    let url_path = parts[1];
    let query = url_path.split('?').nth(1).unwrap_or("");

    // ?error=... で戻ってきたら失敗
    if let Some(err) = query
        .split('&')
        .find(|kv| kv.starts_with("error="))
        .and_then(|kv| kv.split('=').nth(1))
    {
        let body = "<html><body><h2>認証がキャンセルされました</h2><p>アプリに戻ってください。</p></body></html>";
        let response = format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(response.as_bytes()).await.ok();
        stream.shutdown().await.ok();
        return Err(format!("OAuth error: {}", err));
    }

    let code = query
        .split('&')
        .find(|kv| kv.starts_with("code="))
        .and_then(|kv| kv.split('=').nth(1))
        .ok_or_else(|| "no code in callback URL".to_string())?
        .to_string();

    let body = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>認証完了</title></head><body style=\"font-family:sans-serif;text-align:center;padding:3em;background:#f6f9fc;\"><h2 style=\"color:#0c8\">✓ YouTube 認証が完了しました</h2><p>このウィンドウを閉じて、アプリに戻ってください。</p></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await.ok();
    stream.shutdown().await.ok();

    Ok(code)
}


// ========================================================================
// ヘッドレス・フレーム描画（curio-gen の D9 ゲート用）
//
// curio-gen は `node scripts/render-frames.mjs --template … --times … --out …`
// という純粋な node CLI を subprocess で叩く。その node ラッパーが内部でこの exe を
// `--render-frames …` 付きで spawn し、隠しウィンドウ (render.html) で本物の
// renderLayersOnContext を回して各秒の PNG を書き出す。
//
// release ビルドは windows_subsystem="windows" なので stdout がパイプに乗らない。
// そこで exe は `<out>/manifest.json` をファイル出力し、node ラッパーがそれを読んで
// 自前の stdout に流す（GUI exe の stdout 問題を回避しつつ curio-gen の契約を維持）。
// ========================================================================

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderArgs {
    /// テンプレ JSON の中身（exe が --template のファイルを読んで埋める）
    template_json: String,
    /// 描画する秒（カンマ区切りをパース済み）
    times: Vec<f64>,
    /// PNG / manifest.json の出力先ディレクトリ（絶対パス）
    out_dir: String,
    /// 出力幅（省略時は templateDimensions）
    width: Option<u32>,
    /// 出力高さ（省略時は templateDimensions）
    height: Option<u32>,
}

/// `--render-frames` モードの引数を managed state として保持する。
struct RenderState(Option<RenderArgs>);

/// CLI 引数から `--render-frames` モードの RenderArgs を組み立てる。
/// `--render-frames` が無ければ None（＝通常のアプリ起動）。
fn parse_render_cli() -> Option<RenderArgs> {
    let argv: Vec<String> = std::env::args().collect();
    if !argv.iter().any(|a| a == "--render-frames") {
        return None;
    }
    let mut template_path: Option<String> = None;
    let mut times_raw: Option<String> = None;
    let mut out_dir: Option<String> = None;
    let mut width: Option<u32> = None;
    let mut height: Option<u32> = None;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--template" => {
                template_path = argv.get(i + 1).cloned();
                i += 1;
            }
            "--times" => {
                times_raw = argv.get(i + 1).cloned();
                i += 1;
            }
            "--out" => {
                out_dir = argv.get(i + 1).cloned();
                i += 1;
            }
            "--width" => {
                width = argv.get(i + 1).and_then(|s| s.parse::<u32>().ok());
                i += 1;
            }
            "--height" => {
                height = argv.get(i + 1).and_then(|s| s.parse::<u32>().ok());
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    // テンプレ読み込み（失敗時は空文字 → renderEntry 側で JSON.parse が throw → exit 1）
    let template_json = template_path
        .as_deref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let times: Vec<f64> = times_raw
        .as_deref()
        .map(|s| {
            s.split(',')
                .filter_map(|x| x.trim().parse::<f64>().ok())
                .collect()
        })
        .unwrap_or_default();
    Some(RenderArgs {
        template_json,
        times,
        out_dir: out_dir.unwrap_or_default(),
        width,
        height,
    })
}

/// renderEntry（render.html）が起動直後に呼ぶ。描画すべき引数を返す。
#[tauri::command]
fn get_render_args(state: tauri::State<RenderState>) -> Option<RenderArgs> {
    state.0.clone()
}

/// renderEntry が 1 フレーム分の PNG を base64 で渡してくる。out_dir に保存して絶対パスを返す。
#[tauri::command]
fn save_render_frame_png(
    out_dir: String,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&out_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir out: {e}"))?;
    let path = dir.join(format!("{}.png", filename));
    let bytes = general_purpose::STANDARD
        .decode(base64_data.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("write png: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// renderEntry が全フレーム完了（or 失敗）したら呼ぶ。manifest.json を書いてプロセスを終了する。
/// ok=true → exit 0 / ok=false → exit 1。node ラッパーは manifest.json を読んで stdout に流す。
#[tauri::command]
fn finish_render(app: tauri::AppHandle, out_dir: String, manifest_json: String, ok: bool) {
    if !out_dir.is_empty() {
        let dir = PathBuf::from(&out_dir);
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("manifest.json"), &manifest_json);
    }
    app.exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let render_args = parse_render_cli();
    let is_render_mode = render_args.is_some();
    tauri::Builder::default()
        .manage(VoicevoxChild(Mutex::new(None)))
        .manage(RenderState(render_args))
        .setup(move |app| {
            if is_render_mode {
                // ヘッドレス描画モード: 編集 UI は出さず、非表示の render.html ウィンドウだけ作る。
                // 先に render ウィンドウを作ってから main を閉じる（ウィンドウ 0 個での自動終了を避ける）。
                tauri::WebviewWindowBuilder::new(
                    app,
                    "render",
                    tauri::WebviewUrl::App("render.html".into()),
                )
                .visible(false)
                .build()?;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
                return Ok(());
            }
            // 通常起動: config の main ウィンドウは visible:false で作られるのでここで表示する。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            if !is_voicevox_running() {
                if let Some(exe) = find_voicevox() {
                    if let Ok(child) = hidden_cmd(&exe).spawn() {
                        if let Ok(mut guard) = app.state::<VoicevoxChild>().0.lock() {
                            *guard = Some(child);
                        }
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Ok(mut guard) = window.app_handle().state::<VoicevoxChild>().0.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            get_media_dir,
            download_bgm,
            save_overlay_png,
            encode_layer_animation_video,
            save_audio_base64,
            generate_tts,
            edge_tts,
            voicevox_tts,
            openai_tts,
            softalk_tts,
            get_audio_duration,
            read_voicevox_query,
            save_render_chunk,
            save_final_video,
            import_live2d_model,
            import_live2d_global,
            list_live2d_models,
            delete_live2d_model,
            update_live2d_model_meta,
            list_se_files,
            list_templates,
            save_template,
            save_template_narration,
            delete_template,
            list_presets,
            save_preset,
            delete_preset,
            pack_template_to_zip,
            unpack_template_zip,
            youtube_oauth_flow,
            import_asset,
            save_template_asset_base64,
            delete_template_assets,
            rename_template_assets,
            migrate_legacy_audio_dirs,
            list_template_assets,
            delete_template_asset,
            get_render_args,
            save_render_frame_png,
            finish_render,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
