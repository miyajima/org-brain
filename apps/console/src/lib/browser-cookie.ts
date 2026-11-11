// Reads one cookie from a `document.cookie`-style string. Malformed percent-encoding
// falls back to the raw value instead of throwing, so a bad cookie cannot break a page script.
export function readBrowserCookie(cookieString: string, name: string): string | null {
  const entry = cookieString.split("; ").find((part) => part.startsWith(`${name}=`));
  if (entry === undefined) return null;
  const raw = entry.slice(name.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
