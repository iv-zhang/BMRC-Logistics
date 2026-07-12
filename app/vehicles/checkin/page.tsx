'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardBody, Button, Input, Spinner, Chip, Avatar } from '@heroui/react';
import { ArrowLeft, LogIn, Search, Truck, Ambulance, Bike, Car } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { useVehicles } from '@/app/hooks/useVehicles';
import { formatWhen } from '@/app/lib/vehicle-format';
import type { Vehicle } from '@/app/types';

const TYPE_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Ambulance,
  Bike,
  Truck,
  Car,
};

export default function VehicleCheckinPickerPage() {
  const router = useRouter();
  const { user, role, loading: authLoading } = useUserRole();
  const isAdmin = role === 'admin' || role === 'quartermaster';
  const { vehicles: vehicleTypes } = useOrgConfig();
  const { vehicles, loading } = useVehicles();
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [authLoading, user, router]);

  const handleSelect = useCallback((vehicle: Vehicle) => {
    // Non-admins can only check in a vehicle they took out (same rule as statpacks;
    // the transaction in checkinVehicle enforces it too).
    if (!isAdmin && vehicle.assignedToUserId && vehicle.assignedToUserId !== user?.uid) {
      alert(`This vehicle was checked out by ${vehicle.assignedToUserName ?? 'another member'}. Only they (or an admin) can check it in.`);
      return;
    }
    router.push(`/vehicles/check-off?id=${vehicle.id}&mode=checkin`);
  }, [router, isAdmin, user]);

  const typeName = (typeId: string) => vehicleTypes.find((t) => t.id === typeId)?.name ?? typeId;
  const typeIcon = (typeId: string) => {
    const iconName = vehicleTypes.find((t) => t.id === typeId)?.icon ?? 'Truck';
    return TYPE_ICONS[iconName] ?? Truck;
  };

  const checkedOut = vehicles
    .filter((v) => v.isCheckedOut)
    .sort((a, b) => {
      // Own vehicles float to the top.
      const aMine = a.assignedToUserId === user?.uid ? 0 : 1;
      const bMine = b.assignedToUserId === user?.uid ? 0 : 1;
      if (aMine !== bMine) return aMine - bMine;
      return a.name.localeCompare(b.name);
    });
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? checkedOut.filter((v) =>
        v.name.toLowerCase().includes(q) ||
        typeName(v.typeId).toLowerCase().includes(q) ||
        v.assignedToUserName?.toLowerCase().includes(q))
    : checkedOut;

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800 flex items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-6 bg-gradient-to-br from-indigo-50 to-blue-50 dark:from-slate-900 dark:to-slate-800">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button isIconOnly variant="light" onPress={() => router.back()} aria-label="Back">
            <ArrowLeft size={20} />
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <LogIn className="text-primary" size={24} />
              <h1 className="text-2xl md:text-3xl font-semibold">Vehicle Check In</h1>
            </div>
            <p className="text-sm text-foreground-500">Select the vehicle you&apos;re returning</p>
          </div>
        </div>

        <Card>
          <CardBody className="gap-4">
            <Input
              placeholder="Search by name, type, or driver..."
              value={searchQuery}
              onValueChange={setSearchQuery}
              startContent={<Search size={18} />}
              isClearable
              onClear={() => setSearchQuery('')}
            />
            <div className="flex items-center gap-2 text-sm text-foreground-500">
              <Chip size="sm" variant="flat" color="warning">{filtered.length} Checked out</Chip>
            </div>
          </CardBody>
        </Card>

        <div className="space-y-3">
          {filtered.length === 0 ? (
            <Card>
              <CardBody className="text-center py-12">
                <Truck size={48} className="mx-auto mb-3 text-foreground-400" />
                <p className="text-foreground-500">
                  {searchQuery ? 'No vehicles match your search' : 'No vehicles are checked out right now'}
                </p>
              </CardBody>
            </Card>
          ) : (
            filtered.map((vehicle) => {
              const Icon = typeIcon(vehicle.typeId);
              const isMine = vehicle.assignedToUserId === user?.uid;
              return (
                <Card
                  key={vehicle.id}
                  isPressable
                  onPress={() => handleSelect(vehicle)}
                  className="hover:shadow-lg transition-shadow w-full"
                >
                  <CardBody className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <Avatar icon={<Icon />} className="bg-primary-100" />
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-lg truncate">{vehicle.name}</h3>
                          <p className="text-sm text-foreground-500">{typeName(vehicle.typeId)}</p>
                          <p className="text-xs text-foreground-400 mt-1">
                            {vehicle.assignedToUserName ?? 'Unknown driver'} · out since {formatWhen(vehicle.checkedOutAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {isMine ? (
                          <Chip color="primary" size="sm" variant="flat">Your vehicle</Chip>
                        ) : (
                          <Chip color="warning" size="sm" variant="flat">Checked out</Chip>
                        )}
                      </div>
                    </div>
                  </CardBody>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
