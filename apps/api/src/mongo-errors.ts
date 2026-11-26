import { DuplicateKeyError } from './errors.js';

const MONGO_DUPLICATE_KEY = 11000;

function hasDuplicateCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === MONGO_DUPLICATE_KEY
  );
}

/**
 * A unique index refused the write: a Mongo E11000 (also inside a bulk write's `writeErrors`)
 * or the in-memory repositories' DuplicateKeyError.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (error instanceof DuplicateKeyError || hasDuplicateCode(error)) return true;
  if (typeof error !== 'object' || error === null || !('writeErrors' in error)) return false;
  const { writeErrors } = error;
  return Array.isArray(writeErrors) && writeErrors.some(hasDuplicateCode);
}
