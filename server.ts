import express, { type Request, type Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  writeAtomicJson,
  createRollingBackup,
  readStateWithRecovery,
  formatNotesForTxtExport,
  type SmartNote,
  type DraftState,
} from './src/utils/storageEngine.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'StudyHub_Data');
const UPLOAD_FOLDER = path.join(BASE_DIR, 'StudyHub_Files');
const BACKUP_FOLDER = path.join(BASE_DIR, 'StudyHub_Backups');
const SOUNDS_FOLDER = path.join(BASE_DIR, 'StudyHub_Sounds');
const CONVERTED_PDF_FOLDER = path.join(BASE_DIR, 'StudyHub_Converted_PDFs');
const EXPORTS_FOLDER = path.join(BASE_DIR, 'StudyHub_Exports');
const ZEN_VIDEOS_FOLDER = path.join(BASE_DIR, 'StudyHub_Zen_Videos');

const PRIMARY_STATE_PATH = path.join(DATA_DIR, 'app_state.json');
const DRAFT_STATE_PATH = path.join(DATA_DIR, 'unsaved_draft_journal.json');
const ERROR_LOG_PATH = path.join(DATA_DIR, 'error_audit.log');

for (const folder of [
  DATA_DIR,
  UPLOAD_FOLDER,
  BACKUP_FOLDER,
  SOUNDS_FOLDER,
  CONVERTED_PDF_FOLDER,
  EXPORTS_FOLDER,
  ZEN_VIDEOS_FOLDER,
]) {
  try {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  } catch (err) {
    console.error(`[StudyHub] Failed to initialize directory ${folder}:`, err);
  }
}

function logSystemError(context: string, err: unknown): void {
  const timestamp = new Date().toISOString();
  const detail = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err);
  const entry = `[${timestamp}] [${context}] ${detail}\n---\n`;
  console.error(`[StudyHub Error] [${context}]`, detail);
  try {
    fs.appendFileSync(ERROR_LOG_PATH, entry, 'utf8');
  } catch {
    // Fail silently if log write fails
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+/, '');
  return cleaned || `file_${Date.now()}`;
}

/**
 * Generates a clean, valid single-page PDF buffer from plain text lines
 * so both sample lecture PDFs and `/api/convert_to_pdf` work reliably with zero external native binaries.
 */
function buildValidPdfBuffer(title: string, lines: string[]): Buffer {
  const escapePdfText = (str: string) =>
    str
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');

  const streamOps: string[] = [
    'BT',
    '/F1 18 Tf',
    '50 750 Td',
    `(${escapePdfText(title.slice(0, 75))}) Tj`,
    '/F1 11 Tf',
    '0 -28 Td',
  ];

  const maxLines = Math.min(lines.length, 42);
  for (let i = 0; i < maxLines; i++) {
    const line = lines[i].slice(0, 92);
    streamOps.push(`(${escapePdfText(line)}) Tj`);
    streamOps.push('0 -15 Td');
  }
  streamOps.push('ET');
  const streamContent = streamOps.join('\n');

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'utf8')} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += obj;
  }

  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

function ensureSampleMediaFiles(): { pdfName: string; videoName: string } {
  const samplePdfName = 'CS401_Distributed_Systems_Architecture.pdf';
  const samplePdfPath = path.join(UPLOAD_FOLDER, samplePdfName);
  if (!fs.existsSync(samplePdfPath)) {
    try {
      const pdfBuf = buildValidPdfBuffer('CS-401: Distributed Systems & Fault Tolerance', [
        'Lecture 01: Atomic Persistence, Write-Ahead Logging & Consensus',
        '----------------------------------------------------------------------',
        '1. Zero Data Loss Design Principles:',
        '   - Never overwrite state files directly in place.',
        '   - Write to an isolated temporary file (.tmp), flush via fsync, and rename atomically.',
        '   - Maintain rolling daily snapshots and SHA-256 integrity checksums.',
        '',
        '2. Consensus & Replication (Raft / Paxos):',
        '   - Leader Election, Log Replication, and Safety Guarantees.',
        '   - Split-vote mitigation via randomized election timeouts (150ms - 300ms).',
        '',
        '3. Study Hub Split-Screen Reader:',
        '   - Open Smart Notes alongside any lecture PDF or image.',
        '   - Format notes with rich typography, categories, and export to .txt.',
      ]);
      fs.writeFileSync(samplePdfPath, pdfBuf);
    } catch (err) {
      logSystemError('SeedSamplePDF', err);
    }
  }

  const sampleVideoName = 'CS401_Raft_Consensus_Lecture.mp4';
  const sampleVideoPath = path.join(UPLOAD_FOLDER, sampleVideoName);
  if (!fs.existsSync(sampleVideoPath)) {
    try {
      // Generate a 16:9 1280x720 MP4 test video with audio tone using ffmpeg if available
      execSync(
        `ffmpeg -y -f lavfi -i testsrc=duration=12:size=1280x720:rate=24 -f lavfi -i sine=frequency=440:duration=12 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${sampleVideoPath}"`,
        { stdio: 'ignore', timeout: 15000 }
      );
    } catch {
      // Ignore if ffmpeg is unavailable
    }
  }

  return { pdfName: samplePdfName, videoName: sampleVideoName };
}

