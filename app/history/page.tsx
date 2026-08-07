'use client';

/**
 * A member's personal activity history — split out of the dashboard so the
 * "Your Activity" card doesn't compete with live status there. Two feeds:
 * statpack check-off logs (`statpack_logs`) and shift request/attendance
 * history (`shift_requests`), both scoped to the signed-in user.
 */

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardBody, CardHeader, Chip, Divider, Button, Spinner } from '@heroui/react';
import { ArrowLeft, Clock } from 'lucide-react';
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  Timestamp,
} from 'firebase/firestore';
import { db } from '@/firebase';
import { useUserRole } from '@/app/hooks/useUserRole';
import { slotRoleLabel } from '@/app/lib/events';
import type { StatpackLog, ShiftRequest, AttendanceRecord } from '@/app/types';
import { toJsDate, formatEventDate } from '@/app/components/events/event-utils';

/** Derive a chip label + color from the check-in attendance model. */
function describeAttendance(att: AttendanceRecord | undefined): {
  label: string;
  color: 'success' | 'warning' | 'danger' | 'default';
} {
  if (!att) return { label: 'Unrecorded', color: 'default' };
  if (att.exception === 'no_show') return { label: 'No-show', color: 'danger' };
  if (att.exception === 'excused') return { label: 'Excused', color: 'default' };
  if (att.checkedInAt) {
    const late = att.minutesLate ?? 0;
    return late > 0
      ? { label: `Late by ${late}m`, color: 'warning' }
      : { label: 'On time', color: 'success' };
  }
  return { label: 'Unrecorded', color: 'default' };
}

function formatTimestamp(date: Date) {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

export default function HistoryPage() {
  const router = useRouter();
  const { user, effectiveUid, loading: authLoading } = useUserRole();
  const [activity, setActivity] = useState<StatpackLog[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [shiftHistory, setShiftHistory] = useState<ShiftRequest[]>([]);
  const [shiftsLoading, setShiftsLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) router.push('/login');
  }, [authLoading, user, router]);

  useEffect(() => {
    if (!effectiveUid) return;
    const logsQuery = query(
      collection(db, 'statpack_logs'),
      where('userId', '==', effectiveUid),
      orderBy('timestamp', 'desc'),
      limit(50),
    );
    const unsub = onSnapshot(logsQuery, (snapshot) => {
      const logs = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : new Date(),
        } as StatpackLog;
      });
      setActivity(logs);
      setActivityLoading(false);
    }, () => setActivityLoading(false));
    return () => unsub();
  }, [effectiveUid]);

  useEffect(() => {
    if (!effectiveUid) return;
    const requestsQuery = query(collection(db, 'shift_requests'), where('userId', '==', effectiveUid));
    const unsub = onSnapshot(requestsQuery, (snapshot) => {
      const approved = snapshot.docs
        .map((doc) => ({ id: doc.id, ...(doc.data() as ShiftRequest) }))
        .filter((r) => r.status === 'approved')
        .sort((a, b) => {
          const da = toJsDate(a.eventDate)?.getTime() ?? 0;
          const db_ = toJsDate(b.eventDate)?.getTime() ?? 0;
          return db_ - da;
        });
      setShiftHistory(approved);
      setShiftsLoading(false);
    }, () => setShiftsLoading(false));
    return () => unsub();
  }, [effectiveUid]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-3 md:p-6">
      <div className="max-w-4xl mx-auto space-y-4 md:space-y-8">
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-2 flex-wrap">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold">History</h1>
            <p className="text-sm md:text-base text-foreground-500 mt-1">
              Your statpack activity and shift history
            </p>
          </div>
          <Button
            size="sm"
            variant="flat"
            startContent={<ArrowLeft size={14} />}
            onPress={() => router.push('/dashboard')}
          >
            Back to dashboard
          </Button>
        </div>
        <Divider />

        {/* Statpack activity */}
        <Card>
          <CardHeader className="flex flex-col items-start gap-2 pb-3 md:pb-4">
            <h3 className="text-base md:text-lg font-semibold">Statpack Activity</h3>
            <Chip size="sm" variant="flat">
              Last {activity.length}
            </Chip>
          </CardHeader>
          <Divider />
          <CardBody className="gap-2 md:gap-3">
            {activityLoading ? (
              <div className="flex justify-center py-6">
                <Spinner size="sm" color="primary" />
              </div>
            ) : activity.length === 0 ? (
              <p className="text-foreground-500 text-xs md:text-sm">
                No activity yet. Start by checking out a pack!
              </p>
            ) : (
              activity.map((log) => (
                <Card key={log.id} className="bg-content2" shadow="sm">
                  <CardBody className="py-2 md:py-3 px-3 md:px-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <Chip
                            size="sm"
                            color={
                              log.action === 'checkout'
                                ? 'primary'
                                : log.action === 'checkin'
                                ? 'success'
                                : log.action === 'audit'
                                ? 'secondary'
                                : 'default'
                            }
                            variant="flat"
                          >
                            {log.action === 'checkout'
                              ? 'Checked Out'
                              : log.action === 'checkin'
                              ? 'Checked In'
                              : log.action === 'audit'
                              ? 'Audit'
                              : log.action.replace(/_/g, ' ')}
                          </Chip>
                        </div>
                        <p className="text-xs md:text-sm font-medium truncate">
                          {log.statpackName || 'Unknown Pack'}
                        </p>
                        {log.notes && (
                          <p className="text-xs text-foreground-500 mt-1 line-clamp-2">
                            {log.notes}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-foreground-400 whitespace-nowrap">
                        <Clock size={12} />
                        {log.timestamp instanceof Date ? formatTimestamp(log.timestamp) : 'Just now'}
                      </div>
                    </div>
                  </CardBody>
                </Card>
              ))
            )}
          </CardBody>
        </Card>

        {/* Shift history */}
        <Card>
          <CardHeader className="flex flex-col items-start gap-2 pb-3 md:pb-4">
            <h3 className="text-base md:text-lg font-semibold">Shift History</h3>
            <Chip size="sm" variant="flat">
              {shiftHistory.length} shift{shiftHistory.length !== 1 ? 's' : ''}
            </Chip>
          </CardHeader>
          <Divider />
          <CardBody className="gap-2 md:gap-3">
            {shiftsLoading ? (
              <div className="flex justify-center py-6">
                <Spinner size="sm" color="primary" />
              </div>
            ) : shiftHistory.length === 0 ? (
              <p className="text-foreground-500 text-xs md:text-sm">
                No confirmed shifts yet. Sign up on the Shifts board.
              </p>
            ) : (
              shiftHistory.map((req) => {
                const attendance = describeAttendance(req.attendance);
                return (
                  <Card
                    key={req.id}
                    className="bg-content2 cursor-pointer hover:shadow-md transition-shadow"
                    shadow="sm"
                    isPressable
                    onPress={() => req.eventId && router.push(`/events?event=${req.eventId}`)}
                  >
                    <CardBody className="py-2 md:py-3 px-3 md:px-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs md:text-sm font-medium truncate">
                            {req.eventName}
                          </p>
                          <p className="text-xs text-foreground-500 mt-0.5">
                            {req.teamName} · {slotRoleLabel(req.role)}
                          </p>
                          <p className="text-xs text-foreground-400 mt-0.5">
                            {formatEventDate(req.eventDate)}
                          </p>
                        </div>
                        <Chip size="sm" variant="flat" color={attendance.color}>
                          {attendance.label}
                        </Chip>
                      </div>
                    </CardBody>
                  </Card>
                );
              })
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
