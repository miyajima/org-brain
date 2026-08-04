import { HttpError, screenMemoryText } from "@org-brain/shared";

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
