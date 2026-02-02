import React, { useState } from 'react';
import { Card, CardBody, Chip, Tooltip } from '@heroui/react';
import { Statpack, StatpackPocket } from '@/app/types';
import { CheckCircle2, Circle, Wind } from 'lucide-react';

interface BagVisualizerProps {
  statpack: Statpack;
  selectedPocket: StatpackPocket | 'all';
  onSelectPocket: (pocket: StatpackPocket | 'all') => void;
  completedPockets?: Set<StatpackPocket>;
}

// --- DROP ZONE COMPONENT (declared outside render) ---
const DropZone: React.FC<{
  children?: React.ReactNode;
  side?: 'left' | 'right';
  isDragging: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}> = ({ children, side, isDragging, onDragOver, onDrop }) => {
  const isOccupied = children !== undefined;
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={`
                flex-1 flex items-center justify-center h-full rounded-xl transition-all
                ${isDragging && !isOccupied ? 'bg-blue-50 dark:bg-blue-900/30 border-2 border-dashed border-blue-300' : ''}
                ${isDragging && isOccupied ? 'opacity-50' : 'opacity-100'}
            `}
    >
      {isDragging && !isOccupied && <span className="text-[10px] text-blue-400 font-semibold pointer-events-none">Drop</span>}
      {children}
    </div>
  );
};