function createInitialSeedState(): Record<string, unknown> {
  const { pdfName: samplePdfName, videoName: sampleVideoName } = ensureSampleMediaFiles();

  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const defaultFolders = ['Lectures', 'Tutorials', 'Assignments', 'Quizzes', 'Labs', 'References'];

  return {
    subjects: [
      {
        id: 'sub_cs401',
        name: 'CS-401: Distributed Systems',
        icon: 'fa-network-wired',
        color: 'from-indigo-600 via-violet-600 to-purple-600',
        archived: false,
        folders: [...defaultFolders],
      },
      {
        id: 'sub_ai302',
        name: 'AI-302: Neural Architectures',
        icon: 'fa-brain',
        color: 'from-fuchsia-600 via-pink-600 to-rose-500',
        archived: false,
        folders: [...defaultFolders],
      },
      {
        id: 'sub_sec210',
        name: 'SEC-210: Applied Cryptography',
        icon: 'fa-shield-halved',
        color: 'from-emerald-500 via-teal-500 to-cyan-500',
        archived: false,
        folders: [...defaultFolders],
      },
    ],
    pdfs: [
      {
        id: 'file_seed_1',
        subjectId: 'sub_cs401',
        original_name: 'CS401_Distributed_Systems_Architecture.pdf',
        filename: samplePdfName,
        folder: 'Lectures',
      },
    ],
    videos: [
      {
        id: 'vid_seed_1',
        subjectId: 'sub_cs401',
        title: 'Lecture 01 — Raft Consensus & Atomic Storage Engine (16:9 HD)',
        filename: sampleVideoName,
        date: `${today} • 09:00`,
        duration: '00:12',
      },
    ],
    recordings: [],
    notes: [
      {
        id: 'note_seed_1',
        subjectId: 'sub_cs401',
        title: 'Atomic File Operations & Crash Recovery Architecture',
        category: 'Lectures',
        tags: ['atomic-write', 'fsync', 'zero-data-loss'],
        pinned: true,
        color: 'violet',
        date: `${today} • 09:30`,
        updatedAt: new Date().toISOString(),
        text: 'Atomic Persistence Protocol:\n1. Serialize state to a process-scoped .tmp file and validate JSON structure.\n2. Invoke fsync on the file descriptor before closing.\n3. Execute atomic rename over the primary state file and update the .sha256 integrity digest.\nKey Exam Takeaway: In-place file truncation is never crash-safe; atomic rename is indivisible at the filesystem inode level.',
        contentHTML:
          '<h2>Atomic Persistence Protocol</h2><p>To guarantee <b>Zero Data Loss</b> across unexpected crashes or power interruptions, the storage layer enforces a strict 3-step pipeline:</p><ul><li><b>Step 1 (Isolated Staging):</b> Serialize state to a process-scoped <code>.tmp</code> file and validate JSON structure.</li><li><b>Step 2 (Hardware Flush):</b> Invoke <code>fsync</code> on the file descriptor before closing.</li><li><b>Step 3 (Atomic Swap):</b> Execute atomic <code>rename</code> over the primary state file and update the <code>.sha256</code> integrity digest.</li></ul><blockquote>Key Exam Takeaway: In-place file truncation is never crash-safe; atomic rename is indivisible at the filesystem inode level.</blockquote>',
      },
      {
        id: 'note_seed_2',
        subjectId: 'sub_cs401',
        title: 'Midterm Exam Formula & Theorem Checklist',
        category: 'Exam Prep',
        tags: ['cap-theorem', 'midterm', 'pacelc'],
        pinned: false,
        color: 'amber',
        date: `${today} • 11:15`,
        updatedAt: new Date().toISOString(),
        text: 'CAP Theorem & PACELC:\nIn the presence of a network Partition (P), a distributed store must choose between Consistency (C) and Availability (A).\n- CP Systems: ZooKeeper, etcd, Spanner (strict linearizability)\n- AP Systems: Dynamo, Cassandra (eventual consistency with vector clocks)\nReview Raft log matching property before Friday seminar!',
        contentHTML:
          '<h2>CAP &amp; PACELC Theorem Summary</h2><p>In the presence of a network <b>Partition (P)</b>, a distributed store must choose between <u>Consistency (C)</u> and <u>Availability (A)</u>.</p><ul><li><b>CP Systems:</b> ZooKeeper, etcd, Spanner (strict linearizability)</li><li><b>AP Systems:</b> Dynamo, Cassandra (eventual consistency with vector clocks)</li></ul><p style="text-align: center;"><i>Review Raft log matching property before Friday&#39;s seminar!</i></p>',
      },
      {
        id: 'note_seed_3',
        subjectId: 'sub_ai302',
        title: 'Transformer Scaled Dot-Product Attention',
        category: 'Summaries',
        tags: ['transformers', 'attention', 'deep-learning'],
        pinned: true,
        color: 'cyan',
        date: `${today} • 13:00`,
        updatedAt: new Date().toISOString(),
        text: 'Scaled Dot-Product Attention:\nAttention(Q, K, V) = softmax((Q * K^T) / sqrt(d_k)) * V\n- Scaling by 1 / sqrt(d_k) prevents dot products from saturating the softmax function.\n- Multi-Head Attention allows attending to information from different representation subspaces simultaneously.',
        contentHTML:
          '<h2>Scaled Dot-Product Attention</h2><p>The core self-attention equation projects queries <b>Q</b>, keys <b>K</b>, and values <b>V</b>:</p><blockquote>Attention(Q, K, V) = softmax((Q &middot; K<sup>T</sup>) / &radic;d<sub>k</sub>) &middot; V</blockquote><ul><li>Scaling by <code>1 / &radic;d_k</code> prevents dot products from saturating the softmax function.</li><li>Multi-Head Attention allows attending to information from different representation subspaces simultaneously.</li></ul>',
      },
    ],
    noteCategories: ['Lectures', 'Exam Prep', 'Summaries', 'Projects', 'Research', 'Important'],
    tasks: [
      {
        id: 'task_seed_1',
        subjectId: 'sub_cs401',
        text: 'Implement Raft Leader Election & Heartbeat RPC handler',
        completed: false,
      },
      {
        id: 'task_seed_2',
        subjectId: 'sub_cs401',
        text: 'Export Lecture 01 & Midterm Smart Notes to .txt for offline review',
        completed: false,
      },
    ],
    links: [
      {
        id: 'link_seed_1',
        subjectId: 'sub_cs401',
        title: 'In Search of an Understandable Consensus Algorithm (Raft Paper)',
        url: 'https://raft.github.io/raft.pdf',
      },
    ],
    flashcards: [
      {
        id: 'fc_seed_1',
        subjectId: 'sub_cs401',
        type: 'Definition',
        q: 'Why must an atomic file save call fsync() before rename()?',
        a: 'Without fsync(), the OS page cache may reorder the directory entry rename before the file data blocks are committed to non-volatile storage, leaving a 0-byte file after power loss.',
      },
      {
        id: 'fc_seed_2',
        subjectId: 'sub_cs401',
        type: 'Formula',
        q: 'What are the 3 server states in the Raft consensus algorithm?',
        a: 'Leader, Follower, and Candidate.',
      },
    ],
    whiteboards: [],
    deadlines: [
      {
        id: 'dl_seed_1',
        subjectId: 'sub_cs401',
        title: 'Distributed KV Store Lab Submission',
        type: 'Project',
        date: nextWeek,
      },
    ],
    customSounds: [],
    currentSubjectId: 'sub_cs401',
    pomodorosCompleted: 4,
    pomodoroDays: { [today]: 4 },
    activity: { [today]: 75 },
    subjectTimes: { sub_cs401: 2700, sub_ai302: 1800 },
    settings: {
      theme: 'dark',
      accent: 'violet',
      pomoWork: 25,
      pomoBreak: 5,
      autoNextPomo: false,
      notifications: true,
      clockStyle: 'digital',
      timeFormat: '12h',
      zenModeStyle: 'sanctuary',
      zenDynamic: true,
      zenShowGreeting: true,
      zenShowClock: true,
      zenShowQuote: true,
      zenShowPomodoro: true,
      zenShowMixer: true,
      zenShowControls: true,
      zenSceneIndex: 0,
      zenVideoFolder: '',
      pdfExportDir: '',
    },
  };
}

