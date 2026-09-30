import 'dotenv/config';
import { loadConfig } from '../config/env';
import { createPrismaClient, createPrismaStore, prepareDatabase } from '../db/prisma-store';
import { createSendQueue } from '../services/queue/boss';

async function main() {
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient();
  await prepareDatabase(prisma);
  const db = createPrismaStore(prisma);
  const queue = createSendQueue(config, db, prisma);
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
