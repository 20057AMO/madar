---
name: accessibility
description: WCAG implementation — semantic HTML, keyboard navigation, focus management, contrast, ARIA, touch targets. Use when building or auditing UI for inclusive use. Use PROACTIVELY when a new component, view, dialog or form ships — accessibility is structure, not polish; it is cheapest at build time.
---

# Accessibility skill

Scope: interface elements that work for keyboard-only, screen-reader and low-vision users — on a dark-only web UI with custom modals, tabs and canvas.

## Semantic HTML first
- Use native elements before ARIA: buttons are `<button>`, links are `<a href>`, lists are `<ul>/<ol>`, headings in document order
- Interactive styling on a non-interactive element (div with onClick) is a defect: convert it, don't patch it with roles

## Keyboard navigation
- Every interactive control is reachable by Tab and operable by Enter/Space where the platform expects it
- Custom components that behave like tabs/menus/dialogs implement the standard key contract (arrow keys in a tablist, Esc closes a dialog/modal)
- No keyboard traps: the focus never gets stranded inside a component with no way out

## Focus management
- Modals (ConfirmModal, ReAuthModal): focus moves IN on open, returns to the trigger on close, and background stays inert (aria-modal + focus containment)
- Route changes and async-loaded panels announce their arrival; focus follows a deliberate path, never the page bottom
- Visual focus indicators stay visible — never `outline: none` without a replacement

## Contrast and color
- Text meets WCAG contrast on the dark theme — muted/skeleton states included; do not rely on color alone to convey state (add the icon/text, like success/error badges do)
- The dark-only theme makes contrast easier to hold, but check the muted grays and chip backgrounds specifically

## ARIA
- Label everything: `aria-label` on icon-only buttons, `aria-labelledby` on dialogs, `aria-live` on status regions that update (loading banners, save confirmations)
- Never over-announce: `aria-live` on a whole page is noise; put it on the region that changes
- `aria-expanded`/`aria-controls` on disclosure toggles; update them with state, not on mount only

## Touch targets
- Tap targets ≥ 44px on touch; dense icon rows (table actions, chip remove buttons) get spacing or a larger hit area
- Touch and keyboard paths must reach the same actions — a row clickable by mouse that is not keyboard-operable fails both

**Example**
ConfirmModal → focus moves to the confirm button on open, Esc dismisses, `aria-modal` holds background inert, focus returns to the trigger after close, danger variant keeps its red + icon (not red alone). Verdict: add keyboard test before merge.

Accessibility is not a feature you add; it is a defect you remove by building correctly.