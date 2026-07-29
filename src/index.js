const CANVA_API = "https://api.canva.com/rest/v1";
const CANVA_AUTHORIZE = "https://www.canva.com/api/oauth/authorize";
const TOKEN_KEY = "canva:tokens";
const OAUTH_STATE_PREFIX = "canva:oauth:";
const MAX_HEADSHOT_BYTES = 10 * 1024 * 1024;

const CANVA_SCOPES = [
  "asset:read",
  "asset:write",
  "brandtemplate:content:read",
  "brandtemplate:meta:read",
  "design:content:read",
  "design:content:write",
  "design:meta:read"
].join(" ");

const TEXT_FIELDS = {
  salesPrice: "Sales Price Amount",
  baseLoanAmount: "Base loan amount",
  nmls: "NMLS#",
  phone: "Your phone number",
  finalApprovalDetails: "Final approval review details.",
  regarding: "Regarding",
  jobTitle: "Your job title",
  advisorName: "Your name",
  date: "Date",
  property: "Property",
  email: "Your email address",
  recipientName: "Recipient/client name",
  loanToValue: "Loan to value amount",
  loanType: "Loan Type or Product"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/oauth/connect" && request.method === "GET") {
        return startCanvaOAuth(request, env);
      }

      if (url.pathname === "/oauth/callback" && request.method === "GET") {
        return finishCanvaOAuth(request, env);
      }

      if (url.pathname === "/admin/status" && request.method === "GET") {
        return connectionStatus(env);
      }

      if (url.pathname === "/api/generate" && request.method === "POST") {
        return generateLetter(request, env);
      }

      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/admin/")) {
        return json({ error: "Not found." }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("Unhandled request error", error);
      const status =
        error instanceof UserInputError ? 400 :
        error instanceof NotConnectedError ? 409 :
        500;
      return json(
        {
          error: "We couldn’t complete the request.",
          details: safeErrorMessage(error)
        },
        status
      );
    }
  }
};

async function startCanvaOAuth(request, env) {
  assertConfiguration(env, { requireTokens: true });

  const state = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = oauthRedirectUri(request, env);

  await env.CANVA_TOKENS.put(
    `${OAUTH_STATE_PREFIX}${state}`,
    JSON.stringify({ verifier, redirectUri }),
    { expirationTtl: 600 }
  );

  const authorizeUrl = new URL(CANVA_AUTHORIZE);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "s256");
  authorizeUrl.searchParams.set("scope", CANVA_SCOPES);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", env.CANVA_CLIENT_ID);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);

  return Response.redirect(authorizeUrl.toString(), 302);
}

