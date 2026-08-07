const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function opsAlertUlid(seed = Date.now()) {
  let timestamp = Math.floor(seed);
  let time = "";
  for (let index = 0; index < 10; index += 1) {
    time = ENCODING[timestamp % 32] + time;
    timestamp = Math.floor(timestamp / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (byte) => ENCODING[byte % 32]).join("");
  return `${time}${random}`;
}
