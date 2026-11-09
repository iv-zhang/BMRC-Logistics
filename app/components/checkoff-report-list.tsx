'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Button, Chip, Spinner } from '@heroui/react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { db } from '@/firebase';
import LoadFailureNotice, { describeLoadError } from '@/app/components/load-failure-notice';
import type { StatpackLog } from '@/app/types';

const PAGE = 50;
type ActionFilter = 'all' | 'checkout' | 'checkin' | 'audit';
type LogRow = StatpackLog & { id: string };
type Entry = NonNullable<StatpackLog['checkEntries']>[number];

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const o = v as { toDate?: () => Date; seconds?: number };
  if (typeof o.toDate === 'function') {
    try { return o.toDate(); } catch { return null; }
  }
  if (typeof o.seconds === 'number') return new Date(o.seconds * 1000);
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function relative(d: Date | null): string {
  if (!d) return '—';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  return `${days}d ago`;
}

function absolute(d: Date | null): string {
  return d ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

const ACTION_LABEL: Record<string, string> = {
  checkout: 'Checkout', checkin: 'Check-in', audit: 'Audit',
};
const ACTION_COLOR: Record<string, 'primary' | 'success' | 'secondary' | 'default'> = {
  checkout: 'primary', checkin: 'success', audit: 'secondary',
};

const wasRestocked = (e: Entry) => e.restockStatus === 'restocked';

function analyze(log: StatpackLog) {
  const entries = log.checkEntries ?? [];
  const shortages = entries.filter(
    (e) => typeof e.countedQuantity === 'number' && typeof e.requiredQuantity === 'number'
      && e.countedQuantity < e.requiredQuantity && !wasRestocked(e) && !e.issue,
  ).length;
  const acknowledged = entries.filter((e) => e.acknowledged).length;
  const reported = entries.filter((e) => e.issue).length;
  const psis = entries.filter((e) => typeof e.oxygenPsi === 'number').map((e) => e.oxygenPsi as number);
  const aed = entries.filter((e) => e.assetCheckResult);
  const aedBad = aed.filter((e) => e.assetCheckResult?.padsSealed === false).length;
  const sharpsFull = log.sharpsCheck?.status === 'full';
  const flagged = shortages > 0 || acknowledged > 0 || reported > 0 || aedBad > 0 || sharpsFull;
  return { entries, shortages, acknowledged, reported, psis, aed, aedBad, sharpsFull, flagged };
}

function EntryRow({ e }: { e: Entry }) {
  const exp = toDate(e.newExpirationDate);
  const bits: string[] = [];
  if (wasRestocked(e)) bits.push('restocked');
  else if (e.restockStatus === 'shelf_empty') bits.push('shelf empty');
  if (e.issue) bits.push(`reported ${e.issue.type}${e.issue.quantity ? ` ×${e.issue.quantity}` : ''}${e.issue.notes ? ` — ${e.issue.notes}` : ''}`);
  if (e.acknowledged) bits.push(`acknowledged${e.acknowledgeReason ? `: ${e.acknowledgeReason}` : ''}`);
  if (typeof e.oxygenPsi === 'number') bits.push(`${e.oxygenPsi} PSI`);
  if (e.regulatorOk != null) bits.push(`regulator ${e.regulatorOk ? 'OK' : 'not OK'}`);
  if (e.assetCheckResult) {
    const a = e.assetCheckResult;
    bits.push(`pads ${a.padsSealed == null ? '—' : a.padsSealed ? 'sealed' : 'not sealed'}, battery ${a.batteryStatus ?? '—'}`);
  }
  if (exp) bits.push(`exp ${exp.toLocaleDateString([], { month: 'short', year: 'numeric' })}`);
  if (e.notes) bits.push(e.notes);
  const short = typeof e.countedQuantity === 'number' && typeof e.requiredQuantity === 'number' && e.countedQuantity < e.requiredQuantity;
  return (
    <div className="grid grid-cols-[1fr_auto] gap-x-3 py-1.5 border-t border-divider text-xs">
      <div className="min-w-0">
        <span className="font-medium text-foreground">{e.itemName || '—'}</span>
        {e.pocket ? <span className="text-foreground-400"> · {String(e.pocket)}</span> : null}
        {bits.length > 0 && <p className="text-foreground-500 break-words">{bits.join(' · ')}</p>}
      </div>
      <span className={`font-mono tabular-nums ${short ? 'text-warning' : 'text-foreground-600'}`}>
        {typeof e.countedQuantity === 'number' ? e.countedQuantity : '—'}/{typeof e.requiredQuantity === 'number' ? e.requiredQuantity : '—'}
      </span>
    </div>
  );
}

function Row({ log }: { log: LogRow }) {
  const [open, setOpen] = useState(false);
  const a = useMemo(() => analyze(log), [log]);
  const ts = toDate(log.timestamp) ?? toDate(log.clientTimestamp);
  return (
    <div data-testid="checkoff-report-row" className="bg-content1 border border-divider rounded-large">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left"
      >
        {open ? <ChevronDown size={16} className="mt-1 flex-none text-foreground-400" /> : <ChevronRight size={16} className="mt-1 flex-none text-foreground-400" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-foreground">{log.statpackName || '—'}</span>
            <Chip size="sm" variant="flat" color={ACTION_COLOR[log.action] ?? 'default'}>
              {ACTION_LABEL[log.action] ?? log.action}
            </Chip>
            <span className="text-xs text-foreground-500">{log.userName || '—'}</span>
            {log.eventName && <span className="text-xs text-foreground-400">· {log.eventName}</span>}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1">
            {a.shortages > 0 && <Chip size="sm" variant="flat" color="warning">{a.shortages} short</Chip>}
            {a.acknowledged > 0 && <Chip size="sm" variant="flat" color="warning">{a.acknowledged} acknowledged</Chip>}
            {a.reported > 0 && <Chip size="sm" variant="flat" color="danger">{a.reported} reported</Chip>}
            {a.psis.length > 0 && <Chip size="sm" variant="flat">O₂ {a.psis.join(', ')} PSI</Chip>}
            {a.aed.length > 0 && (
              <Chip size="sm" variant="flat" color={a.aedBad > 0 ? 'danger' : 'default'}>
                AED {a.aedBad > 0 ? 'issue' : 'checked'}
              </Chip>
            )}
            {a.sharpsFull && <Chip size="sm" variant="flat" color="warning">Sharps full</Chip>}
            {log.quickCheckin && <Chip size="sm" variant="flat">Quick check-in</Chip>}
            {!a.flagged && <Chip size="sm" variant="flat" color="success">All good</Chip>}
          </div>
        </div>
        <div className="text-right flex-none">
          <p className="text-xs text-foreground-600">{relative(ts)}</p>
          <p className="text-[11px] text-foreground-400">{absolute(ts)}</p>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3">
          {log.notes && <p className="text-xs text-foreground-500 mb-1">Notes: {log.notes}</p>}
          {a.entries.length === 0 ? (
            <p className="text-xs text-foreground-400 py-1">No item-level detail recorded.</p>
          ) : (
            a.entries.map((e, i) => <EntryRow key={`${e.itemId}-${i}`} e={e} />)
          )}
        </div>
      )}
    </div>
  );
}

