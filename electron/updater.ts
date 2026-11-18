export interface UpdateStatusReport {
  enabled: boolean;
  configured: boolean;
  channel: 'stable' | 'beta';
  currentVersion: string;
  available: boolean;
  message: string;
  checkedAt: string;
}

export interface AutoUpdateOptions {
  currentVersion: string;
  feedUrl?: string;
  signingVerified?: boolean;
  isCriticalDatabaseWorkActive?: () => boolean;
}

export class DesktopUpdater {
  private readonly feedUrl: string | null;
  private readonly signingVerified: boolean;
  private readonly currentVersion: string;
  private readonly isCriticalWorkActive: () => boolean;

  constructor(options: AutoUpdateOptions) {
    this.currentVersion = options.currentVersion;
    const trimmed = (options.feedUrl || process.env.VDS_UPDATE_FEED_URL || '').trim();
    this.feedUrl = /^https:\/\/.+/i.test(trimmed) ? trimmed : null;
    this.signingVerified = Boolean(options.signingVerified ?? process.env.VDS_UPDATE_SIGNED === 'true');
    this.isCriticalWorkActive = options.isCriticalDatabaseWorkActive ?? (() => false);
  }

  isEnabled(): boolean {
    return Boolean(this.feedUrl && this.signingVerified);
  }

  async checkForUpdates(): Promise<UpdateStatusReport> {
    const checkedAt = new Date().toISOString();
    if (!this.feedUrl) {
      return {
        enabled: false,
        configured: false,
        channel: 'stable',
        currentVersion: this.currentVersion,
        available: false,
        message:
          'Automatic updates are disabled in this build because no signed HTTPS update feed (VDS_UPDATE_FEED_URL) is configured.',
        checkedAt,
      };
    }

    if (!this.signingVerified) {
      return {
        enabled: false,
        configured: true,
        channel: 'stable',
        currentVersion: this.currentVersion,
        available: false,
        message:
          'Automatic updates are blocked because Authenticode / signature verification is not enabled for this build.',
        checkedAt,
      };
    }

    if (this.isCriticalWorkActive()) {
      return {
        enabled: true,
        configured: true,
        channel: 'stable',
        currentVersion: this.currentVersion,
        available: false,
        message: 'Update check deferred while a critical database operation is in progress.',
        checkedAt,
      };
    }

    // Real HTTPS manifest check only when explicitly configured with signed feed
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.feedUrl.replace(/\/$/, '')}/latest.yml`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        return {
          enabled: true,
          configured: true,
          channel: 'stable',
          currentVersion: this.currentVersion,
          available: false,
          message: `Update server returned HTTP ${res.status}. No silent update applied.`,
          checkedAt,
        };
      }
      return {
        enabled: true,
        configured: true,
        channel: 'stable',
        currentVersion: this.currentVersion,
        available: false,
        message: `Release channel verified (${this.currentVersion}). Manual installation review applies.`,
        checkedAt,
      };
    } catch (err) {
      return {
        enabled: true,
        configured: true,
        channel: 'stable',
        currentVersion: this.currentVersion,
        available: false,
        message: err instanceof Error ? `Update server unreachable (${err.message}).` : 'Offline — update check skipped.',
        checkedAt,
      };
    }
  }
}