async function finishCanvaOAuth(request, env) {
  assertConfiguration(env, { requireTokens: true });
  const url = new URL(request.url);
  const error = url.searchParams.get("error");

  if (error) {
    return htmlMessage(
      "Canva wasn’t connected",
      url.searchParams.get("error_description") || error,
      false
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlMessage("Canva wasn’t connected", "The authorization response was incomplete.", false);
  }

  const stateKey = `${OAUTH_STATE_PREFIX}${state}`;
  const pending = await env.CANVA_TOKENS.get(stateKey, "json");
  await env.CANVA_TOKENS.delete(stateKey);

  if (!pending?.verifier || !pending?.redirectUri) {
    return htmlMessage("Canva wasn’t connected", "The authorization link expired. Please try again.", false);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code_verifier: pending.verifier,
    code,
    redirect_uri: pending.redirectUri
  });

  const response = await fetch(`${CANVA_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthorization(env),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const token = await readCanvaJson(response);
  await saveTokens(env, token);
  return htmlMessage(
    "Canva is connected",
    "The NEO pre-approval form can now generate and download completed PDFs.",
    true
  );
}

async function connectionStatus(env) {
  const configured = Boolean(
    env.CANVA_CLIENT_ID &&
    env.CANVA_CLIENT_SECRET &&
    env.CANVA_TOKENS &&
    env.CANVA_TEMPLATE_ID
  );

  if (!configured) {
    return json({ configured: false, connected: false });
  }

  const tokens = await env.CANVA_TOKENS.get(TOKEN_KEY, "json");
  return json({
    configured: true,
    connected: Boolean(tokens?.access_token || tokens?.refresh_token)
  });
}

async function generateLetter(request, env) {
  assertConfiguration(env, { requireTokens: true });
  const form = await request.formData();
  const values = validateForm(form);
  const accessToken = await getAccessToken(env);

  let headshotAssetId;
  const headshot = form.get("headshot");
  if (headshot instanceof File && headshot.size > 0) {
    headshotAssetId = await uploadHeadshot(accessToken, headshot);
  }

  const data = {};
  for (const [formKey, canvaField] of Object.entries(TEXT_FIELDS)) {
    data[canvaField] = { type: "text", text: values[formKey] };
  }

  if (headshotAssetId) {
    data["Your photo or headshot"] = {
      type: "image",
      asset_id: headshotAssetId
    };
  }

  const title = buildDesignTitle(values);
  const autofill = await canvaRequest(accessToken, "/autofills", {
    method: "POST",
    body: JSON.stringify({
      type: "create_from_brand_template",
      brand_template_id: env.CANVA_TEMPLATE_ID,
      title,
      data
    })
  });

  const autofillJob = await pollCanvaJob(accessToken, "/autofills", autofill.job);
  const design = autofillJob.result?.design;
  if (!design?.id) {
    throw new Error("Canva completed the autofill job without returning a design.");
  }

  const exportStart = await canvaRequest(accessToken, "/exports", {
    method: "POST",
    body: JSON.stringify({
      design_id: design.id,
      format: {
        type: "pdf",
        export_quality: "regular"
      }
    })
  });

  const exportJob = await pollCanvaJob(accessToken, "/exports", exportStart.job);
  const downloadUrl = exportJob.urls?.[0];
  if (!downloadUrl) {
    throw new Error("Canva completed the export without returning a PDF.");
  }

  const pdfResponse = await fetch(downloadUrl);
  if (!pdfResponse.ok || !pdfResponse.body) {
    throw new Error("The completed PDF could not be downloaded from Canva.");
  }

  const filename = `${slugify(values.recipientName)}-pre-approval-letter.pdf`;
  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  });

  if (design.urls?.edit_url) {
    headers.set("X-Canva-Edit-Url", design.urls.edit_url);
  }

  return new Response(pdfResponse.body, { status: 200, headers });
}

function validateForm(form) {
  const values = {};
  for (const formKey of Object.keys(TEXT_FIELDS)) {
    const value = String(form.get(formKey) || "").trim();
    if (!value) {
      throw new UserInputError(`Please complete the “${humanFieldName(formKey)}” field.`);
    }
    if (value.length > 1500) {
      throw new UserInputError(`The “${humanFieldName(formKey)}” field is too long.`);
    }
    values[formKey] = value;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    throw new UserInputError("Please enter a valid Mortgage Advisor email address.");
  }

  const headshot = form.get("headshot");
  if (!(headshot instanceof File) || headshot.size === 0) {
    throw new UserInputError("Please upload a Mortgage Advisor headshot.");
  }
  if (!headshot.type.startsWith("image/")) {
    throw new UserInputError("The headshot must be an image file.");
  }
  if (headshot.size > MAX_HEADSHOT_BYTES) {
    throw new UserInputError("The headshot must be smaller than 10 MB.");
  }

  return values;
}

async function uploadHeadshot(accessToken, file) {
  const bytes = await file.arrayBuffer();
  const filename = sanitizeAssetName(file.name || "Mortgage Advisor headshot");
  const metadata = JSON.stringify({ name_base64: utf8ToBase64(filename) });

  const response = await fetch(`${CANVA_API}/asset-uploads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Asset-Upload-Metadata": metadata
    },
    body: bytes
  });

  const upload = await readCanvaJson(response);
  const job = await pollCanvaJob(accessToken, "/asset-uploads", upload.job);
  if (!job.asset?.id) {
    throw new Error("Canva uploaded the headshot but did not return an asset.");
  }
  return job.asset.id;
}

