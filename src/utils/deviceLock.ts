import { App, Platform } from 'obsidian';

export interface DeviceHeartbeat {
  deviceId: string;
  deviceName: string;
  lastBeat: number;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 90_000;
const DEVICE_ID_LS_KEY = 'diary-bot-device-id';

/**
 * Cross-device single-active-instance lock.
 *
 * Why: when the user's vault is synced (Obsidian Sync, iCloud, Dropbox, etc.),
 * the plugin folder syncs across devices. Two devices polling the same Telegram
 * bot fight over getUpdates offsets and lose messages. This lock writes a
 * heartbeat file inside the synced vault; sync itself is the propagation
 * channel. Each device has a uuid in localStorage (per-install, NOT synced).
 */
export class DeviceLock {
  private app: App;
  private path: string;
  private deviceId: string;
  private deviceName: string;
  private intervalId: number | null = null;
  private onLost: (() => void) | null = null;

  constructor(app: App, pluginDir: string) {
    this.app = app;
    this.path = `${pluginDir}/active-device.json`;
    this.deviceId = this.ensureDeviceId();
    this.deviceName = this.detectDeviceName();
  }

  private ensureDeviceId(): string {
    let id = window.localStorage.getItem(DEVICE_ID_LS_KEY);
    if (!id) {
      id = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(DEVICE_ID_LS_KEY, id);
    }
    return id;
  }

  private detectDeviceName(): string {
    if (Platform.isIosApp) return 'iPhone/iPad';
    if (Platform.isAndroidApp) return 'Android';
    if (Platform.isMacOS) return 'Mac';
    if (Platform.isWin) return 'Windows';
    if (Platform.isLinux) return 'Linux';
    return 'Unknown device';
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  getDeviceName(): string {
    return this.deviceName;
  }

  async readHeartbeat(): Promise<DeviceHeartbeat | null> {
    try {
      if (!(await this.app.vault.adapter.exists(this.path))) return null;
      const raw = await this.app.vault.adapter.read(this.path);
      const parsed = JSON.parse(raw);
      if (typeof parsed?.deviceId !== 'string' || typeof parsed?.lastBeat !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  isStale(hb: DeviceHeartbeat | null): boolean {
    if (!hb) return true;
    return Date.now() - hb.lastBeat > STALE_THRESHOLD_MS;
  }

  isMine(hb: DeviceHeartbeat | null): boolean {
    return !!hb && hb.deviceId === this.deviceId;
  }

  /**
   * Returns the heartbeat representing the *other* active device, or null if
   * no other device currently holds the lock.
   */
  async otherActive(): Promise<DeviceHeartbeat | null> {
    const hb = await this.readHeartbeat();
    if (!hb) return null;
    if (this.isMine(hb)) return null;
    if (this.isStale(hb)) return null;
    return hb;
  }

  /**
   * Try to acquire the lock. Returns true if we now own it.
   *
   * - force=true: take over regardless of who currently holds it.
   * - otherwise: only acquire if the file is missing, stale, or already ours.
   */
  async tryAcquire(force: boolean = false): Promise<boolean> {
    const current = await this.readHeartbeat();
    if (force || this.isStale(current) || this.isMine(current)) {
      await this.write();
      return true;
    }
    return false;
  }

  private async write(): Promise<void> {
    const data: DeviceHeartbeat = {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      lastBeat: Date.now(),
    };
    try {
      await this.app.vault.adapter.write(this.path, JSON.stringify(data));
    } catch (e) {
      console.error('Diary Bot: failed to write device heartbeat', e);
    }
  }

  /**
   * Start the heartbeat loop. If another device takes over (deviceId in the
   * file changes to one that isn't us), onLost fires and the loop stops.
   */
  startHeartbeat(onLost: () => void): void {
    this.onLost = onLost;
    this.intervalId = window.setInterval(async () => {
      const current = await this.readHeartbeat();
      if (current && current.deviceId !== this.deviceId && !this.isStale(current)) {
        this.stopHeartbeat();
        const cb = this.onLost;
        this.onLost = null;
        if (cb) cb();
        return;
      }
      await this.write();
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Stop heartbeat without deleting the file — the file's timestamp will
   * naturally go stale (90s) and other devices can take over by then.
   */
  release(): void {
    this.stopHeartbeat();
  }
}
