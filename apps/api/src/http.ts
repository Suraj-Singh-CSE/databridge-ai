import type { Response } from 'express';

/** Sends `data` in the standard success envelope. */
export function sendData(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ data, error: null });
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export interface PageRequest {
  skip: number;
  limit: number;
}

export function toPageRequest(page: number, limit: number): PageRequest {
  return { skip: (page - 1) * limit, limit };
}
