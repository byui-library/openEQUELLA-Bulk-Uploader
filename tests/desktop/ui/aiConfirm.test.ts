// tests/desktop/ui/aiConfirm.test.ts
import { describe, it, expect } from 'vitest';
import { aiConfirmation, type AiConfirmInput } from '../../../src/desktop/ui/aiConfirm.js';
import { ATTACHMENT_COLUMN, type Profile } from '../../../src/core/extract/types.js';

/** One column asking for a model, which is what ships. */
const profile: Profile = {
  version: 1,
  pattern: '{part1}.pdf',
  columns: [
    { path: ATTACHMENT_COLUMN, sources: [{ filename: true }], locked: true },
    { path: 'MWDL/title', sources: [{ filenameStem: true }] },
    { path: 'MWDL/description', sources: [{ opening: true }, { ai: true }] },
  ],
};

const input = (over: Partial<AiConfirmInput> = {}): AiConfirmInput => ({
  profile,
  documents: 412,
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  budget: 8000,
  cap: 500,
  ...over,
});

describe('aiConfirmation', () => {
  it('names the count, the host and the model before anything is sent', () => {
    const text = aiConfirmation(input())!;
    expect(text).toContain('412');
    expect(text).toContain('gpt-4o-mini');
    expect(text).toMatch(/api\.openai\.com/);
  });

  /**
   * NAMES THE LIMIT AS A LIMIT. Asserting only that "500" appears somewhere is
   * a test that passes with the cap sentence deleted entirely -- the headline
   * count is already 500 once the cap has bitten -- which is a guard that reads
   * as if it protects something and does not. Written first that way, and
   * caught by removing the sentence and watching this stay green.
   */
  it('says where the cap will stop it, and that it is a limit', () => {
    expect(aiConfirmation(input({ documents: 900 }))).toMatch(/limit of 500/);
  });

  it('says the limit is there even when this run will not reach it', () => {
    expect(aiConfirmation(input())).toMatch(/limit is 500/);
  });

  /**
   * A local run costs nothing and sends nothing off the machine. A dialog there
   * is friction that teaches the operator to click past dialogs -- which is
   * what makes the hosted one worthless.
   *
   * THE PREDICATE IS `isLoopbackEndpoint` FROM `core/ai/endpoint.ts`, not a
   * second one written here. That module exists precisely so this decision and
   * `provider.ts`'s refusal to send a key over plain http cannot drift into
   * disagreeing about what "local" means -- a disagreement that shows up as a
   * dialog promising nothing is being sent while a key crosses the network.
   */
  it.each([
    ['localhost', 'http://localhost:11434/v1'],
    ['127.0.0.1', 'http://127.0.0.1:11434/v1'],
    ['elsewhere in 127.0.0.0/8', 'http://127.1.2.3:8080/v1'],
    ['the IPv6 loopback', 'http://[::1]:11434/v1'],
    ['a .localhost name', 'http://ollama.localhost/v1'],
  ])('is not shown for an endpoint on this machine (%s)', (_label, baseUrl) => {
    expect(aiConfirmation(input({ baseUrl, model: 'llama3' }))).toBeNull();
  });

  /** A private LAN address is somebody else's machine on a network with other
   *  people's machines on it. It is genuinely being sent somewhere. */
  it('is shown for a private LAN address, which is not this machine', () => {
    expect(aiConfirmation(input({ baseUrl: 'http://192.168.1.10:11434/v1' }))).not.toBeNull();
  });

  /** An address that will not parse is not local. The unknown case has to be
   *  the cautious one, or a typo exempts a run from the whole check. */
  it('is shown for an address that will not parse', () => {
    expect(aiConfirmation(input({ baseUrl: 'not a url' }))).not.toBeNull();
  });

  // --- what the count is actually counting ---------------------------------

  /**
   * THE COUNT IS OF REQUESTS, AND ONLY OF COLUMNS A MODEL MAY WRITE. Three of
   * the profile's columns are not among them -- an ordinary column, the locked
   * attachment column, and a compose-only one -- and counting any of them would
   * quote the operator a number for work that is never done.
   */
  it('counts only the columns whose profile asked for a model', () => {
    // Three columns, exactly one of which asked. 412 documents, 412 requests.
    expect(aiConfirmation(input())).toContain('412');
    expect(aiConfirmation(input())).not.toContain('1236');
  });

  it('counts one request per model column, so two columns cost twice', () => {
    const two: Profile = {
      ...profile,
      columns: [...profile.columns, { path: 'MWDL/abstract', sources: [{ ai: true }] }],
    };
    expect(aiConfirmation(input({ profile: two, documents: 10, cap: 500 }))).toContain('20');
  });

  /**
   * NEITHER OF THESE CAN EVER BE SENT, whatever a profile asks for, and
   * `eligibleColumns` already refuses both -- the attachment column names the
   * file on disk, and a composeOnly column is dropped before it gets a cell.
   * The count is built from that same rule rather than from a second reading of
   * the profile, so it cannot quote a number the run will not make.
   */
  it.each([
    ['the attachment column', { path: ATTACHMENT_COLUMN, sources: [{ ai: true as const }], locked: true }],
    ['a compose-only column', { path: 'MWDL/x', sources: [{ ai: true as const }], composeOnly: true }],
  ])('never counts %s, which can never be sent', (_label, column) => {
    const bad: Profile = { ...profile, columns: [column] };
    expect(aiConfirmation(input({ profile: bad, documents: 10 }))).toBeNull();
  });

  it('is not shown when no column asked for a model — there is nothing to send', () => {
    const none: Profile = { ...profile, columns: [{ path: 'MWDL/title', sources: [{ filenameStem: true }] }] };
    expect(aiConfirmation(input({ profile: none }))).toBeNull();
  });

  it('is not shown when the folder holds no documents', () => {
    expect(aiConfirmation(input({ documents: 0 }))).toBeNull();
  });

  /** A cap of zero means "make no requests at all". Nothing is sent, so there
   *  is nothing to confirm -- and a dialog saying "about to send 0" is asking
   *  the operator to approve an event that does not happen. */
  it('is not shown when the cap stops every request', () => {
    expect(aiConfirmation(input({ cap: 0 }))).toBeNull();
  });

  // --- the cap's unit ------------------------------------------------------

  /**
   * REQUESTS, NOT DOCUMENTS. `fill.ts` counts calls: a row with two enabled
   * columns costs two, so a cap of 500 described as "500 documents" would
   * understate what it stops the moment a second column is enabled. A
   * confirmation that understates the ceiling is the wrong direction to be
   * wrong in, so the dialog is made to agree with the code rather than the
   * reverse -- and it says in plain words what a request is, because the
   * operator is not expected to know.
   */
  it('describes the cap in requests, and says what a request is', () => {
    const text = aiConfirmation(input())!;
    expect(text).toMatch(/requests/);
    expect(text).toMatch(/one request for each column/i);
    expect(text).not.toMatch(/stops after \d+ documents/i);
  });

  it('names the ceiling as what actually runs when the batch would exceed it', () => {
    const text = aiConfirmation(input({ documents: 900 }))!;
    // 900 wanted, 500 allowed: the headline is what will happen.
    expect(text).toMatch(/up to 500 model requests/);
    expect(text).toMatch(/900/);
    expect(text).toMatch(/left blank and flagged/i);
  });

  // --- the volume ----------------------------------------------------------

  /**
   * THE CHARACTER FIGURE IS A CEILING THE DIALOG WORKS OUT, not a number the
   * caller hands in. `slice.ts` cuts each document down to `budget`, so a raw
   * document total would tell the operator that far more text is leaving their
   * machine than ever does -- and a figure the caller supplies is a figure the
   * caller can get wrong, silently, in exactly that direction. The honest
   * number available before a single file has been read is requests x budget,
   * and it is stated as a maximum rather than as an estimate.
   */
  it('states the volume as a ceiling derived from the budget, not as an estimate', () => {
    // 412 requests x 8000 characters = 3,296,000.
    const text = aiConfirmation(input())!;
    expect(text).toMatch(/at most/i);
    expect(text).toMatch(/3,296,000 characters/);
    expect(text).toContain('8,000');
  });

  it('bounds the volume by the cap too, because the rest is never sent', () => {
    // 900 wanted but 500 allowed: 500 x 8000, not 900 x 8000.
    const text = aiConfirmation(input({ documents: 900 }))!;
    expect(text).toMatch(/4,000,000 characters/);
    expect(text).not.toMatch(/7,200,000/);
  });

  // --- the promise ---------------------------------------------------------

  /**
   * TRUE WHERE THIS IS WIRED IN, and checked rather than assumed. The extract
   * flow ends at `extractRun`, which writes a CSV to a path the operator picks;
   * uploading is a separate flow reached from Choose, with its own confirmation
   * screen. Nothing on this path contacts openEQUELLA at all. If the two flows
   * are ever joined, this sentence becomes a promise the code does not keep.
   */
  it('says plainly that this step uploads nothing to openEQUELLA', () => {
    expect(aiConfirmation(input())).toMatch(/nothing is uploaded to openEQUELLA/i);
    expect(aiConfirmation(input())).toMatch(/spreadsheet/i);
  });

  it('says every model-written value is flagged for checking', () => {
    expect(aiConfirmation(input())).toMatch(/flagged|check/i);
  });
});
