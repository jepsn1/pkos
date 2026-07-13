import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseNote, serializeNote, slugify, type Note } from './note';

const execFileAsync = promisify(execFile);

export const VAULT_PATH = 'VAULT_PATH';
export const GIT = 'GIT';

/** Runs git with the given args inside the vault. Injectable so tests fake it. */
export type GitRunner = (args: string[]) => Promise<void>;

const GIT_AUTHOR = ['-c', 'user.name=jepsn1', '-c', 'user.email=jepsn1@users.noreply.github.com'];

export function realGitRunner(vaultPath: string): GitRunner {
  return async (args) => {
    // safe.directory: harmless when uid matches, required when it does not (container)
    await execFileAsync('git', [
      '-C',
      vaultPath,
      '-c',
      `safe.directory=${vaultPath}`,
      ...GIT_AUTHOR,
      ...args,
    ]);
  };
}

const ALLOWED_FOLDER = /^[a-z0-9][a-z0-9/_-]*$/;

/**
 * The canonical markdown vault (git checkout of jepsn1/knowledge).
 * Owns file layout + git commits; everything else treats notes as data.
 */
@Injectable()
export class VaultService {
  constructor(
    @Inject(VAULT_PATH) private readonly root: string,
    @Inject(GIT) private readonly git: GitRunner,
  ) {}

  /** Write a note under `folder`, commit it, return the vault-relative path. */
  async writeNote(folder: string, note: Note): Promise<string> {
    if (!ALLOWED_FOLDER.test(folder) || folder.includes('..')) {
      throw new BadRequestException(`invalid folder: ${folder}`);
    }
    const dir = path.join(this.root, folder);
    await fs.mkdir(dir, { recursive: true });

    const slug = slugify(note.meta.title);
    let relPath = path.posix.join(folder, `${slug}.md`);
    for (let n = 2; await this.exists(relPath); n++) {
      relPath = path.posix.join(folder, `${slug}-${n}.md`);
    }

    await fs.writeFile(path.join(this.root, relPath), serializeNote(note), 'utf8');
    await this.git(['add', relPath]);
    await this.git(['commit', '-m', `add ${relPath}`]);
    return relPath;
  }

  async readNote(relPath: string): Promise<Note | null> {
    try {
      const raw = await fs.readFile(path.join(this.root, relPath), 'utf8');
      return parseNote(raw);
    } catch {
      return null;
    }
  }

  /** All notes in the vault (files with a `title` frontmatter), as [relPath, note]. */
  async listNotes(): Promise<Array<{ path: string; note: Note }>> {
    const out: Array<{ path: string; note: Note }> = [];
    for (const relPath of await this.walk('')) {
      const note = await this.readNote(relPath);
      if (note) out.push({ path: relPath, note });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async exists(relPath: string): Promise<boolean> {
    return fs
      .access(path.join(this.root, relPath))
      .then(() => true)
      .catch(() => false);
  }

  private async walk(rel: string): Promise<string[]> {
    const entries = await fs.readdir(path.join(this.root, rel), { withFileTypes: true });
    const files: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .git, .gitkeep
      const childRel = rel ? path.posix.join(rel, e.name) : e.name;
      if (e.isDirectory()) files.push(...(await this.walk(childRel)));
      else if (e.name.endsWith('.md')) files.push(childRel);
    }
    return files;
  }
}
