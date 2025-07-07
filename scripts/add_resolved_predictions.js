#!/usr/bin/env node

/**
 * Add Resolved Predictions Script
 * 
 * Creates additional resolved events and predictions to properly test the reputation system.
 * This supplements the existing Metaculus data with synthetic resolved predictions.
 */

const { Client } = require('pg');

// Database configuration - use Docker network hostname
const dbConfig = {
  user: 'intellacc_user',
  host: 'db',
  database: 'intellaccdb',
  password: 'supersecretpassword',
  port: 5432,
};

// Resolved event templates
const resolvedEventTemplates = [
  'Will Bitcoin reach $50,000 by end of 2023?',
  'Will the Lakers make the playoffs in 2023?',
  'Will ChatGPT reach 100M users by March 2023?',
  'Will inflation drop below 5% by end of 2023?',
  'Will Tesla stock exceed $200 by end of 2023?',
  'Will Twitter be acquired by end of 2022?',
  'Will Queen Elizabeth II celebrate her Platinum Jubilee?',
  'Will the World Cup 2022 be held in Qatar?',
  'Will Apple release VR headset by end of 2022?',
  'Will Russia invade Ukraine in 2022?',
  'Will COVID-19 vaccines be available by end of 2021?',
  'Will Trump run for president in 2024?',
  'Will Elon Musk buy Twitter?',
  'Will FTX exchange remain solvent through 2022?',
  'Will China end zero-COVID policy by end of 2022?',
  'Will Netflix subscriber count drop in 2022?',
  'Will Meta stock drop below $100 in 2022?',
  'Will gas prices exceed $5/gallon in 2022?',
  'Will Kanye West buy Twitter?',
  'Will Joe Biden remain president through 2023?',
  'Will cryptocurrency market cap exceed $3T in 2021?',
  'Will GameStop stock reach $300 in 2021?',
  'Will Dogecoin reach $1 by end of 2021?',
  'Will Olympics 2021 be held in Tokyo?',
  'Will Brexit deal be finalized by end of 2020?',
  'Will PS5 be released in 2020?',
  'Will iPhone 12 support 5G?',
  'Will TikTok be banned in the US in 2020?',
  'Will Formula 1 season complete in 2020?',
  'Will NBA season finish in 2020?'
];

// Known outcomes for these events (based on actual history)
const eventOutcomes = [
  { outcome: 'yes', resolved: true },   // Bitcoin did reach $50k
  { outcome: 'no', resolved: true },    // Lakers missed playoffs
  { outcome: 'yes', resolved: true },   // ChatGPT reached 100M users
  { outcome: 'yes', resolved: true },   // Inflation did drop
  { outcome: 'no', resolved: true },    // Tesla didn't exceed $200
  { outcome: 'yes', resolved: true },   // Twitter was acquired by Musk
  { outcome: 'yes', resolved: true },   // Queen had Platinum Jubilee
  { outcome: 'yes', resolved: true },   // World Cup was in Qatar
  { outcome: 'no', resolved: true },    // Apple didn't release VR in 2022
  { outcome: 'yes', resolved: true },   // Russia did invade Ukraine
  { outcome: 'yes', resolved: true },   // COVID vaccines were available
  { outcome: 'yes', resolved: true },   // Trump is running
  { outcome: 'yes', resolved: true },   // Musk bought Twitter
  { outcome: 'no', resolved: true },    // FTX collapsed
  { outcome: 'yes', resolved: true },   // China ended zero-COVID
  { outcome: 'yes', resolved: true },   // Netflix lost subscribers
  { outcome: 'yes', resolved: true },   // Meta stock dropped
  { outcome: 'yes', resolved: true },   // Gas prices exceeded $5
  { outcome: 'no', resolved: true },    // Kanye didn't buy Twitter
  { outcome: 'yes', resolved: true },   // Biden remained president
  { outcome: 'yes', resolved: true },   // Crypto exceeded $3T
  { outcome: 'yes', resolved: true },   // GameStop reached $300
  { outcome: 'no', resolved: true },    // Dogecoin didn't reach $1
  { outcome: 'yes', resolved: true },   // Olympics were held
  { outcome: 'yes', resolved: true },   // Brexit deal finalized
  { outcome: 'yes', resolved: true },   // PS5 was released
  { outcome: 'yes', resolved: true },   // iPhone 12 had 5G
  { outcome: 'no', resolved: true },    // TikTok wasn't banned
  { outcome: 'yes', resolved: true },   // F1 season completed
  { outcome: 'yes', resolved: true }    // NBA season finished
];

