#!/usr/bin/env node
// Classify GitHub actors for Symphony review/rework routing, with no external
// dependencies. The pure classifier accepts explicit allowlists and pre-fetched
// team membership; the optional GitHub path only resolves humans/ai team
// membership and returns JSON.

import { fileURLToPath } from "node:url";

export const ACTOR_CLASSIFICATION = Object.freeze({
  HUMAN: "human",
  AI_ACTOR: "ai_actor",
  DEPENDENCY_BOT: "dependency_bot",
  NON_HUMAN_BOT: "non_human_bot",
  UNKNOWN: "unknown",
});

export const KNOWN_AI_ACTORS = Object.freeze({
  [(process.env.SYMPHONY_BOT_USER || "example-symphony-bot").toLowerCase()]: { actorKind: "coding" },
  [(process.env.CADENCE_REVIEWER || "example-cadence-bot").toLowerCase()]: { actorKind: "review" },
  "claude[bot]": { actorKind: "coding" },
});

export const KNOWN_DEPENDENCY_BOTS = Object.freeze({
  "dependabot[bot]": { actorKind: "dependency" },
});

const GITHUB_ORG = process.env.SYMPHONY_REPOSITORY_OWNER || "example-org";
const HUMANS_TEAM_SLUG = "humans";
const AI_TEAM_SLUG = "ai";

export class GitHubTeamAccessError extends Error {
  constructor(message, { status, teamSlug } = {}) {
    super(message);
    this.name = "GitHubTeamAccessError";
    this.code = "missing_team_permission";
    this.status = status;
    this.teamSlug = teamSlug;
  }
}

export const normalize = (actor) =>
  String(actor || "")
    .trim()
    .toLowerCase();

const listContains = (logins, login) =>
  new Set((logins || []).map(normalize).filter(Boolean)).has(login);

const result = ({ login, classification, humanFacing, source, actorKind }) => ({
  login,
  classification,
  humanFacing,
  source,
  ...(actorKind ? { actorKind } : {}),
});

export const classifyGitHubActor = (actor, options = {}) => {
  const login = normalize(typeof actor === "object" ? actor?.login : actor);
  const teamMembership = options.teamMembership || {};

  // App mode trusts only the configured identities/human mapping. Numeric App
  // IDs are not bot user IDs; when provenance supplies an App ID it must match.
  const appMode = options.appIdentities || process.env.SYMPHONY_GITHUB_AUTH_MODE === "app";
  if (appMode) {
    const identities = options.appIdentities || [
      { appId: Number(process.env.SYMPHONY_APP_ID), slug: process.env.SYMPHONY_APP_SLUG, actorKind: "coding" },
      { appId: Number(process.env.CADENCE_APP_ID), slug: process.env.CADENCE_APP_SLUG, actorKind: "review" },
    ];
    if (identities.length !== 2 || identities.some(({ appId, slug, actorKind }) => !Number.isSafeInteger(appId) || appId <= 0 ||
        !/^[a-z0-9-]+$/.test(slug || "") || !["coding", "review"].includes(actorKind)) ||
        new Set(identities.map((entry) => entry.appId)).size !== 2 || new Set(identities.map((entry) => entry.slug)).size !== 2 ||
        new Set(identities.map((entry) => entry.actorKind)).size !== 2) {
      throw new Error("Two distinct configured GitHub App identities are required.");
    }
    const humans = options.humanAllowlist ?? (process.env.SYMPHONY_HUMAN_LOGIN || "").split(",");
    if (!Array.isArray(humans) || !humans.some((human) => normalize(human))) {
      throw new Error("An explicit GitHub human mapping is required.");
    }
    const app = identities.find(({ slug }) => login === `${slug}[bot]`);
    const appId = options.actorAppId ?? actor?.app?.id;
    if (app && (appId === undefined || appId === app.appId) && (typeof actor !== "object" || actor.type === "Bot")) {
      return { ...result({ login, classification: ACTOR_CLASSIFICATION.AI_ACTOR, humanFacing: false, source: "configured-app", actorKind: app.actorKind }), appId: app.appId };
    }
    if (!login.endsWith("[bot]") && appId === undefined && listContains(humans, login) &&
        (typeof actor !== "object" || actor.type === "User")) {
      return result({ login, classification: ACTOR_CLASSIFICATION.HUMAN, humanFacing: true, source: "human-allowlist" });
    }
    return result({ login, classification: login.endsWith("[bot]") ? ACTOR_CLASSIFICATION.NON_HUMAN_BOT : ACTOR_CLASSIFICATION.UNKNOWN, humanFacing: false, source: "unmapped-actor" });
  }

  if (!login) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.UNKNOWN,
      humanFacing: false,
      source: "missing-login",
    });
  }

  if (listContains(options.humanAllowlist, login)) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.HUMAN,
      humanFacing: true,
      source: "human-allowlist",
    });
  }

  if (listContains(options.aiActorAllowlist, login)) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.AI_ACTOR,
      humanFacing: false,
      source: "ai-allowlist",
    });
  }

  if (listContains(options.dependencyBotAllowlist, login)) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.DEPENDENCY_BOT,
      humanFacing: false,
      source: "dependency-bot-allowlist",
      actorKind: "dependency",
    });
  }

  const knownDependency = KNOWN_DEPENDENCY_BOTS[login];
  if (knownDependency) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.DEPENDENCY_BOT,
      humanFacing: false,
      source: "known-dependency-bot",
      actorKind: knownDependency.actorKind,
    });
  }

  const knownAiActor = KNOWN_AI_ACTORS[login];
  if (knownAiActor) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.AI_ACTOR,
      humanFacing: false,
      source: "known-ai-actor",
      actorKind: knownAiActor.actorKind,
    });
  }

  if (teamMembership.ai) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.AI_ACTOR,
      humanFacing: false,
      source: "ai-team",
    });
  }

  if (teamMembership.humans) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.HUMAN,
      humanFacing: true,
      source: "humans-team",
    });
  }

  if (login.endsWith("[bot]")) {
    return result({
      login,
      classification: ACTOR_CLASSIFICATION.NON_HUMAN_BOT,
      humanFacing: false,
      source: "bot-suffix",
    });
  }

  return result({
    login,
    classification: ACTOR_CLASSIFICATION.UNKNOWN,
    humanFacing: true,
    source: "unknown-non-bot",
  });
};