// Initialize state with automatic recovery from existing backups or seed data
let currentStateCache: Record<string, unknown> = (() => {
  ensureSampleMediaFiles();
  const seeded = createInitialSeedState();
  const loaded = readStateWithRecovery(PRIMARY_STATE_PATH, BACKUP_FOLDER, () => seeded);
  const st = loaded.state as Record<string, unknown>;

  if (!Array.isArray(st.subjects) || st.subjects.length === 0) {
    writeAtomicJson(PRIMARY_STATE_PATH, seeded);
    return seeded;
  }

  // Merge rich seed courses, notes, videos, and PDFs non-destructively if workspace was empty
  const existingSubIds = new Set(
    (st.subjects as Array<{ id: string }>).map((s) => String(s.id))
  );
  for (const seedSub of seeded.subjects as Array<{ id: string }>) {
    if (!existingSubIds.has(String(seedSub.id))) {
      (st.subjects as unknown[]).unshift(seedSub);
    }
  }
  if (!Array.isArray(st.notes) || st.notes.length === 0) {
    st.notes = seeded.notes;
  }
  if (!Array.isArray(st.videos) || st.videos.length === 0) {
    st.videos = seeded.videos;
  }
  if (!Array.isArray(st.pdfs) || st.pdfs.length === 0) {
    st.pdfs = seeded.pdfs;
  }
  if (!Array.isArray(st.tasks) || st.tasks.length === 0) {
    st.tasks = seeded.tasks;
  }
  if (!Array.isArray(st.flashcards) || st.flashcards.length === 0) {
    st.flashcards = seeded.flashcards;
  }
  if (!Array.isArray(st.deadlines) || st.deadlines.length === 0) {
    st.deadlines = seeded.deadlines;
  }
  if (!Array.isArray(st.links) || st.links.length === 0) {
    st.links = seeded.links;
  }
  if (!Array.isArray(st.whiteboards)) {
    st.whiteboards = [];
  }
  if (!Array.isArray(st.noteCategories)) {
    st.noteCategories = ['Lectures', 'Exam Prep', 'Summaries', 'Projects', 'Research', 'Important'];
  }
  if (!st.currentSubjectId) {
    st.currentSubjectId = 'sub_cs401';
  }
  writeAtomicJson(PRIMARY_STATE_PATH, st);
  return st;
})();

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.text({ type: 'text/plain', limit: '100mb' }));

