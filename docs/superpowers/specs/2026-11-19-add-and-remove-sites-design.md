# Add, choose and remove sites from the desktop app — design

Date: 2026-11-19. Approved by the operator the same day.

## Why

The operator installed v1.4.0 to upload to production. The app opened on the
test site, and the operator could not find a way to add production. A way
existed: Sign in, then "Settings for {site}…", then Setup's "These credentials
are for" dropdown, then "Add another site…". If the person who knows the app
best could not find it, nobody else will.

Staff should be able to set up several sites, choose the one they want to
connect to, and remove one they no longer need without wiping the rest.

## What exists already

- **Choosing.** The Sign in screen's dropdown lists every saved site.
- **Adding.** Saving a new site in Setup already sets `state.instanceId` to
  the new site and returns to Sign in (`handleSaveSetup`, `settingsReturnTo`).
- **Removing.** Not possible for a single site. "Clear all credentials…" calls
  `clearSettings`, which unlinks the whole store.

## Decisions

1. **"Add another site…" is a link under Sign in's site dropdown, not an
   option in the dropdown.** On Windows, arrowing through a closed `<select>`
   fires `change` for each option passed. An option that navigates would throw
   an operator into Setup while they were only stepping between test and
   production. Setup's own dropdown keeps its existing option, because there it
   only re-seeds the form and never navigates.
2. **The dropdown is labelled "Site", not "Instance".** Every other screen and
   the confirm text say "site".
3. **At startup the app stays on the FIRST saved site** (operator,
   2026-11-19). A session never starts on production because of what was done
   the day before. The live banner still shows once production is chosen.
4. **Setup gains "Remove this site…"** (operator, 2026-11-19), only for a
   saved site. The confirm names everything it deletes:

   > Remove {label} ({address}) from this computer? This deletes its saved
   > password or OAuth credentials and its model settings, and signs you out
   > of it. Your other sites are not changed. To use it again you would add it
   > again.

   It states what is deleted, and only what is deleted. A confirm that
   understates what it confirms collects consent for something else.

## Behaviour

### Adding a site from Sign in

`handleAddSite()`:

- `seedSetupForm('')` (a blank form), then `setupEnteredFrom = 'signin'`.
- New screen event `addSite` goes to `setup`.
- Same refreshes as the other routes into Setup.
- **Back** returns to Sign in with nothing saved, via the existing
  `handleSetupBack`.
- **Save** follows the existing save path: the new site is selected and the
  operator lands on Sign in.

### Removing a site

Main process, new channel `removeInstance(instanceId)`. In this order:

1. `endSessionsFor(instanceId)`. Failures are swallowed, as `forgetPassword`
   does: the removal the operator asked for still happens, and openEQUELLA
   times out an abandoned session anyway.
2. Clear the token store if its stored token belongs to this site's address.
   There is one token store, keyed by base URL.
3. `SecretStore.removeInstance(instanceId)`. This deletes `instances[id]`,
   `passwords[id]` and `models[id]` in one write. Removing a site that is not
   stored is not an error and writes nothing.

Renderer, `handleRemoveSite()`:

- Ask the confirm above. If it is declined, nothing happens.
- After removal: re-list the sites.
  - If the removed site was `state.instanceId`, select the first remaining
    site.
  - If no sites remain, go to Setup as on first run: a blank form and no Back.
  - Otherwise go to Sign in (new event `siteRemoved`) and re-check its sign-in
    state.
  - A selection waiting on Choose belonged to the app's site. It is not
    returned to.
- If the removal fails, the error shows on Setup and the operator stays there.

### Left alone

- **Cached schemas** (`schemaCache.ts`, keyed by address). They hold no
  credentials, they are the site's public schema, and they are reused if the
  site is added again. The confirm does not claim to delete them.
- **Batch records, manifests and spreadsheets.** These are the operator's own
  files.

## Testing

- **`SecretStore.removeInstance`:**
  - removes the site, its password and its model;
  - leaves another site's three untouched;
  - writes nothing for an unknown id.
- **Handler:**
  - ends sessions before the store is changed;
  - clears the token only when it is this site's;
  - still removes the site when ending sessions throws.
- **Sign in markup:**
  - the "Site" label;
  - the "Add another site…" link, wired to its handler.
- **Setup markup:**
  - "Remove this site…" is present for a saved site and absent for
    "Add another site…".
- **Confirm text:** names the label and the address.
- **`nextScreen`:** `addSite` goes to `setup`, and `siteRemoved` goes to
  `signin`.
- **Preload channel list:** includes `removeInstance`. The existing
  `preload-channels` test enforces this.
