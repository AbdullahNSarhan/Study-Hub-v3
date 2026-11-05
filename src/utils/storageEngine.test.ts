import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  writeAtomicJson,
  createRollingBackup,
  readStateWithRecovery,
  htmlToFormattedText,
  formatNotesForTxtExport,
  filterAndSortNotes,
  type SmartNote,
} from './storageEngine.ts';

describe('Phase 2 & Phase 4 Core Engine Verification', () => {
  test('writeAtomicJson writes valid JSON atomically with checksum and leaves no .tmp artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-atomic-'));
    const targetFile = path.join(tmpDir, 'state.json');

    const payload = {
      subjects: [{ id: 'sub1', name: 'Algorithms & Data Structures' }],
      notes: [{ id: 'n1', subjectId: 'sub1', title: 'Graph Theory', text: 'Dijkstra & A*' }],
    };

    const result = writeAtomicJson(targetFile, payload);
    assert.equal(result.success, true);
    assert.ok(result.bytesWritten > 20);
    assert.equal(result.checksum.length, 64);

    // Verify no .tmp files remain
    const remainingFiles = fs.readdirSync(tmpDir);
    assert.equal(remainingFiles.some((f) => f.endsWith('.tmp')), false);
    assert.equal(fs.existsSync(targetFile), true);
    assert.equal(fs.existsSync(`${targetFile}.sha256`), true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('readStateWithRecovery automatically recovers from backup when primary file is corrupted', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-recovery-'));
    const primaryFile = path.join(tmpDir, 'app_state.json');
    const backupDir = path.join(tmpDir, 'backups');

    const goodState = {
      subjects: [{ id: 's1', name: 'Distributed Systems' }],
      notes: [{ id: 'n1', subjectId: 's1', text: 'Raft Consensus Algorithm' }],
    };

    // Create a valid rolling backup
    const backupFile = createRollingBackup(goodState, backupDir, 5);
    assert.ok(backupFile);

    // Simulate a sudden crash/corruption in primary file
    fs.writeFileSync(primaryFile, '{ "subjects": [ CORRUPTED_JSON_CRASH ', 'utf8');

    const recovery = readStateWithRecovery(primaryFile, backupDir, () => ({ subjects: [], notes: [] }));
    assert.equal(recovery.recoveredFromBackup, true);
    assert.deepEqual(recovery.state, goodState);

    // Verify primary file was automatically healed
    const healedRaw = JSON.parse(fs.readFileSync(primaryFile, 'utf8'));
    assert.deepEqual(healedRaw, goodState);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('htmlToFormattedText and formatNotesForTxtExport preserve headings, bullets, and special characters', () => {
    const sampleNotes: SmartNote[] = [
      {
        id: 'note-1',
        subjectId: 'sub-cs',
        title: 'Operating Systems: Kernel & Memory',
        category: 'Lecture Notes',
        tags: ['kernel', 'virtual-memory'],
        pinned: true,
        date: '2026-11-05 14:30',
        text: 'Fallback plain text',
        contentHTML:
          '<h1>Memory Management</h1><p>Key formulas: <b>E = mc&sup2;</b> &amp; O(n log n) &lt; O(n&sup2;)</p><ul><li>Paging &amp; Segmentation</li><li>TLB Cache Hit Ratio &gt; 98%</li></ul><blockquote>Never lose user data — العربية &amp; Español!</blockquote>',
      },
    ];

    const exportedTxt = formatNotesForTxtExport(sampleNotes, 'CS-401 Operating Systems');
    assert.ok(exportedTxt.includes('STUDY HUB - SMART NOTES EXPORT'));
    assert.ok(exportedTxt.includes('CS-401 Operating Systems'));
    assert.ok(exportedTxt.includes('[1] Operating Systems: Kernel & Memory [PINNED]'));
    assert.ok(exportedTxt.includes('Category : Lecture Notes | Tags: kernel, virtual-memory'));
    assert.ok(exportedTxt.includes('# Memory Management'));
    assert.ok(exportedTxt.includes('  * Paging & Segmentation'));
    assert.ok(exportedTxt.includes('> Never lose user data — العربية & Español!'));
  });

  test('filterAndSortNotes filters by subject, category, tag, and search query with pinned notes first', () => {
    const notes: SmartNote[] = [
      {
        id: '1',
        subjectId: 's1',
        title: 'Midterm Review',
        text: 'Dynamic programming memoization',
        category: 'Exam Prep',
        tags: ['dp', 'midterm'],
        pinned: false,
        date: '2026-11-01',
      },
      {
        id: '2',
        subjectId: 's1',
        title: 'Lecture 1 Summary',
        text: 'Asymptotic notation Big-O',
        category: 'Lectures',
        tags: ['basics'],
        pinned: true,
        date: '2026-11-02',
      },
      {
        id: '3',
        subjectId: 's1',
        title: 'Final Exam Checklist',
        text: 'NP-Completeness and reductions',
        category: 'Exam Prep',
        tags: ['final', 'np'],
        pinned: true,
        date: '2026-11-03',
      },
    ];

    // All notes for s1 should have pinned notes first
    const allS1 = filterAndSortNotes(notes, { subjectId: 's1' });
    assert.equal(allS1.length, 3);
    assert.equal(allS1[0].id, '2');
    assert.equal(allS1[1].id, '3');
    assert.equal(allS1[2].id, '1');

    // Filter by category 'Exam Prep'
    const examNotes = filterAndSortNotes(notes, { subjectId: 's1', category: 'Exam Prep' });
    assert.equal(examNotes.length, 2);
    assert.equal(examNotes[0].id, '3'); // pinned first
    assert.equal(examNotes[1].id, '1');

    // Filter by search query
    const dpNotes = filterAndSortNotes(notes, { subjectId: 's1', query: 'memoization' });
    assert.equal(dpNotes.length, 1);
    assert.equal(dpNotes[0].id, '1');
  });
});
