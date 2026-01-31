'use client';

import React from 'react';
import { Button, Input, ButtonGroup } from '@heroui/react';
import { Plus, Minus } from 'lucide-react';

interface CountControlProps {
  value: number;
  onChange: (value: number) => void;
  label?: string;
  min?: number;
  max?: number;
  presets?: number[];
}

/**
 * Touch-friendly count control with +/- buttons and optional preset quick-select buttons.
 * Designed for mobile audit workflows to minimize fat-fingering.
 * Now optimized for box-based counting.
 */
export default function CountControl({
  value,
  onChange,
  label = 'Boxes',
  min = 0,
  max = 999,
  presets = [1, 5, 10],
}: CountControlProps) {
  const handleIncrement = () => {
    const newVal = value + 1;
    if (newVal <= max) onChange(newVal);
  };

  const handleDecrement = () => {
    const newVal = value - 1;
    if (newVal >= min) onChange(newVal);
  };

  const handlePreset = (p: number) => {
    const newVal = value + p;
    if (newVal >= min && newVal <= max) onChange(newVal);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const num = parseInt(e.target.value, 10);
    if (!isNaN(num) && num >= min && num <= max) {
      onChange(num);
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {label && <label className="text-sm font-medium">{label}</label>}

      {/* Main +/- Controls */}
      <div className="flex items-center gap-2">
        <Button
          isIconOnly
          color="default"
          variant="flat"
          size="lg"
          onClick={handleDecrement}
          disabled={value <= min}
          className="min-w-[56px] h-[56px]"
        >
          <Minus size={24} />
        </Button>

        <Input
          type="number"
          value={value.toString()}
          onChange={handleInputChange}
          className="flex-1 text-center"
          classNames={{
            input: 'text-2xl font-bold text-center',
          }}
          min={min}
          max={max}
        />

        <Button
          isIconOnly
          color="primary"
          variant="flat"
          size="lg"
          onClick={handleIncrement}
          disabled={value >= max}
          className="min-w-[56px] h-[56px]"
        >
          <Plus size={24} />
        </Button>
      </div>

      {/* Preset Buttons */}
      {presets.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {presets.map((preset) => (
            <Button
              key={preset}
              size="sm"
              variant="bordered"
              onClick={() => handlePreset(preset)}
              className="flex-1 min-w-max"
            >
              +{preset}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
