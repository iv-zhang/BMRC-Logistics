# BMRC Logistics — Skill Library

Task-scoped knowledge for working on this codebase without a senior engineer
in the loop. Each skill is self-contained, cites real files/functions, and
encodes the invariants that must not regress. `CLAUDE.md` is the always-loaded
overview; these load on demand when a task matches.

## Map

| Skill | Open it when the task involves… |
|---|---|
| `bmrc-domain` | Any read/write of inventory, batches, stock, status, expiration, locations, assets. **The invariant contract (INV-1…12) lives here.** |
| `bmrc-org-config` | Thresholds, locations, categories, statpack types — or adding a `/settings` option. |
| `bmrc-statpack-flows` | Checkout / check-in / pack audit, the check-off page, pack status, statpack logs/stats. |
| `bmrc-audit-workbench` | The `/audit` page, its five actions, receiving shipments, moves, issue reports, the `auditEvents` ledger. |
| `bmrc-new-page` | Creating a route/page, nav registration, role gating, static-export routing, Firestore subscription patterns. |
| `bmrc-testing` | Running/writing tests, the emulator harness, seeding, end-to-end verification of a change. |
| `bmrc-migrations` | Anything in `scripts/` against live data; schema changes, backfills, data fixes. |
| `bmrc-debugging` | Any bug hunt — symptom → cause → fix playbook for the recurring failure classes. |
| `bmrc-ui` (in `.claude/commands/`) | Anything the user can see — layout, components, colors, responsiveness. |

Typical feature touches several: e.g. "add a field to the audit Count action"
= `bmrc-audit-workbench` (write helper + triple write) + `bmrc-domain` (does
it affect stock math?) + `bmrc-ui` (drawer UI) + `bmrc-testing` (verify).

## House standards (apply to every session)

1. **Never commit or push unless explicitly asked** (`CLAUDE.md` rule).
2. Production Firestore is live for an active EMS corps — experiments and
   tests run on the emulator only; migrations are dry-run first.
3. Business logic lives in `app/lib/` (pure, headless, testable); components
   call helpers. Status/stock math is imported from `item-status.ts`, never
   re-derived.
4. "Done" = `npm run lint` + `npm run build` pass, the relevant test tier is
   green, and the affected flow was driven against the emulator.
5. Match the existing style of the file you're editing; the inventory page and
   dashboard are the canonical UI references.
