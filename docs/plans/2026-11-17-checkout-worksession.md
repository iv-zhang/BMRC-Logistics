# Worksession, Tue 11/17: one shared picture before we build

**Goal:** leave with one shared picture of **how checkout works today**, **what an item and a pack
are**, and **where things live**, so the code that follows is built on the same understanding. This
is a prep session we do together, not a build session. **Scope:** statpack contents and supply items
only.

**Why:** the problem isn't the code, it's how prepared we are going into it. Right now we each have
a different picture of the data and of how checkout works, so fixes drift and decisions get reopened.

**Decided, don't reopen:** [D-37](../../decisions.md) (shortages flag at checkout),
[D-38](../../decisions.md) (stay on Firestore), [D-39](../../decisions.md) (the flag dialog lists only
real failures).

**Who decides:** Ivan decides **what**. Sid decides **how the data is modeled**. Lang decides **where
things go**. Ian brings the item list (#52) if he has it.

## Before the session

- [ ] **Everyone, tonight:** `git switch main && git pull`, `npm install`, `npm run dev:sandbox`, and log
  in as `member@bmrc.test` / `test1234`. If it won't start, post in Slack tonight, not at the session.
- [ ] **Ivan:** set up the test packs in the sandbox for the scenarios below. Bring MRC 2's real
  contents list (a screenshot or export from the pack editor) for part 2.
- [ ] **Ivan:** merge PR #67 so everyone pulls this plan.

## The session: four parts, in order

### 1. Checkout walkthrough (owner: Ivan)
Everyone checks out the test packs in the sandbox as `member@bmrc.test`, running these scenarios:
- **Missing fields:** the O₂ and AED boxes are ticked, but the pressure and pad date are empty.
- **Short pack:** 0/1 EpiPen, 0/2 pressure dressings, 2/3 cold packs.
- **No O₂ tank.**
- **Expired item.**

Note every place you hesitate or get stuck.
**Output:** one list of what's wrong, each line tagged **screen / code / data / process**.

### 2. Data structure (owner: Sid)
What is an item: name, category, size, unit, par, whether it expires, critical or not, consumable vs
asset? What does a pack's contents list look like? Start from `MODEL.md` (`inventory`, `statpacks`) and
MRC 2's real contents, not a blank page.
**Output:** a first draft of #50 at `docs/plans/2026-11-17-data-structure-draft.md`. Sid maps it to code
afterwards.

Open questions for the team:
1. What makes two entries the same item, e.g. "4x4 gauze" and "4 in gauze"?
2. Which properties must every item have, and which are only needed for some?
3. Does par belong to the item, the pack type, or the pocket?
4. How should a device in a pack (AED, O₂ tank) appear on the contents list compared with a
   consumable? This is related to the duplicate "AED / AED 1" on MRC 2 (#65).
5. After a check-off, what do we need to know later: the current count only, or the history of counts?

### 3. Organization (owner: Lang)
Where things live and what they're called: rooms, shelves, bins, packs, pockets.
**Output:** a first draft of #58, linked on the issue.

Open questions for the team:
1. What is the smallest place we label: room, shelf, or bin? Does every item have exactly one home?
2. How should rooms, shelves and bins be named so a new member can find something without asking?
3. Are pocket names and order the same for every pack of a type, and does the app's order match the
   real bag?
4. How are packs named or numbered, and where is that name written on the bag?
5. Where do expired and training-only items live, and what keeps them out of packs?

### 4. Turn the list into issues (owner: Ivan)
Every line from part 1 becomes an issue with one owner. If the walkthrough changes what matters most,
reorder #60, #62 and #68.
**Output:** issues created, and the order agreed.

## Code: after the session, same owners

| Issue | What | Owner | When |
|---|---|---|---|
| #61 | Clearer bottom button; the empty pressure and pad-date boxes look required | Ian (Lang if Ian is out) | Outside the session, PR by Sun 11/22 |
| #60 | Shortages flag instead of block (D-37) | Ivan + Claude; Sid reviews `app/lib` | After the session, PR by Sun 11/22 |
| #68 | Flag dialog lists only real failures (D-39) | Sid | After the session, PR by Sun 11/22 |
| #62 | Pad date filled in from the AED's record | Ian | After the session, by Fri 12/4 |

Part 4 can change this order.

## Parking lot (write questions here, don't debate them)

-
