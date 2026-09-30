const fs = require('fs');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
const sharedDir = path.resolve(backendRoot, '../shared');
const linkDir = path.join(backendRoot, 'node_modules', '@npm-outreach');
const linkPath = path.join(linkDir, 'shared');
const envExample = path.join(backendRoot, '.env.example');
const envFile = path.join(backendRoot, '.env');

if (!fs.existsSync(sharedDir)) {
  console.error(`Shared package not found at ${sharedDir}`);
  process.exit(1);
}

fs.mkdirSync(linkDir, { recursive: true });
fs.rmSync(linkPath, { recursive: true, force: true });

// Junctions work on Windows without administrator rights. POSIX keeps a real symlink.
const type = process.platform === 'win32' ? 'junction' : 'dir';
fs.symlinkSync(sharedDir, linkPath, type);
console.log(`Linked @npm-outreach/shared -> ${sharedDir}`);

if (!fs.existsSync(envFile)) {
  fs.copyFileSync(envExample, envFile);
  console.log('Created backend/.env from .env.example.');
  console.log('Edit DATABASE_URL in backend/.env, then run: npx prisma migrate dev');
}