export const BagVisualizer: React.FC<BagVisualizerProps> = ({ 
  statpack, 
  selectedPocket, 
  onSelectPocket,
  completedPockets
}) => {

  // --- STATE FOR O2 TANK POSITION ---
  const [tankSide, setTankSide] = useState<'left' | 'right'>('right');
  const [isDragging, setIsDragging] = useState(false);

  // Identify O2 Item
  const o2Item = statpack.contents?.find(i => i.itemDetails?.isOxygen);

  const getPocketCount = (pocket: StatpackPocket) => {
    return statpack.contents?.filter(i => i.pocket === pocket).length || 0;
  };

  const getCardProps = (pocket: StatpackPocket) => {
    const isSelected = selectedPocket === pocket;
    const isCompleted = !!completedPockets && completedPockets.has(pocket);
    const completedClass = isCompleted ? 'border-green-400 bg-green-50 dark:bg-green-900/20' : '';
    return {
      isPressable: true,
      onPress: () => onSelectPocket(pocket),
      style: { touchAction: 'pan-y' },
      className: `transition-all duration-200 border-2 shadow-sm hover:shadow-md ${
        isSelected 
          ? 'border-primary bg-primary-50 dark:bg-primary-900/20 scale-[1.02] z-10' 
          : `border-default-200 bg-white dark:bg-slate-800 hover:border-primary-200 ${completedClass}`
      }`
    };
  };

  // --- DRAG AND DROP HANDLERS ---
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('type', 'tank');
    e.dataTransfer.effectAllowed = 'move';
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault(); 
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (side: 'left' | 'right') => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation(); 
    const type = e.dataTransfer.getData('type');
    if (type === 'tank') {
        setTankSide(side);
    }
    setIsDragging(false);
  };

  // --- BOX STYLE O2 TANK ---
  const renderTankBox = () => {
    if (!o2Item || !o2Item.itemDetails) return null;
    
    const { oxygenPsi, maxOxygenPsi } = o2Item.itemDetails;
    const max = maxOxygenPsi || 2000;
    const current = oxygenPsi || 0;
    const pct = Math.min(100, Math.max(0, (current / max) * 100));

    // Determine color based on level
    let fillColor = "bg-green-500/20";
    let textColor = "text-green-700 dark:text-green-300";
    let borderColor = "border-green-300 dark:border-green-700";

    if (pct < 25) {
        fillColor = "bg-red-500/20";
        textColor = "text-red-700 dark:text-red-300";
        borderColor = "border-red-300 dark:border-red-700";
    } else if (pct < 50) {
        fillColor = "bg-yellow-500/20";
        textColor = "text-yellow-700 dark:text-yellow-300";
        borderColor = "border-yellow-300 dark:border-yellow-700";
    }

    return (
        <div 
            draggable 
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            className="w-full h-full p-1 cursor-grab active:cursor-grabbing"
        >
             <Tooltip content={`O2 Level: ${current} / ${max} PSI`} showArrow color="primary">
                <Card style={{ touchAction: 'pan-y' }} className={`w-full h-full border-2 ${borderColor} shadow-sm overflow-hidden relative group`}>
                     {/* Background Level Indicator */}
                     <div 
                        className={`absolute bottom-0 w-full transition-all duration-500 ${fillColor}`}
                        style={{ height: `${pct}%` }}
                     />
                     
                     {/* Content Overlay */}
                     <CardBody className="p-0 flex flex-col items-center justify-center relative z-10 h-full gap-1">
                        <Wind size={14} className={textColor} />
                        <div className="flex flex-col items-center leading-tight">
                            <span className={`text-[9px] font-bold uppercase tracking-wider ${textColor}`}>Oxygen</span>
                            <span className={`text-[10px] font-extrabold ${textColor}`}>{current} PSI</span>
                        </div>
                     </CardBody>
                </Card>
             </Tooltip>
        </div>
    );
  };

  // --- DROP ZONE COMPONENT ---
    // NOTE: DropZone component moved outside render to satisfy static-components rule.

  return (
    <div className="flex flex-col items-center gap-3 py-2 w-full select-none max-w-sm mx-auto">
      
      {/* 3-Column Bag Layout (Skinnier) */}
      <div className="flex flex-row items-stretch justify-center gap-2 h-56 w-full">
        
        {/* Left Side Pocket */}
        <Card {...getCardProps('side_left')} className={`${getCardProps('side_left').className} w-14 flex flex-col justify-center`}>
                <CardBody className="p-1 flex flex-col items-center justify-center gap-1 overflow-hidden">
                  <span className="writing-vertical-rl rotate-180 text-[10px] font-bold text-default-400 uppercase tracking-wider whitespace-nowrap">
                    Left Side
                  </span>
                  {completedPockets && completedPockets.has('side_left') ? <CheckCircle2 className="text-green-500" size={16} /> : <Circle className="text-default-300" size={16} />}
                  <Chip size="sm" variant="flat" color="primary" className="h-5 text-[10px] px-1">
                    {getPocketCount('side_left')}
                  </Chip>
                </CardBody>
        </Card>

        {/* Center: Main & Front */}
        <div className="flex flex-col gap-2 flex-1 min-w-[160px]">
           
           {/* MAIN POCKET */}
           <Card {...getCardProps('main')} className={`${getCardProps('main').className} flex-1`}>
              <CardBody className="relative p-1 overflow-hidden">
                 <div className="absolute top-1 left-2 text-[10px] font-bold text-default-400 uppercase tracking-wider z-0">
                    Main
                 </div>
                 
                 {/* Main Container Layout */}
                 <div className="flex items-center justify-between h-full w-full pt-5 pb-1 px-1 gap-1">
                    
                    {/* Left Drop Zone */}
                    <div className="w-14 h-full">
                      <DropZone side="left" isDragging={isDragging} onDragOver={handleDragOver} onDrop={handleDrop('left')}>
                        {o2Item && tankSide === 'left' && renderTankBox()}
                      </DropZone>
                    </div>

                    {/* Center Info Zone */}
                    <div className="flex flex-col items-center justify-center z-10 flex-1">
                        {completedPockets && completedPockets.has('main') ? <CheckCircle2 className="text-green-500 mb-1" size={24} /> : <CheckCircle2 className="text-default-300 mb-1" size={24} />}
                        <Chip size="sm" variant="shadow" color={selectedPocket === 'main' ? "primary" : "default"} className="h-6 px-1">
                            {getPocketCount('main')}
                        </Chip>
                    </div>

                    {/* Right Drop Zone */}
                      <div className="w-14 h-full">
                         <DropZone side="right" isDragging={isDragging} onDragOver={handleDragOver} onDrop={handleDrop('right')}>
                           {o2Item && tankSide === 'right' && renderTankBox()}
                         </DropZone>
                      </div>
                 </div>

              </CardBody>
           </Card>

           {/* FRONT AUX POCKET */}
           <Card {...getCardProps('front_aux')} className={`${getCardProps('front_aux').className} h-14`}>
             <CardBody className="flex flex-row items-center justify-between px-3 py-1">
                <div className="flex flex-col justify-center">
                    <span className="font-bold text-xs">FRONT</span>
                    <span className="text-[9px] text-default-400 uppercase">Auxiliary</span>
                </div>
                <Chip size="sm" variant="flat" className="h-5 text-[10px] px-1">
                  {getPocketCount('front_aux')}
                </Chip>
                {completedPockets && completedPockets.has('front_aux') && <CheckCircle2 className="text-green-500 ml-2" size={14} />}
             </CardBody>
           </Card>
        </div>

        {/* Right Side Pocket */}
        <Card {...getCardProps('side_right')} className={`${getCardProps('side_right').className} w-14 flex flex-col justify-center`}>
            <CardBody className="p-1 flex flex-col items-center justify-center gap-1 overflow-hidden">
              <span className="writing-vertical-rl rotate-180 text-[10px] font-bold text-default-400 uppercase tracking-wider whitespace-nowrap">
                Right Side
              </span>
              {completedPockets && completedPockets.has('side_right') ? <CheckCircle2 className="text-green-500" size={16} /> : <Circle className="text-default-300" size={16} />}
              <Chip size="sm" variant="flat" color="primary" className="h-5 text-[10px] px-1">
                {getPocketCount('side_right')}
              </Chip>
           </CardBody>
        </Card>
      </div>

      {/* Reset Link */}
      {selectedPocket !== 'all' && (
        <button 
          onClick={() => onSelectPocket('all')}
          className="text-xs text-primary hover:underline cursor-pointer font-medium mt-1"
        >
          View Full Contents
        </button>
      )}

      <style jsx global>{`
        .writing-vertical-rl {
          writing-mode: vertical-rl;
        }
      `}</style>
    </div>
  );
};