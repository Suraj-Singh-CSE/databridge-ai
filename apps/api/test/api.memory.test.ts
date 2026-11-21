import { defineApiSuite } from './support/api-suite.js';
import { createMemoryRepositories } from './support/memory-repositories.js';
import { defineSourcesSuite } from './support/sources-suite.js';

const harness = { setup: () => Promise.resolve(createMemoryRepositories()) };

defineApiSuite('in-memory repositories', harness);
defineSourcesSuite('in-memory repositories', harness);
