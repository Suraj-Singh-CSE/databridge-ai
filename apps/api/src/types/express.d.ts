import type { AccessClaims } from '../modules/auth/tokens.js';
import type { ProjectAccess } from '../middleware/require-project-access.js';
import type { Job } from '../modules/jobs/job.types.js';
import type { Project } from '../modules/projects/project.types.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `authenticate`. */
    user?: AccessClaims;
    /** Set by `requireProjectAccess`. */
    project?: Project;
    projectAccess?: ProjectAccess;
    /** Set by the job routes once the caller's access to the job's project is checked. */
    job?: Job;
    /** Parsed values set by `validate`; read them with `validated()`. */
    validated?: { body?: unknown; params?: unknown; query?: unknown };
  }
}
