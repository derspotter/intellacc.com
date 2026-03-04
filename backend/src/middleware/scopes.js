/**
 * Scope Middleware for API Keys
 */

const requireScope = (requiredScope) => {
    return (req, res, next) => {
        // If it's a normal user session (JWT), they inherently have all scopes
        if (!req.user.isAgent) {
            return next();
        }

        // If it's an API Key, check the assigned scopes
        const scopes = req.user.scopes || [];
        if (!scopes.includes(requiredScope)) {
            return res.status(403).json({ 
                error: 'Forbidden', 
                message: `API Key missing required scope: ${requiredScope}` 
            });
        }

        next();
    };
};

module.exports = {
    requireScope
};
