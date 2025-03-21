/**
 * Middleware to make Socket.IO instance available in all request handlers
 * This ensures consistent access to the real-time functionality across controllers
 */
module.exports = (io) => {
  if (!io) {
    console.error('Socket middleware initialized without IO instance!');
  }
  
  return (req, res, next) => {
    // For debugging
    console.log('Socket middleware applied to request:', req.path);
    
    // Ensure 'io' object is valid before attaching to request
    if (io && typeof io.emit === 'function') {
      // Attach the Socket.IO instance directly to the request object
      req.io = io;
    } else {
      console.warn('Invalid io instance in socket middleware');
    }
    
    next();
  };
};
