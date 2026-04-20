use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

fn hidden_cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
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

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct AudioClipInput {
    path: String,
    start_sec: f64,
}

/// 複数のTTS音声クリップを、それぞれのオフセットで無音ベースに重ねて1本のWAVにミックスする。
/// total_duration_sec で指定された長さに -t でトリム/パディングされる。
#[tauri::command]
async fn mix_audio_clips(
    app: tauri::AppHandle,
    session_id: String,
    filename: String,
    clips: Vec<AudioClipInput>,
    total_duration_sec: f64,
) -> Result<String, String> {
    let asset_dir = session_asset_dir(&app, &session_id)?;
    let out_path = asset_dir.join(format!("{}.wav", filename));
    let d = total_duration_sec.max(0.5);

    // クリップ無しなら無音のみ
    if clips.is_empty() {
        let output = hidden_cmd("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("anullsrc=r=44100:cl=stereo:d={:.3}", d),
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&out_path)
            .output()
            .map_err(|e| format!("ffmpeg silent: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "mix_audio_clips silent wav failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        return Ok(out_path.to_string_lossy().to_string());
    }

    // 引数構築: input0 = 無音ベース、input1.. = 各クリップ
    let mut cmd = hidden_cmd("ffmpeg");
    cmd.arg("-y");
    cmd.args([
        "-f",
        "lavfi",
        "-i",
        &format!("anullsrc=r=44100:cl=stereo:d={:.3}", d),
    ]);
    for c in &clips {
        cmd.args(["-i", &c.path]);
    }

    // filter_complex 構築
    let mut parts: Vec<String> = Vec::new();
    for (i, c) in clips.iter().enumerate() {
        let input_idx = i + 1;
        let delay_ms = (c.start_sec.max(0.0) * 1000.0) as i64;
        parts.push(format!(
            "[{}:a]adelay={ms}|{ms}[a{i}]",
            input_idx,
            ms = delay_ms,
            i = i
        ));
    }
    let mut mix_inputs = String::from("[0:a]");
    for i in 0..clips.len() {
        mix_inputs.push_str(&format!("[a{}]", i));
    }
    parts.push(format!(
        "{}amix=inputs={}:normalize=0:duration=longest[mixed]",
        mix_inputs,
        clips.len() + 1
    ));
    let filter = parts.join(";");

    cmd.args([
        "-filter_complex",
        &filter,
        "-map",
        "[mixed]",
        "-t",
        &format!("{:.3}", d),
        "-ar",
        "44100",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
    ]);
    cmd.arg(&out_path);

    let output = cmd
        .output()
        .map_err(|e| format!("ffmpeg mix: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "mix_audio_clips failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(out_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn generate_silent_wav(
    app: tauri::AppHandle,
    session_id: String,
    duration: f64,
) -> Result<String, String> {
    let asset_dir = session_asset_dir(&app, &session_id)?;
    let out_path = asset_dir.join("silent.wav");
    let d = duration.max(0.5);
    let output = hidden_cmd("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("anullsrc=r=44100:cl=stereo:d={:.3}", d),
            "-c:a",
            "pcm_s16le",
        ])
        .arg(&out_path)
        .output()
        .map_err(|e| format!("ffmpeg silent: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "silent wav failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(out_path.to_string_lossy().to_string())
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
    // .NET ticks: 100ns since 0001-01-01 UTC. Diff from UNIX epoch = 621355968000000000 ticks
    let ticks: u64 = 621_355_968_000_000_000u64 + secs * 10_000_000;
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

#[derive(Debug, Deserialize, Serialize)]
pub struct CaptionInput {
    pub png_path: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimedOverlayInput {
    pub png_path: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub entry_animation: String,
    #[serde(default = "default_anim_duration")]
    pub entry_duration: f64,
    #[serde(default)]
    pub exit_animation: String,
    #[serde(default = "default_anim_duration")]
    pub exit_duration: f64,
}

fn default_anim_duration() -> f64 {
    0.3
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SceneInput {
    pub image_path: String,
    pub audio_path: String,
    pub overlay_png_path: String,
    pub duration: f64,
    #[serde(default = "default_motion")]
    pub motion: String,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default)]
    pub audio_fade_in: bool,
    #[serde(default)]
    pub audio_fade_out: bool,
    #[serde(default = "default_transition")]
    pub transition_to_next: String,
    #[serde(default = "default_trans_dur")]
    pub transition_duration: f64,
    #[serde(default)]
    pub captions: Vec<CaptionInput>,
    #[serde(default)]
    pub audio_leading_pad: f64,
    #[serde(default)]
    pub video_layers: Vec<VideoLayerInput>,
    /// 時間ゲート付きの静止画/テキスト/図形レイヤー（透明 PNG + enable + entry/exit アニメ）
    #[serde(default)]
    pub timed_overlays: Vec<TimedOverlayInput>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoLayerInput {
    pub path: String,
    /// % of 1080 (0-100)
    pub x_pct: f64,
    /// % of 1920 (0-100)
    pub y_pct: f64,
    pub width_pct: f64,
    pub height_pct: f64,
    #[serde(default)]
    pub z_index: i32,
    #[serde(default = "default_layer_shape")]
    pub shape: String,
    /// % of smaller dim; used when shape == "rounded"
    #[serde(default)]
    pub border_radius_pct: f64,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub border_width_pct: f64,
    #[serde(default = "default_border_color")]
    pub border_color: String,
    /// シーン内相対秒。0 ならシーン先頭から表示
    #[serde(default)]
    pub start_sec: f64,
    /// シーン内相対秒。None/0/マイナスなら end まで表示（シーン終了まで）
    #[serde(default = "default_layer_end_sec")]
    pub end_sec: f64,
    #[serde(default)]
    pub entry_animation: String,
    #[serde(default = "default_anim_duration")]
    pub entry_duration: f64,
    #[serde(default)]
    pub exit_animation: String,
    #[serde(default = "default_anim_duration")]
    pub exit_duration: f64,
}

fn default_layer_end_sec() -> f64 {
    9999.0
}

fn default_layer_shape() -> String {
    "rect".to_string()
}
fn default_opacity() -> f64 {
    1.0
}
fn default_border_color() -> String {
    "white".to_string()
}

fn default_motion() -> String {
    "static".to_string()
}
fn default_color() -> String {
    "none".to_string()
}
fn default_transition() -> String {
    "fade".to_string()
}
fn default_trans_dur() -> f64 {
    0.5
}

const FPS: i32 = 30;

fn motion_and_base_filter(motion: &str, duration: f64) -> String {
    let tf = (duration * FPS as f64).ceil() as i64;
    let tf = tf.max(30);
    let base = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1";

    match motion {
        "zoom_in" => format!(
            "{base},zoompan=z='1.0+on/{tf}*0.25':d={tf}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "zoom_out" => format!(
            "{base},zoompan=z='1.25-on/{tf}*0.25':d={tf}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "pan_left" => format!(
            "{base},zoompan=z='1.15':d={tf}:x='(iw-iw/zoom)*(1-on/{tf})':y='ih/2-ih/zoom/2':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "pan_right" => format!(
            "{base},zoompan=z='1.15':d={tf}:x='(iw-iw/zoom)*(on/{tf})':y='ih/2-ih/zoom/2':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "pan_up" => format!(
            "{base},zoompan=z='1.15':d={tf}:x='iw/2-iw/zoom/2':y='(ih-ih/zoom)*(1-on/{tf})':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "pan_down" => format!(
            "{base},zoompan=z='1.15':d={tf}:x='iw/2-iw/zoom/2':y='(ih-ih/zoom)*(on/{tf})':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "ken_burns" => format!(
            "{base},zoompan=z='1.0+on/{tf}*0.12':d={tf}:x='(iw-iw/zoom)*(on/{tf}*0.4+0.3)':y='ih/2-ih/zoom/2':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "push_in" => format!(
            "{base},zoompan=z='1.0+on/{tf}*0.10':d={tf}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "zoom_punch" => format!(
            "{base},zoompan=z='1.0+min(on,9)/9*0.25':d={tf}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        "shake" => format!(
            "{base},zoompan=z='1.12':d={tf}:x='iw/2-iw/zoom/2+sin(on*0.9)*18':y='ih/2-ih/zoom/2+cos(on*1.1)*14':s=1080x1920:fps={fps}",
            base = base,
            tf = tf,
            fps = FPS
        ),
        _ => format!("{base},fps={fps}", base = base, fps = FPS),
    }
}

fn color_filter(color: &str) -> Option<&'static str> {
    match color {
        "sepia" => Some(
            "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
        ),
        "bw" => Some("hue=s=0"),
        "vintage" => Some("curves=preset=vintage"),
        "vivid" => Some("eq=saturation=1.4:contrast=1.08"),
        "cool" => Some("colorbalance=bs=0.3:bm=0.1"),
        "warm" => Some("colorbalance=rs=0.2:rm=0.1"),
        "vignette" => Some("vignette=angle=PI/5"),
        "neon" => Some(
            "eq=saturation=1.8:contrast=1.12,colorbalance=bs=0.2:gm=0.1:rs=-0.1",
        ),
        "high_contrast" => Some("eq=contrast=1.45:saturation=1.15:brightness=-0.02"),
        "soft_glow" => Some("eq=brightness=0.06:gamma=0.95:saturation=0.92:contrast=0.98"),
        "film_grain" => Some(
            "eq=saturation=0.88:contrast=1.05,noise=alls=14:allf=t+u",
        ),
        _ => None,
    }
}

fn audio_fade_filter(scene: &SceneInput) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if scene.audio_fade_in {
        parts.push("afade=t=in:st=0:d=0.5".to_string());
    }
    if scene.audio_fade_out {
        let start = (scene.duration - 0.5).max(0.0);
        parts.push(format!("afade=t=out:st={:.3}:d=0.5", start));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// fade in/out フィルタ文字列を生成。未使用なら None
/// st は動画出力の絶対時刻（t=0 からの秒）
fn build_fade_filter(
    entry_anim: &str,
    entry_start: f64,
    entry_dur: f64,
    exit_anim: &str,
    exit_start: f64,
    exit_dur: f64,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if entry_anim == "fade" && entry_dur > 0.0 {
        parts.push(format!(
            "fade=t=in:st={:.3}:d={:.3}:alpha=1",
            entry_start, entry_dur
        ));
    }
    if exit_anim == "fade" && exit_dur > 0.0 {
        parts.push(format!(
            "fade=t=out:st={:.3}:d={:.3}:alpha=1",
            exit_start, exit_dur
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

/// overlay の x/y 式を slide アニメーション用に生成。slide 以外 or animation なしなら固定値
/// x_final/y_final: 目的位置のピクセル座標
/// main_w/main_h: メイン動画サイズ（1080/1920）
fn build_slide_xy_expr(
    entry_anim: &str,
    entry_start: f64,
    entry_end: f64,
    exit_anim: &str,
    exit_start: f64,
    exit_end: f64,
    x_final: i32,
    y_final: i32,
    main_w: i32,
    main_h: i32,
) -> (String, String) {
    // 出発/到達オフセット（x_final に対する差分で表現）
    // エントリ: 開始オフセット → 0 に補間（0 で x_final）
    let entry_x_offset = match entry_anim {
        "slide-left" => main_w as f64,       // 右端から左へ入る
        "slide-right" => -(main_w as f64),   // 左端から右へ入る
        _ => 0.0,
    };
    let entry_y_offset = match entry_anim {
        "slide-up" => main_h as f64,          // 下から上へ
        "slide-down" => -(main_h as f64),     // 上から下へ
        _ => 0.0,
    };
    let exit_x_offset = match exit_anim {
        "slide-left" => -(main_w as f64),     // 左端へ出る
        "slide-right" => main_w as f64,       // 右端へ出る
        _ => 0.0,
    };
    let exit_y_offset = match exit_anim {
        "slide-up" => -(main_h as f64),       // 上へ出る
        "slide-down" => main_h as f64,        // 下へ出る
        _ => 0.0,
    };

    // 式組み立て。各軸独立に。
    //  t < entry_end:    x_final + entry_offset * (1 - (t-entry_start)/entry_dur)
    //  t > exit_start:   x_final + exit_offset * ((t-exit_start)/exit_dur)
    //  それ以外:         x_final
    let entry_dur = (entry_end - entry_start).max(0.001);
    let exit_dur = (exit_end - exit_start).max(0.001);

    let build_axis = |final_val: i32, entry_off: f64, exit_off: f64| -> String {
        let has_entry = entry_off.abs() > 0.01;
        let has_exit = exit_off.abs() > 0.01;
        if !has_entry && !has_exit {
            return format!("{}", final_val);
        }
        let mut expr = format!("{}", final_val);
        if has_entry {
            // entry 区間のオフセット: off * (1 - (t-entry_start)/entry_dur)
            expr = format!(
                "(if(between(t,{s:.3},{e:.3}),{off:.1}*(1-(t-{s:.3})/{d:.3}),0)+{base})",
                s = entry_start,
                e = entry_end,
                off = entry_off,
                d = entry_dur,
                base = expr,
            );
        }
        if has_exit {
            expr = format!(
                "(if(between(t,{s:.3},{e:.3}),{off:.1}*((t-{s:.3})/{d:.3}),0)+{base})",
                s = exit_start,
                e = exit_end,
                off = exit_off,
                d = exit_dur,
                base = expr,
            );
        }
        expr
    };

    let x_expr = build_axis(x_final, entry_x_offset, exit_x_offset);
    let y_expr = build_axis(y_final, entry_y_offset, exit_y_offset);
    (x_expr, y_expr)
}

fn normalize_transition(name: &str) -> &str {
    match name {
        "cut" | "fade" | "fadeblack" | "fadewhite" | "fadegrays" | "slideleft"
        | "slideright" | "slideup" | "slidedown" | "dissolve" | "zoomin"
        | "circleopen" | "circleclose" | "wipeleft" | "wiperight" | "wipeup"
        | "wipedown" | "pixelize" | "smoothleft" | "radial" | "hblur"
        | "squeezev" | "squeezeh" | "coverleft" | "coverright" | "coverup"
        | "coverdown" | "revealleft" | "revealright" | "revealup"
        | "revealdown" | "diagtl" | "diagtr" | "diagbl" | "diagbr" => name,
        "flash" => "fadewhite",
        _ => "fade",
    }
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

#[tauri::command]
async fn compose_video(
    app: tauri::AppHandle,
    session_id: String,
    scenes: Vec<SceneInput>,
    bgm_path: Option<String>,
    output_filename: String,
) -> Result<String, String> {
    if scenes.is_empty() {
        return Err("No scenes provided".into());
    }

    let base_dir = output_base_dir(&app)?;
    let asset_dir = session_asset_dir(&app, &session_id)?;
    let scene_videos_dir = asset_dir.join("scenes");
    std::fs::create_dir_all(&scene_videos_dir).map_err(|e| e.to_string())?;

    let mut scene_video_paths: Vec<PathBuf> = Vec::new();

    for (i, scene) in scenes.iter().enumerate() {
        let scene_mp4 = scene_videos_dir.join(format!("scene_{:02}.mp4", i));

        let motion = motion_and_base_filter(&scene.motion, scene.duration);
        let color = color_filter(&scene.color);
        // 基底（動画化した image に motion + color）
        let base_label = if scene.video_layers.is_empty() {
            "[bg]".to_string()
        } else {
            "[bg0]".to_string()
        };
        let base_chain = match color {
            Some(c) => format!("[0:v]{},{}{}", motion, c, base_label),
            None => format!("[0:v]{}{}", motion, base_label),
        };

        let mut audio_filter_steps: Vec<String> = Vec::new();
        if scene.audio_leading_pad > 0.0 {
            let ms = (scene.audio_leading_pad * 1000.0).round() as i64;
            audio_filter_steps.push(format!("adelay={}:all=1", ms));
        }
        if let Some(fade) = audio_fade_filter(scene) {
            audio_filter_steps.push(fade);
        }
        let (audio_chain, audio_map): (String, &str) = if audio_filter_steps.is_empty() {
            (String::new(), "1:a")
        } else {
            (
                format!(";[1:a]{}[a]", audio_filter_steps.join(",")),
                "[a]",
            )
        };

        let n_captions = scene.captions.len();
        let n_timed = scene.timed_overlays.len();

        // 動画レイヤーを z_index 昇順で配置
        let mut sorted_layers: Vec<&VideoLayerInput> = scene.video_layers.iter().collect();
        sorted_layers.sort_by_key(|l| l.z_index);

        // Input index: 0=image, 1=audio, 2=overlay, 3..3+caps=captions, +timed, +video_layers
        let caption_input_start = 3usize;
        let timed_overlay_input_start = 3usize + n_captions;
        let video_layer_input_start = 3usize + n_captions + n_timed;

        let mut filter_parts: Vec<String> = Vec::new();
        filter_parts.push(base_chain);

        // 動画レイヤーを順次オーバーレイ
        let mut current_bg = base_label.clone();
        for (li, layer) in sorted_layers.iter().enumerate() {
            let input_idx = video_layer_input_start + li;
            let w_px = ((1080.0_f64) * layer.width_pct / 100.0).round().max(2.0) as i32;
            let h_px = ((1920.0_f64) * layer.height_pct / 100.0).round().max(2.0) as i32;
            let x_px = ((1080.0_f64) * layer.x_pct / 100.0).round() as i32;
            let y_px = ((1920.0_f64) * layer.y_pct / 100.0).round() as i32;

            let layer_label = format!("[vl{}]", li);
            let mut chain = format!(
                "[{}:v]scale={}:{}:force_original_aspect_ratio=increase,crop={}:{},format=yuva420p",
                input_idx, w_px, h_px, w_px, h_px
            );

            // 形状マスク
            if layer.shape == "circle" {
                let r = w_px.min(h_px) / 2;
                chain.push_str(&format!(
                    ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-{}/2,Y-{}/2),{}),255,0)'",
                    w_px, h_px, r
                ));
            }

            // 不透明度
            if layer.opacity < 1.0 && layer.opacity >= 0.0 {
                chain.push_str(&format!(",colorchannelmixer=aa={:.3}", layer.opacity));
            }

            let layer_start = layer.start_sec.max(0.0);
            let layer_end = if layer.end_sec > layer_start {
                layer.end_sec.min(scene.duration)
            } else {
                scene.duration
            };

            let has_fade = layer.entry_animation == "fade"
                || layer.exit_animation == "fade";
            let has_slide = layer.entry_animation.starts_with("slide-")
                || layer.exit_animation.starts_with("slide-");

            if has_fade {
                let exit_start = (layer_end - layer.exit_duration).max(layer_start);
                if let Some(fade) = build_fade_filter(
                    &layer.entry_animation,
                    layer_start,
                    layer.entry_duration,
                    &layer.exit_animation,
                    exit_start,
                    layer.exit_duration,
                ) {
                    chain.push_str(&format!(",{}", fade));
                }
            }
            chain.push_str(&layer_label);
            filter_parts.push(chain);

            let next_bg = format!("[bg{}]", li + 1);
            let has_time_gate = layer.start_sec > 0.0
                || (layer.end_sec > 0.0 && layer.end_sec < scene.duration - 0.01);
            let enable_clause = if has_time_gate {
                format!(":enable='between(t,{:.3},{:.3})'", layer_start, layer_end)
            } else {
                String::new()
            };

            let overlay_pos = if has_slide {
                let entry_end = (layer_start + layer.entry_duration).min(layer_end);
                let exit_start = (layer_end - layer.exit_duration).max(layer_start);
                let (x_expr, y_expr) = build_slide_xy_expr(
                    &layer.entry_animation,
                    layer_start,
                    entry_end,
                    &layer.exit_animation,
                    exit_start,
                    layer_end,
                    x_px,
                    y_px,
                    1080,
                    1920,
                );
                format!("x='{}':y='{}':eval=frame", x_expr, y_expr)
            } else {
                format!("{}:{}", x_px, y_px)
            };

            filter_parts.push(format!(
                "{}{}overlay={}:format=auto{}{}",
                current_bg, layer_label, overlay_pos, enable_clause, next_bg
            ));
            current_bg = next_bg;
        }

        // テロップ (overlay_png) + キャプション + 時間ゲート静止レイヤー
        let total_overlays_after_top = n_captions + n_timed;
        let mut overlay_parts: Vec<String> = Vec::new();
        let top_out = if total_overlays_after_top == 0 {
            "[v]".to_string()
        } else {
            "[vt]".to_string()
        };
        overlay_parts.push(format!("{}[2:v]overlay=0:0{}", current_bg, top_out));

        let mut current_label = top_out;
        let mut overlay_idx = 0usize;

        // キャプション（ナレーション字幕）
        for (ci, cap) in scene.captions.iter().enumerate() {
            let input_idx = caption_input_start + ci;
            let is_last = overlay_idx + 1 == total_overlays_after_top;
            let next_label = if is_last {
                "[v]".to_string()
            } else {
                format!("[vc{}]", overlay_idx)
            };
            overlay_parts.push(format!(
                "{}[{}:v]overlay=0:0:enable='between(t,{:.3},{:.3})'{}",
                current_label, input_idx, cap.start, cap.end, next_label
            ));
            current_label = next_label;
            overlay_idx += 1;
        }

        // 時間ゲート付き静止レイヤー（画像/テキスト/図形等を透明 PNG 化したもの）
        for (ti, tovl) in scene.timed_overlays.iter().enumerate() {
            let input_idx = timed_overlay_input_start + ti;
            let is_last = overlay_idx + 1 == total_overlays_after_top;
            let next_label = if is_last {
                "[v]".to_string()
            } else {
                format!("[vc{}]", overlay_idx)
            };

            let has_fade = tovl.entry_animation == "fade"
                || tovl.exit_animation == "fade";
            let has_slide = tovl.entry_animation.starts_with("slide-")
                || tovl.exit_animation.starts_with("slide-");

            if !has_fade && !has_slide {
                // アニメなし: 従来通りの単純 overlay
                overlay_parts.push(format!(
                    "{}[{}:v]overlay=0:0:enable='between(t,{:.3},{:.3})'{}",
                    current_label, input_idx, tovl.start, tovl.end, next_label
                ));
            } else {
                let entry_end = (tovl.start + tovl.entry_duration).min(tovl.end);
                let exit_start = (tovl.end - tovl.exit_duration).max(tovl.start);

                // fade フィルタ適用
                let fade_filter = build_fade_filter(
                    &tovl.entry_animation,
                    tovl.start,
                    tovl.entry_duration,
                    &tovl.exit_animation,
                    exit_start,
                    tovl.exit_duration,
                );
                let faded_label = format!("[tovl{}]", ti);
                let layer_ref = if let Some(f) = &fade_filter {
                    filter_parts.push(format!(
                        "[{}:v]{}{}",
                        input_idx, f, faded_label
                    ));
                    faded_label.clone()
                } else {
                    format!("[{}:v]", input_idx)
                };

                let overlay_pos = if has_slide {
                    let (x_expr, y_expr) = build_slide_xy_expr(
                        &tovl.entry_animation,
                        tovl.start,
                        entry_end,
                        &tovl.exit_animation,
                        exit_start,
                        tovl.end,
                        0,
                        0,
                        1080,
                        1920,
                    );
                    format!("x='{}':y='{}':eval=frame", x_expr, y_expr)
                } else {
                    "0:0".to_string()
                };

                overlay_parts.push(format!(
                    "{}{}overlay={}:enable='between(t,{:.3},{:.3})'{}",
                    current_label, layer_ref, overlay_pos, tovl.start, tovl.end, next_label
                ));
            }

            current_label = next_label;
            overlay_idx += 1;
        }

        let overlay_chain = overlay_parts.join(";");
        filter_parts.push(overlay_chain);
        let filter = filter_parts.join(";") + &audio_chain;

        eprintln!(
            "[compose_video] scene {} duration={:.3}s n_captions={} n_timed={} n_video_layers={}",
            i,
            scene.duration,
            n_captions,
            n_timed,
            sorted_layers.len()
        );
        for (ti, tovl) in scene.timed_overlays.iter().enumerate() {
            eprintln!(
                "[compose_video]   timed[{}] {:.3}-{:.3}s entry={} exit={} png={}",
                ti,
                tovl.start,
                tovl.end,
                tovl.entry_animation,
                tovl.exit_animation,
                tovl.png_path
            );
        }
        eprintln!("[compose_video] scene {} filter = {}", i, filter);

        let mut cmd = hidden_cmd("ffmpeg");
        cmd.args(["-y", "-loop", "1", "-i"])
            .arg(&scene.image_path)
            .args(["-i"])
            .arg(&scene.audio_path)
            .args(["-i"])
            .arg(&scene.overlay_png_path);
        for cap in &scene.captions {
            cmd.args(["-i"]).arg(&cap.png_path);
        }
        // 時間ゲート付き静止レイヤー（透明PNG）
        // loop + t を指定して、シーン全期間に渡って同フレームを供給
        // （fade/slide フィルタが時間軸で動作するために必要）
        for tovl in &scene.timed_overlays {
            cmd.args(["-loop", "1", "-t", &format!("{:.3}", scene.duration), "-i"])
                .arg(&tovl.png_path);
        }
        // 動画レイヤー（ループ再生、色空間まで保持するため他の入力は直後）
        for layer in &sorted_layers {
            cmd.args(["-stream_loop", "-1", "-i"]).arg(&layer.path);
        }
        cmd.args(["-filter_complex", &filter])
            .args(["-map", "[v]", "-map", audio_map])
            .args(["-c:v", "libx264", "-preset", "medium"]);
        if sorted_layers.is_empty() {
            // 静止画ベースのみなら stillimage チューニング適用
            cmd.args(["-tune", "stillimage"]);
        }
        cmd.args(["-c:a", "aac", "-b:a", "192k"])
            .args(["-pix_fmt", "yuv420p"])
            .args(["-r", &FPS.to_string()])
            .args(["-t", &format!("{:.3}", scene.duration)])
            .arg(&scene_mp4);

        let output = cmd
            .output()
            .map_err(|e| format!("ffmpeg scene {}: {}", i, e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr
                .lines()
                .rev()
                .take(12)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!("ffmpeg scene {} failed:\n{}", i, tail));
        }
        scene_video_paths.push(scene_mp4);
    }

    let combined = asset_dir.join("combined.mp4");

    if scenes.len() == 1 {
        std::fs::copy(&scene_video_paths[0], &combined).map_err(|e| e.to_string())?;
    } else {
        let mut args: Vec<String> = vec!["-y".to_string()];
        for p in &scene_video_paths {
            args.push("-i".to_string());
            args.push(p.to_string_lossy().into_owned());
        }

        let mut filter_parts: Vec<String> = Vec::new();
        let mut video_label = "0:v".to_string();
        let mut audio_label = "0:a".to_string();
        let mut cum_d = 0.0f64;
        let mut cum_t = 0.0f64;

        for i in 0..scenes.len() - 1 {
            let cur = &scenes[i];
            let raw_dur = cur.transition_duration.max(0.0).min(1.5);
            let (trans_dur, trans_name) = if cur.transition_to_next == "cut" {
                (0.05, "fade")
            } else if cur.transition_to_next == "flash" {
                (0.15, "fadewhite")
            } else if raw_dur < 0.05 {
                (0.05, normalize_transition(&cur.transition_to_next))
            } else {
                (raw_dur, normalize_transition(&cur.transition_to_next))
            };

            cum_d += cur.duration;
            cum_t += trans_dur;
            let offset = (cum_d - cum_t).max(0.0);

            let is_last = i == scenes.len() - 2;
            let nv = if is_last {
                "vout".to_string()
            } else {
                format!("v{}", i + 1)
            };
            let na = if is_last {
                "aout".to_string()
            } else {
                format!("a{}", i + 1)
            };

            filter_parts.push(format!(
                "[{vi}][{idx}:v]xfade=transition={tt}:duration={td:.3}:offset={off:.3}[{vo}]",
                vi = video_label,
                idx = i + 1,
                tt = trans_name,
                td = trans_dur,
                off = offset,
                vo = nv
            ));
            filter_parts.push(format!(
                "[{ai}][{idx}:a]acrossfade=d={td:.3}[{ao}]",
                ai = audio_label,
                idx = i + 1,
                td = trans_dur,
                ao = na
            ));

            video_label = nv;
            audio_label = na;
        }

        let filter_complex = filter_parts.join(";");

        args.push("-filter_complex".to_string());
        args.push(filter_complex);
        args.push("-map".to_string());
        args.push(format!("[{}]", video_label));
        args.push("-map".to_string());
        args.push(format!("[{}]", audio_label));
        args.push("-c:v".to_string());
        args.push("libx264".to_string());
        args.push("-preset".to_string());
        args.push("medium".to_string());
        args.push("-c:a".to_string());
        args.push("aac".to_string());
        args.push("-b:a".to_string());
        args.push("192k".to_string());
        args.push("-pix_fmt".to_string());
        args.push("yuv420p".to_string());
        args.push(combined.to_string_lossy().into_owned());

        let output = hidden_cmd("ffmpeg")
            .args(&args)
            .output()
            .map_err(|e| format!("ffmpeg concat xfade: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr
                .lines()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(format!("ffmpeg concat xfade failed:\n{}", tail));
        }
    }

    let output_path = base_dir.join(&output_filename);

    if let Some(bgm) = bgm_path.filter(|s| !s.is_empty()) {
        let status = hidden_cmd("ffmpeg")
            .args(["-y", "-i"])
            .arg(&combined)
            .args(["-i"])
            .arg(&bgm)
            .args([
                "-filter_complex",
                "[1:a]volume=0.15,aloop=loop=-1:size=2e+09[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]",
                "-map",
                "0:v",
                "-map",
                "[aout]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ])
            .arg(&output_path)
            .status()
            .map_err(|e| format!("ffmpeg bgm mix: {}", e))?;

        if !status.success() {
            return Err("ffmpeg bgm mix failed".into());
        }
    } else {
        std::fs::rename(&combined, &output_path).map_err(|e| e.to_string())?;
    }

    Ok(output_path.to_string_lossy().into_owned())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(VoicevoxChild(Mutex::new(None)))
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
            get_audio_duration,
            compose_video,
            list_templates,
            save_template,
            delete_template,
            generate_silent_wav,
            mix_audio_clips,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
