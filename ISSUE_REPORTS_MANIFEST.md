# Issue Reports Feature - Complete File Manifest

## Summary
Full in-app bug/issue reporting system for BMRC Logistics platform. Members submit reports via modal, admins triage in dedicated page. No Cloud Functions, all data in Firestore with audit logging.

## New Source Files

### Core Library
**File:** `app/lib/reports.ts` (200 lines)  
**Purpose:** Firestore helper functions for creating, updating, and querying reports  
**Exports:**
- `createReport()` — Submit new issue report + audit event
- `updateReport()` — Change status/priority/assignment + audit event
- `addComment()` — Add triage comment + audit event
- `subscribeToOpenReports()` — Real-time open reports (optional)
- `subscribeToAllReports()` — Real-time all reports with filters

### UI Components
**File:** `app/components/IssueReportForm.tsx` (280 lines)  
**Purpose:** Member-facing issue submission modal  
**Props:**
- `isOpen` — Modal visibility state
- `onOpenChange` — State setter
- `pagePath` — Pre-filled page context (optional)
- `component` — Pre-filled component name (optional)
- `targetCollection` — Linked entity collection (optional)
- `targetDocId` — Linked entity ID (optional)
- `onSuccess` — Callback on successful submission

**Features:**
- Type, priority, title, description fields
- Optional reproduction steps (multiline)
- Anonymous reporting toggle
- Validation & error messages
- Success toast on submit
- Full HeroUI integration

---

**File:** `app/components/IssueTriageModal.tsx` (390 lines)  
**Purpose:** Admin triage/resolution modal  
**Props:**
- `isOpen` — Modal visibility state
- `onOpenChange` — State setter
- `report` — IssueReport to display
- `admins` — Array of { id, name } for assignment dropdown
- `onSuccess` — Callback on save

**Features:**
- Full report details display
- Status/priority/assignment dropdowns
- Comment thread display
- Add comment textarea
- Change log with admin names & timestamps
- Audit event creation on save
- Full HeroUI integration

---

### Pages
**File:** `app/issue-reports/page.tsx` (330 lines)  
**Purpose:** Admin-only triage dashboard/list page  
**Features:**
- Admin role check (shows access denied for members)
- Real-time stats cards (Open, In Progress, Resolved, Total)
- Filter controls:
  - Search by title/description/reporter
  - Status filter (All/Open/Triaged/In Progress/Resolved/Closed)
  - Priority filter (All/Low/Medium/High/Urgent)
- Report card list with:
  - Title & description preview
  - Priority & status badges
  - Reporter (or "Anonymous")
  - Assigned-to badge (if assigned)
  - Creation date
- Click to open triage modal
- Real-time updates via onSnapshot
- Mobile responsive layout
- Skeleton loading state
- Empty state message

---

## Modified Source Files

### Type Definitions
**File:** `app/types.ts`  
**Changes:** Added `IssueReport` interface with full schema:
```typescript
export interface IssueReport {
  id?: string;
  reporter: {
    userId: string | null;
    userName?: string | null;
    userEmail?: string | null;
    isAnonymous?: boolean;
  };
  target?: { collection?: string; docId?: string };
  type: 'bug' | 'feedback' | 'improvement' | 'question';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'triaged' | 'in_progress' | 'resolved' | 'closed';
  title: string;
  description: string;
  reproductionSteps?: string[];
  pagePath?: string;
  component?: string;
  assignedTo?: { userId?: string; userName?: string } | null;
  comments?: Array<{ commentId?, by, message, timestamp }>;
  attachments?: Array<{ name, url }>;
  linkedAuditId?: string;
  createdAt: Date | FieldValue;
  updatedAt: Date | FieldValue;
}
```

---

### Navigation & Layout
**File:** `app/components/appnavbar.tsx`  
**Changes:**
1. Added import of `IssueReportForm` component
2. Added import of `ExclamationTriangleIcon` from heroicons
3. Added state: `const [isReportOpen, setIsReportOpen] = useState(false);`
4. Added Report Issue button in navbar (orange ⚠️ icon):
   ```tsx
   <Button
     isIconOnly
     className="bg-warning text-white hover:bg-warning-600"
     size="sm"
     onPress={() => setIsReportOpen(true)}
   >
     <ExclamationTriangleIcon className="w-5 h-5" />
   </Button>
   ```
