# Statpack audit custody and checkout availability

## Approved scope

The owner confirmed the live cause and authorized implementation, verification,
one ready PR on `fix/inspect-statpack-availability`, and pushing that branch.
Never merge, deploy, or execute the repair script with `--apply`. Write the smoke
case but do not run the browser smoke driver. Existing unrelated untracked plan
and UI standards documents remain outside this PR.

## Root cause and live evidence

The read-only scan of project `bmrc-logistics` on 2026-10-28 returned four packs
and 251 log rows. Every pack had exactly `status: "Ready"`, `isCheckedOut: true`,
and an existing `name` field. Missing names and status whitespace/casing are
ruled out. This state fully explains zero checkout availability without a stale
bundle or the already-fixed composite-index query.

| Pack | Document ID | Assigned user | Current event ID |
|---|---|---|---|
| BMRC1 | `vwZVWOTh6GfvhL31dawc` | Siddharth Thomas (`miKmJAEYKqhNfoEFrB7f5OdZwF43`) | `d3vySP4s5SHj297ShZ1L` (`test 3`) |
| BMRC2 | `GyWa1frkzslUrn2PrZ9j` | Vincent Kreft (`bGVRtzID3OZdWTnOmNeujtuPo8I3`) | null |
| BMRC3 | `j3JeiVxPx7uf4NnQpRjU` | Ivan Zhang (`7hn1Nm9ZuDhiWnkLzo3WXew9aJy1`) | null |
| BMRC4 | `s9dQJnYwpeKSTMjaEx5J` | Yuxin Yang (`DPEjKAL4wCTmsPJrzIGyTK9m2JJ3`) | null |

The audit branch of `logStatpackCheckOff` unconditionally wrote `deriveStatus()`
while preserving `isCheckedOut`. This is an active writer bug, not merely legacy
editor damage. BMRC1 has an audit at 2026-10-28T03:54:38.151Z after checkout at
2026-10-27T01:30:54.111Z; BMRC4 has an audit at 2026-10-28T04:33:26.437Z after
checkout at 2026-10-09T19:47:45.218Z. The PR #34 editor guard does not cover this
audit path. The scan alone does not establish the exact historical writer for
every pack.

## Implementation

- `app/lib/inventory.ts` and `app/lib/statpack-audit.ts`: use the live transaction
  state; omit status on audit when `isCheckedOut === true`. Preserve contents,
  audit stamps, custody, and override clearing. Audit logs always retain
  `derivedStatus`, declared in `app/types.ts`.
- `app/assets/page.tsx`: display `In Use` whenever `isCheckedOut` is truthy.
  Picker eligibility and the strict transactional checkout gate are unchanged.
- `scripts/inspect-statpack-availability.cjs`: read-only inspection, including
  unnamed documents and each pack's last three logs sorted locally.
- `scripts/repair-statpack-checkout-conflicts.cjs`: dry-run by default, required
  `--actor '{"userId":"...","userName":"..."}'`. Each explicit apply transaction
  re-reads its candidate and rechecks `isCheckedOut === true && status !== 'In Use'`.
  Clear custody only, leave status, and atomically create `action: 'checkin'` with
  notes `Admin reconcile: stale checkout cleared (status/isCheckedOut conflict)`.
  Carry event information onto the log; never call `endEventShifts`. Report
  current event IDs for manual follow-up. The owner alone runs `--apply`.
- `decisions.md` D-8 and `FINDINGS.md`: document the custody rule and incident.
- Unit, fake-transaction, emulator integration, and unexecuted smoke regression
  cases cover checked-out audits, derived findings, conflict display, and picker
  eligibility. Wire offline repair tests into `npm run test`.

## Rules confirmation

`firestore.prod.rules` permits signed-in statpack updates (lines 333–336) and
signed-in statpack-log creates (lines 257–260). There is no log-field whitelist
that would reject `derivedStatus`. The admin script uses Admin SDK credentials.
No collection or rules change is required; no rules deployment is performed.

## Progress and verification

- Continued the existing feature branch originally cut from freshly fetched
  `origin/main`; no changes to `main` and no force-push.
- Owner approved `isCheckedOut` as authoritative; there is no unresolved picker
  policy decision.
- Core audit fix, Assets mapping, D-8 amendment, and focused helper implemented.
- Script and tests delegated on non-overlapping files per `CLAUDE.md`.
- `npx tsc --noEmit` passed. `npm run lint -- --ignore-pattern
  '.claude/worktrees/**'` passed with 121 existing warnings and zero errors;
  final smoke/script-scoped lint also passed. Production `npm run build` passed.
- `npm run test` passed, including custody/picker regressions and fake-transaction
  repair tests (no Firestore writes). `npm run test:statpack-status-log` passed
  18/18 against fresh demo-project Firestore emulators, including the two audit
  transaction regressions.
- Sandbox restrictions blocked tsx IPC sockets/emulator loopback ports; those
  checks passed after approved execution outside the sandbox. The sandboxed
  Turbopack build stalled and was interrupted; the approved outside-sandbox
  build passed. Initial typecheck exposed a test-only excess-property error;
  corrected it and the final typecheck passed.
- Live default-mode [dry run](evidence/2026-10-28-statpack-checkout-conflicts-dry-run.txt)
  at 2026-10-29T01:54Z (2026-10-28 Pacific) found exactly four conflicts:
  `planned=4 applied=0 skipped=0`. All retain `Ready`; BMRC1's event
  `d3vySP4s5SHj297ShZ1L` requires manual shift follow-up. Actor fields are labeled
  dry-run placeholders; replace them with the real admin UID/name before apply.
- Browser smoke and `--apply` will not run, per owner instruction.
- Full invariant/property/semester suites, browser smoke, and rules tests were
  not run. Rules are unchanged; focused emulator transactions were verified.
- Committed implementation as `2ed9aac`, pushed the authorized branch, and opened
  ready [PR #37](https://github.com/iv-zhang/BMRC-Logistics/pull/37) into `main`,
  with complete dry-run output in its description. The GitHub connector returned
  403 on PR creation; the authenticated GitHub CLI created it. No merge or
  production data writes performed. Latest CI/review state is tracked on the PR.
