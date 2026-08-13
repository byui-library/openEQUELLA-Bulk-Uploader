// scripts/probe-instance.mjs
//
// Read-only probe of an openEQUELLA instance. Creates nothing, changes
// nothing. Answers the response-shape questions in
// docs/superpowers/specs/2026-08-12-institution-agnostic-design.md and records
// fixtures the parsing tests are written against.
//
// AT BYU-IDAHO, DO NOT USE THIS SCRIPT -- use the browser instead. The
// instance is Okta SSO-backed, so there is no scriptable way to authenticate:
// the OAuth client is registered for the authorization-code flow only
// (probed 2026-08-12: client_credentials returns `invalid_client`, "must be
// registered with a fixed user"). A previous probe recorded that getting a
// cached token for a script "cost an hour and never succeeded", while pasting
// the URLs into an already-signed-in browser "took seconds". See
// docs/SESSION-HANDOFF.md. The browser recipe is in the README section this
// file's header points at, and `--urls` below prints it.
//
// THIS SCRIPT IS FOR INSTITUTIONS THAT ARE NOT BEHIND SSO -- the ones this
// whole feature exists for. They can sign in with a username and password, so
// the probe can run unattended.
//
//   node scripts/probe-instance.mjs --base https://oeq.example.edu --user NAME --pass SECRET
//   node scripts/probe-instance.mjs --base https://content.byui.edu --urls
//
import { writeFileSync, mkdirSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const has = (name) => process.argv.includes(`--${name}`);

const base = (arg('base') ?? process.env.OEQ_BASE_URL ?? '').replace(/\/+$/, '');

const collectionUuid = arg('collection') ?? process.env.OEQ_COLLECTION_UUID ?? '';
const schemaUuid = arg('schema') ?? process.env.OEQ_SCHEMA_UUID ?? '';

const PATHS = {
  collections: '/api/collection?privilege=CREATE_ITEM&full=true&length=50',
  oneCollection: collectionUuid ? `/api/collection/${collectionUuid}?full=true` : null,
  schema: schemaUuid ? `/api/schema/${schemaUuid}` : null,
};

// `--urls` prints what to paste into a signed-in browser. This is the ONLY
// path that works on an SSO instance, so it is not a fallback -- for BYU-Idaho
// it is the supported route.
if (has('urls')) {
  console.log('\nOpen these in a browser already signed in to openEQUELLA.');
  console.log('Save each response with Ctrl+S to the path shown beside it.\n');
  console.log(`  ${base}${PATHS.collections}`);
  console.log('      -> tests/fixtures/api/collections.json\n');
  if (PATHS.oneCollection) {
    console.log(`  ${base}${PATHS.oneCollection}`);
    console.log('      -> tests/fixtures/api/collection-one.json\n');
  }
  if (PATHS.schema) {
    console.log(`  ${base}${PATHS.schema}`);
    console.log('      -> tests/fixtures/api/schema.json\n');
  }
  console.log('Then run:  node scripts/probe-instance.mjs --analyse\n');
  process.exit(0);
}

// `--analyse` reads fixtures saved from the browser and answers the same
// questions the live path does, so an SSO instance gets an identical report.
// Runs BEFORE the base-url requirement on purpose: reading files saved from a
// browser needs no instance address, and demanding one turned the simplest
// path into an error message.
if (has('analyse') || has('analyze')) {
  const { readFileSync } = await import('node:fs');
  const read = (f) => {
    const path = `tests/fixtures/api/${f}`;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      console.log(`    (not found: ${path})`);
      return null;
    }
    // A browser's JSON viewer saves HTML, not JSON -- a silent, easy mistake
    // whose failure would otherwise read as "the API returned nothing".
    if (/^\s*</.test(text)) {
      console.log(`    (${path} is HTML, not JSON -- save the browser's Raw Data tab instead)`);
      return null;
    }
    try {
      return JSON.parse(text.replace(/^﻿/, ''));
    } catch (error) {
      console.log(`    (${path} is not valid JSON: ${error.message})`);
      return null;
    }
  };
  report(read('collections.json'), read('collection-one.json'), read('schema.json'));
  process.exit(0);
}

if (!base) {
  console.error('Need --base <url> or OEQ_BASE_URL in the environment.');
  process.exit(2);
}

if (!arg('user')) {
  console.error('Need --user and --pass, or --urls for an SSO instance, or --analyse.');
  process.exit(2);
}

