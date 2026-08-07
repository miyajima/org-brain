import { HttpError, MEMORY_WORK_TYPES, ulid, type MemoryWorkType } from "@org-brain/shared";
import type { Env } from "./types";

type CategoryRow = {
  id: string;
  tenant_id: string;
  slug: string;
  label: string;
  description: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
};

function objectBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "invalid_payload", "request body must be an object");
  }
  return raw as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field}_required`, `${field} is required`);
    return null;
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, `invalid_${field}`, `${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

export async function listBusinessCategories(
  env: Env,
  tenantId: string,
  includeInactive = false
) {
  const result = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, slug, label, description, is_active, created_at, updated_at
     FROM business_categories
     WHERE tenant_id = ? AND (? = 1 OR is_active = 1)
     ORDER BY label, slug`
  ).bind(tenantId, includeInactive ? 1 : 0).all<CategoryRow>();
  return result.results;
}

export async function createBusinessCategory(env: Env, tenantId: string, raw: unknown) {
  const body = objectBody(raw);
  const slug = text(body.slug, "business_category_slug", 64, true)!.toLowerCase();
  const label = text(body.label, "business_category_label", 160, true)!;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new HttpError(400, "invalid_business_category_slug", "slug must use lowercase letters, digits, underscore, or hyphen");
  }
  const now = Date.now();
  const category = {
    id: typeof body.id === "string" && body.id.trim() ? body.id.trim().slice(0, 128) : ulid(now),
    tenant_id: tenantId,
    slug,
    label,
    description: text(body.description, "business_category_description", 1000),
    is_active: body.is_active === false ? 0 : 1,
    created_at: now,
    updated_at: now
  };
  try {
    await env.OPEN_BRAIN_DB.prepare(
      `INSERT INTO business_categories(
         id, tenant_id, slug, label, description, is_active, created_at, updated_at
       ) VALUES(?,?,?,?,?,?,?,?)`
    ).bind(...Object.values(category)).run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new HttpError(409, "business_category_slug_conflict", "category slug already exists for tenant");
    }
    throw error;
  }
  return category;
}

export async function updateBusinessCategory(
  env: Env,
  tenantId: string,
  categoryId: string,
  raw: unknown
) {
  const body = objectBody(raw);
  const current = await env.OPEN_BRAIN_DB.prepare(
    "SELECT * FROM business_categories WHERE tenant_id = ? AND id = ?"
  ).bind(tenantId, categoryId).first<CategoryRow>();
  if (!current) throw new HttpError(404, "business_category_not_found", "business category not found");
  const slug = body.slug === undefined
    ? current.slug
    : text(body.slug, "business_category_slug", 64, true)!.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(slug)) {
    throw new HttpError(400, "invalid_business_category_slug", "invalid category slug");
  }
  const updated = {
    ...current,
    slug,
    label: body.label === undefined ? current.label : text(body.label, "business_category_label", 160, true)!,
    description: body.description === undefined
      ? current.description
      : text(body.description, "business_category_description", 1000),
    is_active: body.is_active === undefined ? current.is_active : body.is_active ? 1 : 0,
    updated_at: Date.now()
  };
  await env.OPEN_BRAIN_DB.prepare(
    `UPDATE business_categories
     SET slug = ?, label = ?, description = ?, is_active = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ?`
  ).bind(updated.slug, updated.label, updated.description, updated.is_active, updated.updated_at, tenantId, categoryId).run();
  return updated;
}

export async function validateBusinessClassification(
  env: Env,
  tenantId: string,
  businessCategoryId: string | null | undefined,
  workType: string | null | undefined,
  options: { required?: boolean } = {}
): Promise<{ business_category_id: string | null; work_type: MemoryWorkType | null; classification_warning?: string[] }> {
  const categoryId = businessCategoryId?.trim() || null;
  const normalizedWorkType = workType?.trim() || null;
  if (normalizedWorkType && !MEMORY_WORK_TYPES.includes(normalizedWorkType as MemoryWorkType)) {
    throw new HttpError(400, "invalid_work_type", "work_type is not supported");
  }
  if (categoryId) {
    const category = await env.OPEN_BRAIN_DB.prepare(
      "SELECT id FROM business_categories WHERE tenant_id = ? AND id = ? AND is_active = 1"
    ).bind(tenantId, categoryId).first<{ id: string }>();
    if (!category) throw new HttpError(400, "invalid_business_category", "category is missing, inactive, or belongs to another tenant");
  }
  if (options.required && !categoryId) {
    throw new HttpError(400, "business_category_required", "business_category_id is required");
  }
  if (options.required && !normalizedWorkType) {
    throw new HttpError(400, "work_type_required", "work_type is required");
  }
  const warnings = [
    ...(!categoryId ? ["business_category_unclassified"] : []),
    ...(!normalizedWorkType ? ["work_type_unclassified"] : [])
  ];
  return {
    business_category_id: categoryId,
    work_type: normalizedWorkType as MemoryWorkType | null,
    ...(warnings.length ? { classification_warning: warnings } : {})
  };
}
