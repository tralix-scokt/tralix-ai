import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationDetail, StreamEvent } from '../shared/types.js';
import type { SearchProvider } from '../server/providers/types.js';
import { sseChunk, startApp, startMockLlm, textChunk, type MockLlm } from './helpers.js';

let mock: MockLlm;
let t: Awaited<ReturnType<typeof startApp>>;
let token: string;
const searchCalls: string[] = [];
const fakeSearch: SearchProvider = {
  id: 'test-search',
  async search(req) {
    searchCalls.push(req.query);
    return [{ title: 'Example News', url: 'https://example.com/a', snippet: 'snip', content: 'Fresh facts from today.' }];
  },
};
const text = (evs: StreamEvent[]) => evs.filter((e) => e.type === 'delta').map((e: any) => e.text).join('');
const defaultHandler = (mock: MockLlm) => mock.handler;

beforeAll(async () => {
  mock = await startMockLlm();
  t = await startApp(mock, { search: fakeSearch });
});
afterAll(async () => {
  await t.close();
  await mock.close();
});
beforeEach(async () => {
  token = await t.session();
  mock.requests.length = 0;
  searchCalls.length = 0;
  mock.handler = defaultHandler(mock) && ((_b, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(textChunk('Hello'));
    res.write(textChunk(' there', 'stop'));
    res.end('data: [DONE]\n\n');
  });
});

