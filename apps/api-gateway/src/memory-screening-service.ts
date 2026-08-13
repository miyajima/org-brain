import { HttpError, screenMemoryText, screenSensitiveMemory } from "@org-brain/shared";

export function screenMemoryWriteText(value: string, field: string): string {
  const screened = screenMemoryText(value);
  if (screened.unsafe_instruction) {
    throw new HttpError(400, "unsafe_instruction", `${field} contains a prompt-injection instruction`);
  }
  return screened.text;
}

export function screenOptionalMemoryWriteText(value: string | null | undefined, field: string): string | null {
  return value == null ? null : screenMemoryWriteText(value, field);
}

export function screenMemoryCaptureText(
  value: string,
  field: string,
  options: { visibility?: string | null; allowedPrincipals?: string[] } = {}
): string {
  const injectionScreen = screenMemoryText(value);
  if (injectionScreen.unsafe_instruction) {
    throw new HttpError(400, "unsafe_instruction", `${field} contains a prompt-injection instruction`);
  }
  const principals = options.allowedPrincipals ?? [];
  const screened = screenSensitiveMemory(value, {
    mode: options.visibility === "restricted" ? "restricted_7d" : "deny",
    allowed_principals: principals
  });
  if (!screened.allowed) {
    throw new HttpError(
      400,
      screened.hard_reject ? "credential_detected" : "sensitive_memory_denied",
      screened.hard_reject
        ? `${field} contains credential material and cannot be persisted`
        : `${field} contains sensitive data and requires restricted visibility with allowed principals`
    );
  }
  return screened.text;
}
