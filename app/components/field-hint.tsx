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
 * Accessibility is why the trigger is a real <button> rather than a <span>:
 * HeroUI opens on focus, so keyboard and screen-reader users get the same text
 * a mouse user gets. `isOpen` is controlled so a TAP works too — HeroUI's
 * Tooltip does not open on touch, and managers create events on a phone.
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
  const triggerClass = `inline-flex items-center align-middle ml-1 text-foreground-400 hover:text-foreground-600 outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-full ${className}`;

  const trigger = (
    <button
      type="button"
      aria-label={label}
      className={triggerClass}
      onClick={() => setIsOpen((v) => !v)}
    >
      <Info size={13} aria-hidden="true" />
    </button>
  );

  // Long copy in a tooltip is a wall of text pinned to the cursor. Prefer
  // shortening the sentence; this is the fallback when it genuinely can't be.
  if (text.length > POPOVER_THRESHOLD) {
    return (
      <Popover placement="top" showArrow isOpen={isOpen} onOpenChange={setIsOpen} size="sm">
        <PopoverTrigger>{trigger}</PopoverTrigger>
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
      {trigger}
    </Tooltip>
  );
}

export default FieldHint;
