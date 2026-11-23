import { defineApiSuite } from './support/api-suite.js';
import { defineCandidatesSuite } from './support/candidates-suite.js';
import { defineClustersSuite } from './support/clusters-suite.js';
import { defineDashboardSuite } from './support/dashboard-suite.js';
import { defineExportsSuite } from './support/exports-suite.js';
import { defineQualitySuite } from './support/quality-suite.js';
import { defineSqlSuite } from './support/sql-suite.js';
import { defineScoresSuite } from './support/scores-suite.js';
import { defineJobsSuite } from './support/jobs-suite.js';
import type { QualityRun } from '../src/modules/quality/quality.types.js';
import type { SqlVersion } from '../src/modules/sql/sql.types.js';
import type { Repositories } from '../src/repositories.js';

import {
  createMemoryRepositories,
  type CandidateWrite,
  type ClusterWrite,
  type MemoryRepositories,
  type ScoreWrite,
  type StagedWrite,
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
const memoryStaged = {
  ...memoryMappings,
  async workerStage(repos: Repositories, write: StagedWrite) {
    await Promise.resolve();
    (repos as MemoryRepositories).stagedRecords.workerSave(write);
  },
};
defineStagedSuite('in-memory repositories', memoryStaged);
const memoryCandidates = {
  ...memoryStaged,
  async workerCandidates(repos: Repositories, write: CandidateWrite) {
    await Promise.resolve();
    (repos as MemoryRepositories).candidates.workerSave(write);
  },
};
defineCandidatesSuite('in-memory repositories', memoryCandidates);
const memoryScores = {
  ...memoryCandidates,
  async workerScores(repos: Repositories, write: ScoreWrite) {
    await Promise.resolve();
    (repos as MemoryRepositories).scores.workerSave(write);
  },
};
defineScoresSuite('in-memory repositories', memoryScores);
const memoryClusters = {
  ...memoryScores,
  async workerClusters(repos: Repositories, write: ClusterWrite) {
    await Promise.resolve();
    (repos as MemoryRepositories).clusters.workerSave(write);
  },
};
defineClustersSuite('in-memory repositories', memoryClusters);
defineExportsSuite('in-memory repositories', {
  ...memoryClusters,
  async workerExport(repos, record) {
    await Promise.resolve();
    (repos as MemoryRepositories).exports.workerSave(record);
  },
});
defineSqlSuite('in-memory repositories', {
  ...memoryClusters,
  async workerSqlVersion(repos, version) {
    await Promise.resolve();
    (repos as MemoryRepositories).sqlVersions.workerSave(version);
  },
});
const memoryQuality = {
  ...memoryClusters,
  async workerSqlVersion(repos: Repositories, version: SqlVersion) {
    await Promise.resolve();
    (repos as MemoryRepositories).sqlVersions.workerSave(version);
  },
  async workerQualityRun(repos: Repositories, run: QualityRun) {
    await Promise.resolve();
    (repos as MemoryRepositories).quality.workerSave(run);
  },
};
defineQualitySuite('in-memory repositories', memoryQuality);
defineDashboardSuite('in-memory repositories', {
  ...memoryQuality,
  async workerExport(repos, record) {
    await Promise.resolve();
    (repos as MemoryRepositories).exports.workerSave(record);
  },
  async workerUpdate(repos, jobId, patch) {
    await Promise.resolve();
    (repos as MemoryRepositories).jobs.workerUpdate(jobId, patch);
  },
  async workerLlmCall(repos, call) {
    await Promise.resolve();
    (repos as MemoryRepositories).dashboard.workerLlmCall(call);
  },
});