// Utility functions
function random(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max, decimals = 2) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

// Generate realistic prediction confidence based on actual outcome
function generateRealisticPrediction(actualOutcome, eventTitle) {
  // Some events were more predictable than others
  const predictableEvents = [
    'Olympics 2021', 'PS5', 'iPhone 12', 'Brexit', 'COVID-19 vaccines'
  ];
  
  const controversialEvents = [
    'Bitcoin', 'Tesla', 'GameStop', 'Dogecoin', 'Russia', 'Twitter'
  ];
  
  const isPredicatable = predictableEvents.some(keyword => eventTitle.includes(keyword));
  const isControversial = controversialEvents.some(keyword => eventTitle.includes(keyword));
  
  let baseAccuracy, confidenceRange;
  
  if (isPredicatable) {
    // High accuracy for predictable events
    baseAccuracy = 0.75;
    confidenceRange = [70, 95];
  } else if (isControversial) {
    // Lower accuracy for controversial events
    baseAccuracy = 0.55;
    confidenceRange = [55, 85];
  } else {
    // Medium accuracy for regular events
    baseAccuracy = 0.65;
    confidenceRange = [60, 80];
  }
  
  const isCorrect = Math.random() < baseAccuracy;
  const predictedOutcome = isCorrect ? actualOutcome : (actualOutcome === 'yes' ? 'no' : 'yes');
  
  // Confidence correlates with correctness (overconfidence bias)
  const confidence = isCorrect ? 
    randomInt(confidenceRange[0], confidenceRange[1]) :
    randomInt(confidenceRange[0] - 10, confidenceRange[1] - 20);
  
  return {
    prediction_value: predictedOutcome,
    confidence: Math.max(50, Math.min(95, confidence)),
    outcome: isCorrect ? 'correct' : 'incorrect'
  };
}

