// Optional trust bridge. Keys are configured per tenant/principal; never taken from requests.
function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,''); }
function decode(value) { return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0)); }
async function key(secret,usage) {
  if (typeof secret!=='string'||secret.length<32) throw new Error('use_attestation_key_too_short');
  return crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,[usage]);
}
export async function signMemoryUseAttestation(proof,secret) {
  const bytes=new TextEncoder().encode(JSON.stringify({v:1,...proof}));
  if (bytes.length>2500) throw new Error('use_attestation_too_large');
  const signature=await crypto.subtle.sign('HMAC',await key(secret,'sign'),bytes);
  return `${encode(bytes)}.${encode(new Uint8Array(signature))}`;
}
export async function verifyMemoryUseAttestation(token,{secret,tenant,principal,now=Date.now()}) {
  if (!secret||!tenant||!principal||typeof token!=='string'||token.length>4096) return null;
  try {
    const parts=token.split('.');
    if (parts.length!==2) return null;
    const bytes=decode(parts[0]);
    if (!await crypto.subtle.verify('HMAC',await key(secret,'verify'),decode(parts[1]),bytes)) return null;
    const proof=JSON.parse(new TextDecoder().decode(bytes));
    if (proof.v!==1||proof.tenant_id!==tenant||proof.principal!==principal||typeof proof.text!=='string'||proof.text.length>1000
      ||!Number.isFinite(proof.created_at)||proof.created_at>now||!Number.isFinite(proof.expires_at)||proof.expires_at<=now
      ||proof.expires_at-proof.created_at>90*86400000) return null;
    return {...proof,verified:true};
  } catch { return null; }
}
