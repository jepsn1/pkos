import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentsService } from '../attachments/attachments.service';
import { WebuiImportService, parseAttachedFiles } from './webui-import.service';

const MSG = `### Task ...
<context><source id="1" name="TheManJesus2.docx" resource-id="47083453">text</source></context>
<attached_files>
<file type="file" url="47083453-eedb-4bbb-8402-91989b4ed148" content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document" name="TheManJesus2.docx"/>
</attached_files>
What do you think About this file`;

describe('parseAttachedFiles', () => {
  it('extracts id, name, mime from the attached_files block', () => {
    expect(parseAttachedFiles(MSG)).toEqual([
      {
        id: '47083453-eedb-4bbb-8402-91989b4ed148',
        name: 'TheManJesus2.docx',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ]);
  });

  it('returns [] when there is no attached_files block', () => {
    expect(parseAttachedFiles('just a normal question')).toEqual([]);
  });

  it('handles multiple files', () => {
    const m = `<attached_files><file url="a" name="one.png" content_type="image/png"/><file url="b" name="two.pdf" content_type="application/pdf"/></attached_files>`;
    expect(parseAttachedFiles(m).map((f) => f.id)).toEqual(['a', 'b']);
  });
});

function fakeFetch(bytes: string, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    arrayBuffer: async () => new TextEncoder().encode(bytes).buffer,
  })) as unknown as typeof fetch;
}

function fakeAttachments() {
  const stored: Array<{ originalname: string; mimetype: string; size: number }> = [];
  const svc = {
    store: vi.fn(async (file: { buffer: Buffer; originalname: string; mimetype: string }) => {
      stored.push({ originalname: file.originalname, mimetype: file.mimetype, size: file.buffer.length });
      return { id: `att-${stored.length}`, filename: file.originalname, mime: file.mimetype };
    }),
  } as unknown as AttachmentsService;
  return { svc, stored };
}

describe('WebuiImportService.importFromMessage', () => {
  beforeEach(() => {
    process.env.WEBUI_API_KEY = 'test-token';
    process.env.ATTACHMENTS_PUBLIC_BASE = 'http://pkos.test';
  });
  afterEach(() => {
    delete process.env.WEBUI_API_KEY;
    delete process.env.ATTACHMENTS_PUBLIC_BASE;
  });

  it('fetches each webui file, stores it, and returns pkos URLs', async () => {
    const { svc, stored } = fakeAttachments();
    const f = fakeFetch('docx-bytes');
    const imported = await new WebuiImportService(f, svc).importFromMessage(MSG);
    expect(stored).toHaveLength(1);
    expect(stored[0].originalname).toBe('TheManJesus2.docx');
    expect(imported).toEqual([
      {
        name: 'TheManJesus2.docx',
        url: 'http://pkos.test/api/attachments/att-1',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ]);
    // called webui's file-content API with the id + bearer
    const call = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toContain('/api/v1/files/47083453-eedb-4bbb-8402-91989b4ed148/content');
    expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer test-token');
  });

  it('no-ops when WEBUI_API_KEY is unset (feature off)', async () => {
    delete process.env.WEBUI_API_KEY;
    const { svc, stored } = fakeAttachments();
    const imported = await new WebuiImportService(fakeFetch('x'), svc).importFromMessage(MSG);
    expect(imported).toEqual([]);
    expect(stored).toHaveLength(0);
  });

  it('skips a file that fails to fetch, never throws', async () => {
    const { svc } = fakeAttachments();
    const imported = await new WebuiImportService(fakeFetch('', false, 404), svc).importFromMessage(MSG);
    expect(imported).toEqual([]);
  });
});
