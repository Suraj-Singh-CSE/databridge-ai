import { defineApiSuite } from './support/api-suite.js';
import { defineJobsSuite } from './support/jobs-suite.js';
import {
  createMemoryRepositories,
  type MemoryRepositories,
} from './support/memory-repositories.js';
import { defineSourcesSuite } from './support/sources-suite.js';

const harness = { setup: () => Promise.resolve(createMemoryRepositories()) };

defineApiSuite('in-memory repositories', harness);
defineSourcesSuite('in-memory repositories', harness);
defineJobsSuite('in-memory repositories', {
  ...harness,
  async workerUpdate(repos, jobId, patch) {
    await Promise.resolve();
    (repos as MemoryRepositories).jobs.workerUpdate(jobId, patch);
  },
});
