const http = require('http');

let serverPromise = null;
let activeCount = 0;
let server = null;
const sockets = new Set();

const startServer = () => {
  if (server && server.listening) {
    return Promise.resolve();
  }

  // Lazy: requiring src/index at module scope would cache the whole app
  // before test files register jest.mock factories (this module is pulled
  // in by the setupFilesAfterEnv teardown helper).
  const { app } = require('../src/index');

  server = http.createServer(app);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.unref?.();
      resolve();
    });
  });
};

const getTestServer = async () => {
  activeCount += 1;

  if (!serverPromise) {
    serverPromise = startServer().then(() => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      return {
        port,
        baseUrl: `http://127.0.0.1:${port}`
      };
    });
  }

  return serverPromise;
};

const releaseTestServer = async () => {
  if (activeCount > 0) {
    activeCount -= 1;
  }

  if (activeCount !== 0) {
    return;
  }

  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();

  if (server?.listening) {
    await new Promise((resolve) => server.close(resolve));
  }

  serverPromise = null;
  server = null;
};

const forceCloseTestServer = async () => {
  activeCount = 0;
  await releaseTestServer();
};

module.exports = {
  getTestServer,
  releaseTestServer,
  forceCloseTestServer
};
