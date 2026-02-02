# Bug Reports Feature - Quick Admin Guide

## What's New
Members can now report bugs and issues directly from the app. Admins review, triage, and track resolution all in one place.

## Member Experience
- **Report Issue Button** — Orange ⚠️ button in top navbar (visible to all members)
- **Report Modal** — Simple form with:
  - Issue type (Bug, Feedback, Improvement, Question)
  - Priority level (Low, Medium, High, Urgent)
  - Title & description
  - Optional reproduction steps
  - Anonymous reporting toggle
  - Auto-detects page/component context
- **Confirmation** — Toast appears on successful submission

## Admin Workflow

### 1. Access Reports
- Click **"Issues"** in navbar (admin menu only)
- Or: Navbar → Account (circle) → Reports (in dropdown, admin-only)

### 2. Monitor at a Glance
- **Stat cards** at top show:
  - **Open** (red badge) — new, unreviewed reports
  - **In Progress** (blue badge) — actively being fixed
  - **Resolved** (green badge) — completed reports
  - **Total** — all reports in system

### 3. Find Reports
**Filter by Status:**
- All Statuses, Open, Triaged, In Progress, Resolved, Closed

**Filter by Priority:**
- All Priorities, Low, Medium, High, Urgent

**Search:**
- Type keywords to search title, description, or reporter name

**Combination:** Use all three together (e.g., "Urgent + Open + 'statpack'")

### 4. Review a Report
- Click any report card to open full details modal
- See:
  - **Title** — Issue summary
  - **Description** — Full details
  - **Reproduction Steps** — How to recreate (if provided)
  - **Reporter** — Name & email (or "Anonymous Report")
  - **Location** — Page/component where reported
  - **Comments** — Triage conversation thread
  - **Created Date** — When submitted

### 5. Triage a Report
In the modal, you can:

**Change Status:**
- `Open` — New, needs review
- `Triaged` — Reviewed, not yet assigned
- `In Progress` — Being fixed
- `Resolved` — Fixed, awaiting close
- `Closed` — Complete

**Set Priority:**
- `Low` — Nice to have
- `Medium` — Standard
- `High` — Important
- `Urgent` — Critical

**Assign To:**
- Dropdown to assign to yourself or other admin
- Shows in report card as badge

**Add Comment:**
- Leave notes on the report
- Visible to all admins in comment thread
- Auto-saves with triage changes

**Save:**
- Clicking "Save Changes" updates the report and logs an audit event

### 6. Real-Time Updates
- Report list updates instantly as reports arrive
- Status badges refresh in real-time
- Comments appear immediately
- Open count updates as reports are triaged

## Common Tasks

### Triage High-Priority Bugs
1. Filter: Status = "Open" + Priority = "Urgent"
2. Click first report
3. Set Status → "In Progress"
4. Add Comment: "Investigating..."
5. Assign to yourself
6. Click "Save Changes"

### Review All Reports from a Member
1. Search: member's name
2. Review title/description pattern
3. Assign to owner or reassign priority if needed

### Close Resolved Reports
1. Filter: Status = "Resolved"
2. Click each report
3. Change Status → "Closed"
4. Add Comment: "Fixed in v2.1"
5. Save

### Find Issues on Specific Page
1. Search: page name (e.g., "statpack", "checkout")
2. Or see location in report detail (shows Page: `/statpacks`)

## Data Recorded

Every report action is logged to the audit trail:
- Report created (with type, priority, reporter)
- Status changed (with new status)
- Assigned to (with assignee name)
- Comments added (with comment text)

**Access:** Navbar → Inventory → Audit Logs, then filter by source = `issue_reports`

## Tips & Best Practices

✓ **Set priority immediately** — Helps other admins understand urgency  
✓ **Assign early** — Prevents duplicate work  
✓ **Comment as you investigate** — Keeps team in sync  
✓ **Close when done** — Keeps list clean and focused on open items  
✓ **Use "Triaged" for deferral** — If you've reviewed but won't fix now  
✓ **Check high-priority daily** — During beta testing with many users  

## Mobile & Desktop

- Full feature on desktop
- Mobile-responsive: all filters/modals work on phone
- Report button (⚠️) always visible in navbar

## Troubleshooting

**Reports not appearing?**
- Refresh page (real-time usually works, but manual refresh helps)
- Check status filter (may be filtering out "Open" if set to something else)
- Check role (only admins/quartermasters see this page)

**Can't edit a report?**
- Only admins/quartermasters can triage
- Member role won't see the Issues page

**Can't find a specific report?**
- Try searching by reporter name or keyword
- Check if it's in a different status
- Reports from >30 days ago may be archived (feature TBD)

---

**Questions?** Check the full feature documentation in [ISSUE_REPORTS_IMPLEMENTATION.md](ISSUE_REPORTS_IMPLEMENTATION.md)
