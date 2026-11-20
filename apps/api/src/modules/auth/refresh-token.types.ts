export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
  /** Set on every token of a family once reuse of any of them is detected. */
  reuseDetectedAt: Date | null;
  createdAt: Date;
}

export interface NewRefreshToken {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

export interface RefreshTokenRepository {
  create(input: NewRefreshToken): Promise<RefreshTokenRecord>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /**
   * Revokes the token only if it is still active. Returns true when this call revoked it,
   * false when it was already revoked (lets two concurrent refreshes detect each other).
   */
  revoke(id: string, at: Date): Promise<boolean>;
  setReplacedBy(id: string, replacedBy: string): Promise<void>;
  /** Marks the family as compromised and revokes every token in it. */
  revokeFamily(familyId: string, at: Date): Promise<void>;
  /** True once revokeFamily has run for this family (also covers tokens created after it). */
  isFamilyCompromised(familyId: string): Promise<boolean>;
}
