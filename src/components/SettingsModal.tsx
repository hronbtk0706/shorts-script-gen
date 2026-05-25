import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  loadSettings,
  saveSettings,
  type AppSettings,
  type TtsProviderId,
  type LlmProviderId,
} from "../lib/storage";
import {
  EDGE_VOICES,
  VOICEVOX_SPEAKERS,
  SOFTALK_VOICES,
  OPENAI_TTS_VOICES,
} from "../lib/providers/tts";
import { OPENAI_MODELS } from "../lib/providers/llm";
import { isMacOS } from "../lib/platform";
import { ColorSwatches, recordColorUsed } from "./ColorSwatches";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const JAPANESE_SAY_VOICES = [
  { id: "Kyoko", label: "Kyoko（女性・標準）" },
  { id: "Otoya", label: "Otoya（男性・標準）※要DL" },
  { id: "Eddy (Japanese (Japan))", label: "Eddy（中性）" },
  { id: "Flo (Japanese (Japan))", label: "Flo（中性）" },
  { id: "Grandma (Japanese (Japan))", label: "Grandma（高齢女性）" },
  { id: "Grandpa (Japanese (Japan))", label: "Grandpa（高齢男性）" },
  { id: "Reed (Japanese (Japan))", label: "Reed（男性）" },
  { id: "Rocko (Japanese (Japan))", label: "Rocko（男性）" },
  { id: "Sandy (Japanese (Japan))", label: "Sandy（女性）" },
  { id: "Shelley (Japanese (Japan))", label: "Shelley（女性）" },
];

const DEFAULT_SETTINGS: AppSettings = {
  llmProvider: "groq",
  geminiApiKey: "",
  groqApiKey: "",
  openaiApiKey: "",
  openaiModel: "gpt-5-mini",
  ttsProvider: "voicevox",
  sayVoice: "Kyoko",
  edgeVoice: "ja-JP-NanamiNeural",
  voicevoxSpeaker: 3,
  openaiTtsVoice: "alloy",
  openaiTtsModel: "tts-1",
  softalkPath: "",
  softalkVoice: 0,
  bgmFilePath: "",
  pixabayApiKey: "",
  youtubeApiKey: "",
  contentNiche: "",
  multiCandidateEnabled: true,
  multiCandidateCount: 3,
  referenceVideoCount: 5,
  defaultTemplateId: "",
  seFolderPath: "",
  youtubeOAuthClientId: "",
  youtubeOAuthClientSecret: "",
  videoEncoder: "libx264",
  autoTeropFontSize: 48,
  autoTeropFontColor: "#FFFFFF",
  autoTeropOutlineWidth: 3,
  autoTeropOutlineColor: "#000000",
  autoTeropY: 75,
  autoTeropFillColor: "",
  autoTeropFontFamily: "",
};

