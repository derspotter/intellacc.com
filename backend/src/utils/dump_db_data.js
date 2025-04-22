// backend/src/utils/dump_db_data.js
const db = require('../db');

const tables = [
    'users',
    'posts',
    'topics',
    'events',
    'user_visibility_score',
    'predictions',
    'follows',
    'assigned_predictions',
    'bets',
    'likes'
];

async function dumpDatabaseData() {
    console.log('--- Dumping Database Data ---');
    try {
        for (const table of tables) {
            console.log(`\n--- Table: ${table} ---`);
            try {
                let query;
                if (table === 'predictions') {
                    // Join predictions with users to show username
                    query = `
                        SELECT
                            p.id,
                            p.user_id,
                            u.username,
                            p.event_id,
                            p.event,
                            p.prediction_value,
                            p.confidence,
                            p.created_at,
                            p.resolved_at,
                            p.outcome
                        FROM predictions p
                        JOIN users u ON p.user_id = u.id;
                    `;
                } else {
                    query = `SELECT * FROM ${table};`;
                }

                const result = await db.query(query);
                if (result.rows.length > 0) {
                    console.table(result.rows);
                } else {
                    console.log(`No data found in table ${table}.`);
                }
            } catch (tableError) {
                console.error(`Error fetching data from table ${table}:`, tableError.message);
            }
        }
        console.log('\n--- Database Dump Complete ---');
    } catch (error) {
        console.error('Error connecting to database or dumping data:', error.message);
    } finally {
        // Ensure the pool is ended after all queries are done
        const pool = db.getPool();
        if (pool) {
            await pool.end();
            console.log('Database connection pool closed.');
        }
    }
}

dumpDatabaseData();