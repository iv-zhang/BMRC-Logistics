'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Chip, Spinner, Select, SelectItem, Tabs, Tab } from '@heroui/react';
import { ArrowLeft, Mail, UserRound, Sun, Moon, ShieldCheck, LogOut as LogOutIcon, Bug, AlertCircle, Trash2, History, CalendarClock, Sparkles, IdCard, Settings as SettingsIcon } from 'lucide-react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc, collection, getDocs, query, where } from 'firebase/firestore';
import { useTheme } from 'next-themes';
import { auth, db } from '@/firebase';
import { ROLES, getSemesterStart } from '@/app/config/org-config';
import { useUserRole } from '@/app/hooks/useUserRole';
import { usePanelMode, type PanelMode } from '@/app/hooks/usePanelMode';
import { getMemberCertStatuses, CERT_LABELS } from '@/app/lib/certifications';
import { TEST_IDENTITIES, seedTestUsers, clearTestIdentityHistory } from '@/app/lib/test-identity';
import { getMemberShiftStats } from '@/app/lib/events';
import IssueReportForm from '@/app/components/IssueReportForm';
import type { User, ShiftRequest } from '@/app/types';

export default function ProfilePage() {
  const router = useRouter();
  const { role } = useUserRole();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const { setTheme, resolvedTheme } = useTheme();
  const { mode: panelMode, setMode: setPanelMode } = usePanelMode();
  /** Active `bmrc_test_identity` uid (new identity override), if any. */
  const [testIdentityActive, setTestIdentityActive] = useState<string | null>(null);
  /** Active legacy `bmrc_role_override` string, kept working as a fallback. */
  const [legacyRoleOverrideActive, setLegacyRoleOverrideActive] = useState<string | null>(null);
  const [switchingIdentity, setSwitchingIdentity] = useState(false);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [shiftRequests, setShiftRequests] = useState<ShiftRequest[] | null>(null);
  const [shiftStatsLoading, setShiftStatsLoading] = useState(true);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!currentUser) {
        router.push('/login');
        return;
      }

      try {
        const userRef = doc(db, 'users', currentUser.uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
          const userData = userSnap.data();
          setUser({
            id: userData.id,
            fullName: userData.fullName,
            email: userData.email,
            role: userData.role,
            createdAt: userData.createdAt?.toDate() || new Date(),
            updatedAt: userData.updatedAt?.toDate() || new Date(),
          });
        }
      } catch (error) {
        console.error('Error fetching user data:', error);
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [router]);

  // Volunteer Record: this member's own shift_requests, feeding getMemberShiftStats.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    setShiftStatsLoading(true);
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'shift_requests'), where('userId', '==', user.id)));
        if (cancelled) return;
        setShiftRequests(snap.docs.map((d) => ({ id: d.id, ...d.data() } as ShiftRequest)));
      } catch (error) {
        console.error('Error fetching shift history:', error);
        if (!cancelled) setShiftRequests([]);
      } finally {
        if (!cancelled) setShiftStatsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Test identity / legacy role override state sync
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setTestIdentityActive(localStorage.getItem('bmrc_test_identity'));
    setLegacyRoleOverrideActive(localStorage.getItem('bmrc_role_override'));
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'bmrc_test_identity') setTestIdentityActive(e.newValue);
      if (e.key === 'bmrc_role_override') setLegacyRoleOverrideActive(e.newValue);
    };
    const onCustom = () => {
      setTestIdentityActive(localStorage.getItem('bmrc_test_identity'));
      setLegacyRoleOverrideActive(localStorage.getItem('bmrc_role_override'));
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('bmrc-role-changed', onCustom as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('bmrc-role-changed', onCustom as EventListener);
    };
  }, []);

  const semesterStart = React.useMemo(() => getSemesterStart(), []);
  const shiftStats = React.useMemo(
    () => (shiftRequests ? getMemberShiftStats(shiftRequests, semesterStart) : null),
    [shiftRequests, semesterStart],
  );
  // [Phase 3 / waitlist plan §5.5] A member can be actively queued or holding
  // an offer with zero approved shifts to date — the Volunteer Record's
  // "no shifts on record yet" empty state must not hide that activity.
  const hasWaitlistOrOfferActivity = !!shiftStats && (
    shiftStats.waitlistPending > 0 ||
    shiftStats.offersOutstanding > 0 ||
    shiftStats.offersDeclined > 0 ||
    shiftStats.offersExpired > 0
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <div className="bg-content1 border border-divider rounded-large max-w-md w-full text-center py-10 px-6">
          <UserRound size={40} className="mx-auto text-foreground-300 mb-4" />
          <p className="text-sm font-semibold text-foreground-500 mb-4">Unable to load profile information.</p>
          <Button color="primary" onPress={() => router.push('/dashboard')}>
            Return to dashboard
          </Button>
        </div>
      </div>
    );
  }

  const getRoleColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'danger';
      case 'FTO':
      case 'fto_intern':
        return 'warning';
      case 'quartermaster':
        return 'secondary';
      default:
        return 'primary';
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      router.push('/');
    } catch (e) {
      console.error('Sign out error:', e);
    }
  };

  // Real account role — from the getDoc fetch above, never the override. Gates
  // both seeding (only a real admin/quartermaster may create test identities)
  // and the Test Account History card (a test identity can't hide it from
  // itself by "becoming" a lower role).
  const isRealAdmin = user.role === 'admin' || user.role === 'quartermaster';

  const handleRoleSelect = async (value: string) => {
    try {
      if (value === 'clear') {
        localStorage.removeItem('bmrc_test_identity');
        localStorage.removeItem('bmrc_role_override');
        window.dispatchEvent(new Event('bmrc-role-changed'));
        return;
      }
      // `value` is one of TEST_IDENTITIES' ids. Make sure the seeded docs
      // exist before switching — only a real admin/quartermaster creates them.
      if (isRealAdmin) {
        setSwitchingIdentity(true);
        try {
          await seedTestUsers();
        } finally {
          setSwitchingIdentity(false);
        }
      }
      localStorage.setItem('bmrc_test_identity', value);
      localStorage.removeItem('bmrc_role_override');
      window.dispatchEvent(new Event('bmrc-role-changed'));
    } catch (e) {
      console.error('test identity switch failed', e);
    }
  };

  const handleClearHistory = async (identityId: string, identityName: string) => {
    setClearingId(identityId);
    try {
      const { deleted } = await clearTestIdentityHistory(identityId);
      alert(`Cleared ${deleted} record${deleted === 1 ? '' : 's'} generated by ${identityName}.`);
    } catch (e) {
      console.error('clear test identity history failed', e);
      alert(`Failed to clear history for ${identityName}. Check console.`);
    } finally {
      setClearingId(null);
    }
  };

  // Show the Test Identity control based on the REAL account role (unaffected
  // by the override) OR whenever an override is active — otherwise switching
  // to a member test identity hides the very control needed to switch back.
  const canManageTestRole = isRealAdmin || !!testIdentityActive || !!legacyRoleOverrideActive;
  const roleDef = ROLES.find((r) => r.id === user.role);
  const roleLabel = roleDef?.label ?? (user.role.charAt(0).toUpperCase() + user.role.slice(1));
  const activeIdentityDef = TEST_IDENTITIES.find((i) => i.id === testIdentityActive);

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* ── Page header ────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground mb-1.5">Profile</h1>
            <p className="text-sm text-foreground-500">Your account information</p>
          </div>
          {/* Sign Out also lives in the Settings tab's Account card, but it was
              effectively unfindable there — it's the one action people come to
              this page for, so it sits in the header too. */}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="flat"
              startContent={<ArrowLeft size={14} />}
              onPress={() => router.push('/dashboard')}
            >
              Back to dashboard
            </Button>
            <Button
              size="sm"
              color="danger"
              variant="flat"
              startContent={<LogOutIcon size={14} />}
              onPress={handleSignOut}
            >
              Sign Out
            </Button>
          </div>
        </div>

        <div className="max-w-2xl">
          {/* ── Identity card (always visible) ────────────────────────────── */}
          <div className="bg-content1 border border-divider rounded-large p-5">
            {/* Identity row */}
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-[14px] bg-secondary/15 text-secondary flex items-center justify-center text-xl font-semibold flex-none">
                {user.fullName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-lg text-foreground leading-tight truncate">{user.fullName}</div>
                <div className="flex items-center gap-1 text-xs text-foreground-500 mt-0.5">
                  <Mail size={11} className="flex-none" /> {user.email}
                </div>
              </div>
              <div className="ml-auto flex-none">
                <Chip color={getRoleColor(user.role)} variant="flat" size="sm">
                  {roleLabel}
                </Chip>
              </div>
            </div>

            {/* Details */}
            <div className="flex gap-3 mt-5">
              <div className="flex-1 bg-content2 rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Role</div>
                <div className="text-sm font-semibold text-foreground">{roleLabel}</div>
                {roleDef?.description && (
                  <div className="text-xs text-foreground-400 mt-1">{roleDef.description}</div>
                )}
              </div>
              <div className="flex-1 bg-content2 rounded-large p-4">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">Member Since</div>
                <div className="text-sm font-semibold text-foreground tabular-nums">
                  {user.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
            </div>
          </div>

          {/* ── Tabs: Your Record / Settings ───────────────────────────────── */}
          <Tabs
            aria-label="Profile sections"
            className="mt-4"
            classNames={{ tabList: 'w-full', panel: 'px-0' }}
          >
            <Tab
              key="record"
              title={
                <span className="flex items-center gap-1.5">
                  <IdCard size={15} /> Your Record
                </span>
              }
            >
            <div className="bg-content1 border border-divider rounded-large p-5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-3">Certifications</div>
              <div className="flex flex-col gap-3">
                {(() => {
                  const certStatuses = getMemberCertStatuses(user);
                  const emtColor = certStatuses.emt === 'valid' ? 'success' : certStatuses.emt === 'expired' ? 'danger' : 'default';
                  const cprColor = certStatuses.cpr === 'valid' ? 'success' : certStatuses.cpr === 'expired' ? 'danger' : 'default';
                  const hasExpiredOrMissing = certStatuses.emt !== 'valid' || certStatuses.cpr !== 'valid';

                  return (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <Chip size="sm" variant="flat" color={emtColor}>
                          <span className="font-medium">{CERT_LABELS.emt}</span>
                          {certStatuses.emt === 'valid' && user.certifications?.emt?.expiresOn && (
                            <span className="text-xs ml-1">
                              ({(() => {
                                const d = user.certifications.emt?.expiresOn;
                                const date = d instanceof Date ? d : (typeof d === 'object' && d !== null && 'toDate' in d ? (d as unknown as { toDate(): Date }).toDate() : new Date(String(d)));
                                return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                              })()})
                            </span>
                          )}
                        </Chip>
                        <Chip size="sm" variant="flat" color={cprColor}>
                          <span className="font-medium">{CERT_LABELS.cpr}</span>
                          {certStatuses.cpr === 'valid' && user.certifications?.cpr?.expiresOn && (
                            <span className="text-xs ml-1">
                              ({(() => {
                                const d = user.certifications.cpr?.expiresOn;
                                const date = d instanceof Date ? d : (typeof d === 'object' && d !== null && 'toDate' in d ? (d as unknown as { toDate(): Date }).toDate() : new Date(String(d)));
                                return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                              })()})
                            </span>
                          )}
                        </Chip>
                      </div>
                      {hasExpiredOrMissing && (
                        <div className="flex items-start gap-2 bg-warning/10 border border-warning/30 rounded-lg p-3 text-sm text-warning">
                          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                          <span>Send updated documents to MedOps to restore shift signup.</span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            <div className="bg-content1 border border-divider rounded-large p-5 mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-3 inline-flex items-center gap-1.5">
                <CalendarClock size={13} /> Volunteer Record
              </div>
              {shiftStatsLoading ? (
                <div className="flex justify-center py-4">
                  <Spinner size="sm" color="primary" />
                </div>
              ) : !shiftStats || (shiftStats.shiftsAllTime === 0 && !hasWaitlistOrOfferActivity) ? (
                <p className="text-sm text-foreground-400">
                  No shifts on record yet. Sign up for an event on the Shifts board to start building your volunteer record.
                </p>
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="flex gap-3">
                    <div className="flex-1 bg-content2 rounded-large p-4">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">This Semester</div>
                      <div className="font-mono text-[24px] font-semibold tabular-nums leading-tight text-foreground">
                        {shiftStats.shiftsThisSemester}
                      </div>
                      <div className="text-xs text-foreground-400 mt-0.5">{shiftStats.hoursThisSemester}h volunteered</div>
                    </div>
                    <div className="flex-1 bg-content2 rounded-large p-4">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1.5">All-Time</div>
                      <div className="font-mono text-[24px] font-semibold tabular-nums leading-tight text-foreground-600">
                        {shiftStats.shiftsAllTime}
                      </div>
                      <div className="text-xs text-foreground-400 mt-0.5">{shiftStats.hoursAllTime}h volunteered</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex items-center gap-2 bg-success-50 dark:bg-success-900/20 border border-success/30 rounded-large px-3 py-1.5">
                      <span className="w-2 h-2 rounded-sm bg-success flex-none" />
                      <span className="font-mono font-semibold tabular-nums text-success">{shiftStats.checkedIn}</span>
                      <span className="text-xs text-success/80 font-medium">checked in</span>
                    </div>
                    <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                      <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                      <span className="font-mono font-semibold tabular-nums text-warning">{shiftStats.lateCount}</span>
                      <span className="text-xs text-warning/80 font-medium">
                        late{shiftStats.totalMinutesLate > 0 ? ` (${shiftStats.totalMinutesLate}m total)` : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 bg-danger-50 dark:bg-danger-900/20 border border-danger/30 rounded-large px-3 py-1.5">
                      <span className="w-2 h-2 rounded-sm bg-danger flex-none" />
                      <span className="font-mono font-semibold tabular-nums text-danger">{shiftStats.noShow}</span>
                      <span className="text-xs text-danger/80 font-medium">no-show</span>
                    </div>
                    <div className="flex items-center gap-2 bg-content2 border border-divider rounded-large px-3 py-1.5">
                      <span className="font-mono font-semibold tabular-nums text-foreground">{shiftStats.excused}</span>
                      <span className="text-xs text-foreground-400">excused</span>
                    </div>
                    {/* [Phase 3 / waitlist plan §5.5, R2] Late cancellations are a real
                        record of a commitment the member actually held (unlike the
                        waitlist/offer group below), so they stay in the attendance
                        group — but only when the org has opted `cancellationPolicy
                        .countsAgainstRecord` in, which `lateCancellations` is already
                        gated on upstream. */}
                    {shiftStats.lateCancellations > 0 && (
                      <div className="flex items-center gap-2 bg-warning-50 dark:bg-warning-900/20 border border-warning/30 rounded-large px-3 py-1.5">
                        <span className="w-2 h-2 rounded-sm bg-warning flex-none" />
                        <span className="font-mono font-semibold tabular-nums text-warning">{shiftStats.lateCancellations}</span>
                        <span className="text-xs text-warning/80 font-medium">
                          late cancellation{shiftStats.lateCancellations === 1 ? '' : 's'}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* [Phase 3 / waitlist plan §5.5] Waitlist/offer stats live in their
                      own visually separate group — never merged into the attendance
                      strip above, which is specifically about shifts the member
                      actually held. Neutral tone only: no danger/warning color, no
                      ✗/⚠ icon, and copy never implies fault (P4: queueing and an
                      unaccepted offer carry no liability). */}
                  {(shiftStats.waitlistPending > 0 || shiftStats.offersOutstanding > 0 || shiftStats.offersDeclined > 0 || shiftStats.offersExpired > 0) && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">Waitlist & Offers</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {shiftStats.waitlistPending > 0 && (
                          <div className="flex items-center gap-2 bg-content2 border border-divider rounded-large px-3 py-1.5">
                            <span className="font-mono font-semibold tabular-nums text-foreground">{shiftStats.waitlistPending}</span>
                            <span className="text-xs text-foreground-400">on the waitlist</span>
                          </div>
                        )}
                        {shiftStats.offersOutstanding > 0 && (
                          <div className="flex items-center gap-2 bg-content2 border border-divider rounded-large px-3 py-1.5">
                            <span className="font-mono font-semibold tabular-nums text-foreground">{shiftStats.offersOutstanding}</span>
                            <span className="text-xs text-foreground-400">offers outstanding</span>
                          </div>
                        )}
                        {shiftStats.offersDeclined > 0 && (
                          <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                            <span className="font-mono font-semibold tabular-nums text-foreground">{shiftStats.offersDeclined}</span>
                            <span className="text-xs text-foreground-400">offers declined</span>
                          </div>
                        )}
                        {shiftStats.offersExpired > 0 && (
                          <div className="flex items-center gap-2 bg-content1 border border-divider rounded-large px-3 py-1.5">
                            <span className="font-mono font-semibold tabular-nums text-foreground">{shiftStats.offersExpired}</span>
                            <span className="text-xs text-foreground-400">offers expired</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* [Phase 3 / waitlist plan §8 Phase 3, R2, Q4] Per-type shift
                      tallies so a member can verify a tier criterion written in terms
                      of shift types. Never synthesize an "Other" bucket for requests
                      with no denormalized `eventType` — see the field's doc comment
                      on `MemberShiftStats.shiftsByType` in app/types.ts /
                      app/lib/events.ts. */}
                  {Object.keys(shiftStats.shiftsByType).length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400 mb-2">Shifts by type</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {Object.entries(shiftStats.shiftsByType)
                          .sort(([typeA, countA], [typeB, countB]) => countB - countA || typeA.localeCompare(typeB))
                          .map(([type, count]) => {
                            const semesterCount = shiftStats.shiftsByTypeSemester[type] ?? 0;
                            return (
                              <div key={type} className="flex items-center gap-2 bg-content2 border border-divider rounded-large px-3 py-1.5">
                                <span className="text-xs text-foreground-400">{type}</span>
                                <span className="font-mono font-semibold tabular-nums text-foreground">
                                  {count}{semesterCount > 0 ? ` (${semesterCount} this term)` : ''}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            </Tab>

            <Tab
              key="settings"
              title={
                <span className="flex items-center gap-1.5">
                  <SettingsIcon size={15} /> Settings
                </span>
              }
            >
            <div className="bg-content1 border border-divider rounded-large p-5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-3">Appearance</div>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">Theme</div>
                  <div className="text-xs text-foreground-400 mt-0.5">Choose light or dark mode</div>
                </div>
                {mounted && (
                  <div className="flex items-center gap-1 bg-content2 rounded-large p-1 flex-none">
                    <button
                      onClick={() => setTheme('light')}
                      className={`flex items-center gap-1.5 h-8 px-3 rounded-medium text-[13px] font-medium transition-colors ${resolvedTheme === 'light' ? 'bg-content1 text-foreground shadow-sm' : 'text-foreground-400 hover:text-foreground-600'}`}
                    >
                      <Sun size={15} /> Light
                    </button>
                    <button
                      onClick={() => setTheme('dark')}
                      className={`flex items-center gap-1.5 h-8 px-3 rounded-medium text-[13px] font-medium transition-colors ${resolvedTheme === 'dark' ? 'bg-content1 text-foreground shadow-sm' : 'text-foreground-400 hover:text-foreground-600'}`}
                    >
                      <Moon size={15} /> Dark
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-4 mt-4">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">Pop-out style</div>
                  <div className="text-xs text-foreground-400 mt-0.5">How pop-out panels open across the app</div>
                </div>
                <div className="flex items-center gap-1 bg-content2 rounded-large p-1 flex-none">
                  {([
                    { key: 'drawer', label: 'Drawer' },
                    { key: 'dropdown', label: 'Dropdown' },
                    { key: 'modal', label: 'Center' },
                  ] as { key: PanelMode; label: string }[]).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setPanelMode(key)}
                      className={`flex items-center gap-1.5 h-8 px-3 rounded-medium text-[13px] font-medium transition-colors ${panelMode === key ? 'bg-content1 text-foreground shadow-sm' : 'text-foreground-400 hover:text-foreground-600'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-content1 border border-divider rounded-large p-5 mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-3">Account</div>
              <div className="flex flex-col gap-3">
                {canManageTestRole && (
                  <Select
                    startContent={<ShieldCheck size={16} />}
                    placeholder="Select test identity"
                    isDisabled={switchingIdentity}
                    isLoading={switchingIdentity}
                    selectedKeys={testIdentityActive ? [testIdentityActive] : []}
                    onChange={(e) => { void handleRoleSelect(e.target.value); }}
                    label={
                      activeIdentityDef
                        ? `Test Identity: ${activeIdentityDef.fullName}`
                        : legacyRoleOverrideActive
                          ? `Test Role: ${legacyRoleOverrideActive}`
                          : `Real role: ${user?.role || 'Unknown'}`
                    }
                    description="Switching seeds a dedicated test account (writes are attributed to it, not your real account)."
                    className="w-full"
                  >
                    {[
                      ...TEST_IDENTITIES.map((identity) => (
                        <SelectItem key={identity.id}>
                          {identity.fullName} ({ROLES.find((r) => r.id === identity.role)?.label ?? identity.role})
                        </SelectItem>
                      )),
                      <SelectItem key="clear">
                        Clear override / Real role
                      </SelectItem>,
                    ]}
                  </Select>
                )}
                <Button
                  className="w-full justify-start"
                  color="danger"
                  variant="flat"
                  startContent={<LogOutIcon size={16} />}
                  onPress={handleSignOut}
                >
                  Sign Out
                </Button>
              </div>
            </div>

            {isRealAdmin && (
              <div className="bg-content1 border border-divider rounded-large p-5 mt-4">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-1">
                  <History size={13} /> Test Account History
                </div>
                <p className="text-xs text-foreground-400 mb-3">
                  Manually wipe what a seeded test identity has generated — shift requests, statpack logs, vehicle
                  shifts, notifications, and issue reports — plus vacate any statpack/event slot it&apos;s holding. This
                  does not delete the test account itself, and history is never cleared automatically.
                </p>
                <div className="flex flex-col gap-2">
                  {TEST_IDENTITIES.map((identity) => (
                    <div key={identity.id} className="flex items-center justify-between gap-3 bg-content2 rounded-large p-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground truncate">{identity.fullName}</div>
                        <div className="text-xs text-foreground-400">
                          {ROLES.find((r) => r.id === identity.role)?.label ?? identity.role}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="flat"
                        color="danger"
                        startContent={<Trash2 size={14} />}
                        isLoading={clearingId === identity.id}
                        isDisabled={clearingId !== null && clearingId !== identity.id}
                        onPress={() => handleClearHistory(identity.id, identity.fullName)}
                      >
                        Clear history
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-content1 border border-divider rounded-large p-5 mt-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground-400 mb-3">Support</div>
              <div className="flex flex-col gap-3">
                <Button
                  className="w-full justify-start"
                  variant="flat"
                  startContent={<Bug size={16} />}
                  onPress={() => setIsReportOpen(true)}
                >
                  Report a Bug
                </Button>
                <Button
                  className="w-full justify-start"
                  variant="flat"
                  startContent={<Sparkles size={16} />}
                  onPress={() => window.dispatchEvent(new Event('bmrc-replay-tutorial'))}
                >
                  Replay tutorial
                </Button>
              </div>
            </div>
            </Tab>
          </Tabs>
        </div>
      </div>

      <IssueReportForm
        isOpen={isReportOpen}
        onOpenChange={setIsReportOpen}
        lockType="bug"
        pagePath="/profile"
      />
    </div>
  );
}