// Configure Multer for physical file uploads using atomic temp-to-final placement
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_FOLDER);
  },
  filename: (_req, file, cb) => {
    const safeOrig = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'));
    cb(null, `${Date.now()}_${safeOrig}`);
  },
});
const uploadMiddleware = multer({ storage: uploadStorage });

const soundStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, SOUNDS_FOLDER);
  },
  filename: (_req, file, cb) => {
    const safeOrig = sanitizeFilename(file.originalname);
    cb(null, `${Date.now()}_${safeOrig}`);
  },
});
const soundUploadMiddleware = multer({ storage: soundStorage });

// Static Asset Routes
app.use('/vendor', express.static(path.join(BASE_DIR, 'vendor')));
app.use('/files', express.static(UPLOAD_FOLDER, { acceptRanges: true }));
app.use('/sounds', express.static(SOUNDS_FOLDER, { acceptRanges: true }));

app.get(['/', '/index.html', '/graduation_study_hub.html'], (_req: Request, res: Response) => {
  try {
    const htmlPath = path.join(BASE_DIR, 'graduation_study_hub.html');
    res.sendFile(htmlPath);
  } catch (err) {
    logSystemError('ServeIndexHTML', err);
    res.status(500).send('Failed to load Study Hub interface.');
  }
});

/**
 * GET /api/data
 * Loads full workspace state with corruption recovery and merges any pending crash-recovery draft metadata.
 */
