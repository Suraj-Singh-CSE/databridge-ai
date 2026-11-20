import mongoose from 'mongoose';

import { connectDb } from '../../src/db.js';

const DEFAULT_TEST_URI = 'mongodb://localhost:27017/databridge_test';

/**
 * Connects to the test database. Returns false when MongoDB is unreachable so local runs can
 * skip DB-backed tests; in CI (CI=true) an unreachable database is a hard failure instead.
 */
export async function connectTestDb(): Promise<boolean> {
  const uri = process.env.MONGODB_URI ?? DEFAULT_TEST_URI;
  try {
    await connectDb(uri, { serverSelectionTimeoutMS: process.env.CI === 'true' ? 15_000 : 1_500 });
    return true;
  } catch (error) {
    if (process.env.CI === 'true') {
      throw new Error(`MongoDB is required in CI but ${uri} is unreachable`, { cause: error });
    }
    // Written to stderr directly: Vitest drops console output from files with no running tests.
    process.stderr.write(
      `\n[skip] MongoDB-backed tests skipped: ${uri} is unreachable. ` +
        'Start MongoDB (or set MONGODB_URI) to run them; CI always runs them.\n',
    );
    await mongoose.disconnect();
    return false;
  }
}

/** Empties every collection while keeping indexes (unique email, TTL). */
export async function clearDb(): Promise<void> {
  const collections = await mongoose.connection.db?.collections();
  await Promise.all((collections ?? []).map((c) => c.deleteMany({})));
}
