import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SmartNote {
  id: string;
  subjectId: string;
  title?: string;
  text: string;
  contentHTML?: string;
  category?: string;
  tags?: string[];
  color?: string;
  pinned?: boolean;
  date: string;
  updatedAt?: string;
}

export interface DraftState {
  subjectId: string;
  noteId: string | null;
  title: string;
  contentHTML: string;
  plainText: string;
  category: string;
  tags: string[];
  splitContentHTML?: string;
  splitPlainText?: string;
  updatedAt: string;
}

export interface AtomicWriteResult {
  success: boolean;
  checksum: string;
  bytesWritten: number;
  backupPath?: string;
  error?: string;
}

/**
 * Computes a deterministic SHA-256 hex digest for integrity verification.
 */
export function computeChecksum(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Performs a strict atomic write operation:
 * 1. Ensures target directory exists.
 * 2. Writes full UTF-8 content to a process/timestamp-scoped `.tmp` file.
 * 3. Flushes file descriptor (`fsyncSync`) to physical storage so power loss cannot leave a 0-byte file.
 * 4. Atomically renames `.tmp` over the target path (`renameSync`).
 * 5. Writes a sidecar `.sha256` checksum for corruption detection on startup.
 */
export function writeAtomicJson(targetPath: string, data: unknown): AtomicWriteResult {
  try {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    // Validate that serialized string is valid JSON before touching disk
    JSON.parse(serialized);

    const checksum = computeChecksum(serialized);
    const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const tempPath = `${targetPath}.${uniqueSuffix}.tmp`;

    const fd = fs.openSync(tempPath, 'w');
    try {
      fs.writeFileSync(fd, serialized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tempPath, targetPath);

    // Also write sidecar checksum atomically
    const checksumTmp = `${targetPath}.sha256.${uniqueSuffix}.tmp`;
    fs.writeFileSync(checksumTmp, checksum, 'utf8');
    fs.renameSync(checksumTmp, `${targetPath}.sha256`);

    return {
      success: true,
      checksum,
      bytesWritten: Buffer.byteLength(serialized, 'utf8'),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      checksum: '',
      bytesWritten: 0,
      error: message,
    };
  }
}

/**
 * Creates a timestamped or daily snapshot in `backupDir` and prunes old snapshots beyond `maxBackups`.
 */
export function createRollingBackup(
  sourceData: unknown,
  backupDir: string,
  maxBackups = 14,
  prefix = 'state_'
): string | null {
  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const today = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(backupDir, `${prefix}${today}.json`);
    const writeRes = writeAtomicJson(backupPath, sourceData);
    if (!writeRes.success) return null;

    // Prune older backups while keeping the newest `maxBackups`
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json') && !f.endsWith('.tmp'))
      .map((f) => {
        const full = path.join(backupDir, f);
        return { name: f, full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const oldFile of files.slice(maxBackups)) {
      try {
        fs.unlinkSync(oldFile.full);
        if (fs.existsSync(`${oldFile.full}.sha256`)) {
          fs.unlinkSync(`${oldFile.full}.sha256`);
        }
      } catch {
        // Ignore cleanup errors
      }
    }

    return backupPath;
  } catch {
    return null;
  }
}

/**
 * Reads JSON state safely with automatic corruption detection and fallback to the latest valid backup.
 */
export function readStateWithRecovery<T = Record<string, unknown>>(
  primaryPath: string,
  backupDir: string,
  fallbackFactory: () => T
): { state: T; recoveredFromBackup: boolean; sourcePath: string } {
  const tryParseFile = (filePath: string): T | null => {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as T;
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  };

  const primaryData = tryParseFile(primaryPath);
  if (primaryData !== null) {
    return { state: primaryData, recoveredFromBackup: false, sourcePath: primaryPath };
  }

  // Primary state is missing or corrupted — scan backupDir from newest to oldest
  if (fs.existsSync(backupDir)) {
    try {
      const backups = fs
        .readdirSync(backupDir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
        .map((f) => {
          const full = path.join(backupDir, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      for (const candidate of backups) {
        const recovered = tryParseFile(candidate.full);
        if (recovered !== null) {
          // Immediately heal primary file atomically
          writeAtomicJson(primaryPath, recovered);
          return {
            state: recovered,
            recoveredFromBackup: true,
            sourcePath: candidate.full,
          };
        }
      }
    } catch {
      // Proceed to fallbackFactory
    }
  }

  const initial = fallbackFactory();
  writeAtomicJson(primaryPath, initial);
  return { state: initial, recoveredFromBackup: false, sourcePath: 'default_seed' };
}

/**
 * Converts rich HTML note content into clean, structured plain text for `.txt` export
 * while preserving headings, bullet points, numbered lists, blockquotes, line breaks, and special characters.
 */
export function htmlToFormattedText(htmlOrText: string): string {
  if (!htmlOrText) return '';

  let text = htmlOrText;

  // Normalize block-level tags and list items before stripping tags
  text = text
    .replace(/<hr\s*\/?>/gi, '\n----------------------------------------\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h1[^>]*>(.*?)<\/h1>/gis, '\n# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gis, '\n## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gis, '\n### $1\n')
    .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gis, '\n> $1\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gis, '  * $1\n')
    .replace(/<\/(p|div|ul|ol|pre|table|tr)>/gi, '\n');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode standard HTML entities safely (including special characters & Unicode)
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&copy;': '(c)',
    '&mdash;': '--',
    '&ndash;': '-',
    '&bull;': '*',
  };

  text = text.replace(/&[a-zA-Z0-9#]+;/g, (entity) => {
    if (entities[entity]) return entities[entity];
    if (entity.startsWith('&#x') || entity.startsWith('&#X')) {
      const code = parseInt(entity.slice(3, -1), 16);
      return !Number.isNaN(code) ? String.fromCodePoint(code) : entity;
    }
    if (entity.startsWith('&#')) {
      const code = parseInt(entity.slice(2, -1), 10);
      return !Number.isNaN(code) ? String.fromCodePoint(code) : entity;
    }
    return entity;
  });

  // Normalize excessive blank lines (max 2 consecutive newlines)
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Formats one or multiple Smart Notes into a complete, ready-to-save `.txt` document.
 */
export function formatNotesForTxtExport(
  notes: SmartNote[],
  subjectName = 'Study Hub Workspace'
): string {
  const headerLines = [
    '========================================================================',
    `STUDY HUB - SMART NOTES EXPORT`,
    `Subject / Scope : ${subjectName}`,
    `Exported At     : ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    `Total Notes     : ${notes.length}`,
    '========================================================================',
    '',
  ];

  if (!notes || notes.length === 0) {
    return [...headerLines, '(No notes selected for export)', ''].join('\n');
  }

  const bodyBlocks = notes.map((note, idx) => {
    const title = (note.title || '').trim() || `Note #${idx + 1}`;
    const category = (note.category || 'General').trim();
    const tags = Array.isArray(note.tags) && note.tags.length > 0 ? note.tags.join(', ') : 'None';
    const rawBody = note.contentHTML ? htmlToFormattedText(note.contentHTML) : (note.text || '').trim();

    return [
      `[${idx + 1}] ${title}${note.pinned ? ' [PINNED]' : ''}`,
      `Category : ${category} | Tags: ${tags} | Date: ${note.date || 'N/A'}`,
      '------------------------------------------------------------------------',
      rawBody || '(Empty note)',
      '',
      '========================================================================',
      '',
    ].join('\n');
  });

  return [...headerLines, ...bodyBlocks].join('\n');
}

/**
 * Filters and sorts notes by subject, category, tag, and search query, keeping pinned notes first.
 */
export function filterAndSortNotes(
  notes: SmartNote[],
  options: {
    subjectId?: string;
    category?: string;
    tag?: string;
    query?: string;
  }
): SmartNote[] {
  const { subjectId, category, tag, query } = options;
  const normalizedQuery = (query || '').trim().toLowerCase();
  const normalizedCategory = (category || 'ALL').trim();
  const normalizedTag = (tag || '').trim().toLowerCase();

  return notes
    .filter((n) => {
      if (subjectId && n.subjectId !== subjectId) return false;
      if (normalizedCategory && normalizedCategory !== 'ALL') {
        const noteCat = (n.category || 'General').trim();
        if (noteCat.toLowerCase() !== normalizedCategory.toLowerCase()) return false;
      }
      if (normalizedTag) {
        const noteTags = Array.isArray(n.tags) ? n.tags.map((t) => t.toLowerCase()) : [];
        if (!noteTags.includes(normalizedTag)) return false;
      }
      if (normalizedQuery) {
        const titleMatch = (n.title || '').toLowerCase().includes(normalizedQuery);
        const textMatch = (n.text || '').toLowerCase().includes(normalizedQuery);
        const htmlPlainMatch = n.contentHTML
          ? htmlToFormattedText(n.contentHTML).toLowerCase().includes(normalizedQuery)
          : false;
        const catMatch = (n.category || '').toLowerCase().includes(normalizedQuery);
        const tagMatch = Array.isArray(n.tags)
          ? n.tags.some((t) => t.toLowerCase().includes(normalizedQuery))
          : false;
        return titleMatch || textMatch || htmlPlainMatch || catMatch || tagMatch;
      }
      return true;
    })
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1;
      }
      return 0;
    });
}
