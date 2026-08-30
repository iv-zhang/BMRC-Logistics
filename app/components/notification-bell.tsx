'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Card,
  CardBody,
} from '@heroui/react';
import { Bell, X, Clock, CheckCircle, AlertTriangle, Unlock } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { subscribeUserNotifications, markNotificationRead, markAllRead } from '@/app/lib/notifications';
import type { AppNotification, NotificationType } from '@/app/types';

/**
 * [Phase 3 / waitlist plan §2.4] Per-type presentation mapping for notifications.
 * Each type gets an icon and color; background emphasis applied for time-critical
 * or important outcomes. Uses Record<NotificationType, ...> to enforce exhaustiveness:
 * adding a new member to the union will be a compile error here.
 *
 * tier_open currently has no emitter in the codebase (Phase 3 does not add one;
 * lazy-sweep in Phase 4), so its row is defined here ahead of the code that will
 * produce it.
 */
interface NotificationStyle {
  Icon: React.ComponentType<{ size: number; className: string }>;
  color: string;
  /** Permanent emphasis for a semantically urgent type. When absent the row
   *  falls back to the unread tint. Either way the unread DOT is rendered
   *  separately — see `notificationStyle`'s caller. */
  bgClass?: string;
}

const NOTIFICATION_STYLES: Record<NotificationType, NotificationStyle> = {
  waitlist_offer: {
    Icon: Clock,
    color: 'text-warning',
    bgClass: 'bg-warning-50/60 dark:bg-warning-900/20',
  },
  waitlist_promoted: {
    Icon: CheckCircle,
    color: 'text-success',
    bgClass: 'bg-success-50/60 dark:bg-success-900/20',
  },
  shift_reminder: {
    Icon: Clock,
    color: 'text-primary',
  },
  tier_open: {
    Icon: Unlock,
    color: 'text-primary',
  },
  cert_expiring: {
    Icon: AlertTriangle,
    color: 'text-warning',
    bgClass: 'bg-warning-50/60 dark:bg-warning-900/20',
  },
  request_rejected: {
    Icon: X,
    color: 'text-foreground-400',
  },
  request_approved: {
    Icon: CheckCircle,
    color: 'text-success',
    bgClass: 'bg-success-50/60 dark:bg-success-900/20',
  },
  event_open: {
    Icon: Bell,
    color: 'text-primary',
  },
  broadcast: {
    Icon: Bell,
    color: 'text-primary',
  },
};

/**
 * [Phase 3] The lookup is deliberately NOT `NOTIFICATION_STYLES[type]` bare.
 * `notifications` is historical data: a doc written by an older build (or by a
 * future one, if a deploy lands mid-session) can carry a `type` string that is
 * not in today's union, and TypeScript cannot check what came out of Firestore.
 * An unchecked index would hand back `undefined` and crash the whole popover on
 * `style.Icon` — taking the entire bell down over one unrecognized row. Fall
 * back to the plain `broadcast` treatment instead.
 */
function notificationStyle(type: NotificationType): NotificationStyle {
  return NOTIFICATION_STYLES[type] ?? NOTIFICATION_STYLES.broadcast;
}

export default function NotificationBell() {
  const router = useRouter();
  const { user } = useUserRole();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;

    setLoading(true);
    const unsubscribe = subscribeUserNotifications(user.uid, (items) => {
      setNotifications(items);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user?.uid]);

  if (!user?.uid) return null;

  const unreadCount = notifications.filter(n => !n.read).length;

  const handleNotificationClick = async (notification: AppNotification) => {
    try {
      if (!notification.read) {
        await markNotificationRead(notification.id!);
      }
      if (notification.link) {
        router.push(notification.link);
      }
    } catch (error) {
      console.error('Error handling notification click:', error);
    }
  };

  const handleMarkAllRead = async () => {
    const unreadIds = notifications.filter(n => !n.read).map(n => n.id!);
    if (unreadIds.length === 0) return;
    try {
      await markAllRead(unreadIds);
    } catch (error) {
      console.error('Error marking all read:', error);
    }
  };

  const formatTime = (timestamp: any): string => {
    let date: Date | undefined;
    if (timestamp instanceof Date) {
      date = timestamp;
    } else if (timestamp && typeof timestamp.toDate === 'function') {
      date = timestamp.toDate();
    } else if (timestamp instanceof Object && 'seconds' in timestamp) {
      date = new Date(timestamp.seconds * 1000);
    }

    if (!date) return 'Just now';

    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <Popover placement="bottom-end" offset={10}>
      <PopoverTrigger asChild>
        <Button
          isIconOnly
          variant="light"
          size="sm"
          aria-label="Notifications"
          className="relative text-foreground-400"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-danger rounded-full" />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-[360px] bg-content1 border border-divider rounded-large p-0">
        {/* Header */}
        <div className="px-4 py-3 border-b border-divider flex items-center justify-between">
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          {unreadCount > 0 && (
            <span className="text-xs font-semibold px-2 py-1 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary tabular-nums">
              {unreadCount} new
            </span>
          )}
        </div>

        {/* Notifications list */}
        <div className="max-h-[420px] overflow-y-auto">
          {loading ? (
            <div className="px-4 py-3">
              <p className="text-xs text-foreground-500">Loading notifications…</p>
            </div>
          ) : notifications.length === 0 ? (
            <div className="px-4 py-3">
              <p className="text-xs text-foreground-500">No notifications yet</p>
            </div>
          ) : (
            <div className="divide-y divide-divider">
              {notifications.map((notification) => {
                const style = notificationStyle(notification.type);
                // Apply type's background if present; otherwise use unread logic
                const bgClass =
                  style.bgClass || (!notification.read ? 'bg-primary-50/50 dark:bg-primary-900/10' : '');
                const Icon = style.Icon;
                // [Phase 3] The unread DOT is rendered independently of the
                // background, not as an alternative to it. Before Phase 3 the
                // dot WAS the unread signal for every type except
                // `waitlist_offer`; once four types gained a permanent
                // `bgClass`, tying the signal to the background alone made an
                // unread `request_approved`/`cert_expiring`/`waitlist_*` row
                // pixel-identical to a read one — silently deleting read state
                // from the surface whose entire job is to show it.
                const showUnreadDot = !notification.read;
                return (
                  <button
                    key={notification.id}
                    onClick={() => handleNotificationClick(notification)}
                    className={`w-full text-left px-4 py-3 hover:bg-content2 transition-colors ${bgClass}`}
                  >
                    <div className="flex gap-2 items-start">
                      <span className="relative flex-none mt-0.5">
                        <Icon size={14} className={`${style.color} block`} />
                        {showUnreadDot && (
                          <span
                            aria-label="Unread"
                            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary ring-1 ring-content1"
                          />
                        )}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground leading-tight">
                          {notification.title}
                        </p>
                        {notification.body && (
                          <p className="text-xs text-foreground-500 mt-0.5 line-clamp-2">
                            {notification.body}
                          </p>
                        )}
                        <p className="text-xs text-foreground-400 mt-1">
                          {formatTime(notification.createdAt)}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Mark all read action */}
        {unreadCount > 0 && (
          <>
            <div className="border-t border-divider" />
            <button
              onClick={handleMarkAllRead}
              className="w-full text-left px-4 py-2 text-xs font-semibold text-primary hover:bg-content2 transition-colors"
            >
              Mark all as read
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
