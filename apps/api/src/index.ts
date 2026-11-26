import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { createLogger } from './logger.js';
import { createRedisJobEventBus } from './modules/jobs/job.events.js';
import { createMemoryCounters, createSharedCounters } from './rate-limit-store.js';
import { createMongoRepositories } from './repositories.js';
import { createStorage, prepareStorage } from './storage/index.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config);
  await connectDb(config.MONGODB_URI);
  logger.info('connected to mongodb');

  const storage = createStorage(config);
  await prepareStorage(storage);
  logger.info({ driver: config.STORAGE_DRIVER }, 'file storage ready');

  // One shared Redis subscriber per process fans live job updates out to every open stream.
  const jobEvents = createRedisJobEventBus(config.REDIS_URL, logger);

  // Rate-limit counters shared by every api process (ADR 0028).
  const counters =
    config.RATE_LIMIT_STORE === 'redis'
      ? createSharedCounters(config.REDIS_URL, logger)
      : createMemoryCounters();

  const app = createApp({
    config,
    logger,
    repos: createMongoRepositories(),
    storage,
    jobEvents,
    counters,
  });
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    // Open event streams would keep server.close() waiting; end them.
    server.closeAllConnections();
    server.close(() => {
      Promise.all([jobEvents.close(), counters.close(), disconnectDb()]).then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'error while disconnecting');
          process.exit(1);
        },
      );
    });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  console.error('api failed to start:', error);
  process.exit(1);
});
