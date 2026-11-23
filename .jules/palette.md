# Palette UX & Accessibility Journal

## 2026-11-23 - Guarding Destructive Batch Cleanup Actions Against Double-Submission
**Learning:** Batch file-move actions (`Move to Safe Quarantine` and `Send to Recycle Bin`) in the sticky cleanup bar lacked pending/disabled states, leaving users without progress feedback and allowing accidental duplicate submissions on slow disk operations.
**Action:** Track the active cleanup mode (`cleanupLoading`) to disable sibling controls, expose `aria-busy`, display inline progress copy, and enforce `focus-visible` outlines across all action bar buttons.
