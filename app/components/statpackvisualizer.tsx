import React from 'react';
import { Card, CardBody, Chip } from '@heroui/react';
import { Statpack, StatpackPocket } from '@/app/types';
import { CheckCircle2, Circle } from 'lucide-react';

interface BagVisualizerProps {
  statpack: Statpack;
  selectedPocket: StatpackPocket | 'all';
  onSelectPocket: (pocket: StatpackPocket | 'all') => void;
}

export const BagVisualizer: React.FC<BagVisualizerProps> = ({ 
  statpack, 
  selectedPocket, 
  onSelectPocket 
}) => {

  const getPocketCount = (pocket: StatpackPocket) => {
    return statpack.contents?.filter(i => i.pocket === pocket).length || 0;
  };

  const getTotalCount = () => {
    return statpack.contents?.length || 0;
  };

  // Helper to determine Card styling based on selection
  // Uses 'bg-content1' for standard background (white in light, dark gray in dark mode)
  // Uses 'border-default-200' for standard borders
  const getCardProps = (pocket: StatpackPocket) => {
    const isSelected = selectedPocket === pocket;
    return {
      isPressable: true,
      onPress: () => onSelectPocket(pocket),
      className: `transition-all duration-300 border-2 ${
        isSelected 
          ? 'border-primary bg-primary/10 ring-2 ring-primary/20 scale-[1.02]' 
          : 'border-default-200 hover:border-default-400 bg-content1'
      }`,
      shadow: isSelected ? "md" : "sm" as "md" | "sm"
    };
  };

  return (
    <div className="flex flex-col items-center gap-4 p-4 w-full select-none">
      
      {/* Header / Instructions */}
      <div className="flex flex-col items-center gap-2 mb-2">
        <Chip 
          variant={selectedPocket === 'all' ? "solid" : "bordered"} 
          color="primary"
          className="cursor-pointer"
          onClick={() => onSelectPocket('all')}
        >
          Total Inventory: {getTotalCount()} Items
        </Chip>
        <span className="text-tiny text-default-400 uppercase tracking-wider font-bold">
           Interactive Bag View
        </span>
      </div>

      {/* Bag Grid Layout */}
      <div className="flex justify-center items-stretch gap-3 h-[320px]">
        
        {/* Left Side Pocket */}
        <Card {...getCardProps('side_left')} className={`${getCardProps('side_left').className} w-20 flex flex-col justify-center`}>
           <CardBody className="p-2 flex flex-col items-center justify-center gap-2 overflow-visible">
              {/* Removed rotate-180. 'vertical-rl' reads Top-to-Bottom by default */}
              <span className="vertical-rl text-xs font-bold text-default-500 tracking-widest whitespace-nowrap uppercase">
                Left
              </span>
              <Circle className="text-default-300" size={24} />
              <Chip size="sm" variant="flat">
                {getPocketCount('side_left')} Items
              </Chip>
           </CardBody>
        </Card>

        {/* Center Column */}
        <div className="flex flex-col gap-3 w-48">
          
          {/* Main Compartment */}
          <Card {...getCardProps('main')} className={`${getCardProps('main').className} flex-grow`}>
            <CardBody className="flex flex-col items-center justify-center text-center p-4">
              <div className="bg-default-100 dark:bg-default-50/50 p-3 rounded-full mb-2">
                <CheckCircle2 className={selectedPocket === 'main' ? "text-primary" : "text-default-400"} size={28} />
              </div>
              <span className="font-bold text-lg text-foreground">MAIN</span>
              <span className="text-tiny text-default-400">Airway & Trauma</span>
              <Chip size="sm" variant="flat" className="mt-2">
                {getPocketCount('main')} Items
              </Chip>
            </CardBody>
          </Card>

          {/* Front Aux */}
          <Card {...getCardProps('front_aux')} className={`${getCardProps('front_aux').className} h-24`}>
             <CardBody className="flex flex-col items-start justify-center px-4">
                <span className="font-bold text-small text-foreground">FRONT</span>
                <span className="text-[10px] text-default-400 uppercase">Auxiliary</span>
                <Chip size="sm" variant="flat" className="mt-2">
                  {getPocketCount('front_aux')} Items
                </Chip>
             </CardBody>
          </Card>
        </div>

        {/* Right Side Pocket */}
        <Card {...getCardProps('side_right')} className={`${getCardProps('side_right').className} w-20 flex flex-col justify-center`}>
            <CardBody className="p-2 flex flex-col items-center justify-center gap-2 overflow-visible">
              {/* Removed rotate-180 */}
              <span className="vertical-rl text-xs font-bold text-default-500 tracking-widest whitespace-nowrap uppercase">
                Right
              </span>
              <Circle className="text-default-300" size={24} />
              <Chip size="sm" variant="flat">
                {getPocketCount('side_right')} Items
              </Chip>
           </CardBody>
        </Card>
      </div>

      {/* Reset Link */}
      {selectedPocket !== 'all' && (
        <button 
          onClick={() => onSelectPocket('all')}
          className="text-small text-primary hover:underline mt-2"
        >
          View All Pockets
        </button>
      )}
    </div>
  );
};
