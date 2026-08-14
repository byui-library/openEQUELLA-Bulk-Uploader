// src/core/ai/confirm.ts
//
// ## Why this is in core rather than in the renderer, where it was written
//
// TWO SURFACES ASK THE SAME QUESTION AND MUST ASK IT IN THE SAME WORDS. The
// desktop shows this in a dialog before `extractRun`; `oeq-upload extract --ai`
// prints it and refuses to go on without `--yes`. An operator who reads the
// dialog on Monday and runs the CLI on Tuesday is agreeing to the same thing,
// and a second copy of this text would be free to drift into describing a
// different one.
//
// It lived in `src/desktop/ui/`, which the CLI can technically import -- every
// dependency here is pure core. That is exactly the problem: the import would
// have been legal on the day it was written and silently fatal the day somebody
// added an `electron` import to a file under `ui/`, which is a reasonable thing
// to do to a file under `ui/`. Moving it makes the dependency point the way the
// layering already points.
//
// STILL RENDERER-SAFE, and it has to stay so: nothing reachable from
// `src/desktop/ui/` may import `node:*` or `electron`, and such an import does
// not fail loudly -- it blanks the window with nothing on the terminal.
// `tests/desktop/rendererPurity.test.ts` walks the graph and fails the build.
import { describeHost, isLoopbackEndpoint } from './endpoint.js';
import { modelColumns } from './eligible.js';
import type { Profile } from '../extract/types.js';

export interface AiConfirmInput {
  /**
   * The profile about to be run. The COUNT OF REQUESTS IS DERIVED FROM IT
   * rather than passed in, through `modelColumns` -- the same function the fill
   * pass filters with. A caller counting `{ ai: true }` sources itself would
   * quote a number for work that never happens: the attachment column and a
   * compose-only column can carry the marker and can never be written.
   */
  profile: Profile;
  /** Documents the run will read: every supported file in the folder. */
  documents: number;
  model: string;
  baseUrl: string;
  /** Characters sent from ONE document. See core/ai/slice.ts. */
  budget: number;
  /** Most requests this run may make. See core/ai/fill.ts. */
  cap: number;
}

/**
 * What the operator is asked before any document is sent, or null when no
 * confirmation is warranted.
 *
 * ## Null for an endpoint on this machine
 *
 * Nothing leaves the computer and nothing is charged, so a dialog would be pure
 * friction -- and friction on a dialog that does not matter is what trains
 * people to click past the one that does.
 *
 * `isLoopbackEndpoint` FROM `core/ai/endpoint.ts` DECIDES IT, and no predicate
 * is written here. That module exists for exactly this: `provider.ts` uses the
 * same function to decide whether a bearer key may cross plain http, and two
 * private copies would eventually disagree about what "local" means -- which
 * surfaces as a dialog assuring the operator that nothing is being sent
 * anywhere while a key goes out over the network in clear. An address that will
 * not parse is not local, so a typo gets the dialog rather than an exemption.
 *
 * ## Null when nothing would be sent
 *
 * No documents, no column asking for a model, or a cap of zero. A dialog
 * offering to send nothing asks the operator to approve an event that does not
 * happen, and teaches them that this dialog means nothing.
 *
 * ## Requests, not documents
 *
 * The cap counts CALLS. `fill.ts` makes one per eligible cell, so a row with two
 * enabled columns costs two, and a ceiling described as "500 documents" would
 * understate what it stops the moment a second column is enabled. A
 * confirmation that understates the ceiling is the wrong direction to be wrong
 * in, so the wording follows the code rather than the other way round -- and it
 * says what a request is in the same breath, because the operator has no reason
 * to know.
 *
 * ## The character figure is a CEILING this function works out
 *
 * Not a number handed in. `slice.ts` cuts every document down to `budget` before
 * sending it, so quoting the raw size of the folder would tell the operator
 * that several times more of their text is leaving the machine than ever does.
 * The honest figure available before a single file has been opened is
 * `requests x budget` -- a true maximum, bounded by the cap as well, since
 * requests past it are never made -- and it is stated as a maximum rather than
 * dressed up as an estimate.
 */
export function aiConfirmation(input: AiConfirmInput): string | null {
  if (isLoopbackEndpoint(input.baseUrl)) return null;

  const columns = modelColumns(input.profile).length;
  const wanted = Math.max(0, input.documents) * columns;
  // What will actually be attempted. Everything below is quoted from this and
  // not from `wanted`, so the dialog describes the run that happens.
  const requests = Math.min(wanted, Math.max(0, input.cap));
  if (requests === 0) return null;

  const characters = requests * input.budget;
  const stopped =
    wanted > requests
      ? `This batch would ask for ${requestCount(wanted)}; the run stops at your limit of ` +
        `${requestCount(input.cap)}, and every column past it is left blank and flagged.`
      : `Your limit is ${requestCount(input.cap)}, so this run will not reach it.`;

  return [
    `About to send up to ${requestCount(requests)} to ${describeHost(input.baseUrl)}.`,
    '',
    `    model: ${input.model}`,
    `    at most ${count(characters)} characters of document text — up to ${count(input.budget)} from each request`,
    '',
    `One request for each column a model may fill, so a document with two such columns costs two.`,
    stopped,
    '',
    'Everything a model writes is flagged in the spreadsheet for you to check against the document.',
    'Nothing is uploaded to openEQUELLA by this step — it writes into your spreadsheet only.',
  ].join('\n');
}

/** Thousands separated, because 3296000 and 329600 are the same shape at a
 *  glance and this is the figure the operator is being asked to agree to. */
function count(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * A number of requests, in words that read.
 *
 * A one-document folder is the ordinary first thing anybody tries, so "1 model
 * requests" appears on the path every operator takes -- inside the one dialog
 * whose entire job is to be read carefully. Small, and exactly the kind of
 * small that makes a reader trust the rest of it less.
 */
function requestCount(n: number): string {
  return `${count(n)} model request${n === 1 ? '' : 's'}`;
}
