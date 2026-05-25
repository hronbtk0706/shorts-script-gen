import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { LazyStore } from "@tauri-apps/plugin-store";
import { loadSettings } from "./storage";

const tokenStore = new LazyStore("yt_oauth_tokens.json");
const KEY_ACCESS = "access_token";
const KEY_REFRESH = "refresh_token";
const KEY_EXPIRES_AT = "expires_at"; // ms epoch
const KEY_SCOPE = "scope";

interface OAuthCallbackResult {
  code: string;
  redirectUri: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
}

export async function getStoredTokens(): Promise<StoredTokens | null> {
  const access = await tokenStore.get<string>(KEY_ACCESS);
  const refresh = await tokenStore.get<string>(KEY_REFRESH);
  const expiresAt = await tokenStore.get<number>(KEY_EXPIRES_AT);
  const scope = await tokenStore.get<string>(KEY_SCOPE);
  if (!access || !refresh || !expiresAt) return null;
  return { accessToken: access, refreshToken: refresh, expiresAt, scope };
}

async function saveTokens(t: StoredTokens): Promise<void> {
  await tokenStore.set(KEY_ACCESS, t.accessToken);
  await tokenStore.set(KEY_REFRESH, t.refreshToken);
  await tokenStore.set(KEY_EXPIRES_AT, t.expiresAt);
  if (t.scope) await tokenStore.set(KEY_SCOPE, t.scope);
  await tokenStore.save();
}

export async function clearTokens(): Promise<void> {
  await tokenStore.delete(KEY_ACCESS);
  await tokenStore.delete(KEY_REFRESH);
  await tokenStore.delete(KEY_EXPIRES_AT);
  await tokenStore.delete(KEY_SCOPE);
  await tokenStore.save();
}

/**
 * OAuth 認可フローを実行し、アクセストークンとリフレッシュトークンを取得して保存する。
 * Rust 側でローカルHTTPサーバを立てて code を受け取り、TS 側で token 交換を行う。
 */
export async function startOAuthFlow(): Promise<StoredTokens> {
  const settings = await loadSettings();
  const clientId = settings.youtubeOAuthClientId.trim();
  const clientSecret = settings.youtubeOAuthClientSecret.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "YouTube OAuth の client_id / client_secret を設定画面で登録してください",
    );
  }

  // Rust 側: ブラウザを開いて認可コードを受け取る
  const result = await invoke<OAuthCallbackResult>("youtube_oauth_flow", {
    clientId,
  });

  // トークン交換
  const body = new URLSearchParams({
    code: result.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: result.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await tauriFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as GoogleTokenResponse;
  if (!json.refresh_token) {
    // refresh_token が返らないのは prompt=consent でも既に権限を持っているケース等。
    // 初回ログインなら必ず返ってくるはず。
    throw new Error(
      "refresh_token を取得できませんでした。Google 側の権限をリボークして再試行してください",
    );
  }
  const tokens: StoredTokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
  await saveTokens(tokens);
  return tokens;
}

/**
 * 現在のアクセストークンを返す。期限切れ間近なら refresh_token で更新する。
 */
export async function getValidAccessToken(): Promise<string> {
  const tokens = await getStoredTokens();
  if (!tokens) {
    throw new Error("YouTube と未連携です（Analyticsタブの「YouTube連携」から認証してください）");
  }
  // 残り 60 秒を切ったら refresh
  if (tokens.expiresAt - Date.now() > 60_000) {
    return tokens.accessToken;
  }
  const settings = await loadSettings();
  const body = new URLSearchParams({
    client_id: settings.youtubeOAuthClientId,
    client_secret: settings.youtubeOAuthClientSecret,
    refresh_token: tokens.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await tauriFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Token refresh failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const json = (await res.json()) as GoogleTokenResponse;
  const refreshed: StoredTokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope ?? tokens.scope,
  };
  await saveTokens(refreshed);
  return refreshed.accessToken;
}
