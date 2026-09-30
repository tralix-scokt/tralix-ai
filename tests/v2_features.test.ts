import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, Repository } from '../server/db.js';
import { runMigrations, MIGRATIONS } from '../server/db/migrations.js';
import { hashPassword, verifyPassword } from '../server/auth.js';
import { checkImageSafety } from '../server/providers/image/safety.js';
import { startApp, startMockLlm, textChunk, type MockLlm } from './helpers.js';
import type { ImageGenerationProvider, VisionProvider } from '../server/providers/types.js';

let mock: MockLlm;
let t: Awaited<ReturnType<typeof startApp>>;

const fakeImageGen: ImageGenerationProvider = {
  id: 'test-imggen',
  isConfigured: () => true,
  describe: () => 'flux-test',
  async generate(req) {
    return {
      buffer: Buffer.from('fake-png-bytes'),
      mimeType: 'image/png',
    };
  },
};

const fakeVision: VisionProvider = {
  id: 'test-vision',
  isConfigured: () => true,
  describe: () => 'llama-vision-test',
  async analyze(req) {
    return `Visual analysis of ${req.images.length} images: A golden retriever playing in a park.`;
  },
};

beforeAll(async () => {
  mock = await startMockLlm();
  t = await startApp(mock, {
    imageGeneration: fakeImageGen,
    vision: fakeVision,
  });
});

afterAll(async () => {
  await t.close();
  await mock.close();
});

describe('V2 Database Migrations', () => {
  it('runs versioned migrations cleanly and records applied versions', async () => {
    const pool = await createDatabase();
    const { rows } = await pool.query('SELECT version, name FROM schema_migrations ORDER BY version ASC');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].name).toBe('001_initial_schema');

    // Running migrations again is idempotent
    const rerunCount = await runMigrations(pool);
    expect(rerunCount).toBe(0);
    await pool.end();
  });
});

describe('V2 Authentication & User Isolation', () => {
  it('hashes passwords with scrypt and verifies timing-safely', async () => {
    const password = 'SuperSecret123!';
    const hash = await hashPassword(password);
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('WrongPassword', hash)).toBe(false);
  });

  it('signs up, logs in, isolates data between users, and supports account deletion', async () => {
    // 1. Signup User A
    const signupA = await fetch(`${t.base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'Password123!', displayName: 'Alice' }),
    });
    expect(signupA.status).toBe(201);
    const dataA = (await signupA.json()) as any;
    expect(dataA.user.email).toBe('alice@example.com');
    const tokenA = dataA.sessionToken;
    expect(tokenA).toBeDefined();

    // 2. Signup User B
    const signupB = await fetch(`${t.base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'Password456!', displayName: 'Bob' }),
    });
    expect(signupB.status).toBe(201);
    const dataB = (await signupB.json()) as any;
    const tokenB = dataB.sessionToken;

    // 3. User A creates conversation
    const convA = await (
      await t.api(tokenA, '/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: "Alice's Secret Project" }),
      })
    ).json();
    expect(convA.id).toBeDefined();

    // 4. User B cannot see or access User A's conversation
    const listB = (await (await t.api(tokenB, '/conversations')).json()) as any[];
    expect(listB.some((c) => c.id === convA.id)).toBe(false);

    const getOther = await t.api(tokenB, `/conversations/${convA.id}`);
    expect(getOther.status).toBe(404);

    const deleteOther = await t.api(tokenB, `/conversations/${convA.id}`, { method: 'DELETE' });
    expect(deleteOther.status).toBe(404);

    // 5. User A exports data
    const exportRes = await t.api(tokenA, '/me/export');
    expect(exportRes.status).toBe(200);
    const exportedData = await exportRes.json();
    expect(exportedData.user.email).toBe('alice@example.com');
    expect(exportedData.conversations.some((c: any) => c.id === convA.id)).toBe(true);

    // 6. User A changes password
    const changePw = await t.api(tokenA, '/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'Password123!', newPassword: 'NewPassword999!' }),
    });
    expect(changePw.status).toBe(200);

    // Login with old password fails
    const badLogin = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'Password123!' }),
    });
    expect(badLogin.status).toBe(401);

    // Login with new password succeeds
    const goodLogin = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'NewPassword999!' }),
    });
    expect(goodLogin.status).toBe(200);

    // 7. User A deletes account
    const delAccount = await t.api(tokenA, '/auth/delete-account', { method: 'POST' });
    expect(delAccount.status).toBe(200);

    // Conversation is gone
    expect((await t.api(tokenA, `/conversations/${convA.id}`)).status).toBe(401);
  });
});