export default function CheckoffReportList() {
  const [max, setMax] = useState(PAGE);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loadedMax, setLoadedMax] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [action, setAction] = useState<ActionFilter>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const q = query(collection(db, 'statpack_logs'), orderBy('timestamp', 'desc'), limit(max));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LogRow, 'id'>) })));
        setError(null);
        setLoadedMax(max);
      },
      (err) => {
        console.error('check-off reports snapshot error', err);
        setError(err ?? true);
        setLoadedMax(max);
      },
    );
    return () => unsub();
  }, [max, retry]);

  const loading = loadedMax !== max;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (action === 'all' ? !['checkout', 'checkin', 'audit'].includes(r.action) : r.action !== action) return false;
      if (!term) return true;
      return (r.statpackName || '').toLowerCase().includes(term) || (r.userName || '').toLowerCase().includes(term);
    });
  }, [rows, action, search]);

  const chips: Array<{ k: ActionFilter; label: string }> = [
    { k: 'all', label: 'All' }, { k: 'checkout', label: 'Checkout' },
    { k: 'checkin', label: 'Check-in' }, { k: 'audit', label: 'Audit' },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
      <div className="bg-content1 border border-divider rounded-large p-3 mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[220px] flex items-center gap-2 bg-content2 border border-divider rounded-medium px-3 py-0.5">
          <Search size={15} className="text-foreground-400 flex-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by pack or person…"
            aria-label="Search check-offs"
            className="flex-1 text-sm bg-transparent outline-none py-2 text-foreground placeholder:text-foreground-400"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {chips.map((c) => (
            <Chip
              key={c.k}
              as="button"
              size="sm"
              variant={action === c.k ? 'solid' : 'flat'}
              color={action === c.k ? 'primary' : 'default'}
              className="cursor-pointer"
              onClick={() => setAction(c.k)}
            >
              {c.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {error ? (
          <LoadFailureNotice
            title="Couldn't load check-off reports"
            message={describeLoadError(error)}
            onRetry={() => { setLoadedMax(null); setRetry((n) => n + 1); }}
          />
        ) : loading && rows.length === 0 ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-sm text-foreground-400">No check-offs match.</div>
        ) : (
          filtered.map((r) => <Row key={r.id} log={r} />)
        )}
      </div>

      {!error && rows.length >= max && (
        <div className="flex justify-center mt-4">
          <Button size="sm" variant="flat" isLoading={loading} onPress={() => setMax((m) => m + PAGE)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
