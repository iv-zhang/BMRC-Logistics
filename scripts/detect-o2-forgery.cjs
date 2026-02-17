/**
 * Stress Test: O₂ PSI Forgery Detection
 * 
 * This script tests for suspicious O₂ PSI patterns that may indicate:
 * 1. Identical readings across multiple checkouts (copy-paste fraud)
 * 2. Non-physical PSI jumps (increases between checkouts)
 * 3. Implausible leak rates
 * 4. Round number bias (e.g., always 2000 PSI)
 * 
 * Usage:
 *   node scripts/detect-o2-forgery.cjs [--statpack-id=<id>] [--days=<num>]
 * 
 * Examples:
 *   node scripts/detect-o2-forgery.cjs
 *   node scripts/detect-o2-forgery.cjs --statpack-id=statpack-primary-1 --days=30
 */

const admin = require('firebase-admin');
const { readFileSync } = require('fs');

// Parse command line arguments
const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.replace('--', '').split('=');
  acc[key] = value;
  return acc;
}, {});

const STATPACK_ID = args['statpack-id'] || null;
const DAYS_LOOKBACK = parseInt(args['days'] || '30');

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
 * Fetch O₂ PSI history for analysis
 */
async function fetchO2History(statpackId = null, daysBack = 30) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);
  
  let query = db.collection('statpack_logs')
    .where('action', '==', 'checkout')
    .where('clientTimestamp', '>=', cutoffDate)
    .orderBy('clientTimestamp', 'asc');
  
  if (statpackId) {
    query = query.where('statpackId', '==', statpackId);
  }
  
  const snapshot = await query.get();
  
  const history = [];
  
  snapshot.forEach(doc => {
    const log = doc.data();
    
    // Extract O₂ readings from checkEntries
    (log.checkEntries || []).forEach(entry => {
      if (entry.assetCheckResult?.oxygenPsi !== undefined) {
        history.push({
          logId: doc.id,
          statpackId: log.statpackId,
          statpackName: log.statpackName,
          itemId: entry.itemId,
          itemName: entry.itemName,
          timestamp: log.clientTimestamp?.toDate?.() || log.clientTimestamp,
          userId: log.userId,
          userName: log.userName,
          oxygenPsi: entry.assetCheckResult.oxygenPsi,
        });
      }
    });
  });
  
  return history;
}

/**
 * Detect identical readings (copy-paste fraud)
 */
