import { Component, type ReactNode } from "react";

/**
 * 個別レイヤーの描画でエラーが出ても他のレイヤーや UI 全体を巻き込まないようにする
 * エラーバウンダリ。捕捉時はメッセージを画面と console に出す。
 */
interface State {
  error: Error | null;
}

interface Props {
  children: ReactNode;
  /** デバッグ表示用ラベル (例: layer id + type) */
  label?: string;
}

export class LayerErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(
      `[LayerErrorBoundary] ${this.props.label ?? ""} caught:`,
      error,
      info,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: "rgba(180, 30, 30, 0.6)",
            color: "#fff",
            padding: 8,
            fontSize: 10,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            textAlign: "center",
            whiteSpace: "pre-wrap",
            overflow: "auto",
          }}
        >
          <div style={{ fontWeight: "bold", marginBottom: 4 }}>
            ⚠ レイヤー描画エラー
          </div>
          <div>{this.props.label}</div>
          <div style={{ marginTop: 4, fontFamily: "monospace" }}>
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
