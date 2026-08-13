// scripts/probe-session.mjs
//
// Answers one question: does an openEQUELLA session survive when only
// JSESSIONID is sent back, or does it need the other cookies the login
// response set?
//
// This matters because `UsernamePasswordAuth` returns exactly one header --
// `Cookie: JSESSIONID=...` -- and content-test.byui.edu sits behind an AWS
// load balancer that also sets AWSALB, AWSALBCORS and ROUTEID. If those carry
// routing state, a request without them can land on a backend that has never
// heard of the session. openEQUELLA does NOT answer that with 401: it answers
// 200 with `available: N` and zero results, which is indistinguishable from
// "you have no collections" unless you look for it.
//
// Prints counts and cookie NAMES only. No cookie value, username or password
// is ever printed.
//
// Usage (PowerShell), with credentials in the environment so they never reach
// a process argument list:
//
//   $env:OEQ_USERNAME='you'; $env:OEQ_PASSWORD='...'
//   node scripts/probe-session.mjs --base https://content-test.byui.edu
//   Remove-Item Env:OEQ_PASSWORD
//
// Or put OEQ_USERNAME / OEQ_PASSWORD in .env (gitignored) and run:
//   node --env-file=.env scripts/probe-session.mjs --base https://content-test.byui.edu

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const base = (arg('base') ?? process.env.OEQ_BASE_URL ?? '').replace(/\/+$/, '');
const username = process.env.OEQ_USERNAME;
const password = process.env.OEQ_PASSWORD;

if (!base || !username || !password) {
  console.error('Need --base (or OEQ_BASE_URL) plus OEQ_USERNAME and OEQ_PASSWORD in the environment.');
  process.exit(2);
}

/**
 * The .mjs twin of `instanceEndpoint()` in src/core/instanceUrl.ts -- copied
 * rather than imported because this script runs under plain `node` and cannot
 * import TypeScript. `new URL('/api/...', 'https://host/oeq')` drops the
 * `/oeq`, because an absolute path replaces the base's path outright, and
 * openEQUELLA is commonly deployed under a prefix.
 */
const endpoint = (path) => new URL(path.replace(/^\/+/, ''), `${base.replace(/\/+$/, '')}/`);

const loginUrl = endpoint('/api/auth/login');
loginUrl.searchParams.set('username', username);
loginUrl.searchParams.set('password', password);

const login = await fetch(loginUrl, { method: 'POST' });
console.log('login ->', login.status, login.ok ? '' : '(sign-in itself failed; nothing below is meaningful)');

const setCookies = login.headers.getSetCookie();
console.log('cookies the server set:', setCookies.map((c) => c.split('=')[0]).join(', ') || '(none)');

// `name=value` for each, no attributes. Values are never printed.
const pairs = setCookies.map((c) => c.split(';')[0]);
const jsessionOnly = pairs.find((p) => p.startsWith('JSESSIONID='));
const everything = pairs.join('; ');

if (!jsessionOnly) {
  console.log('No JSESSIONID was issued, so there is no session to test.');
  process.exit(1);
}

// Who does the server think this session is? This is the question that
// matters: openEQUELLA answers an unauthenticated request to /api/collection
// with 200 and an empty list, so the collection count alone cannot tell a
// failed sign-in from an account with no collections. currentuser can.
const whoami = async (label, cookieHeader) => {
  const res = await fetch(endpoint('/api/content/currentuser'), {
    headers: { Cookie: cookieHeader },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  const id = body?.username ?? body?.id ?? '(no username field)';
  const guest = body?.guest;
  console.log(`${label.padEnd(28)} HTTP ${res.status}  username=${id}  guest=${guest ?? '(absent)'}`);
  return body;
};

const COLLECTIONS = '/api/collection?privilege=CREATE_ITEM&length=100';

const count = async (label, cookieHeader) => {
  const res = await fetch(endpoint(COLLECTIONS), { headers: { Cookie: cookieHeader } });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  const results = Array.isArray(body?.results) ? body.results.length : 'n/a';
  console.log(
    `${label.padEnd(28)} HTTP ${res.status}  available=${body?.available ?? '?'}  results=${results}`,
  );
  return typeof results === 'number' ? results : -1;
};

console.log('');
console.log('--- who is this session? ------------------------------------');
await whoami('JSESSIONID only', jsessionOnly);
await whoami('every cookie the server set', everything);

console.log('');
console.log('--- what can it contribute to? ------------------------------');
const withJsessionOnly = await count('JSESSIONID only', jsessionOnly);
const withAll = await count('every cookie the server set', everything);
console.log('');
console.log('=== THE LINE THAT MATTERS: login came back', login.status,
  login.ok ? '(the credentials were accepted)' : '(the credentials were REJECTED)');
console.log('');

if (withAll > 0 && withJsessionOnly === 0) {
  console.log('CONFIRMED: the session needs more than JSESSIONID.');
  console.log('  Sending only JSESSIONID is treated as anonymous -- and openEQUELLA reports');
  console.log('  that as 200 with an empty list, never as 401. That is the bug.');
} else if (withAll > 0 && withJsessionOnly > 0) {
  console.log('NOT the cause: JSESSIONID alone is sufficient here. The session is fine;');
  console.log('  the credential is being lost somewhere else. Report both numbers back.');
} else if (withAll === 0) {
  console.log('Both came back empty, so the session itself is not authenticating.');
  console.log('  Check the login status above -- a 401 means the credentials were rejected.');
}
