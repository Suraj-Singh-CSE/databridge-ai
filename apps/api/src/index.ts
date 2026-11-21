import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { createLogger } from './logger.js';
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

  const app = createApp({ config, logger, repos: createMongoRepositories(), storage });
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      disconnectDb().then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, 'error while disconnecting from mongodb');
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
