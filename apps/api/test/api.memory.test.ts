import { defineApiSuite } from './support/api-suite.js';
import { defineJobsSuite } from './support/jobs-suite.js';
import {
  createMemoryRepositories,
  type MemoryRepositories,
} from './support/memory-repositories.js';
import { defineMappingsSuite } from './support/mappings-suite.js';
import { defineProfilesSuite } from './support/profiles-suite.js';
import { defineSourcesSuite } from './support/sources-suite.js';

const harness = { setup: () => Promise.resolve(createMemoryRepositories()) };

defineApiSuite('in-memory repositories', harness);
defineSourcesSuite('in-memory repositories', harness);
defineProfilesSuite('in-memory repositories', {
  ...harness,
  async workerProfile(repos, write) {
    await Promise.resolve();
    (repos as MemoryRepositories).columnProfiles.workerSave(write);
  },
});
defineJobsSuite('in-memory repositories', {
  ...harness,
  async workerUpdate(repos, jobId, patch) {
    await Promise.resolve();
    (repos as MemoryRepositories).jobs.workerUpdate(jobId, patch);
  },
});
defineMappingsSuite('in-memory repositories', {
  ...harness,
  async markProfiled(repos, projectId, sourceId) {
    await Promise.resolve();
    (repos as MemoryRepositories).columnProfiles.workerSave({
      projectId,
      sourceId,
      columns: [],
      source: { status: 'profiled' },
    });
  },
  async workerSuggest(repos, write) {
    await Promise.resolve();
    (repos as MemoryRepositories).mappings.workerSave(write);
  },
});
