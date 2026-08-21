import { config, assertConfig } from './config.js';
import { cached } from './cache.js';

const key = (...parts) => parts.map((part) => JSON.stringify(part ?? null)).join('|');

let clientPromise;
let describePromise;
let detectPromise;
/** Last unscoped table scan, kept for synchronous name matching. */
let inventory = null;
/** The scan currently in flight, so a query can wait a moment for it. */
let inventoryPromise;
/** Remembers whether this embed model accepts an explicit `dimension` param. */
let embedAcceptsDimension = true;

/**
 * The Pinecone SDK costs ~6s to import, so it is loaded on first use rather
 * than at startup — that keeps the MCP handshake fast and pays the cost once,
 * inside the first tool call.
 * @returns {Promise<import('@pinecone-database/pinecone').Pinecone>}
 */
function getClient() {
  assertConfig();
  clientPromise ??= import('@pinecone-database/pinecone')
    .then(({ Pinecone }) => new Pinecone({ apiKey: config.apiKey }))
    .catch((error) => {
      clientPromise = undefined; // let the next call retry
      throw error;
    });
  return clientPromise;
}

async function getNamespace(namespace) {
  const ns = namespace ?? config.namespace;
  const client = await getClient();
  const index = client.index({ name: config.indexName });
  return ns ? index.namespace(ns) : index;
}

/**
 * Index metadata, fetched once and cached. `integrated` is what decides how we
 * search: send raw text (integrated embedding) vs. embed it ourselves first.
 */
export function describeIndex() {
  describePromise ??= (async () => {
    const client = await getClient();
    const info = await client.describeIndex(config.indexName);
    return {
      name: info.name,
      dimension: info.dimension,
      metric: info.metric,
      vectorType: info.vectorType,
      integrated: Boolean(info.embed),
      embedModel: info.embed?.model,
    };
  })().catch((error) => {
    describePromise = undefined;
    throw error;
  });
  return describePromise;
}

/**
 * Samples a few records to learn which metadata keys this index actually uses,
 * so filters reference real field names instead of guesses. Cached.
 */
function detectFields() {
  detectPromise ??= (async () => {
    const found = new Set();
    try {
      const ns = await getNamespace();
      const page = await ns.listPaginated({ limit: 5 });
      const ids = (page.vectors ?? []).map((vector) => vector.id).filter(Boolean);
      if (ids.length) {
        const fetched = await ns.fetch({ ids });
        for (const record of Object.values(fetched.records ?? {})) {
          for (const key of Object.keys(record.metadata ?? {})) found.add(key);
        }
      }
    } catch {
      // Fall through to the configured defaults.
    }
    const first = (candidates) => candidates.find((field) => found.has(field));
    return {
      textField: first(config.textFields) ?? config.textFields[0],
      tableField: first(config.tableFields) ?? config.tableFields[0],
      dbField: first(config.dbFields) ?? null,
    };
  })();
  return detectPromise;
}

const caseVariants = (value) => [...new Set([value, value.toLowerCase(), value.toUpperCase()])];

/** Builds a top-level filter. Multiple keys are an implicit AND in Pinecone. */
async function buildFilter({ tables, database }) {
  const { tableField, dbField } = await detectFields();
  const filter = {};
  if (tables?.length) {
    filter[tableField] = { $in: tables.flatMap(caseVariants) };
  }
  const db = database ?? config.defaultDatabase;
  if (db && dbField) {
    filter[dbField] = { $in: caseVariants(db) };
  }
  return Object.keys(filter).length ? filter : undefined;
}

async function embedQuery(text, dimension) {
  const client = await getClient();
  const call = (parameters) =>
    client.inference.embed({ model: config.embedModel, inputs: [text], parameters });

  const base = { inputType: 'query', truncate: 'END' };
  let response;
  if (embedAcceptsDimension) {
    try {
      // Matryoshka models (llama-text-embed-v2) need the index dimension.
      response = await call({ ...base, dimension });
    } catch {
      // Fixed-dimension models reject it; don't pay for the retry again.
      embedAcceptsDimension = false;
    }
  }
  response ??= await call(base);

  const values = response.data?.[0]?.values;
  if (!values?.length) {
    throw new Error(`Embedding model "${config.embedModel}" returned no vector for the query.`);
  }
  if (dimension && values.length !== dimension) {
    throw new Error(
      `Embedding dimension mismatch: model "${config.embedModel}" produced ${values.length} dims but index "${config.indexName}" expects ${dimension}. Set EMBED_MODEL to the model you used when upserting.`,
    );
  }
  return values;
}

