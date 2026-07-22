import { describe, expect, it } from 'vitest';
import type { RequestImage, ToolContext } from '../chat/chat.service';
import type { GenOptions, LlmMessage, LlmProvider, ThinkLevel } from '../chat/llm.provider';
import type { KnowledgeService } from '../knowledge/knowledge.service';
import { parseTitleBody, VisionToolsService } from './vision-tools.service';

const IMG: RequestImage = {
  url: 'http://pkos/api/attachments/abc',
  mime: 'image/jpeg',
  base64: 'QUJD', // "ABC"
};

/** Records the vision call; returns a canned transcription. */
function llmWith(reply: string) {
  const calls: Array<{ messages: LlmMessage[]; model?: string; think?: ThinkLevel; gen?: GenOptions }> = [];
  const llm: LlmProvider = {
    async chat(messages, _tools, model, think, gen) {
      calls.push({ messages, model, think, gen });
      return reply;
    },
  };
  return { llm, calls };
}

/** Records ingest args; echoes a saved path built from the (folder,title). */
function knowledgeSpy() {
  const ingests: Array<Record<string, unknown>> = [];
  const knowledge = {
    ingest: async (req: Record<string, unknown>) => {
      ingests.push(req);
      const folder = (req.folder as string) ?? 'articles';
      return { id: 'k1', path: `${folder}/${req.title}.md`, title: req.title } as never;
    },
  } as unknown as KnowledgeService;
  return { knowledge, ingests };
}

const ctxWith = (...images: RequestImage[]): ToolContext => ({ images });

describe('VisionToolsService.make_note_from_image', () => {
  it('runs the vision model over the attached image and saves a note with the image embedded', async () => {
    const { llm, calls } = llmWith('TITLE: Romans 8 study\n\n## Text\nFor I am convinced...');
    const { knowledge, ingests } = knowledgeSpy();
    const svc = new VisionToolsService(llm, knowledge);

    const out = JSON.parse(
      await svc.execute(
        { name: 'make_note_from_image', arguments: { instructions: 'my Bible', folder: 'faith/bible-study' } },
        ctxWith(IMG),
      ),
    );

    // vision model got the image bytes + a dedicated vision model id
    expect(calls[0].model).toBe(process.env.VISION_MODEL ?? 'qwen2.5vl:7b');
    expect(calls[0].messages.at(-1)?.images).toEqual(['QUJD']);
    expect(calls[0].messages.at(-1)?.content).toContain('my Bible');

    // saved into the chosen folder, image embedded at the top, verbatim text kept
    expect(ingests[0].folder).toBe('faith/bible-study');
    expect(ingests[0].title).toBe('Romans 8 study');
    expect(ingests[0].markdown).toContain('![](http://pkos/api/attachments/abc)');
    expect(ingests[0].markdown).toContain('For I am convinced');
    expect(out).toMatchObject({ saved: true, path: 'faith/bible-study/Romans 8 study.md' });
  });

  it('refuses (no fabrication) when no image is attached this turn', async () => {
    const { llm, calls } = llmWith('should not run');
    const { knowledge, ingests } = knowledgeSpy();
    const svc = new VisionToolsService(llm, knowledge);

    const out = JSON.parse(
      await svc.execute({ name: 'make_note_from_image', arguments: {} }, ctxWith()),
    );

    expect(out.error).toMatch(/no image/i);
    expect(calls).toHaveLength(0); // vision model never called
    expect(ingests).toHaveLength(0); // nothing saved
  });

  it('reports back when the model finds no legible text (no empty note saved)', async () => {
    const { llm } = llmWith('TITLE: \n\nNO_TEXT');
    const { knowledge, ingests } = knowledgeSpy();
    const svc = new VisionToolsService(llm, knowledge);

    const out = JSON.parse(
      await svc.execute({ name: 'make_note_from_image', arguments: {} }, ctxWith(IMG)),
    );

    expect(out.error).toMatch(/legible/i);
    expect(ingests).toHaveLength(0);
  });
});

describe('parseTitleBody', () => {
  it('splits the TITLE line from the body', () => {
    expect(parseTitleBody('TITLE: On Grace\n\n## Text\nGrace is favor.')).toEqual({
      title: 'On Grace',
      body: '## Text\nGrace is favor.',
    });
  });

  it('falls back to instructions then a default title when TITLE is missing', () => {
    expect(parseTitleBody('## Text\nsome body', 'a photo from church').title).toBe(
      'a photo from church',
    );
    expect(parseTitleBody('## Text\nsome body').title).toBe('Image note');
  });

  it('throws on an empty / NO_TEXT body', () => {
    expect(() => parseTitleBody('TITLE: x\n\nNO_TEXT')).toThrow(/legible/i);
    expect(() => parseTitleBody('TITLE: x\n\n')).toThrow(/legible/i);
  });
});
