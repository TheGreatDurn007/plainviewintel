import crypto from "crypto";

const API_KEY = () => process.env.X_API_KEY!;
const API_SECRET = () => process.env.X_API_SECRET!;
const ACCESS_TOKEN = () => process.env.X_ACCESS_TOKEN!;
const ACCESS_SECRET = () => process.env.X_ACCESS_TOKEN_SECRET!;

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function oauthSign(method: string, url: string, params: Record<string, string>) {
  const sorted = Object.keys(params).sort().map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join("&");
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sorted)}`;
  const signingKey = `${percentEncode(API_SECRET())}&${percentEncode(ACCESS_SECRET())}`;
  return crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
}

function oauthHeader(method: string, url: string, extraParams: Record<string, string> = {}) {
  const params: Record<string, string> = {
    oauth_consumer_key: API_KEY(),
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ACCESS_TOKEN(),
    oauth_version: "1.0",
    ...extraParams,
  };
  params.oauth_signature = oauthSign(method, url, params);

  const headerParts = Object.keys(params)
    .filter(k => k.startsWith("oauth_"))
    .sort()
    .map(k => `${percentEncode(k)}="${percentEncode(params[k])}"`)
    .join(", ");
  return `OAuth ${headerParts}`;
}

export type PostResult = {
  success: boolean;
  id?: string;
  text?: string;
  error?: string;
};

export async function uploadMedia(imageBuffer: ArrayBuffer): Promise<string | null> {
  const url = "https://upload.twitter.com/1.1/media/upload.json";
  const base64 = Buffer.from(imageBuffer).toString("base64");

  const bodyParams: Record<string, string> = {
    media_data: base64,
    media_category: "tweet_image",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: oauthHeader("POST", url),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  if (!res.ok) return null;
  const data = await res.json() as { media_id_string?: string };
  return data.media_id_string ?? null;
}

export async function postTweet(text: string, mediaId?: string, replyToId?: string): Promise<PostResult> {
  const url = "https://api.twitter.com/2/tweets";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = { text };
  if (mediaId) {
    payload.media = { media_ids: [mediaId] };
  }
  if (replyToId) {
    payload.reply = { in_reply_to_tweet_id: replyToId };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: oauthHeader("POST", url),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    return { success: false, error: data?.detail || data?.title || JSON.stringify(data) };
  }

  return {
    success: true,
    id: data?.data?.id,
    text: data?.data?.text,
  };
}
