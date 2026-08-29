/**
 * Runs the events / shift-staffing integration suites against the emulator.
 * Each ./events/*.test.ts registers itself via defineInvariant(); this entry
 * point imports them, then executes with a fresh seed per suite.
 */
import { runRegistered } from './harness';

import './events/evt-shifts.test';
import './events/evt-waitlist.test';

await runRegistered();
