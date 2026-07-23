'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardBody, Button, Spinner, Tabs, Tab } from '@heroui/react';
import { RotateCcw, Check, X as XIcon } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { saveOrgConfig, resetOrgConfigToDefaults } from '@/app/lib/org-config-store';
import { DEFAULT_ORG_CONFIG, type OrgConfigDoc } from '@/app/config/org-config';
import { OrgTab, ThresholdsTab } from '@/app/components/settings/org-and-thresholds-tab';
import { SitesRoomsTab } from '@/app/components/settings/sites-rooms-tab';
import { ItemCategoriesTab, ItemFamiliesTab, AssetCategoriesTab } from '@/app/components/settings/categories-tab';
import { StatpackTypesTab, VehiclesTab } from '@/app/components/settings/statpacks-vehicles-tab';
import { validateOrgConfig } from '@/app/components/settings/settings-utils';
import { propagateFamilyRename } from '@/app/lib/item-naming';

function cloneConfig(cfg: {
  org: OrgConfigDoc['org'];
  locations: OrgConfigDoc['locations'];
  vehicles: OrgConfigDoc['vehicles'];
  assetCategories: OrgConfigDoc['assetCategories'];
  statpackTypes: OrgConfigDoc['statpackTypes'];
  itemCategories: readonly string[];
  itemFamilies: readonly string[];
  thresholds: OrgConfigDoc['thresholds'];
}): OrgConfigDoc {
  const plain: OrgConfigDoc = {
    org: cfg.org,
    locations: cfg.locations,
    vehicles: cfg.vehicles,
    assetCategories: cfg.assetCategories,
    statpackTypes: cfg.statpackTypes,
    itemCategories: [...cfg.itemCategories],
    itemFamilies: [...cfg.itemFamilies],
    thresholds: cfg.thresholds,
  };
  return typeof structuredClone === 'function' ? structuredClone(plain) : JSON.parse(JSON.stringify(plain));
}

