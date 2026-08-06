// scripts/probe-where.mts
//
// One-off probe. Answers three questions the captured schema/swagger.json
// cannot, because it documents `where` only as a link to external docs and its
// AttachmentBean models no filename property at all:
//
//   1. What `where` clause syntax does this instance accept?
//   2. Does it actually FILTER, or does it return everything regardless?
//   3. Where does an attachment's filename appear in a search result?
//
// This project has twice been wrong about exactly this kind of thing -- the
// staging area being a `?file=` query parameter rather than a body field, and
// /search defaulting to showall=false -- and both times the entire test suite
// agreed with the wrong answer. Hence a probe rather than an assumption.
//
// Reads only. Creates nothing, changes nothing, deletes nothing.
// Run against the TEST instance.
//
// ANSWERS (fill in after running, do not delete the questions):
//   1.
//   2.
//   3.
import { loadConfig, createAuthProvider } from '../src/core/config.js';

const title = process.env.OEQ_PROBE_TITLE;
if (!title) {
  console.error('Set OEQ_PROBE_TITLE to the exact title of an item known to exist.');
  process.exit(1);
}

// Same path the CLI takes, so this works with the authorization-code session
// `oeq-upload login` already established. Client credentials are NOT usable
// against this instance -- the OAuth client has no fixed user.
const cfg = loadConfig(process.env);
const auth = createAuthProvider(cfg, process.env);
const headers = await auth.authHeader();

const enc = encodeURIComponent;

async function probe(label: string, clause: string): Promise<void> {
  const qs =
    `collections=${enc(cfg.collectionUuid)}` +
    `&where=${enc(clause)}` +
    `&info=attachment&showall=true&length=5`;
  const res = await fetch(new URL(`/api/search?${qs}`, cfg.baseUrl), { headers });
  const body = await res.text();
  console.log(`\n=== ${label}`);
  console.log(`clause: ${clause}`);
  console.log(`status: ${res.status}`);
  console.log(body.slice(0, 1800));
}

// A: the escape this tool currently implements -- a doubled single quote.
await probe('A  doubled-quote escaping, a title that EXISTS', `/xml/MWDL/title = '${title.replace(/'/g, "''")}'`);

// B: proves the clause filters at all. If this returns hits, `where` is being
// ignored and the whole approach is invalid.
await probe('B  a title that certainly does NOT exist', `/xml/MWDL/title = 'zzz-no-such-item-zzz'`);

// C: the alternative escape, for comparison with A.
await probe('C  backslash escaping, same title as A', `/xml/MWDL/title = '${title.replace(/'/g, "\\'")}'`);

// D: no spaces around the operator, in case the parser is fussy.
await probe('D  no spaces around =', `/xml/MWDL/title='${title.replace(/'/g, "''")}'`);
