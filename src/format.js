import { config } from './config.js';

const isBlank = (value) =>
  value === null || value === undefined || (typeof value === 'string' && !value.trim());

/** First candidate field that actually holds a value, so callers can fall back. */
function pick(fields, candidates) {
  for (const field of candidates) {
    const value = fields[field];
    if (typeof value === 'string' && value.trim()) return { field, value: value.trim() };
    if (Array.isArray(value) && value.length) return { field, value: value.join('\n') };
  }
  return { field: null, value: null };
}

const renderValue = (value) => {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const score = (value) => (typeof value === 'number' ? value.toFixed(3) : 'n/a');

/**
 * Collapses hits into one entry per table. A table split across several chunks
 * used to be rendered several times over, header and all — the single biggest
 * source of duplicated tokens in a response.
 */
export function groupByTable(hits) {
  const groups = new Map();

  for (const hit of hits) {
    const { field: textField, value: text } = pick(hit.fields, config.textFields);
    const { value: table } = pick(hit.fields, config.tableFields);
    const { value: database } = pick(hit.fields, config.dbFields);
    const name = table ? (database ? `${database}.${table}` : table) : hit.id;

    let group = groups.get(name);
    if (!group) {
      group = { name, table: table ?? hit.id, database, score: -Infinity, chunks: [], fields: {}, textField };
      groups.set(name, group);
    }
    if (typeof hit.score === 'number' && hit.score > group.score) group.score = hit.score;
    if (text && !group.chunks.includes(text)) group.chunks.push(text);
    // First hit wins: it is the highest scoring one for this table.
    group.fields = { ...hit.fields, ...group.fields };
  }

  return [...groups.values()].sort((a, b) => b.score - a.score);
}

/**
 * Drops the same table retrieved from a second database. When an index holds
 * `speed_core_live` and `speed_core_test`, an unscoped search returns both
 * copies of everything and half of top_k is spent on duplicates — the highest
 * scoring copy wins and the others are noted in one line.
 */
export function dedupeByTable(groups, prefer = []) {
  const rank = (group) => {
    const index = prefer.indexOf(group.database);
    return index >= 0 ? index : prefer.length;
  };

  const byTable = new Map();
  for (const group of groups) {
    const existing = byTable.get(group.table);
    if (!existing) {
      byTable.set(group.table, group);
      continue;
    }
    const [keep, drop] = rank(group) < rank(existing) ? [group, existing] : [existing, group];
    keep.alsoIn ??= [];
    for (const database of [drop.database, ...(drop.alsoIn ?? [])]) {
      if (database && database !== keep.database && !keep.alsoIn.includes(database)) {
        keep.alsoIn.push(database);
      }
    }
    byTable.set(group.table, keep);
  }
  return [...byTable.values()];
}

/**
 * Structural keywords, not columns. `DATABASE x` and `TABLE db.t (` are the
 * header lines this index stores above every column list.
 */
const NOT_A_COLUMN =
  /^(database|table|view|schema|columns?|indexes?|create|primary|unique|key|index|constraint|foreign|check|partition|engine|\)|\(|--|\/\*|#)\b/i;

/** Column names parsed straight out of stored DDL — cheap enough to run per candidate. */
export function columnNames(text) {
  if (!text) return [];
  const names = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || NOT_A_COLUMN.test(trimmed)) continue;
    const match = trimmed.match(/^[`"[]?([A-Za-z_][\w$]*)[`"\]]?[\s(]/);
    if (match) names.push(match[1]);
  }
  return names;
}

/** The heading already says which database this is; the DDL need not repeat it. */
const stripHeader = (text) => text.replace(/^DATABASE[^\n]*\n/i, '');

/** One line per candidate: enough for a human to choose, ~15 tokens each. */
function summarise(group) {
  const text = group.chunks[0] ?? '';
  const columns = columnNames(text);
  if (columns.length) {
    const shown = columns.slice(0, 8);
    const more = columns.length > shown.length ? ` +${columns.length - shown.length} more` : '';
    return `${shown.join(', ')}${more}`;
  }
  const { value: description } = pick(group.fields, ['description', 'comment', 'summary']);
  if (description) return description.replace(/\s+/g, ' ').slice(0, 120);
  return text.replace(/\s+/g, ' ').slice(0, 120);
}

function clip(text, max) {
  if (text.length <= max) return { text, clipped: false };
  const cut = text.slice(0, max);
  const boundary = cut.lastIndexOf('\n');
  return { text: boundary > max * 0.6 ? cut.slice(0, boundary) : cut, clipped: true };
}

function renderTable(group, { detail, budget }) {
  const rank = group.match === 'name' ? 'exact name match' : score(group.score);
  const lines = [`## \`${group.name}\` · ${rank}`];
  if (group.alsoIn?.length) lines.push(`_same table also in: ${group.alsoIn.join(', ')}_`);

  if (detail === 'full') {
    const extras = Object.entries(group.fields).filter(
      ([key, value]) => key !== group.textField && !key.startsWith('_') && !isBlank(value),
    );
    for (const [key, value] of extras) lines.push(`- **${key}**: ${renderValue(value)}`);
  }

  const joined = group.chunks.map(stripHeader).join('\n');
  if (!joined) {
    lines.push('_(no schema text on this record — check TEXT_FIELDS)_');
    return lines.join('\n');
  }

  const limit = detail === 'full' ? budget : Math.min(budget, config.maxCharsPerTable);
  const { text, clipped } = clip(joined, limit);
  lines.push('```sql', text, '```');
  if (clipped) {
    lines.push(
      `_truncated — call \`get_table_schema\` with tables:["${group.table}"], detail:"full" for the rest._`,
    );
  }
  return lines.join('\n');
}

/**
 * The schema block the calling model writes SQL against. Deliberately terse:
 * the standing rules live in the server's `instructions` (sent once at
 * handshake) instead of being repeated in every single tool result.
 */
export function formatSchema({ question, groups, mode, database, note, detail = 'compact', extra = [] }) {
  if (!groups.length) return formatEmpty({ question, database });

  const header = [
    `# Schema for: ${question}`,
    [
      `${groups.length} table(s)`,
      `dialect \`${config.sqlDialect}\``,
      database ? `database \`${database}\`` : null,
      mode ? `via \`${mode}\`` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  ];
  if (note) header.push(`**Note:** ${note}`);

  const sections = [];
  let spent = header.join('\n').length;
  for (const group of groups) {
    const remaining = config.maxResponseChars - spent;
    if (remaining < 200) {
      sections.push(`_(response budget reached — ${groups.length - sections.length} table(s) omitted)_`);
      break;
    }
    const section = renderTable(group, { detail, budget: remaining });
    spent += section.length;
    sections.push(section);
  }

  const footer = extra.length
    ? [
        '',
        `_Also matched, not expanded: ${extra.map((group) => `\`${group.name}\` ${score(group.score)}`).join(', ')} — call \`get_table_schema\` if one of these is what you need._`,
      ]
    : [];

  return [...header, '', ...sections, ...footer].join('\n');
}

/**
 * The "which table did you mean?" block. Returned instead of a wall of DDL
 * whenever retrieval could not separate the candidates — costs a fraction of
 * the tokens and puts the choice with the person who knows the answer.
 */
export function formatCandidates({ question, candidates, reason, database, heading }) {
  const lines = [
    heading ?? `# Ambiguous: ${candidates.length} tables could answer "${question}"`,
    `_${reason}_`,
    '',
    '**Do not guess and do not write SQL yet.** Show this list to the user, ask which table(s) they mean,',
    'then call `get_table_schema` with the names they pick.',
    '',
  ];

  candidates.forEach((group, index) => {
    const also = group.alsoIn?.length ? ` (also in ${group.alsoIn.join(', ')})` : '';
    const rank = group.match === 'name' ? 'name match' : score(group.score);
    lines.push(`${index + 1}. \`${group.name}\`${also} · ${rank} — ${summarise(group)}`);
  });

  lines.push('');
  if (database) lines.push(`_Scoped to database \`${database}\`._`);
  lines.push('_If none of these fit, ask the user for the table name, or call `list_tables` with a `filter`._');
  return lines.join('\n');
}

/**
 * A name that is not in the index. Suggesting real names costs a line or two;
 * the alternative — falling back to semantic search and returning four
 * unrelated tables — costs several hundred tokens and answers nothing.
 */
export function formatUnknownTables({ missing, suggestions }) {
  const lines = [`No table named ${missing.map((name) => `\`${name}\``).join(', ')} in the index.`, ''];
  if (suggestions.length) {
    lines.push(
      'Closest real names:',
      ...suggestions.map((name) => `- \`${name}\``),
      '',
      'Ask the user which of these they meant, then call `get_table_schema` again with that name.',
    );
  } else {
    lines.push(
      'No similar names either. Ask the user for the exact table name, or call `list_tables` with a `filter`.',
    );
  }
  return lines.join('\n');
}

export function formatEmpty({ question, database }) {
  return [
    `No schema matched: "${question}"`,
    '',
    'Ask the user which table holds this data, or:',
    '- retry `search_schema` with wording closer to the real table/column names;',
    '- call `list_tables` with a `filter` substring to see what exists.',
    database ? `- the search was scoped to database \`${database}\` — try without it.` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