describe('chat streaming', () => {
  it('streams a reply, persists it, and generates a title', async () => {
    const { events } = await t.chat(token, { action: 'send', content: 'Hi TRALIX' });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('meta');
    expect(types.indexOf('status')).toBeGreaterThan(-1);
    expect(events.find((e) => e.type === 'status')).toMatchObject({ status: 'thinking' });
    expect(text(events)).toBe('Hello there');
    expect(types).toContain('done');
    expect(events.find((e) => e.type === 'title')).toMatchObject({ title: 'Quick Greeting' });

    const meta = events[0] as Extract<StreamEvent, { type: 'meta' }>;
    const conv = (await (await t.api(token, `/conversations/${meta.conversation.id}`)).json()) as ConversationDetail;
    expect(conv.title).toBe('Quick Greeting');
    expect(conv.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hi TRALIX'],
      ['assistant', 'Hello there'],
    ]);
  });

  it('sends the full conversation as context and keeps the system prompt server-side', async () => {
    const first = await t.chat(token, { action: 'send', content: 'My name is Alex.' });
    const id = (first.events[0] as any).conversation.id;
    await t.chat(token, { action: 'send', conversationId: id, content: 'What is my name?' });
    const streamReqs = mock.requests.filter((r) => r.body.stream);
    const last = streamReqs[streamReqs.length - 1].body.messages;
    expect(last.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(last[1].content).toBe('My name is Alex.');
    expect(last[0].content).toContain('TRALIX AI');
    // Upstream got the key; the client never sees it or the prompt.
    expect(streamReqs[0].headers.authorization).toBe('Bearer sk-test-secret');
    const raw = JSON.stringify(first.events);
    expect(raw).not.toContain('sk-test-secret');
    expect(raw).not.toContain('Personality');
  });

  it('runs web search when the model asks, reports real statuses and sources', async () => {
    let call = 0;
    mock.handler = (body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (call++ === 0) {
        expect(body.tools.map((x: any) => x.function.name)).toContain('web_search');
        res.write(
          sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_search', arguments: '{"query":"tech ne' } }] } }] }),
        );
        res.write(sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ws today","topic":"news"}' } }] } }] }));
        res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
      } else {
        const toolMsg = body.messages.find((m: any) => m.role === 'tool');
        expect(toolMsg.content).toContain('Fresh facts from today.');
        res.write(textChunk('According to Example News, things happened.', 'stop'));
      }
      res.end('data: [DONE]\n\n');
    };
    const { events } = await t.chat(token, { action: 'send', content: "What's happening in tech today?" });
    expect(searchCalls).toEqual(['tech news today']);
    const statuses = events.filter((e) => e.type === 'status').map((e: any) => e.status);
    expect(statuses).toEqual(['thinking', 'searching', 'thinking', 'writing']);
    expect(events.find((e) => e.type === 'status' && e.status === 'searching')).toMatchObject({ detail: 'tech news today' });
    const done = events.find((e) => e.type === 'done') as any;
    expect(done.message.sources).toEqual([{ title: 'Example News', url: 'https://example.com/a', snippet: 'snip' }]);
    expect(done.message.content).toContain('According to Example News');
  });

  it('persists partial output when the client stops generation', async () => {
    mock.handler = (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(textChunk('Partial answer'));
      // never finishes
      res.on('close', () => res.end());
    };
    const ctl = new AbortController();
    let convId = '';
    const p = t.chat(token, { action: 'send', content: 'Long one' }, ctl.signal).catch(() => null);
    // wait until the mock has been hit and the partial chunk flushed, then abort like the Stop button does
    for (let i = 0; i < 50 && !mock.requests.some((r) => r.body.stream); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 150));
    ctl.abort();
    await p;
    await new Promise((r) => setTimeout(r, 200));
    const list = (await (await t.api(token, '/conversations')).json()) as any[];
    convId = list[0].id;
    const conv = (await (await t.api(token, `/conversations/${convId}`)).json()) as ConversationDetail;
    expect(conv.messages[1]).toMatchObject({ role: 'assistant', content: 'Partial answer', status: 'stopped' });
  });

  it('regenerates, edits and continues', async () => {
    const first = await t.chat(token, { action: 'send', content: 'Say hi' });
    const meta = first.events[0] as any;
    const convId = meta.conversation.id;

    mock.handler = (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(textChunk('Second take', 'stop'));
      res.end('data: [DONE]\n\n');
    };
    await t.chat(token, { action: 'regenerate', conversationId: convId });
    let conv = (await (await t.api(token, `/conversations/${convId}`)).json()) as ConversationDetail;
    expect(conv.messages.map((m) => m.content)).toEqual(['Say hi', 'Second take']);

    await t.chat(token, { action: 'edit', conversationId: convId, messageId: meta.userMessage.id, content: 'Say hello' });
    conv = (await (await t.api(token, `/conversations/${convId}`)).json()) as ConversationDetail;
    expect(conv.messages.map((m) => m.content)).toEqual(['Say hello', 'Second take']);

    mock.handler = (body, res) => {
      const lastUser = body.messages[body.messages.length - 1];
      expect(lastUser.role).toBe('user');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(textChunk(' and more', 'stop'));
      res.end('data: [DONE]\n\n');
    };
    await t.chat(token, { action: 'continue', conversationId: convId });
    conv = (await (await t.api(token, `/conversations/${convId}`)).json()) as ConversationDetail;
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[1].content).toBe('Second take and more');
  });

  it('marks length-truncated replies so the UI can offer Continue', async () => {
    mock.handler = (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(textChunk('cut off', 'length'));
      res.end('data: [DONE]\n\n');
    };
    const { events } = await t.chat(token, { action: 'send', content: 'write a novel' });
    expect((events.find((e) => e.type === 'done') as any).message.status).toBe('stopped');
  });

  it('shows a safe error, keeps the user message, and allows retry', async () => {
    mock.handler = (_b, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal: key sk-test-secret at db.internal:5432' } }));
    };
    const { events } = await t.chat(token, { action: 'send', content: 'Will fail' });
    const err = events.find((e) => e.type === 'error') as any;
    expect(err).toMatchObject({ code: 'unavailable', retryable: true });
    expect(JSON.stringify(events)).not.toMatch(/sk-test|db\.internal|internal:/);
    const convId = (events[0] as any).conversation.id;
    let conv = (await (await t.api(token, `/conversations/${convId}`)).json()) as ConversationDetail;
    expect(conv.messages.map((m) => m.role)).toEqual(['user']);

    mock.handler = (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(textChunk('Recovered', 'stop'));
      res.end('data: [DONE]\n\n');
    };
    const retry = await t.chat(token, { action: 'regenerate', conversationId: convId });
    expect(text(retry.events)).toBe('Recovered');
    conv = (await (await t.api(token, `/conversations/${convId}`)).json()) as ConversationDetail;
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('conversations & auth', () => {
  it('requires a session and isolates users', async () => {
    expect((await fetch(`${t.base}/api/conversations`)).status).toBe(401);
    const a = await t.chat(token, { action: 'send', content: 'private thing about zebras' });
    const id = (a.events[0] as any).conversation.id;
    const other = await t.session();
    expect((await t.api(other, `/conversations/${id}`)).status).toBe(404);
    expect((await t.api(other, `/conversations/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect(((await (await t.api(other, '/conversations')).json()) as any[]).length).toBe(0);
  });

  it('supports rename, search (titles and content, wildcard-safe) and delete', async () => {
    const a = await t.chat(token, { action: 'send', content: 'Tell me about zebras' });
    const id = (a.events[0] as any).conversation.id;
    await t.chat(token, { action: 'send', content: 'Unrelated' });

    const rename = await t.api(token, `/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Stripes' }) });
    expect(((await rename.json()) as any).title).toBe('Stripes');
    // renamed titles are locked against auto-title
    const search = async (q: string) => ((await (await t.api(token, `/conversations?q=${encodeURIComponent(q)}`)).json()) as any[]).map((c) => c.id);
    expect(await search('stripes')).toEqual([id]);
    expect(await search('zebras')).toEqual([id]); // message content
    expect(await search('%')).toEqual([]);
    expect((await t.api(token, `/conversations/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await search('zebras')).toEqual([]);
  });

  it('validates input', async () => {
    expect((await t.chat(token, { action: 'send', content: '   ' })).res.status).toBe(400);
    expect((await t.chat(token, { action: 'send', content: 'x'.repeat(13_000) })).res.status).toBe(413);
    expect((await t.chat(token, { action: 'regenerate' })).res.status).toBe(400);
  });

  it('exposes capabilities without secrets', async () => {
    const caps = await (await fetch(`${t.base}/api/capabilities`)).json();
    expect(caps.text.state).toBe('active');
    expect(caps.webSearch).toEqual({ state: 'active', detail: 'test-search' });
    expect(caps.imageGeneration.state).toBe('unavailable');
    expect(JSON.stringify(caps)).not.toContain('sk-test');
  });
});