5. Added Issue Reports link to admin menu:
   ```tsx
   {isAdmin && (
     <NavbarItem isActive={isActive('/issue-reports')}>
       <Link href="/issue-reports">
         <ExclamationTriangleIcon className="w-5 h-5 mr-1" />
         Issues
       </Link>
     </NavbarItem>
   )}
   ```
6. Added IssueReportForm modal at end of navbar:
   ```tsx
   <IssueReportForm
     isOpen={isReportOpen}
     onOpenChange={setIsReportOpen}
     pagePath={pathname}
   />
   ```

---

## Documentation Files

### Implementation Guide
**File:** `ISSUE_REPORTS_IMPLEMENTATION.md`  
**Purpose:** Complete feature documentation for developers  
**Includes:**
- Overview of feature
- Type definitions
- Helper library functions
- UI component descriptions
- Firestore collection schema
- Audit integration details
- Firestore rules recommendations
- Feature highlights
- Testing checklist
- File manifest
- Future enhancement ideas

### Admin Quick Start
**File:** `ISSUE_REPORTS_ADMIN_GUIDE.md`  
**Purpose:** Quick reference guide for admin users  
**Includes:**
- How to access reports
- How to monitor stats
- How to filter and search
- How to review reports
- How to triage (change status, priority, assign, comment)
- Real-time update explanation
- Common admin tasks
- Mobile & desktop info
- Troubleshooting

### Deployment Guide
**File:** `ISSUE_REPORTS_DEPLOYMENT_CHECKLIST.md`  
**Purpose:** Step-by-step deployment instructions  
**Includes:**
- Pre-deployment checklist
- Build & deploy commands
- Firestore setup (collection, indexes, rules)
- Testing checklist (member & admin)
- Data integrity checks
- Post-deployment monitoring
- Rollback instructions
- Future enhancements
- Support resources

---

## Architecture Summary

```
┌─ app/lib/reports.ts (Firestore layer)
│  └─ createReport() → addDoc + recordAuditEvent
│     updateReport() → updateDoc + recordAuditEvent
│     addComment() → arrayUnion + recordAuditEvent
│     subscribeToAllReports() → onSnapshot
│
├─ app/components/IssueReportForm.tsx (Member UI)
│  └─ Uses: createReport()
│
├─ app/components/IssueTriageModal.tsx (Admin UI)
│  └─ Uses: updateReport(), addComment()
│
└─ app/issue-reports/page.tsx (Admin page)
   ├─ Uses: subscribeToAllReports()
   └─ Renders: IssueTriageModal
```

## Key Design Decisions

1. **No Cloud Functions** — Simple Firestore writes, no backend complexity
2. **In-app triage only** — Admins don't need external tools
3. **Audit logging** — Every action recorded for compliance
4. **Type-safe throughout** — Full TypeScript support
5. **HeroUI consistent** — Uses same components as rest of app
6. **Real-time updates** — Admin page shows new reports instantly
7. **Anonymous support** — Members can report without identification
8. **Context-aware** — Reports pre-fill page/component context

## Dependencies

**No new dependencies added.** Uses existing:
- `@heroui/react` — UI components
- `firebase/firestore` — Database & realtime updates
- `firebase/auth` — User context
- `lucide-react` — Icons
- `next/navigation` — Routing

## Build Output

✅ **Zero build errors**  
✅ **Zero TypeScript errors**  
✅ **Route added:** `/issue-reports`  
✅ **Static prerender:** 27/27 pages  

## Testing Status

- Member report submission: Ready for testing
- Admin triage page: Ready for testing
- Real-time updates: Ready for testing
- Firestore rules: Pending deployment

---

**Total Implementation:** ~1,200 lines of code + 3 documentation files  
**Complexity:** Low (no external APIs, no async state management)  
**Time to Deploy:** 5-10 minutes  
**Risk Level:** Very Low  

Ready for beta testing! 🚀
