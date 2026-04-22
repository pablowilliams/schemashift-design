# SchemaShift: A Machine-Learning-Assisted Database Migration Safety Reviewer

## Abstract

Database schema migrations are among the highest-risk operations a production system performs. A migration that runs cleanly in staging can lock a billion-row table for minutes in production, break a read replica, or silently truncate data. Existing tooling for reviewing migrations falls into two camps: deterministic linters such as `squawk` and `strong_migrations`, which produce high-precision warnings but have no view of the application code that depends on the schema; and code-review-by-human, which has full context but is slow, inconsistent, and scales poorly. **SchemaShift** is a specification for a system that sits between the two. It combines a rule-based DDL analyser with a runtime-aware context gatherer, an application-code call-site scanner, and a language-model reasoner that is always constrained by a deterministic verifier. The output of every run is a graded risk report and an interactive dashboard that a reviewer can approve, reject, or hand back for revision. This report presents the full design: motivation, a survey of the prior art, a seven-stage pipeline, component specifications, a dashboard sketch, an evaluation methodology grounded in publicly available rule catalogues, a four-week implementation roadmap, and a risk analysis. The goal of the specification is to produce a design that can be built by a small team in a bounded timeframe with no unresolved open questions.

## 1. Introduction

### 1.1 Problem statement

A schema migration is a structured change to the tables, columns, indexes, constraints, and views that define an application's relational backbone. Migrations are written as DDL scripts — native SQL or a framework's higher-level abstraction (Alembic, Django migrations, Liquibase, Flyway, Prisma Migrate, Ecto) — and are typically run as part of a deployment. In aggregate, migrations are a small fraction of the code in a repository, but they carry a disproportionate share of the operational risk, because the cost of a mistake is often not detected until the migration is already running against production data.

Three categories of failure recur. The first is **blocking locks**: a seemingly innocuous `ALTER TABLE` acquires an exclusive lock for longer than the application's request timeout, and user traffic begins to fail. The second is **data loss**: a column is dropped, narrowed, or renamed, and one of the application's writers — perhaps an auxiliary service the author did not know about — still references it, or the new type cannot represent values that the old type could. The third is **replication breakage**: a logical replica, a search index, or a change-data-capture consumer is not tolerant of the shape change, and the migration succeeds on the primary while quietly breaking everything downstream.

Organisations protect themselves against these failures with review processes, but reviewers typically have less context than the migration author. A reviewer is unlikely to remember the row count of every table, the indexes on every foreign-key column, or which microservices read the column being dropped. The result is that migration review is at best a consistency check and at worst a rubber stamp.

### 1.2 Motivation

Two classes of tool already exist. **Deterministic DDL linters** such as `squawk` (Postgres), `strong_migrations` (Rails), and the `--safe` modes of some ORMs read a migration and emit a fixed set of warnings. They are fast, high-precision, and easy to integrate into continuous integration, but they know nothing about the application code that depends on the schema, nothing about the table's current size, and nothing about the replicas that must tolerate the change. **Online schema change tools** such as `pt-online-schema-change` (Percona Toolkit), `gh-ost` (GitHub), and `pg_repack` rewrite tables without holding long-lived locks, but they are execution engines; they presume the decision to run the migration has already been made.

The gap between these two classes is where most migration incidents live. The lint knows "`ALTER TABLE ... SET NOT NULL` is slow on a large table", but it cannot tell the reviewer whether this particular table has a hundred rows or a hundred million. It knows a column rename breaks logical replication, but it cannot tell the reviewer whether this schema actually has a replica. It cannot read the Django or SQLAlchemy models that still reference the old column name and will fail on the first request after the migration lands.

The central claim of this specification is that a hybrid pipeline — deterministic checks first, context enrichment second, language-model reasoning third, deterministic verification last — can close this gap while keeping the output trustworthy. The architecture inherits the discipline of the static linter: nothing is shipped that cannot be justified by a cited rule or a verified rewrite. The language model is not in the trust boundary. It is a re-ranking and explanation layer whose outputs are validated before they reach the user.

### 1.3 Research questions

The design is motivated by four questions:

