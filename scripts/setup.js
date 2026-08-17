#!/usr/bin/env node
/**
 * First-run setup: creates .env from the template and tells the user exactly
 * what is still missing. Safe to re-run — it never overwrites an existing .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');

const PLACEHOLDER = 'your-pinecone-api-key';

if (!fs.existsSync(examplePath)) {
  console.error('✗ .env.example is missing — is this a complete checkout?');
  process.exit(1);
}

if (fs.existsSync(envPath)) {
  console.log('• .env already exists, leaving it alone');
} else {
  fs.copyFileSync(examplePath, envPath);
  console.log('✓ created .env from .env.example');
}

const env = fs.readFileSync(envPath, 'utf8');
const key = /^PINECONE_API_KEY=(.*)$/m.exec(env)?.[1]?.trim() ?? '';

console.log('');
if (!key || key === PLACEHOLDER) {
  console.log('Next: open .env and set PINECONE_API_KEY to your own key.');
  console.log('      Get one from https://app.pinecone.io → API Keys.');
  console.log('      Then run: npm run doctor');
  process.exit(1);
}

console.log(`✓ PINECONE_API_KEY is set (${key.length} chars)`);
console.log('Next: npm run doctor   — confirms the index, field mapping and search quality');
