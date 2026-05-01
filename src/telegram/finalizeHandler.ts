import { TFile, normalizePath } from 'obsidian';
import type DiaryBotPlugin from '../main';
import type { FinalizePacket } from '../relay/relayClient';
import { pad } from '../utils/dateUtils';

/**
 * Handle finalize packet from worker (cloud-side /done output).
 * No AI calls here — packet already has frontmatter + body. We:
 *   1. Download photos via worker /file proxy.
 *   2. Ensure entity stub notes (people / places / projects).
 *   3. Record tasks.
 *   4. Render same wrappedBody layout as legacy in-plugin path.
 *   5. Append to today's daily note via existing NoteWriter.
 */
export async function handleFinalizePacket(plugin: DiaryBotPlugin, packet: FinalizePacket): Promise<void> {
  const userId = plugin.settings.relayUserId;
  if (!userId) return;
  const { frontmatter, body, transcript, photo_ids } = packet;

  // Download photos (if any) via /file. Returns embed wikilinks.
  const photoEmbeds: string[] = [];
  for (const fileId of photo_ids || []) {
    try {
      const buffer = await plugin.relayClient.downloadFile(userId, fileId);
      if (!buffer) continue;
      const fileName = `IMG_${Date.now()}_${Math.floor(Math.random() * 1000)}.jpg`;
      const attFolder = `${plugin.settings.diaryFolder || 'Journal'}/Attachments`;
      await plugin.noteWriter.ensureFolderExists(attFolder);
      const fullPath = normalizePath(`${attFolder}/${fileName}`);
      const created = await plugin.app.vault.createBinary(fullPath, buffer);
      const link = plugin.app.fileManager.generateMarkdownLink(created as TFile, plugin.noteWriter.getDailyNotePath());
      photoEmbeds.push(link.startsWith('!') ? link : `!${link}`);
    } catch (e) {
      console.error('[finalize] photo download failed', e);
    }
  }

  // Entity stub notes (parallel)
  const allEntities: string[] = [];
  const ensurePromises: Promise<unknown>[] = [];
  const collect = (names: any, type: 'person' | 'place' | 'project') => {
    if (!Array.isArray(names)) return;
    for (const raw of names) {
      const name = String(raw).trim();
      if (!name) continue;
      allEntities.push(name);
      if (plugin.settings.enableEntityLinks) {
        ensurePromises.push(plugin.entityNotes.ensureEntityNote(name, type));
      }
    }
  };
  collect(frontmatter.people, 'person');
  collect(frontmatter.places, 'place');
  collect(frontmatter.projects, 'project');
  await Promise.all(ensurePromises);

  // Compose wrappedBody (mirrors legacy layout)
  const now = new Date();
  const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const energyNum = frontmatter.energy || 5;
  const moodLabel = frontmatter.mood || 'journal';
  const moodEmoji = moodToEmoji(frontmatter.mood);

  const photoStr = renderPhotoGallery(photoEmbeds);
  const narrativeBody = body.replace(/^> \*[^\n]+\*?\n*/m, '').replace(/#\S+/g, '').trim();

  const peopleLinks = (frontmatter.people || []).map((n: string) => `[[${n}]]`);
  const placeLinks = (frontmatter.places || []).map((n: string) => `[[${n}]]`);
  const projectLinks = (frontmatter.projects || []).map((n: string) => `[[${n}]]`);
  const topicTags = (frontmatter.topics || []).map((t: string) => `#${t}`);
  const metaInline = [...peopleLinks, ...placeLinks, ...projectLinks, ...topicTags].join(' ');

  const transcriptLines = (transcript || [])
    .map((m) => {
      const clean = (m.content || '')
        .replace(/!\[\[.*?\]\]/g, '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .trim();
      const speaker = m.role === 'user' ? 'Me' : 'AI';
      return clean ? `**${speaker}**: ${clean}` : '';
    })
    .filter(Boolean);
  const transcriptBlock = transcriptLines.length > 0
    ? '\n\n> [!quote]- 💬 Chat\n> ' + transcriptLines.join('\n> ')
    : '';

  const wrappedBody =
    (photoStr ? `${photoStr}\n\n` : '') +
    `## ${stamp} · ${moodEmoji} ${moodLabel} · ⚡ ${energyNum}/10\n\n` +
    narrativeBody +
    (metaInline ? `\n\n${metaInline}` : '') +
    transcriptBlock +
    '\n';

  const fmForNote: Record<string, any> = {
    mood: frontmatter.mood,
    energy: frontmatter.energy,
    starred: false,
    pinned: false,
  };
  if (frontmatter.location) fmForNote.location = frontmatter.location;

  await plugin.noteWriter.appendStructured({
    frontmatter: fmForNote,
    body: wrappedBody,
    entities: allEntities,
  });
}

function renderPhotoGallery(photos: string[]): string {
  if (photos.length === 0) return '';
  if (photos.length === 1) return photos[0];
  const size = photos.length === 2 ? 400 : photos.length === 3 ? 300 : 220;
  return photos.map((p) => withSize(p, size)).join(' ');
}

function withSize(embed: string, size: number): string {
  if (embed.startsWith('![[')) return embed.replace(/]]$/, `|${size}]]`);
  return embed.replace(/^!\[([^\]]*)\]/, (_m, alt) => `![${alt}|${size}]`);
}

function moodToEmoji(mood?: string): string {
  const m = (mood || '').toLowerCase();
  if (m.includes('anxious') || m.includes('worried')) return '😰';
  if (m.includes('sad') || m.includes('down')) return '😢';
  if (m.includes('angry') || m.includes('frustrated')) return '😤';
  if (m.includes('happy') || m.includes('joyful')) return '😊';
  if (m.includes('excited')) return '🎉';
  if (m.includes('calm') || m.includes('peaceful')) return '😌';
  if (m.includes('tired')) return '😴';
  if (m.includes('hopeful')) return '🌱';
  if (m.includes('grateful')) return '🙏';
  if (m.includes('contemplative') || m.includes('reflective')) return '🤔';
  return '💭';
}
