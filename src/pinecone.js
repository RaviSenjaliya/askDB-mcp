import { config, assertConfig } from './config.js';

let clientPromise;
let describePromise;
let detectPromise;
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

/**
 * Index metadata is fetched once and cached. `embed` is present only when the
 * index was created with integrated embedding, which decides how we search:
 * send raw text (integrated) vs. embed it ourselves first (external).
 */
export function describeIndex() {
  describePromise ??= (async () => {
    const client = await getClient();
    const info = await client.describeIndex(config.indexName);
    return {
      name: info.name,
      dimension: info.dimension,
      metric: info.metric,
      host: info.host,
      vectorType: info.vectorType,
      integrated: Boolean(info.embed),
      embedModel: info.embed?.model,
      fieldMap: info.embed?.fieldMap,
    };
  })().catch((error) => {
    describePromise = undefined;
    throw error;
  });
  return describePromise;
}

async function getNamespace(namespace) {
  const ns = namespace ?? config.namespace;
  const client = await getClient();
  const index = client.index({ name: config.indexName });
  return ns ? index.namespace(ns) : index;
}

/**
 * Samples a few records to learn which metadata keys this index actually uses,
 * so filters reference real field names instead of guesses. Cached.
 */
export function detectFields() {
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
      metadataKeys: [...found].sort(),
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
 * Cross-encoder rerank. Embedding similarity over whole-table DDL blobs is
 * mushy — every table full of ids and timestamps looks alike — so reranking can
 * put the right table first. Opt-in via RERANK_MODEL: on DDL it is not a
 * guaranteed win, so measure before enabling.
 */
async function rerankHits({ query, hits, topN }) {
  if (!config.rerankModel || hits.length < 2) return { hits, reranked: false };
  const { textField } = await detectFields();

  const documents = hits.map((hit, index) => ({
    id: String(index),
    text: String(hit.fields[textField] ?? hit.id).slice(0, config.rerankMaxChars),
  }));

  try {
    const client = await getClient();
    const response = await client.inference.rerank({
      model: config.rerankModel,
      query,
      documents,
      topN,
      rankFields: ['text'],
      returnDocuments: false,
      parameters: { truncate: 'END' },
    });
    const ordered = (response.data ?? [])
      .map((row) => (hits[row.index] ? { ...hits[row.index], score: row.score } : null))
      .filter(Boolean);
    return ordered.length
      ? { hits: ordered, reranked: true }
      : { hits: hits.slice(0, topN), reranked: false };
  } catch {
    // Reranking is an enhancement; never let it fail the whole lookup.
    return { hits: hits.slice(0, topN), reranked: false };
  }
}

/**
 * Semantic search over the schema index.
 * @returns {Promise<{hits: Array<{id: string, score: number, fields: object}>, mode: string, filter?: object}>}
 */
export async function searchSchema({ query, topK, tables, database, namespace }) {
  const [index, ns, filter] = await Promise.all([
    describeIndex(),
    getNamespace(namespace),
    buildFilter({ tables, database }),
  ]);

  // Over-fetch when reranking, so the reranker has candidates to reorder.
  const fetchK = config.rerankModel ? Math.min(topK * config.rerankOverfetch, 200) : topK;

  let raw;
  let mode;
  if (index.integrated) {
    const response = await ns.searchRecords({
      query: { topK: fetchK, inputs: { text: query }, ...(filter ? { filter } : {}) },
    });
    raw = (response.result?.hits ?? []).map(fromHit);
    mode = 'integrated';
  } else {
    const vector = await embedQuery(query, index.dimension);
    const response = await ns.query({
      vector,
      topK: fetchK,
      includeMetadata: true,
      ...(filter ? { filter } : {}),
    });
    raw = (response.matches ?? []).map(fromMatch);
    mode = `embed:${config.embedModel}`;
  }

  const { hits, reranked } = await rerankHits({ query, hits: raw, topN: topK });
  return { hits, mode: reranked ? `${mode}+rerank:${config.rerankModel}` : mode, filter };
}

/**
 * Exact lookup by table name, optionally scoped to one database. Falls back to
 * semantic search so a slightly wrong name never returns nothing at all.
 */
export async function fetchTable(table, { database, namespace } = {}) {
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
          hits: records.map((record) => ({
            id: record.id,
            score: 1,
            fields: record.metadata ?? {},
          })),
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
export async function scanTables({ database, namespace } = {}) {
  const [ns, { tableField, dbField }] = await Promise.all([getNamespace(namespace), detectFields()]);
  const wanted = database ?? config.defaultDatabase;

  const byDatabase = new Map();
  const metadataKeys = new Set();
  let scanned = 0;
  let paginationToken;

  do {
    const page = await ns.listPaginated({
      limit: 100,
      ...(paginationToken ? { paginationToken } : {}),
    });
    const ids = (page.vectors ?? []).map((vector) => vector.id).filter(Boolean);
    if (!ids.length) break;

    const fetched = await ns.fetch({ ids });
    for (const record of Object.values(fetched.records ?? {})) {
      scanned += 1;
      const metadata = record.metadata ?? {};
      for (const key of Object.keys(metadata)) metadataKeys.add(key);

      const db = (dbField && metadata[dbField]) || '(unspecified)';
      if (wanted && String(db).toLowerCase() !== wanted.toLowerCase()) continue;

      const table = metadata[tableField];
      const label = typeof table === 'string' && table.trim() ? table.trim() : record.id;
      if (!byDatabase.has(db)) byDatabase.set(db, new Set());
      byDatabase.get(db).add(label);
    }
    paginationToken = page.pagination?.next;
  } while (paginationToken && scanned < config.listScanLimit);

  return {
    databases: [...byDatabase.entries()]
      .map(([db, tables]) => ({ database: db, tables: [...tables].sort((a, b) => a.localeCompare(b)) }))
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
