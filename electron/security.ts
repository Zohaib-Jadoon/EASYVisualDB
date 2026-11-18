import crypto from 'node:crypto';

export function generateDesktopSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function buildDesktopCsp(opts: {
  backendOrigin: string;
  isDev: boolean;
  devOrigin?: string;
}): string {
  const connectSources = [opts.backendOrigin, opts.backendOrigin.replace(/^http/, 'ws')];
  if (opts.isDev && opts.devOrigin) {
    connectSources.push(opts.devOrigin, opts.devOrigin.replace(/^http/, 'ws'));
  }

  const scriptSrc = opts.isDev
    ? `'self' 'unsafe-inline'` // Vite React preamble in desktop:dev only
    : `'self'`;

  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' data: https://fonts.gstatic.com`,
    `img-src 'self' data: blob:`,
    `connect-src 'self' ${connectSources.join(' ')}`,
  ].join('; ');
}

export function isAllowedAppNavigation(targetUrl: string, allowedOrigin: string): boolean {
  try {
    const target = new URL(targetUrl);
    const allowed = new URL(allowedOrigin);
    return target.origin === allowed.origin && (target.protocol === 'http:' || target.protocol === 'https:');
  } catch {
    return false;
  }
}

export function isSafeExternalUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateIpcSender(senderUrl: string | undefined, allowedOrigin: string): boolean {
  if (!senderUrl) return false;
  if (senderUrl.startsWith('file://') && senderUrl.endsWith('/loading.html')) {
    return true;
  }
  return isAllowedAppNavigation(senderUrl, allowedOrigin);
}

export function sanitizeLogLine(line: string): string {
  return line
    .replace(/(password|pwd|secret|token|apikey|api_key|x-vds-desktop-token)\s*[:=]\s*[^\s;,&"']+/gi, '$1=[REDACTED]')
    .replace(/Server=[^;]+;.*?Password=[^;]+;/gi, '[REDACTED_CONNECTION_STRING]');
}

export function sanitizeDefaultFilename(name: string, fallback = 'export.txt'): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return cleaned || fallback;
}
