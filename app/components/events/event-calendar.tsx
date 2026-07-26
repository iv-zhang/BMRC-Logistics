'use client';

/** Month calendar grid (Mon–Sun) for the Shifts board. Each day cell lists that
 *  day's events as small color-coded pills (see `getViewerRelation` in
 *  `event-utils.ts`). Managers additionally see a danger dot on pills for
 *  events with pending requests. */

import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Event, ShiftRequest } from '@/app/types';
import { toJsDate, getViewerRelation, VIEWER_COLOR_PILL, pendingCountForEvent } from './event-utils';

interface EventCalendarProps {
  month: Date;
  onMonthChange: (d: Date) => void;
  events: Event[];
  myRequests: ShiftRequest[];
  pendingRequests: ShiftRequest[];
  canManage: boolean;
  onSelectEvent: (event: Event) => void;
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Always 6 weeks (42 cells), Monday-first, so the grid height never jumps between months. */
function buildMonthGrid(month: Date): Date[][] {
  const year = month.getFullYear();
  const mo = month.getMonth();
  const firstOfMonth = new Date(year, mo, 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // 0 = Monday
  const start = new Date(year, mo, 1 - firstWeekday);
  const weeks: Date[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function LegendDot({ color, label }: { color: 'success' | 'warning' | 'primary' | 'default'; label: string }) {
  const dot: Record<string, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    primary: 'bg-primary',
    default: 'bg-foreground-400',
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-foreground-500">
      <span className={`w-2 h-2 rounded-full ${dot[color]}`} />
      {label}
    </span>
  );
}

export default function EventCalendar({
  month,
  onMonthChange,
  events,
  myRequests,
  pendingRequests,
  canManage,
  onSelectEvent,
}: EventCalendarProps) {
  const weeks = useMemo(() => buildMonthGrid(month), [month]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const ev of events) {
      const d = toJsDate(ev.date);
      if (!d) continue;
      const key = dateKey(d);
      const list = map.get(key) ?? [];
      list.push(ev);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const todayKey = dateKey(new Date());
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            className="w-8 h-8 rounded-medium bg-content1 border border-divider hover:bg-content2 text-foreground-500 flex items-center justify-center transition-colors duration-150"
            aria-label="Previous month"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => {
              const d = new Date();
              onMonthChange(new Date(d.getFullYear(), d.getMonth(), 1));
            }}
            className="text-xs font-semibold px-2.5 py-1.5 rounded-medium bg-content1 border border-divider hover:bg-content2 text-foreground-500 transition-colors duration-150"
          >
            Today
          </button>
          <button
            onClick={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            className="w-8 h-8 rounded-medium bg-content1 border border-divider hover:bg-content2 text-foreground-500 flex items-center justify-center transition-colors duration-150"
            aria-label="Next month"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="bg-content1 border border-divider rounded-large overflow-hidden">
        <div className="grid grid-cols-7 bg-content2 border-b border-divider">
          {WEEKDAY_LABELS.map((d) => (
            <div
              key={d}
              className="px-2 py-2 text-[11px] font-semibold uppercase tracking-widest text-foreground-400 text-center"
            >
              {d}
            </div>
          ))}
        </div>
        <div className="divide-y divide-divider">
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7 divide-x divide-divider">
              {week.map((day) => {
                const key = dateKey(day);
                const inMonth = day.getMonth() === month.getMonth();
                const isToday = key === todayKey;
                const dayEvents = eventsByDay.get(key) ?? [];
                return (
                  <div
                    key={key}
                    className={`min-h-[92px] sm:min-h-[112px] p-1.5 flex flex-col gap-1 ${!inMonth ? 'bg-content2/40' : ''} ${isToday ? 'bg-primary-50/40 dark:bg-primary-900/10' : ''}`}
                  >
                    <span
                      className={`text-xs font-semibold ${inMonth ? 'text-foreground' : 'text-foreground-300'} ${isToday ? 'text-primary' : ''}`}
                    >
                      {day.getDate()}
                    </span>
                    <div className="flex flex-col gap-1 overflow-hidden">
                      {dayEvents.slice(0, 3).map((ev) => {
                        const relation = getViewerRelation(ev, myRequests);
                        const pending = canManage ? pendingCountForEvent(ev.id, pendingRequests) : 0;
                        return (
                          <button
                            key={ev.id}
                            onClick={() => onSelectEvent(ev)}
                            title={ev.name}
                            className={`w-full text-left truncate text-[10px] font-semibold px-1.5 py-0.5 rounded flex items-center gap-1 ${VIEWER_COLOR_PILL[relation.color]}`}
                          >
                            <span className="truncate">{ev.name}</span>
                            {pending > 0 && <span className="w-1.5 h-1.5 rounded-full bg-danger flex-none" />}
                          </button>
                        );
                      })}
                      {dayEvents.length > 3 && (
                        <span className="text-[10px] text-foreground-400 px-1.5">+{dayEvents.length - 3} more</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4 flex-wrap px-1">
        <LegendDot color="success" label="Confirmed" />
        <LegendDot color="warning" label="Requested" />
        <LegendDot color="primary" label="Available" />
        <LegendDot color="default" label="Closed / draft" />
        {canManage && (
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground-500">
            <span className="w-1.5 h-1.5 rounded-full bg-danger" /> Pending requests
          </span>
        )}
      </div>
    </div>
  );
}
