# Logistics rebuild game plan

Status: **Draft for the 2026-11-15 logistics meeting. Not approved.** Synced with the shared briefing ([BMRC Logistics Rebuild Briefing](https://claude.ai/artifact/DgLbSg7zyhsHkYGnmesyC4)) on 2026-11-14. This file is the repo copy; it stays logistics-focused, and organizational and legal context is condensed in §11.

**Goal:** logistics that is solid and hard to let slip, even after leadership turns over. Statpacks and supply inventory first.

**Recommendation:** stay on Firestore. Rebuild the statpack and inventory core offline-first. Ship it as an installable web app (PWA) with a QR code on each pack. Measure it with a small set of metrics that leadership hands down year to year.

---

## 1. Where we are

- **Pain:** bugs, things breaking, unreliable. Even when the logic is right, the UX is miserable.
- **Real users today:** the 4 maintainers plus some FTOs who remember to check packs in and out.
- **Volume:** about 5 events a week, one statpack each. That's about 10 check-offs a week.
- **Must work ASAP:** statpack checkout and check-in, and supply inventory.
- **Later:** shifts, roster and admin. **On hold:** finance, uniforms, stats and calls dashboards. These get hidden, not deleted.
- **Data:** live inventory is non-standard (e.g. "4x4 gauze" and "4 in gauze" are two items). Decision: **re-enter it clean** rather than migrate.
- **Budget:** $0 preferred, $5/month cap. A card is already on Firebase.
- **Environment:** check-offs happen in the downstairs HQ, which has no signal. **Offline is a hard requirement.**
- **Assets:** statpacks, plus one UTV that's in maintenance. Vehicles stay out of the rebuild.
- **Check cadence (experimental):** teams check packs weekly, mainly for expiry, and fill as needed. Logistics audits every two weeks. This must be a setting, not code.

## 2. Why check-off hangs (issue #19)

The cause is how a check-off saves, not which database we use.

- One check-off makes about **60 network round-trips in a row**: ~50 per-item reads for a 49-item pack, a `runTransaction`, then post-commit writes.
- **Transactions cannot finish without a live server connection.**
- Offline persistence is **off** (`firebase.ts:53` is a plain `getFirestore`), and there is no service worker.
- All of this runs in a basement with no signal.

A second structural problem: **95 files import Firestore directly, 49 of them pages or components**, with 59 live listeners. With data logic spread that wide, rules drift apart and one fix breaks something else. Check-off duration is also not recorded anywhere, so we have no baseline for speed.

## 3. SQL vs Firestore

| | Firestore (stay) | Supabase / Postgres |
|---|---|---|
| Cost at our size | $0 (Blaze; free quotas still apply) | $0 free tier |
| Offline | **Built in:** writes queue in IndexedDB and sync on reconnect | Needs an add-on (PowerSync free tier deactivates when idle; Pro $49/mo) |
| Free-tier catch | None that matters to us | **Pauses after 7 idle days** (every break), **no backups**, Pro is $25/mo |
| Data rules (no blank expiry, no duplicates) | Enforced in our code | Enforced by the database (real advantage) |
| Readability for future maintainers | Weaker | Stronger |
| Work before statpacks work again | Rebuild the core data model | Same, plus rewrite auth, rules, and all 95 files |

**What EMS vendors run** (job postings and page fingerprints):
- ESO and ImageTrend: .NET + SQL Server.
- PSTrax and Aladtec: PHP + MySQL.
- Fleetio: Rails + Postgres.
- First Due: Postgres.
- Operative IQ: legacy ASP.NET.

None of them use Firestore. They need SQL for billing, multi-agency setups, and heavy reporting. Their offline support comes from separate native apps with hand-built sync. Their phone apps still rate poorly (Operative IQ Front Line ~2.4★, Station Check ~1.9★).

**Recommendation:** stay on Firestore. One data layer with typed schemas recovers most of SQL's maintainability. Revisit SQL at the shifts and roster phase if reporting gets painful.

## 4. Phone app vs web app

| Option | Effort | Cost | Offline | Upkeep with turnover |
|---|---|---|---|---|
| Mobile site (today) | none | $0 | ✗; Safari wipes site data after 7 days unused | none |
| **Installable PWA** | days | $0 | ✓; Home Screen apps are exempt from the 7-day wipe | low |
| Capacitor wrapper | weeks | $99/yr Apple | Same as PWA; reported Firebase bugs in WKWebView | medium: certificates, review, 90-day TestFlight builds |
| React Native / native | months | $99/yr | custom | high |

- Apple guideline 4.2 rejects "repackaged websites."
- Barcode scanning on iPhone needs a JavaScript library.
- **Recommendation:** PWA, plus an "Add to Home Screen" guide, plus **QR codes on each pack** that open `/statpacks/check-off?id=…`.

## 5. Why crews hate EMS software, and how we avoid it

Crews hate these tools mainly because they're built for the buyer (chiefs, billing, compliance), not for the EMT holding the phone.

| Root cause | Evidence | Our countermeasure |
|---|---|---|
| Built for admins, not the field | "designed around the needs of the system administrator, not the needs of the provider in the field" ([EMS World, 2026](https://www.hmpgloballearningnetwork.com/site/emsworld/perspectives/i-spent-5-years-nyc-9-1-1-software-we-used-was-working-against-us)) | FTOs and members test every screen before it ships |
| Too many taps | "every extra click... is a design failure" (same source) | Check by exception: everything starts OK; tap only what's wrong |
| Loses work, logs you out | "logs you out and doesn't save your progress" ([Station Check reviews](https://apps.apple.com/us/app/station-check/id1458027035)) | Offline-first with autosaved drafts; long sessions |
| Slow on bad signal | "slow load times on bad cell service" ([blog](https://august.mataroa.blog/blog/first-responders-deserve-better/)) | Saves on the phone first, syncs later |
| Rigid setup | "front heavy to get set up" (StationCheck review) | Pack templates editable by logistics in Settings |
| Untrained users | Usability 3.7/7 untrained vs 4.66/7 trained (NAEMT 2017) | A 5-minute walkthrough at new-member training; the in-app tour |

Three complaints are widely believed but unsourced: rubber-stamped checklists, checklists that don't match the bag's layout, and reports that vanish without a response. We design against them anyway.

**The two-minute check-off:**
1. Scan the QR code on the pack.
2. Pockets appear in physical-bag order.
3. Everything is pre-filled from the last check; tap only what changed.
4. Sealed sub-kits with a matching seal number skip the count.
5. Anything flagged reaches logistics, and the reporter sees when it's fixed.

## 6. Clinical requirements that shape the data model

Sources: the [2026 ALCO EMS Field Manual, Rev3](https://ems.acgov.org/ems-assets/docs/Clinical/Field%20Protocols/2026/2026%20Alameda%20County%20EMS%20Field%20Manual%20Rev3.pdf) and the [state EMS regulations, Jan 2025](https://emsa.ca.gov/wp-content/uploads/sites/71/2024/10/California-California-EMS-Authority-Regulations-effective-January-1-2025.pdf).

**Epi status:**
- Approved by the ALCO EMS medical director (Dr. Konik).
- Being integrated into our protocols by our UCSF EMS fellow (Dr. Fedigan).
- We carry auto-injectors today and are **moving to check-and-inject** because it's cheaper.

**Rules that affect logistics:**
- BLS optional scope covers aspirin, glucose testing, epinephrine and Narcan.
- Dosing: epi 0.3 mg IM adult, 0.15 mg pediatric. Narcan is intranasal only for BLS.
- Crews may not carry equipment or medications the medical director hasn't authorized.
- The ALCO minimum BLS equipment list (Field Manual pp.103–107, written for units) includes:
  - AED with adult and pediatric pads; O₂; NRB masks; BVMs; suction
  - 2 chest seals; 12 4x4 gauze; a tourniquet; 20 triage tags
  - glucometer; aspirin; oral glucose x2; Narcan x2
  - epi (auto-injectors or 1 vial)
- No O₂ minimum PSI is specified; we set our own floor and label it club policy.

**Data model consequences:**
- **Epi check-and-inject = a sealed sub-kit** inside the pack: vial, syringes, needles, alcohol preps, plus a seal number. Auto-injectors stay supported during the switch.
- **Per-dose medication log:** lot, expiration, pack, administering member, time, dose, auto-injector or draw-up, replacement. It links to the patient only by **ESO incident number**. **No patient information in this app**, ever: ESO is the patient record (paper today, ESO soon).
- **Medication authorization is data:** which meds, approved by whom, until when. Medical direction can change.
- **Required-items floor per pack template**, taken from the ALCO list (which items apply to a jump bag is the medical director's call). Par can go above the floor, never below it.
- **Bike and other event-specific packs** are club-defined templates. No county policy covers them.

## 7. Metrics: one headline number, five drivers, a click to the cause

The metrics are built as a tree: one headline number the board watches, five drivers under it, and every driver drills down to the exact pack, item, bin or person causing a problem. Nobody has to dig. Today our strict board members *are* the system; the tree turns what they do in their heads into checks anyone can follow and see.

**Headline number: event readiness**, the % of events that left with a fully ready pack. Target 100%.

| Driver | Measures | Red means you see | Owner |
|---|---|---|---|
| 1. Pack contents | Expired, short or broken items found per check; expired-in-pack (target 0) | Which pack, pocket, item | TBD |
| 2. Check discipline | On-time check rate (≥ 90%); audit miss rate (trending to 0); median check-off time (≤ 2 min) | Skipped checks; what the last team marked OK that wasn't | TBD |
| 3. Supply health | Restocks of cover in reserve; items expiring ≤ 90 days without later-dated stock; stockouts; $ expired per quarter | The buy list, sorted by expiry | TBD |
| 4. Location accuracy | % of monthly spot-checked items found at their recorded bin; items with no home | Which bin is wrong or missing | TBD |
| 5. Equipment working | % of devices with current maintenance (AED, O₂, glucometer, suction) | Which device, what's overdue | TBD |

Rules:
- **Pair speed with accuracy.** A 2-minute target without the audit miss rate teaches people to tap "all good."
- **Use median, not average,** so abandoned sessions don't skew it.
- **Baseline first.** Check-off duration isn't recorded today. Phase 2 adds `startedAt`/`completedAt`; we measure for a month before announcing targets.
- **Every driver gets green/yellow/red thresholds and a named owner,** reviewed in a 15-minute monthly logistics meeting. The one-page monthly readiness report is what each logistics lead hands to the next.
- **Best resume metric: $ of expired stock per quarter.** Waste is our real cost, not usage.

## 8. Supply room, ordering and maintenance

Our stock leaves by expiring, not by being used. So "proactive" means forecasting expirations, keeping reserve small, and giving every item a labeled home.

**The bag.** We use the red StatPacks [Breather](https://statpacks.com/product/breather/), an airway and oxygen bag (32 L, 17 × 23 × 9 in).
- Pockets: main compartment (22 × 15 × 6 in), two side pockets (17 × 7 × 4 in each), aux pocket (20 × 13 × 3 in).
- Inside: Velcro interior, foam lining, clear mesh storage.
- Optional modules: the Airway Cell and the green Oxygen Module, so O₂ rides in the bag.
- That matches the app's existing 4-pocket "Primary" template (main, front/aux, left, right), with the cells as sub-kits.
- **To do:** photograph and label one bag's real layout; the product page doesn't say what goes where.

**Location system:**
- A `Room-Shelf-Level-Bin` code (e.g. `R3-S2-L1-B04`) on every shelf and bin.
- A printed label on each bin with item, size, par and a QR code.
- Category colors match the StatPacks cells.
- "Every item has a home": the app knows each item's bin, and moving something is scan bin, scan item.

**Stock rules:**
- **FEFO:** earliest-expiring stock goes in front; new stock goes behind.
- **Two-bin kanban** for high-turn consumables (gloves, gauze): an empty front bin means reorder.
- **A labeled quarantine/training-only area** for expired and donated-expired stock. It can never re-enter patient-care stock ([SECAmb procedure](https://www.secamb.nhs.uk/wp-content/uploads/2024/09/Expired-Consumables-in-Educational-Environments-Procedure.pdf); [San Mateo County EMS](https://www.Smchealth.Org/sites/main/files/file-attachments/22-cln-04_-_use_of_expired_medications_and_supplies_not_authorized.pdf?1662481750) bans expired supplies in field units outright).

**Reserve sizing:**
- Reserve max ≈ enough to restock all 5 bags 1–1.5 times, plus shipping lead time, capped at about 12–18 months of usage.
- Anything bigger expires on the shelf.

**Proactive ordering:**
- A rolling 30/60/90-day expiring report. Any item in the 90-day window without enough later-dated stock goes onto the buy list with one tap.
- Batch orders into a big pre-fall order and a smaller pre-spring order.
- Our Bound Tree contact already beats online prices on epi vials. Record the contact in the vendor list so it survives turnover. (Bound Tree also offers subscription orders on net terms.)

**Maintenance schedule** (an entity: asset, task, interval, last done, next due):

| Item | Task | Interval | Source |
|---|---|---|---|
| AED | Status-indicator visual check | Monthly | [Zoll](https://www.zoll.com/resources/how-to-maintain-aed) |
| AED pads and battery | Replace by printed date (2–5 yrs); order 60+ days ahead | Per date | Zoll |
| O₂ cylinders (DOT-3AL aluminum) | Requalification, plus eddy-current inspection for 6351-T6 alloy | 5 years | [49 CFR 180.209](https://www.law.cornell.edu/cfr/text/49/180.209) |
| O₂ cylinder and regulator | PSI and regulator check | Every event (club policy) | — |
| Glucometer | Control test on each new strip vial, after a drop, or when results look wrong | Event-driven | [FDA](http://www.fda.gov/medical-devices/in-vitro-diagnostics/blood-glucose-monitoring-devices) |
| Suction, BP cuffs, pulse ox, penlights | Function and battery check | Monthly (club policy) | — |

**Known shelf lives:**
- Narcan: 4 years for lots made since Jan 2024 ([FDA](https://www.fda.gov/drugs/drug-alerts-and-statements/fda-announces-shelf-life-extension-naloxone-nasal-spray)).
- AED pads: 2–5 years.
- QuikClot Combat Gauze: about 5 years.
- Glutose: about 2 years.
- Tourniquets have no fixed expiration ([True Rescue](https://truerescue.com/blogs/knowledge/do-tourniquets-expire)): inspect for damage instead. These get an "inspect, don't expire" flag.
- Unconfirmed (use the printed date): chest seals, saline, gloves, BVMs, OPA/NPA, burn gel, cold packs, aspirin, epi vials.

**Starter catalog categories:**
1. Airway/O₂
2. Breathing/medical
3. Circulation/bleeding
4. Trauma/splinting
5. Wound/burn/cold
6. Medications (including syringes and needles)
7. Diagnostics (including strips and control solution)
8. AED and maintenance items
9. PPE
10. Documentation/misc
11. Training/quarantine

**Bag vs event kit:**
- **In the bag:** airway adjuncts, NRB and cannula, BVM, 2 tourniquets, 2 chest seals, gauze and dressings, shears, gloves, meds, glucometer, BP cuff, stethoscope, pulse ox, penlight, cold packs, tape, triangular bandages, burn sheet.
- **Event kit, separate from the bag:** AED, suction, splints. (O₂ rides in the Breather's oxygen module.)
- This split is from the [ALCO Field Manual BLS list](https://ems.acgov.org/ems-assets/docs/Clinical/Field%20Protocols/2026/2026%20Alameda%20County%20EMS%20Field%20Manual%20Rev3.pdf) and [EMS1 special-events guidance](https://ems1.com/ems-products/ambulance-disposable-supplies/articles/equipment-for-medical-responders-at-special-events-i6hX0kfkDz6r0I5h). Final contents are a medical director call.

## 9. Proposed phases

We rebuild the logistics core in place and keep the screens and design system. This is not a from-scratch rewrite.

1. **Phase 0: stop the bleeding (this week, mostly console work).**
   - Check the live rules and deploy `firestore.prod.rules`.
   - Daily backups with a $1 budget alert.
   - Lock down registration.
   - CI runs tsc, lint and tests before deploying.
   - Freeze features; hide shifts, stats, finance and uniforms from nav.
2. **Phase 1: design the clean data model (1–2 team sessions).**
   - Item catalog: one entry per product, with size and variant as fields, plus aliases. No free-text items.
   - Stock lots: quantity and expiration per lot, per location.
   - Kit template vs kit, plus the sealed sub-kit.
   - Medication log.
   - Append-only check-off log; pack status derived from it.
   - Standardize the real HQ inventory in a Google Sheet first.
   - Photograph and label one Breather's real pocket layout and module placement.
   - Assign `Room-Shelf-Level-Bin` codes and print bin labels (item, size, par, QR). Set up the quarantine/training shelf.
3. **Phase 2: offline-first check-off.**
   - `persistentLocalCache` plus a service worker (PWA).
   - Submit becomes one batched write, with no transaction and no network reads before saving.
   - "Saved on this phone, will sync" shown on screen.
   - Reports, restock flags and notifications move off the member's spinner.
   - Duration recorded.
   - `app/data/` is the only Firestore importer (an ESLint `no-restricted-imports` rule enforces it).
4. **Phase 3: inventory on the new model;** import the clean sheet.
5. **Phase 4: field test with FTOs in HQ in airplane mode.** Count taps, measure the baseline, fix friction.
6. **Phase 5 (later): shifts and roster** on the same data layer.

**Turnover-proofing, built into every phase:**
- The schema, invariants and decisions live in the repo (`decisions.md`, this doc).
- Settings hold everything that changes year to year.
- A logistics-lead handoff checklist.
- The monthly metrics report shows at a glance whether things are slipping.

## 10. Meeting agenda (2026-11-15): what to decide

**Principle:** decide now only what is expensive to undo (one-way doors). Everything else becomes a setting we can change any month (two-way doors). That is how we stay future-proof for more calls, more members, higher acuity or a new niche without rebuilding again.

**Why the bar is high:** every collegiate EMS group we've talked to says fire never trusts them by default. Fire's culture trusts standardization (same bag, same layout, every time), named accountability (who did what, when), chain of custody, and written procedure. The design principles below are built to show exactly that.

### A. Decide tomorrow (one-way doors)

| # | Decision | Recommendation | Why it's hard to undo |
|---|---|---|---|
| 1 | Platform | Firestore | Switching later means rewriting the data layer |
| 2 | Rebuild approach | Rebuild the logistics core in place; keep the screens | Sets the next 2–3 months of work |
| 3 | App form | Installable web app (PWA) + QR codes on packs and bins | QR labels get printed and stuck on everything |
| 4 | Design principles (below) | Adopt all six | Every later feature is built on them |
| 5 | Location code format | `Room-Shelf-Level-Bin` (e.g. `R3-S2-L1-B04`) | Physical labels are costly to redo |
| 6 | Metric tree + owners | Adopt §7; one owner per driver from the 9-person team; 15-min monthly review | Data must be collected from day one; there's no backfilling later |
| 7 | Phase 0 owners and dates | Rules deploy, backups, sign-up lockdown, CI checks this week | Security exposure until done |

**The six design principles (decision #4).** These are what make the system survive growth and turnover:
1. **Catalog first.** One canonical entry per product. Size and variant are fields. Nobody types free-text items.
2. **Everything is a holder.** A pack, sub-kit, bin, shelf, vehicle or MCI cache all hold stock the same way. A donated ambulance or a bike team is a new holder, not new code.
3. **Templates with floors.** Each holder type has a template (pockets, items, par). The medical director's required items are a floor that par can't drop below. New acuity means a new template.
4. **Every action has a name, time and reason.** Append-only logs, never silent edits. This is the paper trail fire expects.
5. **Chain of custody for medications.** Each dose and kit is tracked from receipt to use or disposal, linked to an ESO incident number. No patient information is stored. We stay BLS and volunteer (no ALS, no billing), so this is the epi standard fire and the county expect.
6. **Policy is data, not code.** Cadences, thresholds, par levels, authorized meds and who approved them all live in Settings, so the next logistics director changes policy without a developer.

### B. Make these settings; decide whenever (two-way doors)

Check cadence (weekly team / biweekly audit) · tamper seals on or off per sub-kit · two-bin vs min/max per item · refill flow (teams from front shelf vs logistics direct) · reserve factor (1–1.5×) · O₂ PSI floor · expiry warning windows · metric targets (set after the baseline month) · bike or event pack variants · keep expired stock for training or discard.

### C. Homework before Phase 1 (inputs, not decisions)

- [ ] Photograph one Breather, pocket by pocket, with its modules in place.
- [ ] Draft the item catalog in a Google Sheet from what's actually in HQ.
- [ ] Get check-and-inject sub-kit contents and required bag items from Dr. Fedigan.
- [ ] Write down our Bound Tree contact and their epi-vial pricing for the vendor list, so the contact survives turnover.
- [ ] Sketch HQ's 3 rooms with shelf numbers for the location codes.

### How the design absorbs growth

| If we grow in… | What happens | What changes in the app |
|---|---|---|
| Call volume (5 → 20+ events/week) | Usage starts to matter more than expiry | Reserve formula switches from expiry-driven to usage-driven; same data, new setting |
| Size (more members, more bags) | More holders, more checkers | Add holders from templates; roles and permissions already exist |
| Scope within BLS (new optional skills, MCI caches) | New items, kits or meds | New templates + floors; the custody log already supports witness sign-off |
| Niche (bike team, ambulance, MCI cache, 911 QRS) | New kinds of holders | New holder type + template; no new code paths |
| Leadership turnover | New director every 1–2 years | Settings, the metric tree and the monthly report carry the knowledge |

### Meeting format: Nominal Group Technique

Everyone thinks alone first, so the loudest voice doesn't decide and the meeting ends with ranked decisions instead of open-ended talk.

**Before the meeting (each person, alone, ~30 min).** Read this doc, then bring written answers:
1. Decisions 1, 2, 3 and 5: your pick, one reason, and the best argument against your pick.
2. The six principles: one you'd change, cut or add, and why.
3. The top 3 problems you've personally hit in the current app.
4. A paper sketch of the ideal 2-minute check-off (screens or steps).
5. Which metric driver you'd own, and the first thing you'd measure.
6. The biggest risk to this plan, and how you'd reduce it.

Keep answers private (paper, your own notes or a private form) until the round-robin. Seeing others' ideas early anchors everyone.

**Run of show (75 min):**
1. **5 min:** Ivan frames the goal and the one-way vs two-way rule.
2. **20 min:** round-robin. Each person shares one idea per turn with no discussion; a scribe records every idea. Repeat until ideas run out.
3. **15 min:** clarify and merge duplicates. Questions only, no debate.
4. **10 min:** silent vote. Each person ranks their top 5 per decision area.
5. **15 min:** reveal tallies, discuss only split votes, and Ivan confirms each one-way decision.
6. **10 min:** assign owners (metric drivers, Phase 0, homework) and dates.

**Output:** a decision log (each decision, the vote, the owner and the date), added to this doc and to `decisions.md`.

## 11. Organizational context (condensed)

- **BMRC:** UC Berkeley student EMS; partners with UCPD and campus OEM.
- **Medical direction:** UCSF EMS fellows. **Patient records:** ALCO's ESO (pending insurance).
- **Long-term goal:** more trust, then more call volume, then 911 integration or a campus line.
- **Scope:** staying BLS and volunteer. No ALS (it would need medics), and no billing.
- **Precedent:** every collegiate EMS that reached 911 did it under a university department and with a written agreement with the local fire chief (Georgetown GERMS, Cornell EMS, UCLA EMS). In Berkeley, BFD controls city EMS under H&S Code 1797.201 (from snippets; to confirm).
- **What logistics contributes:** readiness, check compliance and medication accountability data from day one. Statpack checkout already links a pack to an event, so a standby log comes almost free.
- UMass Amherst stalled for years because leadership turned over yearly. Turnover-proofing is the core requirement here too.

## 12. Sources

- Firebase: [pricing](https://firebase.google.com/pricing) · [backups](https://firebase.google.com/docs/firestore/backups) · [offline](https://firebase.google.com/docs/firestore/manage-data/enable-offline)
- Supabase: [Supabase pricing](https://supabase.com/pricing) · [PowerSync pricing](https://www.powersync.com/pricing)
- iOS PWA: [iOS PWA status](https://firt.dev/notes/pwa-ios/) · [WebKit 7-day cap and Home Screen exemption](https://webkit.org/tracking-prevention/) · [storage quota](https://webkit.org/blog/14403/updates-to-storage-policy/)
- Apple and wrappers: [fee waiver](https://developer.apple.com/support/membership-fee-waiver/) · [guideline 4.2](https://developer.apple.com/app-store/review/guidelines/) · [Firebase in WKWebView](https://github.com/firebase/firebase-js-sdk/issues/8250)
- Vendor stacks: job postings (PSTrax via wayup.com; First Due via Greenhouse; ESO and ImageTrend via builtin.com); [Fleetio](https://rubyonrails.org/foundation/fleetio); Operative IQ login page headers
- Collegiate EMS: [Georgetown GERMS](https://georgetownems.georgetown.edu/history/) · [Cornell EMS](https://cuems.cornell.edu/about/history-of-cornell-ems) · [UCLA EMS](https://adminvc.ucla.edu/news-views/july-to-september-2019/EMS-history) · [UMass (NCEMSF)](https://www.ncemsf.org/resources/local-school-articles/-sp-600) · [H&S Code 1797.201](https://california.public.law/codes/ca_health_and_safety_code_section_1797.201)
- **Unverified:**
  - Whether Firestore queued writes survive a full app close (test first in Phase 2).
  - Berkeley's 1797.201 status (confirm via the council item or the ALCO 2023 plan).
  - Whether student volunteers can hold optional-skill authorization.
