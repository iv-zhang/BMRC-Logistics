# Bug Reports Feature - Deployment Checklist

## Pre-Deployment

- [x] Build succeeds: `npm run build`
- [x] No TypeScript errors
- [x] No ESLint warnings (if strict)
- [x] All HeroUI components properly used
- [x] Firestore writes follow existing patterns
- [x] Audit events logged for all actions
- [x] Type-safe throughout (full IssueReport typing)

## Files to Deploy

**New Files:**
```
app/components/IssueReportForm.tsx       (~280 lines)
app/components/IssueTriageModal.tsx      (~390 lines)
app/issue-reports/page.tsx               (~330 lines)
app/lib/reports.ts                       (~200 lines)
```

**Modified Files:**
```
app/types.ts                              (added IssueReport interface)
app/components/appnavbar.tsx              (added button & modal)
```

## Build & Deploy Commands

```bash
# Build for production
npm run build

# Deploy to Firebase Hosting
firebase deploy
```

## Firestore Setup

### 1. Create Collection & Indexes
No manual action needed — Firestore auto-creates collection on first write.

**Recommended indexes** (add to `firestore.indexes.json` or create manually):
```
Collection: issue_reports
  Index 1: Fields (status, createdAt DESC)
  Index 2: Fields (priority, createdAt DESC)
  Index 3: Fields (assignedTo.userId, status, createdAt DESC)
  Index 4: Fields (reporter.userId, createdAt DESC)
```

### 2. Add Security Rules
Add to `firestore.rules`:

```
match /issue_reports/{reportId} {
  // Authenticated users can create reports
  allow create: if request.auth != null && 
    request.resource.data.keys().hasAll(['title', 'description', 'type', 'priority', 'status', 'reporter']) &&
    request.resource.data.status == 'open' &&
    request.resource.data.type in ['bug', 'feedback', 'improvement', 'question'] &&
    request.resource.data.priority in ['low', 'medium', 'high', 'urgent'];
  
  // Users can read reports (members see only their own/anonymous, admins see all)
  allow get: if request.auth != null &&
    (resource.data.reporter.isAnonymous == false || 
     resource.data.reporter.userId == request.auth.uid ||
     get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['admin', 'quartermaster']);
  
  allow list: if request.auth != null;
  
  // Only admins can update
  allow update: if request.auth != null &&
    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['admin', 'quartermaster'];
  
  // Only admins can delete
  allow delete: if request.auth != null &&
    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['admin', 'quartermaster'];
}
```

Then deploy:
```bash
firebase deploy --only firestore:rules
```

## Testing Checklist

### Member Testing
- [ ] Click ⚠️ button in navbar
- [ ] Modal opens with form
- [ ] Select issue type dropdown works
- [ ] Select priority dropdown works
- [ ] Enter title and description
- [ ] Optionally add reproduction steps
- [ ] Toggle anonymous checkbox
- [ ] Submit report
- [ ] Success toast appears
- [ ] Modal closes
- [ ] No console errors

### Admin Testing
- [ ] Navigate to Issues page (admin menu)
- [ ] See stat cards (Open, In Progress, Resolved, Total)
- [ ] Filter by status works
- [ ] Filter by priority works
- [ ] Search by title/description/reporter works
- [ ] Click report card opens modal
- [ ] See full report details
- [ ] Change status dropdown works
- [ ] Change priority dropdown works
- [ ] Assign to admin dropdown works
- [ ] Type in comment field
- [ ] Click "Save Changes"
- [ ] Modal closes
- [ ] Report card updates with new status/badge
- [ ] Check audit logs show report creation & triage events
- [ ] No console errors

### Data Integrity
- [ ] Firestore document created with correct schema
- [ ] serverTimestamp() used for all date fields
- [ ] reporter.userId is correct (or null if anonymous)
- [ ] Audit events created for all actions
- [ ] Comments array grows as comments added

## Post-Deployment

### Monitor
- [ ] Check Firestore console for `issue_reports` collection
- [ ] Verify reports are being created with test submissions
- [ ] Check audit logs for report events
- [ ] Monitor quota usage (expect minimal with first few beta users)

### Communicate
- [ ] Announce feature to club
- [ ] Share quick start guides (see ISSUE_REPORTS_ADMIN_GUIDE.md)
- [ ] Post link to feature documentation
- [ ] Encourage members to report bugs early in beta
- [ ] Set expectations for response time

### Track
- [ ] Monitor report volume
- [ ] Track resolution time
- [ ] Gather feedback on feature usability
- [ ] Note patterns (e.g., "many reports on statpack page" = UX issue)

## Rollback (if needed)

If critical issue found:
1. Revert appnavbar.tsx to remove Report Issue button
2. Redeploy
3. Investigate issue in issue-reports page or lib/reports.ts
4. Fix and re-deploy

Reports in Firestore are safe and won't be affected by UI removal.

## Future Enhancements

1. **Email notifications** — Notify admins of high-priority reports
2. **Attachments** — Allow image/video uploads (expand lib/storage.ts)
3. **Report templates** — Pre-filled forms for common issues
4. **Bulk actions** — Close/assign multiple reports
5. **Export** — CSV/PDF reports by date range
6. **Notifications** — Member follow-up when status changes
7. **Slack integration** — Post high-priority reports to Slack
8. **Custom fields** — Add issue-type-specific fields

## Support

**For issues during beta:**
1. Check browser console for errors
2. Check Firestore console for data creation
3. Review ISSUE_REPORTS_IMPLEMENTATION.md for full details
4. Check ISSUE_REPORTS_ADMIN_GUIDE.md for admin workflows

---

**Estimated Time to Deploy:** 5-10 minutes  
**Risk Level:** Low (no Cloud Functions, simple Firestore writes, admin-only triage page)  
**Rollback Difficulty:** Very Easy (just revert navbar button)
