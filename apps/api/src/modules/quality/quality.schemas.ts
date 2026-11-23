import { z } from 'zod';

import { MAX_FIELD_OVERRIDES, QUALITY_RULES, type QualityRuleId } from './quality.types.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');

export const qualityParams = z.strictObject({ projectId: objectId });
export const qualityRunParams = z.strictObject({ projectId: objectId, runId: objectId });
export const listQualityRunsQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

type Direction = 'min' | 'max';

/** `fail` is checked before `warn`: for `min` rules it must not be above warn, else not below. */
function ordered(direction: Direction) {
  return (o: { warn?: number | undefined; fail?: number | null | undefined }) =>
    o.warn === undefined ||
    o.fail === undefined ||
    o.fail === null ||
    (direction === 'min' ? o.fail <= o.warn : o.fail >= o.warn);
}

function orderMessage(direction: Direction) {
  return direction === 'min' ? 'fail must not be above warn' : 'fail must not be below warn';
}

function threshold(max: number) {
  return z.number().min(0).max(max, `must be at most ${max}`);
}

function ruleOverride(rule: QualityRuleId) {
  const { direction, max } = QUALITY_RULES[rule];
  return z
    .strictObject({
      enabled: z.boolean().optional(),
      warn: threshold(max).optional(),
      fail: threshold(max).nullable().optional(),
    })
    .refine(ordered(direction), { message: orderMessage(direction), path: ['fail'] })
    .optional();
}

const fieldOverride = z
  .strictObject({
    warn: threshold(100).optional(),
    fail: threshold(100).nullable().optional(),
  })
  .refine(ordered('min'), { message: orderMessage('min'), path: ['fail'] });

/**
 * PUT .../quality/rules: the project's overrides, replacing the stored ones. Unknown rules,
 * `customer_id_unique` (fixed at 100%) and thresholds out of range are refused.
 */
export const putQualityRulesBody = z.strictObject({
  rules: z
    .strictObject({
      completeness_required: ruleOverride('completeness_required'),
      completeness_optional: ruleOverride('completeness_optional'),
      validity: ruleOverride('validity'),
      phone_shared: ruleOverride('phone_shared'),
      email_shared: ruleOverride('email_shared'),
      city_pin_consistency: ruleOverride('city_pin_consistency'),
      clustering_freshness: ruleOverride('clustering_freshness'),
      sql_run_freshness: ruleOverride('sql_run_freshness'),
      row_count_change: ruleOverride('row_count_change'),
    })
    .default({}),
  fields: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be a field name'), fieldOverride)
    .refine((fields) => Object.keys(fields).length <= MAX_FIELD_OVERRIDES, {
      message: `at most ${MAX_FIELD_OVERRIDES} fields`,
    })
    .default({}),
});
export type PutQualityRulesBody = z.infer<typeof putQualityRulesBody>;
