# Sign-in and credential states — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make every credential state the desktop app can be in either work, or
say plainly what to do about it — before the operator hits a wall, not after.

**Architecture:** The app already models three sign-in states
(`ui/signin.ts#signinMode`: `missing-credentials` / `needs-signin` /
`signed-in`), derived from `hasSettings` and `currentUser`. What it does **not**
model is that **Setup's collection list needs a signed-in session**, which in
OAuth mode cannot exist until the operator has been to the Sign-in screen. Most
of this plan is making Setup honour the state machine that already exists rather
than inventing a second one beside it.

**Tech Stack:** TypeScript, Electron, vitest. Checked against
`content-test.byui.edu` with a real account.

---

## What "handled" means for each state

Every row is either already true or has a task below. **No row may end in an
error the operator can only understand by reading the source.**

| # | State | What must happen |
| --- | --- | --- |
| 1 | No sites at all (first run) | Setup; no collection list attempted; no error |
| 2 | Site half-typed, not saved | Nothing attempted; Save refuses and names the empty box |
| 3 | Password site saved | Collection list loads immediately |
| 4 | Password site, wrong password | Failure names the sign-in, not "collections" |
| 5 | **OAuth site, no token** | **Setup SAYS to sign in first, before the attempt** |
| 6 | OAuth site, signed in | Collection list loads |
| 7 | OAuth site, expired token | Says expired, and to sign in again |
| 8 | OAuth token issued for another site | Refuses to reuse it, and says why |
| 9 | Password site switched to OAuth | Mode shows OAuth; leftover password ignored |
| 10 | OAuth site switched to password | Password used; stale token ignored |
| 11 | Forget OAuth credentials | Site remains; treated as having no credential |
| 12 | Forget password | Same |
| 13 | Sign out | Token cleared; back to needs-signin |
| 14 | Change credentials | Every site wiped, after a confirm |
| 15 | Redirect URL without trailing slash | openEQUELLA's own reason is surfaced |

**Rows 5 and 7 are the known gaps.** The other thirteen are in this table to be
CHECKED, not assumed — several things were believed correct this morning and
were not.

---

## Task 1: Setup says what a site needs before trying to use it — DONE, confirmed by the operator 2026-08-18

**Files:**
- Modify: `src/desktop/ui/app.ts` — the Setup collection refresh
- Modify: `src/desktop/ui/screens/setup.ts` — the line it shows
- Modify: `src/desktop/ipc.ts`, `src/desktop/handlers.ts`, `src/desktop/preload.cts`
- Test: `tests/desktop/ui/appNavigation.test.ts`

The collection dropdown calls `listCollections`, which needs a signed-in
session. In password mode every call signs in, so it works. In OAuth mode it
cannot work until `exchangeCode` has run once and written `token.enc` — and the
operator meets that as a failure AFTER choosing to look, phrased as a problem
with the collection list.

- [x] **Step 1: Write the failing test**