export default function SettingsPage() {
  const router = useRouter();
  const { user, userData, role, loading: authLoading } = useUserRole();
  const orgConfig = useOrgConfig();
  const isAdmin = role === 'admin' || role === 'quartermaster';

  const [draft, setDraft] = useState<OrgConfigDoc | null>(null);
  const [saved, setSaved] = useState<OrgConfigDoc | null>(null);
  const initializedRef = useRef(false);

  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [selectedTab, setSelectedTab] = useState<string>('organization');

  // Deep-link the active tab via ?tab= (e.g. /settings?tab=sites from the
  // retired /storage route). Read once on mount; keep the URL in sync on change.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t) setSelectedTab(t);
  }, []);
  const onTabChange = (key: React.Key) => {
    const k = String(key);
    setSelectedTab(k);
    window.history.replaceState(null, '', `/settings?tab=${k}`);
  };

  // Seed the editable draft once, the first time the live config resolves.
  useEffect(() => {
    if (!isAdmin || orgConfig.loading || initializedRef.current) return;
    initializedRef.current = true;
    const initial = cloneConfig(orgConfig);
    setDraft(initial);
    setSaved(initial);
  }, [isAdmin, orgConfig]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  const updateDraft = (patch: Partial<OrgConfigDoc>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const isDirty = useMemo(() => {
    if (!draft || !saved) return false;
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }, [draft, saved]);

  const errors = useMemo(() => (draft ? Array.from(new Set(validateOrgConfig(draft))) : []), [draft]);

  const actor = useMemo(
    () => ({ uid: user?.uid ?? 'unknown', name: userData?.fullName || user?.displayName || user?.email || 'Unknown' }),
    [user, userData],
  );

  const handleSave = async () => {
    if (!draft || errors.length > 0) return;
    setSaving(true);
    try {
      // Detect same-position family renames BEFORE saving, so the propagation
      // targets the old string that's about to be overwritten.
      const renames: { oldFamily: string; newFamily: string }[] = [];
      if (saved) {
        const prevFamilies = saved.itemFamilies;
        const nextFamilies = draft.itemFamilies;
        for (let i = 0; i < Math.min(prevFamilies.length, nextFamilies.length); i++) {
          const prev = prevFamilies[i]?.trim();
          const next = nextFamilies[i]?.trim();
          if (prev && next && prev !== next) renames.push({ oldFamily: prev, newFamily: next });
        }
      }

      await saveOrgConfig(draft, actor);
      setSaved(draft);
      setToast({ ok: true, msg: 'Settings saved.' });

      // Best-effort: propagate renamed families onto already-saved inventory
      // items. Never let a propagation failure undo or mask the config save.
      if (renames.length > 0) {
        try {
          let total = 0;
          for (const { oldFamily, newFamily } of renames) {
            total += await propagateFamilyRename(oldFamily, newFamily, { id: actor.uid, name: actor.name });
          }
          if (total > 0) {
            setToast({ ok: true, msg: `Settings saved. Renamed family on ${total} item${total === 1 ? '' : 's'}.` });
          }
        } catch (e) {
          console.error('Failed to propagate family rename', e);
          setToast({ ok: false, msg: 'Settings saved, but some items may still show the old family name.' });
        }
      }
    } catch (e) {
      console.error('Failed to save org settings', e);
      setToast({ ok: false, msg: 'Failed to save settings.' });
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!saved) return;
    setDraft(cloneConfig(saved));
  };

  const handleRestoreDefaults = async () => {
    if (!confirm('Restore all organization settings to their built-in defaults? This cannot be undone.')) return;
    setResetting(true);
    try {
      await resetOrgConfigToDefaults(actor);
      const defaults = cloneConfig({ ...DEFAULT_ORG_CONFIG });
      setDraft(defaults);
      setSaved(defaults);
      setToast({ ok: true, msg: 'Restored to defaults.' });
    } catch (e) {
      console.error('Failed to reset org settings', e);
      setToast({ ok: false, msg: 'Failed to restore defaults.' });
    } finally {
      setResetting(false);
    }
  };

  if (authLoading || (isAdmin && (orgConfig.loading || !draft))) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center p-4">
        <Card>
          <CardBody>
            <p className="text-danger">Access denied. Only admins and quartermasters can manage organization settings.</p>
            <Button color="primary" onPress={() => router.push('/dashboard')} className="mt-4">
              Go to Dashboard
            </Button>
          </CardBody>
        </Card>
      </div>
    );
  }

  if (!draft) return null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 p-4 md:p-6">
      <div className="max-w-6xl mx-auto pb-24">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Organization Settings</h1>
            <p className="text-foreground-500">Customize sites, categories, statpacks, and thresholds — no code required.</p>
          </div>
          <Button
            variant="bordered"
            color="danger"
            size="sm"
            startContent={<RotateCcw size={15} />}
            isLoading={resetting}
            onPress={handleRestoreDefaults}
          >
            Restore defaults
          </Button>
        </div>

        {/* Tabs */}
        <Tabs aria-label="Organization settings" selectedKey={selectedTab} onSelectionChange={onTabChange}>
          <Tab key="organization" title="Organization">
            <div className="mt-4">
              <OrgTab org={draft.org} onChange={(org) => updateDraft({ org })} />
            </div>
          </Tab>

          <Tab key="sites" title="Sites & Storage">
            <div className="mt-4">
              <SitesRoomsTab locations={draft.locations} onChange={(locations) => updateDraft({ locations })} />
            </div>
          </Tab>

          <Tab key="item-categories" title="Item Categories">
            <div className="mt-4">
              <ItemCategoriesTab
                itemCategories={draft.itemCategories}
                onChange={(itemCategories) => updateDraft({ itemCategories })}
              />
            </div>
          </Tab>

          <Tab key="item-families" title="Item Families">
            <div className="mt-4">
              <ItemFamiliesTab
                itemFamilies={draft.itemFamilies}
                onChange={(itemFamilies) => updateDraft({ itemFamilies })}
              />
            </div>
          </Tab>

          <Tab key="asset-categories" title="Asset Categories">
            <div className="mt-4">
              <AssetCategoriesTab
                assetCategories={draft.assetCategories}
                verificationFields={orgConfig.verificationFields}
                onChange={(assetCategories) => updateDraft({ assetCategories })}
              />
            </div>
          </Tab>

          <Tab key="statpack-types" title="Statpack Types">
            <div className="mt-4">
              <StatpackTypesTab
                statpackTypes={draft.statpackTypes}
                onChange={(statpackTypes) => updateDraft({ statpackTypes })}
              />
            </div>
          </Tab>

          <Tab key="vehicles" title="Vehicle Types">
            <div className="mt-4">
              <VehiclesTab vehicles={draft.vehicles} onChange={(vehicles) => updateDraft({ vehicles })} />
            </div>
          </Tab>

          <Tab key="thresholds" title="Thresholds">
            <div className="mt-4">
              <ThresholdsTab thresholds={draft.thresholds} onChange={(thresholds) => updateDraft({ thresholds })} />
            </div>
          </Tab>
        </Tabs>
      </div>

      {/* Sticky unsaved-changes bar */}
      {isDirty && (
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-content1/95 backdrop-blur-md border-t border-divider px-4 md:px-6 py-3">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 flex-wrap">
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold text-foreground">Unsaved changes</span>
              {errors.length > 0 ? (
                <span className="text-xs text-danger font-medium">{errors[0]}</span>
              ) : (
                <span className="text-xs text-foreground-400">Save to apply these changes for everyone.</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="light" size="sm" onPress={handleDiscard} isDisabled={saving}>
                Discard
              </Button>
              <Button
                color="primary"
                size="sm"
                onPress={handleSave}
                isLoading={saving}
                isDisabled={errors.length > 0}
              >
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Saving toast (in-progress) */}
      {saving && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] bg-content1 border border-divider rounded-large px-4 py-2 shadow-lg flex items-center gap-2 text-sm text-foreground-600">
          <Spinner size="sm" color="primary" /> Saving…
        </div>
      )}

      {/* Result toast (outcome) */}
      {toast && !saving && (
        <div
          className={`fixed z-[60] left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white max-w-[92vw] ${
            isDirty ? 'bottom-24' : 'bottom-6'
          } ${toast.ok ? 'bg-success' : 'bg-danger'}`}
        >
          <div className="w-5 h-5 rounded-full bg-white/25 flex items-center justify-center flex-none">
            {toast.ok ? <Check size={12} strokeWidth={3.5} /> : <XIcon size={12} strokeWidth={3.5} />}
          </div>
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