export function SettingsModal({ open, onClose, onSaved }: Props) {
  const [s, setS] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [showGemini, setShowGemini] = useState(false);
  const [showGroq, setShowGroq] = useState(false);
  const [showOpenAi, setShowOpenAi] = useState(false);
  const [showPixabay, setShowPixabay] = useState(false);
  const [showYoutube, setShowYoutube] = useState(false);

  useEffect(() => {
    if (open) {
      loadSettings().then(setS);
    }
  }, [open]);

  if (!open) return null;

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveSettings(s);
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold mb-4">設定</h2>

        <section className="space-y-3 pb-5 border-b border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-300">
            台本生成AI
          </h3>
          <label className="block text-sm">プロバイダ</label>
          <select
            value={s.llmProvider}
            onChange={(e) =>
              update("llmProvider", e.target.value as LlmProviderId)
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          >
            <option value="openai">
              OpenAI GPT（高品質・従量課金）
            </option>
            <option value="gemini">
              Gemini 2.5 Flash Lite（20/日・日本語◎）
            </option>
            <option value="groq">
              Groq Llama 3.3 70B（14,400/日・爆速）
            </option>
          </select>

          {s.llmProvider === "groq" && (
            <>
              <label className="block text-sm mt-2">Groq API キー</label>
              <div className="relative">
                <input
                  type={showGroq ? "text" : "password"}
                  value={s.groqApiKey}
                  onChange={(e) => update("groqApiKey", e.target.value)}
                  placeholder="gsk_..."
                  className="w-full px-3 py-2 pr-20 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                />
                <button
                  type="button"
                  onClick={() => setShowGroq(!showGroq)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500"
                >
                  {showGroq ? "隠す" : "表示"}
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  openUrl("https://console.groq.com/keys")
                }
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                → Groq Console で無料取得（クレカ不要）
              </button>
            </>
          )}

          {s.llmProvider === "openai" && (
            <>
              <label className="block text-sm mt-2">OpenAI API キー</label>
              <div className="relative">
                <input
                  type={showOpenAi ? "text" : "password"}
                  value={s.openaiApiKey}
                  onChange={(e) => update("openaiApiKey", e.target.value)}
                  placeholder="sk-..."
                  className="w-full px-3 py-2 pr-20 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                />
                <button
                  type="button"
                  onClick={() => setShowOpenAi(!showOpenAi)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500"
                >
                  {showOpenAi ? "隠す" : "表示"}
                </button>
              </div>
              <button
                type="button"
                onClick={() => openUrl("https://platform.openai.com/api-keys")}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                → OpenAI Platform でAPIキー取得（新規登録で$5クレジット付与）
              </button>

              <label className="block text-sm mt-2">モデル</label>
              <select
                value={s.openaiModel}
                onChange={(e) => update("openaiModel", e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              >
                {OPENAI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </>
          )}

          {s.llmProvider === "gemini" && (
            <>
              <label className="block text-sm mt-2">Gemini API キー</label>
              <div className="relative">
                <input
                  type={showGemini ? "text" : "password"}
                  value={s.geminiApiKey}
                  onChange={(e) => update("geminiApiKey", e.target.value)}
                  placeholder="AIza..."
                  className="w-full px-3 py-2 pr-20 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                />
                <button
                  type="button"
                  onClick={() => setShowGemini(!showGemini)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500"
                >
                  {showGemini ? "隠す" : "表示"}
                </button>
              </div>
              <button
                type="button"
                onClick={() => openUrl("https://aistudio.google.com/apikey")}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                → Google AI Studio で無料取得
              </button>
            </>
          )}
        </section>

        <section className="space-y-3 py-5 border-b border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-300">
            生成モード
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            多候補生成（切り口ブレスト → 複数案 → 自動選抜）が常に有効です。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                候補数（2〜5）
              </label>
              <input
                type="number"
                min={2}
                max={5}
                value={s.multiCandidateCount}
                onChange={(e) =>
                  update(
                    "multiCandidateCount",
                    Math.max(2, Math.min(5, Number(e.target.value) || 3)),
                  )
                }
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                参考動画数（3〜10）
              </label>
              <input
                type="number"
                min={3}
                max={10}
                value={s.referenceVideoCount}
                onChange={(e) =>
                  update(
                    "referenceVideoCount",
                    Math.max(3, Math.min(10, Number(e.target.value) || 5)),
                  )
                }
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              />
            </div>
          </div>
          <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
            ⚠ 参考動画取得は個人の学習・創作参考目的で利用してください
          </p>
        </section>

        <section className="space-y-3 py-5 border-b border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-300">
            ナレーション音声
          </h3>
          <label className="block text-sm">プロバイダ</label>
          <select
            value={s.ttsProvider}
            onChange={(e) =>
              update("ttsProvider", e.target.value as TtsProviderId)
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          >
            <option value="edge">
              Edge TTS（無料・無制限・高品質）
            </option>
            <option value="openai">
              OpenAI TTS（API キー・有料・約¥2/1000字）
            </option>
            <option value="voicevox">
              VOICEVOX（無料・ローカル・キャラ声）
            </option>
            <option value="softalk">
              SofTalk（ゆっくり霊夢/魔理沙・要 SofTalk.exe）
            </option>
            {isMacOS() && (
              <option value="say">
                macOS say（無料・ローカル・シンプル）
              </option>
            )}
          </select>

          {s.ttsProvider === "edge" && (
            <>
              <label className="block text-sm">ボイス</label>
              <select
                value={s.edgeVoice}
                onChange={(e) => update("edgeVoice", e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              >
                {EDGE_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Microsoft Edge ブラウザの読み上げ機能を利用。登録不要。
              </p>
            </>
          )}

          {s.ttsProvider === "voicevox" && (
            <>
              <label className="block text-sm">キャラクター</label>
              <select
                value={s.voicevoxSpeaker}
                onChange={(e) =>
                  update("voicevoxSpeaker", Number(e.target.value))
                }
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              >
                {VOICEVOX_SPEAKERS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                <p>⚠ VOICEVOX アプリを起動中である必要があります（localhost:50021）</p>
                <button
                  type="button"
                  onClick={() => openUrl("https://voicevox.hiroshiba.jp/")}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  → VOICEVOX をダウンロード（Mac/Win/Linux対応・無料）
                </button>
              </div>
            </>
          )}

          {s.ttsProvider === "say" && (
            <>
              <label className="block text-sm">声</label>
              <select
                value={s.sayVoice}
                onChange={(e) => update("sayVoice", e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              >
                {JAPANESE_SAY_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500">
                Premium版はシステム設定 → アクセシビリティ → 読み上げコンテンツからDL
              </p>
            </>
          )}

          {s.ttsProvider === "openai" && (
            <>
              <label className="block text-sm">声</label>
              <select
                value={s.openaiTtsVoice}
                onChange={(e) => update("openaiTtsVoice", e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              >
                {OPENAI_TTS_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <label className="block text-sm">モデル</label>
              <select
                value={s.openaiTtsModel}
                onChange={(e) => update("openaiTtsModel", e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              >
                <option value="tts-1">tts-1（高速・標準）</option>
                <option value="tts-1-hd">tts-1-hd（高品質）</option>
              </select>
              <p className="text-xs text-gray-500">
                OpenAI API キーを上で設定してください。約 ¥2/1000 文字。
              </p>
            </>
          )}

          {s.ttsProvider === "softalk" && (
            <>
              <label className="block text-sm">SofTalk.exe のパス</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={s.softalkPath}
                  onChange={(e) => update("softalkPath", e.target.value)}
                  placeholder="例: C:\Tools\softalk\SofTalk.exe"
                  className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const path = await openFileDialog({
                      multiple: false,
                      directory: false,
                      filters: [
                        {
                          name: "SofTalk.exe",
                          extensions: ["exe"],
                        },
                      ],
                    });
                    if (typeof path === "string") update("softalkPath", path);
                  }}
                  className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
                >
                  📁 選択
                </button>
              </div>
              <label className="block text-sm">声</label>
              <select
                value={s.softalkVoice}
                onChange={(e) =>
                  update("softalkVoice", Number(e.target.value))
                }
                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              >
                {SOFTALK_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                <p>⚠ 別途 SofTalk のダウンロードが必要（無料・非商用）</p>
                <button
                  type="button"
                  onClick={() => openUrl("https://cncsoft.com/download/")}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  → SofTalk をダウンロード（cncsoft.com）
                </button>
              </div>
            </>
          )}
        </section>

        <section className="space-y-3 py-5 border-t border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-300">
            BGM
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            ファイル指定が優先。未指定の場合はPixabay APIで台本のムードに合ったBGMを自動取得します。
          </p>

          <label className="block text-sm">BGMファイル（mp3 / wav）</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={s.bgmFilePath}
              onChange={(e) => update("bgmFilePath", e.target.value)}
              placeholder="ファイルパスを貼り付けるか右のボタンで選択"
              className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs font-mono"
            />
            <button
              type="button"
              onClick={async () => {
                const result = await openFileDialog({
                  multiple: false,
                  filters: [{ name: "Audio", extensions: ["mp3", "wav", "m4a", "ogg"] }],
                });
                if (typeof result === "string") update("bgmFilePath", result);
              }}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm whitespace-nowrap"
            >
              選択
            </button>
            {s.bgmFilePath && (
              <button
                type="button"
                onClick={() => update("bgmFilePath", "")}
                className="px-3 py-2 rounded-lg border border-red-300 text-red-600 text-sm"
              >
                ✕
              </button>
            )}
          </div>

          <label className="block text-sm mt-3">Pixabay APIキー（自動BGM用・任意）</label>
          <div className="relative">
            <input
              type={showPixabay ? "text" : "password"}
              value={s.pixabayApiKey}
              onChange={(e) => update("pixabayApiKey", e.target.value)}
              placeholder="Pixabayで無料取得"
              className="w-full px-3 py-2 pr-20 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            />
            <button
              type="button"
              onClick={() => setShowPixabay(!showPixabay)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500"
            >
              {showPixabay ? "隠す" : "表示"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => openUrl("https://pixabay.com/api/docs/")}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            → Pixabayでアカウント登録・APIキー取得（無料）
          </button>
        </section>

        <section className="space-y-3 py-5 border-t border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-300">
            動画エクスポート
          </h3>
          <label className="block text-sm">エンコーダ</label>
          <select
            value={s.videoEncoder}
            onChange={(e) =>
              update("videoEncoder", e.target.value as AppSettings["videoEncoder"])
            }
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm"
          >
            <option value="libx264">libx264（CPU・最高品質、遅い）</option>
            <option value="h264_nvenc">h264_nvenc（NVIDIA GPU・高速、品質95%）</option>
            <option value="h264_qsv">h264_qsv（Intel iGPU・高速、品質90%）</option>
          </select>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            NVENC は NVIDIA GPU、QSV は Intel 内蔵 GPU が必要。SNS 用途ならハードウェアエンコードで十分です（5〜10倍速い）。
          </p>
        </section>

        <section className="space-y-3 py-5 border-t border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-300">
            台本自動配置のデフォルトテロップスタイル
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            台本→自動配置で生成されるテロップに適用されるスタイル。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs mb-1">フォントサイズ (px)</label>
              <input
                type="number"
                min={8}
                max={200}
                value={s.autoTeropFontSize}
                onChange={(e) =>
                  update("autoTeropFontSize", Number(e.target.value) || 48)
                }
                className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-xs mb-1">縦位置 (% 0=上 / 100=下)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={s.autoTeropY}
                onChange={(e) => update("autoTeropY", Number(e.target.value))}
                className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-xs mb-1">文字色</label>
              <input
                type="color"
                value={s.autoTeropFontColor}
                // ドラッグ中は live update のみ。recents 追加は onBlur (commit) で。
                onChange={(e) => update("autoTeropFontColor", e.target.value)}
                onBlur={(e) => recordColorUsed(e.target.value)}
                className="w-full h-8 rounded border border-gray-300 dark:border-gray-600"
              />
              <ColorSwatches
                value={s.autoTeropFontColor}
                onChange={(c) => {
                  update("autoTeropFontColor", c);
                  recordColorUsed(c);
                }}
              />
            </div>
            <div>
              <label className="block text-xs mb-1">縁の色</label>
              <input
                type="color"
                value={s.autoTeropOutlineColor}
                onChange={(e) => update("autoTeropOutlineColor", e.target.value)}
                onBlur={(e) => recordColorUsed(e.target.value)}
                className="w-full h-8 rounded border border-gray-300 dark:border-gray-600"
              />
              <ColorSwatches
                value={s.autoTeropOutlineColor}
                onChange={(c) => {
                  update("autoTeropOutlineColor", c);
                  recordColorUsed(c);
                }}
              />
            </div>
            <div>
              <label className="block text-xs mb-1">縁の太さ (px、0=なし)</label>
              <input
                type="number"
                min={0}
                max={20}
                value={s.autoTeropOutlineWidth}
                onChange={(e) =>
                  update("autoTeropOutlineWidth", Number(e.target.value))
                }
                className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              />
            </div>
            <div>
              <label className="block text-xs mb-1">背景色（空 = なし）</label>
              <input
                type="text"
                value={s.autoTeropFillColor}
                onChange={(e) => update("autoTeropFillColor", e.target.value)}
                placeholder="例: rgba(0,0,0,0.6)"
                className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs mb-1">フォントファミリー（空 = システム既定）</label>
            <input
              type="text"
              value={s.autoTeropFontFamily}
              onChange={(e) => update("autoTeropFontFamily", e.target.value)}
              placeholder='例: "Noto Sans JP"'
              className="w-full px-2 py-1 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            />
          </div>
        </section>

        <section className="space-y-3 py-5 border-t border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-300">
            SE（効果音）フォルダ
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            アプリに136件のSEが同梱されています。追加のSEフォルダを指定すると、そちらが優先されます。
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={s.seFolderPath}
              onChange={(e) => update("seFolderPath", e.target.value)}
              placeholder="例: C:\Users\...\Documents\SE"
              className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-xs font-mono"
            />
            <button
              type="button"
              onClick={async () => {
                const result = await openFileDialog({
                  multiple: false,
                  directory: true,
                });
                if (typeof result === "string") update("seFolderPath", result);
              }}
              className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm whitespace-nowrap"
            >
              📁 選択
            </button>
            {s.seFolderPath && (
              <button
                type="button"
                onClick={() => update("seFolderPath", "")}
                className="px-3 py-2 rounded-lg border border-red-300 text-red-600 text-sm"
              >
                ✕
              </button>
            )}
          </div>
        </section>

        <section className="space-y-3 py-5 border-t border-gray-200 dark:border-gray-800">
          <h3 className="font-semibold text-sm text-gray-700 dark:text-gray-300">
            トレンド取得 / 自動最適化
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            設定するとYouTubeの最新トレンドを参照して台本を自動改善します。
          </p>

          <label className="block text-sm">チャンネルのジャンル・キーワード</label>
          <input
            type="text"
            value={s.contentNiche}
            onChange={(e) => update("contentNiche", e.target.value)}
            placeholder="例: ワンピース 名シーン, AI活用, 筋トレ"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            参考動画検索のフォールバック用キーワード（トピックが空の時に使用）。
          </p>

          <label className="block text-sm mt-3">
            YouTube Data API キー <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <input
              type={showYoutube ? "text" : "password"}
              value={s.youtubeApiKey}
              onChange={(e) => update("youtubeApiKey", e.target.value)}
              placeholder="AIza..."
              className="w-full px-3 py-2 pr-20 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            />
            <button
              type="button"
              onClick={() => setShowYoutube(!showYoutube)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500"
            >
              {showYoutube ? "隠す" : "表示"}
            </button>
          </div>
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            コメント取得に使用（YouTube 公式 API、無料 10,000 ユニット/日）。
          </p>
          <button
            type="button"
            onClick={() =>
              openUrl(
                "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
              )
            }
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            → Google Cloud で YouTube Data API v3 を有効化（無料・クレカ不要）
          </button>

          <div className="pt-3 mt-3 border-t border-gray-200 dark:border-gray-700">
            <div className="text-sm font-semibold mb-1">
              YouTube Analytics 連携（OAuth）
            </div>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
              自分の動画の視聴維持率・CTR・インプレッション等の詳細データを取得するのに使用。Google Cloud Console で「OAuth 2.0 クライアント ID（デスクトップアプリ）」を作成して登録してください。
            </p>
            <label className="block text-sm">OAuth Client ID</label>
            <input
              type="text"
              value={s.youtubeOAuthClientId}
              onChange={(e) => update("youtubeOAuthClientId", e.target.value)}
              placeholder="xxxxxxxxxxxx.apps.googleusercontent.com"
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 mb-2"
            />
            <label className="block text-sm">OAuth Client Secret</label>
            <input
              type="password"
              value={s.youtubeOAuthClientSecret}
              onChange={(e) =>
                update("youtubeOAuthClientSecret", e.target.value)
              }
              placeholder="GOCSPX-..."
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
            />
            <div className="flex flex-col gap-0.5 mt-1">
              <button
                type="button"
                onClick={() =>
                  openUrl("https://console.cloud.google.com/apis/credentials")
                }
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline text-left"
              >
                → Google Cloud: OAuth 認証情報ページを開く
              </button>
              <button
                type="button"
                onClick={() =>
                  openUrl(
                    "https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com",
                  )
                }
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline text-left"
              >
                → YouTube Analytics API を有効化
              </button>
            </div>
          </div>
        </section>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-lg border border-gray-300 dark:border-gray-600"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:bg-gray-400"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
