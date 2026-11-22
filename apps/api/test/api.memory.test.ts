import { defineApiSuite } from './support/api-suite.js';
import { defineJobsSuite } from './support/jobs-suite.js';
import type { Repositories } from '../src/repositories.js';

import {
  createMemoryRepositories,
  type MemoryRepositories,
  type SuggestionWrite,
} from './support/memory-repositories.js';
import { defineMappingsSuite } from './support/mappings-suite.js';
import { defineProfilesSuite } from './support/profiles-suite.js';
import { defineSourcesSuite } from './support/sources-suite.js';
import { defineStagedSuite } from './support/staged-suite.js';

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
const memoryMappings = {
  ...harness,
  async markProfiled(repos: Repositories, projectId: string, sourceId: string) {
    await Promise.resolve();
    (repos as MemoryRepositories).columnProfiles.workerSave({
      projectId,
      sourceId,
      columns: [],
      source: { status: 'profiled' },
    });
  },
  async workerSuggest(repos: Repositories, write: SuggestionWrite) {
    await Promise.resolve();
    (repos as MemoryRepositories).mappings.workerSave(write);
  },
};
defineMappingsSuite('in-memory repositories', memoryMappings);
defineStagedSuite('in-memory repositories', {
  ...memoryMappings,
  async workerStage(repos, write) {
    await Promise.resolve();
    (repos as MemoryRepositories).stagedRecords.workerSave(write);
  },
});
