/**
 * Emulator read helpers over the Firestore REST API (no firebase SDK).
 *
 * The firebase client SDK drags in @grpc/grpc-js, which Playwright's esbuild
 * bundler cannot load ("Unexpected module status 3"). Reading the emulator over
 * plain HTTP with global fetch sidesteps that entirely and keeps the e2e process
 * dependency-free. Guard: demo-* project + emulator host required.
 */
const HOST = process.env.FIRESTORE_EMULATOR_HOST || process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = process.env.GCLOUD_PROJECT || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'demo-bmrc-logistics';
if (!PROJECT.startsWith('demo-')) throw new Error(`[e2e] refusing non-demo project '${PROJECT}'`);
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeVal(v: any): any {
  if (v == null) return undefined;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeVal);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return undefined;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeFields(f: Record<string, any>): Record<string, any> {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(f)) o[k] = decodeVal(f[k]);
  return o;
}

/** Fetch one document by `collection/id`; null if it doesn't exist. */
export async function getDocById(collection: string, id: string): Promise<Record<string, any> | null> {
  const res = await fetch(`${BASE}/${collection}/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`emulator GET ${collection}/${id} → ${res.status}`);
  const json = await res.json();
  return decodeFields(json.fields || {});
}

/** List all documents in a collection (decoded, each with its `id`). */
export async function listCollection(collection: string): Promise<Array<Record<string, any> & { id: string }>> {
  const out: Array<Record<string, any> & { id: string }> = [];
  let pageToken = '';
  do {
    const url = `${BASE}/${collection}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url);
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`emulator LIST ${collection} → ${res.status}`);
    const json = await res.json();
    for (const d of json.documents || []) {
      out.push({ id: String(d.name).split('/').pop()!, ...decodeFields(d.fields || {}) } as any);
    }
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  return out;
}
