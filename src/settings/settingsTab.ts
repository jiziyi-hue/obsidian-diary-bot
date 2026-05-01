import { App, PluginSettingTab, Setting } from 'obsidian';
import DiaryBotPlugin from '../main';

function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export class DiaryBotSettingTab extends PluginSettingTab {
  plugin: DiaryBotPlugin;
  // Survives across display() re-renders so user can Generate then Verify
  // even if some other field triggers a re-render in between.
  private bindCode: string = '';

  constructor(app: App, plugin: DiaryBotPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'AI Diary Bot' });

    this.renderStatusPanel(containerEl);
    this.renderDeviceStatus(containerEl);
    this.renderWorkerDiagnostic(containerEl);
    this.renderSponsorCard(containerEl);

    containerEl.createEl('h3', { text: 'Service Mode' });
    new Setting(containerEl)
      .setName('Mode')
      .setDesc('Self-hosted: deploy your own Cloudflare Worker (free). Hosted: use the public relay server (subscription).')
      .addDropdown((dd) =>
        dd
          .addOption('self-hosted', 'Self-hosted (own Worker)')
          .addOption('hosted', 'Hosted (public relay)')
          .setValue(this.plugin.settings.serviceMode)
          .onChange(async (value: 'self-hosted' | 'hosted') => {
            this.plugin.settings.serviceMode = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.serviceMode === 'self-hosted') {
      this.renderSelfHostedMode(containerEl);
    } else {
      this.renderHostedMode(containerEl);
    }

    this.renderSharedSettings(containerEl);
  }

  private renderStatusPanel(parent: HTMLElement): void {
    const s = this.plugin.settings;
    const st = this.plugin.status;
    const card = parent.createDiv({ cls: 'diary-bot-card' });
    card.createEl('h3', { text: 'Status' });

    const pluginDir = this.plugin.pluginDir();
    const tick = (b: boolean) => (b ? '✓' : '✗');

    const rows: Array<[string, string]> = [
      ['Plugin install dir', pluginDir],
      ['Service mode', s.serviceMode],
      ['Worker URL', s.relayUrl || '(unset)'],
      [
        'Tokens',
        [
          `bot=${tick(!!s.telegramBotToken)}`,
          `deepseek=${tick(!!s.deepseekApiKey)}`,
          `credit=${tick(!!s.creditToken)}`,
          `userId=${tick(!!s.relayUserId)}`,
          `allowed=${tick(!!s.allowedUserId)}`,
        ].join('  '),
      ],
      [
        'Active device',
        this.plugin.isActiveDevice
          ? `this device (${this.plugin.deviceLock?.getDeviceName() || ''})`
          : this.plugin.blockedBy
            ? `blocked by ${this.plugin.blockedBy.deviceName}`
            : 'idle',
      ],
      [
        'Polling',
        this.plugin.relayClient?.isRunning()
          ? `running (last poll: ${st.lastPollAt ? fmtTime(st.lastPollAt) : 'never'}, msgs: ${st.lastPollCount})`
          : 'stopped',
      ],
      [
        'Last save',
        st.lastSaveAt
          ? st.lastSaveError
            ? `error at ${fmtTime(st.lastSaveAt)}: ${st.lastSaveError}`
            : `OK at ${fmtTime(st.lastSaveAt)}`
          : 'no save yet',
      ],
    ];
    if (st.lastPollError) rows.push(['Last poll error', st.lastPollError]);
    if (st.restoredFromBackup) rows.push(['Notice', 'restored from data.json.bak']);
    if (st.migratedFromLegacy) rows.push(['Notice', 'migrated tokens from legacy secure.json']);

    const table = card.createEl('table', { cls: 'diary-bot-status-table' });
    for (const [k, v] of rows) {
      const tr = table.createEl('tr');
      tr.createEl('th', { text: k });
      tr.createEl('td', { text: v });
    }

    new Setting(card)
      .setName('Refresh status')
      .addButton((b) => b.setButtonText('Refresh').onClick(() => this.display()));
  }

  private renderDeviceStatus(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: 'diary-bot-status-card' });
    const me = this.plugin.deviceLock?.getDeviceName() ?? 'this device';

    if (this.plugin.isActiveDevice) {
      card.createEl('p', { text: `Bot relay is active on ${me}.` });
      const dim = card.createEl('p', { cls: 'dim' });
      dim.appendText('Other devices that open this vault will see a "Take over" prompt and stay passive.');
      return;
    }

    if (this.plugin.blockedBy) {
      card.createEl('p', {
        text: `Bot relay is currently active on ${this.plugin.blockedBy.deviceName}.`,
      });
      const dim = card.createEl('p', { cls: 'dim' });
      dim.appendText('Use one device at a time. Take over to switch the relay to this device.');
      new Setting(parent)
        .setName('Take over on this device')
        .setDesc('Stops the relay on the other device and starts it here.')
        .addButton((btn) =>
          btn
            .setButtonText('Take over')
            .setCta()
            .onClick(async () => {
              btn.setDisabled(true);
              btn.setButtonText('Taking over...');
              await this.plugin.tryActivate(true);
              this.display();
            })
        );
      return;
    }

    const hasSelfHosted = this.plugin.settings.serviceMode === 'self-hosted' && !!this.plugin.settings.relayUrl;
    const hasHosted = this.plugin.settings.serviceMode === 'hosted' && !!this.plugin.settings.creditToken;
    if (!hasSelfHosted && !hasHosted) {
      card.createEl('p', { text: 'Relay is not configured yet. Fill in the fields below to get started.' });
      return;
    }

    card.createEl('p', { text: 'Relay is idle on this device.' });
    new Setting(parent)
      .setName('Activate on this device')
      .addButton((btn) =>
        btn
          .setButtonText('Activate')
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            await this.plugin.tryActivate(false);
            this.display();
          })
      );
  }

  private renderSponsorCard(parent: HTMLElement): void {
    const fundingUrl = (this.plugin.manifest as { fundingUrl?: string }).fundingUrl;
    if (!fundingUrl || typeof fundingUrl !== 'string') return;

    const card = parent.createDiv({ cls: 'diary-bot-card' });
    card.createEl('h3', { text: 'Support the Project' });
    card.createEl('p', {
      text: 'This plugin is free and open-source. If it helps you, consider supporting development.',
    });
    const link = card.createEl('a', {
      cls: 'diary-bot-cta-btn',
      text: 'Sponsor',
      href: fundingUrl,
    });
    link.setAttr('target', '_blank');
    link.setAttr('rel', 'noopener');
  }

  private renderSelfHostedMode(containerEl: HTMLElement): void {
    const guide = containerEl.createDiv({ cls: 'diary-bot-guide' });
    guide.createEl('h3', { text: 'Self-hosted Setup' });
    const ol = guide.createEl('ol');
    [
      'Click the Deploy button below to deploy your own Cloudflare Worker (free).',
      'Create a bot via @BotFather on Telegram and copy the token.',
      'Set BOT_TOKEN and DEEPSEEK_API_KEY secrets in Cloudflare Dashboard.',
      'Paste your Worker URL below.',
      'Paste your Bot Token below (for photo download).',
      'Send /start to your bot to get your User ID.',
      'Generate a bind code, send /bind CODE to your bot, then Verify.',
    ].forEach((t) => ol.createEl('li', { text: t }));

    // CF Deploy Button
    const deployDiv = guide.createDiv({ cls: 'diary-bot-deploy' });
    deployDiv.createEl('p', { text: 'One-click deploy to Cloudflare:' });
    const deployLink = deployDiv.createEl('a', {
      href: 'https://deploy.workers.cloudflare.com/?url=https://github.com/jiziyi-hue/obsidian-diary-bot',
    });
    deployLink.createEl('img', {
      attr: {
        src: 'https://deploy.workers.cloudflare.com/button',
        alt: 'Deploy to Cloudflare Workers',
      },
    });

    containerEl.createEl('h3', { text: 'Worker Configuration' });

    new Setting(containerEl)
      .setName('Worker URL')
      .setDesc('Your Cloudflare Worker URL (e.g. https://diary-bot.yourname.workers.dev)')
      .addText((text) =>
        text
          .setPlaceholder('https://diary-bot.yourname.workers.dev')
          .setValue(this.plugin.settings.relayUrl)
          .onChange(async (value) => {
            this.plugin.settings.relayUrl = value.trim().replace(/\/$/, '');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Bot Token')
      .setDesc('Your bot token from @BotFather (also needed in Worker secrets)')
      .addText((text) =>
        text
          .setPlaceholder('1234567890:ABC...')
          .setValue(this.plugin.settings.telegramBotToken)
          .onChange(async (value) => {
            this.plugin.settings.telegramBotToken = value.trim();
            await this.plugin.saveSettings();
          })
      );

    this.renderBindingUI(containerEl);

    containerEl.createEl('h3', { text: 'AI Provider' });

    new Setting(containerEl)
      .setName('Provider')
      .addDropdown((dd) =>
        dd
          .addOption('deepseek', 'DeepSeek')
          .addOption('openai', 'OpenAI / Compatible')
          .addOption('ollama', 'Ollama (local, privacy)')
          .setValue(this.plugin.settings.aiProvider)
          .onChange(async (value: 'deepseek' | 'openai' | 'ollama') => {
            this.plugin.settings.aiProvider = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.aiProvider === 'deepseek') {
      new Setting(containerEl)
        .setName('DeepSeek API Key')
        .addText((text) =>
          text
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.deepseekApiKey)
            .onChange(async (value) => {
              this.plugin.settings.deepseekApiKey = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Model')
        .addText((text) =>
          text
            .setPlaceholder('deepseek-chat')
            .setValue(this.plugin.settings.deepseekModel)
            .onChange(async (value) => {
              this.plugin.settings.deepseekModel = value.trim();
              await this.plugin.saveSettings();
            })
        );
    } else if (this.plugin.settings.aiProvider === 'openai') {
      new Setting(containerEl)
        .setName('API Key')
        .addText((text) =>
          text
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.openaiApiKey)
            .onChange(async (value) => {
              this.plugin.settings.openaiApiKey = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Model')
        .addText((text) =>
          text
            .setPlaceholder('gpt-4o-mini')
            .setValue(this.plugin.settings.openaiModel)
            .onChange(async (value) => {
              this.plugin.settings.openaiModel = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName('Base URL')
        .setDesc('Custom endpoint for OpenAI-compatible APIs')
        .addText((text) =>
          text
            .setPlaceholder('https://api.openai.com/v1')
            .setValue(this.plugin.settings.openaiBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.openaiBaseUrl = value.trim();
              await this.plugin.saveSettings();
            })
        );
    } else {
      // Ollama (local)
      new Setting(containerEl)
        .setName('Ollama Base URL')
        .setDesc('Default localhost:11434. Run `ollama serve` to start the daemon.')
        .addText((text) =>
          text
            .setPlaceholder('http://localhost:11434')
            .setValue(this.plugin.settings.ollamaBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.ollamaBaseUrl = value.trim();
              await this.plugin.saveSettings();
            })
        );
      new Setting(containerEl)
        .setName('Model')
        .setDesc('Run `ollama pull llama3.2` (or other) first.')
        .addText((text) =>
          text
            .setPlaceholder('llama3.2')
            .setValue(this.plugin.settings.ollamaModel)
            .onChange(async (value) => {
              this.plugin.settings.ollamaModel = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }
  }

  private renderWorkerDiagnostic(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: 'diary-bot-card' });
    card.createEl('h4', { text: 'Worker Diagnostic' });
    const status = card.createEl('p', { cls: 'dim', text: 'Click "Test Worker" to check that secrets and webhook are configured.' });

    new Setting(card)
      .setName('Test Worker')
      .setDesc('Verifies BOT_TOKEN, DEEPSEEK_API_KEY, KV bindings, and webhook are set.')
      .addButton((btn) =>
        btn.setButtonText('Test Worker').onClick(async () => {
          const url = this.plugin.settings.relayUrl;
          if (!url) {
            status.setText('Set Worker URL first.');
            return;
          }
          status.setText('Checking…');
          const health = await this.plugin.relayClient.checkHealth(url);
          if (!health) {
            status.setText('❌ Worker unreachable. Check the URL or that you deployed the worker.');
            return;
          }
          const lines: string[] = [];
          lines.push(health.bot_token_set ? '✅ BOT_TOKEN set' : '❌ BOT_TOKEN missing — run: wrangler secret put BOT_TOKEN');
          lines.push(health.deepseek_key_set ? '✅ DEEPSEEK_API_KEY set (instant AI replies enabled)' : '⚠️ DEEPSEEK_API_KEY missing — bot will NOT auto-reply when Obsidian is closed. Run: wrangler secret put DEEPSEEK_API_KEY');
          lines.push(health.kv_messages_bound ? '✅ KV MESSAGES bound' : '❌ KV MESSAGES not bound');
          lines.push(health.kv_bindings_bound ? '✅ KV BINDINGS bound' : '❌ KV BINDINGS not bound');
          lines.push(health.webhook_ok ? `✅ Webhook registered: ${health.webhook_url}` : '❌ Webhook NOT registered — visit ' + url + '/setup-webhook once');
          status.empty();
          for (const l of lines) {
            status.createEl('div', { text: l });
          }
        })
      );
  }

  private renderHostedMode(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Hosted Relay' });

    if (this.plugin.settings.creditToken) {
      const card = containerEl.createDiv({ cls: 'diary-bot-status-card' });
      card.createEl('p', { text: 'Connected.' });
      const idLine = card.createEl('p', { cls: 'dim' });
      idLine.appendText('Telegram ID: ');
      idLine.createEl('code', { text: this.plugin.settings.relayUserId });
      const credLine = card.createEl('p', { cls: 'dim-tight' });
      credLine.appendText('Credits remaining: ');
      credLine.createEl('strong', { text: String(this.plugin.settings.credits) });

      new Setting(containerEl)
        .setName('Disconnect')
        .addButton((btn) =>
          btn.setButtonText('Disconnect').setWarning().onClick(async () => {
            this.plugin.settings.creditToken = '';
            this.plugin.settings.relayUserId = '';
            this.plugin.settings.credits = 0;
            await this.plugin.saveSettings();
            this.display();
          })
        );
    } else {
      const guide = containerEl.createDiv({ cls: 'diary-bot-guide' });
      guide.createEl('h3', { text: 'Connect Your Telegram' });
      const ol = guide.createEl('ol');
      [
        'Click "Generate Code" below to get a 6-digit code.',
        'Open Telegram and message the public diary bot.',
        'Send: /bind YOUR_CODE',
        'Come back here and click "Verify".',
      ].forEach((t) => ol.createEl('li', { text: t }));

      this.renderBindButtons(containerEl);
    }
  }

  /** Generate + Verify buttons sharing a class-level bindCode that survives re-renders. */
  private renderBindButtons(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Step 1: Generate Code')
      .setDesc(this.bindCode ? `Current code: ${this.bindCode} — send "/bind ${this.bindCode}" to your bot.` : 'Click to get a 6-digit code.')
      .addButton((btn) =>
        btn.setButtonText(this.bindCode ? `Code: ${this.bindCode}` : 'Generate Code').onClick(() => {
          this.bindCode = this.plugin.relayClient.generateBindCode();
          btn.setButtonText(`Code: ${this.bindCode}`);
          btn.setDisabled(true);
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('Step 2: Verify Binding')
      .setDesc('After sending /bind in Telegram, click here.')
      .addButton((btn) =>
        btn.setButtonText('Verify').onClick(async () => {
          if (!this.bindCode) {
            btn.setButtonText('Generate code first');
            return;
          }
          btn.setButtonText('Checking…');
          const result = await this.plugin.relayClient.checkBinding(this.bindCode);
          if (result) {
            this.plugin.settings.creditToken = result.token;
            this.plugin.settings.relayUserId = result.user_id;
            this.plugin.settings.allowedUserId = result.user_id;
            await this.plugin.saveSettings();
            this.bindCode = '';
            await this.plugin.tryActivate();
            this.display();
          } else {
            btn.setButtonText('Not found — try again');
          }
        })
      );
  }

  /** Shared bind UI used by both modes. Deep-link is primary; legacy 6-digit is fallback. */
  private renderBindingUI(containerEl: HTMLElement): void {
    const guide = containerEl.createDiv({ cls: 'diary-bot-guide' });
    guide.createEl('h3', { text: 'Connect Telegram' });
    guide.createEl('p', {
      text: 'One-tap: click "Connect Telegram" below — it opens your bot chat and binds automatically.',
    });

    this.renderDeepLinkButton(containerEl);

    const fallback = containerEl.createDiv({ cls: 'diary-bot-guide' });
    fallback.createEl('details', { text: '' }).createEl('summary', { text: 'Trouble? Use legacy 6-digit code instead' });
    this.renderBindButtons(fallback);

    new Setting(containerEl)
      .setName('Allowed User ID')
      .setDesc('Your Telegram User ID (auto-filled after binding).')
      .addText((text) =>
        text
          .setPlaceholder('e.g. 123456789')
          .setValue(this.plugin.settings.allowedUserId)
          .onChange(async (value) => {
            this.plugin.settings.allowedUserId = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }

  /** Deep-link one-tap onboarding: t.me/<bot>?start=<token>. */
  private renderDeepLinkButton(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Connect Telegram')
      .setDesc('Click to open your bot chat with a one-time bind link. After Telegram confirms, this plugin auto-connects.')
      .addButton((btn) =>
        btn.setButtonText('Connect Telegram').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('Preparing…');
          // Look up bot username from worker /health (worker has BOT_TOKEN).
          const health = await this.plugin.relayClient.checkHealth();
          const botUsername = health?.bot_username;
          if (!botUsername) {
            btn.setButtonText('Worker unreachable — check Relay URL');
            btn.setDisabled(false);
            return;
          }
          const init = await this.plugin.relayClient.initDeepLinkBind(botUsername);
          if (!init) {
            btn.setButtonText('Failed — retry');
            btn.setDisabled(false);
            return;
          }
          btn.setButtonText('Waiting for Telegram…');
          window.open(init.url, '_blank');
          // Poll bind-status up to 5 minutes.
          const start = Date.now();
          const maxMs = 5 * 60 * 1000;
          const poll = async () => {
            if (Date.now() - start > maxMs) {
              btn.setButtonText('Link expired — retry');
              btn.setDisabled(false);
              return;
            }
            const result = await this.plugin.relayClient.pollBindStatus(init.token);
            if (result) {
              this.plugin.settings.creditToken = result.token;
              this.plugin.settings.relayUserId = result.user_id;
              this.plugin.settings.allowedUserId = result.user_id;
              await this.plugin.saveSettings();
              await this.plugin.tryActivate();
              this.display();
              return;
            }
            setTimeout(poll, 2500);
          };
          poll();
        })
      );
  }

  private renderSharedSettings(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Interaction' });

    new Setting(containerEl)
      .setName('Reply Mode')
      .setDesc('Conversation: AI reflects with you. Silent: bot just records, no AI replies.')
      .addDropdown((dd) =>
        dd
          .addOption('conversation', 'Chat (AI replies)')
          .addOption('silent', 'Silent (record-only)')
          .setValue(this.plugin.settings.replyMode)
          .onChange(async (value: 'silent' | 'conversation') => {
            this.plugin.settings.replyMode = value;
            await this.plugin.saveSettings();
            if (this.plugin.settings.relayUserId) {
              await this.plugin.relayClient.pushPref(this.plugin.settings.relayUserId, { replyMode: value });
            }
            this.display();
          })
      );

    containerEl.createEl('h3', { text: 'Memory' });

    new Setting(containerEl)
      .setName('Recency memory (last N days)')
      .setDesc('Inject the last N daily notes into AI context.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableMemory).onChange(async (v) => {
          this.plugin.settings.enableMemory = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Memory window (days)')
      .addSlider((s) =>
        s
          .setLimits(0, 30, 1)
          .setValue(this.plugin.settings.memoryDays)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.memoryDays = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Tag-based memory (RAG)')
      .setDesc('When ON, also pull older entries that share tags with the current message.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableTagRag).onChange(async (v) => {
          this.plugin.settings.enableTagRag = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Auto-create entity notes')
      .setDesc('Create [[wikilink]] stub notes for people / places / projects mentioned in entries.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableEntityLinks).onChange(async (v) => {
          this.plugin.settings.enableEntityLinks = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Vault-wide search (experimental)')
      .setDesc('When ON, memory also searches non-diary notes.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableVaultWideSearch).onChange(async (v) => {
          this.plugin.settings.enableVaultWideSearch = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: 'Vault Layout' });

    new Setting(containerEl)
      .setName('Diary Folder')
      .addText((t) =>
        t.setPlaceholder('Journal').setValue(this.plugin.settings.diaryFolder).onChange(async (v) => {
          this.plugin.settings.diaryFolder = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('People Folder')
      .addText((t) =>
        t.setPlaceholder('Journal/People').setValue(this.plugin.settings.peopleFolder).onChange(async (v) => {
          this.plugin.settings.peopleFolder = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Places Folder')
      .addText((t) =>
        t.setPlaceholder('Journal/Places').setValue(this.plugin.settings.placesFolder).onChange(async (v) => {
          this.plugin.settings.placesFolder = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Projects Folder')
      .addText((t) =>
        t.setPlaceholder('Journal/Projects').setValue(this.plugin.settings.projectsFolder).onChange(async (v) => {
          this.plugin.settings.projectsFolder = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: 'Session' });

    new Setting(containerEl)
      .setName('Max Follow-up Questions')
      .setDesc('How many AI questions before auto-summarising.')
      .addSlider((s) =>
        s
          .setLimits(1, 5, 1)
          .setValue(this.plugin.settings.maxFollowUpQuestions)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxFollowUpQuestions = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Session Timeout')
      .setDesc('Auto-save the session after this many minutes of inactivity.')
      .addDropdown((dd) =>
        dd
          .addOption('15', '15 min')
          .addOption('30', '30 min')
          .addOption('60', '60 min')
          .setValue(this.plugin.settings.sessionTimeoutMinutes.toString())
          .onChange(async (v) => {
            this.plugin.settings.sessionTimeoutMinutes = parseInt(v, 10);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Daily Report Time')
      .setDesc('Auto-generate an evening review at this time (HH:mm).')
      .addText((t) =>
        t
          .setPlaceholder('21:00')
          .setValue(this.plugin.settings.dailyReportTime)
          .onChange(async (v) => {
            this.plugin.settings.dailyReportTime = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
