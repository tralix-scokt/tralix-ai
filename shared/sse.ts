/** Minimal, dependency-free Server-Sent Events parser usable in Node and browsers. */

export interface SSEMessage {
  event: string;
  data: string;
}

export class SSEParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  constructor(private onMessage: (m: SSEMessage) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buffer.slice(0, idx);
      const sepLen = this.buffer.startsWith('\r\n', idx) ? 2 : 1;
      // A trailing lone \r may be half of a \r\n split across chunks — wait for more.
      if (this.buffer[idx] === '\r' && idx + 1 === this.buffer.length) return;
      this.buffer = this.buffer.slice(idx + sepLen);
      this.line(line);
    }
  }

  end(): void {
    if (this.buffer) this.line(this.buffer);
    this.buffer = '';
    this.dispatch();
  }

  private line(line: string): void {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return;
    const c = line.indexOf(':');
    const field = c === -1 ? line : line.slice(0, c);
    let value = c === -1 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }

  private dispatch(): void {
    if (this.data.length) this.onMessage({ event: this.event || 'message', data: this.data.join('\n') });
    this.event = '';
    this.data = [];
  }
}

/** Iterate SSE messages from a fetch() body. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const queue: SSEMessage[] = [];
  const parser = new SSEParser((m) => queue.push(m));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      while (queue.length) yield queue.shift()!;
    }
    parser.push(decoder.decode());
    parser.end();
    while (queue.length) yield queue.shift()!;
  } finally {
    reader.releaseLock();
  }
}
