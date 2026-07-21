import { describe, expect, it, vi } from 'vitest';
import { WebSearchToolService } from './web-search-tools.service';

function fakeFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({ ok, status, json: async () => payload })) as unknown as typeof fetch;
}

const SAMPLE = {
  results: [
    { title: 'A', url: 'https://a.com', content: 'snippet a' },
    { title: 'B', url: 'https://b.com', content: 'snippet b' },
    { title: 'C', url: 'https://c.com', content: 'snippet c' },
    { title: 'no url', content: 'dropped' }, // incomplete → filtered out
  ],
};

async function run(svc: WebSearchToolService, args: Record<string, unknown>) {
  return JSON.parse(await svc.execute({ name: 'web_search', arguments: args }));
}

describe('web_search', () => {
  it('returns ranked results {title,url,snippet}, dropping incomplete rows', async () => {
    const res = await run(new WebSearchToolService(fakeFetch(SAMPLE)), {
      query: 'esv revision year',
    });
    expect(res.count).toBe(3);
    expect(res.results[0]).toEqual({ title: 'A', url: 'https://a.com', snippet: 'snippet a' });
  });

  it('respects limit and clamps it into range', async () => {
    const svc = new WebSearchToolService(fakeFetch(SAMPLE));
    expect((await run(svc, { query: 'x', limit: 2 })).results).toHaveLength(2);
    expect((await run(svc, { query: 'x', limit: 999 })).results).toHaveLength(3); // only 3 valid
    expect((await run(svc, { query: 'x', limit: 0 })).results).toHaveLength(1); // clamped to min 1
  });

  it('calls SearXNG with format=json and a url-encoded query', async () => {
    const f = fakeFetch(SAMPLE);
    await run(new WebSearchToolService(f), { query: 'a b&c' });
    const calledUrl = (f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).toContain('format=json');
    expect(calledUrl).toContain(encodeURIComponent('a b&c'));
  });

  it('missing query → {error}', async () => {
    expect((await run(new WebSearchToolService(fakeFetch(SAMPLE)), {})).error).toMatch(/query/);
  });

  it('unknown tool name → {error}', async () => {
    const svc = new WebSearchToolService(fakeFetch(SAMPLE));
    const res = JSON.parse(await svc.execute({ name: 'nope', arguments: {} }));
    expect(res.error).toMatch(/unknown tool/);
  });

  it('SearXNG HTTP error → {error}, never throws', async () => {
    const res = await run(new WebSearchToolService(fakeFetch({}, false, 502)), { query: 'x' });
    expect(res.error).toMatch(/502|failed/);
  });
});
