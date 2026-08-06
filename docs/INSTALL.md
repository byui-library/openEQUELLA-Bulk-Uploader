# Installing the openEQUELLA Bulk Uploader

This guide is for the person who will actually run the program — not for a
developer. It assumes you have never used a command line and don't need to
start now. If a step doesn't work the way this guide describes, skip ahead to
[If something goes wrong](#if-something-goes-wrong).

## What you need before you start

Two things, and you cannot get either one from this program:

1. **The program itself**, copied from the network share (see below).
2. **A client ID, a client secret, and a redirect URL**, given to you
   separately by your administrator — usually by email or in person, never as
   part of the download. These are what let the program sign in to
   openEQUELLA as you. Without them, the program opens fine but cannot do
   anything.

If you don't have the client ID, secret, and redirect URL yet, ask your
administrator before going any further. There's nothing to configure in the
program until you have them.

## Step 1: Copy the program from the network share

Your administrator will tell you where the network share is. Copy the whole
folder to somewhere on your own computer — your Desktop or Documents folder
is fine. Do not run it directly from the network share; copy it locally
first, then run it from there.

Two versions of the program are provided. They are the same program — the
difference is only in how it gets onto the computer.

- **`openEQUELLA Bulk Uploader 0.1.0.exe`** — a single file. Double-click it
  to run; nothing is installed anywhere.
- **`openEQUELLA Bulk Uploader Setup 0.1.0.exe`** — an installer. Adds a Start
  Menu shortcut and an entry in Add or Remove Programs, like a normal Windows
  program.

### Which one should I use?

| | Single file | Installer |
| --- | --- | --- |
| Shows up in the Start Menu | No | Yes |
| Can be uninstalled normally | No — just delete it | Yes |
| Needs an administrator | Never | No, if you take the default |
| Security warning (Step 2) | Every time you're given a new copy | Once, when you install |
| To update it | Replace the file | Run the new installer |

**If you're going to use this more than once, take the installer.** The main
reason is the security warning: with the installer you see it once, at install
time. With the single file you'll see it again every time someone sends you an
updated copy, and it's alarming enough that people stop and ask whether the
program is safe.

**Take the single file if** you're just trying it out, you're on a shared or
lab computer you'd rather not install things onto, or your computer blocks
installers.

**You can switch later.** Both versions keep your settings and sign-in in the
same place, so if you start with the single file and install it properly
afterwards, you won't have to enter your credentials again.

If you use the installer, one screen asks **who** to install it for. Leave
the default option selected — it installs just for you and needs no special
permissions. If a Windows prompt appears asking for an administrator's
permission, you've picked the "install for all users" option by mistake:
go back and choose the default (per-user) option instead, or close the
installer and use the single-file version above, which never asks this
question at all.

## Step 2: The security warning (this is expected)

The first time you run the program, Windows will almost certainly show a blue
or gray screen titled **"Windows protected your PC"**, with the program name
underneath. This is normal — it is **not** a sign that something is wrong or
dangerous.

Here's why it appears: this program isn't yet digitally signed with a
certificate that Windows recognizes. That's a paperwork/cost step, not a
safety one — Windows shows this warning for *any* unsigned program, no matter
how safe it is, the first time it's run on a computer.

This is what it looks like:

![The Windows SmartScreen warning: a blue dialog headed "Windows protected your PC", with a "More info" link below the message and a "Don't run" button in the corner](images/smartscreen.png)

Note there is no "Run anyway" button visible at first — only **Don't run**.
That is deliberate on Microsoft's part, and it is where most people give up.
Click **More info** and the button appears.

To continue past it:

1. Click **More info** (a small link, usually below the message).
2. A new button appears: click **Run anyway**.

That's it — the program opens normally. Windows won't ask again on that
computer once you've done this once for this program.

If you don't see a **More info** link, or the button is missing entirely, ask
your administrator — occasionally IT policy on a given computer blocks it
outright rather than just warning about it.

## Step 3: First run — entering your credentials

The first time the program opens, it shows a **Set up the Bulk Uploader**
screen. This is where you enter the client ID, client secret, and redirect
URL your administrator gave you (see [What you need before you start](#what-you-need-before-you-start)
if you don't have them yet).

A few things worth knowing about this screen:

- **These three values are specific to you and to one openEQUELLA instance**
  (Production or Test). Most people only ever need Production — leave that
  selected unless your administrator specifically told you to use Test.
- **Type or paste them exactly.** The redirect URL in particular has to match
  what your administrator registered character-for-character, including
  whether or not it ends with a slash (`/`). If sign-in fails later with an
  error mentioning `redirect_uri`, this is the first thing to check.
- Once saved, these are stored **encrypted, for your Windows user account
  only**, using the same protection Windows uses for saved passwords. Nobody
  else who logs into this computer can read them, and they never leave this
  machine except to sign in to openEQUELLA itself.
- The program is never shipped with these values already filled in. If you
  see them pre-filled, or if a colleague's copy of the program already has
  your name signed in, something is wrong — stop and ask your administrator.

## Step 4: Signing in

After Setup, click **Sign in**. A window opens showing the normal openEQUELLA
/ university sign-in page — sign in there exactly as you would in a web
browser. When it's done, the window closes by itself and the program shows
**"Signed in as `<your name>`."**

That name matters: it's who will own every item the program creates during
this session. If it shows the wrong name, sign out and sign in again as
yourself before doing any uploads.

## Try it first: the built-in starter kit

Before you build your own spreadsheet, it's worth doing one real test upload
using the starter kit built into the program — it takes a minute and proves
your sign-in, collection, and spreadsheet all work together before you risk
any real data on it.

Once you're signed in, on the **Choose what to upload** screen there's a
button next to the spreadsheet picker: **Save a template and sample file…**.
Click it and pick any folder — your Desktop is fine. The program saves two
files there:

- **`upload-template.csv`** — a spreadsheet with the real column headers the
  program expects (the ones your administrator's schema actually uses, not
  guesses), already filled in with one example row.
- **`sample-upload.txt`** — a small text file that example row uploads as its
  attachment.

The example row's title is deliberately **`TEST UPLOAD - safe to delete`** —
so if you go through with it, the item it creates in openEQUELLA is
unmistakable and easy to find again afterward.

To run the test upload:

1. Set the **files folder** (step 3 on the Choose screen) to the folder you
   just saved the two files into.
2. Set the **spreadsheet** (step 2) to `upload-template.csv` in that same
   folder.
3. Pick any collection you have access to, then continue through Review and
   Confirm as you normally would.

This creates one real **draft** item in openEQUELLA — go find and delete it
there once you've confirmed the upload worked. Nothing about running this
test is different from a real batch; it's the same code path, just with a
spreadsheet and file the program already knows are correct.

## Building a spreadsheet from your files

If you have a folder of PDFs or Word documents and no spreadsheet, the program
can build one for you. On the **Choose what to upload** screen, click
**I don't have a spreadsheet yet…**.

It works in three steps:

1. **Choose the folder.** The program says how many files it can read, and
   lists any it cannot — nothing is skipped silently.
2. **Set up the columns.** It shows one of your filenames broken into parts, and
   a list of the columns your spreadsheet will have. Add, remove and reorder
   them, and say where each one's value comes from. A preview of the first few
   files updates as you go.

   You start with four columns already there: the file itself, **Title** and
   **Creator** (both read from the document's own properties, where most PDFs
   and Word files record them), and an empty **Description** for you to fill in.
   Remove any you don't want — nothing is compulsory except the file itself,
   which is how each row is matched to its document.

   Removing a column offers an **Undo** straight away, so it is safe to try.

   If your Word documents keep their information in a **table** — a row of
   headings like *Company*, *Job Title*, *Date*, with the values underneath —
   those headings appear in the source list as **Table column: Job Title** and
   so on. Pick one and the whole cell comes across, however long it is.
3. **Save.** The spreadsheet is written where you choose.

**Then open it in Excel and check it before uploading.** This step guesses, and
everything else the program does doesn't. Two extra columns help you check:

- `_notes` — rows that need a look, and why
- `_source` — where each value came from

The uploader ignores both, so you can leave them in place.

`_source` earns its keep on titles in particular. Most documents record a
sensible title, but a fair few record something left over from how the file was
made — an internal reference number, or the name of the Word file it was
exported from. Sort by `_source` in Excel, glance down the rows that say
`title=properties`, and you will spot those in a moment.

### If the dates come out wrong

Dates are the thing most likely to need a second look. A date written as
`12032025` could be 3 December or 12 March — the program will not guess, so it
leaves the value alone and flags the row. If all your files name dates the same
way, ask your administrator to set the date format in the profile once, and it
will read them correctly from then on.

A date that is only a year, like `1953`, is kept exactly as it is rather than
being turned into the 1st of January.

If you will do this again with the same kind of files, click **Save profile…**
so you don't have to set the columns up next time.

## What happens when you upload

This guide covers installing and starting the program, not the full upload
process — the program itself walks you through choosing a spreadsheet, a
folder of files, and reviewing everything before anything is sent. The one
thing worth knowing in advance:

**You choose whether items are created as drafts or published**, on the screen
just before the upload starts. Both are supported.

- **Draft** (the default) — the item exists in openEQUELLA but is not visible
  to others. For some collections this is the finished state; for others
  someone submits them afterwards inside openEQUELLA. Ask whoever asked you to
  run the upload which applies. This program never submits anything for you.
- **Published** — items become visible to everyone immediately.

Publishing asks you to **type the number of items** before the upload button
becomes available. That is deliberate, not a glitch. The collection this tool
was built for has no review queue, so published means visible straight away,
and there is no undo from inside the program. If nobody told you to publish,
choose Draft.

## If something goes wrong

- **The SmartScreen warning won't let you past "More info."** Ask your
  administrator — this can mean local IT policy is blocking unsigned
  programs on that specific computer.
- **Sign-in fails, or the program reports an error page from openEQUELLA
  itself.** Double- and triple-check the redirect URL you entered in Setup
  against what your administrator gave you — this is by far the most common
  cause, and it has to match exactly, including a trailing slash if there is
  one.
- **The program says no credentials are saved**, even though you entered
  them. Credentials are saved separately for Production and Test — make sure
  you're on the instance (shown at the top of every screen) you actually
  configured.
- **A row failed during upload.** The Results screen at the end lists exactly
  which rows failed and why, and has a **Retry failed** button. This does not
  retry the whole batch — only the rows that failed.
- **Nothing above covers it, or you're not sure what happened.** Contact your
  administrator with a screenshot of whatever error message you see. Don't
  guess and don't retry an upload you're unsure about — ask first, especially
  if it says something was left "interrupted."