function detectIdenticalReadings(history) {
  const suspiciousPatterns = [];
  
  // Group by itemId (same oxygen tank)
  const byItem = history.reduce((acc, reading) => {
    const key = `${reading.statpackId}-${reading.itemId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(reading);
    return acc;
  }, {});
  
  Object.entries(byItem).forEach(([key, readings]) => {
    if (readings.length < 3) return;
    
    // Check for sequences of identical readings
    for (let i = 0; i < readings.length - 2; i++) {
      const current = readings[i];
      const next = readings[i + 1];
      const nextNext = readings[i + 2];
      
      if (current.oxygenPsi === next.oxygenPsi && next.oxygenPsi === nextNext.oxygenPsi) {
        // Three identical readings in a row
        const timespanHours = (nextNext.timestamp - current.timestamp) / (1000 * 60 * 60);
        
        if (timespanHours > 1) {
          suspiciousPatterns.push({
            type: 'IDENTICAL_READINGS',
            severity: 'HIGH',
            itemId: current.itemId,
            itemName: current.itemName,
            statpackId: current.statpackId,
            psi: current.oxygenPsi,
            occurrences: 3,
            timespan: `${timespanHours.toFixed(1)} hours`,
            users: [current.userName, next.userName, nextNext.userName],
            message: `${current.itemName} showed identical PSI (${current.oxygenPsi}) across 3+ checkouts over ${timespanHours.toFixed(1)} hours`,
          });
        }
      }
    }
  });
  
  return suspiciousPatterns;
}

/**
 * Detect non-physical PSI increases
 */
function detectPsiIncreases(history) {
  const suspiciousPatterns = [];
  
  // Group by itemId
  const byItem = history.reduce((acc, reading) => {
    const key = `${reading.statpackId}-${reading.itemId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(reading);
    return acc;
  }, {});
  
  Object.entries(byItem).forEach(([key, readings]) => {
    for (let i = 0; i < readings.length - 1; i++) {
      const current = readings[i];
      const next = readings[i + 1];
      
      const psiChange = next.oxygenPsi - current.oxygenPsi;
      
      // O₂ tanks should never increase in PSI without refilling
      // Allow small increases (±25 PSI) for measurement error
      if (psiChange > 25) {
        suspiciousPatterns.push({
          type: 'PSI_INCREASE',
          severity: 'CRITICAL',
          itemId: current.itemId,
          itemName: current.itemName,
          statpackId: current.statpackId,
          fromPsi: current.oxygenPsi,
          toPsi: next.oxygenPsi,
          increase: psiChange,
          fromUser: current.userName,
          toUser: next.userName,
          timeBetween: ((next.timestamp - current.timestamp) / (1000 * 60)).toFixed(0) + ' minutes',
          message: `${current.itemName} PSI increased from ${current.oxygenPsi} to ${next.oxygenPsi} (+${psiChange}) without documented refill`,
        });
      }
    }
  });
  
  return suspiciousPatterns;
}

/**
 * Detect implausible leak rates
 */
function detectImplausibleLeaks(history) {
  const suspiciousPatterns = [];
  
  // Group by itemId
  const byItem = history.reduce((acc, reading) => {
    const key = `${reading.statpackId}-${reading.itemId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(reading);
    return acc;
  }, {});
  
  Object.entries(byItem).forEach(([key, readings]) => {
    for (let i = 0; i < readings.length - 1; i++) {
      const current = readings[i];
      const next = readings[i + 1];
      
      const psiDrop = current.oxygenPsi - next.oxygenPsi;
      const hoursElapsed = (next.timestamp - current.timestamp) / (1000 * 60 * 60);
      
      if (hoursElapsed === 0) continue;
      
      const leakRatePsiPerHour = psiDrop / hoursElapsed;
      
      // Typical O₂ cylinder leak rate: 5-20 PSI/day (0.2-0.8 PSI/hour)
      // Anything over 50 PSI/hour is extremely suspicious
      if (leakRatePsiPerHour > 50) {
        suspiciousPatterns.push({
          type: 'IMPLAUSIBLE_LEAK',
          severity: 'HIGH',
          itemId: current.itemId,
          itemName: current.itemName,
          statpackId: current.statpackId,
          fromPsi: current.oxygenPsi,
          toPsi: next.oxygenPsi,
          drop: psiDrop,
          hoursElapsed: hoursElapsed.toFixed(1),
          leakRate: `${leakRatePsiPerHour.toFixed(1)} PSI/hour`,
          message: `${current.itemName} lost ${psiDrop} PSI in ${hoursElapsed.toFixed(1)} hours (${leakRatePsiPerHour.toFixed(1)} PSI/hour) - typical rate is 0.2-0.8 PSI/hour`,
        });
      }
    }
  });
  
  return suspiciousPatterns;
}

/**
 * Detect round number bias
 */
function detectRoundNumberBias(history) {
  const suspiciousPatterns = [];
  
  // Group by user
  const byUser = history.reduce((acc, reading) => {
    if (!acc[reading.userId]) acc[reading.userId] = [];
    acc[reading.userId].push(reading);
    return acc;
  }, {});
  
  Object.entries(byUser).forEach(([userId, readings]) => {
    if (readings.length < 5) return;
    
    // Count how many are "round" numbers (divisible by 50 or 100)
    const roundNumbers = readings.filter(r => r.oxygenPsi % 50 === 0).length;
    const veryRoundNumbers = readings.filter(r => r.oxygenPsi % 100 === 0).length;
    
    const roundPct = (roundNumbers / readings.length) * 100;
    const veryRoundPct = (veryRoundNumbers / readings.length) * 100;
    
    // Real measurements show ~20% round numbers naturally
    // Over 80% is suspicious
    if (roundPct > 80) {
      suspiciousPatterns.push({
        type: 'ROUND_NUMBER_BIAS',
        severity: 'MEDIUM',
        userId,
        userName: readings[0].userName,
        totalReadings: readings.length,
        roundNumbers,
        roundPct: roundPct.toFixed(0),
        veryRoundPct: veryRoundPct.toFixed(0),
        message: `${readings[0].userName} reports ${roundPct.toFixed(0)}% round numbers (${roundNumbers}/${readings.length}), expected ~20%. Possible estimation instead of measurement.`,
      });
    }
  });
  
  return suspiciousPatterns;
}

/**
 * Generate detailed report
 */
function generateReport(history, patterns) {
  console.log('\n🔍 O₂ PSI FORGERY DETECTION REPORT');
  console.log('='.repeat(70));
  console.log(`Analysis period: Last ${DAYS_LOOKBACK} days`);
  if (STATPACK_ID) {
    console.log(`Statpack filter: ${STATPACK_ID}`);
  }
  console.log(`Total O₂ readings analyzed: ${history.length}`);
  
  const allPatterns = [
    ...patterns.identical,
    ...patterns.increases,
    ...patterns.leaks,
    ...patterns.roundBias,
  ];
  
  if (allPatterns.length === 0) {
    console.log('\n✅ No suspicious patterns detected');
    return;
  }
  
  console.log(`\n⚠️  SUSPICIOUS PATTERNS DETECTED: ${allPatterns.length}`);
  
  // Group by severity
  const critical = allPatterns.filter(p => p.severity === 'CRITICAL');
  const high = allPatterns.filter(p => p.severity === 'HIGH');
  const medium = allPatterns.filter(p => p.severity === 'MEDIUM');
  
  if (critical.length > 0) {
    console.log('\n🚨 CRITICAL ISSUES:');
    critical.forEach(p => {
      console.log(`  [${p.type}] ${p.message}`);
      console.log(`    Details: ${JSON.stringify(p, null, 4).split('\n').slice(1, -1).join('\n    ')}`);
    });
  }
  
  if (high.length > 0) {
    console.log('\n⚠️  HIGH PRIORITY:');
    high.forEach(p => {
      console.log(`  [${p.type}] ${p.message}`);
    });
  }
  
  if (medium.length > 0) {
    console.log('\n📋 MEDIUM PRIORITY:');
    medium.forEach(p => {
      console.log(`  [${p.type}] ${p.message}`);
    });
  }
  
  console.log('\n📊 SUMMARY BY TYPE:');
  console.log(`  Identical readings: ${patterns.identical.length}`);
  console.log(`  PSI increases: ${patterns.increases.length}`);
  console.log(`  Implausible leaks: ${patterns.leaks.length}`);
  console.log(`  Round number bias: ${patterns.roundBias.length}`);
  
  // Recommendations
  console.log('\n💡 RECOMMENDATIONS:');
  if (critical.length > 0) {
    console.log('  - Investigate CRITICAL issues immediately');
    console.log('  - Review training on proper O₂ PSI measurement');
  }
  if (patterns.roundBias.length > 0) {
    console.log('  - Remind users to record actual gauge readings, not estimates');
  }
  if (patterns.increases.length > 0) {
    console.log('  - Verify if tanks were refilled without documentation');
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('🚀 Starting O₂ PSI Forgery Detection...\n');
  
  const history = await fetchO2History(STATPACK_ID, DAYS_LOOKBACK);
  
  console.log(`Fetched ${history.length} O₂ readings`);
  
  if (history.length === 0) {
    console.log('❌ No O₂ readings found in the specified period');
    return;
  }
  
  console.log('Running detection algorithms...');
  
  const patterns = {
    identical: detectIdenticalReadings(history),
    increases: detectPsiIncreases(history),
    leaks: detectImplausibleLeaks(history),
    roundBias: detectRoundNumberBias(history),
  };
  
  generateReport(history, patterns);
  
  console.log('\n✅ Analysis complete');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Analysis failed:', error);
    process.exit(1);
  });