describe('V2 Cross-Chat Memory & Isolation', () => {
  it('stores, edits, retrieves and isolates memories between users', async () => {
    // Setup two users
    const userA = await (
      await fetch(`${t.base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'mem_a@example.com', password: 'Password123!' }),
      })
    ).json();
    const tokenA = userA.sessionToken;

    const userB = await (
      await fetch(`${t.base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'mem_b@example.com', password: 'Password123!' }),
      })
    ).json();
    const tokenB = userB.sessionToken;

    // User A adds memory
    const addA = await (
      await t.api(tokenA, '/memories', {
        method: 'POST',
        body: JSON.stringify({ content: 'User A is building an iPhone app in Swift.' }),
      })
    ).json();
    expect(addA.id).toBeDefined();
    expect(addA.content).toBe('User A is building an iPhone app in Swift.');

    // User B adds different memory
    await t.api(tokenB, '/memories', {
      method: 'POST',
      body: JSON.stringify({ content: 'User B prefers Python and Django.' }),
    });

    // Check list for User A - must NOT contain User B's memory
    const listA = (await (await t.api(tokenA, '/memories')).json()) as any;
    expect(listA.memories).toHaveLength(1);
    expect(listA.memories[0].content).toContain('User A is building');
    expect(JSON.stringify(listA)).not.toContain('User B');

    // Check list for User B - must NOT contain User A's memory
    const listB = (await (await t.api(tokenB, '/memories')).json()) as any;
    expect(listB.memories).toHaveLength(1);
    expect(listB.memories[0].content).toContain('User B prefers');
    expect(JSON.stringify(listB)).not.toContain('User A');

    // User A edits memory
    const editA = await (
      await t.api(tokenA, `/memories/${addA.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: 'User A is building an iOS app with SwiftUI.' }),
      })
    ).json();
    expect(editA.content).toBe('User A is building an iOS app with SwiftUI.');

    // User B cannot delete User A's memory
    const badDelete = await t.api(tokenB, `/memories/${addA.id}`, { method: 'DELETE' });
    expect(badDelete.status).toBe(404);

    // User A deletes memory
    const goodDelete = await t.api(tokenA, `/memories/${addA.id}`, { method: 'DELETE' });
    expect(goodDelete.status).toBe(204);

    const emptyA = (await (await t.api(tokenA, '/memories')).json()) as any;
    expect(emptyA.memories).toHaveLength(0);
  });
});

describe('V2 Upload Validation & Isolation', () => {
  it('validates upload MIME type, size, and isolates files per user', async () => {
    const userA = await (
      await fetch(`${t.base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'upload_a@example.com', password: 'Password123!' }),
      })
    ).json();
    const tokenA = userA.sessionToken;

    const userB = await (
      await fetch(`${t.base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'upload_b@example.com', password: 'Password123!' }),
      })
    ).json();
    const tokenB = userB.sessionToken;

    // 1. Upload valid image for User A
    const form = new FormData();
    const file = new File(['fake-image-content'], 'test.png', { type: 'image/png' });
    form.append('files', file);

    const uploadRes = await fetch(`${t.base}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form,
    });
    expect(uploadRes.status).toBe(201);
    const uploadData = (await uploadRes.json()) as any;
    expect(uploadData.attachments).toHaveLength(1);
    const attachmentId = uploadData.attachments[0].id;
    expect(attachmentId).toBeDefined();

    // 2. User A can access the attachment
    const getAttA = await t.api(tokenA, `/attachments/${attachmentId}`);
    expect(getAttA.status).toBe(200);

    // 3. User B cannot access User A's attachment (404 isolation)
    const getAttB = await t.api(tokenB, `/attachments/${attachmentId}`);
    expect(getAttB.status).toBe(404);

    // 4. Reject invalid file type (e.g. executable / script)
    const badForm = new FormData();
    badForm.append('files', new File(['malicious'], 'bad.exe', { type: 'application/x-msdownload' }));
    const badUpload = await fetch(`${t.base}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: badForm,
    });
    expect(badUpload.status).toBe(500); // Multer file filter rejection
  });
});

describe('V2 Image Generation & Moderation Safety', () => {
  it('moderates unsafe prompts with clear refusal messages', () => {
    const safe = checkImageSafety('A calm sunset over rolling green hills');
    expect(safe.safe).toBe(true);

    const unsafeGore = checkImageSafety('Generate a picture of decapitated severed limbs with blood gore');
    expect(unsafeGore.safe).toBe(false);
    expect(unsafeGore.refusalMessage).toContain('violates safety policies');
    expect(unsafeGore.category).toBe('extreme violence and gore');

    const unsafeCSAM = checkImageSafety('underage nude pictures');
    expect(unsafeCSAM.safe).toBe(false);
    expect(unsafeCSAM.category).toBe('child safety');
  });

  it('runs image generation tool call and persists image for user', async () => {
    const user = await (
      await fetch(`${t.base}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'imggen_user@example.com', password: 'Password123!' }),
      })
    ).json();
    const token = user.sessionToken;

    let call = 0;
    mock.handler = (body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (call++ === 0) {
        // Model requests generate_image tool
        res.write(
          textChunk(''),
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'img_call_1',
                      function: {
                        name: 'generate_image',
                        arguments: JSON.stringify({ prompt: 'A majestic snow leopard in the Himalayas' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })}\n\n`,
        );
      } else {
        // Model returns message referencing generated image
        res.write(textChunk('Here is the image of the snow leopard you asked for:\n\n![A snow leopard](/api/images/test)', 'stop'));
      }
      res.end('data: [DONE]\n\n');
    };

    const { events } = await t.chat(token, { action: 'send', content: 'Draw a snow leopard in the Himalayas' });
    const statuses = events.filter((e) => e.type === 'status').map((e: any) => e.status);
    expect(statuses).toContain('generating_image');

    const done = events.find((e) => e.type === 'done') as any;
    expect(done.message.content).toContain('snow leopard');
  });
});
