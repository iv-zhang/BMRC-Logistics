'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Spinner, Input } from '@heroui/react';
import {
  ArrowLeft, ArrowRight, MapPin, ChevronDown,
  Check, Plus, Minus, Shield, AlertTriangle, X,
} from 'lucide-react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import {
  doc, getDoc, getDocs, query, collection,
  where, documentId, Timestamp,
} from 'firebase/firestore';
import { auth, db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { logStatpackCheckOff } from '@/app/lib/inventory';
import { THRESHOLDS } from '@/app/config/org-config';
import type { Statpack, StatpackItem, StatpackPocket, InventoryItem } from '@/app/types';

// ─── types & constants ───────────────────────────────────────────────────────

type Mode = 'checkout' | 'checkin' | 'audit';
type SharpsStatus = 'ok' | 'full' | 'na';

type Resolution =
  | { kind: 'restocked' }
  | { kind: 'reported'; issueType: 'missing' | 'broken' | 'expired'; quantity?: number; notes?: string }
  | { kind: 'acknowledged'; reason: string };

const POCKETS: { id: StatpackPocket; name: string; code: string }[] = [
  { id: 'main',       name: 'Main Compartment',  code: 'MN' },
  { id: 'front_aux',  name: 'Front Aux Pouch',   code: 'FA' },
  { id: 'side_left',  name: 'Left Side Pocket',  code: 'LS' },
  { id: 'side_right', name: 'Right Side Pocket', code: 'RS' },
];

interface ItemChecks {
  exp?: string;
  psi?: string;
  regulatorOk?: boolean;
  padsSealed?: boolean;
  batteryOk?: boolean;
  padExp?: string;
}

interface ItemRules {
  needExp: boolean;
  needPsi: boolean;
  needAED: boolean;
  minPsi: number;
  expLabel: string;
  hasRules: boolean;
}

interface ItemIssue {
  short: boolean;
  expired: boolean;
  lowPsi: boolean;
  shortBy: number;
  any: boolean;
}

function deriveRules(item: StatpackItem): ItemRules {
  const d = item.itemDetails as any;
  const isOxygen = d?.isOxygen === true;
  const isAED = d?.assetCategory === 'AED' || /\baed\b/i.test(d?.name || '');
  const needExp =
    item.requiresExpirationCheck === true ||
    item.verificationRules?.requireExpirationConfirmation === true;
  const needPsi = isOxygen || (item.verificationRules?.requireO2PsiMin ?? 0) > 0;
  const needAED = isAED;
  const minPsi = item.verificationRules?.requireO2PsiMin ?? THRESHOLDS.o2PsiMin;
  const expLabel = needAED ? 'Pad / battery expiration' : 'Confirm expiration';
  return { needExp, needPsi, needAED, minPsi, expLabel, hasRules: needExp || needPsi || needAED };
}

// last calendar-day (inclusive) of a YYYY-MM month string, or null if unparseable
function parseMonthEnd(month?: string): Date | null {
  if (!month) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  return new Date(year, mon, 0, 23, 59, 59, 999); // day 0 of next month = last day of this month
}

function isMonthExpired(month: string | undefined, today: Date): boolean {
  const end = parseMonthEnd(month);
  if (!end) return false;
  return end.getTime() < today.getTime();
}

// The date we consider authoritative for expiry: freshly entered month wins, else stored date.
function effectiveExpDate(item: StatpackItem, rules: ItemRules, checks: ItemChecks): Date | null {
  const entered = rules.needAED ? checks.padExp : rules.needExp ? checks.exp : undefined;
  if (entered) return parseMonthEnd(entered);
  return item.expirationDate ? new Date(item.expirationDate) : null;
}

// Input completeness — ignores whether the value is in the past (that's an "issue", not "incomplete").
function checksComplete(rules: ItemRules, checks: ItemChecks): boolean {
  if (!rules.hasRules) return true;
  if (rules.needExp && !checks.exp) return false;
  if (rules.needPsi && (!checks.psi || !checks.regulatorOk)) return false;
  if (rules.needAED && (!checks.padsSealed || !checks.batteryOk || !checks.padExp)) return false;
  return true;
}

function computeIssue(
  item: StatpackItem, rules: ItemRules, found: number, checks: ItemChecks, today: Date,
): ItemIssue {
  const shortBy = Math.max(0, item.requiredQuantity - found);
  const short = shortBy > 0;
  const exp = effectiveExpDate(item, rules, checks);
  const expired = exp !== null && exp.getTime() < today.getTime();
  const lowPsi = rules.needPsi && !!checks.psi ? Number(checks.psi) < rules.minPsi : false;
  return { short, expired, lowPsi, shortBy, any: short || expired || lowPsi };
}

// "Ready" (green) = genuinely good: complete checks AND non-expired AND (for O2) in-pressure.
function isItemReady(
  item: StatpackItem,
  rules: ItemRules,
  verifiedSet: Set<string>,
  checks: ItemChecks,
  today: Date,
): boolean {
  const { needExp, needPsi, needAED, minPsi, hasRules } = rules;
  if (!hasRules) return verifiedSet.has(item.itemId);
  if (needExp && (!checks.exp || isMonthExpired(checks.exp, today))) return false;
  if (needPsi && (!checks.psi || Number(checks.psi) < minPsi || !checks.regulatorOk)) return false;
  if (needAED && (!checks.padsSealed || !checks.batteryOk || !checks.padExp || isMonthExpired(checks.padExp, today))) return false;
  return true;
}

function isResolved(res: Resolution | undefined): boolean {
  return !!res && (res.kind === 'reported' || res.kind === 'acknowledged');
}

function daysUntil(d: Date, today: Date) {
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function fmtMonthYear(d: Date) {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ─── ItemRow ─────────────────────────────────────────────────────────────────

interface ItemRowProps {
  item: StatpackItem;
  found: number;
  checks: ItemChecks;
  verifiedSet: Set<string>;
  today: Date;
  mode: Mode;
  issue: ItemIssue;
  resolution: Resolution | undefined;
  onToggle: () => void;
  onMinus: (e: React.MouseEvent) => void;
  onPlus: (e: React.MouseEvent) => void;
  onCheck: (key: keyof ItemChecks, val: string | boolean) => void;
  onRestock: () => void;
  onReport: (issueType: 'missing' | 'broken' | 'expired', quantity: number | undefined, notes: string) => void;
  onAcknowledge: (reason: string) => void;
}

function ItemRow({
  item, found, checks, verifiedSet, today, mode, issue, resolution,
  onToggle, onMinus, onPlus, onCheck, onRestock, onReport, onAcknowledge,
}: ItemRowProps) {
  const rules = useMemo(() => deriveRules(item), [item]);
  const { needExp, needPsi, needAED, minPsi, expLabel, hasRules } = rules;

  const [draft, setDraft] = useState<'report' | 'acknowledge' | null>(null);
  const [reason, setReason] = useState('');

  const verified = isItemReady(item, rules, verifiedSet, checks, today);

  const effExp = effectiveExpDate(item, rules, checks);
  const expDays = effExp ? daysUntil(effExp, today) : null;
  const isExpired = expDays !== null && expDays < 0;
  const isSoon = expDays !== null && expDays >= 0 && expDays <= THRESHOLDS.expirationWarningDays;

  const d = item.itemDetails as any;
  const isOxygen = d?.isOxygen === true;
  const serial = item.serialNumber || d?.assetSerial;
  const itemName = d?.name || `Item ${item.itemId.slice(-6)}`;
  const sub = isOxygen && serial
    ? `Serial ${serial} · max ${d?.maxPsi ?? 2000} PSI`
    : serial
    ? `Asset · ${serial}`
    : effExp
    ? `${d?.category || 'Item'} · exp ${fmtMonthYear(effExp)}`
    : d?.category || 'Item';

  const psiNum = Number(checks.psi || 0);
  const psiOk = !!checks.psi && psiNum >= minPsi;
  const psiHint = !checks.psi ? `min ${minPsi}` : psiOk ? 'OK' : `Low · min ${minPsi}`;
  const psiHintColor = !checks.psi ? 'text-warning' : psiOk ? 'text-success' : 'text-danger';

  const checksReady = checksComplete(rules, checks) && (!needExp || !isMonthExpired(checks.exp, today)) && (!needAED || !isMonthExpired(checks.padExp, today)) && (!needPsi || psiOk);
  const resolved = isResolved(resolution);
  const V = verified;
  const rowBase = V
    ? 'bg-primary border-primary cursor-default'
    : `bg-content2 border-divider ${!hasRules ? 'cursor-pointer hover:border-primary/30' : 'cursor-default'}`;

  // month input status dot: empty→warning, expired→danger, otherwise→success
  const monthDot = (val: string | undefined) =>
    !val ? 'bg-warning' : isMonthExpired(val, today) ? 'bg-danger' : 'bg-success';

  const issueLabel = [
    issue.short ? `Short ${issue.shortBy}` : null,
    issue.expired ? 'Expired' : null,
    issue.lowPsi ? 'Low PSI' : null,
  ].filter(Boolean).join(' · ');

  const submitReport = () => {
    const type: 'missing' | 'broken' | 'expired' =
      issue.expired ? 'expired' : issue.short ? 'missing' : 'broken';
    onReport(type, issue.short ? issue.shortBy : undefined, reason.trim());
    setDraft(null);
    setReason('');
  };
  const submitAck = () => {
    if (!reason.trim()) return;
    onAcknowledge(reason.trim());
    setDraft(null);
    setReason('');
  };

  const monthInputCls = {
    base: 'w-40 flex-none',
    inputWrapper: 'h-9 min-h-9 bg-content1 border border-divider data-[hover=true]:bg-content1',
    input: 'text-xs font-semibold',
  } as const;

  return (
    <div
      onClick={hasRules ? undefined : onToggle}
      className={`border rounded-xl px-3 py-3 transition-all duration-150 ${rowBase}`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-6 h-6 rounded-lg flex-none flex items-center justify-center border-2 transition-all ${
          V ? 'bg-white border-white' : 'bg-transparent border-foreground-400'
        }`}>
          <Check size={13} strokeWidth={3.5} className={V ? 'text-primary' : 'text-transparent'} />
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-sm font-semibold ${V ? 'text-white' : 'text-foreground'}`}>
              {itemName}
            </span>
            {isExpired && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${V ? 'bg-white/20 text-white' : 'bg-danger-50 dark:bg-danger-900/30 text-danger'}`}>
                Expired
              </span>
            )}
            {!isExpired && isSoon && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${V ? 'bg-white/20 text-white' : 'bg-warning-50 dark:bg-warning-900/20 text-warning'}`}>
                Expiring
              </span>
            )}
            {d?.isMed && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${V ? 'bg-white/20 text-white' : 'bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300'}`}>
                Rx
              </span>
            )}
            {isOxygen && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${V ? 'bg-white/20 text-white' : 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300'}`}>
                O₂
              </span>
            )}
            {d?.assetCategory === 'AED' && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${V ? 'bg-white/20 text-white' : 'bg-primary-50 dark:bg-primary-900/20 text-primary'}`}>
                Asset
              </span>
            )}
            {issue.short && (
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${V ? 'bg-white/20 text-white' : 'bg-warning-50 dark:bg-warning-900/20 text-warning'}`}>
                Short {issue.shortBy}
              </span>
            )}
          </div>
          <span className={`text-xs font-medium ${V ? 'text-white/70' : 'text-foreground-500'}`}>
            {sub}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-none" onClick={e => e.stopPropagation()}>
          <button
            onClick={onMinus}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-150 ${
              V ? 'bg-white/15 hover:bg-white/25 text-white' : 'bg-content3 hover:bg-content3/80 text-foreground-500'
            }`}
          >
            <Minus size={13} strokeWidth={2.7} />
          </button>
          <div className="min-w-[38px] text-center">
            <div className={`font-mono text-lg font-semibold leading-none tabular-nums ${
              V ? 'text-white' : issue.short ? 'text-warning' : 'text-foreground'
            }`}>
              {found}
            </div>
            <div className={`text-[9px] font-semibold mt-0.5 uppercase tracking-wide ${
              V ? 'text-white/60' : 'text-foreground-400'
            }`}>
              / {item.requiredQuantity}
            </div>
          </div>
          <button
            onClick={onPlus}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-150 ${
              V
                ? 'bg-white/20 hover:bg-white/30 text-white'
                : 'bg-primary-50 hover:bg-primary-100 dark:bg-primary-900/20 dark:hover:bg-primary-800/30 text-primary'
            }`}
          >
            <Plus size={13} strokeWidth={2.7} />
          </button>
        </div>
      </div>

      {hasRules && (
        <div
          onClick={e => e.stopPropagation()}
          className={`mt-3 rounded-xl p-3 border ${
            V ? 'bg-white/10 border-white/20' : 'bg-warning-50/60 dark:bg-warning-950/20 border-warning/20'
          }`}
        >
          <div className="flex items-center gap-1.5 mb-2.5">
            <Shield size={11} className={V ? 'text-white' : 'text-warning'} />
            <span className={`text-[10px] font-semibold uppercase tracking-widest ${V ? 'text-white' : 'text-warning'}`}>
              Required checks
            </span>
            <span className={`ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full ${
              checksReady
                ? V ? 'bg-white/20 text-white' : 'bg-success-50 dark:bg-success-900/20 text-success'
                : V ? 'bg-white/15 text-white/70' : 'bg-warning-50 dark:bg-warning-900/20 text-warning'
            }`}>
              {checksReady ? 'Complete' : 'Action needed'}
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {needExp && (
              <div className="flex items-center gap-2">
                <span className={`flex-1 text-xs font-semibold ${V ? 'text-white/90' : 'text-foreground-600'}`}>
                  {expLabel}
                </span>
                <Input
                  type="month"
                  size="sm"
                  aria-label={expLabel}
                  value={checks.exp ?? ''}
                  onValueChange={v => onCheck('exp', v)}
                  classNames={monthInputCls}
                />
                <span className={`w-2 h-2 rounded-full flex-none ${monthDot(checks.exp)}`} />
              </div>
            )}

            {needPsi && (
              <>
                <div className="flex items-center gap-2">
                  <span className={`flex-1 text-xs font-semibold ${V ? 'text-white/90' : 'text-foreground-600'}`}>
                    Cylinder pressure
                  </span>
                  <Input
                    type="text"
                    size="sm"
                    inputMode="numeric"
                    placeholder="PSI"
                    aria-label="Cylinder pressure PSI"
                    value={checks.psi ?? ''}
                    onValueChange={v => onCheck('psi', v.replace(/[^0-9]/g, ''))}
                    classNames={{
                      base: 'w-24 flex-none',
                      inputWrapper: 'h-9 min-h-9 bg-content1 border border-divider data-[hover=true]:bg-content1',
                      input: 'text-xs font-semibold font-mono',
                    }}
                  />
                  <span className={`text-xs font-semibold min-w-[60px] ${psiHintColor}`}>{psiHint}</span>
                </div>

                <button onClick={() => onCheck('regulatorOk', !checks.regulatorOk)} className="flex items-center gap-2 text-left">
                  <div className={`w-5 h-5 rounded-md flex-none flex items-center justify-center border-2 transition-all ${
                    checks.regulatorOk
                      ? V ? 'bg-white border-white' : 'bg-primary border-primary'
                      : V ? 'bg-transparent border-white/60' : 'bg-transparent border-foreground-400'
                  }`}>
                    <Check size={11} strokeWidth={3.5} className={checks.regulatorOk ? (V ? 'text-primary' : 'text-white') : 'text-transparent'} />
                  </div>
                  <span className={`text-xs font-semibold ${V ? 'text-white/90' : 'text-foreground-600'}`}>Regulator attached &amp; functioning</span>
                </button>
              </>
            )}

            {needAED && (
              <div className="flex flex-col gap-2">
                <button onClick={() => onCheck('padsSealed', !checks.padsSealed)} className="flex items-center gap-2 text-left">
                  <div className={`w-5 h-5 rounded-md flex-none flex items-center justify-center border-2 transition-all ${
                    checks.padsSealed
                      ? V ? 'bg-white border-white' : 'bg-primary border-primary'
                      : V ? 'bg-transparent border-white/60' : 'bg-transparent border-foreground-400'
                  }`}>
                    <Check size={11} strokeWidth={3.5} className={checks.padsSealed ? (V ? 'text-primary' : 'text-white') : 'text-transparent'} />
                  </div>
                  <span className={`text-xs font-semibold ${V ? 'text-white/90' : 'text-foreground-600'}`}>Pads sealed &amp; unexpired</span>
                </button>

                <button onClick={() => onCheck('batteryOk', !checks.batteryOk)} className="flex items-center gap-2 text-left">
                  <div className={`w-5 h-5 rounded-md flex-none flex items-center justify-center border-2 transition-all ${
                    checks.batteryOk
                      ? V ? 'bg-white border-white' : 'bg-primary border-primary'
                      : V ? 'bg-transparent border-white/60' : 'bg-transparent border-foreground-400'
                  }`}>
                    <Check size={11} strokeWidth={3.5} className={checks.batteryOk ? (V ? 'text-primary' : 'text-white') : 'text-transparent'} />
                  </div>
                  <span className={`text-xs font-semibold ${V ? 'text-white/90' : 'text-foreground-600'}`}>Battery indicator green</span>
                </button>

                <div className="flex items-center gap-2">
                  <span className={`flex-1 text-xs font-semibold ${V ? 'text-white/90' : 'text-foreground-600'}`}>Pad / battery expiration</span>
                  <Input
                    type="month"
                    size="sm"
                    aria-label="Pad / battery expiration"
                    value={checks.padExp ?? ''}
                    onValueChange={v => onCheck('padExp', v)}
                    classNames={monthInputCls}
                  />
                  <span className={`w-2 h-2 rounded-full flex-none ${monthDot(checks.padExp)}`} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Fix-or-acknowledge — shown whenever the item has an unresolved short / expired / low-PSI issue */}
      {(issue.any || resolved) && (
        <div
          onClick={e => e.stopPropagation()}
          className={`mt-3 rounded-xl px-3 py-2.5 flex flex-col gap-2 ${
            resolved
              ? V ? 'bg-white/10' : 'bg-content3'
              : V ? 'bg-white/10' : 'bg-danger-50 dark:bg-danger-950/20'
          }`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <AlertTriangle size={13} className={V ? 'text-white' : resolved ? 'text-foreground-500' : 'text-danger'} />
            <span className={`text-xs font-semibold ${V ? 'text-white' : resolved ? 'text-foreground-600' : 'text-danger'}`}>
              {resolved
                ? resolution!.kind === 'reported'
                  ? `Reported${resolution!.notes ? ` — ${resolution!.notes}` : ''}`
                  : `Acknowledged — ${(resolution as any).reason}`
                : `${issueLabel} — resolve to continue`}
            </span>
            {!draft && (
              <div className="ml-auto flex gap-1.5">
                {issue.short && (
                  <button
                    onClick={() => onRestock()}
                    className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-white text-primary hover:bg-white/90 transition-colors"
                  >
                    Set to par
                  </button>
                )}
                <button
                  onClick={() => { setDraft('report'); setReason(''); }}
                  className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                    V ? 'border-white/40 text-white hover:bg-white/10' : 'border-divider text-foreground-600 hover:bg-content3'
                  }`}
                >
                  Report
                </button>
                <button
                  onClick={() => { setDraft('acknowledge'); setReason(''); }}
                  className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors ${
                    V ? 'border-white/40 text-white hover:bg-white/10' : 'border-divider text-foreground-600 hover:bg-content3'
                  }`}
                >
                  Acknowledge
                </button>
              </div>
            )}
          </div>

          {draft && (
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                autoFocus
                placeholder={draft === 'report' ? 'What is wrong? (optional)' : 'Reason for proceeding'}
                aria-label={draft === 'report' ? 'Report notes' : 'Acknowledge reason'}
                value={reason}
                onValueChange={setReason}
                classNames={{
                  base: 'flex-1',
                  inputWrapper: 'h-9 min-h-9 bg-content1 border border-divider data-[hover=true]:bg-content1',
                  input: 'text-xs',
                }}
              />
              <Button
                size="sm"
                color={draft === 'report' ? 'danger' : 'primary'}
                className="font-semibold"
                isDisabled={draft === 'acknowledge' && !reason.trim()}
                onPress={draft === 'report' ? submitReport : submitAck}
              >
                {draft === 'report' ? 'File' : 'Confirm'}
              </Button>
              <button
                onClick={() => { setDraft(null); setReason(''); }}
                className={`w-8 h-8 rounded-lg flex items-center justify-center flex-none ${V ? 'text-white/80 hover:bg-white/10' : 'text-foreground-400 hover:bg-content3'}`}
              >
                <X size={15} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function StatpackCheckOffPage() {
  const router = useRouter();

  const [packId, setPackId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('checkout');
  const { role } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [pack, setPack] = useState<Statpack | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const today = useMemo(() => new Date(), []);

  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const [verifiedSet, setVerifiedSet] = useState<Set<string>>(new Set());
  const [itemChecks, setItemChecks] = useState<Record<string, ItemChecks>>({});
  const [resolution, setResolution] = useState<Record<string, Resolution>>({});
  const [pocketExpanded, setPocketExpanded] = useState<Record<string, boolean>>({
    main: true, front_aux: true, side_left: false, side_right: false,
  });
  const [sealState, setSealState] = useState<Record<string, boolean>>({});

  // Pack-level sharps container check
  const [sharps, setSharps] = useState<SharpsStatus | null>(null);
  const [sharpsAck, setSharpsAck] = useState('');

  // Check-in review step
  const [showReview, setShowReview] = useState(false);

  // Read id and mode from URL query params (avoids useSearchParams Suspense requirement)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get('id');
    const m = sp.get('mode');
    if (id) setPackId(id);
    if (m === 'checkout' || m === 'checkin' || m === 'audit') setMode(m);
  }, []);

  useEffect(() => {
    return onAuthStateChanged(auth, u => {
      if (!u) { router.push('/login'); return; }
      setUser(u);
    });
  }, [router]);

  useEffect(() => {
    if (!packId) return;
    setLoading(true);
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'statpacks', packId));
        if (!snap.exists()) { router.back(); return; }
        const data = snap.data();

        const rawContents: StatpackItem[] = Array.isArray(data.contents)
          ? data.contents.map((it: any) => ({
              ...it,
              expirationDate: it.expirationDate instanceof Timestamp
                ? it.expirationDate.toDate()
                : it.expirationDate instanceof Date ? it.expirationDate : undefined,
            }))
          : [];

        const ids = [...new Set(
          rawContents.flatMap(i => [i.assetInstanceId, i.itemId].filter(Boolean) as string[])
        )];
        const invMap = new Map<string, InventoryItem>();
        for (let i = 0; i < ids.length; i += 10) {
          const chunk = ids.slice(i, i + 10);
          const q = query(collection(db, 'inventory'), where(documentId(), 'in', chunk));
          const s = await getDocs(q);
          s.forEach(d => invMap.set(d.id, { id: d.id, ...d.data() } as InventoryItem));
        }

        const contents = rawContents.map(item => {
          const lookupId = item.assetInstanceId || item.itemId;
          const inv = lookupId ? invMap.get(lookupId) : undefined;
          return {
            ...item,
            itemDetails: inv ? { ...(item.itemDetails ?? {}), ...inv } : item.itemDetails,
          };
        });

        const spPack: Statpack = {
          id: snap.id,
          name: String(data.name || ''),
          type: data.type ?? 'Primary',
          status: data.status ?? 'Ready',
          currentLocation: data.currentLocation,
          isCheckedOut: data.isCheckedOut ?? false,
          assignedToUserId: data.assignedToUserId,
          assignedToUserName: data.assignedToUserName,
          lastCheckedAt: data.lastCheckedAt instanceof Timestamp ? data.lastCheckedAt.toDate() : undefined,
          compartments: Array.isArray(data.compartments) ? data.compartments : [],
          contents,
          createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : new Date(),
          updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : new Date(),
          assetValue: data.assetValue,
          assetSerial: data.assetSerial,
        };

        setPack(spPack);

        // Start from ACTUAL counts — currentQuantity — so depletion is visible. Fall back to par only when missing.
        const counts: Record<string, number> = {};
        contents.forEach(it => {
          counts[it.itemId] = typeof it.currentQuantity === 'number' ? it.currentQuantity : it.requiredQuantity;
        });
        setItemCounts(counts);

        const seals: Record<string, boolean> = {};
        POCKETS.forEach(pk => { seals[pk.id] = false; });
        (spPack.compartments ?? []).forEach(c => {
          if (c.isSealed) seals[c.parentPocket] = true;
        });
        setSealState(seals);
      } catch (e) {
        console.error('Failed to load statpack', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [packId, router]);

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const allItems = useMemo(() => pack?.contents ?? [], [pack]);

  const countOf = useCallback((it: StatpackItem) =>
    itemCounts[it.itemId] ?? (typeof it.currentQuantity === 'number' ? it.currentQuantity : it.requiredQuantity),
    [itemCounts]);

  const pocketGroups = useMemo(() => {
    if (!pack) return [];
    return POCKETS.map(pk => ({
      ...pk,
      items: pack.contents.filter(it => it.pocket === pk.id),
    })).filter(pk => pk.items.length > 0);
  }, [pack]);

  const verifiedCount = useMemo(() =>
    allItems.filter(it => isItemReady(it, deriveRules(it), verifiedSet, itemChecks[it.itemId] ?? {}, today)).length,
    [allItems, verifiedSet, itemChecks, today]
  );
  const totalItems = allItems.length;
  const pct = totalItems > 0 ? Math.round(verifiedCount / totalItems * 100) : 0;

  const shortCount = useMemo(() =>
    allItems.filter(it => countOf(it) < it.requiredQuantity).length,
    [allItems, countOf]
  );
  const expCount = useMemo(() =>
    allItems.filter(it => {
      const rules = deriveRules(it);
      const exp = effectiveExpDate(it, rules, itemChecks[it.itemId] ?? {});
      if (!exp) return false;
      const dd = daysUntil(exp, today);
      return dd >= 0 && dd <= THRESHOLDS.expirationWarningDays;
    }).length,
    [allItems, itemChecks, today]
  );

  // Blocking list: incomplete checks + unresolved short/expired/lowPsi + full sharps not acknowledged.
  const blockers = useMemo(() => {
    const list: string[] = [];
    allItems.forEach(it => {
      const rules = deriveRules(it);
      const chk = itemChecks[it.itemId] ?? {};
      const name = (it.itemDetails as any)?.name || 'item';
      if (rules.hasRules && !checksComplete(rules, chk)) {
        list.push(`${name}: finish required checks`);
        return;
      }
      const iss = computeIssue(it, rules, countOf(it), chk, today);
      if (iss.any && !isResolved(resolution[it.itemId])) {
        list.push(`${name}: resolve (${[iss.short && 'short', iss.expired && 'expired', iss.lowPsi && 'low PSI'].filter(Boolean).join(', ')})`);
      }
    });
    if (sharps === 'full' && !sharpsAck.trim()) list.push('Sharps container full: acknowledge or empty');
    return list;
  }, [allItems, itemChecks, countOf, resolution, sharps, sharpsAck, today]);

  const statusInfo = useMemo(() => {
    const s = pack?.status ?? 'Ready';
    if (s.includes('Expired')) return { label: 'Expired Items', color: 'text-danger', bg: 'bg-danger-50 dark:bg-danger-900/20' };
    if (s === 'Restock Needed') return { label: 'Restock Needed', color: 'text-warning', bg: 'bg-warning-50 dark:bg-warning-900/20' };
    return { label: 'Ready', color: 'text-success', bg: 'bg-success-50 dark:bg-success-900/20' };
  }, [pack]);

  const modeTitle = mode === 'checkout' ? 'Checkout Verification'
    : mode === 'checkin' ? 'Check-In Verification' : 'Inventory Audit';
  const modeSub = mode === 'checkout' ? 'Verify each item before deploying'
    : mode === 'checkin' ? 'Confirm contents on return' : 'Full count · accountable check';
  const btnLabel = mode === 'checkout' ? 'Complete Checkout'
    : mode === 'checkin' ? 'Review Check-In' : 'Submit Audit';

  const toggleVerify = useCallback((itemId: string) => {
    setVerifiedSet(prev => {
      const next = new Set(prev);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  }, []);

  const adjustCount = useCallback((itemId: string, delta: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setItemCounts(prev => ({ ...prev, [itemId]: Math.max(0, (prev[itemId] ?? 0) + delta) }));
  }, []);

  const updateCheck = useCallback((itemId: string, key: keyof ItemChecks, val: string | boolean) => {
    setItemChecks(prev => ({ ...prev, [itemId]: { ...(prev[itemId] ?? {}), [key]: val } }));
  }, []);

  // Only satisfies no-rule items — never implies an item with unmet required checks is ready.
  const markSimpleVerified = useCallback(() => {
    setVerifiedSet(new Set(allItems.filter(it => !deriveRules(it).hasRules).map(it => it.itemId)));
  }, [allItems]);

  // Build the check-off payload + a plain-language summary for the check-in review.
  const buildPayload = useCallback(() => {
    if (!pack || !user) return null;

    const oxygenReadings: Record<string, string> = {};
    const summary = {
      used: [] as { name: string; qty: number }[],
      restocked: [] as string[],
      reported: [] as string[],
      acknowledged: [] as string[],
      psi: [] as { name: string; psi: number }[],
    };

    const checkEntries = allItems.map(it => {
      const rules = deriveRules(it);
      const chk = itemChecks[it.itemId] ?? {};
      const found = countOf(it);
      const res = resolution[it.itemId];
      const iss = computeIssue(it, rules, found, chk, today);
      const name = (it.itemDetails as any)?.name || 'Unknown';

      if (rules.needPsi && chk.psi) {
        oxygenReadings[it.itemId] = chk.psi;
        summary.psi.push({ name, psi: Number(chk.psi) });
      }

      const usedQty = it.requiredQuantity - found;
      if (usedQty > 0) summary.used.push({ name, qty: usedQty });

      let restockStatus: 'restocked' | 'shelf_empty' | 'not_needed' | undefined;
      if (res?.kind === 'restocked') { restockStatus = 'restocked'; summary.restocked.push(name); }
      else if (res?.kind === 'reported') { restockStatus = 'shelf_empty'; summary.reported.push(name); }
      else restockStatus = found < it.requiredQuantity ? undefined : 'not_needed';

      if (res?.kind === 'acknowledged') summary.acknowledged.push(name);

      const enteredMonth = rules.needAED ? chk.padExp : rules.needExp ? chk.exp : undefined;
      const newExpirationDate = enteredMonth ? parseMonthEnd(enteredMonth) ?? undefined : undefined;

      return {
        itemId: it.itemId,
        itemName: name,
        batchId: it.batchId,
        compartmentId: it.compartmentId,
        pocket: it.pocket,
        requiredQuantity: it.requiredQuantity,
        countedQuantity: found,
        ok: found >= it.requiredQuantity && !iss.expired && !iss.lowPsi,
        serialNumber: it.serialNumber,
        expirationDate: it.expirationDate,
        newExpirationDate,
        oxygenPsi: rules.needPsi && chk.psi ? Number(chk.psi) : undefined,
        regulatorOk: rules.needPsi ? !!chk.regulatorOk : undefined,
        acknowledged: res?.kind === 'acknowledged' ? true : undefined,
        acknowledgeReason: res?.kind === 'acknowledged' ? res.reason : undefined,
        issue: res?.kind === 'reported'
          ? { type: res.issueType, quantity: res.quantity, notes: res.notes || undefined }
          : undefined,
        assetCheckResult: (rules.needAED || rules.needPsi) ? {
          padsSealed: chk.padsSealed,
          batteryStatus: chk.batteryOk ? 'Good' as const : undefined,
          oxygenPsi: rules.needPsi && chk.psi ? Number(chk.psi) : undefined,
        } : undefined,
        restockStatus,
      };
    });

    const sealChecks: Record<string, { sealed: boolean }> = {};
    if (isAdmin && mode === 'audit') {
      POCKETS.forEach(pk => { sealChecks[pk.id] = { sealed: !!sealState[pk.id] }; });
    }

    const sharpsCheck = sharps
      ? { status: sharps, notes: sharps === 'full' && sharpsAck.trim() ? sharpsAck.trim() : undefined }
      : undefined;

    return {
      payload: {
        statpackId: pack.id,
        statpackName: pack.name,
        action: mode,
        userId: user.uid,
        userName: user.displayName || user.email || 'Unknown',
        checkEntries,
        sealChecks: Object.keys(sealChecks).length > 0 ? sealChecks : undefined,
        oxygenReadings: Object.keys(oxygenReadings).length > 0 ? oxygenReadings : undefined,
        sharpsCheck,
      },
      summary,
    };
  }, [pack, user, allItems, itemChecks, countOf, resolution, sealState, sharps, sharpsAck, isAdmin, mode, today]);

  const doSubmit = useCallback(async () => {
    const built = buildPayload();
    if (!built) return;
    setShowReview(false);
    setSubmitting(true);
    try {
      await logStatpackCheckOff(built.payload as any);
      const msg = mode === 'checkout'
        ? 'Checkout complete — you are accountable for this bag'
        : mode === 'checkin'
        ? 'Check-in confirmed. Thank you.'
        : `Audit submitted for ${pack?.name ?? ''}`;
      showToast(msg, true);
      setTimeout(() => router.push('/dashboard'), 1500);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Submission failed', false);
    } finally {
      setSubmitting(false);
    }
  }, [buildPayload, mode, pack, showToast, router]);

  const handleComplete = useCallback(() => {
    if (!pack || !user) return;
    if (blockers.length > 0) {
      const preview = blockers.slice(0, 3).join(' · ');
      showToast(`${blockers.length} to resolve: ${preview}${blockers.length > 3 ? '…' : ''}`, false);
      return;
    }
    if (mode === 'checkin') { setShowReview(true); return; }
    doSubmit();
  }, [pack, user, blockers, mode, doSubmit, showToast]);

  const reviewSummary = useMemo(() => {
    if (!showReview) return null;
    return buildPayload()?.summary ?? null;
  }, [showReview, buildPayload]);

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!pack) return null;

  const sharpsOpts: { id: SharpsStatus; label: string }[] = [
    { id: 'ok', label: 'OK' },
    { id: 'full', label: 'Full' },
    { id: 'na', label: 'N/A' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-lg mx-auto min-h-screen flex flex-col">

        {/* Sticky header */}
        <header className="sticky top-0 z-30 bg-background/80 backdrop-blur-md border-b border-divider">
          <div className="h-14 flex items-center gap-2 px-3">
            <button
              onClick={() => router.back()}
              className="w-9 h-9 rounded-xl flex items-center justify-center text-foreground-500 hover:bg-content2 transition-colors duration-150"
            >
              <ArrowLeft size={20} />
            </button>
            <div className="flex-1 text-center flex flex-col leading-tight">
              <span className="text-sm font-semibold text-foreground">{modeTitle}</span>
              <span className="text-[11px] text-foreground-400 font-medium">{modeSub}</span>
            </div>
            <div className="w-9 h-9" />
          </div>
        </header>

        {/* Scrollable content */}
        <main className="flex-1 px-3 py-4 flex flex-col gap-3 pb-28">

          {/* Hero summary card */}
          <div className="bg-content1 border border-divider rounded-2xl p-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-[13px] bg-primary flex-none flex items-center justify-center shadow-md shadow-primary/30 relative">
                <div className="absolute w-5 h-1.5 bg-white rounded-sm" />
                <div className="absolute w-1.5 h-5 bg-white rounded-sm" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-lg leading-tight text-foreground truncate">{pack.name}</div>
                <div className="flex items-center gap-1.5 text-xs text-foreground-500 font-medium mt-0.5">
                  <MapPin size={11} className="text-foreground-400 flex-none" />
                  <span className="truncate">
                    {pack.type}{pack.currentLocation ? ` · ${pack.currentLocation}` : ''}
                  </span>
                </div>
              </div>
              <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap ${statusInfo.bg} ${statusInfo.color}`}>
                {statusInfo.label}
              </span>
            </div>

            <div className="mt-4">
              <div className="flex items-end justify-between mb-2">
                <span className="text-xs font-semibold text-foreground-500">
                  {verifiedCount} / {totalItems} verified
                </span>
                <span className="font-mono text-xl font-semibold text-primary leading-none tabular-nums">
                  {pct}%
                </span>
              </div>
              <div className="h-2 rounded-full bg-content3 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-2.5 flex items-center gap-2 text-xs text-foreground-400 font-medium">
                <span>
                  <span className="font-semibold text-foreground-500 tabular-nums">{totalItems}</span> items
                </span>
                <span className="w-1 h-1 rounded-full bg-foreground-300" />
                <span>
                  <span className={`font-semibold tabular-nums ${shortCount > 0 ? 'text-warning' : 'text-foreground-500'}`}>{shortCount}</span> short
                </span>
                <span className="w-1 h-1 rounded-full bg-foreground-300" />
                <span>
                  <span className={`font-semibold tabular-nums ${expCount > 0 ? 'text-warning' : 'text-foreground-500'}`}>{expCount}</span> expiring
                </span>
                {isAdmin && (
                  <button
                    onClick={markSimpleVerified}
                    className="ml-auto text-xs font-semibold text-primary hover:text-primary/70 transition-colors"
                  >
                    Mark simple items verified
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Pocket accordion groups */}
          {pocketGroups.map(pk => {
            const pVer = pk.items.filter(it =>
              isItemReady(it, deriveRules(it), verifiedSet, itemChecks[it.itemId] ?? {}, today)
            ).length;
            const pTot = pk.items.length;
            const pkPct = pTot > 0 ? Math.round(pVer / pTot * 100) : 0;
            const pkDone = pVer === pTot && pTot > 0;
            const expanded = !!pocketExpanded[pk.id];

            return (
              <div key={pk.id} className="bg-content1 border border-divider rounded-2xl overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-content2 transition-colors duration-150 text-left"
                  onClick={() => setPocketExpanded(p => ({ ...p, [pk.id]: !p[pk.id] }))}
                >
                  <div className={`w-9 h-9 rounded-[9px] flex items-center justify-center font-mono font-semibold text-xs flex-none transition-colors ${
                    pkDone ? 'bg-success-50 dark:bg-success-900/20 text-success' : 'bg-content3 text-foreground-400'
                  }`}>
                    {pk.code}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-foreground">{pk.name}</div>
                    <div className="text-xs text-foreground-400 font-medium">
                      {pTot} items · {pTot - pVer > 0 ? `${pTot - pVer} to verify` : 'all verified'}
                    </div>
                  </div>
                  <span className={`font-mono text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${
                    pkDone ? 'bg-success-50 dark:bg-success-900/20 text-success' : 'bg-primary-50 dark:bg-primary-900/20 text-primary'
                  }`}>
                    {pVer}/{pTot}
                  </span>
                  <ChevronDown
                    size={17}
                    className={`text-foreground-400 transition-transform duration-200 flex-none ${expanded ? 'rotate-180' : ''}`}
                  />
                </button>

                <div className="h-0.5 bg-content3">
                  <div
                    className={`h-full transition-all duration-300 ${pkDone ? 'bg-success' : 'bg-primary'}`}
                    style={{ width: `${pkPct}%` }}
                  />
                </div>

                {expanded && (
                  <div className="p-2.5 flex flex-col gap-2">
                    {pk.items.map(it => {
                      const rules = deriveRules(it);
                      const chk = itemChecks[it.itemId] ?? {};
                      const found = countOf(it);
                      const iss = computeIssue(it, rules, found, chk, today);
                      return (
                        <ItemRow
                          key={it.itemId}
                          item={it}
                          found={found}
                          checks={chk}
                          verifiedSet={verifiedSet}
                          today={today}
                          mode={mode}
                          issue={iss}
                          resolution={resolution[it.itemId]}
                          onToggle={() => toggleVerify(it.itemId)}
                          onMinus={e => adjustCount(it.itemId, -1, e)}
                          onPlus={e => adjustCount(it.itemId, 1, e)}
                          onCheck={(key, val) => updateCheck(it.itemId, key, val)}
                          onRestock={() => {
                            setItemCounts(prev => ({ ...prev, [it.itemId]: it.requiredQuantity }));
                            setResolution(prev => ({ ...prev, [it.itemId]: { kind: 'restocked' } }));
                            showToast(`Set to par: ${(it.itemDetails as any)?.name ?? 'item'}`, true);
                          }}
                          onReport={(issueType, quantity, notes) => {
                            setResolution(prev => ({ ...prev, [it.itemId]: { kind: 'reported', issueType, quantity, notes } }));
                            showToast('Issue reported to admin', false);
                          }}
                          onAcknowledge={(rsn) => {
                            setResolution(prev => ({ ...prev, [it.itemId]: { kind: 'acknowledged', reason: rsn } }));
                            showToast('Acknowledged — recorded on the log', true);
                          }}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Sharps container check — pack-level. Shown on check-in & audit; optional on checkout. */}
          <div className="bg-content1 border border-divider rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
                Sharps Container
              </span>
              <span className="text-xs text-foreground-400 font-medium">
                {mode === 'checkout' ? 'optional' : 'confirm status'}
              </span>
            </div>
            <div className="flex bg-content2 border border-divider rounded-large p-1 gap-1">
              {sharpsOpts.map(opt => {
                const active = sharps === opt.id;
                const isFull = opt.id === 'full';
                return (
                  <button
                    key={opt.id}
                    onClick={() => setSharps(active ? null : opt.id)}
                    className={`flex-1 px-3 py-2 rounded-medium text-sm font-semibold transition-colors duration-150 ${
                      active
                        ? isFull ? 'bg-danger text-white' : 'bg-primary text-white'
                        : 'text-foreground-500 hover:bg-content2'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            {sharps === 'full' && (
              <div className="mt-3 flex items-center gap-2">
                <Input
                  size="sm"
                  placeholder="Acknowledge — how was it handled?"
                  aria-label="Sharps full acknowledgement"
                  value={sharpsAck}
                  onValueChange={setSharpsAck}
                  classNames={{
                    base: 'flex-1',
                    inputWrapper: 'h-9 min-h-9 bg-content1 border border-danger/40 data-[hover=true]:bg-content1',
                    input: 'text-xs',
                  }}
                />
                <span className={`w-2 h-2 rounded-full flex-none ${sharpsAck.trim() ? 'bg-success' : 'bg-danger'}`} />
              </div>
            )}
          </div>

          {/* Compartment seals — admin + audit only */}
          {isAdmin && mode === 'audit' && (
            <div className="bg-content1 border border-divider rounded-2xl p-4">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-3">
                Compartment Seals
              </div>
              <div className="flex flex-col gap-2">
                {POCKETS.map((pk, i) => {
                  const sealed = !!sealState[pk.id];
                  return (
                    <button
                      key={pk.id}
                      onClick={() => setSealState(p => ({ ...p, [pk.id]: !p[pk.id] }))}
                      className="flex items-center gap-3 bg-content2 border border-divider rounded-xl px-3 py-3 hover:bg-content3 transition-colors duration-150 text-left"
                    >
                      <div className={`w-5 h-5 rounded-md flex-none flex items-center justify-center border-2 transition-all ${
                        sealed ? 'bg-primary border-primary' : 'bg-transparent border-foreground-400'
                      }`}>
                        <Check size={11} strokeWidth={3.5} className={sealed ? 'text-white' : 'text-transparent'} />
                      </div>
                      <span className="flex-1 text-sm font-semibold text-foreground">{pk.name}</span>
                      <span className={`font-mono text-xs font-semibold ${sealed ? 'text-foreground-400' : 'text-danger'}`}>
                        {sealed ? `SEAL-${pk.code}-0${i + 1}` : 'unsealed'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </main>

        {/* Sticky footer */}
        <footer className="sticky bottom-0 z-30 bg-background/80 backdrop-blur-md border-t border-divider px-3 py-3 flex items-center gap-3">
          <div className="flex flex-col leading-tight">
            {blockers.length > 0 ? (
              <>
                <span className="text-sm font-semibold text-danger tabular-nums">
                  {blockers.length} to resolve
                </span>
                <span className="text-xs text-foreground-400 font-medium">
                  {verifiedCount}/{totalItems} verified
                </span>
              </>
            ) : (
              <>
                <span className="text-sm font-semibold text-foreground tabular-nums">
                  {verifiedCount} / {totalItems} verified
                </span>
                <span className="text-xs text-foreground-400 font-medium">
                  {pct === 100 ? 'All items verified' : `${totalItems - verifiedCount} remaining`}
                </span>
              </>
            )}
          </div>
          <Button
            color={blockers.length > 0 ? 'danger' : 'primary'}
            variant={blockers.length > 0 ? 'flat' : 'solid'}
            className="ml-auto font-semibold"
            isLoading={submitting}
            onPress={handleComplete}
            endContent={!submitting ? <ArrowRight size={16} /> : undefined}
          >
            {btnLabel}
          </Button>
        </footer>
      </div>

      {/* Check-in usage review */}
      {showReview && reviewSummary && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={() => setShowReview(false)} />
          <div className="fixed inset-x-0 bottom-0 z-50 max-w-lg mx-auto bg-content1 border-t border-divider rounded-t-2xl flex flex-col max-h-[85vh]">
            <div className="px-5 py-4 border-b border-divider flex items-center gap-3">
              <div className="w-9 h-9 rounded-[10px] bg-primary-50 dark:bg-primary-900/20 text-primary flex items-center justify-center flex-none">
                <Check size={17} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground">Confirm check-in</div>
                <div className="text-xs text-foreground-400 font-medium">You are attesting to the following</div>
              </div>
              <button
                onClick={() => setShowReview(false)}
                className="w-8 h-8 rounded-medium bg-content2 hover:bg-content3 text-foreground-400 flex items-center justify-center transition-colors flex-none"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
              <ReviewSection title="Items used" empty="No items used">
                {reviewSummary.used.map(u => (
                  <ReviewRow key={u.name} label={u.name} value={`−${u.qty}`} tone="warning" />
                ))}
              </ReviewSection>

              <ReviewSection title="Restocked to par" empty="Nothing restocked">
                {reviewSummary.restocked.map(n => (
                  <ReviewRow key={n} label={n} value="par" tone="success" />
                ))}
              </ReviewSection>

              <ReviewSection title="Reported to admin" empty="No issues reported">
                {reviewSummary.reported.map(n => (
                  <ReviewRow key={n} label={n} value="reported" tone="danger" />
                ))}
              </ReviewSection>

              {reviewSummary.acknowledged.length > 0 && (
                <ReviewSection title="Acknowledged" empty="">
                  {reviewSummary.acknowledged.map(n => (
                    <ReviewRow key={n} label={n} value="ack" tone="warning" />
                  ))}
                </ReviewSection>
              )}

              {reviewSummary.psi.length > 0 && (
                <ReviewSection title="O₂ pressure" empty="">
                  {reviewSummary.psi.map(p => (
                    <ReviewRow key={p.name} label={p.name} value={`${p.psi} PSI`} tone="foreground" mono />
                  ))}
                </ReviewSection>
              )}

              <div className="flex items-center justify-between bg-content2 rounded-large px-4 py-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-foreground-400">Sharps container</span>
                <span className={`text-sm font-semibold ${
                  sharps === 'full' ? 'text-danger' : sharps === 'ok' ? 'text-success' : 'text-foreground-500'
                }`}>
                  {sharps ? sharps.toUpperCase() : 'Not checked'}
                </span>
              </div>
            </div>

            <div className="px-5 py-4 border-t border-divider flex gap-3">
              <Button variant="bordered" className="flex-1 font-semibold" onPress={() => setShowReview(false)}>
                Back
              </Button>
              <Button color="primary" className="flex-1 font-semibold" isLoading={submitting} onPress={doSubmit}
                endContent={!submitting ? <ArrowRight size={15} /> : undefined}>
                Confirm Check-In
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed z-[60] bottom-20 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${
          toast.ok ? 'bg-success' : 'bg-danger'
        }`}>
          <div className="w-5 h-5 rounded-full bg-white/25 flex items-center justify-center flex-none">
            {toast.ok
              ? <Check size={12} strokeWidth={3.5} />
              : <span className="text-xs leading-none">✕</span>}
          </div>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

// ─── Review helpers ───────────────────────────────────────────────────────────

function ReviewSection({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const arr = React.Children.toArray(children);
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">{title}</div>
      {arr.length > 0 ? (
        <div className="flex flex-col gap-1.5">{children}</div>
      ) : empty ? (
        <div className="text-xs text-foreground-400 font-medium">{empty}</div>
      ) : null}
    </div>
  );
}

function ReviewRow({ label, value, tone, mono }: {
  label: string; value: string; tone: 'success' | 'warning' | 'danger' | 'foreground'; mono?: boolean;
}) {
  const toneCls = tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-foreground-600';
  return (
    <div className="flex items-center justify-between bg-content2 rounded-large px-3 py-2">
      <span className="text-sm font-medium text-foreground truncate mr-3">{label}</span>
      <span className={`text-xs font-semibold flex-none ${toneCls} ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</span>
    </div>
  );
}
