# Palette UX & Accessibility Journal

## 2026-11-23 - Guarding Destructive Batch Cleanup Actions Against Double-Submission
**Learning:** Batch file-move actions (`Move to Safe Quarantine` and `Send to Recycle Bin`) in the sticky cleanup bar lacked pending/disabled states, leaving users without progress feedback and allowing accidental duplicate submissions on slow disk operations.
**Action:** Track the active cleanup mode (`cleanupLoading`) to disable sibling controls, expose `aria-busy`, display inline progress copy, and enforce `focus-visible` outlines across all action bar buttons.

## 2026-11-27 - Non-Empty List Loading Feedback During Tab/Filter/Page Transitions
**Learning:** Showing loading skeletons only when `groups.length === 0 && files.length === 0` leaves tab switches, filter changes, sorting, and pagination visually silent once results are already on screen, making slow queries feel unresponsive.
**Action:** Pair `aria-busy={listLoading}` on the workspace tabpanel with an inline `role="status"` updating indicator and dimmed list opacity (`opacity-60`) whenever `listLoading` is true with existing items.
