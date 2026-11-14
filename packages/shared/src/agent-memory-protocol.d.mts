import type { ZodObject, ZodRawShape } from "zod";

export interface AmpBackend {
  request(input: Record<string, any>): Promise<Record<string, any>>;
}
export interface AmpRuntime {
  saveAmp(wiki: AmpBackend, input: unknown): Promise<Record<string, any>>;
  searchAmp(wiki: AmpBackend, input: unknown): Promise<Record<string, any>>;
  readAmp(wiki: AmpBackend, input: unknown): Promise<Record<string, any>>;
  validateAmpPage(wiki: AmpBackend, input: unknown): Promise<Record<string, any>>;
  projectIndexContext(wiki: AmpBackend, input: Record<string, any>): Promise<Record<string, any> | undefined>;
}
export const AMP_INPUT_SCHEMAS: Record<"save" | "search" | "read" | "validate", ZodObject<ZodRawShape>>;
export const AMP_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
export function ampJsonSchema(): Record<string, unknown>;
export function parseAmpPage(content: string): Record<string, any>;
export function projectIndexPath(projectId: string): string;
export function countAmpTokens(value: unknown): number;
export function createAmpRuntime(dependencies: {
  countTokens(value: unknown): number;
  recall(wiki: AmpBackend, input: Record<string, any>): Promise<Record<string, any>>;
  readArguments?(args: Record<string, unknown>): Record<string, unknown>;
}): AmpRuntime;
