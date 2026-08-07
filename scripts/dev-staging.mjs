/**
 * Launch `next dev` pointed at the cloud staging project (`bmrc-staging`).
 *
 * Why a wrapper instead of `node --env-file=.env.staging.local next dev`?
 * `next dev` spawns worker processes and forwards the parent's flags via
 * NODE_OPTIONS, and Node refuses `--env-file` inside NODE_OPTIONS ("not
 * allowed in NODE_OPTIONS"). So we load the env file into THIS process's
 * environment up front; the spawned `next` (and its workers) then inherit
 * real environment variables — nothing travels through NODE_OPTIONS.
 *
 * Precedence note: @next/env will also read `.env.local`, but it never
 * overrides variables already present in process.env — so the staging values
 * loaded here win, and your prod `.env.local` is effectively ignored for this
 * run. Extra CLI args (e.g. a `-p 3001` port) are passed straight through.
 */
import process from 'node:process';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const ENV_FILE = '.env.staging.local';

if (!existsSync(ENV_FILE)) {
  console.error(
    `\n[dev:staging] Missing ${ENV_FILE}.\n` +
      `Copy .env.staging.local.example to ${ENV_FILE} and fill in your staging\n` +
      `web-app config (see STAGING.md).\n`,
  );
  process.exit(1);
}

// Node 20.12+/22+/24: load the env file into process.env before spawning.
process.loadEnvFile(ENV_FILE);

const extraArgs = process.argv.slice(2);
const child = spawn('next', ['dev', ...extraArgs], {
  stdio: 'inherit',
  shell: true, // resolve `next` via npm's augmented PATH (node_modules/.bin)
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
