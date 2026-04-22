# SchemaShift — Migration Safety Reviewer

> Design project. A deterministic rule engine + LLM-assisted rewrite planner that grades SQL migrations before they touch production, and proposes a safer expand–migrate–contract split when one exists.

SchemaShift is a technical design specification. This repository contains:

1. **A 19-page design report** (`SchemaShift_Design_Report.pdf`, built from `report.md`, `figures.py`, and `build_pdf.py`) that describes a seven-stage pipeline, a documented rule catalogue, evaluation methodology, and a four-week roadmap.
2. **An interactive prototype** (`docs/`) that runs the static-analyser portion of the design entirely in the browser. Paste a SQL migration, receive a risk grade, per-statement findings, and a rewrite plan. Live at the GitHub Pages site linked in the repository sidebar.

The analyser is adapted from the published rule catalogues of [squawk](https://squawkhq.com) and [strong_migrations](https://github.com/ankane/strong_migrations). Every rule in `docs/app.js` carries a citation to the source catalogue.

## Why this exists

Deterministic linters catch SQL anti-patterns; online-schema-change tools avoid blocking locks at runtime; migration runners apply changes idempotently. But three things are missing from the current ecosystem:

1. A **risk grade** per migration, not per statement. Reviewers want a single A–F signal that summarises a PR before drilling in.
2. **Context-aware severity.** A `SET NOT NULL` on an empty lookup table is trivial; the same statement on a billion-row events table is an incident. Current linters see only the SQL.
3. An automated **rewrite plan.** Most teams know they should split risky DDL into expand / migrate / contract phases, but writing the three-phase version by hand is tedious and easy to get wrong.

SchemaShift is a specification for a tool that fills those gaps. The interactive prototype is a proof of the first and third pieces; the second requires live database metadata and is described in the report rather than built into the demo.

## The interactive demo

Open [docs/index.html](docs/index.html) locally, or visit the GitHub Pages site, and paste a SQL migration into the editor. The analyser:

- Splits the input into statements, respecting comments, string literals, and dollar-quoted blocks.
- Runs the rule catalogue (currently 14 rules across five classes — see `docs/app.js`) against each statement.
- Computes a score (100 minus the sum of severity weights) and an A–F grade. A single critical finding caps the grade at D.
- Renders findings in severity order.
- Emits a three-phase rewrite plan as `<details>` disclosure blocks for any rule that has one, with a real `<button>` copy-to-clipboard affordance per phase.
- Highlights each flagged statement inline in the migration source, with severity encoded as border style (solid / dashed / double / double-bold) in addition to colour.

A worked example to paste in:

```sql
-- Adding a required email column to a populated users table.
ALTER TABLE users ADD COLUMN email VARCHAR(255);
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
CREATE INDEX idx_users_email ON users(email);
```

That input triggers BL-001 (critical), BL-003 (high), and receives a D grade, with a full three-phase rewrite plan for BL-001.

## Accessibility

The prototype is built to WCAG 2.2 AA. Specifically:

- Semantic landmarks (`header`, `main`, `footer`), a skip link, and a single `h1`.
- Full keyboard operability: every interactive element is reachable by Tab and operable by Enter/Space. `Cmd/Ctrl+Enter` in the textarea runs analysis.
- Visible focus: two-layer outline with a 3:1 minimum contrast against both light and dark backgrounds.
- Four-tier severity is encoded redundantly — label text, border colour, and border style. The highest tier ("critical") uses a double-bold border that survives `forced-colors: active`.
- A single `aria-live="polite"` region announces analysis completion, copy confirmations, and error states. No visual-only signals.
- `prefers-reduced-motion` disables the score-ring transition and the hero shimmer.
- `prefers-color-scheme` is respected, with a manual override persisted via `localStorage`.

The `<details>`/`<summary>` rewrite-phase blocks use the browser's native keyboard behaviour. The copy-to-clipboard buttons are real `<button>` elements.

## Repository layout

| Path | Purpose |
|---|---|
| `report.md` | Source of the design report. Ten sections plus five appendices. |
| `figures.py` | Six vector figures (Platypus `Drawing` objects). |
| `build_pdf.py` | Renders `report.md` + `figures.py` into the final PDF with a bookmark outline. |
| `SchemaShift_Design_Report.pdf` | Built artefact, committed for convenience and rebuilt in CI. |
| `docs/` | Interactive demo — static files, served via GitHub Pages. |
| `.github/workflows/build-pdf.yml` | Rebuilds the PDF on every change to the source, asserts a minimum page count, uploads as an artefact. |

## Building the PDF locally

```bash
python -m venv .venv
source .venv/bin/activate
pip install reportlab==4.2.2
python build_pdf.py
```

The output is `SchemaShift_Design_Report.pdf` in the repository root, ~60 KB and 19 pages.

## Running the demo locally

The demo is a single HTML file with two siblings (`styles.css`, `app.js`) and no build step. Any static file server works:

```bash
cd docs
python -m http.server 8000
# visit http://localhost:8000
```

No network requests leave the page. Analysis runs entirely client-side.

## Scope and non-goals

- **Postgres-first.** The rule catalogue targets Postgres. MySQL is a stretch goal noted in the roadmap. SQLite is out of scope.
- **Not a query optimiser.** SchemaShift reviews schema changes, not query plans.
- **Not a replacement for a DBA.** A critical-severity finding is a signal to involve a human, not a substitute for one.
- **The LLM rewrite engine described in the report is not in the browser demo.** The demo uses deterministic templates, which is a strict subset of what the full system specifies.

## Citations and prior art

The rule catalogue is adapted from:

- [squawk](https://squawkhq.com) by Steven Kraft — PostgreSQL migration linter.
- [strong_migrations](https://github.com/ankane/strong_migrations) by Andrew Kane — safe-migration rules for Rails, widely adapted across ecosystems.

Other tools referenced in the design but not in the demo:

- [pg_repack](https://github.com/reorg/pg_repack) — online table reorganisation for Postgres.
- [pgroll](https://github.com/xataio/pgroll) — multi-version schema migrations for Postgres (Xata).
- [pt-online-schema-change](https://docs.percona.com/percona-toolkit/pt-online-schema-change.html) — Percona's online DDL for MySQL.
- [gh-ost](https://github.com/github/gh-ost) — GitHub's triggerless online DDL for MySQL.
- [sqlglot](https://github.com/tobymao/sqlglot), [sqlparse](https://github.com/andialbrecht/sqlparse), [pglast](https://github.com/lelit/pglast) — Python SQL parsers.
- [Alembic](https://alembic.sqlalchemy.org), [Liquibase](https://www.liquibase.org), [Flyway](https://flywaydb.org), [Prisma Migrate](https://www.prisma.io/migrate), [Django migrations](https://docs.djangoproject.com/en/stable/topics/migrations/) — migration runners.

## License

This is a design project. All original text and code in this repository are released under the MIT license. The cited external tools retain their own licenses.
