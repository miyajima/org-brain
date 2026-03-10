const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(seed = Date.now()): string {
  const time = encodeTime(seed, 10);
  const random = encodeRandom(16);
  return `${time}${random}`;
}

function encodeTime(time: number, length: number): string {
  let out = "";
  let value = time;
  for (let i = 0; i < length; i += 1) {
    out = ENCODING[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ENCODING[bytes[i] % 32];
  }
  return out;
}
