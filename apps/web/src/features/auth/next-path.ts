/** Only same-app paths are allowed as a post-sign-in target (no open redirects). */
export function safeNextPath(next: string | null): string {
  if (!next?.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/projects';
  }
  return next;
}