/** Normalises the two different response shapes into { id, score, fields }. */
const fromHit = (hit) => ({ id: hit._id, score: hit._score, fields: hit.fields ?? {} });
const fromMatch = (match) => ({ id: match.id, score: match.score, fields: match.metadata ?? {} });

/**
 * Semantic search over the schema index.
 * @returns {Promise<{hits: Array<{id: string, score: number, fields: object}>, mode: string}>}
 */
export function searchSchema({ query, topK, tables, database, namespace }) {
  return cached(key('search', query, topK, tables, database, namespace), () =>
    runSearch({ query, topK, tables, database, namespace }),
  );
}

async function runSearch({ query, topK, tables, database, namespace }) {
  const [index, ns, filter] = await Promise.all([
    describeIndex(),
    getNamespace(namespace),
    buildFilter({ tables, database }),
  ]);

  if (index.integrated) {
    const response = await ns.searchRecords({
      query: { topK, inputs: { text: query }, ...(filter ? { filter } : {}) },
    });
    return { hits: (response.result?.hits ?? []).map(fromHit), mode: 'integrated' };
  }

  const vector = await embedQuery(query, index.dimension);
  const response = await ns.query({
    vector,
    topK,
    includeMetadata: true,
    ...(filter ? { filter } : {}),
  });
  return { hits: (response.matches ?? []).map(fromMatch), mode: `embed:${config.embedModel}` };
}

/**
 * Exact lookup by table name, optionally scoped to one database. Falls back to
 * semantic search so a slightly wrong name never returns nothing at all.
 */
export function fetchTable(table, { database, namespace } = {}) {
  return cached(key('table', table, database, namespace), () =>
    runFetchTable(table, { database, namespace }),
  );
}

async function runFetchTable(table, { database, namespace } = {}) {
  const [ns, filter] = await Promise.all([
    getNamespace(namespace),
    buildFilter({ tables: [table], database }),
  ]);

  if (filter) {
    try {
      const response = await ns.fetchByMetadata({ filter, limit: 50 });
      const records = Object.values(response.records ?? {});
      if (records.length) {
        return {
          hits: records.map((record) => ({ id: record.id, score: 1, fields: record.metadata ?? {} })),
          matchedBy: 'exact-metadata',
        };
      }
    } catch {
      // Filter unsupported for these fields — drop to semantic search.
    }
  }

  const fallback = await searchSchema({
    query: `schema, columns and data types of the "${table}" table`,
    topK: 5,
    database,
    namespace,
  });
  return { hits: fallback.hits, matchedBy: 'semantic-fallback' };
}

/**
 * Walks the index to collect every table, grouped by database, plus the
 * metadata keys in use. Capped by LIST_SCAN_LIMIT.
 */
export function scanTables({ database, namespace } = {}) {
  const unscoped = !database && !namespace;
  const promise = cached(key('scan', database, namespace), () =>
    runScanTables({ database, namespace }),
  ).then((scan) => {
    if (unscoped) inventory = scan;
    return scan;
  });

  // Tracked separately so a query can wait on a warm-up already under way.
  if (unscoped) {
    inventoryPromise = promise.catch(() => {
      inventoryPromise = undefined;
      return null;
    });
  }
  return promise;
}

/** The unscoped table inventory, but only if it is already in memory. Never blocks. */
export const peekInventory = () => inventory;

/**
 * The inventory, waiting at most `ms` for a warm-up already in flight, then
 * giving up and resolving null. Waiting a beat for the right table beats
 * answering the first question of a session with a shortlist; waiting
 * indefinitely would just move the cold start into the user's query.
 */
export function inventoryWithin(ms) {
  if (inventory) return Promise.resolve(inventory);
  if (!inventoryPromise || ms <= 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    inventoryPromise.then(settle, () => settle(null));
  });
}

/**
 * Fire-and-forget priming, called once at startup. The Pinecone SDK import
 * costs ~6s and the full table scan ~19s; paying that in the background means
 * the first real question does not. Nothing awaits it and nothing depends on
 * it — every consumer falls back to working without it.
 */
