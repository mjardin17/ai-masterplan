import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createBackendApp } from './src/server/app';
import { getServerConfig } from './src/server/config/env';

function parseCliPort(argv: string[]): number | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    } else if (arg === '--port' && i + 1 < argv.length) {
      const parsed = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return null;
}

async function main() {
  const baseConfig = getServerConfig();
  const cliPort = parseCliPort(process.argv.slice(2));
  const config = cliPort ? { ...baseConfig, port: cliPort } : baseConfig;
  const runtime = await createBackendApp({ config });
  const { app } = runtime;

  const isProd = config.nodeEnv === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[ai-masterplan] Control plane listening on http://0.0.0.0:${config.port}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await runtime.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[ai-masterplan] Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
