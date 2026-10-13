# Paste-ready prompts

Two jobs, one session each. Everything the assistant needs is inside the
prompt — it does not need this file, the Bills Hub repo, or the conversation
these came from.

Replace `BILLHUB_URL` with `https://billhub.fusioneta.com.my` before pasting
if you want it concrete.

---

## Prompt 1 — WazzOCR asks Bills Hub where each bill belongs

────────────────────── COPY FROM HERE ──────────────────────

You are working in the FusionETA/WazzOCR repository (Node.js, Express,
MySQL). Read the code before changing anything, and ask me rather than guess
if something below does not match what you find.

GOAL

WazzOCR receives a photographed supplier bill over WhatsApp and creates it in
Xero. Today it decides for itself which Xero organisation to create the bill
in and which contact to file it under. From now on it must ask Bills Hub,
which holds that mapping in a table the finance team maintains.

THE ENDPOINT, WHICH ALREADY EXISTS AND WORKS

  GET BILLHUB_URL/api/recharge/premises
      ?address=<candidate 1>&address=<candidate 2>&...&supplier=<name>

Repeat `address` for EVERY block of text on the bill that could be an
address. Do not pick one. A bill prints the supplier's own office address, a
billing address and the service address, and they look alike — choosing
wrongly files the bill against the wrong company. Bills Hub matches all of
them against its register and returns the one it recognises. Verified: given
TNB's Bangsar office, a real premises and a PO box, it returns the premises.

`supplier` is the supplier name you read off the bill. Optional, but always
send it: one building has an electricity account and a water account, and
the supplier is what tells those two rows apart.

200 — a match:

    {
      "premisesAddress": "Level 12, Signum Tower, Jalan Kia Peng, 50450 Kuala Lumpur",
      "paidBy":      { "tenantId": "a55c5c9f-...", "code": "DCGLOBAL2" },
      "contactName": "Tenaga Nasional Berhad - Signum Tower",
      "rechargeTo":  { "tenantId": "26ac19b9-...", "code": "SD" }
    }

Create the bill in `paidBy.tenantId`, under the contact named by
`contactName`. IGNORE `rechargeTo` — it is a note for humans. Bills Hub
performs the recharge itself later, from its own separate rules, once the
bill has been paid there. Nothing you do here recharges anything.

404 — {"error":"No premises in the register matches that address."}
Nobody has mapped this premises. This is a correct answer, not a fault.

WHAT TO BUILD

1. Call this before every bill creation. Do NOT gate it behind a list of
   utility names. A list like "TNB, Air Selangor, Indah Water, SAJ, Telekom,
   Celcom, Maxis, Assessment" excludes every landlord, and rent is the
   second-largest case on this account. It also excludes utilities nobody
   has added to the list yet. The register is already the gate: an unmapped
   premises returns 404.

2. Extract the supplier and EVERY address-like block. Use this as the basis
   of the extraction prompt:

       From this bill, extract:
         supplier   The company issuing the bill, as printed.
         addresses  EVERY address-like block on the page, as a list, each
                    verbatim. Include the supplier's own address, the
                    billing address and the service/premises address. Do not
                    decide which is which. Do not merge or tidy them.

       Copy each address exactly as printed, including the postcode and any
       unit or lot number. Do not expand or abbreviate: do not turn "Jln"
       into "Jalan" or the reverse. Do not translate. If a line is unclear,
       include your best reading rather than omitting it.

       On a Malaysian utility bill the premises is usually the address NOT
       next to the supplier's logo, and is often labelled Alamat Premis,
       Service Address or Alamat Penghantaran.

       Suppliers you will see most, to help read the letterhead. A hint, NOT
       a filter — a bill from anyone else is handled the same way:
         Electricity  TNB / Tenaga Nasional, SESB / Sabah Electricity,
                      Sarawak Energy
         Water        Air Selangor, Syabas, SAJ, Jabatan Air, LAKU,
                      Kuching Water, Air Kelantan, PBA
         Sewerage     Indah Water / IWK, Alam Flora, SWCorp
         Gas          Gas Malaysia, Petronas Gas
         Telecoms     Telekom Malaysia / unifi / TM Technology Services,
                      Maxis, Celcom, Digi, U Mobile, Time, Astro
         Council      Majlis Bandaraya / Perbandaran / Daerah, DBKL,
                      cukai taksiran, cukai tanah
         Rent         A landlord, called whatever they are called.

   Send the addresses exactly as extracted. Do not normalise, trim or clean
   them first — Bills Hub does that, and doing it twice loses words.
   Matching forgives case and punctuation but NOT abbreviations.

3. Do not cache the result. Someone adds a row in Bills Hub and expects the
   next bill to use it. If you must cache, cache for seconds and say so in a
   comment.

4. On 404, never fall back to a default organisation or a generic contact.
   That is a real bill created silently in the wrong company. Hold it and
   ask on WhatsApp, or create it somewhere obviously-for-review and flag it.
   Ask me which before you implement it.

