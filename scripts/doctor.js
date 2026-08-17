#!/usr/bin/env node
/**
 * Connectivity + shape check. Run `npm run doctor` before wiring the server
 * into a client: it prints the index config, a sample record and the detected
 * field names, so you can tune TEXT_FIELDS / TABLE_FIELDS in .env.
 */
import { config } from '../src/config.js';
import { describeIndex, detectFields, listNamespaces, scanTables, searchSchema } from '../src/pinecone.js';

const ok = (message) => console.log(`  ✓ ${message}`);
const bad = (message) => console.log(`  ✗ ${message}`);

const preview = (value, max = 300) => {
  const rendered = Array.isArray(value) ? value.join(' | ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return rendered.length > max ? `${rendered.slice(0, max)}…` : rendered;
};

console.log('\naskDB MCP — doctor\n');

console.log('config');
if (config.apiKey) {
  ok(`PINECONE_API_KEY present (${config.apiKey.length} chars, value not printed)`);
} else {
  bad('PINECONE_API_KEY missing — copy .env.example to .env');
  process.exit(1);
}
ok(`index: ${config.indexName}`);
ok(`namespace: ${config.namespace || '(default)'}`);

console.log('\nindex');
let index;
try {
  index = await describeIndex();
  ok(`reachable · ${index.dimension} dims · ${index.metric} · ${index.vectorType ?? 'dense'}`);
  if (index.integrated) {
    ok(`integrated embedding: ${index.embedModel} · fieldMap: ${JSON.stringify(index.fieldMap)}`);
    console.log('    → queries send raw text; EMBED_MODEL is ignored.');
  } else {
    ok(`no integrated embedding → queries are embedded with EMBED_MODEL=${config.embedModel}`);
    console.log('    → this MUST be the model you used when upserting, or results will be noise.');
  }
} catch (error) {
  bad(`cannot describe index: ${error.message}`);
  process.exit(1);
}

console.log('\nnamespaces');
try {
  const namespaces = await listNamespaces();
  if (namespaces.length) {
    for (const entry of namespaces) ok(`${entry.name}: ${entry.recordCount} records`);
  } else {
    bad('no namespaces reported — the index looks empty');
  }
} catch (error) {
  bad(`describeIndexStats failed: ${error.message}`);
}

console.log('\nrecord shape');
let sampleFields = {};
try {
  const detected = await detectFields();
  ok(`metadata fields in use: ${detected.metadataKeys.join(', ') || 'none'}`);
  ok(`schema text ← "${detected.textField}" · table ← "${detected.tableField}" · database ← ${detected.dbField ? `"${detected.dbField}"` : 'not found'}`);

  const scan = await scanTables();
  ok(`scanned ${scan.scanned} records${scan.truncated ? ` (capped at ${config.listScanLimit})` : ''}`);
  const total = scan.databases.reduce((sum, entry) => sum + entry.tables.length, 0);
  if (total) {
    ok(`${total} tables across ${scan.databases.length} database(s)`);
    for (const entry of scan.databases) {
      console.log(`    ${entry.database}: ${entry.tables.length} tables — ${entry.tables.slice(0, 6).join(', ')}${entry.tables.length > 6 ? '…' : ''}`);
    }
  } else {
    bad(`no table names found via TABLE_FIELDS=${config.tableFields.join(',')}`);
    console.log('    → pick the right key from the metadata fields above and set TABLE_FIELDS.');
  }
} catch (error) {
  bad(`scan failed: ${error.message}`);
}

console.log('\nsample search ("customer orders and revenue")');
try {
  const { hits, mode } = await searchSchema({ query: 'customer orders and revenue', topK: 3 });
  ok(`retrieval mode: ${mode}`);
  if (!hits.length) {
    bad('0 hits — wrong namespace, empty index, or mismatched embedding model');
  }
  for (const hit of hits) {
    console.log(`\n  ── ${hit.id}  (score ${hit.score?.toFixed?.(4) ?? 'n/a'})`);
    sampleFields = hit.fields;
    for (const [key, value] of Object.entries(hit.fields)) {
      console.log(`     ${key}: ${preview(value)}`);
    }
  }
} catch (error) {
  bad(`search failed: ${error.message}`);
}

const textHit = config.textFields.find((field) => sampleFields[field]);
console.log('\nverdict');
if (textHit) {
  ok(`schema text will be read from "${textHit}" — TEXT_FIELDS is correct`);
} else if (Object.keys(sampleFields).length) {
  bad(`none of TEXT_FIELDS=${config.textFields.join(',')} exist on the records`);
  console.log(`    → set TEXT_FIELDS to whichever of these holds the schema: ${Object.keys(sampleFields).join(', ')}`);
} else {
  bad('no sample record retrieved, cannot verify TEXT_FIELDS');
}
console.log('');