1. Given a migration file and a current schema, can a deterministic analyser achieve recall comparable to `squawk` and `strong_migrations` on their own rule catalogues, while extending coverage to ORM-specific idioms?
2. Given table metadata (row counts, index sizes, replication topology), can the risk grade be adjusted in a way that meaningfully improves reviewer triage, rather than simply adding noise?
3. Given application code (ORM models, raw SQL query sites), can a call-site scanner reliably surface the places that reference a changed column or table, in a way that cuts blast-radius estimation time for a human reviewer?
4. Given a language model constrained by a deterministic verifier, can we produce safer rewrites (`ALTER TABLE` split into expand-migrate-contract phases, `CREATE INDEX` rewritten as `CREATE INDEX CONCURRENTLY`, `ADD FOREIGN KEY` split into `NOT VALID` + `VALIDATE`) that pass a schema-equivalence test?

### 1.4 Scope

SchemaShift targets Postgres first, with MySQL as a stretch goal. The choice is pragmatic: `pglast` and `libpg_query` (the C parser extracted from the Postgres source) give a near-ground-truth SQL parser for Postgres, and `squawk` — the most mature open-source migration linter — is Postgres-specific. MySQL coverage is a planned extension using the MySQL workbench grammar and `gh-ost`'s rule catalogue; the architecture is identical but the rule catalogue and online-DDL engine differ.

The system is not a replacement for a database administrator. It does not tune queries, rewrite indexes for existing tables, or make capacity-planning decisions. It reviews a proposed schema change and grades its risk. The scope is narrow on purpose.

## 2. Background and Related Work

### 2.1 Deterministic DDL linting

