// Non-billable onboarding probe. Live caller/provider readiness is verified separately.
// Never return secret values or service response bodies.
export function reviewSetup(env) {
  const required = ["CADENCE_APP_PRIVATE_KEY", "CADENCE_LINEAR_API_TOKEN",
    "CADENCE_APP_ID", "CADENCE_REVIEWER", "SYMPHONY_BOT_USER"];
  for (const name of required) {
    if (!env[name]?.trim()) throw new Error(`Missing ${name}. Configure repository/selected-organization Actions settings; environment-only settings cannot reach reusable callers.`);
  }
  if (!/^[1-9]\d*$/.test(env.CADENCE_APP_ID)) throw new Error("CADENCE_APP_ID must be the numeric App ID, not its slug or installation ID.");
  for (const name of ["CADENCE_REVIEWER", "SYMPHONY_BOT_USER"]) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\[bot\]$/.test(env[name]) || env[name].startsWith("example-")) {
      throw new Error(`${name} must identify the installed App's real slug[bot] login.`);
    }
  }
  if (env.CADENCE_REVIEWER === env.SYMPHONY_BOT_USER) throw new Error("Cadence and Symphony must use distinct Apps.");
  const provider = env.CADENCE_OPENAI_API_KEY?.trim() ? "codex"
    : env.CADENCE_AI_REVIEW_ANTHROPIC_API_KEY?.trim() ? "claude" : undefined;
  if (!provider) throw new Error("Configure CADENCE_OPENAI_API_KEY or CADENCE_AI_REVIEW_ANTHROPIC_API_KEY. Neither provider key reached this job.");
  const model = env[provider === "codex" ? "CADENCE_CODEX_MODEL" : "CADENCE_CLAUDE_MODEL"] || undefined;
  if ((provider === "claude" && !model) || (model && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model))) throw new Error(`Set a valid CADENCE_${provider === "codex" ? "CODEX" : "CLAUDE"}_MODEL repository variable.`);
  if (provider === "claude" && model !== "claude-opus-5") throw new Error("CADENCE_CLAUDE_MODEL must be claude-opus-5 under the published review contract.");
  return { provider, model };
}

export function verifyInstallation({ appSlug, reviewer, repository }, installation) {
  if (!appSlug || `${appSlug}[bot]` !== reviewer) throw new Error("CADENCE_REVIEWER does not match the App minted from CADENCE_APP_ID/private key.");
  if (installation.total_count !== 1 || installation.repositories?.[0]?.full_name !== repository) {
    throw new Error("Cadence token must cover exactly the target repository. Check its installation.");
  }
}

export async function verifyEnvironment(github, { owner, repo, defaultBranch }) {
  const params = { owner, repo, environment_name: "cadence-controller" };
  const route = "GET /repos/{owner}/{repo}/environments/{environment_name}";
  let environment;
  try { environment = (await github.request(route, params)).data; }
  catch (error) {
    throw new Error(`Cannot read cadence-controller (HTTP ${error.status || "unknown"}). Have the repository admin create/check the environment; the probe needs Actions read.`);
  }
  const policy = environment.deployment_branch_policy;
  const remedy = "Configure cadence-controller: Selected branches and tags, exactly one branch rule for the actual default branch; no tags or wildcards.";
  if (!policy?.custom_branch_policies || policy.protected_branches) throw new Error(remedy);
  let rules;
  try { rules = await github.paginate(`${route}/deployment-branch-policies`, params); }
  catch (error) {
    throw new Error(`Cannot read cadence-controller deployment branch policies (HTTP ${error.status || "unknown"}). Verify Actions read and ask the repository admin for policy readback.`);
  }
  if (!defaultBranch || /[*?\[\]\\]/.test(defaultBranch) || rules.length !== 1 ||
      rules[0].name !== defaultBranch || rules[0].type !== "branch") throw new Error(remedy);
}

export async function verifyServices(env, fetchImpl = fetch) {
  const setup = reviewSetup(env);
  if (!/^[A-Z0-9]+$/.test(env.LINEAR_TEAM_KEY || "")) throw new Error("Missing/invalid target configuration linear.teamKey (LINEAR_TEAM_KEY).");
  // Metadata requests catch invalid keys/model access before a billable review.
  // They do not prove inference, review publication, or Linear write permission.
  const request = async (url, options, label) => {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error(`${label} could not be reached. Retry the preflight; no readiness was established.`); }
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}. Check the selected key, account permissions and model; no provider fallback is attempted.`);
    try { return await response.json(); }
    catch { throw new Error(`${label} returned an invalid response. No readiness was established.`); }
  };
  const linear = await request("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: env.CADENCE_LINEAR_API_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ query: "query($team:String!){viewer{id} teams(filter:{key:{eq:$team}}){nodes{key}}}", variables: { team: env.LINEAR_TEAM_KEY } }),
  }, "CADENCE_LINEAR_API_TOKEN validation");
  if (linear.errors?.length || !linear.data?.viewer?.id) throw new Error("CADENCE_LINEAR_API_TOKEN cannot read Linear. Supply a token with access to the target team and workpad writes.");
  if (!linear.data.teams?.nodes?.some(team => team.key === env.LINEAR_TEAM_KEY)) throw new Error("CADENCE_LINEAR_API_TOKEN cannot access the target linear.teamKey. Verify the token's workspace and team grants.");
  const openai = setup.provider === "codex";
  await request(`${openai ? "https://api.openai.com/v1/models" : "https://api.anthropic.com/v1/models"}${setup.model ? "/" + encodeURIComponent(setup.model) : ""}`, {
    headers: openai ? { authorization: `Bearer ${env.CADENCE_OPENAI_API_KEY}` }
      : { "x-api-key": env.CADENCE_AI_REVIEW_ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
  }, `${openai ? "CADENCE_OPENAI_API_KEY" : "CADENCE_AI_REVIEW_ANTHROPIC_API_KEY"} model access`);
  return setup;
}
