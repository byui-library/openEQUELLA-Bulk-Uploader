# Installing the openEQUELLA Bulk Uploader

This guide is for the person who will actually run the program — not for a
developer. It assumes you have never used a command line and don't need to
start now. If a step doesn't work the way this guide describes, skip ahead to
[If something goes wrong](#if-something-goes-wrong).

## What you need before you start

Three things, and you cannot get any of them from the program itself:

1. **The program**, copied from the network share (see below).
2. **The web address of your openEQUELLA site** — the same one you type into a
   browser to use openEQUELLA, for example `https://oeq.yourschool.edu`. It
   must start with `https`; the program will not accept an address that starts
   with `http`, and there is a good reason for that (your password is sent as
   part of the web address when signing in, so an unencrypted connection would
   expose it).
3. **A username and password for openEQUELLA** — for most people, the ordinary
   one you already use on the site itself.

That is the usual case. **If your institution signs in through single sign-on**
— you are bounced to a university login page rather than typing a password into
openEQUELLA — an ordinary password will not work, and you need something else
instead: **a client ID, a client secret, and a redirect URL**, given to you by
your administrator, usually by email or in person and never as part of the
download. BYU-Idaho is in this situation. See
[If your site uses single sign-on](#if-your-site-uses-single-sign-on) below.

Either way, ask your administrator before going any further if you are not sure
which applies. There is nothing to configure in the program until you know.

### If you have used this program before

**You will be asked for your sign-in details once more.** This version stores
them differently, so the ones saved by version 1.0.0 cannot be read and are
discarded rather than half-understood; the Setup screen says so when it happens.
Enter them again and it will not ask a second time.

## Step 1: Copy the program from the network share

Your administrator will tell you where the network share is. Copy the whole
folder to somewhere on your own computer — your Desktop or Documents folder
is fine. Do not run it directly from the network share; copy it locally
first, then run it from there.

Two versions of the program are provided. They are the same program — the
difference is only in how it gets onto the computer.

- **`openEQUELLA Bulk Uploader 1.1.1.exe`** — a single file. Double-click it
  to run; nothing is installed anywhere.
- **`openEQUELLA Bulk Uploader Setup 1.1.1.exe`** — an installer. Adds a Start
  Menu shortcut and an entry in Add or Remove Programs, like a normal Windows
  program.

The number in the filename is the version. If the copy on the share is newer
than 1.1.1, take that one — everything below still applies.

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

## Step 3: First run — entering your site and sign-in

The first time the program opens, it shows a **Set up the Bulk Uploader**
screen. It arrives blank: the program does not know which openEQUELLA site you
use, and is not shipped knowing anybody's.

Fill in, top to bottom:

1. **Site address** — for example `https://oeq.yourschool.edu`.
2. **A name for it** — whatever you call it, such as *Production* or *Test*.
   This is only a label for you; it is what the coloured bar across the top of
   every screen will show, so make it something you will recognise at a glance.
3. **Username** and **Password** — your ordinary openEQUELLA sign-in. This is
   selected for you as the sign-in method, and it is the right one for most
   institutions.

Then click **Save credentials**.

A few things worth knowing about this screen:

- **These details are saved per site.** If you use both a real site and a test
  one, each gets its own entry, and the dropdown at the top of the screen
  switches between them. `Add another site…` at the bottom of that list is how
  you add the second one.
- Once saved, they are stored **encrypted, for your Windows user account
  only**, using the same protection Windows uses for saved passwords. Nobody
  else who logs into this computer can read them, and they never leave this
  machine except to sign in to openEQUELLA itself.
- The program is never shipped with any of this already filled in. If you see
  it pre-filled, or if a colleague's copy already has your name signed in,
  something is wrong — stop and ask your administrator.
- To change a saved password later, come back to this screen: a stored one
  shows as **"Signed in as …"** with a **Forget this password** button beside
  it. Leaving the password box empty when you save means *leave the stored one
  alone*, so that button is the only way to remove it.

### Come back to Setup once, after you have signed in

Three more settings appear on this screen **only after the site has been saved
and you have signed in** — the program has to ask openEQUELLA for them, so they
cannot be shown before that. Reach it again from the Sign-in screen's
**Settings for …** button, or from **Site settings for …** at the foot of the
screen where you choose a collection or the one that reports a finished batch.
Saving from there puts you straight back where you were, with your collection,
spreadsheet and folder still chosen — and if you only came to look, the
**Back to …** button leaves without saving anything. None of those routes
touches your saved password. (**Clear all credentials…**, beside the first of
them, is the one that does: it clears every site you have added.)

**Pointed at the wrong site?** The bar across the top names the site you are
about to upload to, and **Sign out of …** — at the foot of the same two
screens — ends that session and returns you to Sign-in, where you can pick a
different one. It is offered only before a batch starts and after one has
finished; while files are uploading there is deliberately no way off that
screen.

- **Collection you contribute to** — a dropdown of the collections your account
  is actually allowed to add to, read from your site. You never have to find or
  type a long identifier. If it says this account can contribute nowhere, that
  is a permission your administrator grants, not something you have typed
  wrongly.
- **Field that records the attachment ID** — usually you do not have to touch
  this. Your files are attached to their items whether or not it is filled in.
  Some schemas *also* keep that ID as a metadata field of their own, so it can
  be searched and exported, and where yours declares exactly one such field the
  program fills it in for you as soon as you choose a collection above. The
  line underneath the box says so when it has, and you are free to change it or
  clear it.

  Where your schema declares **no** such field the box stays blank and the line
  says the schema has none — nothing is missing and there is nothing to do.
  Where it declares **more than one**, the program fills in nothing and names
  them all: only your institution knows which one it uses, and you can pick from
  the box's own dropdown. Whatever ends up in the box, that line tells you
  whether it really exists in your collection's schema.
- **"This is a live site — items created here are real"** — leave this ticked
  unless you know the address is a test or training instance. When it is
  ticked, the bar across the top of every screen stays loud and red, which is
  the only thing telling you which site you are uploading to.

### If your site uses single sign-on

If your institution bounces you to a university login page instead of taking a
password directly — BYU-Idaho does — an ordinary password will not work here.
Open **Advanced: OAuth client credentials** on the Setup screen and fill in the
client ID, client secret and redirect URL your administrator gave you.

**Type or paste the redirect URL exactly.** It has to match what your
administrator registered character-for-character, including whether or not it
ends with a slash (`/`). If sign-in fails later with an error mentioning
`redirect_uri`, this is the first thing to check.

## Step 4: Signing in

After Setup, click **Sign in**.

- **With a username and password**, nothing opens — the program signs in
  directly and the screen updates.
- **With single sign-on**, a window opens showing the normal openEQUELLA /
  university sign-in page. Sign in there exactly as you would in a web browser.
  When it's done, the window closes by itself.

Either way the program then shows **"Signed in as `<your name>`."**

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

   **The columns arrive already filled in**, worked out from your actual files.
   Before showing you this screen the program opens a few of them and looks at
   what is inside, so if your Word documents keep their information in a table
   with headings like *Company*, *Job Title*, *Job Description*, *Date*, it will
   already have matched those to the right fields.

   It only matches a heading whose name lines up with a field in your schema.
   *Job Title* becomes the title, *Job Description* becomes the description —
   but *Company*, *Pay* and *Qualifications* mean nothing to this schema, so
   they are left alone rather than put somewhere that looks plausible. Add them
   yourself if you want them.

   Where a column shows **two** sources, it tries them in order and takes the
   first that isn't empty. That is how one setup can serve a folder holding both
   Word files and PDFs: the Word files have a *Job Title* cell, the PDFs record
   their title as a document property instead.

   Nothing here is fixed. Change any source, add columns, remove the ones you
   don't want — only the file itself is compulsory, because it is how each row
   is matched to its document. Removing a column offers an **Undo** straight
   away, so it is safe to try.
3. **Save.** The spreadsheet is written where you choose.

**Then open it in Excel and check it before uploading.** This step guesses, and
everything else the program does doesn't. Two extra columns help you check:

- `_notes` — rows that need a look, and why
- `_source` — where each value came from

The uploader skips any column whose name starts with an underscore, so you can
leave them in place or delete them - either works.

`_source` earns its keep on titles in particular. Most documents record a
sensible title, but a fair few record something left over from how the file was
made — an internal reference number, or the name of the Word file it was
exported from. `_source` is a single cell per row listing every column's origin
at once — `attachment name=filename; MWDL/title=properties` — so sorting on it
will not group anything. Use Excel's search or a text filter for
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

### Optional: letting a language model fill the gaps

Some documents simply do not state a description anywhere the program can find
one. If you want, it can ask a language model to write that column instead.

**You do not have to do anything.** On the Setup screen there is a collapsed
section, *"Optional: let a language model fill gaps the documents do not
answer"*. **Leave it empty and no model is contacted and nothing leaves this
computer.** There is no prompt, no warning and no half-working version.

One small thing does change if your column setup asks for a model — and the
**Alumni Obituary** starter kit does. Any description that came out empty gains
a line in `_notes` saying a language model was asked for and none was set up.
It is a note, not a problem: those rows were already flagged, because a
description only comes out empty when no death date could be found either, and
that is flagged on its own. Nothing else about the spreadsheet is different.

**The program checks the model's work before it writes anything.** A model
sometimes states things the document does not say, so every answer is read back
against the document, and one that makes a claim the document does not support is
thrown away rather than written — see *When the program refuses an answer* below.

**Whether the answers it keeps are any good is your judgement.** The program has
been tested thoroughly on *what it sends, when it is allowed to send, what it
refuses, and how it flags what comes back* — but no test can say whether a
description reads well or is useful. That judgement is yours, made by reading the
descriptions against the documents. This is why every cell a model writes is
flagged. **And it depends heavily on which model you point it at** — see *Which
model, and why it matters more than you would expect* below.

#### Two kinds of model, and the difference matters

- **On your own computer** (for example Ollama at
  `http://localhost:11434/v1`). Free, and **nothing leaves the machine**. Slower
  — ninety seconds for one answer is ordinary on an older PC, which is why the
  program waits two minutes before giving up.
- **A hosted service** (for example OpenAI at `https://api.openai.com/v1`).
  Faster, needs an API key, and **sends the text of your documents to somebody
  else's computer**. If your material is not allowed to leave site, use a model
  on your own computer instead — and if you are not sure, ask before you fill
  the address in.

Fill in the address, the model's name, and (for a hosted service only) the API
key. The key is stored encrypted for your Windows account, exactly like your
password. Three more boxes have sensible defaults you can leave alone: how much
of each document to send, how many requests one run may make, and how long to
wait for an answer.

#### Which model, and why it matters more than you would expect

**A small model will give you descriptions that need heavy editing. That is the
model, not this program.** It is worth knowing before you decide the feature is
not working.

The same ten scanned documents were run twice, with the same instructions and the
same settings, changing only which model answered:

| | a small model (3B) | a larger model (8B) |
| --- | --- | --- |
| descriptions written in the form asked for | about 3 of 8 | **8 of 8** |
| invented answers thrown away | 2 of 2 | 2 of 2 |
| good answers wrongly thrown away | none | none |
| time for ten documents | slower | about 140 seconds |

The small model's mistakes were obvious ones: a person's name put where a date
should start the line, an age given instead of a date of death, a rambling
sentence naming a hospital. **Nothing about the instructions caused that** — the
same instructions produced eight correct lines from the larger model. So if what
comes back is the wrong shape, ask whoever set up your model whether a larger one
will run on that machine. Do not rewrite the column instructions first.

**Two of the ten documents defeated both models** — one states no date anywhere,
the other never mentions the school the model claimed for it — and both times the
program threw the answer away. A better model does not remove the need for that
check, which is why it cannot be switched off.

Model names look like `llama3.2:3b` and `llama3.1:8b`; the number before the `b`
is roughly the size. Bigger is generally better and slower, and needs more of the
machine. Treat the table as one small trial on ten documents in English, not as a
promise.

#### What you will see when it runs

- **You are asked before any document leaves this computer.** The message comes
  at the very end, after you have chosen the folder, set up the columns and
  picked where to save — deliberately, so that nothing can still call the run
  off after you have agreed to it. It says how many requests are about to be
  made, to which service, using which model, and at most how much of your text
  is going. Nothing is sent until you agree, and nothing is uploaded to
  openEQUELLA by this step — it writes into your spreadsheet only.

  **A model on your own computer does not ask.** Nothing is leaving the machine
  and nothing is being charged, so there is nothing to agree to. That is
  deliberate: a box you have to click through when it does not matter is what
  teaches people to click through the one that does.

- **A ceiling on every run.** The run stops after the number of requests you set
  — 500 unless you change it — and every column it did not reach is left blank
  and says so. One request is made for each column a model may fill, so a
  document with two such columns uses two.

- **Everything a model wrote is flagged**, with no exceptions, in `_notes`. The
  `_source` column records `MWDL/description=ai` for such a cell. It holds every
  column's origin in one cell, so sorting on it groups nothing — search or
  filter the column for `=ai` to find the rows a machine wrote into.

- **A stronger warning on dates and names.** Those cells say that an invented
  date cannot be told from a real one by anyone reading the catalogue
  afterwards, and the row stays in the "needs review" count. The template that
  ships with the program does not let a model near the death date for exactly
  this reason.

- **A separate count** on the summary, kept apart from the rows needing review:
  *N had a value written by a language model — every one is flagged.* Every
  model-written cell carries a note, so folding the two counts together would
  report that all 400 rows need review and hide the one that genuinely failed.

- **A blank cell and a plain reason whenever something goes wrong** — the model
  was unreachable, it declined, it ran out of time, it was cut off mid-answer.
  Nothing half-finished is ever written into a cell, and there is no silent
  retry.

- **An answer thrown away when it says something your document does not.** See
  below.

#### When the program refuses an answer

Before an answer is written into a cell, it is read back against the document it
came from. **Any date, number, or claim your column setup already checks for**
has to appear in the document. If one does not, the whole answer is discarded and
the cell is left exactly as it was, and the `_notes` column says which claim was
unsupported and quotes back what the model said:

```text
MWDL/description: left blank -- the model's answer was refused, because it
stated things this document does not support. "2024-01-06": no date this tool
can read in the document supports it -- it recognises English month names and
numeric date forms only. The model did answer and the call succeeded -- this
tool discarded the answer -- so there is nothing to retry; read the document and
fill this cell in by hand.
```

Nothing went wrong at the model's end, so there is nothing to run again. Read the
document and type the cell in yourself.

**Note what that message does and does not say.** It says no date *the program
can read* supports the answer — never "the document states no such date", which
would be a claim about your document. The difference matters if you catalogue in
a language other than English; see the next section.

#### It reads dates in English only

The check that catches invented dates knows **English month names** and the
numeric forms (`2024-01-06`, `6.1.2024`, `4/2/98`, `the 6th of January 2024`).
A document written in another language — `Falleció el 6 de enero de 2024`,
`Er starb am 6. Januar 2024` — states a day, and the program sees only the year
in it.

**What that means in practice:** if your documents are not in English, a
*correct* answer giving a day-precision date will be refused and the cell left
blank for you to fill in by hand. That is deliberate. The program refuses rather
than guessing, because the whole reason this check exists is a document that
genuinely stated no date at all and had one invented for it. Everything else
about the model still works; you will simply type more dates in yourself.

**This is the program checking the model's work, and it is not a complete
check.** Ordinary description wording is not checked at all — writing the same
thing in different words is exactly what a model is for. And an answer that
passes is not thereby correct: it means every date and number in it does appear
in the document, not that the sentence around them says the right thing. That is
why every cell a model wrote stays flagged for you to read.

**What it will never do is overwrite something your document actually said.** A
model may fill a cell that came out empty, or replace one the program had
already flagged as a guess. A value the document stated is left alone.

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
and there is no undo from inside the program. The program cannot tell whether
your collection is the same, so it assumes it is. If nobody told you to
publish, choose Draft.

## If something goes wrong

- **The SmartScreen warning won't let you past "More info."** Ask your
  administrator — this can mean local IT policy is blocking unsigned
  programs on that specific computer.
- **The program will not accept your site address.** It must start with
  `https`, not `http`. That is refused rather than warned about because your
  password travels as part of the web address when signing in to openEQUELLA.
  If your site really is only available over `http`, that is a question for
  your administrator, not something to work around here.
- **Sign-in fails with a username and password.** Check them by signing in to
  openEQUELLA in a web browser at the same address. If that works and this does
  not, tell your administrator — this way of signing in is new, and yours may
  be the first site to try it.
- **Sign-in fails with an error page from openEQUELLA itself, or one mentioning
  `redirect_uri` or `client_id`.** This is the single sign-on route. Double- and
  triple-check the redirect URL you entered under **Advanced** against what your
  administrator gave you — by far the most common cause, and it has to match
  exactly, including a trailing slash if there is one.
- **The program says no credentials are saved**, even though you entered
  them. Credentials are saved separately for each site — make sure the one
  shown in the bar at the top of the screen is the one you actually configured.
- **The Setup screen is blank and says credentials are stored differently
  now.** Expected, once, when upgrading from version 1.0.0. Enter your details
  again; it will not ask a third time.
- **The collection dropdown is empty, or says this account can contribute
  nowhere.** Sign-in worked and the account has no permission to create items
  anywhere. Only an openEQUELLA administrator can grant that — it is not a
  wrong address and not a wrong password.
- **A row failed during upload.** The Results screen at the end lists exactly
  which rows failed and why, and has a **Retry failed** button. This does not
  retry the whole batch — only the rows that failed.
- **Every document fails when the language model runs, and the model program
  keeps crashing.** *Every* request failing — not one or two — points at the
  model software on that computer, **not at this program**. Check it on its own,
  with this program closed: at a command prompt, `ollama run llama3 "Say OK."`.
  If that fails too, nothing you change on the Setup screen will help, and it is
  a question for whoever installed the model. Two things to tell them, because
  they are the usual causes and both were hit here:
  - **A leftover `HSA_OVERRIDE_GFX_VERSION` setting on the computer.** People
    copy these from forum posts to make a graphics card work. If it names the
    wrong kind of card, every request fails with a message about an *invalid
    device function*, and the model program dies. Unsetting it was the fix.
  - **A built-in (integrated) graphics chip being skipped on purpose.** Ollama
    ignores those by default; `OLLAMA_IGPU_ENABLE=1` turns them back on. Its own
    log says which graphics chip it found and what it decided to use, and that
    log is where to look first.

  Falling back to the computer's main processor instead of its graphics chip is
  always an option. It is slower, not broken.
- **Nothing above covers it, or you're not sure what happened.** Contact your
  administrator with a screenshot of whatever error message you see. Don't
  guess and don't retry an upload you're unsure about — ask first, especially
  if it says something was left "interrupted."
