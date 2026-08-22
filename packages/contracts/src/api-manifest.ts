import { z } from "zod";
import { orgPermissionSchema } from "./auth.js";

export const API_MANIFEST_VERSION = "orgbrain-api-manifest/v1" as const;
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

export const apiRouteManifestEntrySchema = z.object({
  method: z.enum(HTTP_METHODS),
  path: z.string().startsWith("/"),
  permission: orgPermissionSchema.nullable(),
  request_schema: z.string().nullable(),
  response_schema: z.string().nullable(),
  success_statuses: z.array(z.number().int().min(200).max(399)).min(1),
  idempotent: z.boolean()
});

export const apiManifestSchema = z.object({
  contract_version: z.literal(API_MANIFEST_VERSION),
  oss_ref: z.string().regex(/^[0-9a-f]{40}$/u),
  generated_at: z.string().datetime(),
  routes: z.array(apiRouteManifestEntrySchema)
});

export type ApiRouteManifestEntry = z.infer<typeof apiRouteManifestEntrySchema>;
export type ApiManifest = z.infer<typeof apiManifestSchema>;