async function addResolvedPredictions() {
  const client = new Client(dbConfig);
  
  try {
    await client.connect();
    console.log('Connected to database');
    
    // Get all users
    const usersResult = await client.query('SELECT id FROM users WHERE id > 3');
    const userIds = usersResult.rows.map(row => row.id);
    
    console.log(`Creating ${resolvedEventTemplates.length} resolved events...`);
    
    const createdEvents = [];
    
    // Create resolved events
    for (let i = 0; i < resolvedEventTemplates.length; i++) {
      const title = resolvedEventTemplates[i];
      const outcomeData = eventOutcomes[i];
      const details = `Historical prediction market: ${title}`;
      
      // Events from the past 2 years
      const createdAt = randomDate(new Date(2021, 0, 1), new Date(2023, 6, 1));
      const closingDate = randomDate(createdAt, new Date(2023, 11, 31));
      
      const result = await client.query(
        `INSERT INTO events (title, details, event_type, category, created_at, closing_date, outcome) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          title, 
          details, 
          'binary', 
          'historical', 
          createdAt, 
          closingDate, 
          outcomeData.outcome
        ]
      );
      
      createdEvents.push({
        id: result.rows[0].id,
        title,
        outcome: outcomeData.outcome,
        created_at: createdAt,
        closing_date: closingDate
      });
    }
    
    console.log('Generating realistic predictions for resolved events...');
    let predictionCount = 0;
    
    // Generate predictions for each resolved event
    for (const event of createdEvents) {
      // Each event gets 15-40 predictions
      const numPredictions = randomInt(15, 40);
      
      for (let i = 0; i < numPredictions; i++) {
        const userId = random(userIds);
        
        // Generate realistic prediction
        const prediction = generateRealisticPrediction(event.outcome, event.title);
        
        // Prediction made before event closing
        const predictionDate = randomDate(event.created_at, event.closing_date);
        const resolvedDate = randomDate(event.closing_date, new Date());
        
        // Calculate log loss for resolved prediction
        const prob = prediction.confidence / 100;
        const rawLogLoss = prediction.outcome === 'correct' ? 
          -Math.log(prob) : 
          -Math.log(1 - prob);
        
        try {
          await client.query(
            `INSERT INTO predictions (
              user_id, event_id, event, prediction_value, confidence, 
              created_at, resolved_at, outcome, prediction_type, raw_log_loss
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              userId, event.id, event.title, prediction.prediction_value, prediction.confidence,
              predictionDate, resolvedDate, prediction.outcome, 'binary', rawLogLoss
            ]
          );
          predictionCount++;
        } catch (err) {
          // Skip duplicates or conflicts
        }
      }
    }
    
    console.log('Recalculating user reputation scores...');
    
    // Recalculate reputation scores with new data
    for (const userId of userIds) {
      const userPredictions = await client.query(
        'SELECT * FROM predictions WHERE user_id = $1 AND outcome != $2',
        [userId, 'pending']
      );
      
      if (userPredictions.rows.length > 0) {
        const correctPredictions = userPredictions.rows.filter(p => p.outcome === 'correct').length;
        const totalPredictions = userPredictions.rows.length;
        
        // Calculate average log loss
        const logLosses = userPredictions.rows
          .filter(p => p.raw_log_loss !== null)
          .map(p => parseFloat(p.raw_log_loss));
        
        if (logLosses.length > 0) {
          const avgLogLoss = logLosses.reduce((a, b) => a + b, 0) / logLosses.length;
          
          // Time-weighted score (simplified)
          const timeWeightedScore = -avgLogLoss;
          
          // Peer bonus (based on prediction count and accuracy)
          const accuracyBonus = (correctPredictions / totalPredictions - 0.5) * 0.2;
          const volumeBonus = Math.min(totalPredictions * 0.005, 0.3);
          const peerBonus = accuracyBonus + volumeBonus;
          
          // Reputation points using tanh formula: Rep = 10 * tanh(-(Acc + R)) + 1
          const repInput = -(timeWeightedScore + peerBonus);
          const repPoints = Math.max(1.0, Math.min(11.0, 10 * Math.tanh(repInput) + 1));
          
          // Update existing reputation record
          await client.query(
            `UPDATE user_reputation 
             SET rep_points = $1, time_weighted_score = $2, peer_bonus = $3, updated_at = $4
             WHERE user_id = $5`,
            [repPoints, timeWeightedScore, peerBonus, new Date(), userId]
          );
        }
      }
    }
    
    // Final statistics
    const totalPredictionsResult = await client.query('SELECT COUNT(*) FROM predictions');
    const resolvedPredictionsResult = await client.query("SELECT COUNT(*) FROM predictions WHERE outcome != 'pending'");
    const totalEventsResult = await client.query('SELECT COUNT(*) FROM events');
    const resolvedEventsResult = await client.query("SELECT COUNT(*) FROM events WHERE outcome IS NOT NULL AND outcome != 'pending'");
    
    console.log('\n🎉 Resolved predictions added successfully!');
    console.log('📊 Updated database statistics:');
    console.log(`   📅 Total events: ${totalEventsResult.rows[0].count}`);
    console.log(`   ✅ Resolved events: ${resolvedEventsResult.rows[0].count}`);
    console.log(`   🎯 Total predictions: ${totalPredictionsResult.rows[0].count}`);
    console.log(`   ✅ Resolved predictions: ${resolvedPredictionsResult.rows[0].count}`);
    console.log(`   🆕 Added predictions: ${predictionCount}`);
    console.log('\n✅ Reputation system now has sufficient resolved data for testing!');
    
  } catch (error) {
    console.error('Error adding resolved predictions:', error);
    throw error;
  } finally {
    await client.end();
  }
}

// Run the script
if (require.main === module) {
  addResolvedPredictions()
    .then(() => {
      console.log('Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { addResolvedPredictions };