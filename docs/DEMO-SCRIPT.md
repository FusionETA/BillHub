# Showing Bills Hub: Bank files and Recharge

A walkthrough to talk through, and the things only Janice can tell us.

Two modules, about ten minutes each. Both are built; neither has been
signed off against the real thing, and the questions at the end are the
reason why.

---

## Part 1 — Bank files

**The problem it solves.** Bills are approved in Xero across forty-one
companies. Somebody then retypes them into the bank's portal. That is the
step where money goes to the wrong payee, and it is the step Bills Hub
removes.

**What to show, in order:**

1. **The Bills tab, filtered to approved-and-unpaid.** Point out that this
   is every company at once. Nobody has to open forty-one Xero sessions to
   find out what is due.

2. **Select a few bills and start a payment run.** Bills Hub splits them
   by *paying bank account*, not by company — the bank cares which account
   the money leaves, and nothing else.

3. **Two rails come out of that split:**
   - **Bank transfer** — ordinary suppliers, paid to an account number.
   - **JomPay** — utilities and other registered billers, paid to a biller
     code instead of an account.

   Which rail a payee uses is not a setting anybody maintains. It comes
   from the supplier's Xero contact: if the **Bank account name** field
   holds digits, that is a JomPay biller code; if it holds a bank's name,
   it is a transfer and the name is resolved to the BNM bank code the file
   needs.

4. **Generate the file.** Hong Leong produces a ConnectFirst bulk payment
   or a JomPay bulk file. CIMB produces a filled BizConverter workbook,
   which is then run through CIMB's own converter and the resulting .txt
   uploaded to BizChannel.

5. **Show what it refuses to do.** A payee missing a bank account, or
   missing an email on the CIMB with-advice sheet, is *reported* rather
   than written as a line the portal will reject or, worse, accept wrongly.

**Say this plainly:** all five layouts are reproduced from the banks' own
specifications and checked line by line, but **not one has yet been
accepted by a live portal**. The app says so on screen. The first real run
should be a single line, to a known account, for a trivial amount.

**Testing mode** (Bank files tab) blocks every write to Xero while leaving
reads working, so the whole flow can be rehearsed against real data without
touching anything.

---

## Part 2 — Recharge

**The problem it solves.** One company pays a bill for premises another
company occupies. Today that is found later, by hand, and journalled —
if anybody remembers.

**The shape of it:** when a bill is paid, Bills Hub asks "whose premises
was this actually for?" If the answer is a different company, it raises
the paperwork for the recharge in both companies at once.

**What to show, in order:**

1. **A bill on the Bills tab.** Mark it paid. That is the trigger — the
   whole module hangs off paying a bill *here*. A bill settled directly in
   Xero does not start a recharge, which is deliberate: otherwise
   connecting Bills Hub would propose thousands of recharges for history.

2. **Switch to Recharge.** The bill is now a suggestion, saying which
   company it belongs to and why.

3. **The "why" is the interesting part.** There are two ways a bill gets
   matched, and they exist because a Xero bill has *no premises field*:

   - **Supplier rules** — one supplier contact, one entity. The trick is
     to name the contact in Xero after the premises it bills for:
     `Tenaga Nasional Berhad - Signum Tower`. Then the contact itself
     answers the question, with nothing to read off the PDF.
   - **Recharge rules** — match on the supplier, the reference, the
     amount, and so on. This is the fallback for everything an address
     cannot identify: EPF, insurance, a supplier billing several sites on
     one contact.

   Show one of each. The TNB bills match on the address; the EPF bill has
   no address that means anything, so it matches on the supplier.

4. **Click Recharge.** One click creates both documents:
   - a **draft sales invoice** in the company that paid, and
   - a **draft bill** in the company being charged.

   Both are drafts so each side approves its own, and anything raised in
   error is deleted rather than credited. Whatever was attached to the
   original bill is copied onto both, so whoever approves either one can
   see the actual invoice without going back to the payer's Xero.

5. **The runs table** links straight into both documents in Xero. The
   reference ties them together — `IC-TNB-SIGNUM-1226-SD`.

**Say this plainly:** the matching is only as good as the contact names.
Right now 98% of Ayu Borneo's 2,250 electricity bills sit on four generic
contacts, with the premises buried in the *reference*. Until those contacts
are split one-per-premises, a supplier rule would send every one of them to
the same company — so for TNB as it stands today the matching has to be done
on the reference, with recharge rules.

---

## Questions for Janice

### Bank files

1. **Which banks do you actually pay from today**, and which portal does
   each one use? We have built Hong Leong ConnectFirst and CIMB
   BizConverter. Is there anything else?

2. **Can we do one controlled test upload per format?** One line, known
   payee, small amount. None of the five layouts has been through a real
   portal yet, and that is the only thing that will prove them.

3. **Is it still true that every JomPay bill is paid from Hong Leong**, and
   suppliers from CIMB? The app assumes that. CIMB's JomPay sheet is built
   but deliberately switched off, and turning it on is one setting.

4. **Does one bank file ever cover several paying companies**, or is it
   always one company's account per file? This changes how a payment run
   is grouped.

5. **Who checks a file before it is uploaded**, and should Bills Hub record
   that approval?

6. **For payees with no bank details in Xero** — who fills those in, and is
   the Xero contact the master record we should trust? Bills Hub reads the
   account number from the contact's Financial details, and Xero silently
   discards anything written back there except the account number.

7. **Email advice on CIMB payments** — do you want it? It needs an email
   address on every payee, so a run with one missing will not go through.

### Recharge

8. **Can the supplier contacts be split one per premises**, and named after
   the building — `TNB - Signum Tower` rather than one generic `TNB`? This
   is the single thing that decides whether the simple rule works or
   everything has to be matched on the reference. Who would do it, and by
   when?

9. **Where a contact has to cover several premises**, is the premises
   always in the reference, and always in the same position? A rule can be
   narrowed to a reference fragment, but only if the format is reliable.

10. **From what date should recharges start?** There are 2,250 paid
    electricity bills in history, 157 of them paid by the management
    company for premises it does not occupy. Recharging all of them
    retrospectively is a decision, not a default.

11. **Which account codes** should the recharge invoice and the recharge
    bill post to? Is it one standard pair group-wide, or does it vary by
    company or by expense type?

12. **What is the tax treatment?** Bills Hub currently posts both sides as
    no-tax. Is that right for an intercompany recharge?

13. **Does a recharge ever need splitting between companies** — half to one,
    half to another? The engine can do it; no rule uses it yet.

14. **Both documents are now drafts** — somebody has to approve each side.
    Who, in each company, and should Bills Hub chase it?

15. **How do these intercompany balances get settled** — netted off
    periodically, actually paid, or left to sit? We removed settlement from
    the module; if it is needed, now is the time to say.

16. **When a bill is in a foreign currency**, which rate should the recharge
    use — the bill's, or the rate on the day it is recharged?

### Both

17. **Who are the users**, and what should each of them be allowed to do?
    Everyone can currently do everything.

18. **Is there anything in either flow that has to be kept for audit** —
    who approved a payment run, who posted a recharge, what the file
    contained at the time?
