use std::collections::HashMap;
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
///
/// 重要: stdout/stderr は piped にした上で **バックグラウンドスレッドで継続ドレイン** する。
/// これをやらないと Windows の小さい pipe buffer（既定 ~4KB）が満杯になった瞬間に
/// ffmpeg が次の stderr write でブロックし、CPU 0.1% / mp4 サイズ停滞という典型的
/// な「ハング」になる（167 movie ソースの init や毎秒数行の進捗ログだけで秒〜数分
/// で満杯になる）。スレッドで read_to_end しておけば終了時に collected Vec を
/// `Output.stderr` として返せるので、エラー時のメッセージも従来通り取得できる。
///
/// progress: Some((app, total_duration_sec)) を渡すと stderr の `time=HH:MM:SS.MS`
/// 行を拾って `ffmpeg-progress` イベント（payload: 0.0〜1.0 の f64 比率）を emit する。
fn run_ffmpeg_cancellable(
    mut cmd: Command,
    state: &ExportCancelState,
    progress: Option<(tauri::AppHandle, f64)>,
) -> Result<std::process::Output, String> {
    use std::io::Read;
    use tauri::Emitter;
    if state.is_cancelled() {
        return Err("cancelled".into());
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("spawn: {}", e))?;

    // 走行中ドレイン: child から stdout/stderr を奪い、専用スレッドで EOF まで読み続ける。
    // ffmpeg 終了で pipe が close され read_to_end が返り、join() で回収できる。
    let mut stdout_pipe = child.stdout.take().ok_or("stdout already taken")?;
    let mut stderr_pipe = child.stderr.take().ok_or("stderr already taken")?;
    let stdout_handle = std::thread::Builder::new()
        .name("ffmpeg-stdout-drain".into())
        .spawn(move || {
            let mut buf: Vec<u8> = Vec::with_capacity(4096);
            let _ = stdout_pipe.read_to_end(&mut buf);
            buf
        })
        .map_err(|e| format!("stdout drain thread spawn: {e}"))?;
    let progress_for_stderr = progress.clone();
    let stderr_handle = std::thread::Builder::new()
        .name("ffmpeg-stderr-drain".into())
        .spawn(move || {
            // ffmpeg は進捗を CR で上書き出力するので、\n と \r 両方を区切り扱いする。
            // 区切りごとに line_buf を解析 → progress 設定時は ffmpeg-progress を emit。
            let mut all: Vec<u8> = Vec::with_capacity(8192);
            let mut line_buf: Vec<u8> = Vec::with_capacity(256);
            let mut chunk = [0u8; 1024];
            let mut last_emit = std::time::Instant::now()
                - std::time::Duration::from_secs(1);
            loop {
                match stderr_pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => {
                        all.extend_from_slice(&chunk[..n]);
                        for &b in &chunk[..n] {
                            if b == b'\n' || b == b'\r' {
                                if !line_buf.is_empty() {
                                    if let Some((app, total)) = progress_for_stderr.as_ref() {
                                        if *total > 0.0
                                            && last_emit.elapsed().as_millis() >= 200
                                        {
                                            if let Ok(s) = std::str::from_utf8(&line_buf) {
                                                if let Some(t) = parse_ffmpeg_time(s) {
                                                    let r = (t / total).clamp(0.0, 1.0);
                                                    let _ = app.emit("ffmpeg-progress", r);
                                                    last_emit = std::time::Instant::now();
                                                }
                                            }
                                        }
                                    }
                                    line_buf.clear();
                                }
                            } else {
                                line_buf.push(b);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            all
        })
        .map_err(|e| format!("stderr drain thread spawn: {e}"))?;

    *state.current_child.lock().unwrap() = Some(child);

    // try_wait ベースのポーリング（50ms）
    loop {
        if state.is_cancelled() {
            // kill 済みのはずだが念のため
            if let Some(c) = state.current_child.lock().unwrap().as_mut() {
                let _ = c.kill();
            }
            let _ = state.current_child.lock().unwrap().take();
            // ドレインスレッドの後始末（kill 後 pipe close → 早期 join）
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            return Err("cancelled".into());
        }
        let status_opt: Option<std::process::ExitStatus> = {
            let mut guard = state.current_child.lock().unwrap();
            match guard.as_mut() {
                Some(c) => c.try_wait().map_err(|e| format!("try_wait: {}", e))?,
                None => return Err("child removed unexpectedly".into()),
            }
        };
        if let Some(status) = status_opt {
            // child を state から外す（drop で resource 解放）
            let _ = state.current_child.lock().unwrap().take();
            if state.is_cancelled() {
                let _ = stdout_handle.join();
                let _ = stderr_handle.join();
                return Err("cancelled".into());
            }
            let stdout = stdout_handle.join().unwrap_or_default();
            let stderr = stderr_handle.join().unwrap_or_default();
            return Ok(std::process::Output {
                status,
                stdout,
                stderr,
            });
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


fn default_anim_duration() -> f64 {
    0.3
}

fn default_ambient_intensity() -> f64 {
    1.0
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
    #[serde(default)]
    pub ambient_animation: String,
    #[serde(default = "default_ambient_intensity")]
    pub ambient_intensity: f64,
    /// video 用: 素材が短いときにループするか
    #[serde(default = "default_video_loop")]
    pub video_loop: bool,
    /// video 用: 再生速度倍率。1.0 = 等速、0.5 = 半分、2.0 = 倍速
    #[serde(default = "default_playback_rate")]
    pub playback_rate: f64,
    /// クロップ（素材に対する % 値）。x+width/y+height が 100 を超えない範囲
    #[serde(default)]
    pub crop: Option<CropInput>,
    /// キーフレームアニメーション（任意）。トラック単位で x/y/scale/opacity/rotation を時刻依存に補間。
    #[serde(default)]
    pub keyframes: LayerKeyframesInput,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CropInput {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
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

    // プレビュー側で `opacity *= e` を適用しているアニメは、エクスポートでも fade を重ねる。
    // それ以外（pop / zoom-in / zoom-out / slide-* 等）は動きで登場/退場するので
    // 追加の alpha fade は不要（重ねると動きながら透明度が変わる二重アニメに見える）。
    // blur-in / blur-out は ffmpeg で時間依存の gblur が出来ないため、fade で代替する。
    let entry_has_fade_component = matches!(
        entry_anim,
        "fade" | "blur-in" | "elastic-pop" | "flip-in" | "stretch-in" | "roll-in"
    );
    let exit_has_fade_component = matches!(
        exit_anim,
        "fade" | "blur-out" | "flip-out" | "stretch-out" | "roll-out"
    );
    let entry_is_non_fade_anim = !entry_anim.is_empty()
        && entry_anim != "none"
        && !entry_has_fade_component;
    let exit_is_non_fade_anim = !exit_anim.is_empty()
        && exit_anim != "none"
        && !exit_has_fade_component;

    let entry_effective_dur = if skip_entry_fade {
        0.0
    } else if entry_has_fade_component && entry_dur > 0.0 {
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
    } else if exit_has_fade_component && exit_dur > 0.0 {
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

/// あるアニメ名がスケールアニメとして扱われるかを判定
fn anim_uses_scale(entry_anim: &str, exit_anim: &str) -> bool {
    matches!(
        entry_anim,
        "zoom-in" | "pop" | "elastic-pop" | "stretch-in" | "flip-in"
    ) || matches!(exit_anim, "zoom-out" | "stretch-out" | "flip-out")
}

/// 入退場のスケールアニメを ffmpeg 式 (sx, sy) で生成。
/// stretch-in / stretch-out / flip-in / flip-out は X 軸のみアニメ（Y は 1.0 固定）。
/// 該当アニメが無ければ None。
fn build_scale_anim_expr(
    entry_anim: &str,
    entry_start: f64,
    entry_dur: f64,
    exit_anim: &str,
    exit_start: f64,
    exit_dur: f64,
) -> Option<(String, String)> {
    // entry: 各アニメの (sx_expr, sy_expr) を返す。スケールしない軸は None（後で 1.0 にする）
    let (entry_sx, entry_sy): (Option<String>, Option<String>) = match entry_anim {
        "zoom-in" => {
            let s = entry_start;
            let e = entry_start + entry_dur;
            let d = entry_dur.max(0.001);
            let expr = format!(
                "if(lt(t,{s:.3}),0.01,if(gt(t,{e:.3}),1,max(0.01,(t-{s:.3})/{d:.3})))",
                s = s, e = e, d = d,
            );
            (Some(expr.clone()), Some(expr))
        }
        "pop" => {
            // easeOutBack: 1 + c3*(p-1)^3 + c1*(p-1)^2, c1=1.70158, c3=2.70158
            let s = entry_start;
            let e = entry_start + entry_dur;
            let d = entry_dur.max(0.001);
            let expr = format!(
                "if(lt(t,{s:.3}),0.01,if(gt(t,{e:.3}),1,max(0.01,1+2.70158*pow((t-{s:.3})/{d:.3}-1,3)+1.70158*pow((t-{s:.3})/{d:.3}-1,2))))",
                s = s, e = e, d = d,
            );
            (Some(expr.clone()), Some(expr))
        }
        "elastic-pop" => {
            // easeOutElastic: 2^(-10p) * sin((p*10 - 0.75) * 2π/3) + 1
            let s = entry_start;
            let e = entry_start + entry_dur;
            let d = entry_dur.max(0.001);
            let expr = format!(
                "if(lt(t,{s:.3}),0.01,if(gt(t,{e:.3}),1,max(0.01,1+pow(2,-10*(t-{s:.3})/{d:.3})*sin(((t-{s:.3})/{d:.3}*10-0.75)*2.0944))))",
                s = s, e = e, d = d,
            );
            (Some(expr.clone()), Some(expr))
        }
        "stretch-in" | "flip-in" => {
            // scaleX 0→1 (ease-out: e = 1-(1-p)^2)。flip-in は 3D を 2D scaleX で近似。
            let s = entry_start;
            let e = entry_start + entry_dur;
            let d = entry_dur.max(0.001);
            let expr = format!(
                "if(lt(t,{s:.3}),0.01,if(gt(t,{e:.3}),1,max(0.01,1-pow(1-(t-{s:.3})/{d:.3},2))))",
                s = s, e = e, d = d,
            );
            (Some(expr), None)
        }
        _ => (None, None),
    };

    let (exit_sx, exit_sy): (Option<String>, Option<String>) = match exit_anim {
        "zoom-out" => {
            let s = exit_start;
            let e = exit_start + exit_dur;
            let d = exit_dur.max(0.001);
            let expr = format!(
                "if(lt(t,{s:.3}),1,if(gt(t,{e:.3}),0.01,max(0.01,1-(t-{s:.3})/{d:.3})))",
                s = s, e = e, d = d,
            );
            (Some(expr.clone()), Some(expr))
        }
        "stretch-out" | "flip-out" => {
            // scaleX 1→0 (ease-in: e = p^2)
            let s = exit_start;
            let e = exit_start + exit_dur;
            let d = exit_dur.max(0.001);
            let expr = format!(
                "if(lt(t,{s:.3}),1,if(gt(t,{e:.3}),0.01,max(0.01,1-pow((t-{s:.3})/{d:.3},2))))",
                s = s, e = e, d = d,
            );
            (Some(expr), None)
        }
        _ => (None, None),
    };

    fn combine(entry: Option<String>, exit: Option<String>) -> Option<String> {
        match (entry, exit) {
            (None, None) => None,
            (Some(e), None) => Some(e),
            (None, Some(x)) => Some(x),
            (Some(e), Some(x)) => Some(format!("({})*({})", e, x)),
        }
    }

    let sx = combine(entry_sx, exit_sx);
    let sy = combine(entry_sy, exit_sy);

    if sx.is_none() && sy.is_none() {
        None
    } else {
        Some((
            sx.unwrap_or_else(|| "1".to_string()),
            sy.unwrap_or_else(|| "1".to_string()),
        ))
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
    // roll-in は左から登場 (preview の translateX(-100%) → 0 と同じ向き)。
    // roll-out は右へ退場 (preview の translateX(0) → 100% と同じ向き)。
    let entry_x_off = match entry_anim {
        "slide-left" => main_w as f64,
        "slide-right" | "roll-in" => -(main_w as f64),
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
        "slide-right" | "roll-out" => (2 * main_w) as f64,
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

// ===== Ambient（表示中ずっと続くアニメ）helpers =====
// preview の computeLayerAmbientStyle (TemplateCanvas.tsx) と同じ式を ffmpeg 側で再現する。
// k は ambientIntensity (0..2)。

fn ambient_k(intensity: f64) -> f64 {
    intensity.max(0.0).min(2.0)
}

/// shake / bounce / float の overlay xy 加算量。preview の px は 360 幅基準なので canvas 幅で換算。
fn build_ambient_translate(
    ambient: &str,
    intensity: f64,
    canvas_width: i32,
) -> (String, String) {
    let k = ambient_k(intensity);
    if k.abs() < 0.001 {
        return ("0".to_string(), "0".to_string());
    }
    let px_scale = canvas_width as f64 / 360.0; // 縦 1080 → 3.0、横 1920 → 5.33
    match ambient {
        "shake" => (
            format!("(sin(t*30)*{:.4})", 2.0 * k * px_scale),
            format!("(cos(t*33)*{:.4})", 1.5 * k * px_scale),
        ),
        "bounce" => (
            "0".to_string(),
            format!("(-abs(sin(t*2*PI))*{:.4})", 4.0 * k * px_scale),
        ),
        "float" => (
            "0".to_string(),
            format!("(sin(t*PI)*{:.4})", 3.0 * k * px_scale),
        ),
        _ => ("0".to_string(), "0".to_string()),
    }
}

/// pulse の scale 倍率式（既存 scale 式に乗算する）。
fn build_ambient_scale_factor(ambient: &str, intensity: f64) -> Option<String> {
    let k = ambient_k(intensity);
    if k.abs() < 0.001 || ambient != "pulse" {
        return None;
    }
    Some(format!("(1+0.05*{:.4}*sin(t*2*PI))", k))
}

/// wiggle の rotation 度数式（既存 rotation 度数に加算する）。
fn build_ambient_rotation_deg(ambient: &str, intensity: f64) -> Option<String> {
    let k = ambient_k(intensity);
    if k.abs() < 0.001 || ambient != "wiggle" {
        return None;
    }
    Some(format!("(sin(t*2*PI)*{:.4})", 2.0 * k))
}

/// rainbow の hue フィルタ。preview の hue-rotate(t*60deg) を `hue=h='60*t'` で再現。
fn build_ambient_color_filter(ambient: &str) -> Option<String> {
    if ambient != "rainbow" {
        return None;
    }
    Some("hue=h='60*t':eval=frame".to_string())
}

/// blink の alpha 切替フィルタ（geq）。preview: sin(t*PI*4) > 0 ? 1 : 0.3+0.7*(1-k)
/// 入力は format=yuva420p の YUV+alpha なので lum/cb/cr は素通し、a だけ切替える。
fn build_ambient_alpha_filter(ambient: &str, intensity: f64) -> Option<String> {
    if ambient != "blink" {
        return None;
    }
    let k = ambient_k(intensity);
    let low = (0.3 + 0.7 * (1.0 - k)).max(0.0).min(1.0);
    Some(format!(
        "geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(gt(sin(T*PI*4),0),alpha(X,Y),alpha(X,Y)*{:.4})'",
        low
    ))
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

/// ffmpeg の stderr 1行から `time=HH:MM:SS.MS`（または `time=HH:MM:SS.MS\s` / 行末）
/// を見つけて秒に変換して返す。見つからなければ None。
fn parse_ffmpeg_time(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    // 値部分はスペース or 末尾まで
    let end = rest.find(' ').unwrap_or(rest.len());
    let t = rest[..end].trim();
    // "N/A" のときもあるのでスキップ
    if t.is_empty() || t == "N/A" {
        return None;
    }
    let parts: Vec<&str> = t.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// ffmpeg の `movie=` フィルタ filename 引数用にパスをエスケープする。
/// - Windows のバックスラッシュ区切りを `/` に変換（ffmpeg は `/` を受け付ける）
/// - filtergraph は 2 段エスケープのため、ドライブの `:` は `\\:`（バックスラッシュ 2 個）
///   にしないと movie フィルタのオプション区切りと衝突して `'C'` を開こうとして失敗する
///   （Windows 実機 ffmpeg 8.1 で検証済み）。
///
/// 本アプリの static PNG は `Documents/生成動画/<session>/layer_<id>.png` に置かれ、
/// パスに `,` `;` `[` `]` `'` 等の filtergraph 特殊文字は含まれない運用なので、
/// ここでは `:` のエスケープのみ行う。
fn escape_movie_path(path: &str) -> String {
    path.replace('\\', "/").replace(':', "\\\\:")
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
    // 画質設定（省略時は標準 crf=23 / medium）
    video_crf: Option<i32>,
    video_preset: Option<String>,
    // エンコーダ選択（省略時は libx264）。"libx264" | "h264_nvenc" | "h264_qsv"
    video_encoder: Option<String>,
    // 出力解像度（省略時は縦 1080x1920・旧テンプレ互換）
    canvas_width: Option<i32>,
    canvas_height: Option<i32>,
) -> Result<String, String> {
    state.begin(session_id.clone());
    let sid_for_cleanup = session_id.clone();
    let result = compose_template_video_inner(
        app.clone(),
        &state,
        session_id,
        total_duration,
        layers,
        audio_layers,
        bgm_path,
        output_filename,
        video_crf.unwrap_or(23).clamp(0, 51),
        video_preset.unwrap_or_else(|| "medium".to_string()),
        video_encoder.unwrap_or_else(|| "libx264".to_string()),
        canvas_width.unwrap_or(1080).max(2),
        canvas_height.unwrap_or(1920).max(2),
    );
    state.end();
    // 成功時は中間 session フォルダ（layer_*.png 等）を削除してディスクを節約。
    // 失敗時はデバッグのため残す（PNG・filter ファイル・cmd_args ログから原因追跡できる）。
    // cancel 時は cancel_export 側で既に削除済み。
    if result.is_ok() {
        let _ = clean_session_dir(&app, &sid_for_cleanup);
    }
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
    video_crf: i32,
    video_preset: String,
    video_encoder: String,
    canvas_width: i32,
    canvas_height: i32,
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
            "color=c=black:s={}x{}:r={}:d={:.3}",
            canvas_width, canvas_height, FPS, total_duration
        ),
    ]);

    // 入力 1..N: video レイヤーのみ -i で追加（同じ video が複数 chunk で背景に使われると
    // -i が重複して argv 肥大化するので パス + loop で dedup）。
    //
    // static レイヤー（image/comment/text/color/shape を焼いた PNG）は -i に追加しない。
    // 各 static は filter チェーン内の movie= 源で直接ファイルを読む（vis_layer_to_idx = None）。
    // 理由: 数百個の static の長い絶対パスが `-loop 1 -framerate 30 -t XX -i <path>` として
    // argv に並ぶと、Windows の CreateProcess 32767 char 制限を超えて spawn os error 206 に
    // なる。movie= で読めばパスは（8KB 超で）ファイル経由になる filter_complex_script 側へ
    // 移り、argv からは消える。PNG 自体は不変なのでプレビューとの一致は保たれる。
    let mut vis_input_to_idx: HashMap<(String, bool), usize> = HashMap::new();
    let mut vis_layer_to_idx: Vec<Option<usize>> = Vec::with_capacity(n_layers);
    let mut next_input_idx: usize = 1; // 0 は黒背景
    let mut static_count: usize = 0;

    for layer in &layers_sorted {
        match layer.kind.as_str() {
            "static" => {
                // 入力には追加しない。filter チェーンで movie= から読む。
                static_count += 1;
                vis_layer_to_idx.push(None);
            }
            "video" => {
                // ループ可否は呼び出し元（curio-gen の timeline_export 等）が
                // layer.video_loop で指定する。curio-gen はループ感を避けるため
                // playbackRate で尺合わせする設計（videoLoop=False が標準）。
                // ループ要望時のみ stream_loop -1 を付与。
                let key = (layer.path.clone(), layer.video_loop);
                let idx = if let Some(&existing) = vis_input_to_idx.get(&key) {
                    existing
                } else {
                    let new_idx = next_input_idx;
                    next_input_idx += 1;
                    if layer.video_loop {
                        cmd.args(["-stream_loop", "-1"]);
                    }
                    cmd.args(["-i"]).arg(&layer.path);
                    vis_input_to_idx.insert(key, new_idx);
                    new_idx
                };
                vis_layer_to_idx.push(Some(idx));
            }
            other => {
                return Err(format!("unknown layer kind: {}", other));
            }
        }
    }

    let total_visual_inputs = next_input_idx - 1;
    eprintln!(
        "[compose_template_video] visual inputs: layers={}, video -i inputs={}, static(movie filter)={}",
        n_layers, total_visual_inputs, static_count,
    );

    // 入力 N+1..: オーディオレイヤー（同じ wav が複数 chunk で参照されることは少ないが
    // 念のため同じパス + loop で dedup）
    let audio_input_start = 1 + total_visual_inputs;
    let mut audio_input_to_idx: HashMap<(String, bool), usize> = HashMap::new();
    let mut audio_layer_to_idx: Vec<usize> = Vec::with_capacity(audio_layers.len());
    let mut next_audio_idx: usize = audio_input_start;
    for audio in &audio_layers {
        let key = (audio.path.clone(), audio.audio_loop);
        let idx = if let Some(&existing) = audio_input_to_idx.get(&key) {
            existing
        } else {
            let new_idx = next_audio_idx;
            next_audio_idx += 1;
            if audio.audio_loop {
                cmd.args(["-stream_loop", "-1"]);
            }
            cmd.args(["-i"]).arg(&audio.path);
            audio_input_to_idx.insert(key, new_idx);
            new_idx
        };
        audio_layer_to_idx.push(idx);
    }

    // 入力 M+1: BGM（オプション）
    let bgm_input_idx: Option<usize> =
        bgm_path.as_ref().filter(|s| !s.is_empty()).map(|p| {
            cmd.args(["-stream_loop", "-1", "-i"]).arg(p);
            next_audio_idx
        });

    // ======== filter_complex ========
    let mut filter_parts: Vec<String> = Vec::new();

    // 各レイヤーごとに、後段で overlay チェーンを組むのに必要な情報を集める。
    // overlay チェーン構造（直列 or グループ並列）は最終ループで決める。
    struct LayerOverlay {
        label: String,
        pos: String,
        start_sec: f64,
        end_sec: f64,
    }
    let mut overlays: Vec<LayerOverlay> = Vec::with_capacity(n_layers);

    // ----- ビデオ: 各レイヤーの per-layer chain を構築 -----
    for (i, layer) in layers_sorted.iter().enumerate() {
        let input_idx = vis_layer_to_idx[i];
        let layer_label = format!("[lyr{}]", i);

        // レイヤーのフィルタチェーン。
        // video は -i で追加済みの入力 [idx:v] を起点にする。
        // static は入力を持たず、movie= でファイルから読む。movie 内蔵 loop=0 は
        // ffmpeg が終了しなくなるため使わず、standalone loop フィルタ(infinite) +
        // trim=duration で尺を区切る（これで EOF が伝播し正常終了する）。fps で 30 CFR
        // に揃え、setpts で PTS を 0 起点へ。これは旧 `-loop 1 -framerate 30 -t XX` と等価。
        //
        // trim=duration はレイヤーごとに **end_sec + 0.5秒（境界マージン）** で区切る。
        // end_sec 以降は overlay 側の enable=0 で合成されないため、それ以上のフレームを
        // 生成しても捨てるだけで filtergraph CPU の無駄。早く消えるレイヤーが多いと
        // 全体の filtergraph 負荷が大きく下がる。total_duration を上限にクランプ。
        let static_trim_dur = (layer.end_sec + 0.5).min(total_duration).max(0.1);
        let mut chain = match input_idx {
            Some(idx) => format!("[{}:v]", idx),
            None => format!(
                "movie={path},loop=loop=-1:size=1:start=0,fps={fps},trim=duration={dur:.3},setpts=PTS-STARTPTS,",
                path = escape_movie_path(&layer.path),
                fps = FPS,
                dur = static_trim_dur,
            ),
        };
        // video は指定サイズに cover fit + 出力 fps へ揃える（素材が 24/60fps でも 30fps CFR に）
        // static は既にサイズ確定済みなので scale 不要、framerate も入力側で 30 指定済み
        if layer.kind == "video" {
            // 入力動画の PTS を 0 基準に正規化する。
            // VFR 入力や非ゼロ開始 PTS が fps=30 フィルタのフレーム生成を乱してカクつく問題を防ぐ
            chain.push_str("setpts=PTS-STARTPTS,");
            // クロップ（素材に対する % → iw/ih 式）。scale より前に実行して表示範囲を切り抜く
            if let Some(c) = &layer.crop {
                let is_default =
                    c.x.abs() < 0.01
                        && c.y.abs() < 0.01
                        && (c.width - 100.0).abs() < 0.01
                        && (c.height - 100.0).abs() < 0.01;
                if !is_default {
                    chain.push_str(&format!(
                        "crop=iw*{:.4}:ih*{:.4}:iw*{:.4}:ih*{:.4},",
                        c.width / 100.0,
                        c.height / 100.0,
                        c.x / 100.0,
                        c.y / 100.0,
                    ));
                }
            }
            // 再生速度（1.0 以外なら setpts で PTS をスケール）。
            // クランプ下限を 0.25 → 0.05 に緩和。
            // curio-gen の timeline_export.py が「素材 < 表示尺」のとき src/target で
            // playbackRate を計算する設計のため、極端な短尺差で 0.05〜0.25 の範囲に
            // 入る値が来ることがある。0.25 で打ち切ると尺合わせが破綻して凍結する。
            // 0.05（20倍スロー）まで許容して凍結を防ぐ。
            let rate = layer.playback_rate.max(0.05).min(4.0);
            if (rate - 1.0).abs() > 0.01 {
                chain.push_str(&format!("setpts=PTS/{:.4},", rate));
            }
            // ★ 真の凍結バグ修正: layer の PTS に startSec を加算して overlay の
            // enable window と一致させる。
            //
            // overlay は PTS で frame をマッチするため、layer stream の PTS が
            // [0, target_dur] のままだと、output_t=startSec のとき overlay は
            // layer PTS=startSec のフレームを要求するが、layer stream は既に
            // EOF（または stretched src の終わり）に達していて、最後の1フレームが
            // repeat されてしまう。結果として「動画が最後のフレームで止まったまま
            // enable window の間ずっと表示される」という症状になる。
            //
            // setpts=PTS+startSec/TB で layer PTS を [startSec, startSec+target_dur] に
            // 揃えれば、output_t=startSec で layer の先頭フレームが再生される。
            // startSec=0 のレイヤーには影響なし（既存挙動と同じ）。
            if layer.start_sec.abs() > 0.001 {
                chain.push_str(&format!("setpts=PTS+{:.4}/TB,", layer.start_sec));
            }
            chain.push_str(&format!(
                "scale={}:{}:force_original_aspect_ratio=increase,crop={}:{},fps={},",
                layer.w_px, layer.h_px, layer.w_px, layer.h_px, FPS
            ));
        }
        chain.push_str("format=yuva420p");

        // ambient（表示中ずっと続くアニメ）の事前評価。
        // rainbow（hue）と blink（geq alpha）は format 直後にチェーンに挿入する。
        // pulse（scale）/ wiggle（rotation）/ shake/bounce/float（overlay xy）は後段で合算。
        if let Some(rainbow) = build_ambient_color_filter(&layer.ambient_animation) {
            chain.push_str(",");
            chain.push_str(&rainbow);
        }
        if let Some(blink) =
            build_ambient_alpha_filter(&layer.ambient_animation, layer.ambient_intensity)
        {
            chain.push_str(",");
            chain.push_str(&blink);
        }
        let amb_rot_deg =
            build_ambient_rotation_deg(&layer.ambient_animation, layer.ambient_intensity);
        let amb_scale_factor =
            build_ambient_scale_factor(&layer.ambient_animation, layer.ambient_intensity);
        let (amb_x_off, amb_y_off) =
            build_ambient_translate(&layer.ambient_animation, layer.ambient_intensity, canvas_width);
        let has_ambient_translate = amb_x_off != "0" || amb_y_off != "0";

        // キーフレーム: どのプロパティが実際にアニメしているか
        let kf_x_anim = keyframe_is_animating(&layer.keyframes.x);
        let kf_y_anim = keyframe_is_animating(&layer.keyframes.y);
        let kf_scale_anim = keyframe_is_animating(&layer.keyframes.scale);
        let kf_rotation_anim = keyframe_is_animating(&layer.keyframes.rotation);

        let exit_start =
            (layer.end_sec - layer.exit_duration).max(layer.start_sec);

        // rotation: キーフレーム + roll-in/out + wiggle ambient + 静的 layer.rotation を合算する。
        let has_rotation_static = layer.rotation.abs() > 0.01;
        let has_roll_in = layer.entry_animation == "roll-in";
        let has_roll_out = layer.exit_animation == "roll-out";
        let has_ambient_rot = amb_rot_deg.is_some();
        let has_dynamic_rotation =
            kf_rotation_anim || has_roll_in || has_roll_out || has_ambient_rot;
        if has_dynamic_rotation {
            // 度数の expression を組み立て、最後に PI/180 を掛ける。
            let base_deg = if kf_rotation_anim {
                keyframe_expr(&layer.keyframes.rotation, layer.rotation)
            } else {
                format!("{:.6}", layer.rotation)
            };
            let mut deg_parts: Vec<String> = vec![format!("({})", base_deg)];
            if has_roll_in {
                // preview: rotate((1-e)*-180), e = 1-(1-p)^2 → rot = -180 * (1-p)^2
                let s = layer.start_sec;
                let e = layer.start_sec + layer.entry_duration;
                let d = layer.entry_duration.max(0.001);
                deg_parts.push(format!(
                    "if(lt(t,{s:.3}),-180,if(gt(t,{e:.3}),0,-180*pow(1-(t-{s:.3})/{d:.3},2)))",
                    s = s, e = e, d = d
                ));
            }
            if has_roll_out {
                // preview: rotate(e*180), e = p^2 → rot = 180 * p^2
                let s = exit_start;
                let e = layer.end_sec;
                let d = layer.exit_duration.max(0.001);
                deg_parts.push(format!(
                    "if(lt(t,{s:.3}),0,if(gt(t,{e:.3}),180,180*pow((t-{s:.3})/{d:.3},2)))",
                    s = s, e = e, d = d
                ));
            }
            if let Some(wiggle) = amb_rot_deg.as_ref() {
                deg_parts.push(wiggle.clone());
            }
            let total_deg = deg_parts.join("+");
            chain.push_str(&format!(
                // rotate フィルタには `eval` option は無い（ffmpeg 8.x で reject される）。
                // 角度式が `t` を使えば自動的に毎フレーム評価される。
                ",rotate=a='({expr})*PI/180':c=0x00000000:ow='hypot(iw,ih)':oh='hypot(iw,ih)'",
                expr = total_deg,
            ));
        } else if has_rotation_static {
            let rad = layer.rotation * std::f64::consts::PI / 180.0;
            chain.push_str(&format!(
                ",rotate=a={rad:.6}:c=0x00000000:ow=rotw({rad:.6}):oh=roth({rad:.6})",
                rad = rad,
            ));
        }

        let has_entry_exit_scale_anim = anim_uses_scale(
            &layer.entry_animation,
            &layer.exit_animation,
        );
        let has_ambient_scale = amb_scale_factor.is_some();
        let has_scale_anim = has_entry_exit_scale_anim || has_ambient_scale;
        // static (PNG ループ) レイヤーで scale=eval=frame の出力サイズが毎フレーム変動すると
        // 長い overlay チェーン内で framesync が混乱して「カードが見えない」現象が出る。
        // 対策:
        //   1. scale 式を min(1, ...) でクランプして overshoot (scale > 1) を抑制
        //      （pop のバウンス感は失われるが、scale=1 までの easing は残る）
        //   2. scale 直後に pad で「元の PNG サイズに常に揃える」
        //      → overlay framesync が変動サイズに悩まなくなる
        let is_static_layer = input_idx.is_none();
        let needs_size_stabilize = is_static_layer && has_scale_anim;

        // scale: キーフレーム優先。なければ entry/exit + ambient pulse を合算。
        if kf_scale_anim {
            let mut s_expr = keyframe_expr(&layer.keyframes.scale, 1.0);
            if let Some(p) = amb_scale_factor.as_ref() {
                s_expr = format!("({})*{}", s_expr, p);
            }
            chain.push_str(&format!(
                ",scale=w='iw*({s})':h='ih*({s})':eval=frame:flags=bilinear",
                s = s_expr,
            ));
        } else if has_scale_anim {
            // entry/exit scale 式（無ければ (1, 1)）に pulse を乗算する。
            let (mut sx, mut sy) = build_scale_anim_expr(
                &layer.entry_animation,
                layer.start_sec,
                layer.entry_duration,
                &layer.exit_animation,
                exit_start,
                layer.exit_duration,
            ).unwrap_or_else(|| ("1".to_string(), "1".to_string()));
            if let Some(p) = amb_scale_factor.as_ref() {
                sx = format!("({})*{}", sx, p);
                sy = format!("({})*{}", sy, p);
            }
            // static (PNG ループ) では pad で出力サイズを固定する必要がある。
            // pop の bounce オーバーシュート (scale > 1) は pad 出力サイズを超えて
            // 負の pad x/y を生み、ffmpeg が Invalid argument で停止するため、
            // scale 式を min(1, ...) でクランプする。
            // 1 を超える瞬間の "ピョッ" としたバウンス感は失われるが、
            // 0→1 への easing 自体は維持される。ambient pulse は overshoot しない
            // 設計なのでクランプ不要。
            if needs_size_stabilize {
                sx = format!("min(1,{})", sx);
                sy = format!("min(1,{})", sy);
            }
            chain.push_str(&format!(
                ",scale=w='iw*({sx})':h='ih*({sy})':eval=frame:flags=bilinear",
                sx = sx, sy = sy,
            ));
            if needs_size_stabilize {
                // pad は scale 後の小さいフレームを元 PNG サイズ (w_px × h_px) の
                // 透明キャンバスに中央配置 → 出力フレームサイズが毎フレーム同じになる。
                chain.push_str(&format!(
                    ",pad=w={ow}:h={oh}:x='({ow}-iw)/2':y='({oh}-ih)/2':color=black@0:eval=frame",
                    ow = layer.w_px,
                    oh = layer.h_px,
                ));
            }
        }

        // fade（境界ピッタリ接触側はスキップで明滅防止）
        // - タイムラインの先頭/末尾 (黒背景に接触する側) はスキップ
        // - **隣のレイヤーがピッタリ接続している側もスキップ** (両方が 1 frame fade すると
        //   その境界で alpha 0 同士になり「一瞬何もない」コマが発生するため)
        const ADJ_TOL: f64 = 0.04;
        let has_neighbor_at_start = layers_sorted.iter().enumerate().any(|(j, other)| {
            j != i && (other.end_sec - layer.start_sec).abs() <= ADJ_TOL
        });
        let has_neighbor_at_end = layers_sorted.iter().enumerate().any(|(j, other)| {
            j != i && (other.start_sec - layer.end_sec).abs() <= ADJ_TOL
        });
        let skip_entry_fade = layer.start_sec <= 0.02 || has_neighbor_at_start;
        let skip_exit_fade =
            layer.end_sec >= total_duration - 0.02 || has_neighbor_at_end;
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
            || layer.exit_animation.starts_with("slide-")
            || has_roll_in
            || has_roll_out;
        let has_rotation_effective = has_dynamic_rotation || has_rotation_static;
        let dynamic_size = kf_scale_anim || has_scale_anim || has_rotation_effective;
        let has_kf_position = kf_x_anim || kf_y_anim;
        let entry_end =
            (layer.start_sec + layer.entry_duration).min(layer.end_sec);

        // キーフレーム x/y が動くときは、そっちを基本位置として使う（% → px 変換）。
        // 動かない軸は layer.x_px / layer.y_px を使う。
        let kf_x_px_expr: String = if kf_x_anim {
            let pct_static = layer.x_px as f64 * 100.0 / canvas_width as f64;
            let pct_expr = keyframe_expr(&layer.keyframes.x, pct_static);
            format!("({})*{:.4}", pct_expr, canvas_width as f64 / 100.0)
        } else {
            format!("{}", layer.x_px)
        };
        let kf_y_px_expr: String = if kf_y_anim {
            let pct_static = layer.y_px as f64 * 100.0 / canvas_height as f64;
            let pct_expr = keyframe_expr(&layer.keyframes.y, pct_static);
            format!("({})*{:.4}", pct_expr, canvas_height as f64 / 100.0)
        } else {
            format!("{}", layer.y_px)
        };

        let overlay_pos = if has_kf_position {
            // キーフレームで位置指定。dynamic_size のときは中央基準に補正。
            if dynamic_size {
                let half_w = layer.w_px / 2;
                let half_h = layer.h_px / 2;
                format!(
                    "x='({xc})+{hw}-overlay_w/2+{ax}':y='({yc})+{hh}-overlay_h/2+{ay}':eval=frame",
                    xc = kf_x_px_expr,
                    yc = kf_y_px_expr,
                    hw = half_w,
                    hh = half_h,
                    ax = amb_x_off,
                    ay = amb_y_off,
                )
            } else if has_ambient_translate {
                format!(
                    "x='({xc})+{ax}':y='({yc})+{ay}':eval=frame",
                    xc = kf_x_px_expr,
                    yc = kf_y_px_expr,
                    ax = amb_x_off,
                    ay = amb_y_off,
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
                    canvas_width,
                    canvas_height,
                )
            } else {
                ("0".to_string(), "0".to_string())
            };
            format!(
                "x='({cx})-overlay_w/2+{sx}+{ax}':y='({cy})-overlay_h/2+{sy}+{ay}':eval=frame",
                cx = cx,
                cy = cy,
                sx = sx,
                sy = sy,
                ax = amb_x_off,
                ay = amb_y_off,
            )
        } else if has_slide || has_ambient_translate {
            let (sx, sy) = if has_slide {
                build_slide_offset_expr(
                    &layer.entry_animation,
                    layer.start_sec,
                    entry_end,
                    &layer.exit_animation,
                    exit_start,
                    layer.end_sec,
                    canvas_width,
                    canvas_height,
                )
            } else {
                ("0".to_string(), "0".to_string())
            };
            format!(
                "x='{}+{}+{}':y='{}+{}+{}':eval=frame",
                layer.x_px, sx, amb_x_off, layer.y_px, sy, amb_y_off,
            )
        } else {
            format!("{}:{}", layer.x_px, layer.y_px)
        };

        overlays.push(LayerOverlay {
            label: layer_label,
            pos: overlay_pos,
            start_sec: layer.start_sec,
            end_sec: layer.end_sec,
        });
    }

    // ----- overlay チェーンを組む（直列 or グループ並列） -----
    // SSG_FILTER_GROUPS 環境変数で切替:
    //   1 or 未設定: 旧挙動（[0:v]→lyr0→lyr1→...→[vout] の単一直列）
    //   2,4,8 等: 指定数のグループに分けて並列合成 → 最後に [0:v] へ統合
    //
    // overlay の "over" 演算子は結合則を持つので**理論上は同じ絵**になる。
    // ただし 8bit YUVA の丸めで端の色が微差出る可能性あり。A/B 検証してから
    // default を切替える運用。デフォルトは安全に旧挙動 (1)。
    let num_groups: usize = std::env::var("SSG_FILTER_GROUPS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1)
        .min(16);

    if n_layers == 0 {
        filter_parts.push("[0:v]null[vout]".to_string());
    } else if num_groups == 1 || n_layers < num_groups * 2 {
        // 旧挙動: 単一直列チェーン
        let mut current_bg = "[0:v]".to_string();
        for (i, ov) in overlays.iter().enumerate() {
            let next_bg = if i + 1 == n_layers {
                "[vout]".to_string()
            } else {
                format!("[vbg{}]", i)
            };
            filter_parts.push(format!(
                "{}{}overlay={}:enable='gte(t,{:.3})*lt(t,{:.3})'{}",
                current_bg, ov.label, ov.pos, ov.start_sec, ov.end_sec, next_bg
            ));
            current_bg = next_bg;
        }
    } else {
        // グループ並列: 各グループを透明 bg 上で合成 → 最後に [0:v] に統合
        eprintln!(
            "[compose_template_video] filter groups={} (overlay tree-mode)",
            num_groups
        );
        let per_group = (n_layers + num_groups - 1) / num_groups;
        let mut group_labels: Vec<String> = Vec::new();

        for g in 0..num_groups {
            let start = g * per_group;
            let end = ((g + 1) * per_group).min(n_layers);
            if start >= end {
                continue;
            }
            // 透明 bg を生成（黒のアルファ 0 = 完全透過）。色情報も alpha も yuva420p で揃える
            filter_parts.push(format!(
                "color=c=black@0.0:size={}x{}:rate={}:duration={:.3},format=yuva420p[gbg{}_0]",
                canvas_width, canvas_height, FPS, total_duration, g
            ));
            // グループ内 layer を直列合成
            let mut current = format!("[gbg{}_0]", g);
            let count = end - start;
            for j in 0..count {
                let i = start + j;
                let ov = &overlays[i];
                let next = if j + 1 == count {
                    format!("[g{}]", g)
                } else {
                    format!("[gbg{}_{}]", g, j + 1)
                };
                filter_parts.push(format!(
                    "{}{}overlay={}:enable='gte(t,{:.3})*lt(t,{:.3})'{}",
                    current, ov.label, ov.pos, ov.start_sec, ov.end_sec, next
                ));
                current = next;
            }
            group_labels.push(format!("[g{}]", g));
        }

        // 最後に [0:v] に各グループを順次合成。z-index 順は維持される
        let mut current = "[0:v]".to_string();
        for (gi, g_label) in group_labels.iter().enumerate() {
            let next = if gi + 1 == group_labels.len() {
                "[vout]".to_string()
            } else {
                format!("[gout{}]", gi)
            };
            filter_parts.push(format!(
                "{}{}overlay=0:0{}",
                current, g_label, next
            ));
            current = next;
        }
    }

    // ----- 音声: 各レイヤー + BGM を amix -----
    let mut amix_inputs: Vec<String> = Vec::new();
    for (i, audio) in audio_layers.iter().enumerate() {
        let input_idx = audio_layer_to_idx[i];
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

    // Windows の CreateProcess は引数列を ~32KB に制限する。
    // 大規模テンプレ (数百レイヤー) で filter_complex がそれを超えると
    // "spawn: ファイル名または拡張子が長すぎます (os error 206)" になるので
    // 8KB を超えたら -filter_complex_script でファイル経由に切り替える。
    if filter.len() > 8192 {
        let filter_script = base_dir.join(format!(".filter_complex_{}.txt", output_filename));
        std::fs::write(&filter_script, &filter)
            .map_err(|e| format!("write filter_complex_script: {}", e))?;
        cmd.arg("-filter_complex_script");
        cmd.arg(&filter_script);
    } else {
        cmd.args(["-filter_complex", &filter]);
    }
    cmd.args(["-map", "[vout]", "-map", audio_map.as_str()]);

    // エンコーダごとに最適なパラメータを設定する。
    // libx264: 品質最高、CPU 処理で遅い
    // h264_nvenc: NVIDIA GPU、5〜10倍速い、品質ロスは小さい
    // h264_qsv: Intel 内蔵 GPU、3〜5倍速い、品質ロスは少しある
    match video_encoder.as_str() {
        "h264_nvenc" => {
            // NVENC は CRF と等価な指定として -cq を使う。preset は p1〜p7（p7 が最高品質）。
            // CRF 0..51 の値域を p7..p1 にマップせず、シンプルに p6 = 高品質寄りの固定にする。
            cmd.args([
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p6",
                "-tune",
                "hq",
                "-rc",
                "vbr",
                "-cq",
                &video_crf.to_string(),
                "-b:v",
                "0",
            ]);
        }
        "h264_qsv" => {
            // QSV は -global_quality を CRF と同じ値域で使える。
            cmd.args([
                "-c:v",
                "h264_qsv",
                "-preset",
                "slower",
                "-global_quality",
                &video_crf.to_string(),
                "-look_ahead",
                "1",
            ]);
        }
        _ => {
            // libx264 (CPU)
            cmd.args([
                "-c:v",
                "libx264",
                "-preset",
                video_preset.as_str(),
                "-crf",
                &video_crf.to_string(),
            ]);
        }
    }

    cmd.args([
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

    // Windows の CreateProcess は引数列を 32767 文字に制限する。spawn 前に診断ログを
    // ファイルに書き出し（Tauri release は console を持たないので stderr では見えない）。
    {
        let args: Vec<std::ffi::OsString> = cmd.get_args().map(|a| a.to_os_string()).collect();
        let total_len: usize = args.iter().map(|a| a.len() + 3).sum::<usize>() + 30;
        let mut report = String::new();
        report.push_str(&format!(
            "cmd args count={} estimated_len={} (Win limit=32767)\n\n",
            args.len(),
            total_len,
        ));
        let mut lens: Vec<(usize, String)> = args
            .iter()
            .map(|a| (a.len(), a.to_string_lossy().into_owned()))
            .collect();
        lens.sort_by(|a, b| b.0.cmp(&a.0));
        report.push_str("長い引数 top20:\n");
        for (l, s) in lens.iter().take(20) {
            report.push_str(&format!("  {} chars: {}\n", l, &s[..s.len().min(160)]));
        }
        report.push_str("\n全引数 (順序保存):\n");
        for (i, a) in args.iter().enumerate() {
            let s = a.to_string_lossy();
            report.push_str(&format!("  [{:3}] ({}) {}\n", i, s.len(), &s[..s.len().min(200)]));
        }
        let log_path = base_dir.join(format!(".cmd_args_{}.log", output_filename));
        let _ = std::fs::write(&log_path, &report);
    }

    let output = run_ffmpeg_cancellable(
        cmd,
        state,
        Some((app.clone(), total_duration)),
    )
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
            import_live2d_model,
            import_live2d_global,
            list_live2d_models,
            delete_live2d_model,
            update_live2d_model_meta,
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
            youtube_oauth_flow,
            import_asset,
            save_template_asset_base64,
            delete_template_assets,
            rename_template_assets,
            migrate_legacy_audio_dirs,
            list_template_assets,
            delete_template_asset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
