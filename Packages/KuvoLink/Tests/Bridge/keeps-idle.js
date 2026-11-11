// A stand-in server in the test's own process keeps its idle connections open long after the
// box's fetch lets them go, as the engine's own leave that to the box. The box runs git
// synchronously, and so do these stand-ins: under load that holds the process for seconds, and a
// connection idle across it was closed by the server's 5-second timer just as the box sent its
// next request on it ("fetch failed", ECONNRESET), whichever step that happened to be.
export function keepsIdle(server) {
  server.keepAliveTimeout = 10 * 60_000;
  return server;
}
