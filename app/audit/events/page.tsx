'use client';

import React, { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, onSnapshot, getDocs } from 'firebase/firestore';
import { db } from '@/firebase';
import { Card, CardHeader, CardBody, CardFooter, Button, Badge } from '@heroui/react';

export default function AuditEventsPage() {
  const [events, setEvents] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState<string>('auditEvents');

  useEffect(() => {
    const collectionName = source;
    const q = query(collection(db, collectionName), orderBy('timestamp', 'desc'), limit(50));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const normalized = snap.docs.map((d) => {
          const data = d.data();
          // normalize different log shapes into a common viewer model
          return {
            id: d.id,
            eventType: data.eventType || data.action || collectionName,
            actor: data.actor || { userId: data.userId ?? null, userName: data.userName ?? data.userName ?? data.userEmail ?? null },
            timestamp: data.timestamp || data.createdAt || null,
            targets: data.targets || (data.itemId ? [{ collection: 'inventory', docId: data.itemId }] : (data.statpackId ? [{ collection: 'statpacks', docId: data.statpackId }] : [])),
            details: data,
            delta: data.delta || null,
            before: data.before || null,
            after: data.after || null,
          };
        });
        setEvents(normalized);
      },
      (err) => console.error(`Listener failed for ${collectionName}`, err)
    );
    return () => unsub();
  }, [source]);

  const toggle = (id: string) => setExpanded((s) => ({ ...s, [id]: !s[id] }));

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-bold">Logs</h2>
        <div className="flex gap-2">
          <Button size="sm" variant={source === 'auditEvents' ? 'solid' : 'bordered'} onPress={() => setSource('auditEvents')}>Audit Events</Button>
          <Button size="sm" variant={source === 'inventory_logs' ? 'solid' : 'bordered'} onPress={() => setSource('inventory_logs')}>Inventory Logs</Button>
          <Button size="sm" variant={source === 'statpack_logs' ? 'solid' : 'bordered'} onPress={() => setSource('statpack_logs')}>Statpack Logs</Button>
        </div>
      </div>
      <div className="grid gap-3">
        {events.length === 0 && <div className="text-sm text-muted">No events in {source}.</div>}
        {events.map((ev) => {
          const ts = ev.timestamp && ev.timestamp.toDate ? ev.timestamp.toDate().toLocaleString() : String(ev.timestamp ?? '');
          const actor = ev.actor?.userName || ev.actor?.userEmail || ev.actor?.userId || 'system';
          return (
            <Card key={ev.id} className="bg-white dark:bg-slate-800">
              <CardHeader className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="font-medium text-sm">{ev.eventType}</div>
                    <Badge color="primary">{actor}</Badge>
                  </div>
                  <div className="text-xs text-muted">{ts}</div>
                </div>
                <div className="flex items-center gap-2">
                  {ev.targets && ev.targets.length > 0 && (
                    <div className="text-xs text-gray-500 mr-2">Targets: {ev.targets.map((t: any) => `${t.collection}/${t.docId}`).join(', ')}</div>
                  )}
                  <Button size="sm" variant="bordered" onPress={() => toggle(ev.id)}>
                    {expanded[ev.id] ? 'Hide' : 'Details'}
                  </Button>
                </div>
              </CardHeader>

              {expanded[ev.id] && (
                <CardBody>
                  <pre className="text-xs overflow-auto whitespace-pre-wrap">{JSON.stringify(ev.details || ev.delta || { before: ev.before, after: ev.after }, null, 2)}</pre>
                </CardBody>
              )}

              <CardFooter className="text-xs text-muted">Event ID: {ev.id}</CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
