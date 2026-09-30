# Log: fix/firestore-rules

## Packets done
- S1 · `firestore.prod.rules` (signed-in floor, `users` role-escalation guard) · 6779f71 · buggy first version (additive catch-all + medops escalation); fixed in c42a253, never deploy 6779f71
- S2 · `firebase.json` -> `firestore.prod.rules`, new `firebase.emulator.json`, 8 emulator scripts pass `--config` · 63cd57d · JSON parses; `emulators:exec` boots and exits 0 (firebase-tools 15.30.2, JDK 21)
- S3 · 25-case emulator suite `app/lib/__tests__/rules-stopgap.test.ts` + `npm run test:rules`; fixed both S1 holes · c42a253 · `npm run test:rules` 25/25 pass; tsc/eslint clean on touched files; app not driven against prod rules
- S4 · deploy (user runs; command is in plan §0.5) · not deployed · deploy from c42a253 only

## Unfolded findings
- A bare `firebase deploy` still ships hosting AND firestore rules/indexes (now the safe prod stopgap); recommended habit stays explicit `--only` forms.
- `firebase-tools` 15.x works with JDK 21 on this machine, so the memory note pinning 13.35.1 is stale.
