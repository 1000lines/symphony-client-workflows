// Exercise the publisher/broker boundary without minting real credentials.
import assert from "node:assert/strict";

export let preflights = 0;
export const loadAppConfig = async (env) =>
  JSON.parse(env.PUBLICATION_TEST_CONFIG);
export async function getInstallationToken(options) {
  assert.equal(options.forceRefresh, true);
  assert.equal(options.config.permissions.issues, "write");
  assert.equal(options.config.permissions.pull_requests, "write");
  preflights++;
  return { token: "github-test-secret" };
}
export function createGitHubAppClient({ config, fetchImpl }) {
  assert.deepEqual(config.permissions, {
    pull_requests: "read",
    issues: "write",
  });
  return (path, { method, body }) =>
    fetchImpl(`https://api.github.com/repos/${config.repository}${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { authorization: "Bearer github-test-secret" },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
}
