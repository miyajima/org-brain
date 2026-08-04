export type ConsoleAccessEnv = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_JWKS_JSON?: string;
  ACCESS_JWT_REQUIRED?: string;
};

type AccessClaims = {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
};

type AccessJwk = JsonWebKey & { kid?: string };

export class AccessJwtError extends Error {
  constructor(readonly status: 401 | 500, message: string) {
    super(message);
  }
}

function decodeBase64Url(input: string): Uint8Array {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new AccessJwtError(401, "Invalid Cloudflare Access JWT encoding");
  }
}

function parsePart<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as T;
  } catch (error) {
    if (error instanceof AccessJwtError) throw error;
    throw new AccessJwtError(401, "Invalid Cloudflare Access JWT payload");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function loadJwks(env: ConsoleAccessEnv): Promise<{ keys?: AccessJwk[] }> {
  if (env.ACCESS_JWKS_JSON?.trim()) {
    try {
      return JSON.parse(env.ACCESS_JWKS_JSON) as { keys?: AccessJwk[] };
    } catch {
      throw new AccessJwtError(500, "ACCESS_JWKS_JSON is not valid JSON");
    }
  }
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  if (!teamDomain) throw new AccessJwtError(500, "ACCESS_TEAM_DOMAIN is required");
  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new AccessJwtError(500, "Could not load Cloudflare Access certificates");
  return response.json();
}

export function accessJwtRequired(env: ConsoleAccessEnv): boolean {
  return env.ACCESS_JWT_REQUIRED?.trim().toLowerCase() !== "false";
}

export async function verifyConsoleAccessJwt(env: ConsoleAccessEnv, token: string): Promise<AccessClaims> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
  const expectedAudience = env.ACCESS_AUD?.trim();
  if (!teamDomain || !expectedAudience) {
    throw new AccessJwtError(500, "ACCESS_TEAM_DOMAIN and ACCESS_AUD are required");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessJwtError(401, "Invalid Cloudflare Access JWT");
  const header = parsePart<{ alg?: string; kid?: string }>(parts[0]);
  if (header.alg !== "RS256" || !header.kid) {
    throw new AccessJwtError(401, "Unsupported Cloudflare Access JWT");
  }
  const jwks = await loadJwks(env);
  const jwk = jwks.keys?.find((candidate) => candidate.kid === header.kid);
  if (!jwk) throw new AccessJwtError(401, "Cloudflare Access JWT key not found");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    toArrayBuffer(decodeBase64Url(parts[2])),
    toArrayBuffer(new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  );
  if (!verified) throw new AccessJwtError(401, "Invalid Cloudflare Access JWT signature");
  const claims = parsePart<AccessClaims>(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || typeof claims.exp !== "number") {
    throw new AccessJwtError(401, "Cloudflare Access JWT is missing required claims");
  }
  if (claims.exp <= now) throw new AccessJwtError(401, "Cloudflare Access JWT expired");
  if (typeof claims.nbf === "number" && claims.nbf > now) {
    throw new AccessJwtError(401, "Cloudflare Access JWT is not yet valid");
  }
  if (claims.iss !== `https://${teamDomain}`) {
    throw new AccessJwtError(401, "Cloudflare Access JWT issuer is not allowed");
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(expectedAudience)) {
    throw new AccessJwtError(401, "Cloudflare Access JWT audience is not allowed");
  }
  return claims;
}
