import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { DiaryBotSettings, DEFAULT_SETTINGS } from './settings/settings';
import { DiaryBotSettingTab } from './settings/settingsTab';
import { MessageHandler } from './telegram/messageHandler';
import { AIRouter } from './ai/aiRouter';
import { SessionManager } from './ai/sessionManager';
import { MemoryRetriever } from './ai/memoryRetriever';
import { NoteWriter } from './vault/noteWriter';
import { EntityNotes } from './vault/entityNotes';
import { cleanupEntities, notifyCleanupResult } from './vault/cleanupEntities';
import { DiaryExportModal } from './export/diaryExport';
import { syncTopicProfilesFromCloud, registerTopicReverseSync, backfillTopics } from './vault/topicsSync';
import { PhotoWallView, PHOTO_WALL_VIEW_TYPE } from './views/photoWallView';
import { TimelineView, TIMELINE_VIEW_TYPE } from './views/timelineView';
import { PeopleGraphView, PEOPLE_GRAPH_VIEW_TYPE } from './views/peopleGraphView';
import { DailyReportGenerator } from './vault/dailyReport';
import { WeeklyReportGenerator } from './vault/weeklyReport';
import { MonthlyReportGenerator } from './vault/monthlyReport';
import { RelayClient } from './relay/relayClient';
import { DeviceLock, DeviceHeartbeat } from './utils/deviceLock';
import { DashboardView, DASHBOARD_VIEW_TYPE } from './views/dashboardView';
import { ReportState } from './vault/reportState';
import { buildUserProfile } from './utils/profileBuilder';

// Simple XOR obfuscation for tokens in data.json (same key as old secureStorage)
const XOR_KEY = 'diary-bot-obfuscation-key-123';

const SECRET_FIELDS = [
  'telegramBotToken',
  'deepseekApiKey',
  'openaiApiKey',
  'creditToken',
  'relayUserId',
  'allowedUserId',
] as const;

function xorEncode(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  }
  return btoa(result);
}