export function warmup() {
  const note = (label) => (error) =>
    console.error(`[askdb-mcp] warmup ${label}: ${error?.message ?? error}`);
  describeIndex().catch(note('describeIndex'));
  scanTables({}).catch(note('scanTables'));
}

async function runScanTables({ database, namespace } = {}) {
  const [ns, { tableField, dbField }] = await Promise.all([getNamespace(namespace), detectFields()]);
  const wanted = database ?? config.defaultDatabase;

  // Listing ids is cheap (no metadata comes back); fetching the records is not.
  // So collect every id first, then fetch the batches concurrently — done
  // sequentially, a 466-record index took ~19s.
  const batches = [];
  let paginationToken;
  let listed = 0;
  do {
    const page = await ns.listPaginated({
      limit: 100,
      ...(paginationToken ? { paginationToken } : {}),
    });
    const ids = (page.vectors ?? []).map((vector) => vector.id).filter(Boolean);
    if (!ids.length) break;
    batches.push(ids);
    listed += ids.length;
    paginationToken = page.pagination?.next;
  } while (paginationToken && listed < config.listScanLimit);

  const byDatabase = new Map();
  const metadataKeys = new Set();
  let scanned = 0;

  const add = (db, table) => {
    if (wanted && String(db).toLowerCase() !== wanted.toLowerCase()) return;
    if (!byDatabase.has(db)) byDatabase.set(db, new Set());
    byDatabase.get(db).add(table);
  };

  // Fetch one batch first. If every id in it is exactly `database.table`, the
  // remaining ids can be read directly and the other batches never fetched —
  // on a ~486-table index that is ~386 records of DDL left on the wire.
  const sample = batches.length ? await ns.fetch({ ids: batches[0] }) : { records: {} };
  const sampled = Object.values(sample.records ?? {});
  for (const record of sampled) {
    for (const key of Object.keys(record.metadata ?? {})) metadataKeys.add(key);
  }

  const split = (id) => {
    const dot = id.indexOf('.');
    return dot > 0 ? { db: id.slice(0, dot), table: id.slice(dot + 1) } : null;
  };
  const idsAreQualified =
    sampled.length > 0 &&
    Boolean(dbField) &&
    sampled.every((record) => {
      const parts = split(record.id);
      const metadata = record.metadata ?? {};
      return (
        parts && parts.db === String(metadata[dbField]) && parts.table === String(metadata[tableField])
      );
    });

  const consume = (records) => {
    for (const record of records) {
      scanned += 1;
      const metadata = record.metadata ?? {};
      const db = (dbField && metadata[dbField]) || '(unspecified)';
      const table = metadata[tableField];
      add(db, typeof table === 'string' && table.trim() ? table.trim() : record.id);
    }
  };

  consume(sampled);

  // Batches whose ids all parse are read directly; anything with an id that
  // does not follow the convention is still fetched, so a mixed index cannot
  // end up with names guessed out of a malformed id.
  const remaining = batches.slice(1);
  const toFetch = idsAreQualified ? [] : remaining;
  if (idsAreQualified) {
    for (const ids of remaining) {
      if (!ids.every((id) => split(id))) {
        toFetch.push(ids);
        continue;
      }
      for (const id of ids) {
        scanned += 1;
        const { db, table } = split(id);
        add(db, table);
      }
    }
  }

  for (let index = 0; index < toFetch.length; index += config.scanConcurrency) {
    const slice = toFetch.slice(index, index + config.scanConcurrency);
    const pages = await Promise.all(slice.map((ids) => ns.fetch({ ids })));
    for (const page of pages) {
      const records = Object.values(page.records ?? {});
      for (const record of records) {
        for (const key of Object.keys(record.metadata ?? {})) metadataKeys.add(key);
      }
      consume(records);
    }
  }

  return {
    databases: [...byDatabase.entries()]
      .map(([db, tables]) => ({
        database: db,
        tables: [...tables].sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.database.localeCompare(b.database)),
    metadataKeys: [...metadataKeys].sort(),
    scanned,
    truncated: Boolean(paginationToken) && scanned >= config.listScanLimit,
  };
}

export async function listNamespaces() {
  const client = await getClient();
  const stats = await client.index({ name: config.indexName }).describeIndexStats();
  return Object.entries(stats.namespaces ?? {}).map(([name, value]) => ({
    name: name || '(default)',
    recordCount: value.recordCount ?? 0,
  }));
}
