import { BadRequestException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import { VaultService, type GitRunner } from './vault.service';
import type { Note } from './note';

let root: string;
let gitCalls: string[][];
const fakeGit: GitRunner = async (args) => {
  gitCalls.push(args);
};

function vault(): VaultService {
  return new VaultService(root, fakeGit);
}

const note: Note = {
  meta: {
    title: 'On Grace',
    source: 'personal reflection',
    tags: ['grace', 'salvation'],
    summary: 'Grace is unmerited favor.',
    importance: 4,
    created: '2026-07-13',
  },
  body: 'Grace is the unearned favor of God toward sinners.',
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-vault-'));
  gitCalls = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('VaultService', () => {
  it('writes a note with full YAML frontmatter and commits it', async () => {
    const relPath = await vault().writeNote('faith/reflections', note);
    expect(relPath).toBe('faith/reflections/on-grace.md');

    const raw = await fs.readFile(path.join(root, relPath), 'utf8');
    const { data, content } = matter(raw);
    expect(data).toEqual({
      title: 'On Grace',
      source: 'personal reflection',
      tags: ['grace', 'salvation'],
      summary: 'Grace is unmerited favor.',
      importance: 4,
      created: '2026-07-13',
    });
    expect(content.trim()).toBe(note.body);

    expect(gitCalls).toEqual([
      ['add', relPath],
      ['commit', '-m', `add ${relPath}`],
    ]);
  });

  it('omits empty optional frontmatter fields', async () => {
    const relPath = await vault().writeNote('articles', {
      meta: { title: 'Bare', tags: [], created: '2026-07-13' },
      body: 'body',
    });
    const { data } = matter(await fs.readFile(path.join(root, relPath), 'utf8'));
    expect(Object.keys(data).sort()).toEqual(['created', 'tags', 'title']);
  });

  it('suffixes the filename when the slug already exists', async () => {
    const v = vault();
    expect(await v.writeNote('faith/reflections', note)).toBe(
      'faith/reflections/on-grace.md',
    );
    expect(await v.writeNote('faith/reflections', note)).toBe(
      'faith/reflections/on-grace-2.md',
    );
  });

  it('rejects folder traversal', async () => {
    await expect(vault().writeNote('../evil', note)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(vault().writeNote('/abs', note)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('round-trips a note through read', async () => {
    const v = vault();
    const relPath = await v.writeNote('faith/theology', note);
    const back = await v.readNote(relPath);
    expect(back).toEqual({ meta: note.meta, body: note.body });
  });

  it('lists only real notes, skipping non-note markdown', async () => {
    const v = vault();
    await fs.writeFile(path.join(root, 'README.md'), '# vault readme\n');
    const a = await v.writeNote('faith/reflections', note);
    const b = await v.writeNote('books', {
      meta: { title: 'Knowing God', tags: ['book'], created: '2026-07-13' },
      body: 'Packer.',
    });
    const listed = await v.listNotes();
    expect(listed.map((n) => n.path).sort()).toEqual([a, b].sort());
  });
});