`squawk` (https://squawkhq.com, MIT-licensed) is a Postgres migration linter written in Rust by Steve Dignam. It ships with roughly twenty rules covering the most common migration hazards: adding `NOT NULL` without a default, adding a new unique index without `CONCURRENTLY`, dropping or renaming columns, changing column types in place, and using `SERIAL` or `ENUM` types that are hard to evolve. `squawk` parses migrations using the Postgres grammar via `libpg_query` and emits GitHub-annotation-compatible output for CI.

`strong_migrations` (https://github.com/ankane/strong_migrations, MIT-licensed) is a Rails gem by Andrew Kane that checks Rails migrations before they are executed. It raises errors rather than warnings by default and refuses to run migrations that match a catalogue of unsafe patterns, with an explicit escape hatch requiring a comment to acknowledge the risk. Its rule set overlaps heavily with `squawk` but is written for Rails's migration DSL rather than raw DDL.

Other entries in this space include `pgroll` (Xata), `pgzx`, `schemasl`, and the `--safe` / `--check` modes built into Django, Alembic, and Prisma Migrate. Their commonalities: all are local to the migration file, all emit warnings without consulting the application, and all assume that a human reviewer will resolve the warnings they cannot.

### 2.2 Online schema change

Once a migration has been deemed risky, an online schema-change tool can reduce the window during which the table is locked. `gh-ost` (https://github.com/github/gh-ost, MIT-licensed) is GitHub's MySQL online migrator; it creates a shadow table, streams changes via the binlog, and swaps at the end. `pt-online-schema-change` (Percona Toolkit) performs the same role using triggers. `pg_repack` (https://github.com/reorg/pg_repack, BSD-licensed) provides online CLUSTER and VACUUM FULL for Postgres; `pgroll` (Xata, Apache-licensed) goes further and adds expand-migrate-contract orchestration. These tools are complementary to SchemaShift: SchemaShift decides whether a migration is risky and what shape a safe rewrite would take; `pg_repack` or `pgroll` execute the rewrite.

### 2.3 SQL parsing libraries

Accurate parsing is a prerequisite for accurate analysis. Three libraries dominate the Python ecosystem:

- `sqlglot` (https://github.com/tobymao/sqlglot, MIT-licensed), a dialect-aware SQL parser and transpiler written in pure Python. It supports dialect-specific rewrites (Postgres, MySQL, SQLite, BigQuery, Snowflake, and more) and exposes a mutable AST.
- `sqlparse` (https://github.com/andialbrecht/sqlparse, BSD-licensed), a simpler tokeniser and pretty-printer. It is forgiving but produces a less precise tree and does not validate dialect semantics.
- `pglast` (https://github.com/lelit/pglast, GPL-licensed), a Python binding to `libpg_query`, the parser extracted from the Postgres source tree. It is ground-truth for Postgres DDL but pulls in a C dependency.

SchemaShift will use `pglast` for Postgres parsing where possible (for its precision) and fall back to `sqlglot` for MySQL and for dialect-agnostic rewrites.

### 2.4 ML for code

Large language models are increasingly applied to code review tasks, with broadly two patterns. In the first, the model is a direct oracle: its output is the recommendation. This works for low-stakes tasks (style, naming) but fails badly on anything where a hallucinated recommendation can cause damage. In the second, the model is a re-ranker and explainer: deterministic tools surface candidate issues, and the model provides natural-language rationale and prioritisation, with every suggestion validated before it is shown to the user.

SchemaShift adopts the second pattern, adapting the architecture used by PyOptimize, a prior specification in this series. The language model never proposes a migration rewrite that is not schema-equivalent to the original; every rewrite is re-parsed, diffed against the input, and dry-run against a cloned schema before it reaches the dashboard.

### 2.5 The gap this system targets

The gap between DDL linters and online schema-change tools is well understood by practitioners, but no open-source system known to the authors sits cleanly in the middle. The closest is `pgroll`, which runs expand-migrate-contract migrations but does not ingest existing migration files or analyse application code. SchemaShift's contribution is not any individual component — each of the seven stages has a precedent somewhere — but the integrated pipeline, with a deterministic verifier guarding every output.

## 3. System Architecture

### 3.1 Design principles

Four principles govern every design choice in the specification.

**Deterministic before probabilistic.** Every pattern that can be detected with a rule is detected with a rule. The language model is never the first line of defence; it is never the only line of defence.

**Verifier is non-negotiable.** No rewrite reaches the dashboard unless it parses, re-plans to a schema that is equivalent to the author's intent under a defined equivalence relation, and runs cleanly in a sandbox.

**Context is earned, not assumed.** SchemaShift runs with whatever metadata it is given. With a `pg_dump --schema-only` and table sizes, it produces a full review. With only the migration file, it falls back to the rule catalogue and flags the absence of context explicitly.

**Accessibility-first UI.** The dashboard targets WCAG 2.2 AA for the reviewer and meets it without mouse input, without colour-only signalling, and without reliance on hover states.

### 3.2 Pipeline overview

The pipeline is a seven-stage pipeline in the same shape as PyOptimize:

[FIGURE:pipeline]

1. **Ingestion.** Accept migration files (SQL, Alembic, Django, Liquibase, Prisma), the current schema (`pg_dump --schema-only` or equivalent), and an optional metadata bundle (table sizes, index sizes, replication topology, pg_stat_statements excerpts).
2. **Static analyser.** Parse each migration with `pglast` or `sqlglot`, flatten into a list of DDL operations, and apply a rule catalogue adapted from `squawk` and `strong_migrations`.
3. **Context gatherer.** Read the metadata bundle. Attach to each flagged operation the size and index profile of its target table, and the replication topology touching it.
4. **Call-site scanner.** Walk the application repository. Collect references to the changed column or table from ORM models (SQLAlchemy, Django, Peewee, Pony, SQLModel), from raw-SQL query sites, and from fixtures, seed scripts, and integration tests.
5. **Signal fusion.** Combine rule severity, table size, call-site count, and replication topology into a risk score per operation and a grade per migration.
6. **LLM reasoner + rewrite engine.** Present the fused signals to a language model and ask for (a) a natural-language blast-radius explanation and (b) a safer rewrite expressed as an expand-migrate-contract phase plan.
7. **Verifier.** Re-parse the rewrite, dry-run it against a cloned schema, and assert the end-state is equivalent to the input under the defined relation. Any rewrite that fails is discarded; only the deterministic analysis reaches the dashboard.

Stage 7 then feeds the reporting layer, which emits both an academic-style PDF review and an interactive dashboard.

### 3.3 Data flow

[FIGURE:data_model]

Every artefact that crosses a stage boundary is typed. The core data contracts are:

- `MigrationInput` — the raw file, its detected framework, and a pointer to the current schema.
- `DDLOperation` — a single normalised operation (e.g. `AddColumn`, `DropColumn`, `CreateIndex`, `AddForeignKey`), its parsed AST, and the original span.
- `RuleHit` — a rule id, severity, operation reference, and a short rationale string.
- `ContextBundle` — the table size, index profile, replication topology, and pg_stat_statements excerpt for an operation's target.
- `CallSite` — a file path, line number, language, and the name of the symbol that references the changed column or table.
- `FusedSignal` — the combination of rule hits, context, and call-sites for a single operation, with a computed risk score.
- `Rewrite` — a sequence of DDL operations proposed as a safer replacement, with a proof that it reaches the same end-state under the equivalence relation.
- `Report` — the final artefact: grade, per-migration summary, per-operation findings, and the approved rewrites.

Every contract is expressed as a Pydantic model in the reference implementation. No stage is permitted to produce output that does not validate against the downstream contract.

## 4. Component Specifications

### 4.1 Ingestion

The ingestion stage normalises a migration into a list of DDL operations regardless of source. Framework-specific translators produce raw SQL for parsing:

- **Alembic.** `alembic upgrade --sql` emits the raw SQL equivalent of an Alembic script. SchemaShift drives Alembic in a subprocess.
- **Django.** `manage.py sqlmigrate` emits the SQL for a single migration name.
- **Liquibase.** `liquibase updateSQL` writes the DDL that would be applied.
- **Prisma Migrate.** `prisma migrate diff --script` emits the SQL diff between two schema states.
- **Raw SQL.** Read as-is.

Any framework not listed falls back to raw-SQL mode. The ingestion stage fails loudly if it cannot produce a SQL artefact; it never silently skips.

### 4.2 Static analyser

The analyser walks the parsed AST and emits `RuleHit`s. The initial rule catalogue groups rules by risk class:

- **BLOCKING** — operations that hold long-running locks (`ALTER TABLE ... SET NOT NULL` without default on a populated table, `ALTER TABLE ... ADD FOREIGN KEY` without `NOT VALID`, `CREATE INDEX` without `CONCURRENTLY`).
- **UNSAFE** — operations that lose or narrow data (`DROP COLUMN`, `ALTER COLUMN TYPE` narrowing, `DROP TABLE`).
- **REPLICATION** — operations that break logical decoding consumers (`RENAME COLUMN`, `RENAME TABLE`, changing primary-key definitions).
- **PERF** — operations that are slow at scale (`VACUUM FULL`, `CLUSTER`, large `UPDATE` inside the migration).
- **RECOVERY** — operations that are hard to reverse without a backup (`DROP INDEX` on a FK column, dropping a unique constraint that the application now relies on).

A pattern catalogue in Appendix A lists the full initial set with source citations.

### 4.3 Context gatherer

The gatherer accepts a metadata bundle. The core fields:

- `table_sizes`: a JSON document of `{schema.table: {rows, size_bytes, is_partitioned}}`.
- `index_profiles`: index names, sizes, and the columns they cover.
- `replication_topology`: a list of logical subscribers, streaming replicas, and CDC consumers.
- `query_hotness`: a pg_stat_statements excerpt keyed by table.

The bundle is optional. When it is missing, the context gatherer attaches an explicit `ContextUnknown` marker to each operation and the fused signal defers to rule severity alone. The dashboard surfaces "no context" prominently so the reviewer is never misled about the depth of the review.

### 4.4 Call-site scanner

The scanner reads the application repository for references to the columns and tables changed by the migration. It is designed to be fast and cautious: false positives are preferable to false negatives because the scanner's output is surfaced as "places a human should check", not "places we will rewrite".

Supported languages and ORMs:

- **Python.** SQLAlchemy (Core and ORM), Django ORM, Peewee, Pony, SQLModel, raw psycopg2/psycopg3 query strings.
- **Node.** Prisma, Knex, raw `pg`/`mysql2` template strings.
- **Go.** `database/sql` and `sqlc`.
- **Rust.** `sqlx` compile-time SQL.

The scanner uses tree-sitter grammars where available for structured matching and regex fallback elsewhere. Every match is attributed and scored: an exact model-field reference is a stronger signal than a string literal with the column name.

### 4.5 Signal fusion

[FIGURE:risk_score]

The risk score for an operation is an ordered tuple of four components:

1. **Rule severity.** `critical` (blocks deployment) = 4, `high` = 3, `medium` = 2, `low` = 1, `none` = 0.
2. **Context amplifier.** A multiplier in `[1.0, 2.5]` determined by table size, replication topology, and query hotness. A billion-row table under streaming replication is at the top of the range; an empty dev table is at 1.0.
3. **Call-site count.** The log of the number of references to the changed symbol in the application repository, clipped at a ceiling.
4. **Recoverability penalty.** Added only for operations that are hard to reverse: `DROP COLUMN`, `DROP TABLE`, narrowing type changes.

The per-migration grade is A–F, derived from the highest per-operation score plus a gentle penalty for the total number of findings. Grades are intentionally coarse; the per-operation details are where the nuance lives.

### 4.6 LLM reasoner and rewrite engine

The reasoner receives a structured prompt containing the operation, its rule hits, its context bundle, and the top call-sites. It is asked for two outputs:

- A natural-language **blast-radius** paragraph, no longer than one hundred words per operation.
- A **rewrite plan** expressed as a sequence of DDL statements, with each phase annotated as "expand", "migrate", or "contract".

Both outputs are templates. The blast-radius paragraph is constrained to reference only facts present in the prompt (the context bundle, the rule hits, the call-sites). The rewrite plan is constrained to a finite grammar of safe transformations — adding a column as nullable, backfilling in batches, adding a `NOT VALID` foreign key and validating separately, creating an index with `CONCURRENTLY`, renaming by dual-write. The grammar is a feature, not a limitation; it is the price of the verifier being able to reason about correctness.

### 4.7 Verifier

[FIGURE:verifier]

The verifier is the gate. For every rewrite:

1. **Parse.** The rewrite must parse cleanly in `pglast` (or `sqlglot` for non-Postgres).
2. **Span check.** The set of columns, tables, indexes, and constraints the rewrite touches must be a subset of those the original migration touches, except for transient objects introduced by the expand-migrate-contract pattern.
3. **Schema equivalence.** The rewrite, when applied to a clone of the current schema, must produce a target schema whose logical shape matches what the original migration would have produced. "Logical shape" means column set, type set, nullability, constraints, indexes — ignoring the trivial differences introduced by online DDL (e.g. a `NOT VALID` foreign key that is later validated).
4. **Dry-run.** The rewrite is applied to a throwaway Postgres instance populated with the current schema (no data). A failure here discards the rewrite outright.

Rewrites that fail the verifier are logged with a reason and never shown to the reviewer. The deterministic analysis — rule hits, context, call-sites — is unaffected; a failed verifier is a failure of the proposal, not of the review.

### 4.8 Reporting

Every run produces two artefacts:

- A **PDF review** structured like this report — an abstract summary, per-migration pages, per-operation findings, and the approved rewrites as code blocks. The PDF is checked into a reviews folder in the repository and is the durable record of the review.
- An **interactive dashboard** with five views. Reviewers work in the dashboard; the PDF is for after-the-fact audit.

## 5. Dashboard Design

[FIGURE:dashboard]

The dashboard is a Next.js + Tailwind application that renders a single migration review. It is structured around five views:

- **Overview.** Grade, migration counts, top-five riskiest operations, and a trend chart across recent reviews.
- **Migration list.** One row per migration file, sortable by grade, operation count, and lock estimate. Expanding a row shows per-operation findings in place.
- **Operation detail.** Rule hits, context bundle, call-site list, proposed rewrite with a diff view, and an "approve / request changes" affordance.
- **Rewrite preview.** The expand-migrate-contract phases, each with copy-to-clipboard and a "download as SQL" button.
- **History.** Every past review for this repository, filterable by grade and author. Supports export as CSV and as a standalone PDF.

Accessibility targets are WCAG 2.2 AA. Specifically: semantic headings, skip-link, full keyboard operability, visible focus with 3:1 contrast, 4.5:1 body-text contrast, and respect for `prefers-reduced-motion`, `prefers-reduced-transparency`, and `forced-colors: active`. No information is conveyed by colour alone; severity is encoded redundantly with icon shape and text label. Dynamic content updates announce via a single polite ARIA live region. Modal dialogs trap focus and return it on close.

## 6. Evaluation Methodology

### 6.1 Datasets

Three datasets drive the evaluation.

**Catalogue coverage.** The `squawk` rule catalogue and the `strong_migrations` rule catalogue are public and small. SchemaShift's static analyser is evaluated against synthetic migrations that exercise each rule in each catalogue, scored on precision and recall.

**OSS migration corpus.** A corpus of real migration files from public repositories on GitHub — filtered to Alembic, Django, Rails, and Prisma projects with an active commit history and a permissive licence — serves as a realistic distribution. Baseline numbers: runtime per migration, rule-hit count, and verifier pass rate.

**Incident replay.** A hand-curated set of migrations that caused production incidents (sourced from public post-mortems with the author's permission where available) serves as a hard-negative set. For each, SchemaShift must either grade the migration below "C" or surface the failure-causing operation in the top three findings.

### 6.2 Metrics

- **Rule precision / recall** on synthetic migrations (target: ≥ 0.95 precision, ≥ 0.90 recall against each catalogue).
- **Grade stability.** Re-running the pipeline on the same input must produce the same grade. The LLM stages are seeded; any non-determinism is a defect.
- **Verifier pass rate.** The fraction of LLM-generated rewrites that pass the verifier. Target: ≥ 0.80 on the incident-replay set.
- **Human-review alignment.** On a sample of migrations reviewed independently by a human DBA, agreement on the top-three findings (measured as Jaccard similarity) should exceed 0.7.
- **Runtime budget.** Whole-pipeline wall-clock for a migration of ≤ 200 DDL statements: ≤ 60 seconds on a laptop-class machine, excluding LLM latency.

### 6.3 Regression gates

The CI job runs the full evaluation on every pull request and blocks merges on three regression gates: no more than a 1-point drop in precision, no more than a 1-point drop in recall, and no new verifier failures on the incident-replay set.

## 7. Implementation Roadmap

[FIGURE:roadmap]

The project plan is four weeks of focused work.

**Week 1 — scaffolding and static analyser.** Repository, CI, data contracts, parser integration (`pglast`, `sqlglot`), initial port of ten rules from `squawk` and `strong_migrations`. Deliverable: a command-line tool that runs on a single SQL file and emits rule hits.

**Week 2 — context and call-sites.** Metadata bundle parser, table-size and index-profile readers, application-code scanner for SQLAlchemy and Django ORMs. Deliverable: a tool that takes a migration + schema dump + repository path and emits fused signals.

**Week 3 — LLM reasoner and verifier.** Reasoner integration, rewrite grammar, verifier with dry-run Postgres container. Deliverable: the full pipeline end-to-end, with the verifier discarding any rewrite that fails.

**Week 4 — dashboard and PDF reporting.** Next.js dashboard scaffolded, five views, WCAG 2.2 AA pass, PDF emitter, CI wiring, and evaluation harness fully automated. Deliverable: a deployable system.

Two weeks of buffer follow for evaluation, hardening, and documentation.

## 8. Risk Analysis

**Verifier is too lenient.** If the equivalence relation is wrong, an unsafe rewrite could pass the verifier and reach a reviewer. Mitigation: the relation is defined narrowly (only the transformations in the rewrite grammar are whitelisted) and the incident-replay set is used to test for leaks.

**False positives in the call-site scanner.** Regex-based matches against column names will produce noise. Mitigation: every scanner hit is surfaced with its source line and context, and scores are shown so the reviewer can quickly dismiss spurious matches.

**LLM hallucination.** The language model is not in the trust boundary, but its natural-language rationale can still mislead. Mitigation: the blast-radius paragraph is constrained to reference only facts present in the prompt, and the dashboard shows the evidence alongside the rationale.

**Metadata bundle drift.** If the table sizes are from yesterday and the table doubled overnight, the risk estimate is wrong. Mitigation: the bundle carries a timestamp, and the dashboard shows the age of the metadata alongside the grade.

**Dialect drift.** Postgres is the initial target; MySQL is a stretch goal; SQLite is out of scope. Mitigation: every dialect-specific rule is tagged; the static analyser refuses to run unsupported dialects and reports that fact loudly rather than producing a misleading grade.

**Rule-catalogue staleness.** Postgres and MySQL continue to add features that change what is safe; `squawk` and `strong_migrations` are updated, and SchemaShift must follow. Mitigation: a quarterly review of the upstream catalogues, a test suite that pins each rule to its citation, and a CI job that pulls the upstream changelogs.

## 9. Ethical Considerations

Database migrations touch data. SchemaShift is designed never to be given data; it runs against schema and metadata alone. The verifier's dry-run instance is empty. The reference implementation refuses to connect to a database URL that carries a non-default TLS profile, to reduce the chance of operator error.

The tool is advisory. A human reviewer approves or rejects every finding. SchemaShift will not run a migration on the user's behalf. It emits phase plans that a database administrator can run themselves, and it produces the PDF review that can live alongside the migration in version control as the durable record of the decision.

The dashboard targets WCAG 2.2 AA. Reviewers who rely on a screen reader, who navigate by keyboard, or who use high-contrast or forced-colors modes are first-class users; no feature is introduced that excludes them.

## 10. Conclusion

SchemaShift is a system specification. It sits between two mature classes of tool — deterministic DDL linters and online schema-change engines — and it closes the gap by adding context-awareness, application-code scanning, and constrained LLM reasoning, with a deterministic verifier guarding every output. The design draws on `squawk`, `strong_migrations`, `pglast`, `sqlglot`, `pg_repack`, and `pgroll`; it does not reinvent any of them. The novel contribution is the integrated pipeline and the discipline of keeping the language model outside the trust boundary.

The four-week roadmap, the rule catalogue in Appendix A, and the data contracts in Appendix B are designed to be directly buildable. There is no stage that depends on unresolved research; every component has a precedent in the literature or the open-source ecosystem. The goal of this specification is that a single engineer with the appropriate domain knowledge could build the system without reinterpreting the design.

## Appendix A — Pattern Catalogue

The initial rule catalogue groups migrations by risk class. Each rule cites the upstream catalogue it was adapted from.

### BLOCKING

- **BL-001.** `ALTER TABLE ... SET NOT NULL` without a default on a populated table. Source: `squawk` (adding-not-null-field), `strong_migrations` (setting-not-null). Rewrite: add column as nullable, backfill in batches, set `NOT NULL` afterward; on Postgres 12+, use `ALTER TABLE ... ADD CONSTRAINT ... CHECK (column IS NOT NULL) NOT VALID` + `VALIDATE CONSTRAINT`.
- **BL-002.** `ALTER TABLE ... ADD FOREIGN KEY` without `NOT VALID`. Source: `squawk` (adding-foreign-key-constraint). Rewrite: add the constraint with `NOT VALID`, then `VALIDATE CONSTRAINT` in a separate transaction.
- **BL-003.** `CREATE INDEX` without `CONCURRENTLY`. Source: `squawk` (adding-serial-primary-key-field is related), `strong_migrations` (adding-an-index-non-concurrently). Rewrite: use `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction.
- **BL-004.** `ALTER TABLE ... ADD COLUMN` with a volatile default on a populated table. Source: `squawk` (adding-field-with-default). Rewrite: add the column without a default, backfill in batches, then set the default for future inserts.
- **BL-005.** `CLUSTER` or `VACUUM FULL` inside a migration. Source: `strong_migrations`. Rewrite: replace with `pg_repack` or `pgroll`.

### UNSAFE

- **UN-001.** `DROP COLUMN`. Source: both catalogues. Rewrite: expand-migrate-contract; remove references from application first, deploy, then drop.
- **UN-002.** `ALTER COLUMN ... TYPE` where the new type is narrower. Source: `squawk` (changing-column-type). Rewrite: add the new column, dual-write, backfill, swap.
- **UN-003.** `DROP TABLE`. Source: both catalogues. Rewrite: two-phase; deprecate reads then drop in a follow-up migration.

### REPLICATION

- **RP-001.** `RENAME COLUMN` or `RENAME TABLE`. Source: `strong_migrations` (renaming-a-column). Rewrite: add a new column, backfill, dual-write, swap reads, drop the old column in a follow-up migration.
- **RP-002.** Primary-key change. Source: `squawk` (ban-drop-primary-key). Rewrite: not automated; flag for manual review.

### PERF

- **PF-001.** Large `UPDATE` or `DELETE` inside the migration. Source: `strong_migrations` (executing-queries-in-migrations). Rewrite: move the DML out of the migration and into a batched background job.
- **PF-002.** `ALTER TYPE ... ADD VALUE` inside a transaction. Source: `squawk` (adding-enum-value-inside-transaction). Rewrite: run the `ALTER TYPE` in its own transaction.

### RECOVERY

- **RC-001.** `DROP INDEX` on a foreign-key column. Source: authors' heuristic; not in upstream catalogues. Rewrite: flag for review; the reviewer confirms the FK is no longer enforced.

Additional rules are added as the catalogue evolves. Each new rule must be accompanied by a synthetic test case, a citation, and a rewrite template if one exists.

## Appendix B — Data Contracts

The reference implementation uses Pydantic models. The core shapes are sketched here for completeness.

```python
class DDLOperation(BaseModel):
    kind: Literal["add_column", "drop_column", "alter_type", "rename",
                  "add_index", "drop_index", "add_fk", "drop_fk",
                  "add_constraint", "drop_constraint", "create_table",
                  "drop_table", "other"]
    schema: str
    table: str
    column: str | None
    ast: dict
    span: tuple[int, int]

class RuleHit(BaseModel):
    rule_id: str
    severity: Literal["critical", "high", "medium", "low"]
    operation: DDLOperation
    rationale: str
    citation: str

class ContextBundle(BaseModel):
    rows: int | None
    size_bytes: int | None
    indexes: list[IndexProfile]
    replication: ReplicationTopology | None
    hotness: QueryHotness | None
    timestamp: datetime

class CallSite(BaseModel):
    path: str
    line: int
    language: str
    symbol: str
    confidence: Literal["exact", "likely", "possible"]

class FusedSignal(BaseModel):
    operation: DDLOperation
    rule_hits: list[RuleHit]
    context: ContextBundle | None
    call_sites: list[CallSite]
    score: float
    grade_contribution: float

class Rewrite(BaseModel):
    phases: list[list[DDLOperation]]
    phase_names: list[Literal["expand", "migrate", "contract"]]
    verifier_passed: bool
    verifier_reason: str | None

class Report(BaseModel):
    migration_path: str
    grade: Literal["A", "B", "C", "D", "F"]
    summary: str
    fused_signals: list[FusedSignal]
    rewrites: dict[str, Rewrite]
    metadata_age: timedelta
    generated_at: datetime
```

## Appendix C — Deployment

The reference deployment targets Docker Compose for local review and a single GitHub Action for CI review. The Compose file runs three containers: the SchemaShift pipeline, a scratch Postgres for the verifier, and the dashboard. The GitHub Action runs the pipeline on every migration-touching pull request, uploads the PDF review as an artefact, and posts the grade as a PR comment.

No cloud service is required. The language-model API is pluggable; the reference implementation supports any OpenAI-compatible endpoint, and a local-only mode is provided that omits the reasoner stage and produces a rule-and-context-only review. The local-only mode is recommended for repositories where source cannot leave the network.

## Appendix D — Development Environment and Engineering Conventions

The reference implementation is Python 3.12 with typed data contracts enforced by Pydantic. Testing is pytest with coverage gates. Linting is `ruff` with the `F`, `E`, `W`, `B`, `I`, and `PERF` rulesets enabled; formatting is `black` and `isort`. Static typing is `mypy --strict` at CI time. SQL parsing uses `pglast` for Postgres and `sqlglot` as a fallback. The dashboard is Next.js 14 (App Router) with Tailwind and Radix UI primitives for accessibility. The PDF emitter uses `reportlab` and follows the same `TocDocTemplate` pattern adopted by PyOptimize.

All code is formatted on save. All tests run in CI on every push. The verifier dry-run container is pinned to a specific Postgres major version; upgrades are coordinated with a full evaluation run.

## Appendix E — Glossary

- **Expand-migrate-contract.** A migration pattern in which a schema change is split into three phases: add the new shape, backfill it while both old and new shapes are valid, and remove the old shape once all consumers have cut over.
- **Schema equivalence.** Two schemas are equivalent if they have the same set of tables, columns, types, nullability, constraints, and indexes, modulo transient objects introduced by online DDL.
- **Verifier.** The stage that refuses to ship any rewrite that cannot be proven equivalent to the author's intent.
- **Metadata bundle.** An optional JSON document carrying table sizes, index profiles, replication topology, and query hotness.
- **Catalogue coverage.** The fraction of a reference rule catalogue (e.g. `squawk`) that the SchemaShift analyser reproduces.
- **Incident replay.** A hand-curated set of migrations known to have caused production incidents, used as hard negatives in the evaluation.
- **Expand phase.** The first phase of an expand-migrate-contract migration: adding new columns, indexes, or constraints in a non-breaking way.
- **Migrate phase.** The second phase: backfilling data, dual-writing, or validating constraints deferred from the expand phase.
- **Contract phase.** The third phase: removing the old columns, indexes, or constraints once all consumers have cut over.
