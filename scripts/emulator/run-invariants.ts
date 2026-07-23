/**
 * Runs every Tier-1 invariant integration test against the emulator.
 * Each ./invariants/inv-XX.test.ts registers itself via defineInvariant();
 * this entry point imports them all, then executes with a fresh seed per suite.
 */
import { runRegistered } from './harness';

// Order = INV id. Importing registers the suite.
import './invariants/inv-01.test';
import './invariants/inv-02.test';
import './invariants/inv-03.test';
import './invariants/inv-04.test';
import './invariants/inv-05.test';
import './invariants/inv-06.test';
import './invariants/inv-07.test';
import './invariants/inv-08.test';
import './invariants/inv-09.test';
import './invariants/inv-10.test';
import './invariants/inv-11.test';
import './invariants/inv-12.test';
import './invariants/inv-13.test';
import './invariants/inv-14.test';
import './invariants/inv-15.test';

await runRegistered();
