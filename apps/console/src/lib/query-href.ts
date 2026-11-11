// Builds a same-page href from the current query string. Null, undefined and empty overrides remove the key.
export function queryHref(
  url: URL,
  params: URLSearchParams,
  overrides: Record<string, string | null | undefined>
): string {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined || value === "") {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  const queryString = next.toString();
  return queryString ? `${url.pathname}?${queryString}` : url.pathname;
}
