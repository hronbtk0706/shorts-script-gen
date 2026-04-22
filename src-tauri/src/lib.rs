use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

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

/// 書き出し中の FFmpeg プロセスをキャンセル可能にするための共有状態。
#[derive(Default)]
pub struct ExportCancelState {
    cancelled: AtomicBool,
    current_child: Mutex<Option<Child>>,
    session_id: Mutex<Option<String>>,
}

impl ExportCancelState {
    fn begin(&self, session_id: String) {
        self.cancelled.store(false, Ordering::SeqCst);
        *self.session_id.lock().unwrap() = Some(session_id);
    }
    fn end(&self) {
        *self.session_id.lock().unwrap() = None;
        *self.current_child.lock().unwrap() = None;
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    fn trigger_cancel(&self) -> Option<String> {
        self.cancelled.store(true, Ordering::SeqCst);
        let mut guard = self.current_child.lock().unwrap();
        if let Some(c) = guard.as_mut() {
            let _ = c.kill();
        }
        self.session_id.lock().unwrap().clone()
    }
}

/// FFmpeg を呼ぶ共通ヘルパー。cancelled が立っていたら即 Err、
/// spawn 後は child を state に登録して外部から kill 可能にする。
fn run_ffmpeg_cancellable(
    mut cmd: Command,
    state: &ExportCancelState,
) -> Result<std::process::Output, String> {
    if state.is_cancelled() {
        return Err("cancelled".into());
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("spawn: {}", e))?;
    *state.current_child.lock().unwrap() = Some(child);

    // try_wait ベースのポーリング（50ms）
    loop {
        if state.is_cancelled() {
            // kill 済みのはずだが念のため
            if let Some(c) = state.current_child.lock().unwrap().as_mut() {
                let _ = c.kill();
            }
            let _ = state.current_child.lock().unwrap().take();
            return Err("cancelled".into());
        }
        let exited: bool = {
            let mut guard = state.current_child.lock().unwrap();
            match guard.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(_status)) => true,
                    Ok(None) => false,
                    Err(e) => return Err(format!("try_wait: {}", e)),
                },
                None => return Err("child removed unexpectedly".into()),
            }
        };
        if exited {
            let child = state
                .current_child
                .lock()
                .unwrap()
                .take()
                .ok_or("child already taken")?;
            let output = child
                .wait_with_output()
                .map_err(|e| format!("wait_with_output: {}", e))?;
            if state.is_cancelled() {
                return Err("cancelled".into());
            }
            return Ok(output);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn clean_session_dir(app: &tauri::AppHandle, session_id: &str) -> Result<(), String> {
    let dir = session_asset_dir(app, session_id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("remove session: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn cancel_export(
    app: tauri::AppHandle,
    state: tauri::State<'_, ExportCancelState>,
) -> Result<(), String> {
    let sid = state.trigger_cancel();
    if let Some(s) = sid {
        // 書き出し中の中間ファイルをまとめて削除
        let _ = clean_session_dir(&app, &s);
    }
    Ok(())
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
    std::fs::write(&path, json).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
fn delete_template(id: String) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid template id".into());
    }
    let path = templates_dir().join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
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


fn default_anim_duration() -> f64 {
    0.3
}

/// ==== 新方式（レイヤーのみ 1 本合成）の入力型 ====
/// テンプレートの各レイヤーを、シーン分割を経由せずに直接 overlay で積むための入力。
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateLayerInput {
    /// "static" = 事前に w_px × h_px の透明 PNG に焼き込み済み（image/text/color/shape/comment）
    /// "video"  = 動画ファイル。Rust 側で w_px × h_px にスケール
    pub kind: String,
    pub path: String,
    /// ピクセル座標（1080x1920 基準、レイヤー左上）
    pub x_px: i32,
    pub y_px: i32,
    pub w_px: i32,
    pub h_px: i32,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub z_index: i32,
    /// グローバル時刻（動画の 0 秒目からの表示開始）
    pub start_sec: f64,
    /// グローバル時刻（表示終了）
    pub end_sec: f64,
    #[serde(default)]
    pub entry_animation: String,
    #[serde(default = "default_anim_duration")]
    pub entry_duration: f64,
    #[serde(default)]
    pub exit_animation: String,
    #[serde(default = "default_anim_duration")]
    pub exit_duration: f64,
    /// video 用: 素材が短いときにループするか
    #[serde(default = "default_video_loop")]
    pub video_loop: bool,
    /// キーフレームアニメーション（任意）。トラック単位で x/y/scale/opacity/rotation を時刻依存に補間。
    #[serde(default)]
    pub keyframes: LayerKeyframesInput,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct KeyframeInput {
    pub time: f64,
    pub value: f64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct KeyframeTrackInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub frames: Vec<KeyframeInput>,
}

#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayerKeyframesInput {
    #[serde(default)]
    pub x: Option<KeyframeTrackInput>,
    #[serde(default)]
    pub y: Option<KeyframeTrackInput>,
    #[serde(default)]
    pub scale: Option<KeyframeTrackInput>,
    #[serde(default)]
    pub opacity: Option<KeyframeTrackInput>,
    #[serde(default)]
    pub rotation: Option<KeyframeTrackInput>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TemplateAudioInput {
    pub path: String,
    pub start_sec: f64,
    pub end_sec: f64,
    #[serde(default = "default_opacity")]
    pub volume: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    #[serde(default)]
    pub audio_loop: bool,
    /// 再生速度倍率。1.0 = 等速、0.5 = 半分、2.0 = 倍速
    #[serde(default = "default_playback_rate")]
    pub playback_rate: f64,
}

fn default_playback_rate() -> f64 {
    1.0
}


fn default_video_loop() -> bool {
    true
}


fn default_opacity() -> f64 {
    1.0
}

const FPS: i32 = 30;


/// fade in/out フィルタ文字列を生成。fade が不要なら None。
/// st は動画出力の絶対時刻（t=0 からの秒）
///
/// entry/exit の animation が "fade" ならユーザー指定の duration を使用。
/// それ以外（"none" やスライド・ズーム等のアニメ指定時）でも、
/// 出現/消滅の 1 フレーム(1/FPS)だけ alpha フェードを強制挿入して、
/// enable=between の境界でレイヤーがパチッと現れる/消える「ちらつき」を防ぐ。
///
/// ただし skip_entry_fade / skip_exit_fade が true の側は fade を一切付けない。
/// シーン境界にピッタリ接して「ずっと見えっぱなし」のレイヤーにまで微弱 fade を
/// 入れると、シーン冒頭/末尾で画面全体が alpha 0→1 / 1→0 で「明滅」するため、
/// 境界接触側の fade はこのフラグで明示的に省略する。
/// キーフレームトラックから ffmpeg 式の文字列を生成する。
/// トラックが無効/空/未指定なら static_value を固定式として返す（"N.NNN"）。
/// 2 点以上あれば、区間ごとに線形補間する if 式を組み立てる。
fn keyframe_expr(track: &Option<KeyframeTrackInput>, static_value: f64) -> String {
    let Some(tr) = track else {
        return format!("{:.6}", static_value);
    };
    if !tr.enabled || tr.frames.is_empty() {
        return format!("{:.6}", static_value);
    }
    let mut frames: Vec<&KeyframeInput> = tr.frames.iter().collect();
    frames.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    if frames.len() == 1 {
        return format!("{:.6}", frames[0].value);
    }
    // 最後は末尾キーフレームの値で固定
    let mut expr = format!("{:.6}", frames.last().unwrap().value);
    // 区間を後ろから組み立てる: if(lt(t, frames[i+1].time), segment(i,i+1), expr)
    for i in (0..frames.len() - 1).rev() {
        let a = frames[i];
        let b = frames[i + 1];
        let dt = (b.time - a.time).max(0.001);
        let segment = format!(
            "{:.6}+({:.6}-{:.6})*((t-{:.3})/{:.6})",
            a.value, b.value, a.value, a.time, dt
        );
        expr = format!("if(lt(t,{:.3}),{},{})", b.time, segment, expr);
    }
    // 最初のキーフレーム前は a.value で固定
    expr = format!(
        "if(lt(t,{:.3}),{:.6},{})",
        frames[0].time, frames[0].value, expr
    );
    expr
}

/// キーフレームが実際にアニメするか（enabled かつ 2 点以上）
fn keyframe_is_animating(track: &Option<KeyframeTrackInput>) -> bool {
    match track {
        Some(t) => t.enabled && t.frames.len() >= 2,
        None => false,
    }
}

fn build_fade_filter(
    entry_anim: &str,
    entry_start: f64,
    entry_dur: f64,
    exit_anim: &str,
    exit_start: f64,
    exit_dur: f64,
    skip_entry_fade: bool,
    skip_exit_fade: bool,
) -> Option<String> {
    let min_fade = 1.0 / FPS as f64;
    let mut parts: Vec<String> = Vec::new();

    // ユーザーが pop / zoom-in / slide-* 等の「動いて現れる」アニメを選んでいる場合は、
    // そのアニメ自体が登場の視覚的連続性を担っているので、追加の alpha fade は不要。
    // fade を重ねると「動きつつ透明度も変化」する二重アニメに見えてしまう。
    // → fade 強制は "none" / 未指定のときに限る。
    let entry_is_non_fade_anim = !entry_anim.is_empty()
        && entry_anim != "none"
        && entry_anim != "fade";
    let exit_is_non_fade_anim = !exit_anim.is_empty()
        && exit_anim != "none"
        && exit_anim != "fade";

    let entry_effective_dur = if skip_entry_fade {
        0.0
    } else if entry_anim == "fade" && entry_dur > 0.0 {
        entry_dur
    } else if entry_is_non_fade_anim {
        0.0
    } else {
        min_fade
    };
    if entry_effective_dur > 0.0 {
        parts.push(format!(
            "fade=t=in:st={:.3}:d={:.3}:alpha=1",
            entry_start, entry_effective_dur
        ));
    }

    let exit_effective_dur = if skip_exit_fade {
        0.0
    } else if exit_anim == "fade" && exit_dur > 0.0 {
        exit_dur
    } else if exit_is_non_fade_anim {
        0.0
    } else {
        min_fade
    };
    if exit_effective_dur > 0.0 {
        parts.push(format!(
            "fade=t=out:st={:.3}:d={:.3}:alpha=1",
            exit_start, exit_effective_dur
        ));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// 入退場 zoom-in / zoom-out / pop のスケール係数 S(t) を ffmpeg 式で生成
/// 戻り値は None（該当アニメなし）または S(t) 式（例: "if(..,.., 1)" ）
fn build_scale_anim_expr(
    entry_anim: &str,
    entry_start: f64,
    entry_dur: f64,
    exit_anim: &str,
    exit_start: f64,
    exit_dur: f64,
) -> Option<String> {
    let entry_expr: Option<String> = match entry_anim {
        "zoom-in" => {
            let s = entry_start;
            let e = entry_start + entry_dur;
            let d = entry_dur.max(0.001);
            Some(format!(
                "if(lt(t,{s:.3}),0.01,if(gt(t,{e:.3}),1,max(0.01,(t-{s:.3})/{d:.3})))",
                s = s,
                e = e,
                d = d,
            ))
        }
        "pop" => {
            // easeOutBack: 1 + c3*(p-1)^3 + c1*(p-1)^2, c1=1.70158, c3=2.70158
            let s = entry_start;
            let e = entry_start + entry_dur;
            let d = entry_dur.max(0.001);
            Some(format!(
                "if(lt(t,{s:.3}),0.01,if(gt(t,{e:.3}),1,max(0.01,1+2.70158*pow((t-{s:.3})/{d:.3}-1,3)+1.70158*pow((t-{s:.3})/{d:.3}-1,2))))",
                s = s,
                e = e,
                d = d,
            ))
        }
        _ => None,
    };

    let exit_expr: Option<String> = match exit_anim {
        "zoom-out" => {
            let s = exit_start;
            let e = exit_start + exit_dur;
            let d = exit_dur.max(0.001);
            Some(format!(
                "if(lt(t,{s:.3}),1,if(gt(t,{e:.3}),0.01,max(0.01,1-(t-{s:.3})/{d:.3})))",
                s = s,
                e = e,
                d = d,
            ))
        }
        _ => None,
    };

    match (entry_expr, exit_expr) {
        (None, None) => None,
        (Some(e), None) => Some(e),
        (None, Some(x)) => Some(x),
        (Some(e), Some(x)) => Some(format!("({})*({})", e, x)),
    }
}

/// slide 入退場用の overlay x/y 加算オフセット式（中心基準の位置式に足す用途）
/// 戻り値は (x_offset_expr, y_offset_expr)。slide なしなら ("0", "0")
fn build_slide_offset_expr(
    entry_anim: &str,
    entry_start: f64,
    entry_end: f64,
    exit_anim: &str,
    exit_start: f64,
    exit_end: f64,
    main_w: i32,
    main_h: i32,
) -> (String, String) {
    let entry_x_off = match entry_anim {
        "slide-left" => main_w as f64,
        "slide-right" => -(main_w as f64),
        _ => 0.0,
    };
    let entry_y_off = match entry_anim {
        "slide-up" => main_h as f64,
        "slide-down" => -(main_h as f64),
        _ => 0.0,
    };
    // 2x canvas width/height で exit: 要素が画面端付近にあっても確実に画外へ出す
    let exit_x_off = match exit_anim {
        "slide-left" => -(2 * main_w) as f64,
        "slide-right" => (2 * main_w) as f64,
        _ => 0.0,
    };
    let exit_y_off = match exit_anim {
        "slide-up" => -(2 * main_h) as f64,
        "slide-down" => (2 * main_h) as f64,
        _ => 0.0,
    };

    let entry_dur = (entry_end - entry_start).max(0.001);
    let exit_dur = (exit_end - exit_start).max(0.001);

    let build_axis = |entry_off: f64, exit_off: f64| -> String {
        let has_entry = entry_off.abs() > 0.01;
        let has_exit = exit_off.abs() > 0.01;
        if !has_entry && !has_exit {
            return "0".to_string();
        }
        let mut parts: Vec<String> = Vec::new();
        if has_entry {
            parts.push(format!(
                "if(between(t,{s:.3},{e:.3}),{off:.1}*(1-(t-{s:.3})/{d:.3}),0)",
                s = entry_start,
                e = entry_end,
                off = entry_off,
                d = entry_dur,
            ));
        }
        if has_exit {
            // 退場: exit_start 以前は 0、exit_start..exit_end で 0→off、exit_end 以降は off で固定
            // （0 に戻すと enable のフレーム境界で一瞬元位置に戻る flicker が起きる）
            parts.push(format!(
                "if(lt(t,{s:.3}),0,if(lt(t,{e:.3}),{off:.1}*((t-{s:.3})/{d:.3}),{off:.1}))",
                s = exit_start,
                e = exit_end,
                off = exit_off,
                d = exit_dur,
            ));
        }
        format!("({})", parts.join("+"))
    };

    (build_axis(entry_x_off, exit_x_off), build_axis(entry_y_off, exit_y_off))
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

#[tauri::command]
async fn download_image(
    app: tauri::AppHandle,
    session_id: String,
    url: String,
    filename: String,
) -> Result<String, String> {
    let dir = session_asset_dir(&app, &session_id)?;
    let img_path = dir.join(format!("{}.jpg", filename));

    let status = hidden_cmd("curl")
        .args(["-L", "-f", "-s", "-o"])
        .arg(&img_path)
        .arg(&url)
        .status()
        .map_err(|e| format!("curl failed: {}", e))?;

    if !status.success() {
        return Err(format!("Failed to download image from {}", url));
    }
    Ok(img_path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn cloudflare_generate_image(
    app: tauri::AppHandle,
    session_id: String,
    account_id: String,
    api_key: String,
    model: String,
    body_json: String,
    filename: String,
) -> Result<String, String> {
    let dir = session_asset_dir(&app, &session_id)?;
    let tmp_path = dir.join(format!("{}_cf.bin", filename));
    let out_path = dir.join(format!("{}.png", filename));

    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/ai/run/{}",
        account_id, model
    );
    let auth_header = format!("Authorization: Bearer {}", api_key);

    let output = hidden_cmd("curl")
        .args(["-s", "-S", "-L", "-X", "POST"])
        .args(["-H", &auth_header])
        .args(["-H", "Content-Type: application/json"])
        .args(["-d", &body_json])
        .arg("-o")
        .arg(&tmp_path)
        .args(["-w", "%{http_code}"])
        .arg(&url)
        .output()
        .map_err(|e| format!("curl failed: {}", e))?;

    if !output.status.success() {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!(
            "curl exited with error: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let status_code = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let body = std::fs::read(&tmp_path).map_err(|e| format!("read tmp: {}", e))?;
    let _ = std::fs::remove_file(&tmp_path);

    if status_code != "200" {
        let snippet: String = String::from_utf8_lossy(&body).chars().take(400).collect();
        return Err(format!("Cloudflare HTTP {}: {}", status_code, snippet));
    }

    let is_binary_image = body.len() > 4
        && (body.starts_with(&[0xFF, 0xD8, 0xFF])
            || body.starts_with(&[0x89, 0x50, 0x4E, 0x47]));

    let bytes: Vec<u8> = if is_binary_image {
        body
    } else {
        let text = std::str::from_utf8(&body)
            .map_err(|e| format!("utf8 decode: {}", e))?;
        let v: serde_json::Value = serde_json::from_str(text).map_err(|e| {
            let snippet: String = text.chars().take(300).collect();
            format!("json parse error: {} / body: {}", e, snippet)
        })?;
        let img_b64 = v
            .get("result")
            .and_then(|r| r.get("image"))
            .and_then(|i| i.as_str())
            .ok_or_else(|| {
                let snippet: String = text.chars().take(300).collect();
                format!("no result.image in response: {}", snippet)
            })?;
        general_purpose::STANDARD
            .decode(img_b64)
            .map_err(|e| format!("base64 decode: {}", e))?
    };

    std::fs::write(&out_path, bytes).map_err(|e| format!("write png: {}", e))?;
    Ok(out_path.to_string_lossy().into_owned())
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


/// ===========================================================================
/// compose_template_video: 新方式の動画合成
///
/// - シーン分割/セグメント/hook-body-cta を一切使わない
/// - 黒背景の上に全レイヤーを z_index 昇順で overlay
/// - 1 回の ffmpeg 呼び出しで完結
/// - motion / color / xfade は廃止（必要になったらレイヤー単位で復活可）
/// ===========================================================================
#[tauri::command]
async fn compose_template_video(
    app: tauri::AppHandle,
    state: tauri::State<'_, ExportCancelState>,
    session_id: String,
    total_duration: f64,
    layers: Vec<TemplateLayerInput>,
    audio_layers: Vec<TemplateAudioInput>,
    bgm_path: Option<String>,
    output_filename: String,
) -> Result<String, String> {
    state.begin(session_id.clone());
    let result = compose_template_video_inner(
        app.clone(),
        &state,
        session_id,
        total_duration,
        layers,
        audio_layers,
        bgm_path,
        output_filename,
    );
    state.end();
    result
}

fn compose_template_video_inner(
    app: tauri::AppHandle,
    state: &ExportCancelState,
    session_id: String,
    total_duration: f64,
    layers: Vec<TemplateLayerInput>,
    audio_layers: Vec<TemplateAudioInput>,
    bgm_path: Option<String>,
    output_filename: String,
) -> Result<String, String> {
    let base_dir = output_base_dir(&app)?;
    let asset_dir = base_dir.join(&session_id);
    std::fs::create_dir_all(&asset_dir).map_err(|e| e.to_string())?;

    // z_index 昇順に並び替え
    let mut layers_sorted = layers;
    layers_sorted.sort_by_key(|l| l.z_index);
    let n_layers = layers_sorted.len();

    let mut cmd = hidden_cmd("ffmpeg");
    cmd.arg("-y");

    // 入力 0: 黒背景
    cmd.args([
        "-f",
        "lavfi",
        "-i",
        &format!(
            "color=c=black:s=1080x1920:r={}:d={:.3}",
            FPS, total_duration
        ),
    ]);

    // 入力 1..N: 各レイヤー
    for layer in &layers_sorted {
        match layer.kind.as_str() {
            "static" => {
                cmd.args([
                    "-loop",
                    "1",
                    "-framerate",
                    &FPS.to_string(),
                    "-t",
                    &format!("{:.3}", total_duration),
                    "-i",
                ])
                    .arg(&layer.path);
            }
            "video" => {
                if layer.video_loop {
                    cmd.args(["-stream_loop", "-1"]);
                }
                cmd.args(["-i"]).arg(&layer.path);
            }
            other => {
                return Err(format!("unknown layer kind: {}", other));
            }
        }
    }

    // 入力 N+1..: オーディオレイヤー
    let audio_input_start = 1 + n_layers;
    for audio in &audio_layers {
        if audio.audio_loop {
            cmd.args(["-stream_loop", "-1"]);
        }
        cmd.args(["-i"]).arg(&audio.path);
    }

    // 入力 M+1: BGM（オプション）
    let bgm_input_idx: Option<usize> =
        bgm_path.as_ref().filter(|s| !s.is_empty()).map(|p| {
            cmd.args(["-stream_loop", "-1", "-i"]).arg(p);
            audio_input_start + audio_layers.len()
        });

    // ======== filter_complex ========
    let mut filter_parts: Vec<String> = Vec::new();

    // ----- ビデオ: 背景 → 各レイヤー overlay -----
    let mut current_bg = "[0:v]".to_string();
    for (i, layer) in layers_sorted.iter().enumerate() {
        let input_idx = 1 + i;
        let is_last = i + 1 == n_layers;
        let next_bg = if is_last {
            "[vout]".to_string()
        } else {
            format!("[vbg{}]", i)
        };
        let layer_label = format!("[lyr{}]", i);

        // レイヤーのフィルタチェーン
        let mut chain = format!("[{}:v]", input_idx);
        // video は指定サイズに cover fit + 出力 fps へ揃える（素材が 24/60fps でも 30fps CFR に）
        // static は既にサイズ確定済みなので scale 不要、framerate も入力側で 30 指定済み
        if layer.kind == "video" {
            chain.push_str(&format!(
                "scale={}:{}:force_original_aspect_ratio=increase,crop={}:{},fps={},",
                layer.w_px, layer.h_px, layer.w_px, layer.h_px, FPS
            ));
        }
        chain.push_str("format=yuva420p");

        // キーフレーム: どのプロパティが実際にアニメしているか
        let kf_x_anim = keyframe_is_animating(&layer.keyframes.x);
        let kf_y_anim = keyframe_is_animating(&layer.keyframes.y);
        let kf_scale_anim = keyframe_is_animating(&layer.keyframes.scale);
        let kf_rotation_anim = keyframe_is_animating(&layer.keyframes.rotation);

        // rotation: キーフレーム優先。なければ従来の静的回転。
        let has_rotation_static = layer.rotation.abs() > 0.01;
        if kf_rotation_anim {
            // キーフレームで時刻依存に回転（度 → ラジアン変換）。
            // 回転後に見切れないよう ow/oh は対角線長で確保。
            let r_expr = keyframe_expr(&layer.keyframes.rotation, layer.rotation);
            chain.push_str(&format!(
                ",rotate=a='({expr})*PI/180':c=0x00000000:ow='hypot(iw,ih)':oh='hypot(iw,ih)':eval=frame",
                expr = r_expr,
            ));
        } else if has_rotation_static {
            let rad = layer.rotation * std::f64::consts::PI / 180.0;
            chain.push_str(&format!(
                ",rotate=a={rad:.6}:c=0x00000000:ow=rotw({rad:.6}):oh=roth({rad:.6})",
                rad = rad,
            ));
        }

        let has_scale_anim = matches!(
            layer.entry_animation.as_str(),
            "zoom-in" | "pop"
        ) || layer.exit_animation == "zoom-out";
        let exit_start =
            (layer.end_sec - layer.exit_duration).max(layer.start_sec);

        // scale: キーフレーム優先。なければ従来のアニメ。
        if kf_scale_anim {
            let s_expr = keyframe_expr(&layer.keyframes.scale, 1.0);
            chain.push_str(&format!(
                ",scale=w='iw*({s})':h='ih*({s})':eval=frame:flags=bilinear",
                s = s_expr,
            ));
        } else if has_scale_anim {
            if let Some(s_expr) = build_scale_anim_expr(
                &layer.entry_animation,
                layer.start_sec,
                layer.entry_duration,
                &layer.exit_animation,
                exit_start,
                layer.exit_duration,
            ) {
                chain.push_str(&format!(
                    ",scale=w='iw*({s})':h='ih*({s})':eval=frame:flags=bilinear",
                    s = s_expr,
                ));
            }
        }

        // fade（境界ピッタリ接触側はスキップで明滅防止）
        let skip_entry_fade = layer.start_sec <= 0.02;
        let skip_exit_fade = layer.end_sec >= total_duration - 0.02;
        if let Some(fade) = build_fade_filter(
            &layer.entry_animation,
            layer.start_sec,
            layer.entry_duration,
            &layer.exit_animation,
            exit_start,
            layer.exit_duration,
            skip_entry_fade,
            skip_exit_fade,
        ) {
            chain.push_str(&format!(",{}", fade));
        }

        // 不透明度
        if (layer.opacity - 1.0).abs() > 0.01 {
            chain.push_str(&format!(
                ",colorchannelmixer=aa={:.3}",
                layer.opacity.clamp(0.0, 1.0)
            ));
        }

        chain.push_str(&layer_label);
        filter_parts.push(chain);

        // overlay 位置
        let has_slide = layer.entry_animation.starts_with("slide-")
            || layer.exit_animation.starts_with("slide-");
        let has_rotation_effective = kf_rotation_anim || has_rotation_static;
        let dynamic_size = kf_scale_anim || has_scale_anim || has_rotation_effective;
        let has_kf_position = kf_x_anim || kf_y_anim;
        let entry_end =
            (layer.start_sec + layer.entry_duration).min(layer.end_sec);

        // キーフレーム x/y が動くときは、そっちを基本位置として使う（% → px 変換）。
        // 動かない軸は layer.x_px / layer.y_px を使う。
        let kf_x_px_expr: String = if kf_x_anim {
            let pct_static = layer.x_px as f64 * 100.0 / 1080.0;
            let pct_expr = keyframe_expr(&layer.keyframes.x, pct_static);
            format!("({})*{:.4}", pct_expr, 1080.0 / 100.0)
        } else {
            format!("{}", layer.x_px)
        };
        let kf_y_px_expr: String = if kf_y_anim {
            let pct_static = layer.y_px as f64 * 100.0 / 1920.0;
            let pct_expr = keyframe_expr(&layer.keyframes.y, pct_static);
            format!("({})*{:.4}", pct_expr, 1920.0 / 100.0)
        } else {
            format!("{}", layer.y_px)
        };

        let overlay_pos = if has_kf_position {
            // キーフレームで位置指定。dynamic_size のときは中央基準に補正。
            if dynamic_size {
                let half_w = layer.w_px / 2;
                let half_h = layer.h_px / 2;
                format!(
                    "x='({xc})+{hw}-overlay_w/2':y='({yc})+{hh}-overlay_h/2':eval=frame",
                    xc = kf_x_px_expr,
                    yc = kf_y_px_expr,
                    hw = half_w,
                    hh = half_h,
                )
            } else {
                format!(
                    "x='{}':y='{}':eval=frame",
                    kf_x_px_expr, kf_y_px_expr
                )
            }
        } else if dynamic_size {
            let cx = layer.x_px + layer.w_px / 2;
            let cy = layer.y_px + layer.h_px / 2;
            let (sx, sy) = if has_slide {
                build_slide_offset_expr(
                    &layer.entry_animation,
                    layer.start_sec,
                    entry_end,
                    &layer.exit_animation,
                    exit_start,
                    layer.end_sec,
                    1080,
                    1920,
                )
            } else {
                ("0".to_string(), "0".to_string())
            };
            format!(
                "x='({cx})-overlay_w/2+{sx}':y='({cy})-overlay_h/2+{sy}':eval=frame",
                cx = cx,
                cy = cy,
                sx = sx,
                sy = sy,
            )
        } else if has_slide {
            let (sx, sy) = build_slide_offset_expr(
                &layer.entry_animation,
                layer.start_sec,
                entry_end,
                &layer.exit_animation,
                exit_start,
                layer.end_sec,
                1080,
                1920,
            );
            format!(
                "x='{}+{}':y='{}+{}':eval=frame",
                layer.x_px, sx, layer.y_px, sy,
            )
        } else {
            format!("{}:{}", layer.x_px, layer.y_px)
        };

        filter_parts.push(format!(
            "{}{}overlay={}:enable='gte(t,{:.3})*lt(t,{:.3})'{}",
            current_bg, layer_label, overlay_pos, layer.start_sec, layer.end_sec, next_bg
        ));
        current_bg = next_bg;
    }

    // レイヤー 0 個のときは背景そのまま [vout] に
    if n_layers == 0 {
        filter_parts.push("[0:v]null[vout]".to_string());
    }

    // ----- 音声: 各レイヤー + BGM を amix -----
    let mut amix_inputs: Vec<String> = Vec::new();
    for (i, audio) in audio_layers.iter().enumerate() {
        let input_idx = audio_input_start + i;
        let mut steps: Vec<String> = Vec::new();

        // 再生速度（atempo は 0.5〜100.0 対応。実用範囲は 0.5〜4.0）
        if (audio.playback_rate - 1.0).abs() > 0.01 {
            let rate = audio.playback_rate.max(0.5).min(4.0);
            steps.push(format!("atempo={:.3}", rate));
        }
        let clip_dur = (audio.end_sec - audio.start_sec).max(0.0);
        if clip_dur > 0.0 {
            steps.push(format!(
                "atrim=duration={:.3},asetpts=PTS-STARTPTS",
                clip_dur
            ));
        }
        if (audio.volume - 1.0).abs() > 0.01 {
            steps.push(format!("volume={:.3}", audio.volume.max(0.0)));
        }
        if audio.fade_in > 0.0 {
            steps.push(format!("afade=t=in:st=0:d={:.3}", audio.fade_in));
        }
        if audio.fade_out > 0.0 {
            let st = (clip_dur - audio.fade_out).max(0.0);
            steps.push(format!("afade=t=out:st={:.3}:d={:.3}", st, audio.fade_out));
        }
        let ms = (audio.start_sec * 1000.0).round() as i64;
        if ms > 0 {
            steps.push(format!("adelay={}:all=1", ms));
        }

        let label = format!("[a{}]", i);
        let chain_str = if steps.is_empty() {
            format!("[{}:a]anull{}", input_idx, label)
        } else {
            format!("[{}:a]{}{}", input_idx, steps.join(","), label)
        };
        filter_parts.push(chain_str);
        amix_inputs.push(label);
    }

    if let Some(idx) = bgm_input_idx {
        filter_parts.push(format!(
            "[{}:a]volume=0.15,aloop=loop=-1:size=2e+09[bgm]",
            idx
        ));
        amix_inputs.push("[bgm]".to_string());
    }

    let audio_map: String;
    if amix_inputs.is_empty() {
        // 音声なし → 無音トラックを生成
        filter_parts.push(format!(
            "anullsrc=r=48000:cl=stereo,atrim=duration={:.3}[aout]",
            total_duration
        ));
        audio_map = "[aout]".to_string();
    } else {
        filter_parts.push(format!(
            "{}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0[aout]",
            amix_inputs.join(""),
            amix_inputs.len(),
        ));
        audio_map = "[aout]".to_string();
    }

    let filter = filter_parts.join(";");

    eprintln!(
        "[compose_template_video] total_duration={:.3}s layers={} audio_layers={} bgm={} filter_len={}",
        total_duration,
        n_layers,
        audio_layers.len(),
        bgm_input_idx.is_some(),
        filter.len(),
    );

    cmd.args(["-filter_complex", &filter]);
    cmd.args(["-map", "[vout]", "-map", audio_map.as_str()]);
    cmd.args([
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-pix_fmt",
        "yuv420p",
        "-r",
        &FPS.to_string(),
        "-fps_mode",
        "cfr",
        "-g",
        &(FPS * 2).to_string(),
        "-movflags",
        "+faststart",
        "-t",
        &format!("{:.3}", total_duration),
    ]);

    let output_path = base_dir.join(&output_filename);
    cmd.arg(&output_path);

    let output = run_ffmpeg_cancellable(cmd, state)
        .map_err(|e| format!("ffmpeg compose_template: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr
            .lines()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!("ffmpeg compose_template failed:\n{}", tail));
    }

    Ok(output_path.to_string_lossy().into_owned())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(VoicevoxChild(Mutex::new(None)))
        .manage(ExportCancelState::default())
        .setup(|app| {
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
            download_image,
            download_bgm,
            cloudflare_generate_image,
            save_overlay_png,
            save_audio_base64,
            generate_tts,
            edge_tts,
            voicevox_tts,
            openai_tts,
            softalk_tts,
            get_audio_duration,
            compose_template_video,
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
            cancel_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
