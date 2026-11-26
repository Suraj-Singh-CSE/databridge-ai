import mongoose from 'mongoose';

import type { Logger } from './logger.js';
import type { RetentionSettings } from './modules/retention/retention.service.js';
import { ONE_APPROVED_SQL_INDEX, SqlVersionModel } from './modules/sql/sql.model.js';

const DAY_SECONDS = 24 * 60 * 60;
const NAMESPACE_NOT_FOUND = 26;

type IndexLogger = Pick<Logger, 'info' | 'warn'>;

/** A TTL index the api keeps in step with its settings (ADR 0029). */
interface TtlIndex {
  collection: string;
  field: string;
  name: string;
  days: number;
}

export function ttlIndexes(settings: RetentionSettings): TtlIndex[] {
  return [
    // Only finished jobs have a finishedAt (null while queued or running): never expired early.
    {
      collection: 'jobs',
      field: 'finishedAt',
      name: 'ttl_finished',
      days: settings.JOB_RETENTION_DAYS,
    },
    {
      collection: 'llm_calls',
      field: 'created_at',
      name: 'ttl_created',
      days: settings.LLM_CALL_RETENTION_DAYS,
    },
    // Every new turn updates updatedAt, so this is "30 days since the last message".
    {
      collection: 'assistant_conversations',
      field: 'updatedAt',
      name: 'ttl_last_activity',
      days: settings.ASSISTANT_RETENTION_DAYS,
    },
  ];
}

function db() {
  const found = mongoose.connection.db;
  if (!found) throw new Error('not connected to mongodb');
  return found;
}

async function existingIndexes(collection: string) {
  try {
    return await db().collection(collection).indexes();
  } catch (error) {
    if ((error as { code?: unknown }).code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Creates the TTL index, or changes its expiry in place when the setting changed. */
async function ensureTtl({ collection, field, name, days }: TtlIndex): Promise<void> {
  const seconds = days * DAY_SECONDS;
  const existing = (await existingIndexes(collection)).find((index) => index.name === name);
  if (!existing) {
    await db()
      .collection(collection)
      .createIndex({ [field]: 1 }, { name, expireAfterSeconds: seconds }, undefined);
  } else if (existing.expireAfterSeconds !== seconds) {
    await db().command({ collMod: collection, index: { name, expireAfterSeconds: seconds } });
  }
}

/**
 * Supersedes all but the newest approved SQL version of each project (left by the race G3-13
 * fixed), so the one-approved index can be built on an existing database.
 */
async function supersedeDuplicateApprovals(logger: IndexLogger): Promise<void> {
  const groups = await SqlVersionModel.aggregate<{ ids: mongoose.Types.ObjectId[] }>([
    { $match: { status: 'approved' } },
    { $sort: { version: -1 } },
    { $group: { _id: '$projectId', ids: { $push: '$_id' } } },
    { $match: { 'ids.1': { $exists: true } } },
  ]);
  const older = groups.flatMap((g) => g.ids.slice(1));
  if (older.length === 0) return;
  await SqlVersionModel.updateMany(
    { _id: { $in: older }, status: 'approved' },
    { $set: { status: 'superseded', supersededAt: new Date() } },
  );
  logger.warn({ count: older.length }, 'superseded duplicate approved SQL versions');
}

/**
 * Indexes that depend on settings or need existing data repaired first (G3-11, G3-13). Run
 * after connectDb. A failure is logged, not fatal: the api works without them (the checks in
 * the services remain) and the next start tries again.
 */
export async function ensureIndexes(
  settings: RetentionSettings,
  logger: IndexLogger,
): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ...ttlIndexes(settings).map((ttl): [string, () => Promise<void>] => [
      `${ttl.collection}.${ttl.name}`,
      () => ensureTtl(ttl),
    ]),
    [
      `sql_versions.${ONE_APPROVED_SQL_INDEX.name}`,
      async () => {
        await supersedeDuplicateApprovals(logger);
        await SqlVersionModel.collection.createIndex(
          ONE_APPROVED_SQL_INDEX.key,
          {
            name: ONE_APPROVED_SQL_INDEX.name,
            unique: true,
            partialFilterExpression: ONE_APPROVED_SQL_INDEX.partialFilterExpression,
          },
          undefined,
        );
      },
    ],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      logger.warn({ err: error, index: name }, 'could not ensure index');
    }
  }
  logger.info('indexes ensured');
}