5. A timeout, a 5xx or a connection error is NOT a 404. Treat it as "do not
   know yet", queue a retry, and do not create the bill from a guess.

6. Authentication: this endpoint sits behind Bills Hub's session auth and
   WazzOCR is a server, not a browser. Propose a header-checked service
   token, with the value in .env on both sides, and tell me what to add on
   the Bills Hub side. Do NOT read Bills Hub's database directly, even
   though both apps share a MySQL server — that would duplicate the address
   matching in a second place where it will drift.

CONSTRAINTS

- The repository is PUBLIC. No tokens, keys, phone numbers or customer data
  in code, tests or fixtures. Everything through .env, which is gitignored.
- Do not start a new Xero consent. Bills Hub may be borrowing this app's
  Xero grant; a second consent supersedes the token and stops this pipeline.

DONE WHEN

- A bill for a mapped premises is created in the organisation and under the
  contact the register names.
- A row added in Bills Hub is used by the very next bill, with no restart.
- An unmapped premises does not produce a bill in a default company.
- Bills Hub being unreachable does not produce a bill in a default company.
- Two accounts at one address each resolve to their own contact when the
  supplier is sent.
- A bill from a supplier on no list at all is still looked up.

─────────────────────── COPY TO HERE ───────────────────────

---

## Prompt 2 — One login: Bills Hub uses WazzOCR's session

────────────────────── COPY FROM HERE ──────────────────────

You are working across two FusionETA repositories, both Node.js + Express +
MySQL and both PUBLIC: WazzOCR and BillHub. Read both before changing
anything.

GOAL

Simon signs into WazzOCR. He clicks a button and lands in Bills Hub, already
signed in as Simon. Bills Hub stops holding passwords at all.

THREE FACTS THAT MAKE THIS SMALL — verify each before relying on it

1. The apps share a MySQL server. BillHub/lib/grantSource.js already reads
   `wazzocr`.`xero_grants` cross-database.
2. WazzOCR/auth/sessions.js and BillHub/auth/sessions.js are THE SAME FILE.
   Cookie `wz_session`; a random token in the cookie; SHA-256 of that token
   stored as `sessions.id`; 30-day TTL. BillHub was derived from WazzOCR.
3. BillHub already has `accounts.wazzocr_account_id`, and
   BillHub/models/accounts.js resolves through it.

So this needs no OAuth, no identity provider and no shared secret service.

BUILD IT THIS WAY

Both apps are now on one registrable domain — wazzocr.fusioneta.com.my and
billhub.fusioneta.com.my. Confirm that, because everything below depends on
it.

In WazzOCR, auth/middleware.js setSessionCookie: add a domain so the cookie
reaches both hosts.

    domain: process.env.SESSION_COOKIE_DOMAIN || undefined   // .fusioneta.com.my

In Bills Hub, auth/sessions.js resolveUser: resolve the token against
WazzOCR's tables instead of its own.

    SELECT u.* FROM `wazzocr`.`sessions` s
      JOIN `wazzocr`.`users` u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > NOW()

Same cookie, same hash, so the token Bills Hub receives is one WazzOCR
already issued. Map the WazzOCR user to a Bills Hub account through the
existing accounts.wazzocr_account_id.

Put it behind AUTH_SOURCE=own|wazzocr, mirroring the existing
XERO_GRANT_SOURCE flag, so it can be turned off without a rollback.

Add a button in WazzOCR, visible only to a signed-in user, linking to
BILLHUB_URL. Nothing else: if the cookie is shared, Bills Hub recognises the
session on arrival.

IF THE DOMAINS CANNOT BE SHARED

Tell me first. If we go ahead: WazzOCR mints a handoff token that is
short-lived (60 seconds or less), single-use and recorded as burned, bound
to the user id, and HMAC-SHA256 signed with a shared secret. Bills Hub
redeems it at /auth/handoff, creates its OWN session and redirects. Never
put a user id, email or role in a URL parameter and trust it.

ALSO

- Bills Hub's POST /api/auth/login and its password form must refuse, with a
  message pointing at WazzOCR. The route already refuses under
  AUTH_DISABLED; reuse that shape. Stop reading users.password_hash; leave
  the column.
- Logging out of WazzOCR must log out of Bills Hub, or the UI must say
  plainly that it does not.
- Bills Hub has exactly one permission, users.is_super_admin, which controls
  the Activity tab. Decide where it lives once identity comes from WazzOCR
  and tell me. Do not drop it: it is what stops everyone reading the audit
  log of everyone else.
- AUTH_DISABLED=true must be off in any deployment doing this. It makes
  every request the default account's owner and would make all of this
  decorative.
- No credentials in either repo. Both are public.

DONE WHEN

- Simon signs into WazzOCR, clicks through, and Bills Hub shows him as Simon
  with no second login.
- Bills Hub's own login refuses and says where to go.
- Signing out of WazzOCR means Bills Hub no longer recognises him.
- A user who is not a super admin gets 403 from Bills Hub's /api/activity —
  check the route, not just that the tab is hidden.

─────────────────────── COPY TO HERE ───────────────────────
