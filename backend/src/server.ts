import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config/env.js';
import { createPrismaClient, createPrismaStore, prepareDatabase } from './db/prisma-store.js';
import { createSendQueue } from './services/queue/boss.js';

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  if (!config.apiKey) throw new Error('BACKEND_API_KEY is required');
  const prisma = createPrismaClient();
  await prepareDatabase(prisma);
  const db = createPrismaStore(prisma);
  const queue = createSendQueue(config, db, prisma);
  const app = await createApp({
    config,
    db,
    enqueue: (id) => queue.enqueue(id),
  });
  if (config.runWorkerInServer) await queue.start();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const shutdown = async () => {
    await app.close();
    await queue.stop();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