// --- live path: password sign-in, then three GETs ------------------------
const loginUrl = new URL('/api/auth/login', base);
loginUrl.searchParams.set('username', arg('user'));
loginUrl.searchParams.set('password', arg('pass') ?? '');

const loginRes = await fetch(loginUrl, { method: 'POST' });
console.log('=== Q0  POST /api/auth/login ->', loginRes.status);
const cookies = loginRes.headers.getSetCookie();
console.log('    set-cookie names:', cookies.map((c) => c.split('=')[0]).join(', ') || '(none)');
const jsession = cookies.find((c) => c.startsWith('JSESSIONID='));
console.log('    JSESSIONID present:', Boolean(jsession));
if (!loginRes.ok || !jsession) {
  console.log('    body:', (await loginRes.text()).slice(0, 300));
  console.log('\nPassword sign-in did not work here. If this instance is SSO-backed');
  console.log('that is expected -- re-run with --urls and use the browser.');
  process.exit(1);
}

// EVERY cookie the sign-in set, not just JSESSIONID -- the same defect this
// script exists to catch, and it bit here first. Behind a load balancer the
// AWSALB/ROUTEID cookies decide which backend a request reaches; JSESSIONID
// alone lands on one that has never seen the session, and openEQUELLA answers
// that as GUEST with 200 and empty results. Every question below would then be
// answered for the wrong identity, and the output would look plausible.
// Measured on content-test.byui.edu, 2026-08-12; see src/core/passwordAuth.ts.
const headers = { Cookie: cookies.map((c) => c.split(';')[0]).join('; ') };
const get = async (path) => {
  if (!path) return null;
  const res = await fetch(new URL(path, base), { headers });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.log(`    (${path} returned non-JSON, status ${res.status})`);
    return null;
  }
};

mkdirSync('tests/fixtures/api', { recursive: true });
const collections = await get(PATHS.collections);
const oneCollection = await get(PATHS.oneCollection);
const derivedSchema = oneCollection?.schema?.uuid;
const schema = await get(PATHS.schema ?? (derivedSchema ? `/api/schema/${derivedSchema}` : null));

for (const [name, body] of [
  ['collections.json', collections],
  ['collection-one.json', oneCollection],
  ['schema.json', schema],
]) {
  if (body) {
    writeFileSync(`tests/fixtures/api/${name}`, JSON.stringify(body, null, 2));
    console.log(`    -> recorded tests/fixtures/api/${name}`);
  }
}

report(collections, oneCollection, schema);

/** The three unknowns the design doc says must be settled before code depends on them. */
function report(collections, oneCollection, schema) {
  console.log('\n=== Q1  collection list');
  if (!collections) {
    console.log('    MISSING - tests/fixtures/api/collections.json not found or not JSON');
  } else {
    console.log('    wrapper keys:', Object.keys(collections).join(', '));
    const first = collections.results?.[0];
    console.log('    available:', collections.available ?? '(no `available` key)');
    console.log('    entry keys:', first ? Object.keys(first).join(', ') : '(no results)');
    console.log('    entries carry uuid+name:', Boolean(first?.uuid && first?.name));
  }

  console.log('\n=== Q2  does a collection name its schema?  (THE BIG ONE)');
  if (!oneCollection) {
    console.log('    MISSING - tests/fixtures/api/collection-one.json not found or not JSON');
  } else {
    console.log('    keys:', Object.keys(oneCollection).join(', '));
    console.log('    schema field:', JSON.stringify(oneCollection.schema ?? '(ABSENT)'));
    console.log(
      oneCollection.schema?.uuid
        ? '    -> YES. Setup can go collection -> schema in one hop.'
        : '    -> NO. The Setup flow needs rethinking; see the design doc.',
    );
  }

  console.log('\n=== Q3  schema shape');
  if (!schema) {
    console.log('    MISSING - tests/fixtures/api/schema.json not found or not JSON');
  } else {
    console.log('    keys:', Object.keys(schema).join(', '));
    console.log('    namePath:', schema.namePath ?? '(absent)');
    console.log('    itemNamePath:', schema.itemNamePath ?? '(absent)');
    console.log('    definition is a:', typeof schema.definition);
    const declared = schema.namePath ?? schema.itemNamePath;
    console.log(
      declared
        ? `    -> title path is declared as ${declared}`
        : '    -> NO declared title path. Duplicate detection must report "could not check".',
    );
  }
  console.log('');
}
