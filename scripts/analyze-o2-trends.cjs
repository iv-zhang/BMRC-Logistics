/**
 * O₂ PSI Trend Detection & Leak Analytics
 * 
 * This script analyzes O₂ PSI trends over time to:
 * 1. Detect gradual leak patterns (normal vs abnormal)
 * 2. Predict when tanks will need refilling
 * 3. Identify tanks with accelerating leak rates
 * 4. Generate maintenance recommendations
 * 
 * Usage:
 *   node scripts/analyze-o2-trends.cjs [--item-id=<id>] [--days=<num>] [--export=<file>]
 * 
 * Examples:
 *   node scripts/analyze-o2-trends.cjs
 *   node scripts/analyze-o2-trends.cjs --item-id=oxygen-tank-001 --days=60
 *   node scripts/analyze-o2-trends.cjs --export=o2-report.json
 */

const admin = require('firebase-admin');
const { readFileSync, writeFileSync } = require('fs');

// Parse command line arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=');
  acc[key] = value;
  return acc;
}, {});

const ITEM_ID = args['item-id'] || null;
const DAYS_LOOKBACK = parseInt(args['days'] || '90');
const EXPORT_FILE = args['export'] || null;

// Initialize Firebase Admin
try {
  const serviceAccount = JSON.parse(
    readFileSync('./service-account-key.json', 'utf8')
  );
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin:', error.message);
  process.exit(1);
}

const db = admin.firestore();

/**
 * Fetch O₂ PSI time series data
 */
async function fetchO2TimeSeries(itemId = null, daysBack = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);
  
  const query = db.collection('statpack_logs')
    .where('action', '==', 'checkout')
    .where('clientTimestamp', '>=', cutoffDate)
    .orderBy('clientTimestamp', 'asc');
  
  const snapshot = await query.get();
  
  const timeSeries = [];
  
  snapshot.forEach(doc => {
    const log = doc.data();
    
    (log.checkEntries || []).forEach(entry => {
      if (entry.assetCheckResult?.oxygenPsi !== undefined) {
        if (!itemId || entry.itemId === itemId) {
          timeSeries.push({
            itemId: entry.itemId,
            itemName: entry.itemName,
            statpackId: log.statpackId,
            timestamp: log.clientTimestamp?.toDate?.() || log.clientTimestamp,
            oxygenPsi: entry.assetCheckResult.oxygenPsi,
            userId: log.userId,
            userName: log.userName,
          });
        }
      }
    });
  });
  
  return timeSeries;
}

/**
 * Calculate leak rate using linear regression
 */
function calculateLeakRate(dataPoints) {
  if (dataPoints.length < 2) return null;
  
  // Convert timestamps to hours since first reading
  const baseTime = dataPoints[0].timestamp.getTime();
  const points = dataPoints.map(p => ({
    x: (p.timestamp.getTime() - baseTime) / (1000 * 60 * 60), // hours
    y: p.oxygenPsi,
  }));
  
  // Linear regression: y = mx + b
  const n = points.length;
  const sumX = points.reduce((sum, p) => sum + p.x, 0);
  const sumY = points.reduce((sum, p) => sum + p.y, 0);
  const sumXY = points.reduce((sum, p) => sum + p.x * p.y, 0);
  const sumX2 = points.reduce((sum, p) => sum + p.x * p.x, 0);
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  // Calculate R² (goodness of fit)
  const yMean = sumY / n;
  const ssTotal = points.reduce((sum, p) => sum + Math.pow(p.y - yMean, 2), 0);
  const ssResidual = points.reduce((sum, p) => {
    const predicted = slope * p.x + intercept;
    return sum + Math.pow(p.y - predicted, 2);
  }, 0);
  const r2 = 1 - (ssResidual / ssTotal);
  
  return {
    leakRatePsiPerHour: -slope, // Negative slope = leak
    leakRatePsiPerDay: -slope * 24,
    intercept,
    r2,
    dataPoints: n,
  };
}

/**
 * Predict when tank will reach minimum PSI
 */
