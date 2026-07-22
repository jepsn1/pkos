import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentsService, type StoredFile } from './attachments.service';
import type { Attachment, AttachmentRepo, NewAttachment } from './attachments.repo';

class FakeRepo implements AttachmentRepo {
  rows: Attachment[] = [];
  seq = 0;
  async insert(a: NewAttachment): Promise<Attachment> {
    const row: Attachment = { ...a, id: `att-${++this.seq}`, created: new Date() };
    this.rows.push(row);
    return row;
  }
  async getById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async findBySha(sha: string) {
    return this.rows.find((r) => r.sha256 === sha) ?? null;
  }
  async listByItem(itemId: string) {
    return this.rows.filter((r) => r.itemId === itemId);
  }
}

function file(name: string, content: string, mimetype = 'application/octet-stream'): StoredFile {
  return { originalname: name, buffer: Buffer.from(content), mimetype };
}

let root: string;
let repo: FakeRepo;
let svc: AttachmentsService;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pkos-att-'));
  repo = new FakeRepo();
  svc = new AttachmentsService(repo, root);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('AttachmentsService', () => {
  it('stores a blob on disk (sharded by sha) and records metadata', async () => {
    const a = await svc.store(file('MindofChrist.pptx', 'slides', 'application/vnd.ms-powerpoint'), 'item-1');
    expect(a.id).toBe('att-1');
    expect(a.filename).toBe('MindofChrist.pptx');
    expect(a.size).toBe(Buffer.from('slides').length);
    expect(a.itemId).toBe('item-1');
    expect(a.diskPath).toBe(path.posix.join(a.sha256.slice(0, 2), `${a.sha256}.pptx`));
    // blob physically written
    await expect(fs.readFile(path.join(root, a.diskPath), 'utf8')).resolves.toBe('slides');
  });

  it('dedupes identical bytes: reuses the row + writes no second blob', async () => {
    const a = await svc.store(file('a.txt', 'same'));
    const b = await svc.store(file('renamed.txt', 'same'));
    expect(b.id).toBe(a.id);
    expect(repo.rows).toHaveLength(1);
  });

  it('different bytes → distinct rows', async () => {
    const a = await svc.store(file('a.txt', 'one'));
    const b = await svc.store(file('b.txt', 'two'));
    expect(b.id).not.toBe(a.id);
    expect(repo.rows).toHaveLength(2);
  });

  it('get() returns the row + absolute path; unknown id throws', async () => {
    const a = await svc.store(file('x.png', 'img', 'image/png'));
    const { attachment, absPath } = await svc.get(a.id);
    expect(attachment.mime).toBe('image/png');
    expect(absPath).toBe(path.join(root, a.diskPath));
    await expect(svc.get('nope')).rejects.toThrow(/no attachment/);
  });

  it('listByItem returns only that note’s attachments', async () => {
    await svc.store(file('a.txt', '1'), 'item-1');
    await svc.store(file('b.txt', '2'), 'item-2');
    const list = await svc.listByItem('item-1');
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe('a.txt');
  });
});
