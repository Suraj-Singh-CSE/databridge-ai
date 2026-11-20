import { defineApiSuite } from './support/api-suite.js';
import { createMemoryRepositories } from './support/memory-repositories.js';

defineApiSuite('in-memory repositories', {
  setup: () => Promise.resolve(createMemoryRepositories()),
});