function xorDecode(encoded: string): string {
  try {
    const raw = atob(encoded);
    let result = '';
    for (let i = 0; i < raw.length; i++) {
      result += String.fromCharCode(raw.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    }
    return result;
  } catch { return ''; }
}

// Legacy decoder for migrating from old `secure.json`. Old SecureStorage wrapped
// the XOR output with UTF-8 escape/unescape:
//   encode: btoa(unescape(encodeURIComponent(xor(json, key))))
//   decode: xor(decodeURIComponent(escape(atob(blob))), key) → JSON.parse
function legacyDecodeSecureBlob(encoded: string): Record<string, string> | null {
  try {
    const xored = decodeURIComponent(escape(atob(encoded)));
    let json = '';
    for (let i = 0; i < xored.length; i++) {
      json += String.fromCharCode(xored.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    }
    const parsed = JSON.parse(json);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (e) {
    console.error('Diary Bot: legacy secure.json decode failed', e);
    return null;
  }
}

export interface PluginStatus {
  lastPollAt: number;
  lastPollCount: number;
  lastPollError: string | null;
  lastSaveAt: number;
  lastSaveError: string | null;
  restoredFromBackup: boolean;
  migratedFromLegacy: boolean;
}

export default class DiaryBotPlugin extends Plugin {
  settings!: DiaryBotSettings;
  messageHandler!: MessageHandler;
  aiRouter!: AIRouter;
  sessionManager!: SessionManager;
  memoryRetriever!: MemoryRetriever;
  noteWriter!: NoteWriter;
  entityNotes!: EntityNotes;
  dailyReportGenerator!: DailyReportGenerator;
  weeklyReportGenerator!: WeeklyReportGenerator;
  monthlyReportGenerator!: MonthlyReportGenerator;
  relayClient!: RelayClient;
  deviceLock!: DeviceLock;
  reportState!: ReportState;

  isActiveDevice = false;
  blockedBy: DeviceHeartbeat | null = null;
  private settingsTab: DiaryBotSettingTab | null = null;
  private profileInterval: number | null = null;
  status: PluginStatus = {
    lastPollAt: 0,
    lastPollCount: 0,
    lastPollError: null,
    lastSaveAt: 0,
    lastSaveError: null,
    restoredFromBackup: false,
    migratedFromLegacy: false,
  };

  /** Resolved on-disk plugin folder. Use this for sidecar files instead of `manifest.id`,
   *  since the install folder name (e.g. `obsidian-diary-bot`) may differ from `manifest.id`. */
  pluginDir(): string {
    const fromManifest = (this.manifest as any).dir as string | undefined;
    if (fromManifest && fromManifest.length > 0) return fromManifest.replace(/\\/g, '/');
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  async onload() {
    await this.loadSettings();

    this.aiRouter = new AIRouter(this.settings);
    this.sessionManager = new SessionManager();
    this.sessionManager.attachStorage(this.app, this.pluginDir());
    await this.sessionManager.load();
    this.noteWriter = new NoteWriter(this.app, this);
    this.entityNotes = new EntityNotes(this.app, this.entityFolders());
    this.memoryRetriever = new MemoryRetriever(this.app, this.aiRouter, this.memoryFolders());
    this.reportState = new ReportState(this.app, this.manifest.id);
    this.dailyReportGenerator = new DailyReportGenerator(this);
    this.weeklyReportGenerator = new WeeklyReportGenerator(this);
    this.monthlyReportGenerator = new MonthlyReportGenerator(this);
    this.messageHandler = new MessageHandler(this);
    this.relayClient = new RelayClient(this);
    this.deviceLock = new DeviceLock(this.app, this.pluginDir());

    this.settingsTab = new DiaryBotSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Dashboard view
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));
    this.registerView(PHOTO_WALL_VIEW_TYPE, (leaf) => new PhotoWallView(leaf, this));
    this.registerView(TIMELINE_VIEW_TYPE, (leaf) => new TimelineView(leaf, this));
    this.registerView(PEOPLE_GRAPH_VIEW_TYPE, (leaf) => new PeopleGraphView(leaf, this));
    this.addRibbonIcon('bar-chart-3', 'Diary Dashboard', () => this.activateView());
    this.addRibbonIcon('image', 'Diary Photo Wall', () => this.activatePhotoWall());
    this.addRibbonIcon('list', 'Diary Timeline', () => this.activateTimeline());
    this.addRibbonIcon('book-open', 'Export Diary as Book', () => new DiaryExportModal(this).open());
    this.addRibbonIcon('map-pin', 'Diary Map View', () => this.openMapViewOrInstall());
    this.addRibbonIcon('users', 'Diary People Graph', () => this.activatePeopleGraph());
    this.addCommand({
      id: 'open-dashboard',
      name: 'Open Diary Dashboard',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'cleanup-entities',
      name: 'Cleanup Entity Notes (dedup + blocklist)',
      callback: async () => {
        const folders = Object.values(this.entityFolders());
        const result = await cleanupEntities(this.app, folders, false);
        notifyCleanupResult(result);
      },
    });
    this.addCommand({
      id: 'export-diary-book',
      name: 'Export Diary as Book (PDF / Markdown)',
      callback: () => new DiaryExportModal(this).open(),
    });
    this.addCommand({
      id: 'open-photo-wall',
      name: 'Open Diary Photo Wall',
      callback: () => this.activatePhotoWall(),
    });
    this.addCommand({
      id: 'open-timeline',
      name: 'Open Diary Timeline',
      callback: () => this.activateTimeline(),
    });
    this.addCommand({
      id: 'open-people-graph',
      name: 'Open Diary People Graph',
      callback: () => this.activatePeopleGraph(),
    });
    this.addCommand({
      id: 'sync-topic-profiles',
      name: 'Sync Topic Profiles from Cloud',
      callback: async () => {
        await syncTopicProfilesFromCloud(this);
        new Notice('Topic profiles synced from cloud.');
      },
    });
    this.addCommand({
      id: 'backfill-topics',
      name: 'Backfill Topic Mentions from Vault → Cloud',
      callback: async () => {
        new Notice('Backfilling… this may take a minute.');
        const r = await backfillTopics(this);
        new Notice(`Backfill done: ${r.scanned} entries scanned, ${r.pushed} pushed.`, 8000);
      },
    });

    this.app.workspace.onLayoutReady(() => this.tryActivate());

    this.registerInterval(window.setInterval(() => this.checkDailyReport(), 60 * 1000));
    this.registerInterval(window.setInterval(() => this.checkAutoReports(), 5 * 60 * 1000));
    this.registerInterval(window.setInterval(() => this.autoSaveExpiredSessions(), 60 * 1000));
    this.registerInterval(window.setInterval(() => this.sessionManager.flush(), 60 * 1000));
  }

  async tryActivate(force: boolean = false): Promise<void> {
    if (this.isActiveDevice) return;

    const hasSelfHosted = this.settings.serviceMode === 'self-hosted' && !!this.settings.relayUrl;
    const hasHosted = this.settings.serviceMode === 'hosted' && !!this.settings.creditToken;
    if (!hasSelfHosted && !hasHosted) {
      console.warn(
        `[DiaryBot] not activating — mode=${this.settings.serviceMode}, ` +
        `relayUrl=${!!this.settings.relayUrl}, creditToken=${!!this.settings.creditToken}`
      );
      this.refreshSettingsTab();
      return;
    }

    if (!this.settings.relayUserId || !this.settings.creditToken) {
      console.warn(
        `[DiaryBot] not activating — missing credentials: ` +
        `relayUserId=${!!this.settings.relayUserId}, creditToken=${!!this.settings.creditToken}. ` +
        `Run "Generate Code" → /bind in Telegram → Verify in settings.`
      );
      this.refreshSettingsTab();
      return;
    }

    const acquired = await this.deviceLock.tryAcquire(force);
    if (!acquired) {
      this.blockedBy = await this.deviceLock.otherActive();
      this.isActiveDevice = false;
      console.warn(`[DiaryBot] device lock blocked by ${this.blockedBy?.deviceName || 'unknown'}`);
      this.refreshSettingsTab();
      return;
    }

    this.blockedBy = null;
    this.isActiveDevice = true;
    console.log('[DiaryBot] activated, starting polling…');
    this.deviceLock.startHeartbeat(() => this.handleLockLost());
    await this.bootRuntime();
    this.catchUpReports();
    this.startProfilePush();
    this.refreshSettingsTab();
  }

  private async handleLockLost(): Promise<void> {
    this.isActiveDevice = false;
    this.relayClient?.stopPolling();
    this.stopProfilePush();
    this.blockedBy = await this.deviceLock.otherActive();
    this.refreshSettingsTab();
  }

  private async bootRuntime(): Promise<void> {
    if (this.settings.serviceMode === 'hosted' && this.settings.creditToken) {
      this.relayClient.setRelayUrl(this.settings.relayUrl);
      this.relayClient.setCredentials(this.settings.relayUserId, this.settings.creditToken);
    } else if (this.settings.serviceMode === 'self-hosted' && this.settings.relayUrl) {
      this.relayClient.setRelayUrl(this.settings.relayUrl);
      this.relayClient.setCredentials(this.settings.relayUserId, this.settings.creditToken);
    }
    await this.relayClient.startPolling();
    this.messageHandler.registerRelayHandlers();

    // Initial sync of UI-toggle prefs to worker (replyMode, persona). User may
    // have changed these in settings while plugin was offline / not yet bound.
    if (this.settings.relayUserId) {
      this.relayClient.pushPref(this.settings.relayUserId, {
        replyMode: this.settings.replyMode,
      }).catch((e) => console.error('[DiaryBot] initial pushPref failed', e));

      // Pull latest topic profiles into vault Topics/ folder (background).
      syncTopicProfilesFromCloud(this).catch((e) => console.error('[DiaryBot] topic sync failed', e));
    }

    // Watch Topics/<key>.md for user edits → reverse-push to worker.
    registerTopicReverseSync(this);
  }

  private startProfilePush(): void {
    if (this.profileInterval) return;
    this.profileInterval = window.setInterval(async () => {
      if (!this.isActiveDevice || !this.settings.relayUserId) return;
      try {
        const profile = await buildUserProfile(
          this.app,
          this.settings.diaryFolder,
          7
        );
        if (profile) {
          await this.relayClient.pushProfile(this.settings.relayUserId, profile);
        }
      } catch (e) {
        console.error('Diary Bot: profile push failed', e);
      }
    }, 10 * 60 * 1000);
  }

  private stopProfilePush(): void {
    if (this.profileInterval !== null) {
      window.clearInterval(this.profileInterval);
      this.profileInterval = null;
    }
  }

  private refreshSettingsTab(): void {
    if (this.settingsTab && (this.settingsTab as any).containerEl?.isShown?.()) {
      this.settingsTab.display();
    }
  }

  async onunload() {
    try {
      this.relayClient?.stopPolling();
      this.stopProfilePush();
    } finally {
      this.deviceLock?.release();
      await this.sessionManager?.flush();
    }
  }

  async loadSettings() {
    let data: any = null;
    let usedBackup = false;
    try {
      data = await this.loadData();
    } catch (e) {
      console.error('[DiaryBot] loadData failed, attempting backup', e);
    }
    // If primary missing/empty, try backup file in plugin dir
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      const backup = await this.loadBackup();
      if (backup) {
        console.log('[DiaryBot] restored settings from data.json.bak');
        data = backup;
        usedBackup = true;
      }
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Migrate old mode names
    if ((this.settings.serviceMode as string) === 'free') this.settings.serviceMode = 'self-hosted';
    if ((this.settings.serviceMode as string) === 'paid') this.settings.serviceMode = 'hosted';
    // Restore credentials from XOR-obfuscated field in data.json
    const secrets = (data as any)?._secrets;
    if (secrets) {
      try {
        const decoded = JSON.parse(xorDecode(secrets));
        for (const field of SECRET_FIELDS) {
          if (decoded[field] && !(this.settings as any)[field]) {
            (this.settings as any)[field] = decoded[field];
          }
        }
      } catch (e) {
        console.error('[DiaryBot] corrupt _secrets, skipping', e);
      }
    }
    // Strip stale _secrets from in-memory settings so it can't leak elsewhere
    delete (this.settings as any)._secrets;

    // Migrate from legacy `secure.json` (pre-_secrets scheme)
    const migratedFromLegacy = await this.migrateLegacySecureFile();

    this.status.restoredFromBackup = usedBackup;
    this.status.migratedFromLegacy = migratedFromLegacy;
  }

  /** If legacy secure.json exists and has tokens, populate empty fields and delete it.
   *  Returns true if migration happened. */
  private async migrateLegacySecureFile(): Promise<boolean> {
    const legacyPath = `${this.pluginDir()}/secure.json`;
    try {
      if (!(await this.app.vault.adapter.exists(legacyPath))) return false;
      const raw = await this.app.vault.adapter.read(legacyPath);
      const decoded = legacyDecodeSecureBlob(raw.trim());
      if (!decoded) return false;
      let touched = false;
      for (const field of SECRET_FIELDS) {
        if (decoded[field] && !(this.settings as any)[field]) {
          (this.settings as any)[field] = decoded[field];
          touched = true;
        }
      }
      if (touched) {
        console.log('[DiaryBot] migrated tokens from legacy secure.json');
        await this.saveSettings(); // re-encode under _secrets
      }
      // Always delete after read to avoid second migration/staleness
      try {
        await this.app.vault.adapter.remove(legacyPath);
      } catch (e) {
        console.warn('[DiaryBot] could not delete legacy secure.json', e);
      }
      return touched;
    } catch (e) {
      console.error('[DiaryBot] legacy migration failed', e);
      return false;
    }
  }

  private async loadBackup(): Promise<any | null> {
    try {
      const path = `${this.pluginDir()}/data.json.bak`;
      if (!(await this.app.vault.adapter.exists(path))) return null;
      const raw = await this.app.vault.adapter.read(path);
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    } catch (e) {
      console.error('[DiaryBot] backup read failed', e);
      return null;
    }
  }

  private async writeBackup(data: any): Promise<void> {
    try {
      const path = `${this.pluginDir()}/data.json.bak`;
      await this.app.vault.adapter.write(path, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[DiaryBot] backup write failed', e);
    }
  }

  /** Atomic write: write data.json.tmp, verify by re-reading, then rename onto data.json.
   *  Falls back to direct saveData if rename unavailable on the adapter. */
  private async atomicSaveData(data: any): Promise<void> {
    const dir = this.pluginDir();
    const tmpPath = `${dir}/data.json.tmp`;
    const finalPath = `${dir}/data.json`;
    const json = JSON.stringify(data, null, 2);
    const adapter = this.app.vault.adapter;

    try {
      await adapter.write(tmpPath, json);
      // Verify we can read+parse what we wrote
      const verify = await adapter.read(tmpPath);
      JSON.parse(verify); // throws if corrupt
      // Rename atomically (Obsidian's adapter supports rename for ordinary files)
      const renameFn = (adapter as any).rename;
      if (typeof renameFn === 'function') {
        // Remove existing destination first if rename refuses to overwrite
        try {
          if (await adapter.exists(finalPath)) {
            await adapter.remove(finalPath);
          }
        } catch { /* best effort */ }
        await renameFn.call(adapter, tmpPath, finalPath);
      } else {
        // Fallback: direct write
        await adapter.write(finalPath, json);
        try { await adapter.remove(tmpPath); } catch { /* ignore */ }
      }
    } catch (e) {
      console.error('[DiaryBot] atomic save failed, falling back to saveData', e);
      // Last-resort fallback to Obsidian's own saveData (still better than silent failure)
      await this.saveData(data);
    }
  }

  async saveSettings() {
    if (this.aiRouter) this.aiRouter.rebuild(this.settings);
    if (this.memoryRetriever) {
      this.memoryRetriever.rebuild(this.aiRouter);
      this.memoryRetriever.updateFolders(this.memoryFolders());
      this.memoryRetriever.vaultWideSearch = this.settings.enableVaultWideSearch;
    }
    if (this.entityNotes) this.entityNotes.updateFolders(this.entityFolders());

    const dataToSave: Record<string, any> = { ...this.settings };
    delete dataToSave._secrets;

    // XOR-obfuscate ALL sensitive fields into _secrets, blank them in plain section
    const secrets: Record<string, string> = {};
    let hasAny = false;
    for (const field of SECRET_FIELDS) {
      const value = (this.settings as any)[field] || '';
      secrets[field] = value;
      dataToSave[field] = '';
      if (value) hasAny = true;
    }
    if (hasAny) {
      dataToSave._secrets = xorEncode(JSON.stringify(secrets));
    }

    try {
      await this.atomicSaveData(dataToSave);
      await this.writeBackup(dataToSave);
      this.status.lastSaveAt = Date.now();
      this.status.lastSaveError = null;
    } catch (e: any) {
      this.status.lastSaveError = e?.message || String(e);
      this.status.lastSaveAt = Date.now();
      console.error('[DiaryBot] saveSettings failed', e);
    }
  }

  private memoryFolders() {
    return {
      diary: this.settings.diaryFolder || 'Journal',
      person: this.settings.peopleFolder || 'Journal/People',
      place: this.settings.placesFolder || 'Journal/Places',
      project: this.settings.projectsFolder || 'Journal/Projects',
    };
  }

  private entityFolders() {
    return {
      person: this.settings.peopleFolder || 'Journal/People',
      place: this.settings.placesFolder || 'Journal/Places',
      project: this.settings.projectsFolder || 'Journal/Projects',
    };
  }

  private async checkAutoReports() {
    if (!this.isActiveDevice) return;
    try {
      await this.weeklyReportGenerator.checkAndGenerate();
      await this.monthlyReportGenerator.checkAndGenerate();
    } catch (e) {
      console.error('Diary Bot: auto report check failed', e);
    }
  }

  private async checkDailyReport() {
    if (!this.isActiveDevice) return;
    if (!this.settings.enableDailyReport) return;
    try { await this.dailyReportGenerator.checkAndPrepend(); } catch {}
  }

  private async catchUpReports() {
    const now = new Date();
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const ds = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      try { await this.dailyReportGenerator.generateForDate(ds); } catch {}
    }
    try { await this.weeklyReportGenerator.checkAndGenerate(); } catch {}
    try { await this.monthlyReportGenerator.checkAndGenerate(); } catch {}
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0] || null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) || null;
      if (leaf) await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  async activatePhotoWall() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(PHOTO_WALL_VIEW_TYPE)[0] || null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      if (leaf) await leaf.setViewState({ type: PHOTO_WALL_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  /** Open obsidian-map-view if installed; else nudge user to install. */
  openMapViewOrInstall(): void {
    const plugins: any = (this.app as any).plugins;
    const mapView = plugins?.plugins?.['obsidian-map-view'];
    if (mapView) {
      // Try its open command.
      const cmds: any = (this.app as any).commands;
      const tried = cmds?.executeCommandById?.('obsidian-map-view:open-map-view');
      if (!tried) {
        // Fallback: just notice. User can open via their own command.
        new Notice('Map View installed. Open it via Ctrl+P → "Map View".');
      }
      return;
    }
    // Not installed — open community-plugins browser focused on map-view.
    new Notice('Install "Map View" plugin first (one-tap below).', 5000);
    try {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById('community-plugins');
    } catch {
      new Notice('Open Settings → Community plugins → search "Map View".');
    }
  }

  async activateTimeline() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(TIMELINE_VIEW_TYPE)[0] || null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      if (leaf) await leaf.setViewState({ type: TIMELINE_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  async activatePeopleGraph() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(PEOPLE_GRAPH_VIEW_TYPE)[0] || null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      if (leaf) await leaf.setViewState({ type: PEOPLE_GRAPH_VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  private async autoSaveExpiredSessions() {
    if (!this.isActiveDevice) return;
    const sessions = this.sessionManager.getAllSessions();
    for (const session of sessions) {
      if (
        session.messages.length > 0 &&
        session.state !== 'SAVING' &&
        this.sessionManager.isSessionExpired(session, this.settings.sessionTimeoutMinutes)
      ) {
        await this.messageHandler.finishSession(session.userId, true);
      }
    }
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
