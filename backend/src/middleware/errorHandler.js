const errorHandler = (err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.url} -`, err);

  // Default to 500 server error
  let statusCode = err.status || 500;
  let message = err.message || 'Internal Server Error';

  // Handle specific database errors (like unique constraint violation)
  if (err.code === '23505') {
    statusCode = 409;
    message = 'Conflict: Resource already exists.';
  }

  // Hide detailed DB errors in production
  if (process.env.NODE_ENV === 'production' && statusCode === 500) {
    message = 'Internal Server Error';
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
};

module.exports = errorHandler;