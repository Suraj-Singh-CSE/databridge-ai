import { z } from 'zod';

import { DASHBOARD_RANGES, type DashboardRange } from './dashboard.types.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const RANGES = Object.keys(DASHBOARD_RANGES) as [DashboardRange, ...DashboardRange[]];

export const dashboardParams = z.strictObject({ projectId: objectId });
export const dashboardQuery = z.strictObject({
  range: z.enum(RANGES).default('30d'),
});
