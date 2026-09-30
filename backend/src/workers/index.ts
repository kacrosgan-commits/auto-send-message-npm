import 'dotenv/config';
import { loadConfig } from '../config/env';
import { createPrismaClient, createPrismaStore } from '../db/prisma-store';
import { createPgBossQueue } from '../services/queue/boss';

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient();
  const db = createPrismaStore(prisma);
  const queue = createPgBossQueue(config, db);
  await queue.start();
  console.log('gmail-send worker started');
  const shutdown = async () => {
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
