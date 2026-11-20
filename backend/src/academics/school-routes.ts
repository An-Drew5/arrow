import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/service";
import { HttpError } from "../shared/errors/http-error";
import { asyncHandler } from "../shared/middleware/async-handler";
import { requirePermission } from "../shared/middleware/require-permission";
import { tenantContext } from "../shared/middleware/tenant-context";
import type { RequestWithTenant } from "../shared/middleware/request-context";

const scaleKind = z.enum(["letter", "proficiency", "number"]);
const settingsPatchSchema = z.object({
  positionBasis: z.enum(["best_n", "all_subjects"]).optional(),
  aggregateSubjectCount: z.number().int().min(1).max(12).optional(),
  passMark: z.number().int().min(0).max(100).optional(),
  lateCountsAsPresent: z.boolean().optional(),
  sbaExamGapThreshold: z.number().int().min(0).max(100).optional(),
  reportScaleKinds: z.object({
    primary: z.array(scaleKind).min(1).max(3),
    jhs: z.array(scaleKind).min(1).max(3),
  }).strict().optional(),
}).strict();

const profilePatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  region: z.string().trim().max(100).nullable().optional(),
  districtDirectorate: z.string().trim().max(160).nullable().optional(),
  headteacherName: z.string().trim().max(160).nullable().optional(),
}).strict();

export const schoolRoutes = Router();
schoolRoutes.use(tenantContext);

schoolRoutes.get(
  "/school/settings",
  requirePermission("settings:manage"),
  asyncHandler(async (request, response) => {
    const { claims, tx } = (request as RequestWithTenant).tenantContext;
    const settings = await sql`
      SELECT position_basis AS "positionBasis",
        aggregate_subject_count AS "aggregateSubjectCount",
        pass_mark AS "passMark",
        late_counts_as_present AS "lateCountsAsPresent",
        sba_exam_gap_threshold AS "sbaExamGapThreshold",
        report_scale_kinds AS "reportScaleKinds"
      FROM school_settings WHERE school_id = ${claims.schoolId!}::uuid
    `.execute(tx);
    if (!settings.rows[0]) throw new HttpError(404, "NOT_FOUND", "School settings not found");
    response.json(settings.rows[0]);
  }),
);

schoolRoutes.patch(
  "/school/settings",
  requirePermission("settings:manage"),
  asyncHandler(async (request, response) => {
    const parsed = settingsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
    }
    if (Object.keys(parsed.data).length === 0) {
      throw new HttpError(400, "VALIDATION_ERROR", "Provide at least one setting to update");
    }
    const { claims, tx } = (request as RequestWithTenant).tenantContext;
    const schoolId = claims.schoolId!;
    const result = await sql`
      UPDATE school_settings SET
        position_basis = COALESCE(${parsed.data.positionBasis ?? null}, position_basis),
        aggregate_subject_count = COALESCE(${parsed.data.aggregateSubjectCount ?? null}, aggregate_subject_count),
        pass_mark = COALESCE(${parsed.data.passMark ?? null}, pass_mark),
        late_counts_as_present = COALESCE(${parsed.data.lateCountsAsPresent ?? null}, late_counts_as_present),
        sba_exam_gap_threshold = COALESCE(${parsed.data.sbaExamGapThreshold ?? null}, sba_exam_gap_threshold),
        report_scale_kinds = COALESCE(${parsed.data.reportScaleKinds
          ? JSON.stringify(parsed.data.reportScaleKinds)
          : null}::jsonb, report_scale_kinds)
      WHERE school_id = ${schoolId}::uuid
      RETURNING position_basis AS "positionBasis",
        aggregate_subject_count AS "aggregateSubjectCount",
        pass_mark AS "passMark",
        late_counts_as_present AS "lateCountsAsPresent",
        sba_exam_gap_threshold AS "sbaExamGapThreshold",
        report_scale_kinds AS "reportScaleKinds"
    `.execute(tx);
    if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "School settings not found");
    await recordAudit(tx, {
      schoolId,
      userId: claims.userId,
      action: "school.settings_updated",
      resourceType: "school_settings",
      resourceId: schoolId,
      metadata: parsed.data,
    });
    response.json(result.rows[0]);
  }),
);

schoolRoutes.get(
  "/school/profile",
  requirePermission("students:read"),
  asyncHandler(async (request, response) => {
    const { claims, tx } = (request as RequestWithTenant).tenantContext;
    const result = await sql`
      SELECT id, name, slug, region, address, phone, email,
        district_directorate AS "districtDirectorate",
        headteacher_name AS "headteacherName"
      FROM schools WHERE id = ${claims.schoolId!}::uuid
    `.execute(tx);
    if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "School profile not found");
    response.json(result.rows[0]);
  }),
);

schoolRoutes.patch(
  "/school/profile",
  requirePermission("settings:manage"),
  asyncHandler(async (request, response) => {
    const parsed = profilePatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
    }
    if (Object.keys(parsed.data).length === 0) {
      throw new HttpError(400, "VALIDATION_ERROR", "Provide at least one profile field to update");
    }
    const { claims, tx } = (request as RequestWithTenant).tenantContext;
    const schoolId = claims.schoolId!;
    const result = await sql`
      UPDATE schools SET
        name = COALESCE(${parsed.data.name ?? null}, name),
        address = CASE WHEN ${parsed.data.address === undefined} THEN address ELSE ${parsed.data.address ?? null} END,
        phone = CASE WHEN ${parsed.data.phone === undefined} THEN phone ELSE ${parsed.data.phone ?? null} END,
        email = CASE WHEN ${parsed.data.email === undefined} THEN email ELSE ${parsed.data.email ?? null} END,
        region = CASE WHEN ${parsed.data.region === undefined} THEN region ELSE ${parsed.data.region ?? null} END,
        district_directorate = CASE WHEN ${parsed.data.districtDirectorate === undefined}
          THEN district_directorate ELSE ${parsed.data.districtDirectorate ?? null} END,
        headteacher_name = CASE WHEN ${parsed.data.headteacherName === undefined}
          THEN headteacher_name ELSE ${parsed.data.headteacherName ?? null} END
      WHERE id = ${schoolId}::uuid
      RETURNING id, name, slug, region, address, phone, email,
        district_directorate AS "districtDirectorate",
        headteacher_name AS "headteacherName"
    `.execute(tx);
    if (!result.rows[0]) throw new HttpError(404, "NOT_FOUND", "School profile not found");
    await recordAudit(tx, {
      schoolId,
      userId: claims.userId,
      action: "school.profile_updated",
      resourceType: "school",
      resourceId: schoolId,
      metadata: parsed.data,
    });
    response.json(result.rows[0]);
  }),
);
