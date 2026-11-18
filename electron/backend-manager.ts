import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage, utilityProcess, UtilityProcess } from 'electron';
import { generateDesktopSecret, sanitizeLogLine } from './security';

export interface BackendPaths {
  userDataDir: string;
  dataDir: string;
  logsDir: string;
  logFilePath: string;
  dpapiKeyPath: string;
  prefsPath: string;
}

export function resolveDesktopDataPaths(userDataDir: string): BackendPaths {
  return {
    userDataDir,
    dataDir: path.join(userDataDir, 'data'),
    logsDir: path.join(userDataDir, 'logs'),
    logFilePath: path.join(userDataDir, 'logs', 'app.log'),
    dpapiKeyPath: path.join(userDataDir, 'master.key.dpapi'),
    prefsPath: path.join(userDataDir, 'preferences.json'),
  };
}

export class DesktopBackendManager {
  private child: UtilityProcess | null = null;
  private readonly secret: string;
  private boundPort: number | null = null;
  private paths: BackendPaths;
  private dpapiProtected = false;

  constructor(userDataDir: string) {
    this.secret = generateDesktopSecret();
    this.paths = resolveDesktopDataPaths(userDataDir);
  }

  getDesktopToken(): string {
    return this.secret;
  }

  getApiBaseUrl(): string {
    if (!this.boundPort) {
      throw new Error('Desktop backend is not started yet.');
    }
    return `http://127.0.0.1:${this.boundPort}`;
  }

  getPaths(): BackendPaths {
    return this.paths;
  }

  isDpapiProtected(): boolean {
    return this.dpapiProtected;
  }

  appendLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
    try {
      fs.mkdirSync(this.paths.logsDir, { recursive: true });
      const line = `[${new Date().toISOString()}] [${level}] ${sanitizeLogLine(message)}\n`;
      fs.appendFileSync(this.paths.logFilePath, line, 'utf8');
    } catch {
      // Never crash on logging failure
    }
  }

  readRecentLogs(maxLines = 120): string[] {
    try {
      if (!fs.existsSync(this.paths.logFilePath)) return [];
      const raw = fs.readFileSync(this.paths.logFilePath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }

  private resolveOrProvisionMasterKey(): string {
    fs.mkdirSync(this.paths.userDataDir, { recursive: true });
    fs.mkdirSync(this.paths.dataDir, { recursive: true });

    const dpapiAvailable = (() => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    })();

    if (dpapiAvailable && fs.existsSync(this.paths.dpapiKeyPath)) {
      try {
        const encrypted = fs.readFileSync(this.paths.dpapiKeyPath);
        const decrypted = safeStorage.decryptString(encrypted);
        if (decrypted.length >= 32) {
          this.dpapiProtected = true;
          return decrypted;
        }
      } catch (err) {
        this.appendLog(
          'WARN',
          `DPAPI key read fallback: ${err instanceof Error ? err.message : 'decrypt error'}`
        );
      }
    }

    const fallbackKeyFile = path.join(this.paths.dataDir, '.vds-master.key');
    let keyHex = '';
    if (fs.existsSync(fallbackKeyFile)) {
      keyHex = fs.readFileSync(fallbackKeyFile, 'utf8').trim();
    }
    if (keyHex.length < 32) {
      keyHex = crypto.randomBytes(32).toString('hex');
    }

    if (dpapiAvailable) {
      try {
        const encryptedBuf = safeStorage.encryptString(keyHex);
        fs.writeFileSync(this.paths.dpapiKeyPath, encryptedBuf, { mode: 0o600 });
        this.dpapiProtected = true;
      } catch {
        this.dpapiProtected = false;
      }
    }
    return keyHex;
  }

  async start(opts: { serverEntryPath: string; staticDir: string }): Promise<{ port: number; url: string }> {
    if (this.boundPort && this.child) {
      return { port: this.boundPort, url: this.getApiBaseUrl() };
    }

    const masterKey = this.resolveOrProvisionMasterKey();
    this.appendLog('INFO', `Starting bundled backend from ${opts.serverEntryPath}`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: '0',
      HOST: '127.0.0.1',
      VDS_DESKTOP_MODE: '1',
      VDS_DESKTOP_SECRET: this.secret,
      VDS_DATA_DIR: this.paths.dataDir,
      VDS_STATIC_DIR: opts.staticDir,
      VDS_MASTER_KEY: masterKey,
    };

    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(opts.serverEntryPath, [], {
        env,
        stdio: 'pipe',
        serviceName: 'visual-database-studio-backend',
      });
      this.child = child;

      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.appendLog('ERROR', 'Timed out waiting for bundled backend startup.');
          reject(new Error('Bundled backend startup timed out after 20 seconds.'));
        }
      }, 20000);

      const handleReady = (port: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.boundPort = port;
        this.appendLog('INFO', `Bundled backend listening on http://127.0.0.1:${port}`);
        resolve({ port, url: `http://127.0.0.1:${port}` });
      };

      child.on('message', (msg: unknown) => {
        if (msg && typeof msg === 'object') {
          const m = msg as { type?: string; port?: number };
          if (m.type === 'ready' && typeof m.port === 'number') {
            handleReady(m.port);
          }
        }
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          if (line.startsWith('VDS_SERVER_READY:')) {
            try {
              const info = JSON.parse(line.slice('VDS_SERVER_READY:'.length)) as { port?: number };
              if (typeof info.port === 'number') handleReady(info.port);
            } catch {
              // ignore parse issue
            }
          } else {
            this.appendLog('INFO', `[backend] ${line}`);
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          this.appendLog('WARN', `[backend-err] ${line}`);
        }
      });

      child.on('exit', (code) => {
        this.appendLog('INFO', `Bundled backend exited with code ${code}.`);
        this.child = null;
        this.boundPort = null;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Bundled backend exited prematurely (code ${code}). Check ${this.paths.logFilePath}.`));
        }
      });
    });
  }

  async checkHealth(): Promise<boolean> {
    if (!this.boundPort) return false;
    try {
      const res = await fetch(`${this.getApiBaseUrl()}/api/health`, {
        headers: { 'x-vds-desktop-token': this.secret },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    const proc = this.child;
    this.appendLog('INFO', 'Initiating graceful backend shutdown.');

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.child = null;
        this.boundPort = null;
        resolve();
      };

      const killTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        finish();
      }, 3500);

      proc.once('exit', () => {
        clearTimeout(killTimer);
        finish();
      });

      try {
        proc.postMessage({ type: 'shutdown' });
      } catch {
        try {
          proc.kill();
        } catch {
          // ignore
        }
        clearTimeout(killTimer);
        finish();
      }
    });
  }

  wipeLocalSensitiveData(): void {
    const targets = [
      this.paths.dpapiKeyPath,
      this.paths.prefsPath,
      path.join(this.paths.dataDir, 'control-plane.db'),
      path.join(this.paths.dataDir, 'control-plane.db-wal'),
      path.join(this.paths.dataDir, 'control-plane.db-shm'),
      path.join(this.paths.dataDir, '.vds-master.key'),
      path.join(this.paths.dataDir, 'sandbox-northwind.db'),
    ];
    for (const file of targets) {
      try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch {
        // ignore lock errors during exit
      }
    }
    this.appendLog('INFO', 'User requested local data wipe completed.');
  }
}

export function resolveBundledPaths(): { serverEntryPath: string; staticDir: string } {
  const appPath = app.getAppPath();
  return {
    serverEntryPath: path.join(appPath, 'dist-electron', 'server.mjs'),
    staticDir: path.join(appPath, 'dist'),
  };
}
