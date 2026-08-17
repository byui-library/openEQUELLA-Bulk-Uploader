# Security

This tool uploads files and metadata to an openEQUELLA instance using
credentials an operator supplies. This page states what it does with those
credentials, what leaves the machine, and what an adopting institution should
check on their own site.

Last reviewed 2026-08-17.

## Reporting a vulnerability

Open a GitHub issue for anything already public. For anything that is not,
use GitHub's **Report a vulnerability** button on the Security tab, which
opens a private advisory rather than a public issue.

## Your password is in the URL, and URLs get logged

openEQUELLA's sign-in API is `POST /api/auth/login?username=…&password=…`.
Both are query-string parameters; the API declares no request-body form. That
is openEQUELLA's design and this tool cannot change it.

- **In transit it is protected.** HTTPS is required before any request is
  built, and plain `http` is refused outright — including to `localhost` —
  precisely because the password rides in the URL.
- **At rest on the server it may not be.** Web servers, reverse proxies and
  load balancers routinely record the full request line, query string included.
  An AWS load balancer's access logs do.

**What to check on your own instance:** whether access logging captures query
strings, how long those logs are kept, and who can read them. Where your site
supports OAuth, prefer it — the password never leaves the browser in that flow.

This is worth raising with the openEQUELLA project itself. A login that took
its credentials in the request body would close it for every institution.

## What leaves your machine

- **To your openEQUELLA instance:** the files you selected, the metadata in
  your spreadsheet, and your credentials. Nothing else.
- **To a language model, only if you configure one.** With no model endpoint
  configured, nothing is contacted and nothing is sent. Point it at a local
  runtime and nothing leaves the machine. Point it at a hosted provider and the
  text of your documents is sent there, governed by that provider's terms
  rather than by anything here. An API key is never sent over plain `http` to
  anything but this machine.
- **Nowhere else.** There is no telemetry, no crash reporting, no update check.

Every value a language model writes is checked against the document it came
from before it is written, and is flagged in the spreadsheet. That is a
correctness guard, not a security one, but it is the question people ask next.

## Stored credentials

Credentials are encrypted with Electron's `safeStorage` — on Windows that is
DPAPI, tied to your Windows account, so another user of the same computer
cannot read them. If the operating system reports encryption unavailable, the
tool refuses to store rather than falling back to plaintext.

**If you build this for Linux**, check which `safeStorage` backend you get:
without a system keyring it can report itself available while using a weak one.
Only Windows installers are published today.

The CLI is different: it reads `OEQ_USERNAME` and `OEQ_PASSWORD` from the
environment on every run, so their protection is whatever protects your
environment and your shell history.

## Spreadsheet formula injection

Text extracted from documents is written into a spreadsheet you open in Excel,
and Excel executes a cell beginning `=`, `+`, `-` or `@`. Such values are
prefixed with an apostrophe when written, and the apostrophe is removed again
when the spreadsheet is read back, so what gets uploaded is the text the
document actually contained.

A value that genuinely starts with one of those characters therefore shows a
leading apostrophe in Excel. That is expected, and it does not reach
openEQUELLA.

## OAuth

The authorization-code flow sends a one-time `state` value and refuses a
redirect that does not carry it back. This matters most for the CLI's loopback
capture, which listens on a local port that any other process on the machine
can reach.

**The CLI's manual-paste flow cannot check it** — you paste a code read off a
page, usually without the state beside it — and it does not pretend to. Prefer
the loopback flow (`OEQ_REDIRECT_URI` pointing at `127.0.0.1`) where your OAuth
client's registration allows it.

## Dependency advisories

`npm audit` currently reports three moderate advisories. Both underlying issues
were checked against how this code actually calls the libraries:

| Package | Advisory | Applies here? |
| --- | --- | --- |
| `fast-xml-parser` | Comment/CDATA injection in `XMLBuilder` | **No.** Only `XMLParser` is used. Item XML is built by hand with its own escaper in `src/core/metadata.ts`. |
| `uuid` (via `exceljs`) | Missing bounds check when a `buf` argument is passed | **No.** Nothing here passes one. |

Both fixes are breaking major upgrades, one of them to `exceljs`, which writes
every spreadsheet this tool produces. **Do not run `npm audit fix --force`
before a release.** Re-check when non-breaking fixes ship, and treat any future
advisory that touches `XMLParser` as urgent — it parses `.docx` files and
schema XML, both of which come from outside.

## What has not been reviewed

- No penetration testing against a running instance.
- The openEQUELLA server itself. Several points above are properties of its
  API, which this tool can only work within.
- The installer, its signing, and how it reaches staff.
- Provenance or integrity of the dependency tree beyond the advisory database.