function predictRefillDate(currentPsi, leakRate, minPsi = 1800) {
  if (leakRate.leakRatePsiPerHour <= 0) {
    return null; // No leak or increasing (error)
  }
  
  const psiRemaining = currentPsi - minPsi;
  const hoursRemaining = psiRemaining / leakRate.leakRatePsiPerHour;
  
  if (hoursRemaining <= 0) {
    return new Date(); // Already below minimum
  }
  
  const refillDate = new Date();
  refillDate.setTime(refillDate.getTime() + hoursRemaining * 60 * 60 * 1000);
  
  return refillDate;
}

/**
 * Analyze trends for a single tank
 */
function analyzeTankTrends(itemId, readings) {
  if (readings.length < 2) {
    return {
      itemId,
      itemName: readings[0]?.itemName || 'Unknown',
      status: 'INSUFFICIENT_DATA',
      message: 'Need at least 2 readings for trend analysis',
    };
  }
  
  const sortedReadings = readings.sort((a, b) => a.timestamp - b.timestamp);
  const leakRate = calculateLeakRate(sortedReadings);
  
  if (!leakRate) {
    return {
      itemId,
      itemName: sortedReadings[0].itemName,
      status: 'ERROR',
      message: 'Failed to calculate leak rate',
    };
  }
  
  const latestReading = sortedReadings[sortedReadings.length - 1];
  const firstReading = sortedReadings[0];
  const currentPsi = latestReading.oxygenPsi;
  
  // Classify leak rate
  let leakStatus;
  let severity;
  
  if (leakRate.leakRatePsiPerDay < 0.5) {
    leakStatus = 'EXCELLENT';
    severity = 'low';
  } else if (leakRate.leakRatePsiPerDay < 2) {
    leakStatus = 'NORMAL';
    severity = 'low';
  } else if (leakRate.leakRatePsiPerDay < 10) {
    leakStatus = 'ELEVATED';
    severity = 'medium';
  } else if (leakRate.leakRatePsiPerDay < 50) {
    leakStatus = 'HIGH';
    severity = 'high';
  } else {
    leakStatus = 'CRITICAL';
    severity = 'critical';
  }
  
  const refillDate = predictRefillDate(currentPsi, leakRate);
  const daysUntilRefill = refillDate ? 
    Math.round((refillDate - new Date()) / (1000 * 60 * 60 * 24)) : null;
  
  return {
    itemId,
    itemName: latestReading.itemName,
    statpackId: latestReading.statpackId,
    status: leakStatus,
    severity,
    currentPsi,
    leakRatePsiPerDay: leakRate.leakRatePsiPerDay.toFixed(2),
    leakRatePsiPerHour: leakRate.leakRatePsiPerHour.toFixed(3),
    trendQuality: leakRate.r2.toFixed(3),
    readingCount: leakRate.dataPoints,
    firstReadingDate: firstReading.timestamp.toISOString().split('T')[0],
    latestReadingDate: latestReading.timestamp.toISOString().split('T')[0],
    daysUntilRefill,
    predictedRefillDate: refillDate?.toISOString().split('T')[0] || 'N/A',
    recommendations: generateRecommendations(leakStatus, currentPsi, daysUntilRefill),
  };
}

/**
 * Generate maintenance recommendations
 */
function generateRecommendations(status, currentPsi, daysUntilRefill) {
  const recommendations = [];
  
  if (currentPsi < 1800) {
    recommendations.push('🚨 IMMEDIATE ACTION: PSI below minimum threshold - refill or replace now');
  } else if (daysUntilRefill !== null && daysUntilRefill < 7) {
    recommendations.push('⚠️ Refill needed within 7 days');
  } else if (daysUntilRefill !== null && daysUntilRefill < 14) {
    recommendations.push('📅 Schedule refill within 2 weeks');
  }
  
  if (status === 'CRITICAL') {
    recommendations.push('🔧 CRITICAL: Abnormal leak rate detected - inspect valve and connections immediately');
  } else if (status === 'HIGH') {
    recommendations.push('🔍 HIGH: Elevated leak rate - schedule maintenance inspection');
  } else if (status === 'ELEVATED') {
    recommendations.push('📋 Monitor closely - leak rate higher than normal');
  } else if (status === 'EXCELLENT') {
    recommendations.push('✅ Tank in excellent condition - no action needed');
  }
  
  return recommendations;
}

/**
 * Generate summary report
 */
