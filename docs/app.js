/* =========================================================================
 * SchemaShift — Migration Safety Reviewer
 * Client-side rule engine. Runs entirely in the browser. No network.
 *
 * Rule catalogue is adapted from the published catalogues of squawk
 * (https://squawkhq.com) and strong_migrations
 * (https://github.com/ankane/strong_migrations). Each rule carries a citation
 * in the `source` field.
 *
 * Severity weights (four tiers — the fourth, "critical", is what distinguishes
 * a migration that will take a production lock from one that is merely untidy):
 *   low      = 1
 *   medium   = 3
 *   high     = 6
 *   critical = 10
 *
 * The grade is derived by subtracting the sum of severity weights from 100,
 * clamped to [0, 100], then mapping to A/B/C/D/F. The rewrite plan surfaces
 * the expand–migrate–contract alternative for rules that have one.
 * ========================================================================= */

/* ----------------------------- DOM handles ------------------------------ */
const el = {
  sqlInput: document.getElementById("sql-input"),
  sqlFile: document.getElementById("sql-file"),
  analyseBtn: document.getElementById("analyse-btn"),
  resetBtn: document.getElementById("reset-btn"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),
  resultsSection: document.getElementById("results-section"),
  resultsH: document.getElementById("results-h"),
  scoreNumber: document.getElementById("score-number"),
  scoreTitle: document.getElementById("score-title"),
  scoreSummary: document.getElementById("score-summary"),
  scoreSr: document.getElementById("score-sr"),
  ringFg: document.getElementById("ring-fg"),
  gradeBadge: document.getElementById("grade-badge"),
  gradeLetter: document.getElementById("grade-letter"),
  gradeWord: document.getElementById("grade-word"),
  gradeGlyph: document.getElementById("grade-glyph-path"),
  findingsSection: document.getElementById("findings-section"),
  findingsList: document.getElementById("findings-list"),
  findingsEmpty: document.getElementById("findings-empty"),
  rewritesSection: document.getElementById("rewrites-section"),
  rewritesIntro: document.getElementById("rewrites-intro"),
  rewrites: document.getElementById("rewrites"),
  codeSection: document.getElementById("code-section"),
  codeDisplay: document.getElementById("code-display"),
  themeToggle: document.getElementById("theme-toggle"),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 from viewBox

/* ------------------------------ Severity -------------------------------- */
const SEVERITY = {
  low: { weight: 1, order: 0, label: "Low" },
  medium: { weight: 3, order: 1, label: "Medium" },
  high: { weight: 6, order: 2, label: "High" },
  critical: { weight: 10, order: 3, label: "Critical" },
};

/* ------------------------------ Rule catalogue --------------------------- */
/* Each rule:
 *   id, severity, title, description, regex (applied to a single statement
 *   after comment stripping), rewrite (optional) — if present, the rewrite
 *   engine will emit an expand–migrate–contract plan.
 *
 *   rewrite.phases is an array of { phase, explain, sql }. The phase string
 *   is one of "Expand", "Migrate", "Contract".
 */
const RULES = [
  /* ----------------------------- BLOCKING ------------------------------- */
  {
    id: "BL-001",
    severity: "critical",
    title: "SET NOT NULL on populated table without a check-constraint shim",
    description:
      "ALTER TABLE … ALTER COLUMN … SET NOT NULL performs a full-table rewrite on Postgres < 12 and a full-table scan on Postgres 12+, while holding an ACCESS EXCLUSIVE lock. On a populated table, reads and writes are blocked for the duration.",
    source: "squawk: adding-not-null-field; strong_migrations: setting-not-null",
    regex:
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\w".]+\s+ALTER(?:\s+COLUMN)?\s+[\w".]+\s+SET\s+NOT\s+NULL/i,
    rewrite: (match, table, column) => ({
      phases: [
        {
          phase: "Expand",
          explain:
            "Add a NOT VALID CHECK constraint first. The CHECK is not enforced against existing rows, so it acquires a brief lock only.",
          sql: `ALTER TABLE ${table || "<table>"}
    ADD CONSTRAINT ${column || "<column>"}_not_null
    CHECK (${column || "<column>"} IS NOT NULL) NOT VALID;`,
        },
        {
          phase: "Migrate",
          explain:
            "Backfill any rows where the column is NULL, then VALIDATE the constraint. VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock, which does not block reads or writes.",
          sql: `-- Backfill in batches from a background job, not this migration:
UPDATE ${table || "<table>"} SET ${column || "<column>"} = <default>
    WHERE ${column || "<column>"} IS NULL;

ALTER TABLE ${table || "<table>"}
    VALIDATE CONSTRAINT ${column || "<column>"}_not_null;`,
        },
        {
          phase: "Contract",
          explain:
            "On Postgres 12+, ALTER COLUMN … SET NOT NULL will recognise the validated CHECK and skip the table scan, acquiring ACCESS EXCLUSIVE only briefly. Drop the now-redundant CHECK afterwards.",
          sql: `ALTER TABLE ${table || "<table>"}
    ALTER COLUMN ${column || "<column>"} SET NOT NULL;

ALTER TABLE ${table || "<table>"}
    DROP CONSTRAINT ${column || "<column>"}_not_null;`,
        },
      ],
    }),
  },
  {
    id: "BL-002",
    severity: "high",
    title: "ADD FOREIGN KEY without NOT VALID",
    description:
      "Adding a foreign key validates every existing row, which acquires an ACCESS EXCLUSIVE lock on the referencing table and a ROW SHARE lock on the referenced table for the duration of the scan.",
    source: "squawk: adding-foreign-key-constraint",
    regex:
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\w".]+\s+ADD\s+(?:CONSTRAINT\s+[\w"]+\s+)?FOREIGN\s+KEY(?!(?:.|\n)*?NOT\s+VALID)/i,
    rewrite: (match, table) => ({
      phases: [
        {
          phase: "Expand",
          explain:
            "Add the constraint with NOT VALID. This enforces the constraint for new writes without scanning existing rows, so it finishes quickly.",
          sql: `ALTER TABLE ${table || "<table>"}
    ADD CONSTRAINT <constraint_name>
    FOREIGN KEY (<column>) REFERENCES <other_table> (<other_column>)
    NOT VALID;`,
        },
        {
          phase: "Migrate",
          explain:
            "Validate the constraint in a separate transaction. VALIDATE CONSTRAINT takes a SHARE UPDATE EXCLUSIVE lock, which does not block reads or writes.",
          sql: `ALTER TABLE ${table || "<table>"}
    VALIDATE CONSTRAINT <constraint_name>;`,
        },
      ],
    }),
  },
  {
    id: "BL-003",
    severity: "high",
    title: "CREATE INDEX without CONCURRENTLY",
    description:
      "A non-concurrent CREATE INDEX holds a SHARE lock on the table for the entire build, blocking all writes until the index is fully built.",
    source:
      "squawk: disallowed-unique-constraint; strong_migrations: adding-an-index-non-concurrently",
    regex:
      /CREATE(?:\s+UNIQUE)?\s+INDEX(?!\s+CONCURRENTLY)(?:\s+IF\s+NOT\s+EXISTS)?\s+[\w".]+\s+ON\s+/i,
    rewrite: (match) => ({
      phases: [
        {
          phase: "Migrate",
          explain:
            "Use CREATE INDEX CONCURRENTLY. It does not take a long-running lock, but cannot run inside a transaction — ship it in its own migration file with the transaction wrapper disabled.",
          sql: match
            .replace(/CREATE\s+INDEX/i, "CREATE INDEX CONCURRENTLY")
            .replace(/CREATE\s+UNIQUE\s+INDEX/i, "CREATE UNIQUE INDEX CONCURRENTLY") + ";",
        },
      ],
    }),
  },
  {
    id: "BL-004",
    severity: "high",
    title: "ADD COLUMN with a volatile default on a populated table",
    description:
      "On Postgres < 11, adding a column with any default performs a full table rewrite while holding ACCESS EXCLUSIVE. On Postgres 11+, a constant default is stored in pg_attrdef and is cheap, but a volatile default (now(), gen_random_uuid(), nextval()) still rewrites the table.",
    source: "squawk: adding-field-with-default",
    regex:
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\w".]+\s+ADD\s+(?:COLUMN\s+)?[\w".]+[\s\S]*?DEFAULT\s+(?:now\s*\(\s*\)|current_timestamp|gen_random_uuid\s*\(\s*\)|uuid_generate_v4\s*\(\s*\)|nextval\s*\()/i,
    rewrite: (match, table, column) => ({
      phases: [
        {
          phase: "Expand",
          explain:
            "Add the column without a default. This is a metadata-only change on all supported Postgres versions.",
          sql: `ALTER TABLE ${table || "<table>"}
    ADD COLUMN ${column || "<column>"} <type>;`,
        },
        {
          phase: "Migrate",
          explain:
            "Backfill in batches from a background job. The migration itself must not execute the UPDATE.",
          sql: `-- Background job, not this migration:
UPDATE ${table || "<table>"} SET ${column || "<column>"} = <value> WHERE <batch predicate>;`,
        },
        {
          phase: "Contract",
          explain:
            "After the backfill completes, set the default for future inserts.",
          sql: `ALTER TABLE ${table || "<table>"}
    ALTER COLUMN ${column || "<column>"} SET DEFAULT <default_expr>;`,
        },
      ],
    }),
  },
  {
    id: "BL-005",
    severity: "critical",
    title: "CLUSTER or VACUUM FULL inside a migration",
    description:
      "CLUSTER and VACUUM FULL rewrite the entire table under an ACCESS EXCLUSIVE lock. They are never appropriate inside a migration that must succeed or fail atomically.",
    source: "strong_migrations",
    regex: /\b(CLUSTER|VACUUM\s+FULL)\b/i,
    rewrite: () => ({
      phases: [
        {
          phase: "Migrate",
          explain:
            "Remove this statement from the migration. Use pg_repack (https://github.com/reorg/pg_repack) or pgroll (Xata) for online table reorganisation, run from an operations runbook rather than application migrations.",
          sql: "-- Do not run CLUSTER or VACUUM FULL from a migration.\n-- Use pg_repack or schedule maintenance with the operations team.",
        },
      ],
    }),
  },

  /* ------------------------------- UNSAFE ------------------------------- */
  {
    id: "UN-001",
    severity: "critical",
    title: "DROP COLUMN",
    description:
      "Dropping a column breaks every application instance still referencing it. A rolling deploy that drops the column before the last referencing instance has stopped will produce errors.",
    source: "squawk; strong_migrations",
    regex:
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\w".]+\s+DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?[\w".]+/i,
    rewrite: (match, table, column) => ({
      phases: [
        {
          phase: "Expand",
          explain:
            "First deploy application code that neither reads from nor writes to the column. Wait for every running instance to have been rolled forward.",
          sql: `-- Application change only. No SQL in this phase.`,
        },
        {
          phase: "Contract",
          explain:
            "Once no application reads the column, drop it. If the column is referenced by a view, index, or constraint, drop those first.",
          sql: `ALTER TABLE ${table || "<table>"}
    DROP COLUMN ${column || "<column>"};`,
        },
      ],
    }),
  },
  {
    id: "UN-002",
    severity: "high",
    title: "ALTER COLUMN … TYPE (potentially narrowing)",
    description:
      "Changing a column type may rewrite every row and may lose data. TEXT to VARCHAR(N), BIGINT to INT, and TIMESTAMPTZ to TIMESTAMP are all lossy without explicit conversion.",
    source: "squawk: changing-column-type",
    regex:
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?[\w".]+\s+ALTER(?:\s+COLUMN)?\s+[\w".]+\s+(?:SET\s+DATA\s+)?TYPE\s+/i,
    rewrite: (match, table, column) => ({
      phases: [
        {
          phase: "Expand",
          explain:
            "Add a new column with the target type. Set up a trigger that dual-writes from the old column.",
          sql: `ALTER TABLE ${table || "<table>"}
    ADD COLUMN ${column || "<column>"}_new <new_type>;

-- Dual-write trigger, created in this migration:
CREATE OR REPLACE FUNCTION ${table || "<table>"}_${column || "<column>"}_dualwrite()
RETURNS trigger AS $$
BEGIN
    NEW.${column || "<column>"}_new := NEW.${column || "<column>"}::<new_type>;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ${table || "<table>"}_${column || "<column>"}_dualwrite
    BEFORE INSERT OR UPDATE ON ${table || "<table>"}
    FOR EACH ROW EXECUTE FUNCTION ${table || "<table>"}_${column || "<column>"}_dualwrite();`,
        },
        {
          phase: "Migrate",
          explain:
            "Backfill the new column from the old column in batches, from a background job.",
          sql: `-- Background job, not this migration:
UPDATE ${table || "<table>"}
    SET ${column || "<column>"}_new = ${column || "<column>"}::<new_type>
    WHERE ${column || "<column>"}_new IS NULL;`,
        },
        {
          phase: "Contract",
          explain:
            "After the application has been updated to read from the new column, drop the old column and rename.",
          sql: `DROP TRIGGER ${table || "<table>"}_${column || "<column>"}_dualwrite ON ${table || "<table>"};
DROP FUNCTION ${table || "<table>"}_${column || "<column>"}_dualwrite;

ALTER TABLE ${table || "<table>"}
    DROP COLUMN ${column || "<column>"};

ALTER TABLE ${table || "<table>"}
    RENAME COLUMN ${column || "<column>"}_new TO ${column || "<column>"};`,
        },
      ],
    }),
  },
  {
    id: "UN-003",
    severity: "critical",
    title: "DROP TABLE",
    description:
      "Dropping a table makes data unrecoverable without a restore. Any application reference to the table — including legacy jobs, reporting queries, or analytics pipelines — will fail.",
    source: "squawk; strong_migrations",
    regex: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\w".,\s]+/i,
    rewrite: (match, table) => ({
      phases: [
        {
          phase: "Expand",
          explain:
            "First remove all application references. Add a REVOKE to block accidental reads during the deprecation window. Leave the table in place for at least one release cycle.",
          sql: `REVOKE ALL ON ${table || "<table>"} FROM <app_role>;`,
        },
        {
          phase: "Contract",
          explain:
            "After the deprecation window has passed and no alerts have fired, drop the table in a follow-up migration. Back up first.",
          sql: `-- Only after a deprecation window:
DROP TABLE ${table || "<table>"};`,
        },
      ],
    }),
  },

  /* ---------------------------- REPLICATION ----------------------------- */
  {
    id: "RP-001",
    severity: "critical",
    title: "RENAME COLUMN or RENAME TABLE",
    description:
      "A rename is instant for the database but is observed as a breaking change by every application instance that has not yet been redeployed. During a rolling deploy, some instances will still issue queries against the old name.",
    source: "strong_migrations: renaming-a-column",
    regex:
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\w".]+\s+RENAME\s+(?:COLUMN\s+)?[\w".]+\s+TO\s+/i,
    rewrite: (match, table, oldName, newName) => ({
      phases: [
        {
          phase: "Expand",
          explain:
            "Add the new column. Dual-write to both via trigger. Do not rename.",
          sql: `ALTER TABLE ${table || "<table>"}
    ADD COLUMN ${newName || "<new_name>"} <type>;

-- Dual-write trigger (see UN-002 for the pattern).`,
        },
        {
          phase: "Migrate",
          explain:
            "Backfill from a background job. Update the application to read from the new name. Deploy.",
          sql: `-- Background job, not this migration:
UPDATE ${table || "<table>"}
    SET ${newName || "<new_name>"} = ${oldName || "<old_name>"}
    WHERE ${newName || "<new_name>"} IS NULL;`,
        },
        {
          phase: "Contract",
          explain:
            "After the application is fully rolled forward, drop the old column in a follow-up migration.",
          sql: `ALTER TABLE ${table || "<table>"}
    DROP COLUMN ${oldName || "<old_name>"};`,
        },
      ],
    }),
  },
  {
    id: "RP-002",
    severity: "critical",
    title: "Primary-key change",
    description:
      "Changing a primary key rewrites the clustered index and may cascade into every foreign-key that references it. Logical replication downstream is likely to break.",
    source: "squawk: ban-drop-primary-key",
    regex:
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\w".]+\s+(?:DROP\s+CONSTRAINT\s+[\w"]+\s*(?:,|;|$)|ADD\s+PRIMARY\s+KEY|DROP\s+PRIMARY\s+KEY)/i,
    // No automatic rewrite. Flag for manual review.
  },

  /* ------------------------------- PERF --------------------------------- */
  {
    id: "PF-001",
    severity: "high",
    title: "Large UPDATE or DELETE inside the migration",
    description:
      "Running a bulk UPDATE or DELETE inside a migration serialises against every concurrent writer and holds a long transaction open. This is the single most common cause of a migration timing out in production.",
    source: "strong_migrations: executing-queries-in-migrations",
    regex: /^\s*(UPDATE|DELETE\s+FROM)\s+[\w".]+/i,
    rewrite: () => ({
      phases: [
        {
          phase: "Migrate",
          explain:
            "Move the DML out of the migration and into a batched background job. The migration should contain schema changes only.",
          sql: `-- Background job skeleton (pseudocode):
-- while rows remain:
--     UPDATE <table> SET <col> = <value>
--         WHERE id IN (
--             SELECT id FROM <table>
--             WHERE <predicate>
--             ORDER BY id LIMIT 1000
--             FOR UPDATE SKIP LOCKED
--         );
--     COMMIT;
--     sleep(0.1);`,
        },
      ],
    }),
  },
  {
    id: "PF-002",
    severity: "medium",
    title: "ALTER TYPE … ADD VALUE inside a transaction",
    description:
      "Postgres does not allow new enum values to be used in the same transaction that adds them. If your migration runner wraps statements in a transaction, the migration will error at commit.",
    source: "squawk: adding-enum-value-inside-transaction",
    regex: /ALTER\s+TYPE\s+[\w".]+\s+ADD\s+VALUE\s+/i,
    rewrite: (match) => ({
      phases: [
        {
          phase: "Migrate",
          explain:
            "Ship the ALTER TYPE on its own, outside a transaction block. In Alembic: `with op.get_context().autocommit_block(): op.execute(...)`. In Flyway: use a separate migration file with transactional=false.",
          sql: match.trim() + ";",
        },
      ],
    }),
  },

  /* ----------------------------- RECOVERY ------------------------------- */
  {
    id: "RC-001",
    severity: "medium",
    title: "DROP INDEX on a foreign-key column",
    description:
      "Dropping an index that supports a foreign-key lookup or a cascading delete can silently turn an indexed lookup into a sequential scan. Verify no foreign-key depends on the index before proceeding.",
    source: "SchemaShift heuristic",
    regex: /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?[\w".]+/i,
    // No automatic rewrite. Flag for manual review.
  },

  /* ----------- Secondary parsing-level patterns (low / medium) ---------- */
  {
    id: "BL-006",
    severity: "medium",
    title: "Missing CONCURRENTLY on DROP INDEX",
    description:
      "DROP INDEX takes an ACCESS EXCLUSIVE lock on the parent table for the duration. On a hot table, even a quick drop can queue up reads and writes.",
    source: "strong_migrations",
    regex: /DROP\s+INDEX\s+(?!CONCURRENTLY\b)(?:IF\s+EXISTS\s+)?[\w".]+/i,
    rewrite: (match) => ({
      phases: [
        {
          phase: "Migrate",
          explain:
            "Use DROP INDEX CONCURRENTLY. It cannot run inside a transaction.",
          sql: match.replace(/DROP\s+INDEX/i, "DROP INDEX CONCURRENTLY") + ";",
        },
      ],
    }),
  },
];

/* -------------------------- Statement splitting -------------------------- */
/*
 * A deliberately simple SQL splitter. It is not a full parser — a full
 * parser is out of scope for a client-side review — but it handles the
 * realistic cases: -- line comments, block comments, single-quoted
 * strings, dollar-quoted bodies ($body$ ... $body$, $$ ... $$), and
 * semicolon terminators. Statements retain their original offsets into the
 * source text so the highlight layer can mark ranges accurately.
 */
function splitStatements(src) {
  const statements = [];
  const n = src.length;
  let i = 0;
  let stmtStart = 0;
  let stmtBuf = "";

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    // Line comment
    if (ch === "-" && next === "-") {
      while (i < n && src[i] !== "\n") {
        stmtBuf += src[i];
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      stmtBuf += src[i] + src[i + 1];
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        stmtBuf += src[i];
        i++;
      }
      if (i < n) {
        stmtBuf += src[i] + src[i + 1];
        i += 2;
      }
      continue;
    }
    // Single-quoted string
    if (ch === "'") {
      stmtBuf += ch;
      i++;
      while (i < n) {
        stmtBuf += src[i];
        if (src[i] === "'" && src[i + 1] === "'") {
          stmtBuf += src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Dollar-quoted block: $tag$ … $tag$
    if (ch === "$") {
      const tagMatch = src.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        stmtBuf += tag;
        i += tag.length;
        const endIdx = src.indexOf(tag, i);
        if (endIdx === -1) {
          stmtBuf += src.slice(i);
          i = n;
          continue;
        }
        stmtBuf += src.slice(i, endIdx + tag.length);
        i = endIdx + tag.length;
        continue;
      }
    }
    // Semicolon — statement terminator at top level
    if (ch === ";") {
      stmtBuf += ch;
      const raw = stmtBuf;
      statements.push({
        raw,
        start: stmtStart,
        end: i + 1,
      });
      i++;
      stmtStart = i;
      stmtBuf = "";
      continue;
    }
    stmtBuf += ch;
    i++;
  }
  // Trailing statement without a semicolon
  if (stmtBuf.trim().length > 0) {
    statements.push({ raw: stmtBuf, start: stmtStart, end: n });
  }
  return statements;
}

/* Strip comments for rule matching, but preserve character positions by
 * replacing them with spaces so the regex match offsets still line up. */
function stripCommentsPreserveLength(s) {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === "-" && s[i + 1] === "-") {
      while (i < n && s[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "*") {
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) {
        out += s[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    if (s[i] === "'") {
      out += s[i];
      i++;
      while (i < n) {
        out += s[i];
        if (s[i] === "'" && s[i + 1] === "'") {
          out += s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

/* ---------------------- Extract table / column hints --------------------- */
/* These run *after* a rule has matched, to fill in placeholders in the
 * rewrite template. They are best-effort: if a name is not recoverable the
 * rewrite SQL uses angle-bracket placeholders. */
function extractNames(stmt) {
  const clean = stripCommentsPreserveLength(stmt);
  const hints = { table: null, column: null, oldName: null, newName: null };

  const alter = clean.match(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w".]+)/i
  );
  if (alter) hints.table = alter[1];

  const drop = clean.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w".]+)/i);
  if (drop) hints.table = drop[1];

  const setNotNull = clean.match(
    /ALTER(?:\s+COLUMN)?\s+([\w".]+)\s+SET\s+NOT\s+NULL/i
  );
  if (setNotNull) hints.column = setNotNull[1];

  const addCol = clean.match(
    /ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\w".]+)/i
  );
  if (addCol && !hints.column) hints.column = addCol[1];

  const dropCol = clean.match(
    /DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?([\w".]+)/i
  );
  if (dropCol && !hints.column) hints.column = dropCol[1];

  const alterType = clean.match(
    /ALTER(?:\s+COLUMN)?\s+([\w".]+)\s+(?:SET\s+DATA\s+)?TYPE/i
  );
  if (alterType) hints.column = alterType[1];

  const rename = clean.match(
    /RENAME\s+(?:COLUMN\s+)?([\w".]+)\s+TO\s+([\w".]+)/i
  );
  if (rename) {
    hints.oldName = rename[1];
    hints.newName = rename[2];
  }

  return hints;
}

/* ---------------------------- Analyser core ------------------------------ */
function analyse(src) {
  const statements = splitStatements(src);
  const findings = [];
  let nextFindingId = 1;

  statements.forEach((stmt, stmtIdx) => {
    const clean = stripCommentsPreserveLength(stmt.raw);
    RULES.forEach((rule) => {
      const match = clean.match(rule.regex);
      if (!match) return;

      const localStart = match.index;
      const localEnd = match.index + match[0].length;
      const absStart = stmt.start + localStart;
      const absEnd = stmt.start + localEnd;
      const line = countLines(src, absStart);

      const hints = extractNames(stmt.raw);
      const finding = {
        id: `f${nextFindingId++}`,
        ruleId: rule.id,
        severity: rule.severity,
        title: rule.title,
        description: rule.description,
        source: rule.source,
        statement: stmt.raw.trim(),
        statementIndex: stmtIdx + 1,
        absStart,
        absEnd,
        line,
      };
      if (rule.rewrite) {
        finding.rewrite = rule.rewrite(
          match[0],
          hints.table,
          hints.column,
          hints.oldName,
          hints.newName
        );
      }
      findings.push(finding);
    });
  });

  // Deduplicate: if a statement is flagged by both DROP INDEX (RC-001) and
  // non-concurrent DROP INDEX (BL-006), the BL-006 rewrite is the one the
  // reviewer wants, but we still want to keep both findings because they
  // surface different concerns. The findings list sorts by severity order,
  // descending, so the user sees the highest-severity finding first.
  findings.sort((a, b) => {
    const sa = SEVERITY[a.severity].order;
    const sb = SEVERITY[b.severity].order;
    if (sa !== sb) return sb - sa;
    return a.absStart - b.absStart;
  });

  return { statements, findings };
}

function countLines(src, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src[i] === "\n") n++;
  return n;
}

/* ---------------------------- Scoring / grading -------------------------- */
function scoreFindings(findings) {
  const penalty = findings.reduce(
    (acc, f) => acc + SEVERITY[f.severity].weight,
    0
  );
  const score = Math.max(0, 100 - penalty);
  const grade = gradeFor(score, findings);
  return { score, grade, penalty };
}

function gradeFor(score, findings) {
  const hasCritical = findings.some((f) => f.severity === "critical");
  // A single critical finding caps the grade at D. This matches the report
  // appendix: a critical-severity operation is defined as one that will
  // prevent the migration from deploying safely.
  if (hasCritical && score > 55) return "D";
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

const GRADE_META = {
  A: {
    word: "Safe to ship",
    title: "This migration is safe by static analysis",
    summary:
      "No blocking patterns detected. Review any medium-severity findings below, but this migration can proceed to the normal release process.",
    glyph: "M6 12l4 4 8-8",
  },
  B: {
    word: "Minor concerns",
    title: "A few medium-severity issues to review",
    summary:
      "The migration does not contain known blocking operations, but one or more findings warrant a reviewer's attention before merge.",
    glyph: "M6 12l4 4 8-8",
  },
  C: {
    word: "Review required",
    title: "Several concerns — do not merge without review",
    summary:
      "Multiple findings detected. At least one is likely to cause user-visible degradation during deploy. Address the rewrite plan below.",
    glyph: "M12 8v5M12 16v.5",
  },
  D: {
    word: "Unsafe",
    title: "Unsafe for direct deploy",
    summary:
      "This migration contains patterns that will cause a production incident on a populated table. Split into expand–migrate–contract phases before merging.",
    glyph: "M12 8v5M12 16v.5",
  },
  F: {
    word: "Block",
    title: "Blocking — rewrite required",
    summary:
      "Critical operations detected. These cannot be rolled out safely. Rewrite using the plan below and re-run the analyser.",
    glyph: "M8 8l8 8M16 8l-8 8",
  },
};

/* --------------------------- Rendering helpers --------------------------- */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function announce(message) {
  // Reuse the polite status live region for all announcements.
  el.status.textContent = "";
  // Force a fresh DOM mutation so screen readers re-announce identical text.
  requestAnimationFrame(() => {
    el.status.textContent = message;
  });
}

function resetUi() {
  el.resultsSection.hidden = true;
  el.findingsSection.hidden = true;
  el.rewritesSection.hidden = true;
  el.codeSection.hidden = true;
  el.findingsList.innerHTML = "";
  el.findingsEmpty.hidden = true;
  el.rewrites.innerHTML = "";
  el.codeDisplay.innerHTML = "";
  el.error.hidden = true;
  el.error.textContent = "";
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

function renderScore(score, grade, findings) {
  const meta = GRADE_META[grade];
  el.scoreNumber.textContent = String(score);
  el.scoreTitle.textContent = meta.title;
  el.scoreSummary.textContent = meta.summary;
  el.gradeBadge.dataset.grade = grade.toLowerCase();
  el.gradeLetter.textContent = grade;
  el.gradeWord.textContent = meta.word;
  el.gradeGlyph.setAttribute("d", meta.glyph);

  // Animated ring fill — respect prefers-reduced-motion
  const offset = RING_CIRCUMFERENCE * (1 - score / 100);
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    .matches;
  if (reduceMotion) {
    el.ringFg.style.transition = "none";
  } else {
    el.ringFg.style.transition = "stroke-dashoffset 520ms ease-out";
  }
  // Force a reflow so the transition registers when called twice in quick
  // succession (e.g., user clicks Analyse, then immediately Analyses again).
  void el.ringFg.getBoundingClientRect();
  el.ringFg.style.strokeDashoffset = String(offset);

  // Screen-reader summary, more detailed than the visual label.
  const sevCounts = countBySeverity(findings);
  const breakdown = Object.entries(sevCounts)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${SEVERITY[sev].label.toLowerCase()}`)
    .join(", ");
  const srMsg = breakdown
    ? `Grade ${grade}, score ${score} out of 100. ${meta.title}. ${findings.length} finding${
        findings.length === 1 ? "" : "s"
      } — ${breakdown}.`
    : `Grade ${grade}, score ${score} out of 100. ${meta.title}. No findings.`;
  el.scoreSr.textContent = srMsg;
}

function countBySeverity(findings) {
  const counts = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  return counts;
}

function renderFindings(findings) {
  el.findingsList.innerHTML = "";
  if (findings.length === 0) {
    el.findingsEmpty.hidden = false;
    return;
  }
  el.findingsEmpty.hidden = true;
  for (const f of findings) {
    const li = document.createElement("li");
    li.className = "finding";
    li.id = f.id;
    li.dataset.severity = f.severity;

    li.innerHTML = `
      <div class="finding__head">
        <h3 class="finding__title">${escapeHtml(f.title)}</h3>
        <span class="severity-tag" data-severity="${f.severity}">${
      SEVERITY[f.severity].label
    }</span>
        <span class="finding__rule"><code>${escapeHtml(f.ruleId)}</code></span>
      </div>
      <p class="finding__desc">${escapeHtml(f.description)}</p>
      <ul class="finding__locations">
        <li>Statement ${f.statementIndex}, line ${f.line}. Source: ${escapeHtml(
      f.source
    )}.</li>
      </ul>
    `;
    el.findingsList.appendChild(li);
  }
}

function renderRewrites(findings) {
  el.rewrites.innerHTML = "";
  const withRewrites = findings.filter((f) => f.rewrite);
  if (withRewrites.length === 0) {
    el.rewritesSection.hidden = true;
    return;
  }
  el.rewritesSection.hidden = false;

  for (const f of withRewrites) {
    for (const phase of f.rewrite.phases) {
      const details = document.createElement("details");
      details.className = "rewrite";
      details.open = phase.phase === "Expand";
      const summaryText = `${f.ruleId} · ${f.title}`;
      details.innerHTML = `
        <summary>
          <span class="rewrite__phase">${escapeHtml(phase.phase)}</span>
          <span>${escapeHtml(summaryText)}</span>
        </summary>
        <div class="rewrite__body">
          <p class="rewrite__explain">${escapeHtml(phase.explain)}</p>
          <pre class="rewrite__sql"><code>${escapeHtml(phase.sql)}</code></pre>
          <div class="rewrite__actions">
            <button type="button" class="button button--ghost button--copy">
              Copy ${escapeHtml(phase.phase)} phase SQL
            </button>
          </div>
        </div>
      `;
      const btn = details.querySelector(".button--copy");
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(phase.sql);
          announce(`Copied ${phase.phase} phase SQL to clipboard.`);
        } catch {
          announce(
            `Copy blocked by the browser. Select the ${phase.phase} phase SQL manually.`
          );
        }
      });
      el.rewrites.appendChild(details);
    }
  }
}

function renderCode(src, findings) {
  el.codeDisplay.innerHTML = "";
  if (!src.trim()) return;
  const nodes = buildHighlightedSource(src, findings);
  for (const node of nodes) el.codeDisplay.appendChild(node);
  el.codeSection.hidden = false;
}

/* Builds an array of text and <a class="flag"> nodes, splicing flags in at
 * each finding's absolute range. Overlapping ranges are merged to the
 * highest severity at that position. */
function buildHighlightedSource(src, findings) {
  const bounds = [];
  for (const f of findings) {
    bounds.push({ type: "open", pos: f.absStart, finding: f });
    bounds.push({ type: "close", pos: f.absEnd, finding: f });
  }
  bounds.sort((a, b) => a.pos - b.pos || (a.type === "close" ? -1 : 1));

  const nodes = [];
  let cursor = 0;
  const open = []; // stack of currently open findings

  function flushTextTo(pos) {
    if (pos <= cursor) return;
    const text = src.slice(cursor, pos);
    if (open.length === 0) {
      nodes.push(document.createTextNode(text));
    } else {
      // Pick the highest-severity open finding for this slice
      const top = open.reduce((hi, cur) =>
        SEVERITY[cur.severity].order > SEVERITY[hi.severity].order ? cur : hi
      );
      const a = document.createElement("a");
      a.className = "flag";
      a.dataset.severity = top.severity;
      a.href = `#${top.id}`;
      a.setAttribute(
        "aria-label",
        `${SEVERITY[top.severity].label} finding — ${top.title}. Jump to finding ${top.ruleId}.`
      );
      a.textContent = text;
      nodes.push(a);
    }
    cursor = pos;
  }

  for (const b of bounds) {
    flushTextTo(b.pos);
    if (b.type === "open") open.push(b.finding);
    else {
      const idx = open.indexOf(b.finding);
      if (idx !== -1) open.splice(idx, 1);
    }
  }
  flushTextTo(src.length);
  return nodes;
}

/* ------------------------------ Event wiring ----------------------------- */
function runAnalyse() {
  resetUi();
  const src = el.sqlInput.value;
  if (!src.trim()) {
    showError("Paste a SQL migration first, or load a .sql file.");
    announce("No SQL provided.");
    el.sqlInput.focus();
    return;
  }

  let result;
  try {
    result = analyse(src);
  } catch (err) {
    console.error(err);
    showError(
      "Could not parse the SQL. Confirm it is Postgres-dialect and try again."
    );
    announce("Analysis failed.");
    return;
  }

  const { findings } = result;
  const { score, grade } = scoreFindings(findings);

  el.resultsSection.hidden = false;
  el.findingsSection.hidden = false;
  renderScore(score, grade, findings);
  renderFindings(findings);
  renderRewrites(findings);
  renderCode(src, findings);

  el.resetBtn.hidden = false;
  el.analyseBtn.textContent = "Re-analyse";

  const sevCounts = countBySeverity(findings);
  const parts = Object.entries(sevCounts)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${SEVERITY[sev].label.toLowerCase()}`);
  const summary = parts.length
    ? `Grade ${grade}. ${findings.length} finding${
        findings.length === 1 ? "" : "s"
      } — ${parts.join(", ")}.`
    : `Grade ${grade}. No findings.`;
  announce(summary);

  // Move focus to the results heading so screen-reader users pick up from
  // the same place a sighted user scrolls to.
  requestAnimationFrame(() => {
    el.resultsH.focus();
    el.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function runReset() {
  el.sqlInput.value = "";
  resetUi();
  el.resetBtn.hidden = true;
  el.analyseBtn.textContent = "Analyse migration";
  el.sqlInput.focus();
  announce("Input cleared.");
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    showError("That file is larger than 5 MB. Paste a smaller migration.");
    return;
  }
  try {
    const text = await file.text();
    el.sqlInput.value = text;
    announce(`Loaded ${file.name}.`);
  } catch {
    showError("Could not read that file.");
  }
}

/* ------------------------- Theme toggle (dark mode) ---------------------- */
function initTheme() {
  const saved = localStorage.getItem("schemashift-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = saved ? saved === "dark" : prefersDark;
  applyTheme(isDark);
  el.themeToggle.addEventListener("click", () => {
    const nowDark = document.documentElement.dataset.theme !== "dark";
    applyTheme(nowDark);
    localStorage.setItem("schemashift-theme", nowDark ? "dark" : "light");
  });
}

function applyTheme(isDark) {
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  el.themeToggle.setAttribute("aria-pressed", isDark ? "true" : "false");
  el.themeToggle.setAttribute(
    "aria-label",
    isDark ? "Switch to light mode" : "Switch to dark mode"
  );
}

/* ------------------------------ Bootstrap -------------------------------- */
function init() {
  el.analyseBtn.addEventListener("click", runAnalyse);
  el.resetBtn.addEventListener("click", runReset);
  el.sqlFile.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    loadFile(file);
    // Reset so the same file can be re-picked.
    e.target.value = "";
  });
  el.sqlInput.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+Enter runs analysis from the textarea
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runAnalyse();
    }
  });
  initTheme();
}

document.addEventListener("DOMContentLoaded", init);