async function getAccessToken(env) {
  const tokens = await env.CANVA_TOKENS.get(TOKEN_KEY, "json");
  if (!tokens) {
    throw new NotConnectedError();
  }

  if (tokens.access_token && Number(tokens.expires_at) > Date.now() + 60_000) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new NotConnectedError();
  }

  const response = await fetch(`${CANVA_API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: basicAuthorization(env),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token
    })
  });

  const refreshed = await readCanvaJson(response);
  await saveTokens(env, refreshed);
  return refreshed.access_token;
}

async function saveTokens(env, token) {
  if (!token?.access_token || !token?.refresh_token) {
    throw new Error("Canva did not return the required authorization tokens.");
  }

  await env.CANVA_TOKENS.put(
    TOKEN_KEY,
    JSON.stringify({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + Number(token.expires_in || 0) * 1000,
      scope: token.scope || CANVA_SCOPES
    })
  );
}

async function canvaRequest(accessToken, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${CANVA_API}${path}`, { ...init, headers });
  return readCanvaJson(response);
}

async function pollCanvaJob(accessToken, resourcePath, initialJob) {
  let job = initialJob;
  if (!job?.id) {
    throw new Error("Canva did not return a job ID.");
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (job.status === "success") return job;
    if (job.status === "failed") {
      throw new Error(job.error?.message || "The Canva job failed.");
    }

    await delay(Math.min(500 + attempt * 250, 2000));
    const result = await canvaRequest(accessToken, `${resourcePath}/${encodeURIComponent(job.id)}`);
    job = result.job;
  }

  throw new Error("Canva is taking longer than expected. Please try again.");
}

async function readCanvaJson(response) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message = payload.message || payload.error?.message || `Canva returned ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}

function assertConfiguration(env, { requireTokens = false } = {}) {
  const missing = [];
  if (!env.CANVA_CLIENT_ID) missing.push("CANVA_CLIENT_ID");
  if (!env.CANVA_CLIENT_SECRET) missing.push("CANVA_CLIENT_SECRET");
  if (!env.CANVA_TEMPLATE_ID) missing.push("CANVA_TEMPLATE_ID");
  if (requireTokens && !env.CANVA_TOKENS) missing.push("CANVA_TOKENS binding");

  if (missing.length) {
    throw new Error(`Cloudflare configuration is incomplete: ${missing.join(", ")}.`);
  }
}

function oauthRedirectUri(request, env) {
  if (env.CANVA_REDIRECT_URI) return env.CANVA_REDIRECT_URI;
  const url = new URL(request.url);
  return `${url.origin}/oauth/callback`;
}

function basicAuthorization(env) {
  return `Basic ${utf8ToBase64(`${env.CANVA_CLIENT_ID}:${env.CANVA_CLIENT_SECRET}`)}`;
}

function buildDesignTitle(values) {
  const title = `${values.recipientName} | Pre-Approval Letter | ${values.date}`;
  return title.slice(0, 255);
}

function sanitizeAssetName(name) {
  const cleaned = name.replace(/[^\p{L}\p{N}._ -]/gu, "").trim();
  return (cleaned || "Mortgage Advisor headshot").slice(0, 50);
}

function humanFieldName(key) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (character) => character.toUpperCase());
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "borrower";
}

function randomBase64Url(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeErrorMessage(error) {
  if (error instanceof UserInputError) return error.message;
  if (error instanceof NotConnectedError) return error.message;
  return error instanceof Error ? error.message : "Unknown error.";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function htmlMessage(title, message, success) {
  const color = success ? "#0A2540" : "#8A1C1C";
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7f8;color:#0a2540;font-family:Montserrat,Arial,sans-serif}
    main{width:min(560px,calc(100% - 40px));box-sizing:border-box;background:#fff;border:1px solid #dfe7ea;border-radius:24px;padding:42px;box-shadow:0 18px 50px rgba(10,37,64,.12)}
    .mark{width:48px;height:7px;border-radius:99px;background:#5bcbf5;margin-bottom:28px}
    h1{margin:0 0 12px;font-size:32px;line-height:1.08;color:${color}}
    p{margin:0 0 28px;color:#52636f;line-height:1.65}
    a{display:inline-block;background:#0a2540;color:#fff;text-decoration:none;font-weight:700;padding:13px 19px;border-radius:12px}
  </style>
</head>
<body>
  <main>
    <div class="mark"></div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/">Return to the form</a>
  </main>
</body>
</html>`,
    {
      status: success ? 200 : 400,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }
    }
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

class UserInputError extends Error {}

class NotConnectedError extends Error {
  constructor() {
    super("Canva has not been connected by an administrator.");
  }
}