function generateReport(analyses) {
  console.log('\n📊 O₂ PSI TREND ANALYSIS REPORT');
  console.log('='.repeat(70));
  console.log(`Analysis period: Last ${DAYS_LOOKBACK} days`);
  console.log(`Total tanks analyzed: ${analyses.length}`);
  
  // Group by severity
  const critical = analyses.filter(a => a.severity === 'critical');
  const high = analyses.filter(a => a.severity === 'high');
  const medium = analyses.filter(a => a.severity === 'medium');
  const low = analyses.filter(a => a.severity === 'low');
  
  console.log('\n🚨 SEVERITY BREAKDOWN:');
  console.log(`  Critical: ${critical.length}`);
  console.log(`  High: ${high.length}`);
  console.log(`  Medium: ${medium.length}`);
  console.log(`  Low/Normal: ${low.length}`);
  
  if (critical.length > 0) {
    console.log('\n🚨 CRITICAL ISSUES:');
    critical.forEach(a => {
      console.log(`\n  ${a.itemName} (${a.itemId})`);
      console.log(`    Current PSI: ${a.currentPsi}`);
      console.log(`    Leak rate: ${a.leakRatePsiPerDay} PSI/day`);
      console.log(`    Days until refill: ${a.daysUntilRefill || 'N/A'}`);
      a.recommendations.forEach(r => console.log(`    ${r}`));
    });
  }
  
  if (high.length > 0) {
    console.log('\n⚠️  HIGH PRIORITY:');
    high.forEach(a => {
      console.log(`\n  ${a.itemName} (${a.itemId})`);
      console.log(`    Leak rate: ${a.leakRatePsiPerDay} PSI/day`);
      console.log(`    Days until refill: ${a.daysUntilRefill || 'N/A'}`);
    });
  }
  
  // Refill schedule
  const needsRefill = analyses
    .filter(a => a.daysUntilRefill !== null && a.daysUntilRefill < 30)
    .sort((a, b) => a.daysUntilRefill - b.daysUntilRefill);
  
  if (needsRefill.length > 0) {
    console.log('\n📅 REFILL SCHEDULE (Next 30 days):');
    needsRefill.forEach(a => {
      const urgency = a.daysUntilRefill < 7 ? '🚨' : 
                      a.daysUntilRefill < 14 ? '⚠️' : '📋';
      console.log(`  ${urgency} ${a.itemName}: ${a.daysUntilRefill} days (${a.predictedRefillDate})`);
    });
  }
  
  // Statistics
  const avgLeakRate = analyses
    .filter(a => a.severity)
    .reduce((sum, a) => sum + parseFloat(a.leakRatePsiPerDay), 0) / analyses.length;
  
  console.log('\n📈 FLEET STATISTICS:');
  console.log(`  Average leak rate: ${avgLeakRate.toFixed(2)} PSI/day`);
  console.log(`  Tanks below minimum: ${analyses.filter(a => a.currentPsi < 1800).length}`);
  console.log(`  Tanks needing refill (30 days): ${needsRefill.length}`);
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Starting O₂ PSI Trend Analysis...\n');
  
  const timeSeries = await fetchO2TimeSeries(ITEM_ID, DAYS_LOOKBACK);
  
  console.log(`Fetched ${timeSeries.length} O₂ readings`);
  
  if (timeSeries.length === 0) {
    console.log('❌ No O₂ readings found in the specified period');
    return;
  }
  
  // Group by itemId
  const byItem = timeSeries.reduce((acc, reading) => {
    if (!acc[reading.itemId]) acc[reading.itemId] = [];
    acc[reading.itemId].push(reading);
    return acc;
  }, {});
  
  console.log(`Analyzing trends for ${Object.keys(byItem).length} oxygen tanks...\n`);
  
  const analyses = Object.entries(byItem).map(([itemId, readings]) => 
    analyzeTankTrends(itemId, readings)
  );
  
  generateReport(analyses);
  
  // Export if requested
  if (EXPORT_FILE) {
    const exportData = {
      generatedAt: new Date().toISOString(),
      periodDays: DAYS_LOOKBACK,
      totalReadings: timeSeries.length,
      analyses,
    };
    
    writeFileSync(EXPORT_FILE, JSON.stringify(exportData, null, 2));
    console.log(`\n✅ Exported detailed report to ${EXPORT_FILE}`);
  }
  
  console.log('\n✅ Analysis complete');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Analysis failed:', error);
    process.exit(1);
  });
