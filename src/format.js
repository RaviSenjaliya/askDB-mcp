import { config } from "./config.js";

const isBlank = (value) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && !value.trim());

function pick(fields, candidates) {
  for (const field of candidates) {
    const value = fields[field];
    if (typeof value === "string" && value.trim())
      return { field, value: value.trim() };
    if (Array.isArray(value) && value.length)
      return { field, value: value.join("\n") };
  }
  return { field: null, value: null };
}

const renderValue = (value) =>
  Array.isArray(value)
    ? value.join(", ")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);

function renderHit(hit, position) {
  const { field: textField, value: text } = pick(hit.fields, config.textFields);
  const { value: table } = pick(hit.fields, config.tableFields);
  const { value: database } = pick(hit.fields, config.dbFields);

  const name = table ? (database ? `${database}.${table}` : table) : hit.id;
  const score = typeof hit.score === "number" ? hit.score.toFixed(4) : "n/a";

  const lines = [`### ${position}. \`${name}\`   _(relevance ${score})_`];

  const extras = Object.entries(hit.fields).filter(
    ([key, value]) =>
      key !== textField && !key.startsWith("_") && !isBlank(value)
  );
  for (const [key, value] of extras) {
    lines.push(`- **${key}**: ${renderValue(value)}`);
  }

  if (text) {
    lines.push("", "```sql", text, "```");
  } else if (!extras.length) {
    lines.push("- _(record had no readable text; check TEXT_FIELDS)_");
  }

  return lines.join("\n");
}

/**
 * Builds the block handed back to the calling LLM. The instructions matter as
 * much as the schema: they keep the model from inventing tables that are not
 * in the retrieved context.
 */
export function formatSchemaContext({
  question,
  hits,
  mode,
  namespace,
  database,
  note,
}) {
  if (!hits.length) {
    return [
      `No schema matched: "${question}"`,
      "",
      "Next steps:",
      "- Retry `search_schema` with wording closer to the actual table/column names.",
      "- Call `list_tables` to see what this database really contains.",
      database
        ? `- The search was scoped to database \`${database}\` — try without it.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const scope = [
    `**Matches:** ${hits.length}`,
    database ? `database \`${database}\`` : null,
    namespace ? `namespace \`${namespace}\`` : null,
    mode ? `retrieval \`${mode}\`` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const header = [
    "# Retrieved database schema",
    "",
    `**Question:** ${question}`,
    scope,
    `**SQL dialect:** ${config.sqlDialect}`,
  ];
  if (note) header.push(`**Note:** ${note}`);

  const instructions = [
    "",
    "## How to use this",
    "1. Write the SQL using **only** the tables and columns below — do not invent names.",
    "2. Table names are shown fully qualified as `database.table`; keep that qualification in the query when more than one database appears.",
    "3. Join on the keys shown in the DDL. If a needed relationship is not visible, say so instead of guessing.",
    "4. If something is missing, call `search_schema` again with different wording, or `get_table_schema` for an exact table.",
    "5. Return the query in a `sql` block and state any assumptions.",
    "",
    "## Schema",
    "",
  ];

  const body = hits.map((hit, index) => renderHit(hit, index + 1)).join("\n\n");
  return [...header, ...instructions, body].join("\n");
}
