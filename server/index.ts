import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const { app, db, deps } = createApp({ cfg });

const server = app.listen(cfg.port, cfg.host, () => {
  const s = (ok: boolean) => (ok ? 'ready' : 'NOT CONFIGURED');
  console.log(`TRALIX AI listening on http://${cfg.host}:${cfg.port}`);
  console.log(`  text model : ${s(deps.providers.text.isConfigured())}${deps.providers.text.describe() ? ` (${deps.providers.text.describe()})` : ''}`);
  console.log(`  web search : ${deps.providers.search ? `ready (${deps.providers.search.id})` : 'NOT CONFIGURED'}`);
  console.log(`  weather    : ${deps.providers.weatherEnabled ? 'ready (open-meteo)' : 'disabled'}`);
});
server.requestTimeout = 0; // streaming responses may be long-lived
server.keepAliveTimeout = 65_000;

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