const safeJson = async (response) => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
};

export const githubTeamUrl = ({ org, teamSlug }) =>
  `https://api.github.com/orgs/${encodeURIComponent(
    org
  )}/teams/${encodeURIComponent(teamSlug)}`;

export const githubTeamMembershipUrl = ({ org, teamSlug, login }) =>
  `${githubTeamUrl({ org, teamSlug })}/memberships/${encodeURIComponent(
    login
  )}`;

const githubHeaders = (token) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
});

const positiveId = (id) => Number.isSafeInteger(id) && id > 0;
const repositorySlug = (repo) => /^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repo || "");
const humanAccount = (user) => user?.type === "User" && positiveId(user.id) &&
  /^[a-z0-9-]+$/i.test(user.login || "") && !user.app &&
  !KNOWN_AI_ACTORS[normalize(user.login)] && !KNOWN_DEPENDENCY_BOTS[normalize(user.login)];
const untrusted = (reason) => ({ allowed: false, contentTrust: "untrusted", reason });
const authorityFailure = (reason) => ({ ...untrusted(reason), verificationFailed: true });

// Only these authenticated, repository-scoped reads supply authority. Neither
// an actor classification nor a caller-provided permission/association does.
const readAuthorityJson = async (url, token, fetchImpl) => {
  const response = await fetchImpl(url, {
    headers: { ...githubHeaders(token), "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`github-authority-http-${response.status}`);
  if (response.url && response.url !== url) throw new Error("github-authority-url-mismatch");
  return response.json();
};

export const verifyGitHubHumanWriteAccess = async ({
  author, repository, token, fetchImpl = fetch,
}) => {
  if (!repositorySlug(repository)) return untrusted("invalid-target-repository");
  if (!humanAccount(author)) return untrusted("unverified-human-author");
  if (!token) return authorityFailure("app-installation-token-required");
  try {
    // GitHub authenticates installation credentials at this endpoint. Token
    // spelling is not authority: stateless installation tokens also contain
    // underscores and dots. The repository-scoped read below checks access.
    const installation = await readAuthorityJson(
      "https://api.github.com/installation/repositories?per_page=1", token, fetchImpl,
    );
    if (!positiveId(installation?.total_count) || !Array.isArray(installation.repositories) ||
        installation.repositories.length !== 1 || !positiveId(installation.repositories[0]?.id) ||
        !repositorySlug(installation.repositories[0]?.full_name)) {
      return authorityFailure("malformed-app-installation");
    }
    const permission = await readAuthorityJson(
      `https://api.github.com/repos/${repository}/collaborators/${author.login}/permission`, token, fetchImpl,
    );
    if (!humanAccount(permission?.user) || permission.user.id !== author.id ||
        normalize(permission.user.login) !== normalize(author.login) ||
        !["admin", "write", "maintain", "read", "triage", "none"].includes(permission.permission)) {
      return authorityFailure("malformed-author-permission");
    }
    // GitHub maps maintain to write and custom roles to their effective base
    // permission. role_name is descriptive, never an authority allowlist.
    if (!["admin", "write", "maintain"].includes(permission.permission) ||
        permission.user.permissions?.push === false) return untrusted("author-lacks-write-access");
    return {
      allowed: true, contentTrust: "verified-human-writer", reason: "verified-human-write-access",
      repository, author: normalize(author.login), authorId: author.id,
      permission: permission.permission,
    };
  } catch (error) {
    // Do not expose API bodies, thrown network messages, or credentials.
    return authorityFailure(/^github-authority-(http-\d{3}|url-mismatch)$/.test(error.message)
      ? error.message : "github-authority-unavailable");
  }
};

export const verifyReviewEventAuthority = async ({
  payload, eventName, repository, token, fetchImpl = fetch,
}) => {
  const isReview = eventName === "pull_request_review";
  const isComment = ["issue_comment", "pull_request_review_comment"].includes(eventName);
  if (!(isReview ? ["submitted", "edited"] : isComment ? ["created", "edited"] : []).includes(payload.action)) {
    return untrusted("unsupported-feedback-action");
  }
  const feedback = isReview ? payload.review : payload.comment;
  const pr = payload.pull_request || payload.issue;
  if (!repositorySlug(repository) || normalize(payload.repository?.full_name) !== normalize(repository) ||
      (pr?.base?.repo?.full_name && normalize(pr.base.repo.full_name) !== normalize(repository))) {
    return untrusted("event-repository-mismatch");
  }
  if (!positiveId(pr?.number) || !positiveId(feedback?.id) || !humanAccount(feedback?.user)) {
    return untrusted("unverified-feedback-author");
  }
  const sender = payload.sender;
  if (sender?.type === "Bot" || sender?.app || normalize(sender?.login).endsWith("[bot]") ||
      KNOWN_AI_ACTORS[normalize(sender?.login)] || KNOWN_DEPENDENCY_BOTS[normalize(sender?.login)]) {
    return untrusted("non-human-feedback-editor");
  }
  if (!token) return authorityFailure("app-installation-token-required");
  try {
    const root = `https://api.github.com/repos/${repository}`;
    const url = isReview ? `${root}/pulls/${pr.number}/reviews/${feedback.id}`
      : `${root}/${eventName === "issue_comment" ? "issues" : "pulls"}/comments/${feedback.id}`;
    const current = await readAuthorityJson(url, token, fetchImpl);
    const parent = eventName === "issue_comment" ? current?.issue_url : current?.pull_request_url;
    const expectedParent = `${root}/${eventName === "issue_comment" ? "issues" : "pulls"}/${pr.number}`;
    if (current?.id !== feedback.id || parent !== expectedParent ||
        !humanAccount(current.user) || current.user.id !== feedback.user.id ||
        normalize(current.user.login) !== normalize(feedback.user.login)) return untrusted("feedback-author-or-target-mismatch");
    if ((current.body !== null && typeof current.body !== "string") ||
        (feedback.body !== null && typeof feedback.body !== "string") ||
        (current.body ?? "") !== (feedback.body ?? "") ||
        (isReview && normalize(current.state) !== normalize(feedback.state)) ||
        (feedback.updated_at && current.updated_at !== feedback.updated_at)) return untrusted("stale-feedback-event");
    return verifyGitHubHumanWriteAccess({ author: current.user, repository, token, fetchImpl });
  } catch (error) {
    return authorityFailure(/^github-authority-(http-\d{3}|url-mismatch)$/.test(error.message)
      ? error.message : "github-authority-unavailable");
  }
};

const ensureTeamReadable = async ({ org, teamSlug, token, fetchImpl }) => {
  const response = await fetchImpl(githubTeamUrl({ org, teamSlug }), {
    headers: githubHeaders(token),
  });
  if (response.ok) return;

  const payload = await safeJson(response);
  if ([401, 403, 404].includes(response.status)) {
    throw new GitHubTeamAccessError(
      `GitHub team "${teamSlug}" is not readable with the provided token (${response.status}).`,
      { status: response.status, teamSlug }
    );
  }
  throw new Error(
    `GitHub team read failed for "${teamSlug}" (${response.status}): ${
      payload.message || "unknown error"
    }`
  );
};

export const fetchGitHubTeamMembership = async ({
  actor,
  org = GITHUB_ORG,
  teamSlug,
  token,
  fetchImpl = fetch,
}) => {
  const login = normalize(actor);
  if (!login) throw new Error("GitHub actor login is required.");
  if (!token) {
    throw new GitHubTeamAccessError(
      "Set GH_TOKEN with GitHub org/team read access.",
      {
        teamSlug,
      }
    );
  }

  await ensureTeamReadable({ org, teamSlug, token, fetchImpl });

  const response = await fetchImpl(
    githubTeamMembershipUrl({ org, teamSlug, login }),
    { headers: githubHeaders(token) }
  );
  const payload = await safeJson(response);
  if (response.status === 200) {
    return payload.state === "active";
  }
  if (response.status === 404) {
    return false;
  }
  if ([401, 403].includes(response.status)) {
    throw new GitHubTeamAccessError(
      `GitHub team membership for "${teamSlug}" is not readable with the provided token (${response.status}).`,
      { status: response.status, teamSlug }
    );
  }
  throw new Error(
    `GitHub team membership read failed for "${teamSlug}" (${
      response.status
    }): ${payload.message || "unknown error"}`
  );
};

export const fetchGitHubActorTeams = async ({
  actor,
  org = GITHUB_ORG,
  humansTeamSlug = HUMANS_TEAM_SLUG,
  aiTeamSlug = AI_TEAM_SLUG,
  token,
  fetchImpl = fetch,
}) => {
  const [humans, ai] = await Promise.all([
    fetchGitHubTeamMembership({
      actor,
      org,
      teamSlug: humansTeamSlug,
      token,
      fetchImpl,
    }),
    fetchGitHubTeamMembership({
      actor,
      org,
      teamSlug: aiTeamSlug,
      token,
      fetchImpl,
    }),
  ]);

  return {
    status: "ok",
    org,
    humansTeamSlug,
    aiTeamSlug,
    membership: { humans, ai },
  };
};

export const classifyGitHubActorWithTeams = async (actor, options = {}) => {
  if (options.appIdentities || process.env.SYMPHONY_GITHUB_AUTH_MODE === "app") {
    return { ...classifyGitHubActor(actor, options), teamLookup: { status: "not-required" } };
  }
  try {
    const teamLookup = await fetchGitHubActorTeams({ actor, ...options });
    return {
      ...classifyGitHubActor(actor, {
        ...options,
        teamMembership: teamLookup.membership,
      }),
      teamLookup,
    };
  } catch (error) {
    if (!(error instanceof GitHubTeamAccessError)) throw error;
    return {
      ...classifyGitHubActor(actor, options),
      teamLookup: {
        status: "missing_permission",
        code: error.code,
        statusCode: error.status,
        teamSlug: error.teamSlug,
        message: error.message,
      },
    };
  }
};

const parseArgs = (argv) => {
  let actor;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else if (arg.startsWith("-")) {
      throw new Error(`Unexpected argument: ${arg}`);
    } else if (!actor) {
      actor = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return { actor };
};

const usage = () =>
  [
    "Usage: node scripts/github-actor-classification.mjs <github-actor>",
    "",
    "Set GH_TOKEN with example-org org/team read access.",
  ].join("\n");

const main = async () => {
  const { actor, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!actor) throw new Error(usage());

  const classified = await classifyGitHubActorWithTeams(actor, {
    token: process.env.GH_TOKEN,
  });

  if (classified.teamLookup?.status === "missing_permission") {
    console.error(classified.teamLookup.message);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(classified, null, 2)}\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
