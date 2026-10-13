# Brief: WazzOCR ↔ Bills Hub

Two pieces of work, for whoever picks up WazzOCR. Hand this whole file to
your AI assistant or read it yourself — it is written to be actioned, not
admired.

Repos: `FusionETA/WazzOCR` and `FusionETA/BillHub`. Both public, so **no
credentials in either**.

---

## Start here: three facts that make this easier than it looks

These were verified against the code, not assumed.

1. **The two apps already share a MySQL server.** Bills Hub reads
   `` `wazzocr`.`xero_grants` `` cross-database when `XERO_GRANT_SOURCE=wazzocr`
   (see `BillHub/lib/grantSource.js`). So one app can read the other's tables
   today, with no new infrastructure.

2. **The session code is identical in both.** `WazzOCR/auth/sessions.js` and
   `BillHub/auth/sessions.js` are the same file: cookie named **`wz_session`**,
   a random token in the cookie, **SHA-256 of that token** stored as
   `sessions.id`, 30-day TTL. Bills Hub was derived from WazzOCR.

3. **The account mapping already exists.** `BillHub` has
   `accounts.wazzocr_account_id` and `models/accounts.js` resolves through it
   already.

Nothing below needs OAuth, a new identity provider, or a shared secret
service.

---

## Part A — WazzOCR looks up the premises before creating a bill

### What it is for

Somebody photographs a utility or rental bill into WazzOCR's WhatsApp.
WazzOCR reads the premises address off it. It then needs two things the
paper cannot tell it:

- **which Xero organisation to create the bill in**, and
- **which Xero contact to file it under**.

Bills Hub holds that mapping, maintained by the finance team on
**Recharge → Address rules**. WazzOCR must ask it, per bill, every time.

### The endpoint, which already exists and works

```
GET {BILLHUB_URL}/api/recharge/premises?address=<urlencoded>&supplier=<urlencoded>
```

`supplier` is optional but **send it** — it is the supplier name WazzOCR read
off the bill, and it is what distinguishes two accounts at one building
(a building has electricity and water, both mapped).

**200** — a match:

```json
{
  "premisesAddress": "Level 12, Signum Tower, Jalan Kia Peng, 50450 Kuala Lumpur",
  "paidBy":      { "tenantId": "a55c5c9f-…", "code": "DCGLOBAL2" },
  "contactName": "Tenaga Nasional Berhad - Signum Tower",
  "rechargeTo":  { "tenantId": "26ac19b9-…", "code": "SD" }
}
```

Use `paidBy.tenantId` as the Xero tenant to create the bill in, and
`contactName` as the supplier contact. **Ignore `rechargeTo`** — it is a note
for humans; Bills Hub does the recharge itself later, from its own rules,
once the bill is paid there.

**404** — `{"error":"No premises in the register matches that address."}`
Nobody has mapped this premises. This is a real answer, not a fault.

### How the matching behaves (do not reimplement it)

- Containment on a key with every non-alphanumeric stripped, so **case and
  punctuation do not matter**, and a longer address printed on the bill still
  finds a row holding the distinctive part.
- **Abbreviations are not forgiven**: `Jln` does not find `Jalan`. That is
  deliberate — guessing is how a bill lands on the wrong company.
- Disabled rows are never returned.

Send the address **as WazzOCR read it**. Do not normalise, truncate or
"clean" it first; the endpoint does that, and doing it twice loses words.

### Requirements

1. **Every bill creation goes through this** — utility and rental at minimum.
   Decide explicitly whether non-utility bills skip it or try it and accept
   the 404; write the decision down in the code.
2. **No caching of the result.** The finance team adds a row and expects the
   next bill to use it. If you must cache, cache for seconds, not minutes, and
   say so in a comment.
3. **A 404 must never be guessed around.** Do not fall back to a default
   organisation or a generic contact — that is precisely the wrong bill in the
   wrong company, created silently. Hold the bill and ask on WhatsApp, or
   create it somewhere obviously-for-review and flag it. **Pick one and be
   consistent.**
4. **A timeout or 5xx is not a 404.** Treat an unreachable Bills Hub as "do
   not know" and queue a retry; do not let it mean "no mapping".

### The one thing not yet decided: how WazzOCR authenticates to this endpoint

`/api/recharge/premises` sits behind Bills Hub's normal session auth. WazzOCR
is a server, not a browser. Choose one:

- **(a) A service token.** Add a header-checked token to Bills Hub for
  `/api/recharge/premises` only. Simplest, and the one to pick unless there is
  a reason not to. Token in `.env` on both sides, never in the repo.
- **(b) Read the table directly.** The apps share a MySQL server, so WazzOCR
  could query `` `billhub`.`recharge_rules` ``. Faster and with no auth, but it
  duplicates the matching logic in a second place where it will drift. **Not
  recommended** — the matching is the subtle part.

