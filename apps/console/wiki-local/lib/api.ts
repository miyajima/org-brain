let csrf = "";
type ApiValue = Record<string, any>;
async function decode(response: Response): Promise<ApiValue> {
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_api_response");
  const result = value as ApiValue;
  if (!response.ok)
    throw new Error(String(result.error || "wiki_request_failed"));
  return result;
}
export async function apiStatus() {
  const value = await decode(
    await fetch("/api/v1/features/llm-wiki", { cache: "no-store" }),
  );
  csrf = value.csrf;
  return value;
}
async function post(path: string, input: unknown) {
  if (!csrf) await apiStatus();
  return decode(
    await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wiki-csrf": csrf },
      body: JSON.stringify(input),
    }),
  );
}
export function request(input: Record<string, unknown>) {
  return post("/api/v1/wiki/request", input);
}
export function setFeature(enabled: boolean, auto_maintenance: boolean) {
  return post("/api/v1/features/llm-wiki", { enabled, auto_maintenance });
}
export function showError(error: unknown) {
  const element = document.querySelector<HTMLElement>("#error");
  if (element) {
    element.hidden = false;
    element.textContent =
      error instanceof Error ? error.message : String(error);
  } else console.error(error);
}
