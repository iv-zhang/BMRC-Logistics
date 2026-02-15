"use client";

import React, { useState } from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { fixBrokenTimestamps } from '@/app/lib/fix-timestamps';

export default function FixTimestampsPage() {
  const { role } = useUserRole();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{
    total: number;
    fixed: number;
    alreadyOk: number;
    errors: string[];
  } | null>(null);

  const handleFix = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await fixBrokenTimestamps();
      setResult(res);
    } catch (err) {
      setResult({
        total: 0,
        fixed: 0,
        alreadyOk: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    } finally {
      setRunning(false);
    }
  };

  if (role !== 'admin') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card><CardBody><p>Admin access required.</p></CardBody></Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">Fix Broken Timestamps</h1>
        <Card>
          <CardBody className="space-y-4">
            <p className="text-sm text-default-600">
              This will scan all <code>statpack_logs</code> documents for broken
              <code> serverTimestamp()</code> sentinels and replace them with a
              real server timestamp. Open browser DevTools console to see
              per-document progress.
            </p>
            <p className="text-xs text-warning-600">
              ⚠️ Note: repaired timestamps will be set to the current time (not the
              original checkout/checkin time). The original times were lost because
              the sentinel was never resolved. This at least makes the logs
              functional again.
            </p>
            <Button
              color="primary"
              isLoading={running}
              onPress={handleFix}
            >
              {running ? 'Fixing…' : 'Run Fix'}
            </Button>

            {result && (
              <div className="mt-4 space-y-2 text-sm">
                <p><strong>Total docs:</strong> {result.total}</p>
                <p><strong>Fixed:</strong> {result.fixed}</p>
                <p><strong>Already OK:</strong> {result.alreadyOk}</p>
                {result.errors.length > 0 && (
                  <div className="text-danger">
                    <strong>Errors:</strong>
                    <ul className="list-disc pl-5">
                      {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                )}
                {result.errors.length === 0 && result.fixed > 0 && (
                  <p className="text-success-600">✅ All broken timestamps fixed!</p>
                )}
                {result.fixed === 0 && result.alreadyOk > 0 && (
                  <p className="text-success-600">✅ No broken timestamps found — all good!</p>
                )}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
