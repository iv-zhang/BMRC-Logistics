# Inventory page — layout rules

### Inventory Scroll Rule
On desktop (`md:` and up) `/inventory` is a **fixed-height app shell**: the page wrapper is `md:h-screen md:overflow-hidden`, and the item list (list view) / table body (table view) is the **only** scroll region. The filter sidebar, page title, and search/toolbar row stay pinned in view.

Never solve sidebar overflow with `sticky` or by scrolling the `<aside>` itself — `sticky` clips the bottom of a tall sidebar with no way to reach it, and scrolling the aside creates a second competing scroll area. The correct fix is to keep the sidebar **short enough to fit one viewport** (it is deliberately dense: `p-3` cards, `text-[13px]` rows). The one bounded exception is the category list, which may scroll internally if the org has more categories than fit.

Below `md`, the page reverts to a single unified page scroll with the filters in a collapsible disclosure — so every height/overflow class in this layout must be `md:`-prefixed.

This page and `/dashboard` are the canonical UI reference for the rest of the app — follow the `bmrc-ui` skill.