```typescript
describe('a site that cannot list collections yet', () => {
  it('says an OAuth site needs signing in, without having to fail first', async () => {
    harness = await boot({
      site: { authMode: 'code' },
      storedPassword: null,
      storedOAuth: { clientId: 'c', redirectUri: 'https://x/', hasSecret: true },
      hasToken: false,
    });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();

    expect(harness.app.innerHTML).toMatch(/sign in to this site/i);
    // The point of the whole task: it did not have to try and fail to know.
    expect(harness.calls.listCollections).toEqual([]);
  });

  it('lists collections for a password site with no sign-in step at all', async () => {
    harness = await boot({ site: { authMode: 'password' } });
    await reachChoose(harness.app);
    harness.app.fire('#choose-site-settings');
    await flush();
    expect(harness.calls.listCollections.length).toBeGreaterThan(0);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

`npx vitest run tests/desktop/ui/appNavigation.test.ts -t "cannot list collections"`

- [x] **Step 3: Implement**

Add `hasToken(instanceId)` to the IPC surface, answered in the main process from
the token store. Ask it before refreshing collections: password mode always
proceeds, code mode proceeds only when a token exists.

ASKED, NOT INFERRED FROM A FAILURE. Reading the state is how the screen can say
something before the operator acts; catching an error only lets it explain
afterwards, and this app already does that badly enough.

- [x] **Step 4: Verify** — the new tests, then `npm test`, `npm run typecheck`,
      `npm run build:desktop`.
- [x] **Step 5: Commit.**

### STOP — TEST 1 (operator)

I will relaunch the app. Then:

1. Open **Site settings** on the OAuth site. **Expect:** a plain line saying to
   sign in first, and **no** red error about the collection list.
2. Switch the site to **Username and password**, save, reopen Site settings.
   **Expect:** the collection list loads, with no sign-in step.

Tell me what each one shows before I start Task 2.

---

## Task 2: Sign in from where the operator is standing

**Files:** `src/desktop/ui/screens/setup.ts`, `src/desktop/ui/app.ts`,
test in `tests/desktop/ui/appNavigation.test.ts`

Telling somebody to go back a screen is worse than letting them act. Setup gets
a **Sign in to this site** button, shown only in the state Task 1 detects.

- [ ] **Step 1:** Failing tests — the button appears only for an OAuth site with
      no token; pressing it calls the same `signIn` path the Sign-in screen uses;
      the collection list is refreshed once it returns.
- [ ] **Step 2:** Watch them fail.
- [ ] **Step 3:** Implement, re-run, full suite, commit.

### STOP — TEST 2 (operator)

On the OAuth site, press **Sign in to this site** from Site settings.

- If the browser window completes, the collection list should populate **without
  you leaving the screen**.
- If it fails with "No OAuth client can be found", that is row 15 — the
  **trailing slash** on the redirect URL. Add it and try again.

Tell me which happened, and paste the message if it failed.

---

## Task 3: An unusable token says which kind of unusable, and a refused one offers a way out

**Widened 2026-08-19 by the case that worked.** `hasToken` reads the STORE, so
a token that exists and is REFUSED by the server is indistinguishable from a
good one. That state gets no sign-in button (Task 2 hides it when a token
exists) AND a failing collection list — the worst pairing available, and
unrecoverable without leaving the screen. It is what the operator hit for two
sessions. So this task must also:

- [ ] Offer the **Sign in to this site** button when the collection list fails
      with an authentication error, not only when no token is stored. A token
      the server refuses is a reason to sign in again, and the screen should
      say so rather than leaving the operator with an error and no control.


**Files:** `src/core/authCode.ts` (messages only), `tests/authCode.test.ts`

`getToken` already tells absent, expired and issued-for-another-instance apart,
and the desktop now substitutes a front-end-appropriate instruction. What it
does not do is make the DIFFERENCE actionable: expired means "sign in again",
cross-instance means "this token belongs to another site".

- [ ] **Step 1:** Tests pinning that all three reasons survive into the message
      the desktop shows, and that they differ from one another.
- [ ] **Step 2:** Watch them fail; implement; re-run; commit.

### STOP — TEST 3 (operator)

Only once a token exists: press **Sign out**, then open Site settings.
**Expect:** the "needs signing in" line again — not a stale collection list.

---

## Task 4: Switching a site between password and OAuth

**Files:** tests only, unless something is found.

Rows 9 and 10. Both are believed correct after today's `authMode` fix, and both
leave something behind that must be ignored rather than acted on: a password
entry left by a switch to OAuth, and a `token.enc` left by a switch back.

- [ ] **Step 1:** Tests — a site stored as `code` that still has a password entry
      uses OAuth; a site stored as `password` that still has a token uses the
      password.
- [ ] **Step 2:** If either fails, fix it. Commit either way.

### STOP — TEST 4 (operator)

Switch the site password → OAuth → password, saving each time and opening Site
settings after each. **Expect:** the radio always shows what you last saved, the
boxes match it, and the collection list behaves per rows 3 and 5.

---

## Task 5: Forgetting, and the difference between the three Forgets

**Files:** tests; `src/desktop/ui/screens/setup.ts` if the wording is unclear.

Rows 11 to 14. There are now three destructive controls and they differ sharply:
**Forget this password** (one site's account), **Forget these OAuth credentials**
(one site's client), and **Change credentials** (every site, after a confirm —
it deleted the whole dev store this morning).

- [ ] **Step 1:** Tests that each removes only what it names, and that a site
      whose credential has been forgotten reports `missing-credentials`.
- [ ] **Step 2:** Fix anything that removes more than it says. Commit.

### STOP — TEST 5 (operator)

**Do this last, and on the dev build only** — it clears real settings.

1. **Forget these OAuth credentials.** Expect: the site stays in the list, its
   boxes empty, and Sign-in reports missing credentials.
2. Re-enter them and save.
3. Read the wording on **Change credentials** and tell me whether it is clear
   that it wipes *every* site rather than just this one.

---

## Deliberately not in this plan

- **Extraction, the model pass, duplicates and upload.** Scoped out with the
  operator; this is the credential path only.
- **The 403 from `content-test` on a rejected OAuth token.** That is a property
  of that instance's OAuth client registration, not of this app, and nothing
  here changes it. Password mode is the configuration that has demonstrably
  uploaded a real batch to this instance.
- **Making OAuth the recommended mode.** It is not, on this evidence.
