# Desktop GUI and Distribution — Design

**Date:** 2026-08-04
**Status:** Approved
**Builds on:** [2026-08-03-oeq-bulk-uploader-design.md](2026-08-03-oeq-bulk-uploader-design.md)

## Problem

The tool works — 37 items contributed to production, every one verified. But it
is a CLI that requires Node, a terminal, a hand-edited `.env`, and an OAuth
dance that took three attempts to get right even with an expert driving.

To hand it to department staff it needs to be an application they can
double-click, with no prerequisites and nothing to configure by hand except a
client ID and secret delivered separately.

## Decisions

| Question | Decision |
| --- | --- |
| Audience | Non-technical Windows staff, zero prerequisites |
| Form factor | Electron desktop app |
| GUI scope | Includes in-app column-mapping help |
| Credential storage | Per-user OS encryption (see "Credentials") |
| Target control | Instance dropdown + permission-derived collection picker |
| Item state | Draft default; publish behind a typed confirmation |
| Distribution | Network share, unsigned initially |

## Architecture

The existing core is reused **unchanged**. Its 252 tests continue to apply, and
nothing about the wire format, runner, or manifest semantics is revisited.

```text
src/core/      untouched
src/cli/       untouched -- stays for maintainer use
src/mcp/       untouched
src/desktop/
  main.ts        Electron main process; owns all core calls and filesystem access
  auth.ts        Sign-in in an embedded BrowserWindow
  secrets.ts     Encrypted credential + token storage
  ipc.ts         Typed request/response channel
  ui/            Renderer: HTML/CSS/TS
```

**The renderer has no Node integration and never imports core.** It sends
intents over IPC and renders results. `contextIsolation` on, `nodeIntegration`
off, a narrow preload exposing only the typed IPC surface. This is the standard
Electron security posture, and it also means the UI cannot bypass a safety rail
by reaching around it.

## Screens

1. **Setup** — first run only. Paste client ID and secret. Explains they come
   from the administrator, separately from the app.
2. **Sign in** — one button. Opens the embedded window. Ends showing
   "Signed in as \<name\>", which is also the answer to *who will own these items*.
3. **Choose** — instance, collection, spreadsheet, files folder.
4. **Review** — the substantive screen. See below.
5. **Confirm** — counts, instance, collection, item state.
6. **Progress** — per-file status, running totals, cancel.
7. **Results** — created/failed counts, per-row errors, retry failed, link to
   the collection.

### The Review screen

This is where the GUI earns its existence, and it is the reason the MCP server
was built in the first design: the schema has 158 valid leaf xpaths and getting
a column header wrong produces an item that looks fine and silently lost a field.

It shows:

- **Every column**, marked valid or invalid. Invalid ones get nearest-match
  suggestions from `schema.ts#suggest` and a control to remap without editing
  Excel. A remap is an in-memory override applied when the manifest is built —
  the user's spreadsheet file is never modified. Overrides are discarded when
  the app closes; they are a fix for this run, not a saved mapping profile.
  (A saved profile is a plausible v2 feature but is deliberately not in scope.)
- **Row-to-file matching** — how many rows matched, which rows name a file that
  isn't present, which files have no row.
- **Duplicate identifiers** already in the target collection, from
  `preflightDuplicates`. Advisory, never a silent skip.

Nothing uploads from this screen.

## Sign-in

Electron loads openEQUELLA in a `BrowserWindow` and watches its own navigation
events, capturing `?code=` directly. No pasting, no browser-history hunting, no
localhost redirect to register.

Two behaviours are carried over from what the live runs taught us, and both are
required:

1. **Establish the session first.** Load the instance root and wait until
   `/api/content/currentuser` reports a non-guest user, *then* navigate to
   `/oauth/authorise`. Going straight there while logged out bounces through
   Okta, which returns to a bare `/oauth/authorise` with the query string
   stripped, and openEQUELLA reports `client_id (null)`.
2. **Send `redirect_uri` verbatim.** Production registers it without a trailing
   slash; test registers it with one. Never normalise. Capture must match on the
   instance's own **origin** — signing in through SSO also produces a `?code=`
   on `id.churchofjesuschrist.org`, and taking that one yields an exchange that
   fails obscurely.

## Credentials

Stored with Electron's **`safeStorage`**, which on Windows encrypts via DPAPI —
the same OS mechanism backing Credential Manager — with the ciphertext held in
the app's user-data directory. Same per-user protection; no native module, so no
additional build toolchain.

Covers both the client secret and the access token. The token matters as much as
the secret: it authenticates fully as that person, and openEQUELLA reports an
expiry measured in weeks.

**No credentials are ever built into the distributable.** The app ships with
empty settings; `.env` is not bundled. The administrator delivers the client ID
and secret out of band.

A **Sign out** action clears the stored token, and a **Reset settings** action
clears everything including the client credentials.

## Safety rails

The collection UUID is byte-identical on test and production, so the instance is
the *only* thing distinguishing them. A `.env` line checked by eye does not
survive contact with a dozen users.

- **Instance banner**, always visible, naming the instance. Production is
  visually distinct (red).
- **Collection picker is permission-derived** — fetched via
  `CREATE_ITEM`, so a collection the user cannot contribute to is not offered.
- **Publish requires typing the item count** into a dialog that names the
  instance and collection, and states there is no moderation workflow. A dialog
  with an OK button is not a safeguard; people click through those.
- Carried over unchanged from the core: a token minted for one instance is
  refused against another; the job lock prevents concurrent runs against one
  manifest; interrupted rows are never silently reprocessed.

## Error handling

- Every core error already carries operator-facing text; the UI surfaces it
  rather than replacing it with a generic message.
- Per-row failures do not stop the batch. The Results screen lists each failed
  row with its reason and offers **Retry failed**, which maps to the existing
  retry semantics — `failed` rows only, never `interrupted` ones.
- A row left `interrupted` by a previous run is reported with the same
  explanation the CLI gives, and requires an explicit acknowledgement before it
  is reprocessed.
- The manifest is written to the app's user-data directory, so a crashed run is
  resumable on next launch. The Results screen offers to resume it.

## Packaging and distribution

`electron-builder` produces a portable folder and an NSIS installer, unsigned.

Ships with a short setup note covering the SmartScreen warning ("More info →
Run anyway") with a screenshot, and where to get the client ID and secret.

Signing is a later build-config change requiring only a certificate; nothing in
the application code depends on it.

## Testing

- **Core**: unchanged, 252 tests.
- **New unit tests**: the credential adapter (round-trip, reset, corrupt-blob
  handling) and the mapping/override logic.
- **Electron smoke test**: scripted launch verifying the window opens, IPC
  responds, and Setup appears on a clean profile.
- **Manual**: the packaged executable on a machine with no Node installed —
  the only way to prove the "zero prerequisites" claim, and the one thing no
  automated test in this repo can establish.

## Out of scope

- macOS. Windows only, per the audience decision.
- Auto-update.
- Editing metadata values in-app; Excel does that well already.
- Automating shared owners; still applied via Manage Resources.
- Replacing the CLI or MCP server; both remain for maintainer use.
