#!/usr/bin/env node
// Copies built plugin files to the Obsidian vault install dir.
// Usage:
//   DIARY_BOT_VAULT=<vault-root> node tools/deploy.js
//   (or set DIARY_BOT_VAULT in your shell)

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.resolve(__dirname, '..');
const VAULT_ROOT = process.env.DIARY_BOT_VAULT || '';
const PLUGIN_FOLDER_NAME = 'obsidian-diary-bot';

const installDir = path.join(VAULT_ROOT, '.obsidian', 'plugins', PLUGIN_FOLDER_NAME);

if (!VAULT_ROOT || !fs.existsSync(VAULT_ROOT)) {
  console.error('[deploy] set DIARY_BOT_VAULT env var to your vault path');
  console.error('[deploy] e.g. DIARY_BOT_VAULT="C:/Users/you/Vault" node tools/deploy.js');
  process.exit(1);
}

if (!fs.existsSync(installDir)) {
  console.log(`[deploy] creating ${installDir}`);
  fs.mkdirSync(installDir, { recursive: true });
}

const FILES = ['main.js', 'manifest.json', 'styles.css', 'versions.json'];
let copied = 0;
for (const f of FILES) {
  const src = path.join(SOURCE_DIR, f);
  if (!fs.existsSync(src)) {
    console.warn(`[deploy] skip (missing): ${f}`);
    continue;
  }
  const dst = path.join(installDir, f);
  fs.copyFileSync(src, dst);
  const stat = fs.statSync(dst);
  console.log(`[deploy] ${f} → ${dst}  (${stat.size} bytes)`);
  copied++;
}
console.log(`[deploy] done, ${copied} file(s) copied to ${installDir}`);
console.log('[deploy] reload plugin in Obsidian: Settings → Community plugins → toggle off/on');
