export const ROLES = ['admin', 'data_engineer', 'data_steward', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** A user as the API exposes it. Never contains the password hash. */
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewUser {
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
}

export interface UserCredentials {
  user: User;
  passwordHash: string;
}

export interface UserRepository {
  /** Throws DuplicateKeyError when the email is already registered. */
  create(input: NewUser): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findCredentialsByEmail(email: string): Promise<UserCredentials | null>;
  /** Changes a user's global role; returns the updated user, or null when it does not exist. */
  setRole(id: string, role: Role): Promise<User | null>;
  /**
   * Atomically claims the one-time "bootstrap admin" slot (BOOTSTRAP_ADMIN_EMAIL). Returns true
   * for exactly one caller, so two simultaneous requests cannot both promote a user.
   */
  claimBootstrapAdmin(): Promise<boolean>;
}
