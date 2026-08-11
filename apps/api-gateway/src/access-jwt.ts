import { HttpError } from "@org-brain/shared";

export type AccessClaims = {
  sub?: string;
  email?: string;
  name?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email_verified?: boolean;
  common_name?: string;
  service_token_id?: string;
  service_token_status?: boolean | string;
};

type AccessJwk = JsonWebKey & { kid?: string };

export type AccessJwtEnv = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_JWKS_JSON?: string;
  OIDC_ISSUER?: string;
  OIDC_AUD?: string;
  OIDC_JWKS_JSON?: string;
};

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseJwtPart<T>(part: string, field: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as T;
  } catch {
    throw new HttpError(401, "unauthorized", `Invalid Access JWT ${field}`);
  }
}

async function loadAccessJwks(env: AccessJwtEnv): Promise<{ keys?: AccessJwk[] }> {
  const configuredJwks = env.OIDC_JWKS_JSON?.trim() || env.ACCESS_JWKS_JSON?.trim();
  if (configuredJwks) {
    try {
      return JSON.parse(configuredJwks) as { keys?: AccessJwk[] };
    } catch {
      throw new HttpError(500, "misconfigured", "configured JWKS JSON is not valid JSON");
    }
  }
  const oidcIssuer = env.OIDC_ISSUER?.trim().replace(/\/+$/u, "");
  if (oidcIssuer) {
    if (!oidcIssuer.startsWith("https://")) {
      throw new HttpError(500, "misconfigured", "OIDC_ISSUER must use https");
    }
    const discovery = await fetch(`${oidcIssuer}/.well-known/openid-configuration`);
    if (!discovery.ok) throw new HttpError(500, "misconfigured", "Could not load OIDC discovery document");
    const metadata = await discovery.json<{ jwks_uri?: string }>();
    if (!metadata.jwks_uri?.startsWith("https://")) {
      throw new HttpError(500, "misconfigured", "OIDC discovery returned an invalid jwks_uri");
    }
    const response = await fetch(metadata.jwks_uri);
    if (!response.ok) throw new HttpError(500, "misconfigured", "Could not load OIDC JWKS");
    return response.json();
  }
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!teamDomain) throw new HttpError(500, "misconfigured", "ACCESS_TEAM_DOMAIN is required for Access auth");
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new HttpError(500, "misconfigured", "Could not load Cloudflare Access certificates");
  return response.json();
}

export async function verifyAccessJwt(
  env: AccessJwtEnv,
  token: string,
  options: {
    expectedAudience?: string;
    expectedIssuer?: string;
    requireSubject?: boolean;
  } = {}
): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "unauthorized", "Invalid Access JWT");
  const header = parseJwtPart<{ alg?: string; kid?: string }>(parts[0], "header");
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "unauthorized", "Unsupported Access JWT");
  const jwks = await loadAccessJwks(env);
  const key = jwks.keys?.find((item) => item.kid === header.kid);
  if (!key) throw new HttpError(401, "unauthorized", "Access JWT key not found");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    toArrayBuffer(base64UrlDecode(parts[2])),
    toArrayBuffer(new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  );
  if (!verified) throw new HttpError(401, "unauthorized", "Invalid Access JWT signature");
  const claims = parseJwtPart<AccessClaims>(parts[1], "payload");
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new HttpError(401, "unauthorized", "Access JWT expired or missing expiry");
  }
  if (claims.nbf && claims.nbf > now) throw new HttpError(401, "unauthorized", "Access JWT not yet valid");
  const expectedAudience =
    options.expectedAudience?.trim() ||
    env.OIDC_AUD?.trim() ||
    env.ACCESS_AUD?.trim();
  if (expectedAudience) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!audiences.includes(expectedAudience)) {
      throw new HttpError(401, "unauthorized", "Access JWT audience is not allowed");
    }
  }
  const expectedIssuer =
    options.expectedIssuer?.trim().replace(/\/+$/u, "") ||
    env.OIDC_ISSUER?.trim().replace(/\/+$/u, "") ||
    (env.ACCESS_TEAM_DOMAIN?.trim() ? `https://${env.ACCESS_TEAM_DOMAIN.trim()}` : "");
  if (expectedIssuer && claims.iss !== expectedIssuer) {
    throw new HttpError(401, "unauthorized", "Access JWT issuer is not allowed");
  }
  if (options.requireSubject !== false && !claims.sub?.trim()) {
    throw new HttpError(401, "unauthorized", "Access JWT subject is missing");
  }
  return claims;
}
