'use client';

/**
 * [Phase 3.5 / waitlist plan §5.8 (P15)] The one place explanatory copy goes
 * on an AUTHOR-facing surface (the event editor, /settings) once it stops
 * earning its permanent place on screen.
 *
 * The complaint this answers: P11 ("nothing hardcoded") produced a lot of
 * knobs, and each knob arrived with a sentence justifying it. Individually
 * every sentence is defensible; stacked, they turned a form into an essay.
 *
 * This moves the sentence, it does NOT delete it. Three kinds of text stay on
 * screen and must never be passed to this component (§5.8, "the keep rule"):
 *
 *   1. A warning or a policy promise — a caveat behind hover has stopped working.
 *   2. Live state — a hint implies static help; a stale-looking hint reads as decoration.
 *   3. Instruction for what to type, read while typing — interpolation keys
 *      (`{hours}`), conventions like `0 = unlimited`.
 *
 * And the member-facing exception: on member surfaces the text IS the feature
 * (§5.3's pre-emptive explanation, P4's non-binding reassurance, a tier
 * `rationale`). Do not hide those. If they read long, shorten the sentence.
 *
 * Accessibility is why the trigger is focusable and carries an `aria-label`:
 * HeroUI opens on focus, so keyboard and screen-reader users get the same text
 * a mouse user gets. `isOpen` is controlled so a TAP works too — HeroUI's
 * Tooltip does not open on touch, and managers create events on a phone.
 *
 * The trigger is a `<span role="button" tabIndex={0}>` and NOT a real
 * `<button>`. That is load-bearing, not a style choice (see §10.3 D27):
 *
 *   - A hint belongs beside a field's LABEL, and HeroUI renders a `Select`'s
 *     label *inside* the trigger `<button>`. `<button>` inside `<button>` is
 *     illegal HTML and React reports it as a hydration error.
 *   - An `Input`'s label is a real `<label>`, whose content model forbids
 *     labelable descendants — a `<button>` is one. Same bug, no warning.
 *   - `<span>` is not "interactive content" per the HTML content model, so it
 *     is valid in both places, while `role="button"` + `tabIndex` + a keyboard
 *     handler keep it a button for assistive tech.
 *
 * The click handler also stops propagation: without it, tapping the ⓘ inside a
 * label focuses the field, and inside a `Select` trigger it opens the dropdown
 * behind the tooltip. Any future refactor that reaches for `<button>` here
 * reintroduces both bugs at once.
 */

import React from 'react';
import { Tooltip, Popover, PopoverTrigger, PopoverContent } from '@heroui/react';
import { Info } from 'lucide-react';

/** Above this length a tooltip becomes an unreadable slab; use a Popover instead. */
const POPOVER_THRESHOLD = 140;

export interface FieldHintProps {
  /** The sentence that used to live on screen. Keep it to one or two sentences. */
  text: string;
  /** Optional label for the trigger; defaults to the hint text itself. */
  ariaLabel?: string;
  /** Extra classes on the trigger button (spacing only — never colour). */
  className?: string;
}

/**
 * An inline ⓘ that reveals `text` on hover, focus or tap.
 *
 * Sits immediately after the label text, never on its own row — the whole
 * point is that the control collapses to one line:
 *
 *   <p className="text-sm font-medium">Enable waitlist <FieldHint text="…" /></p>
 */
export function FieldHint({ text, ariaLabel, className = '' }: FieldHintProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const label = ariaLabel ?? text;
  const triggerClass = `inline-flex items-center align-middle ml-1 cursor-help text-foreground-400 hover:text-foreground-600 outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-full ${className}`;

  // Toggle on click/Enter/Space, and never let the gesture reach the field this
  // hint is labelling (see the header comment).
  const toggle = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOpen((v) => !v);
  };

  /**
   * `PopoverTrigger` clones its child with react-aria press handlers that
   * already toggle the popover, so the manual `toggle` must be attached ONLY in
   * the Tooltip branch — a Tooltip never opens on press, which is the whole
   * reason `isOpen` is controlled. Attaching it in both branches makes the two
   * toggles cancel and the popover never opens on tap.
   */
  const renderTrigger = (withToggle: boolean) => (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      className={triggerClass}
      onClick={withToggle ? toggle : undefined}
      onKeyDown={
        withToggle
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') toggle(e);
            }
          : undefined
      }
    >
      <Info size={13} aria-hidden="true" />
    </span>
  );

  // Long copy in a tooltip is a wall of text pinned to the cursor. Prefer
  // shortening the sentence; this is the fallback when it genuinely can't be.
  if (text.length > POPOVER_THRESHOLD) {
    return (
      <Popover placement="top" showArrow isOpen={isOpen} onOpenChange={setIsOpen} size="sm">
        <PopoverTrigger>{renderTrigger(false)}</PopoverTrigger>
        <PopoverContent>
          <p className="text-xs text-foreground-600 max-w-[260px] py-2">{text}</p>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Tooltip
      content={<span className="text-xs max-w-[240px] block">{text}</span>}
      placement="top"
      size="sm"
      showArrow
      delay={200}
      closeDelay={0}
      isOpen={isOpen}
      onOpenChange={setIsOpen}
    >
      {renderTrigger(true)}
    </Tooltip>
  );
}

export default FieldHint;
