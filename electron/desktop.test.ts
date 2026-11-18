import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDesktopCsp,
  generateDesktopSecret,
  isAllowedAppNavigation,
  isSafeExternalUrl,
  sanitizeDefaultFilename,
  sanitizeLogLine,
  validateIpcSender,
} from './security';
import { DesktopUpdater } from './updater';
import { clampWindowBounds } from './window-bounds';

test('Electron desktop security helpers enforce CSP, origin navigation, and secret redaction', () => {
  const token = generateDesktopSecret();
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]+$/);

  const prodCsp = buildDesktopCsp({ backendOrigin: 'http://127.0.0.1:41234', isDev: false });
  assert.ok(prodCsp.includes("object-src 'none'"));
  assert.ok(prodCsp.includes("frame-ancestors 'none'"));
  assert.ok(!prodCsp.includes("'unsafe-inline'\;"));
  assert.ok(prodCsp.includes('http://127.0.0.1:41234'));

  assert.equal(isAllowedAppNavigation('http://127.0.0.1:41234/explorer', 'http://127.0.0.1:41234'), true);
  assert.equal(isAllowedAppNavigation('https://evil.example/phish', 'http://127.0.0.1:41234'), false);
  assert.equal(isAllowedAppNavigation('file:///etc/passwd', 'http://127.0.0.1:41234'), false);

  assert.equal(isSafeExternalUrl('https://learn.microsoft.com/sql'), true);
  assert.equal(isSafeExternalUrl('http://insecure.example'), false);
  assert.equal(isSafeExternalUrl('file:///C:/Windows/System32/cmd.exe'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);

  assert.equal(validateIpcSender('http://127.0.0.1:41234/', 'http://127.0.0.1:41234'), true);
  assert.equal(validateIpcSender('https://evil.example', 'http://127.0.0.1:41234'), false);
  assert.equal(validateIpcSender(undefined, 'http://127.0.0.1:41234'), false);

  const sanitized = sanitizeLogLine('Connect x-vds-desktop-token=secret123 password=MyPass! host=db.local');
  assert.ok(!sanitized.includes('secret123'));
  assert.ok(!sanitized.includes('MyPass!'));
  assert.ok(sanitized.includes('[REDACTED]'));

  assert.equal(sanitizeDefaultFilename('..\\..\\bad:name?.csv'), '.._.._bad_name_.csv');
});

test('clampWindowBounds restores valid multi-monitor bounds and rescues off-screen windows', () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1920, height: 1080 },
  ];

  const validSecondMonitor = clampWindowBounds(
    { x: 2050, y: 120, width: 1280, height: 800, isMaximized: false },
    displays
  );
  assert.equal(validSecondMonitor.x, 2050);
  assert.equal(validSecondMonitor.width, 1280);

  const disconnectedMonitor = clampWindowBounds(
    { x: 4500, y: 120, width: 1280, height: 800, isMaximized: false },
    displays
  );
  assert.ok(disconnectedMonitor.x! >= 0 && disconnectedMonitor.x! < 1920);
  assert.equal(disconnectedMonitor.width, 1280);

  const tooSmall = clampWindowBounds({ width: 320, height: 200, isMaximized: true }, displays);
  assert.equal(tooSmall.width, 1024);
  assert.equal(tooSmall.height, 680);
  assert.equal(tooSmall.isMaximized, true);
});

test('DesktopUpdater remains safely disabled without signed HTTPS feed and defers during critical DB work', async () => {
  const unconfigured = new DesktopUpdater({ currentVersion: '1.0.0' });
  assert.equal(unconfigured.isEnabled(), false);
  const unconfiguredRes = await unconfigured.checkForUpdates();
  assert.equal(unconfiguredRes.enabled, false);
  assert.equal(unconfiguredRes.available, false);

  const unsigned = new DesktopUpdater({
    currentVersion: '1.0.0',
    feedUrl: 'https://releases.example.com/vds',
    signingVerified: false,
  });
  assert.equal(unsigned.isEnabled(), false);

  const busy = new DesktopUpdater({
    currentVersion: '1.0.0',
    feedUrl: 'https://releases.example.com/vds',
    signingVerified: true,
    isCriticalDatabaseWorkActive: () => true,
  });
  assert.equal(busy.isEnabled(), true);
  const deferredRes = await busy.checkForUpdates();
  assert.match(deferredRes.message, /deferred/i);
});

test('Bundled backend desktop loopback mode enforces 127.0.0.1, x-vds-desktop-token, and origin check', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-desktop-srv-'));
  process.env.VDS_NO_AUTOSTART = '1';
  process.env.VDS_DESKTOP_MODE = '1';
  process.env.VDS_DESKTOP_SECRET = generateDesktopSecret();
  process.env.VDS_DATA_DIR = tmpDir;
  process.env.SQL_STUDIO_DB_PATH = path.join(tmpDir, 'control-plane.db');

  const { startServer, validateDesktopRequestSecurity } = await import('../server');
  assert.equal(
    validateDesktopRequestSecurity(
      { path: '/api/workspace', header: () => undefined },
      true,
      process.env.VDS_DESKTOP_SECRET
    ).allowed,
    false
  );

  const instance = await startServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: path.resolve(process.cwd(), 'dist'),
  });

  try {
    const addr = instance.httpServer.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Health endpoint remains accessible for readiness probes
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { status: string; desktopMode: boolean };
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.desktopMode, true);

    // Unauthenticated API call without desktop token is rejected (401)
    const unauthRes = await fetch(`${baseUrl}/api/workspace`);
    assert.equal(unauthRes.status, 401);

    // Foreign Origin header is rejected (403)
    const evilOriginRes = await fetch(`${baseUrl}/api/workspace`, {
      headers: {
        Origin: 'https://attacker.example',
        'x-vds-desktop-token': process.env.VDS_DESKTOP_SECRET!,
      },
    });
    assert.equal(evilOriginRes.status, 403);

    // Authorized Desktop Renderer call succeeds (200)
    const authRes = await fetch(`${baseUrl}/api/workspace`, {
      headers: {
        Origin: baseUrl,
        'x-vds-desktop-token': process.env.VDS_DESKTOP_SECRET!,
      },
    });
    assert.equal(authRes.status, 200);

    const capsRes = await fetch(`${baseUrl}/api/desktop/capabilities`, {
      headers: {
        'x-vds-desktop-token': process.env.VDS_DESKTOP_SECRET!,
      },
    });
    assert.equal(capsRes.status, 200);
    const capsJson = (await capsRes.json()) as { desktopMode: boolean; windowsAuth: { driverName: string } };
    assert.equal(capsJson.desktopMode, true);
    assert.ok(capsJson.windowsAuth.driverName.length > 0);
  } finally {
    await instance.shutdown();
    delete process.env.VDS_DESKTOP_MODE;
    delete process.env.VDS_DESKTOP_SECRET;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
