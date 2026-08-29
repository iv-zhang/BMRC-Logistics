'use client';

/** List view for the Shifts board — events sorted by date (as delivered by
 *  `subscribeEvents`), same viewer color semantics as the calendar. */

import { Chip } from '@heroui/react';
import { MapPin, Clock, CalendarDays, Lock } from 'lucide-react';
import type { Event, ShiftRequest, User } from '@/app/types';
import {
  formatEventDate,
  formatTimeRange,
  getViewerRelation,
  teamSummaryLines,
  pendingCountForEvent,
  toJsDate,
  VIEWER_COLOR_CHIP,
} from './event-utils';
import { getTierAccess, type MemberShiftStats } from '@/app/lib/events';

interface EventListProps {
  events: Event[];
  myRequests: ShiftRequest[];
  pendingRequests: ShiftRequest[];
  canManage: boolean;
  onSelectEvent: (event: Event) => void;
  /** [Phase 2 / waitlist plan §5.3] The viewer's own shift stats, for the
   *  priority-access chip's `getTierAccess` eligibility check below. */
  viewerStats: MemberShiftStats;
  userData: User | null;
}

export default function EventList({
  events,
  myRequests,
  pendingRequests,
  canManage,
  onSelectEvent,
  viewerStats,
  userData,
}: EventListProps) {
  // [Phase 2 / waitlist plan §5.3, T3] One `now` per render — this component
  // maps every event in the list, so `new Date()` must not be called inside
  // that map. Deliberately not live-updating on an idle tab (P6); no timer.
  const now = new Date();
  if (events.length === 0) {
    return (
      <div className="bg-content1 border border-divider rounded-large px-6 py-12 text-center">
        <CalendarDays size={40} className="mx-auto mb-3 text-foreground-400" />
        <p className="text-sm text-foreground-500">No events scheduled yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {events.map((ev) => {
        const relation = getViewerRelation(ev, myRequests);
        const pending = canManage ? pendingCountForEvent(ev.id, pendingRequests) : 0;
        const teams = teamSummaryLines(ev.teams || []);
        // [Phase 2 / waitlist plan §5.3] Second, independent chip — tier vs.
        // "is this open to me" are different axes, so this never merges into
        // `relation.color`. Disappears on its own once general access opens,
        // no stored dismissal state. Rendered for every viewer, managers
        // included — they bypass the gate (always `eligible`, so green) but
        // still need to see the event is tiered.
        const generalOpensAt = toJsDate(ev.accessTier?.generalOpensAt);
        const tierActive = !!ev.accessTier?.enabled && !!generalOpensAt && now < generalOpensAt;
        const tierEligible = tierActive && getTierAccess(ev, userData, viewerStats, now).eligible;
        return (
          <div
            key={ev.id}
            onClick={() => onSelectEvent(ev)}
            className="flex flex-col gap-2 bg-content1 border border-divider rounded-large px-4 py-4 cursor-pointer hover:border-primary/30 hover:shadow-sm transition-all duration-150"
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-semibold text-foreground">{ev.name}</span>
                  <Chip size="sm" variant="flat" color={VIEWER_COLOR_CHIP[relation.color]}>
                    {relation.label}
                  </Chip>
                  {tierActive && (
                    <Chip
                      size="sm"
                      variant="flat"
                      color={tierEligible ? 'success' : 'secondary'}
                      startContent={<Lock size={11} />}
                    >
                      Priority access
                    </Chip>
                  )}
                  {pending > 0 && (
                    <Chip size="sm" variant="flat" color="danger">
                      {pending} pending
                    </Chip>
                  )}
                </div>
                <div className="flex items-center gap-3 text-xs text-foreground-400 mt-1 flex-wrap">
                  <span>{formatEventDate(ev.date)}</span>
                  {(ev.venue || ev.location) && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={11} /> {ev.venue || ev.location}
                    </span>
                  )}
                  {formatTimeRange(ev.callTime, ev.endTime) && (
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} /> {formatTimeRange(ev.callTime, ev.endTime)}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap mt-1">
              {teams.map((t) => (
                <span
                  key={t.teamId}
                  className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-content2 text-foreground-500"
                >
                  {t.name}: FTO {t.ftoOk ? '✓' : '—'} · EMT {t.emtFilled}/{t.emtCount}
                  {t.hasIntern ? ` · Intern ${t.internFilled ? '✓' : '—'}` : ''}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
