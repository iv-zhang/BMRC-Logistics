# Audit & Restock System Overhaul — Implementation Plan

## Problem Statement

The current audit and restock system has several issues:
1. **Duplicated audit systems** — Stack audit, admin audit modal, and audit events page are disconnected
2. **Legacy field usage** — `totalStockQuantity` (deprecated) still used instead of `unopenedBoxes`
3. **Two disconnected restock systems** — shelf-based `/restock` page vs statpack check-in restock
4. **No easy "do I have bandaids?" view** — inventory page is admin-heavy, not audit-friendly
5. **No delegated audit permissions** — only admins can audit
6. **Disposables tracking confusion** — should be boxes/bags in the back only, not individual items

## Core Business Rules

### Disposables (boxes/bags in the back)
- Tracked as **unopened boxes/bags** with a defined quantity inside
- Each box/bag has a **QR code** for scanning
- Only tracked in the **Back Room** — front area is not tracked
- When front runs low → take a box from back → mark as "consumed" → refill front
- `unopenedBoxes` is the source of truth, NOT `totalStockQuantity`

### Assets (full lifecycle tracking)
- Tracked individually by serial/barcode at ALL times
- Status: Ready / In Use / Checked Out / Maintenance
- Location tracked always
- Full history/timeline

## Changes to Implement

### Phase 1: Consolidate & Fix Core Logic
1. **New unified audit page** (`/audit`) — replaces the stub
2. **Fix stack audit** to use `unopenedBoxes` instead of `totalStockQuantity`
3. **Audit permissions** — `canAudit` field on User, admin can grant

### Phase 2: Streamlined Audit UI
1. **Quick Audit View** — "What do I have?" cards showing box counts
2. **Zone-based audit** — select a zone, walk through items
3. **Mobile-first design** — large touch targets, swipe navigation
4. **Member dashboard audit button** — visible to authorized members

### Phase 3: Restock Workflow Fix
1. **Consume box flow** — clear "Take from back → Mark consumed → Refill front" workflow
2. **Low stock alerts** — based on `unopenedBoxes` vs `reorderThreshold`
3. **Restock history** — unified log

### Phase 4: Testing Framework
1. **Automated test suite** for all audit/restock operations
2. **Console logging framework** for debugging
3. **Visual regression tests** (screenshot-based)

## Files to Create/Modify

### New Files
- `app/audit/page.tsx` — Unified audit page (REPLACE stub)
- `app/audit/quick-audit.tsx` — Quick inventory snapshot view
- `app/lib/audit-helpers.ts` — Consolidated audit logic
- `app/components/audit-item-card.tsx` — Reusable audit item card
- `app/components/audit-permission-modal.tsx` — Grant audit access modal
- `tests/audit-restock.test.ts` — Test framework

### Modified Files
- `app/audit/stack-audit-client.tsx` — Fix to use `unopenedBoxes`
- `app/types.ts` — Add `canAudit` to User, clean up duplicates
- `app/dashboard/member-dashboard.tsx` — Add audit button for authorized members
- `app/dashboard/page.tsx` — Add audit shortcut for admins
- `app/hooks/useUserRole.tsx` — Expose `canAudit` permission
