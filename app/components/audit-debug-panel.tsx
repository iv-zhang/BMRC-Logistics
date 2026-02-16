'use client';

/**
 * AuditDebugPanel — In-app testing & debug overlay for the audit system.
 *
 * HOW TO USE:
 * 1. On the audit page, press Ctrl+Shift+D (or ⌘+Shift+D on Mac)
 * 2. Panel slides in from the right
 * 3. Run live tests against real Firestore data
 * 4. View snapshot diagnostics, timing, and error logs
 *
 * Only visible to admins. Logs are persisted to sessionStorage for review.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Chip,
  Progress,
} from '@heroui/react';
import {
  Bug,
  X,
  Play,
  Download,
  Trash2,
} from 'lucide-react';
import {
  generateAuditSnapshot,
  analyzeRestockNeeds,
  type AuditSnapshot,
} from '@/app/lib/audit-helpers';
import { determineIsAsset } from '@/app/lib/inventory';
import type { InventoryItem } from '@/app/types';

// ── Log entry type ───────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string;
  level: 'info' | 'pass' | 'fail' | 'warn' | 'error';
  message: string;
  data?: any;
  durationMs?: number;
}

// ── Storage helpers ──────────────────────────────────────────────────────────

const LOG_KEY = 'bmrc_audit_debug_logs';

function loadLogs(): LogEntry[] {
  try {
    return JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveLogs(logs: LogEntry[]) {
  sessionStorage.setItem(LOG_KEY, JSON.stringify(logs.slice(-500))); // Keep last 500
}

// ── Main component ───────────────────────────────────────────────────────────

interface AuditDebugPanelProps {
  inventory: InventoryItem[];
  snapshot: AuditSnapshot | null;
  userRole: string;
  canAudit: boolean;
}

export default function AuditDebugPanel({
  inventory,
  snapshot,
  userRole,
  canAudit,
}: AuditDebugPanelProps) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>(loadLogs);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Keyboard shortcut: Ctrl/⌘+Shift+D
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setOpen((p) => !p);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = useCallback((entry: Omit<LogEntry, 'timestamp'>) => {
    const newLog: LogEntry = { ...entry, timestamp: new Date().toISOString() };
    setLogs((prev) => {
      const updated = [...prev, newLog];
      saveLogs(updated);
      return updated;
    });
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    sessionStorage.removeItem(LOG_KEY);
  }, []);

  const downloadLogs = useCallback(() => {
    const text = logs
      .map((l) =>
        `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}${
          l.durationMs !== undefined ? ` (${l.durationMs}ms)` : ''
        }${l.data ? '\n  DATA: ' + JSON.stringify(l.data) : ''}`
      )
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-debug-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [logs]);

  // ── Test suites ──────────────────────────────────────────────────────────

  const runAllTests = useCallback(async () => {
    setRunning(true);
    setProgress(0);
    const tests = [
      testDataIntegrity,
      testSnapshotConsistency,
      testBoxCounting,
      testAssetClassification,
      testRestockAnalysis,
      testZoneDistribution,
      testTimingBenchmark,
    ];

    addLog({ level: 'info', message: '═══ Starting full test suite ═══' });

    for (let i = 0; i < tests.length; i++) {
      try {
        await tests[i]();
      } catch (err: any) {
        addLog({ level: 'error', message: `Test crashed: ${err.message}`, data: err.stack });
      }
      setProgress(((i + 1) / tests.length) * 100);
    }

    addLog({ level: 'info', message: '═══ Test suite complete ═══' });
    setRunning(false);
  }, [inventory, snapshot, addLog]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Individual tests ─────────────────────────────────────────────────────

  const testDataIntegrity = useCallback(async () => {
    addLog({ level: 'info', message: '── Data Integrity Checks ──' });

    // Check for items missing critical fields
    let missingName = 0;
    let missingCategory = 0;
    let missingBoxes = 0;
    let negativeBoxes = 0;
    let missingItemsPerBox = 0;

    inventory.forEach((item) => {
      if (!item.name) missingName++;
      if (!item.category) missingCategory++;
      if (item.unopenedBoxes === undefined || item.unopenedBoxes === null) missingBoxes++;
      if (typeof item.unopenedBoxes === 'number' && item.unopenedBoxes < 0) negativeBoxes++;
      if (!item.itemsPerBox) missingItemsPerBox++;
    });

    if (missingName === 0) {
      addLog({ level: 'pass', message: 'All items have names' });
    } else {
      addLog({ level: 'fail', message: `${missingName} items missing name field` });
    }

    if (missingCategory === 0) {
      addLog({ level: 'pass', message: 'All items have categories' });
    } else {
      addLog({ level: 'warn', message: `${missingCategory} items missing category` });
    }

    if (missingBoxes === 0) {
      addLog({ level: 'pass', message: 'All items have unopenedBoxes field' });
    } else {
      addLog({
        level: 'warn',
        message: `${missingBoxes} items missing unopenedBoxes`,
        data: inventory.filter((i) => i.unopenedBoxes === undefined || i.unopenedBoxes === null).map((i) => i.name),
      });
    }

    if (negativeBoxes === 0) {
      addLog({ level: 'pass', message: 'No items have negative box counts' });
    } else {
      addLog({
        level: 'fail',
        message: `${negativeBoxes} items have negative unopenedBoxes!`,
        data: inventory.filter((i) => typeof i.unopenedBoxes === 'number' && i.unopenedBoxes < 0).map((i) => ({ name: i.name, boxes: i.unopenedBoxes })),
      });
    }

    if (missingItemsPerBox === 0) {
      addLog({ level: 'pass', message: 'All items have itemsPerBox' });
    } else {
      addLog({
        level: 'warn',
        message: `${missingItemsPerBox} items missing itemsPerBox (defaults to 1)`,
      });
    }
  }, [inventory, addLog]);

  const testSnapshotConsistency = useCallback(async () => {
    addLog({ level: 'info', message: '── Snapshot Consistency ──' });

    if (!snapshot) {
      addLog({ level: 'warn', message: 'No snapshot loaded — skipping' });
      return;
    }

    const totalInSnapshot = snapshot.disposables.length + snapshot.assets.length;
    addLog({ level: 'info', message: `Snapshot has ${totalInSnapshot} items (${snapshot.disposables.length} disposables, ${snapshot.assets.length} assets)` });

    // Check if snapshot matches inventory count
    const disposablesInInv = inventory.filter((i) => !determineIsAsset(i)).length;
    const assetsInInv = inventory.filter((i) => determineIsAsset(i)).length;

    if (snapshot.disposables.length === disposablesInInv) {
      addLog({ level: 'pass', message: 'Disposable count matches inventory' });
    } else {
      addLog({
        level: 'warn',
        message: `Disposable count mismatch: snapshot ${snapshot.disposables.length} vs inventory ${disposablesInInv} (zone filter active?)`,
      });
    }

    if (snapshot.assets.length === assetsInInv) {
      addLog({ level: 'pass', message: 'Asset count matches inventory' });
    } else {
      addLog({
        level: 'warn',
        message: `Asset count mismatch: snapshot ${snapshot.assets.length} vs inventory ${assetsInInv} (zone filter active?)`,
      });
    }

    // Verify low stock counts
    const computedLowStock = snapshot.disposables.filter((d) => d.isLowStock).length;
    if (computedLowStock === snapshot.lowStockCount) {
      addLog({ level: 'pass', message: `Low stock count verified: ${computedLowStock}` });
    } else {
      addLog({ level: 'fail', message: `Low stock mismatch: reported ${snapshot.lowStockCount} but counted ${computedLowStock}` });
    }

    // Verify expired counts
    const computedExpired = snapshot.disposables.filter((d) => d.isExpired).length;
    if (computedExpired === snapshot.expiredCount) {
      addLog({ level: 'pass', message: `Expired count verified: ${computedExpired}` });
    } else {
      addLog({ level: 'fail', message: `Expired count mismatch: reported ${snapshot.expiredCount} but counted ${computedExpired}` });
    }
  }, [inventory, snapshot, addLog]);

  const testBoxCounting = useCallback(async () => {
    addLog({ level: 'info', message: '── Box Counting Validation ──' });

    let stockSyncIssues = 0;
    const issues: { name: string; boxes: number; total: number; expected: number }[] = [];

    inventory.forEach((item) => {
      if (determineIsAsset(item)) return;

      const boxes = item.unopenedBoxes ?? 0;
      const perBox = item.itemsPerBox ?? 1;
      const total = item.totalStockQuantity ?? 0;
      const expectedTotal = boxes * perBox;

      // Check if totalStockQuantity is in sync with boxes * itemsPerBox
      if (total > 0 && expectedTotal > 0 && total !== expectedTotal) {
        stockSyncIssues++;
        issues.push({ name: item.name, boxes, total, expected: expectedTotal });
      }
    });

    if (stockSyncIssues === 0) {
      addLog({ level: 'pass', message: 'totalStockQuantity in sync with boxes × itemsPerBox for all items' });
    } else {
      addLog({
        level: 'warn',
        message: `${stockSyncIssues} items have totalStockQuantity out of sync (legacy data)`,
        data: issues.slice(0, 10), // Show first 10
      });
    }

    // Check for items that should use box tracking but have no box data
    const disposablesWithoutBoxes = inventory.filter(
      (i) => !determineIsAsset(i) && (i.unopenedBoxes === undefined || i.unopenedBoxes === null) && (i.totalStockQuantity ?? 0) > 0
    );
    if (disposablesWithoutBoxes.length === 0) {
      addLog({ level: 'pass', message: 'All disposables with stock have box counts' });
    } else {
      addLog({
        level: 'warn',
        message: `${disposablesWithoutBoxes.length} disposables have totalStockQuantity but no unopenedBoxes (needs migration)`,
        data: disposablesWithoutBoxes.map((i) => ({ name: i.name, total: i.totalStockQuantity })),
      });
    }
  }, [inventory, addLog]);

  const testAssetClassification = useCallback(async () => {
    addLog({ level: 'info', message: '── Asset Classification ──' });

    let implicitAssets = 0;
    let misclassified = 0;

    inventory.forEach((item) => {
      const isAsset = determineIsAsset(item);

      // Check items classified as assets solely by value or category (not explicit flag)
      if (isAsset && item.isAsset !== true) {
        implicitAssets++;
      }

      // Check disposables with high value
      if (!isAsset && typeof item.assetValue === 'number' && item.assetValue >= 500) {
        misclassified++;
      }
    });

    addLog({
      level: 'info',
      message: `${inventory.filter((i) => determineIsAsset(i)).length} assets, ${inventory.filter((i) => !determineIsAsset(i)).length} disposables in inventory`,
    });

    if (implicitAssets > 0) {
      addLog({
        level: 'warn',
        message: `${implicitAssets} items classified as assets implicitly (by category/value, not isAsset flag)`,
      });
    }

    if (misclassified > 0) {
      addLog({
        level: 'fail',
        message: `${misclassified} high-value items not flagged as assets — review classification`,
      });
    } else {
      addLog({ level: 'pass', message: 'No misclassified high-value disposables' });
    }
  }, [inventory, addLog]);

  const testRestockAnalysis = useCallback(async () => {
    addLog({ level: 'info', message: '── Restock Analysis ──' });

    if (!snapshot) {
      addLog({ level: 'warn', message: 'No snapshot — skipping' });
      return;
    }

    const decisions = analyzeRestockNeeds(snapshot.disposables);
    const critical = decisions.filter((d) => d.urgency === 'critical');
    const low = decisions.filter((d) => d.urgency === 'low');

    addLog({
      level: 'info',
      message: `${decisions.length} restock decisions: ${critical.length} critical, ${low.length} low`,
    });

    if (critical.length > 0) {
      addLog({
        level: 'warn',
        message: `Critical items needing restock:`,
        data: critical.map((c) => `${c.itemName} (${c.unopenedBoxes} boxes, need ${c.reorderThreshold})`),
      });
    }

    // Verify all out-of-stock items are critical
    const outOfStock = snapshot.disposables.filter((d) => d.unopenedBoxes === 0);
    const outOfStockNotCritical = outOfStock.filter(
      (d) => !critical.find((c) => c.itemId === d.id)
    );
    if (outOfStockNotCritical.length === 0) {
      addLog({ level: 'pass', message: 'All out-of-stock items flagged as critical' });
    } else {
      addLog({
        level: 'fail',
        message: `${outOfStockNotCritical.length} out-of-stock items not flagged critical`,
        data: outOfStockNotCritical.map((i) => i.name),
      });
    }
  }, [snapshot, addLog]);

  const testZoneDistribution = useCallback(async () => {
    addLog({ level: 'info', message: '── Zone Distribution ──' });

    const zones: Record<string, number> = {};
    inventory.forEach((item) => {
      const zone = item.room || item.location || 'Unknown';
      zones[zone] = (zones[zone] || 0) + 1;
    });

    Object.entries(zones)
      .sort(([, a], [, b]) => b - a)
      .forEach(([zone, count]) => {
        addLog({ level: 'info', message: `  ${zone}: ${count} items` });
      });

    const unlocated = zones['Unknown'] ?? 0;
    if (unlocated === 0) {
      addLog({ level: 'pass', message: 'All items have a zone assignment' });
    } else {
      addLog({ level: 'warn', message: `${unlocated} items have no zone (room/location)` });
    }
  }, [inventory, addLog]);

  const testTimingBenchmark = useCallback(async () => {
    addLog({ level: 'info', message: '── Timing Benchmarks ──' });

    // Benchmark snapshot generation (live Firestore call)
    const t0 = performance.now();
    try {
      await generateAuditSnapshot();
      const t1 = performance.now();
      const dur = Math.round(t1 - t0);
      if (dur < 2000) {
        addLog({ level: 'pass', message: `Snapshot generation: ${dur}ms (target < 2000ms)`, durationMs: dur });
      } else {
        addLog({ level: 'warn', message: `Snapshot generation slow: ${dur}ms (target < 2000ms)`, durationMs: dur });
      }
    } catch (err: any) {
      addLog({ level: 'error', message: `Snapshot generation failed: ${err.message}` });
    }

    // Benchmark restock analysis (pure computation)
    if (snapshot) {
      const t2 = performance.now();
      analyzeRestockNeeds(snapshot.disposables);
      const t3 = performance.now();
      addLog({ level: 'pass', message: `Restock analysis: ${Math.round(t3 - t2)}ms`, durationMs: Math.round(t3 - t2) });
    }

    // Benchmark filtering
    const t4 = performance.now();
    const searchTerm = 'bandaid';
    inventory.filter((i) => i.name.toLowerCase().includes(searchTerm));
    const t5 = performance.now();
    addLog({ level: 'pass', message: `Search filter: ${Math.round(t5 - t4)}ms for ${inventory.length} items`, durationMs: Math.round(t5 - t4) });
  }, [inventory, snapshot, addLog]);

  // ── Render ─────────────────────────────────────────────────────────────

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 p-2 rounded-full bg-default-100 hover:bg-default-200 shadow-lg opacity-30 hover:opacity-100 transition-opacity"
        title="Open Debug Panel (⌘+Shift+D)"
      >
        <Bug size={18} />
      </button>
    );
  }

  const passCount = logs.filter((l) => l.level === 'pass').length;
  const failCount = logs.filter((l) => l.level === 'fail').length;
  const warnCount = logs.filter((l) => l.level === 'warn').length;

  return (
    <div className="fixed right-0 top-0 bottom-0 w-[420px] max-w-[90vw] z-50 bg-background border-l border-divider shadow-2xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-divider bg-default-50">
        <div className="flex items-center gap-2">
          <Bug size={18} className="text-warning" />
          <span className="font-semibold text-sm">Audit Debug Panel</span>
        </div>
        <div className="flex items-center gap-1">
          <Chip size="sm" color="success" variant="flat">
            {passCount} ✓
          </Chip>
          {failCount > 0 && (
            <Chip size="sm" color="danger" variant="flat">
              {failCount} ✗
            </Chip>
          )}
          {warnCount > 0 && (
            <Chip size="sm" color="warning" variant="flat">
              {warnCount} ⚠
            </Chip>
          )}
          <Button isIconOnly size="sm" variant="light" onPress={() => setOpen(false)}>
            <X size={16} />
          </Button>
        </div>
      </div>

      {/* Quick stats */}
      <div className="px-4 py-2 border-b border-divider bg-default-50/50 text-xs text-default-500 grid grid-cols-3 gap-2">
        <div>
          <div className="font-medium">Inventory</div>
          <div>{inventory.length} items</div>
        </div>
        <div>
          <div className="font-medium">Role</div>
          <div>{userRole} {canAudit ? '✓' : '✗'}</div>
        </div>
        <div>
          <div className="font-medium">Snapshot</div>
          <div>{snapshot ? `${snapshot.totalDisposableTypes}d / ${snapshot.totalAssetTypes}a` : 'None'}</div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-4 py-2 border-b border-divider flex gap-2 flex-wrap">
        <Button
          size="sm"
          color="primary"
          variant="flat"
          startContent={<Play size={14} />}
          isLoading={running}
          onPress={runAllTests}
        >
          Run All Tests
        </Button>
        <Button
          size="sm"
          variant="flat"
          startContent={<Download size={14} />}
          onPress={downloadLogs}
          isDisabled={logs.length === 0}
        >
          Export
        </Button>
        <Button
          size="sm"
          variant="flat"
          color="danger"
          startContent={<Trash2 size={14} />}
          onPress={clearLogs}
          isDisabled={logs.length === 0}
        >
          Clear
        </Button>
      </div>

      {/* Progress bar */}
      {running && (
        <div className="px-4 py-1">
          <Progress value={progress} size="sm" color="primary" />
        </div>
      )}

      {/* Log output */}
      <div className="flex-1 overflow-auto px-4 py-2 font-mono text-xs space-y-0.5">
        {logs.length === 0 && (
          <div className="text-center text-default-400 py-8">
            Press &ldquo;Run All Tests&rdquo; to start
            <br />
            <span className="text-xs">or ⌘+Shift+D to toggle this panel</span>
          </div>
        )}
        {logs.map((log, i) => (
          <div
            key={i}
            className={`py-0.5 ${
              log.level === 'pass'
                ? 'text-success'
                : log.level === 'fail'
                  ? 'text-danger'
                  : log.level === 'warn'
                    ? 'text-warning'
                    : log.level === 'error'
                      ? 'text-danger font-bold'
                      : 'text-default-500'
            }`}
          >
            <span className="opacity-40 mr-1">
              {new Date(log.timestamp).toLocaleTimeString()}
            </span>
            {log.level === 'pass' && '✅ '}
            {log.level === 'fail' && '❌ '}
            {log.level === 'warn' && '⚠️ '}
            {log.level === 'error' && '🔥 '}
            {log.level === 'info' && '🔹 '}
            {log.message}
            {log.durationMs !== undefined && (
              <span className="opacity-50 ml-1">({log.durationMs}ms)</span>
            )}
            {log.data && (
              <details className="ml-4 opacity-70">
                <summary className="cursor-pointer">details</summary>
                <pre className="whitespace-pre-wrap text-[10px] leading-tight mt-0.5">
                  {typeof log.data === 'string' ? log.data : JSON.stringify(log.data, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}
