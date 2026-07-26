'use client';

/** List view for the Shifts board — events sorted by date (as delivered by
 *  `subscribeEvents`), same viewer color semantics as the calendar. */

import { Chip } from '@heroui/react';
import { MapPin, Clock, CalendarDays } from 'lucide-react';
import type { Event, ShiftRequest } from '@/app/types';
import {
  formatEventDate,
  formatTimeRange,
  getViewerRelation,
  teamSummaryLines,
  pendingCountForEvent,
  VIEWER_COLOR_CHIP,
} from './event-utils';

interface EventListProps {
  events: Event[];
  myRequests: ShiftRequest[];
  pendingRequests: ShiftRequest[];
  canManage: boolean;
  onSelectEvent: (event: Event) => void;
}

export default function EventList({ events, myRequests, pendingRequests, canManage, onSelectEvent }: EventListProps) {
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
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
