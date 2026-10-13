#!/usr/bin/env node
// Starts a real Mockttp (httptoolkit-server's copy) for the HTTP/3 gateway's ignored tests
// (docs/http3.md):
// a throwaway CA made by Mockttp's own generateCACertificate (same shape as the Wirepane CA),
// SOCKS with custom-metadata, two mock rules for https://example.test and passthrough for the rest.
// Prints every request with
// its tags. Exits on SIGTERM or after 5 minutes.
//
//   node mockttp-h3.cjs <dir>   -> writes <dir>/ca.pem, <dir>/ca.key, <dir>/port
const fs = require("fs");
const path = require("path");
const mockttp = require(path.join(__dirname, "..", "..", "httptoolkit-server", "node_modules", "mockttp"));

const dir = process.argv[2];

async function main() {
  const ca = await mockttp.generateCACertificate({
    subject: { commonName: "Wirepane Test CA", organizationName: "Wirepane" },
  });
  fs.writeFileSync(path.join(dir, "ca.pem"), ca.cert);
  fs.writeFileSync(path.join(dir, "ca.key"), ca.key, { mode: 0o600 });

  const server = mockttp.getLocal({
    https: { cert: ca.cert, key: ca.key },
    socks: { authMethods: ["no-auth", "custom-metadata"] },
  });
  await server.start();
  await server
    .forGet("https://example.test/hello")
    .thenReply(200, "hello from mockttp", {
      "content-type": "text/plain",
      "x-mockttp": "yes",
    });
  await server
    .forPost("https://example.test/echo")
    .thenCallback(async (request) => ({
      statusCode: 200,
      body: `echo ${(await request.body.getText()).length} bytes`,
    }));
  // Anything else goes to the real server, as Wirepane's default rule does.
  await server.forAnyRequest().thenPassThrough();
  await server.on("request", (request) => {
    console.log(
      "REQUEST " +
        JSON.stringify({
          method: request.method,
          url: request.url,
          httpVersion: request.httpVersion,
          tags: request.tags,
          host: request.headers.host,
        }),
    );
  });
  fs.writeFileSync(path.join(dir, "port"), String(server.port));
  console.log("READY " + server.port);

  const stop = async () => {
    await server.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  setTimeout(stop, 5 * 60 * 1000).unref();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
