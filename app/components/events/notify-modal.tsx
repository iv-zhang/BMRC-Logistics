'use client';

/**
 * Manager modal for sending a targeted notification about an event, replacing
 * the old blind "notify everyone" button. Audience is a union of "everyone in
 * the org" and/or "people signed up for this shift" (approved requests).
 */

import { useEffect, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter, Button, Input, Textarea, Checkbox } from '@heroui/react';
import { AlertTriangle } from 'lucide-react';
import { db } from '@/firebase';
import { getSignedUpUserIds, updateEvent, type EventActor } from '@/app/lib/events';
import { broadcastNotification } from '@/app/lib/notifications';
import type { Event } from '@/app/types';
import { formatEventDate } from './event-utils';

interface NotifyModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: Event | null;
  actor: EventActor;
  onSent: (count: number) => void;
  onError: (msg: string) => void;
}

export default function NotifyModal({ isOpen, onClose, event, actor, onSent, onError }: NotifyModalProps) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [audienceEveryone, setAudienceEveryone] = useState(true);
  const [audienceSignedUp, setAudienceSignedUp] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !event) return;
    setTitle(`New shift posted: ${event.name}`);
    setMessage(formatEventDate(event.date));
    setAudienceEveryone(true);
    setAudienceSignedUp(false);
    setError(null);
  }, [isOpen, event]);

  const noAudienceSelected = !audienceEveryone && !audienceSignedUp;

  const handleSend = async () => {
    if (!event?.id) return;
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (noAudienceSelected) {
      setError('Choose at least one audience');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const recipientIds = new Set<string>();

      if (audienceSignedUp) {
        const signedUp = await getSignedUpUserIds(event.id);
        signedUp.forEach((id) => recipientIds.add(id));
        if (signedUp.length === 0 && !audienceEveryone) {
          setError('No one is signed up yet — nothing was sent. Try "Everyone in the org" instead.');
          setSending(false);
          return;
        }
      }

      if (audienceEveryone) {
        const snap = await getDocs(collection(db, 'users'));
        snap.docs.forEach((d) => recipientIds.add(d.id));
      }

      recipientIds.delete(actor.uid);

      const count = await broadcastNotification(
        Array.from(recipientIds),
        { type: 'broadcast', title: title.trim(), body: message.trim() || undefined, link: '/events' },
        actor,
      );
      await updateEvent(event.id, { notified: true });
      onSent(count);
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to notify members';
      setError(msg);
      onError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }} placement="center" size="lg">
      <ModalContent>
        <ModalHeader className="text-base font-semibold">Notify members</ModalHeader>
        <ModalBody className="gap-4">
          <Input label="Title" value={title} onValueChange={setTitle} isRequired autoFocus />
          <Textarea label="Message" value={message} onValueChange={setMessage} minRows={3} />

          <div className="flex flex-col gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground-400">
              Audience
            </span>
            <div className="flex flex-col gap-2 bg-content2 rounded-large p-3">
              <Checkbox isSelected={audienceEveryone} onValueChange={setAudienceEveryone} size="sm">
                <span className="text-sm text-foreground">Everyone in the org</span>
              </Checkbox>
              <Checkbox isSelected={audienceSignedUp} onValueChange={setAudienceSignedUp} size="sm">
                <span className="text-sm text-foreground">People signed up for this shift</span>
              </Checkbox>
            </div>
          </div>

          {error && (
            <p className="text-sm text-danger inline-flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 flex-none" /> {error}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="bordered" onPress={onClose} isDisabled={sending}>
            Cancel
          </Button>
          <Button color="primary" onPress={handleSend} isLoading={sending}>
            Send
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
