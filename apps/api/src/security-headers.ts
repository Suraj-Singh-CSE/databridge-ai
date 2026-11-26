import type { RequestHandler } from 'express';
import helmet from 'helmet';

/**
 * Content-Security-Policy for the SPA and the API (ADR 0027). Scripts load only from this
 * origin (no inline script). Styles also allow 'unsafe-inline' because two bundled libraries
 * insert <style> elements at runtime: sonner (toast styles) and react-remove-scroll (the dialog
 * scroll lock). Inline styles cannot run code; scripts stay strict.
 */
export const CONTENT_SECURITY_POLICY = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'script-src-attr': ["'none'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'object-src': ["'none'"],
} as const;

/** Features the app never uses; a page (or injected script) cannot turn them on. */
export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()';

/**
 * Security headers on every response (web app and API). HSTS only in production: it is
 * meaningless over plain HTTP and would pin local hosts to HTTPS.
 */
export function securityHeaders(production: boolean): RequestHandler[] {
  const permissionsPolicy: RequestHandler = (_req, res, next) => {
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    next();
  };
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: Object.fromEntries(
          Object.entries(CONTENT_SECURITY_POLICY).map(([key, value]) => [key, [...value]]),
        ),
      },
      strictTransportSecurity: production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      xFrameOptions: { action: 'deny' },
    }),
    permissionsPolicy,
  ];
}
