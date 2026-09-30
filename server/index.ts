import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const { app, pool, deps } = await createApp({ cfg });

const server = app.listen(cfg.port, cfg.host, () => {
  const s = (ok: boolean) => (ok ? 'ready' : 'NOT CONFIGURED');
  console.log(`TRALIX AI (V2) listening on http://${cfg.host}:${cfg.port}`);
  console.log(
    `  text model  : ${s(deps.providers.text.isConfigured())}${deps.providers.text.describe() ? ` (${deps.providers.text.describe()})` : ''}`,
  );
  console.log(
    `  vision model: ${s(!!deps.providers.vision?.isConfigured())}${deps.providers.vision?.describe() ? ` (${deps.providers.vision?.describe()})` : ''}`,
  );
  console.log(
    `  image gen   : ${s(!!deps.providers.imageGeneration?.isConfigured())}${deps.providers.imageGeneration?.describe() ? ` (${deps.providers.imageGeneration?.describe()})` : ''}`,
  );
  console.log(`  web search  : ${deps.providers.search ? `ready (${deps.providers.search.id})` : 'NOT CONFIGURED'}`);
  console.log(`  weather     : ${deps.providers.weatherEnabled ? 'ready (open-meteo)' : 'disabled'}`);
  console.log(`  memory      : ready (persistent across chats)`);
  console.log(`  storage     : ${deps.storage.isS3 ? 'S3/R2 object storage' : 'local uploads directory'}`);
});
server.requestTimeout = 0; // streaming responses may be long-lived
server.keepAliveTimeout = 65_000;

const shutdown = () => {
  server.close(async () => {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
