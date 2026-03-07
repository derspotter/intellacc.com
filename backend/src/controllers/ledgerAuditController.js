// backend/src/controllers/ledgerAuditController.js
const ledgerAuditService = require('../services/ledgerAuditService');

exports.runAuditCron = async (req, res) => {
  try {
    const results = await ledgerAuditService.runFullAudit();
    
    // Determine overall health
    const isHealthy = 
        results.sqlAuditIssuesFound === 0 && 
        results.lmsrConsistencyFailures.length === 0 && 
        results.balanceInvariantFailures.length === 0;

    res.status(isHealthy ? 200 : 207).json({
      success: true,
      healthy: isHealthy,
      message: isHealthy ? 'Ledger audit passed' : 'Ledger audit detected discrepancies',
      results
    });
  } catch (err) {
    console.error('Error in runAuditCron:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