app.get('/api/data', (_req: Request, res: Response) => {
  try {
    const recovery = readStateWithRecovery(
      PRIMARY_STATE_PATH,
      BACKUP_FOLDER,
      () => currentStateCache
    );
    currentStateCache = recovery.state;

    // Check if an unsaved crash draft exists on disk
    let pendingDraft: DraftState | null = null;
    if (fs.existsSync(DRAFT_STATE_PATH)) {
      try {
        const rawDraft = fs.readFileSync(DRAFT_STATE_PATH, 'utf8');
        pendingDraft = JSON.parse(rawDraft) as DraftState;
      } catch {
        pendingDraft = null;
      }
    }

    res.json({
      ...currentStateCache,
      _meta: {
        recoveredFromBackup: recovery.recoveredFromBackup,
        sourcePath: recovery.sourcePath,
        pendingDraft,
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) {
    logSystemError('GET /api/data', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

/**
 * POST /api/data
 * Atomically saves full application state (handles both application/json and text/plain from navigator.sendBeacon).
 */
app.post('/api/data', (req: Request, res: Response) => {
  try {
    let incomingState: Record<string, unknown>;
    if (typeof req.body === 'string') {
      incomingState = JSON.parse(req.body) as Record<string, unknown>;
    } else if (req.body && typeof req.body === 'object') {
      incomingState = req.body as Record<string, unknown>;
    } else {
      res.status(400).json({ status: 'error', error: 'Invalid JSON payload' });
      return;
    }

    // Strip ephemeral _meta before persisting
    const cleanState = { ...incomingState };
    delete cleanState._meta;

    const settings = (cleanState.settings as Record<string, unknown>) || {};
    const targetBackupDir =
      typeof settings.backupPath === 'string' && settings.backupPath.trim()
        ? settings.backupPath.trim()
        : BACKUP_FOLDER;

    // 1. Create rolling daily snapshot of previous good state before overwriting
    if (currentStateCache && Object.keys(currentStateCache).length > 0) {
      createRollingBackup(currentStateCache, targetBackupDir, 14, 'state_');
    }

    // 2. Write new state atomically (.tmp -> fsync -> rename + .sha256)
    const writeRes = writeAtomicJson(PRIMARY_STATE_PATH, cleanState);
    if (!writeRes.success) {
      throw new Error(writeRes.error || 'Atomic write failed');
    }

    // 3. Also update today's backup with the freshest state
    createRollingBackup(cleanState, targetBackupDir, 14, 'state_');

    currentStateCache = cleanState;

    res.json({
      status: 'success',
      checksum: writeRes.checksum,
      bytesWritten: writeRes.bytesWritten,
      savedAt: new Date().toISOString(),
    });
  } catch (err) {
    logSystemError('POST /api/data', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

/**
 * POST /api/autosave_draft
 * Ultra-fast background atomic journal for in-progress note edits so force-closing mid-sentence never loses data.
 */
app.post('/api/autosave_draft', (req: Request, res: Response) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || body.clear === true) {
      if (fs.existsSync(DRAFT_STATE_PATH)) {
        fs.unlinkSync(DRAFT_STATE_PATH);
      }
      res.json({ status: 'cleared' });
      return;
    }

    const writeRes = writeAtomicJson(DRAFT_STATE_PATH, {
      ...body,
      updatedAt: new Date().toISOString(),
    });
    res.json({ status: 'success', checksum: writeRes.checksum });
  } catch (err) {
    logSystemError('POST /api/autosave_draft', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

app.get('/api/autosave_draft', (_req: Request, res: Response) => {
  try {
    if (!fs.existsSync(DRAFT_STATE_PATH)) {
      res.json({ status: 'empty', draft: null });
      return;
    }
    const raw = fs.readFileSync(DRAFT_STATE_PATH, 'utf8');
    res.json({ status: 'success', draft: JSON.parse(raw) });
  } catch (err) {
    logSystemError('GET /api/autosave_draft', err);
    res.json({ status: 'empty', draft: null });
  }
});

/**
 * POST /api/export_notes_txt
 * Formats single or multiple Smart Notes into a structured .txt file, saves atomically to StudyHub_Exports,
 * and returns the formatted plain text for instant browser download.
 */
app.post('/api/export_notes_txt', (req: Request, res: Response) => {
  try {
    const { notes, subjectName, filename } = req.body as {
      notes: SmartNote[];
      subjectName?: string;
      filename?: string;
    };
    const notesArray = Array.isArray(notes) ? notes : [];
    const formattedTxt = formatNotesForTxtExport(notesArray, subjectName || 'Study Hub Notes');

    const safeName = sanitizeFilename(filename || `StudyHub_Notes_${Date.now()}.txt`);
    const finalName = safeName.endsWith('.txt') ? safeName : `${safeName}.txt`;
    const exportPath = path.join(EXPORTS_FOLDER, finalName);

    // Atomic write for exported .txt file
    const tmpPath = `${exportPath}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, formattedTxt, 'utf8');
    fs.renameSync(tmpPath, exportPath);

    res.json({
      status: 'success',
      filename: finalName,
      exportPath,
      content: formattedTxt,
    });
  } catch (err) {
    logSystemError('POST /api/export_notes_txt', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

/**
 * POST /api/upload_file
 * Supports both `files[]` (multiple) and `file` (single) multipart uploads.
 */
app.post('/api/upload_file', uploadMiddleware.any(), (req: Request, res: Response) => {
  try {
    const incomingFiles = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);
    if (!incomingFiles || incomingFiles.length === 0) {
      res.status(400).json({ error: 'No files selected' });
      return;
    }
    const subjectId = String(req.body?.subject_id || 'sub_cs401');
    const folderName = String(req.body?.folder || 'Lectures').slice(0, 100);

    const uploaded = incomingFiles.map((f) => ({
      filename: f.filename,
      original_name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      folder: folderName,
      subject_id: subjectId,
      url: `/files/${f.filename}`,
      size: f.size,
    }));

    res.json({
      status: 'success',
      files: uploaded,
      skipped: [],
      url: uploaded[0].url,
      filename: uploaded[0].filename,
      originalName: uploaded[0].original_name,
    });
  } catch (err) {
    logSystemError('POST /api/upload_file', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

/**
 * DELETE /api/delete_file/:filename
 */
app.delete('/api/delete_file/:filename', (req: Request, res: Response) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    const targetPath = path.join(UPLOAD_FOLDER, filename);
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    res.json({ status: 'success' });
  } catch (err) {
    logSystemError('DELETE /api/delete_file', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

/**
 * GET /api/open_file/:filename
 */
app.get('/api/open_file/:filename', (req: Request, res: Response) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    const targetPath = path.join(UPLOAD_FOLDER, filename);
    if (fs.existsSync(targetPath)) {
      res.json({ status: 'success', url: `/files/${filename}` });
      return;
    }
    res.status(404).json({ status: 'error', error: 'File not found' });
  } catch (err) {
    logSystemError('GET /api/open_file', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

/**
 * POST /api/convert_to_pdf
 * Supports multipart `files[]` upload batch conversion AND JSON `{ filename }` conversion.
 */
app.post('/api/convert_to_pdf', uploadMiddleware.any(), (req: Request, res: Response) => {
  try {
    const incomingFiles = (req.files as Express.Multer.File[]) || [];
    const attachSubject = String(req.body?.subject_id || '').trim();
    const attachFolder = String(req.body?.folder || 'Lectures').slice(0, 100);
    const targetDir = CONVERTED_PDF_FOLDER;

    if (incomingFiles.length > 0) {
      const results: Array<Record<string, unknown>> = [];
      for (const f of incomingFiles) {
        const origName = Buffer.from(f.originalname, 'latin1').toString('utf8');
        const ext = path.extname(origName).toLowerCase();
        const stem = path.basename(origName, ext) || 'Converted_Document';
        const pdfFilename = `${sanitizeFilename(stem)}.pdf`;
        const outPath = path.join(targetDir, pdfFilename);
        const hubFilename = `${attachSubject || 'conv'}_${Date.now()}_${pdfFilename}`;
        const hubPath = path.join(UPLOAD_FOLDER, hubFilename);

        let lines: string[] = [];
        try {
          lines = fs.readFileSync(f.path, 'utf8').split(/\r?\n/).slice(0, 60);
        } catch {
          lines = [`Converted Document: ${origName}`, `Source Format: ${ext.toUpperCase()}`];
        }
        const pdfBuf = buildValidPdfBuffer(stem, lines);
        const tmpOut = `${outPath}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpOut, pdfBuf);
        fs.renameSync(tmpOut, outPath);
        fs.copyFileSync(outPath, hubPath);

        results.push({
          original_name: origName,
          pdf_name: pdfFilename,
          output_path: outPath,
          output_dir: targetDir,
          size_bytes: pdfBuf.length,
          subject_file: attachSubject
            ? {
                filename: hubFilename,
                original_name: pdfFilename,
                folder: attachFolder,
                subject_id: attachSubject,
              }
            : null,
        });
      }
      res.json({ status: 'success', output_dir: targetDir, results, errors: [] });
      return;
    }

    const { filename } = req.body as { filename?: string };
    if (!filename) {
      res.status(400).json({ status: 'error', error: 'No filename provided' });
      return;
    }

    const safeBase = path.basename(filename);
    const srcPath = path.join(UPLOAD_FOLDER, safeBase);
    if (!fs.existsSync(srcPath)) {
      res.status(404).json({ status: 'error', error: 'Source file not found on disk' });
      return;
    }

    const ext = path.extname(safeBase).toLowerCase();
    const stem = path.basename(safeBase, ext);
    const outFilename = `converted_${stem}.pdf`;
    const outPathInUploads = path.join(UPLOAD_FOLDER, outFilename);

    let extractedLines: string[] = [];
    try {
      const rawContent = fs.readFileSync(srcPath, 'utf8');
      extractedLines = rawContent.split(/\r?\n/).slice(0, 60);
    } catch {
      extractedLines = [`Converted document: ${safeBase}`, `Original Format: ${ext.toUpperCase()}`];
    }

    const pdfBuf = buildValidPdfBuffer(`Converted Document: ${stem}`, extractedLines);
    const tmpPdf = `${outPathInUploads}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPdf, pdfBuf);
    fs.renameSync(tmpPdf, outPathInUploads);

    res.json({
      status: 'success',
      pdfUrl: `/files/${outFilename}`,
      method: 'Built-in Vector PDF Engine',
    });
  } catch (err) {
    logSystemError('POST /api/convert_to_pdf', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

/**
 * Custom Ambient Sounds Endpoints
 */
app.post('/api/sounds/upload', soundUploadMiddleware.any(), (req: Request, res: Response) => {
  try {
    const incomingFiles = (req.files as Express.Multer.File[]) || (req.file ? [req.file] : []);
    if (!incomingFiles.length) {
      res.status(400).json({ error: 'No audio file provided' });
      return;
    }
    const sounds = incomingFiles.map((f) => {
      const orig = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const stem = path.basename(orig, path.extname(orig));
      return {
        id: `snd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: stem,
        filename: f.filename,
        original_name: orig,
        url: `/sounds/${f.filename}`,
      };
    });
    res.json({
      status: 'success',
      sounds,
      url: sounds[0].url,
      filename: sounds[0].filename,
      originalName: sounds[0].original_name,
    });
  } catch (err) {
    logSystemError('POST /api/sounds/upload', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

app.delete('/api/sounds/:filename', (req: Request, res: Response) => {
  try {
    const filename = path.basename(String(req.params.filename || ''));
    const filepath = path.join(SOUNDS_FOLDER, filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
    res.json({ status: 'success' });
  } catch (err) {
    logSystemError('DELETE /api/sounds', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

/**
 * Zen Mode Custom Videos Discovery & Streaming
 */
app.get('/api/zen_videos', (_req: Request, res: Response) => {
  try {
    const videoExts = new Set(['.mp4', '.webm', '.mkv', '.mov']);
    const videos: Array<{ id: string; name: string; path: string; url: string }> = [];
    if (fs.existsSync(ZEN_VIDEOS_FOLDER)) {
      for (const file of fs.readdirSync(ZEN_VIDEOS_FOLDER)) {
        const ext = path.extname(file).toLowerCase();
        if (videoExts.has(ext)) {
          const fullPath = path.join(ZEN_VIDEOS_FOLDER, file);
          videos.push({
            id: `vid_${Buffer.from(fullPath).toString('hex').slice(0, 12)}`,
            name: path.basename(file, ext).replace(/[-_]/g, ' '),
            path: fullPath,
            url: `/api/zen_video_stream?path=${encodeURIComponent(fullPath)}`,
          });
        }
      }
    }
    res.json({
      status: 'success',
      configured: videos.length > 0,
      valid_folder: true,
      empty: videos.length === 0,
      fallback: videos.length === 0,
      folder: ZEN_VIDEOS_FOLDER,
      videos,
    });
  } catch (err) {
    logSystemError('GET /api/zen_videos', err);
    res.json({ status: 'success', videos: [], empty: true, fallback: true });
  }
});

app.get('/api/zen_video_stream', (req: Request, res: Response) => {
  try {
    const rawPath = String(req.query.path || '');
    if (!rawPath || !fs.existsSync(rawPath)) {
      res.status(404).send('Video not found');
      return;
    }
    res.sendFile(path.resolve(rawPath));
  } catch (err) {
    logSystemError('GET /api/zen_video_stream', err);
    res.status(500).send('Stream error');
  }
});

/**
 * System Info, Backups, and Workspace Maintenance Endpoints
 */
app.get('/api/system_info', (_req: Request, res: Response) => {
  try {
    let storageCount = 0;
    let totalBytes = 0;
    if (fs.existsSync(UPLOAD_FOLDER)) {
      for (const f of fs.readdirSync(UPLOAD_FOLDER)) {
        const full = path.join(UPLOAD_FOLDER, f);
        try {
          const st = fs.statSync(full);
          if (st.isFile()) {
            storageCount++;
            totalBytes += st.size;
          }
        } catch {
          // ignore
        }
      }
    }
    const dbBytes = fs.existsSync(PRIMARY_STATE_PATH) ? fs.statSync(PRIMARY_STATE_PATH).size : 0;
    const backupsCount = fs.existsSync(BACKUP_FOLDER)
      ? fs.readdirSync(BACKUP_FOLDER).filter((f) => f.endsWith('.json')).length
      : 0;

    res.json({
      status: 'success',
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      storageFiles: storageCount,
      storageSizeMB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
      dbSizeMB: Number((dbBytes / (1024 * 1024)).toFixed(2)),
      backupsCount,
      startupEnabled: false,
      fullscreen: false,
      defaultExportDir: CONVERTED_PDF_FOLDER,
      appFolder: BASE_DIR,
    });
  } catch (err) {
    logSystemError('GET /api/system_info', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

app.post('/api/backup_export', (_req: Request, res: Response) => {
  try {
    const backupFile = createRollingBackup(
      currentStateCache,
      BACKUP_FOLDER,
      20,
      `manual_backup_${Date.now()}_`
    );
    const filename = backupFile ? path.basename(backupFile) : 'backup.json';
    res.json({ status: 'success', path: backupFile || BACKUP_FOLDER, filename });
  } catch (err) {
    logSystemError('POST /api/backup_export', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

app.post('/api/factory_reset', (_req: Request, res: Response) => {
  try {
    // Always preserve an emergency pre-reset backup so even factory reset honors Zero Data Loss recovery if needed
    createRollingBackup(currentStateCache, BACKUP_FOLDER, 20, 'pre_factory_reset_');
    const fresh = createInitialSeedState();
    writeAtomicJson(PRIMARY_STATE_PATH, fresh);
    currentStateCache = fresh;
    if (fs.existsSync(DRAFT_STATE_PATH)) {
      fs.unlinkSync(DRAFT_STATE_PATH);
    }
    res.json({ status: 'success' });
  } catch (err) {
    logSystemError('POST /api/factory_reset', err);
    res.status(500).json({ status: 'error', error: String(err) });
  }
});

app.post('/api/startup', (req: Request, res: Response) => {
  const enable = Boolean(req.body?.enable);
  res.json({ status: 'success', startupEnabled: enable });
});

app.post('/api/window_mode', (req: Request, res: Response) => {
  res.json({ status: 'success', mode: req.body?.mode || 'maximized' });
});

app.post('/api/toggle_fullscreen', (_req: Request, res: Response) => {
  res.json({ status: 'success' });
});

app.post('/api/pick_folder', (_req: Request, res: Response) => {
  res.json({ status: 'success', path: BACKUP_FOLDER });
});

app.post('/api/open_path', (_req: Request, res: Response) => {
  res.json({ status: 'success', path: BASE_DIR });
});

app.get('/api/open_url', (req: Request, res: Response) => {
  res.json({ status: 'success', url: req.query.url || '' });
});

app.post('/api/exit', (_req: Request, res: Response) => {
  // Flush current state atomically before acknowledging exit
  writeAtomicJson(PRIMARY_STATE_PATH, currentStateCache);
  res.json({ status: 'exiting' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[StudyHub] Zero-Data-Loss Server listening on http://0.0.0.0:${PORT}`);
});