---

## Part B — One login: WazzOCR's session, used by Bills Hub

### The goal

Simon signs into WazzOCR. He clicks a button. He is in Bills Hub, as Simon,
with no second login. Bills Hub stops holding passwords at all.

### Recommended: share the cookie, resolve against WazzOCR

This works because of facts 1 and 2 above, and it is the smallest change.

**In WazzOCR** (`auth/middleware.js`, `setSessionCookie`): add a `domain` so
the cookie is sent to both hosts.

```js
res.cookie(sessions.COOKIE_NAME, rawToken, {
  httpOnly: true,
  secure: req.secure || process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  domain: process.env.SESSION_COOKIE_DOMAIN || undefined,   // e.g. .fusioneta.com.my
  maxAge: sessions.TTL_DAYS * 86400000,
  path: '/'
});
```

**This only works if both apps are on the same registrable domain** — say
`wazzocr.fusioneta.com.my` and `billhub.fusioneta.com.my`. Today Bills Hub is
on a bare DigitalOcean host, so **it needs a subdomain of the same domain as
WazzOCR before any of this works.** Sort that first; everything else is
pointless without it.

**In Bills Hub** (`auth/sessions.js` `resolveUser`): resolve the token against
**WazzOCR's** tables rather than its own.

```sql
SELECT u.* FROM `wazzocr`.`sessions` s
  JOIN `wazzocr`.`users` u ON u.id = s.user_id
 WHERE s.id = ? AND s.expires_at > NOW()
```

Same hash, same cookie, so the token Bills Hub receives is one WazzOCR already
issued. Then map WazzOCR's user to a Bills Hub account through the existing
`accounts.wazzocr_account_id`.

Put it behind a flag — `AUTH_SOURCE=own|wazzocr`, mirroring the existing
`XERO_GRANT_SOURCE` — so it can be turned off without a rollback.

### If the two apps cannot share a domain

Then a signed handoff. Get these right or it is an open door:

- WazzOCR mints a token that is **short-lived (≤60s)**, **single-use**
  (recorded and burned on redemption), **bound to the user id**, and **signed
  with a shared secret** (HMAC-SHA256) or written to a shared table.
- Bills Hub redeems it at `/auth/handoff?token=…`, creates **its own**
  session, and redirects.
- **Never** put a user id, email or role in a URL parameter and trust it.
  Anything a browser can edit is not identity.

### What Bills Hub must stop doing

- `POST /api/auth/login` and the password form: refuse with a message
  pointing at WazzOCR. The route already refuses under `AUTH_DISABLED`;
  reuse that shape.
- `users.password_hash`: stop reading it. Leave the column.
- Logging out should log out of **both**, or say plainly that it does not.

### Authorisation, which is a separate question from identity

Bills Hub has exactly one permission: `users.is_super_admin`, which controls
the **Activity** tab. If identity comes from WazzOCR, decide where that flag
lives — WazzOCR's `users` table, or a Bills-Hub-side table keyed on the
WazzOCR user id. **Do not drop it**: it is what stops everyone reading the
audit log of everyone else.

Related: `AUTH_DISABLED=true` must be **off** in any deployment doing this.
It makes every request the default account's owner and would make the whole
exercise decorative.

### The button

In WazzOCR, link to `{BILLHUB_URL}/`. Nothing clever — if the cookie is
shared, Bills Hub recognises the session on arrival. Show the button only to
a signed-in user.

---

## How to know it is done

**Part A**
- A bill photographed to WhatsApp for a mapped premises is created in the
  organisation and under the contact the register names.
- A row added in Bills Hub is used by the **very next** bill, with no restart
  and no wait.
- An unmapped premises does **not** produce a bill in a default company.
- Bills Hub being down does not produce a bill in a default company either.
- Two accounts at one address (electricity and water) each resolve to their
  own contact when the supplier is passed.

**Part B**
- Simon signs into WazzOCR, clicks through, and Bills Hub shows him as Simon
  with no login.
- Bills Hub's own login refuses, and says where to go.
- Signing out of WazzOCR means Bills Hub no longer recognises him.
- A user who is not a super admin cannot open **Activity** — check the route
  returns 403, not just that the tab is hidden.

---

## Things to be careful about

- **Both repos are public.** No tokens, keys or live phone numbers in code,
  tests or fixtures. Everything through `.env`, which is gitignored.
- **Do not start a second Xero consent while `XERO_GRANT_SOURCE=wazzocr`.** It
  supersedes WazzOCR's token and stops its pipeline. This has nothing to do
  with the work above, but it is the easiest way to break production.
- **Test against localhost first.** Bills Hub has `scripts/dev-local.sh`, but
  note it runs `test/seed.js`, which wipes data — read it before running it on
  anything you care about.
