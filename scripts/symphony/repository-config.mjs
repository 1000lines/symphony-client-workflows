// Read configuration only from the fetched, selected target base. This module
// is shared by CI/close bridges and review policy; it does not execute commands.
import { validateConfig } from "./runtime-bundle/skills/symphony-repository/scripts/config.mjs";
export {
  inspectConfig,
  validateConfig,
} from "./runtime-bundle/skills/symphony-repository/scripts/config.mjs";

const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonempty = (value) =>
  typeof value === "string" && value.trim().length > 0;
const assert = (condition, reason) => {
  if (!condition) throw new Error(reason);
};
const repositoryName = (value) =>
  typeof value === "string" &&
  /^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(value) &&
  ![".", ".."].includes(value.split("/")[1]);
const matchesRepository = (repository, fullName) =>
  repositoryName(fullName) &&
  positive(repository?.id) &&
  repository.full_name === fullName &&
  repository.owner?.login === fullName.split("/")[0];

// The trusted task/project selects the repository and base. Only the fetched
// selected base revision supplies active configuration; task-head proposals do not.
// A missing file is an onboarding handoff to symphony-repository (PR, issue,
// then pinned Linear workpad), never permission to infer passing requirements.
export async function loadRepositoryConfig({
  repository: fullName,
  baseBranch,
  expectedRevision,
  token,
  fetchImpl = fetch,
}) {
  assert(repositoryName(fullName), "Invalid selected repository");
  assert(sha(expectedRevision), "Missing expected target base revision");
  const read = async (path) => {
    const response = await fetchImpl(
      `https://api.github.com/repos/${fullName}${path}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
        },
      }
    );
    assert(
      response.ok,
      `Repository configuration read failed: HTTP ${response.status}`
    );
    return response.json();
  };
  const repository = await read("");
  assert(
    matchesRepository(repository, fullName),
    "Discovered repository owner/name mismatch"
  );
  const selectedBase = baseBranch ?? repository.default_branch;
  assert(nonempty(selectedBase), "Missing selected base branch");
  const branch = await read(`/branches/${encodeURIComponent(selectedBase)}`);
  assert(
    branch.name === selectedBase && branch.commit?.sha === expectedRevision,
    "Configuration must match fetched selected base"
  );
  const tree = await read(`/git/trees/${expectedRevision}`);
  assert(
    tree.truncated === false && Array.isArray(tree.tree),
    "Incomplete target base tree"
  );
  const entries = tree.tree.filter(
    (entry) => entry.path === ".symphony.cfg.json"
  );
  const context = {
    repository,
    baseBranch: selectedBase,
    revision: expectedRevision,
  };
  if (!entries.length) return { status: "missing", ...context };
  assert(
    entries.length === 1 &&
      entries[0].type === "blob" &&
      ["100644", "100755"].includes(entries[0].mode) &&
      sha(entries[0].sha),
    "Repository config must be a regular file"
  );
  const file = await read(`/git/blobs/${entries[0].sha}`);
  assert(
    file.sha === entries[0].sha &&
      file.encoding === "base64" &&
      nonempty(file.content),
    "Missing configuration content"
  );
  const config = validateConfig(
    JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))
  );
  return { status: "configured", ...context, config };
}

// Existing import name retained for downstream callers; there is no mapping or
// central target list. The arguments/result are the target-base config contract.
export { loadRepositoryConfig as loadRepositoryMapping };
