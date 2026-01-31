'use client';

import React from 'react';
import { ButtonGroup, Button } from '@heroui/react';

export type ConditionValue = 'Good' | 'Damaged' | 'Expired';

interface ConditionToggleProps {
  value: ConditionValue;
  onChange: (value: ConditionValue) => void;
  label?: string;
}

/**
 * Large touch-friendly condition toggle for mobile audit.
 * Three-state toggle: Good -> Damaged -> Expired -> Good.
 */
export default function ConditionToggle({
  value,
  onChange,
  label = 'Condition',
}: ConditionToggleProps) {
  const conditions: ConditionValue[] = ['Good', 'Damaged', 'Expired'];

  const handleToggle = (condition: ConditionValue) => {
    onChange(condition);
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {label && <label className="text-sm font-medium">{label}</label>}

      <ButtonGroup className="w-full" fullWidth>
        {conditions.map((condition) => (
          <Button
            key={condition}
            color={
              value === condition
                ? condition === 'Good'
                  ? 'success'
                  : condition === 'Damaged'
                  ? 'warning'
                  : 'danger'
                : 'default'
            }
            variant={value === condition ? 'solid' : 'bordered'}
            size="lg"
            onClick={() => handleToggle(condition)}
            className={
              value === condition ? 'font-bold' : ''
            }
          >
            {condition}
          </Button>
        ))}
      </ButtonGroup>
    </div>
  );
}
