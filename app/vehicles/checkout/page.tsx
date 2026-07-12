'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardBody, Button, Input, Spinner, Chip, Avatar } from '@heroui/react';
import { ArrowLeft, LogOut, Search, Truck, Ambulance, Bike, Car, Gauge, Fuel, Battery } from 'lucide-react';
import { useUserRole } from '@/app/hooks/useUserRole';
import { useOrgConfig } from '@/app/hooks/useOrgConfig';
import { useVehicles } from '@/app/hooks/useVehicles';
import { fuelLabel } from '@/app/lib/vehicle-format';
import type { Vehicle } from '@/app/types';

const TYPE_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Ambulance,
  Bike,
  Truck,
  Car,
};

export default function VehicleCheckoutPickerPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useUserRole();
  const { vehicles: vehicleTypes } = useOrgConfig();
  const { vehicles, loading } = useVehicles();
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [authLoading, user, router]);

  const handleSelect = useCallback((vehicle: Vehicle) => {
    router.push(`/vehicles/check-off?id=${vehicle.id}&mode=checkout`);
  }, [router]);

  const typeName = (typeId: string) => vehicleTypes.find((t) => t.id === typeId)?.name ?? typeId;
  const typeIcon = (typeId: string) => {
    const iconName = vehicleTypes.find((t) => t.id === typeId)?.icon ?? 'Truck';
    return TYPE_ICONS[iconName] ?? Truck;
  };

  const available = vehicles.filter((v) => v.status === 'active' && !v.isCheckedOut);
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? available.filter((v) => v.name.toLowerCase().includes(q) || typeName(v.typeId).toLowerCase().includes(q))
    : available;

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
              <LogOut className="text-primary" size={24} />
              <h1 className="text-2xl md:text-3xl font-semibold">Vehicle Check Out</h1>
            </div>
            <p className="text-sm text-foreground-500">Select the vehicle you&apos;re taking on shift</p>
          </div>
        </div>

        <Card>
          <CardBody className="gap-4">
            <Input
              placeholder="Search by name or type..."
              value={searchQuery}
              onValueChange={setSearchQuery}
              startContent={<Search size={18} />}
              isClearable
              onClear={() => setSearchQuery('')}
            />
            <div className="flex items-center gap-2 text-sm text-foreground-500">
              <Chip size="sm" variant="flat" color="success">{filtered.length} Available</Chip>
            </div>
          </CardBody>
        </Card>

        <div className="space-y-3">
          {filtered.length === 0 ? (
            <Card>
              <CardBody className="text-center py-12">
                <Truck size={48} className="mx-auto mb-3 text-foreground-400" />
                <p className="text-foreground-500">
                  {searchQuery ? 'No vehicles match your search' : 'No vehicles available for checkout'}
                </p>
              </CardBody>
            </Card>
          ) : (
            filtered.map((vehicle) => {
              const Icon = typeIcon(vehicle.typeId);
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
                          <div className="flex items-center gap-3 text-xs text-foreground-400 mt-1 flex-wrap">
                            {typeof vehicle.lastMileage === 'number' && (
                              <span className="inline-flex items-center gap-1">
                                <Gauge size={11} /> <span className="font-mono tabular-nums">{vehicle.lastMileage}</span> mi
                              </span>
                            )}
                            {fuelLabel(vehicle.lastFuelLevel) && (
                              <span className="inline-flex items-center gap-1">
                                <Fuel size={11} /> {fuelLabel(vehicle.lastFuelLevel)}
                              </span>
                            )}
                            {typeof vehicle.lastBatteryLevel === 'number' && (
                              <span className="inline-flex items-center gap-1">
                                <Battery size={11} /> <span className="font-mono tabular-nums">{vehicle.lastBatteryLevel}</span>%
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <Chip color="success" size="sm" variant="flat">Available</Chip>
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
