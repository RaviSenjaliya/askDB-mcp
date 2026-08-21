/**
 * Name matching over the table inventory, used to rescue the cases pure vector
 * search gets wrong.
 *
 * With an e5 index every cosine score lands between 0.79 and 0.83, so a
 * question about payments can rank `tbl_payment_link_preset_type` above
 * `tbl_payment` — the embedding cannot tell them apart, but the *name* can.
 * This runs against the already-cached inventory, so it costs nothing at
 * query time.
 */

const STOP = new Set(
  `a an the of for from with and or to in on at by as is are was were be been do does did
   how what which who whom when where why many much show me my we our us its their his her list give find get
   need want please all any some each every total sum count avg average number amount_of
   top last first latest recent new old previous next between over under above below
   select query sql table tables data database db record records row rows report
   month months day days year years week weeks time date today yesterday`
    .split(/\s+/)
    .filter(Boolean),
);

/** Prefixes that carry no meaning: tbl_payment and payment are the same table. */
const PREFIX = /^(tbl_|tb_|t_|vw_|v_|dim_|fact_|stg_)/;
const IS_VIEW = /^(vw_|v_)/i;

/** "payments" -> "payment", but "status" and "address" are left alone. */
const singular = (word) =>
  word.length > 3 && word.endsWith('s') && !/(ss|us|is|as)$/.test(word) ? word.slice(0, -1) : word;

/** Content words from the question, normalised the same way table names are. */
export function keywords(question) {
  const words = question.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? [];
  return [...new Set(words.map(singular))].filter((word) => !STOP.has(word));
}

/** `speed_core_live.tbl_payment_link` -> ['payment', 'link'] */
function tokens(table) {
  return table
    .toLowerCase()
    .split('.')
    .pop()
    .replace(PREFIX, '')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(singular);
}

/**
 * Real table names close to one the caller asked for. Catches the ordinary
 * misses — "payments" for `tbl_payment`, a missing `tbl_` prefix, a name from
 * the wrong environment — without a round trip to the index.
 */
export function similarTables(name, inventory, { prefer = [], limit = 6 } = {}) {
  const wanted = singular(name.toLowerCase().split('.').pop().replace(PREFIX, ''));
  if (!wanted || !inventory?.databases?.length) return [];

  const found = [];
  const order = (db) => (prefer.indexOf(db) >= 0 ? prefer.indexOf(db) : prefer.length);
  for (const entry of inventory.databases) {
    for (const table of entry.tables) {
      const bare = singular(table.toLowerCase().replace(PREFIX, ''));
      if (bare === wanted || bare.includes(wanted) || wanted.includes(bare)) {
        found.push({ name: `${entry.database}.${table}`, table, database: entry.database, exact: bare === wanted });
      }
    }
  }

  const seen = new Set();
  return found
    .sort(
      (a, b) =>
        b.exact - a.exact ||
        a.table.length - b.table.length ||
        order(a.database) - order(b.database) ||
        a.table.localeCompare(b.table),
    )
    .filter((match) => !seen.has(match.table) && seen.add(match.table))
    .slice(0, limit)
    .map((match) => match.name);
}

/**
 * Scores every table in the inventory against the question's keywords.
 *
 * A table is a *covered* match when every token in its name was asked for:
 * "pos terminals" covers `tbl_pos_terminal` completely, but only a third of
 * `tbl_pos_terminal_charge_payment_mapping`. Among covered names the longest
 * wins, so `tbl_pos_terminal` beats the bare `tbl_pos` — it accounts for more
 * of the question. Anything not fully covered is left to the vector search.
 */
export function matchTables(question, inventory, { database, limit = 3, prefer = [] } = {}) {
  const words = keywords(question);
  if (!words.length || !inventory?.databases?.length) return [];

  const scored = [];
  for (const entry of inventory.databases) {
    if (database && entry.database.toLowerCase() !== database.toLowerCase()) continue;
    for (const table of entry.tables) {
      const parts = tokens(table);
      if (!parts.length) continue;
      const matched = parts.filter((part) => words.includes(part));
      if (!matched.length || matched.length !== parts.length) continue; // partial names are noise
      scored.push({
        database: entry.database,
        table,
        name: `${entry.database}.${table}`,
        weight: matched.length,
        signature: parts.join('_'),
        view: IS_VIEW.test(table),
      });
    }
  }
  if (!scored.length) return [];

  // Databases named by the caller first, then the biggest — a table that lives
  // in both _live and _test should come back from the one actually in use.
  const size = new Map(inventory.databases.map((entry) => [entry.database, entry.tables.length]));
  const rank = (db) => {
    const preferred = prefer.indexOf(db);
    return preferred >= 0 ? preferred : prefer.length + 1 / (size.get(db) ?? 1);
  };

  scored.sort(
    (a, b) =>
      b.weight - a.weight ||
      a.view - b.view || // the base table before the view over it
      rank(a.database) - rank(b.database) ||
      a.table.localeCompare(b.table),
  );

  // One entry per name signature: `tbl_account_kyc` in _live and in _test, and
  // the `vw_account_kyc` view over it, are all one answer.
  const seen = new Set();
  const best = scored[0].weight;
  return scored
    .filter((match) => match.weight === best && !seen.has(match.signature) && seen.add(match.signature))
    .slice(0, limit);
}
