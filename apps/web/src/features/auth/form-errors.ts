import { ApiError } from '@/lib/api';

/** Calm, plain-language text for a failed sign-in or registration. */
export function authErrorMessage(error: unknown, action: 'sign-in' | 'register'): string {
  if (!(error instanceof ApiError)) return 'Something went wrong. Please try again.';
  if (error.status === 429) return 'Too many attempts. Try again in a few minutes.';
  if (error.status === 401 && action === 'sign-in') return 'Email or password is incorrect.';
  if (error.status === 409) return 'An account with this email already exists.';
  if (error.code === 'INVITE_CODE_INVALID') {
    return 'That invite code is not valid. Check it and try again.';
  }
  if (error.code === 'REGISTRATION_CLOSED') {
    return 'New accounts are not being created right now. Ask an admin for access.';
  }
  if (error.code === 'NETWORK_ERROR') return error.message;
  if (error.code === 'VALIDATION_ERROR') return 'Check the highlighted fields and try again.';
  return 'Something went wrong. Please try again.';
}
