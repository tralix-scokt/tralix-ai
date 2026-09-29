import { describe, expect, it } from 'vitest';
import { SSEParser } from '../shared/sse.js';

describe('SSEParser', () => {
  it('handles split chunks, CRLF, comments and multi-line data', () => {
    const out: any[] = [];
    const p = new SSEParser((m) => out.push(m));
    p.push('event: delta\r\nda');
    p.push('ta: {"a":1}\r\n\r\n: ping\n\ndata: x\ndata: y\n\n');
    p.push('data: tail');
    p.end();
    expect(out).toEqual([
      { event: 'delta', data: '{"a":1}' },
      { event: 'message', data: 'x\ny' },
      { event: 'message', data: 'tail' },
    ]);
  });
});
