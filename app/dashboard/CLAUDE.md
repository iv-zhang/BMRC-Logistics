# Dashboard page — layout rules

### Dashboard Layout (differs from other pages)
`app/dashboard/page.tsx` is a full-viewport app shell, not a document page:
- Uses the standard blue gradient (`bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800`) as the page wrapper, same as other pages.
- Has a compact `h-[54px]` sticky header at `z-20` with `bg-content1/80 backdrop-blur-md`.
- No standard page header block (`text-2xl` title + stats row). Content starts immediately after the sticky header.
- Uses **`framer-motion`** (`AnimatePresence` + `motion.div`) for the inline statpack detail expand panel. No other page uses framer-motion.
- Section cards have a `bg-content2` header stripe pattern with a scrollable body capped at `maxHeight: 256`.
- Statpack tiles are in a horizontal scroll row (`overflow-x-auto`, `scrollbarWidth: 'thin'`).

`page.tsx` splits into `member-dashboard.tsx` vs. the admin view based on role.

This page and `/inventory` are the canonical UI reference for the rest of the app — follow the `bmrc-ui` skill.
