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
import { Bell, X, Clock } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { subscribeUserNotifications, markNotificationRead, markAllRead } from '@/app/lib/notifications';
import type { AppNotification } from '@/app/types';

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
                // [Phase 1 / waitlist plan §5.2] `waitlist_offer` is the one
                // notification type carrying a hard deadline (offer.respondBy
                // can be as little as 2h out) — give it a distinct warning
                // treatment so it doesn't blend into the generic feed. The
                // bell had no type→icon/color mapping before this, so the
                // other new types (`waitlist_promoted`, `shift_reminder`,
                // `tier_open`) intentionally render as plain rows for now.
                const isOffer = notification.type === 'waitlist_offer';
                return (
                  <button
                    key={notification.id}
                    onClick={() => handleNotificationClick(notification)}
                    className={`w-full text-left px-4 py-3 hover:bg-content2 transition-colors ${
                      isOffer
                        ? 'bg-warning-50/60 dark:bg-warning-900/20'
                        : !notification.read
                          ? 'bg-primary-50/50 dark:bg-primary-900/10'
                          : ''
                    }`}
                  >
                    <div className="flex gap-2 items-start">
                      {isOffer ? (
                        <Clock size={14} className="text-warning flex-none mt-0.5" />
                      ) : (
                        !notification.read && (
                          <span className="w-2 h-2 rounded-full bg-primary flex-none mt-1.5" />
                        )
                      )}
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
