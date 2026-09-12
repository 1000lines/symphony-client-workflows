const { readFileSync } = require("node:fs");
const path = require("node:path");

const APPROVED_CADENCE_CLAUDE_MODELS = Object.freeze(["claude-opus-5"]);
const DRY_RUN_FIXTURE_MODEL = "claude-opus-5";
const repoRoot = path.resolve(__dirname, "../../..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/cadence-ai-review-trigger.yml"
);
const skillPath = path.join(
  repoRoot,
  ".claude/skills/cadence-ai-review/SKILL.md"
);
const reviewClaudePath = path.join(
  repoRoot,
  ".claude/skills/cadence-ai-review/review-CLAUDE.md"
);
const standingDocsAxisPath = path.join(
  repoRoot,
  "scripts/symphony/runtime-bundle/review-axes/standing-docs-current-state.md"
);
const standingDocsAxis = "standing-docs-current-state";
const disallowedFallbackExpression = "CADENCE_CLAUDE_MODEL " + "||";
const disallowedFallbackModel = "claude-opus-" + "4-8";
const cadenceReviewSkill = ".claude/skills/cadence-ai-review/SKILL.md";
const designReviewSkill = ".claude/skills/design-review/SKILL.md";
const standingDocsAxisFile =
  "scripts/symphony/runtime-bundle/review-axes/standing-docs-current-state.md";
const docsProcessFixtureFiles = Object.freeze([
  "docs/symphony-plans/design-DEMO-247-process-hardening.md",
  ".github/workflows/cadence-ai-review-trigger.yml",
  ".claude/skills/cadence-ai-review/SKILL.md",
]);

const relativeToRepo = (file) => path.relative(repoRoot, file);

const readRepoFile = (file) => readFileSync(file, "utf8");

const isDocsProcessPath = (file) =>
  file.startsWith("docs/symphony-plans/") ||
  file.startsWith("docs/engineering/review/") ||
  file.startsWith(".github/workflows/") ||
  file.startsWith(".claude/skills/") ||
  file.startsWith("scripts/symphony/runtime-bundle/");

const reviewLoadoutForChangedFiles = (changedFiles = []) => {
  const axes = changedFiles.some(isDocsProcessPath)
    ? [standingDocsAxisFile]
    : [];
  return {
    skill: cadenceReviewSkill,
    axes,
    excludedSkill: designReviewSkill,
  };
};

const validateModel = (model) => {
  if (!model) {
    throw new Error(
      "CADENCE_CLAUDE_MODEL must be set; no fallback model is allowed."
    );
  }
  if (!APPROVED_CADENCE_CLAUDE_MODELS.includes(model)) {
    throw new Error(
      `CADENCE_CLAUDE_MODEL=${model} is not approved. Approved model ids: ${APPROVED_CADENCE_CLAUDE_MODELS.join(
        ", "
      )}.`
    );
  }
};

const requireIncludes = (contents, needle, label) => {
  if (!contents.includes(needle)) {
    throw new Error(`${label} must include ${needle}.`);
  }
};

const requireNotIncludes = (contents, needle, label) => {
  if (contents.includes(needle)) {
    throw new Error(`${label} must not include ${needle}.`);
  }
};

const validateCadenceReviewConfiguration = ({
  model,
  headSha = "dry-run-head-sha",
} = {}) => {
  validateModel(model);

  const workflow = readRepoFile(workflowPath);
  const skill = readRepoFile(skillPath);
  const reviewClaude = readRepoFile(reviewClaudePath);
  const standingDocs = readRepoFile(standingDocsAxisPath);

  requireIncludes(
    workflow,
    "CADENCE_CLAUDE_MODEL: ${{ vars.CADENCE_CLAUDE_MODEL }}",
    relativeToRepo(workflowPath)
  );
  requireIncludes(
    workflow,
    "--model ${{ env.CADENCE_CLAUDE_MODEL }}",
    relativeToRepo(workflowPath)
  );
  requireNotIncludes(
    workflow,
    disallowedFallbackExpression,
    relativeToRepo(workflowPath)
  );
  requireNotIncludes(
    workflow,
    disallowedFallbackModel,
    relativeToRepo(workflowPath)
  );
  requireIncludes(workflow, "/cadence-ai-review", relativeToRepo(workflowPath));
  requireIncludes(workflow, standingDocsAxis, relativeToRepo(workflowPath));
  requireIncludes(
    workflow,
    "Current PR head SHA:",
    relativeToRepo(workflowPath)
  );
  requireNotIncludes(
    workflow,
    "\n            /design-review",
    relativeToRepo(workflowPath)
  );

  requireIncludes(skill, standingDocsAxis, relativeToRepo(skillPath));
  requireIncludes(skill, "design-review", relativeToRepo(skillPath));
  requireIncludes(
    reviewClaude,
    standingDocsAxis,
    relativeToRepo(reviewClaudePath)
  );
  requireIncludes(
    reviewClaude,
    "design-review",
    relativeToRepo(reviewClaudePath)
  );
  requireIncludes(
    standingDocs,
    "# Standing Docs Current State Review Axis",
    relativeToRepo(standingDocsAxisPath)
  );

  const fixtureLoadout = reviewLoadoutForChangedFiles(docsProcessFixtureFiles);
  if (fixtureLoadout.skill !== cadenceReviewSkill) {
    throw new Error(
      `Docs/process fixture must load ${cadenceReviewSkill}, got ${fixtureLoadout.skill}.`
    );
  }
  if (!fixtureLoadout.axes.includes(standingDocsAxisFile)) {
    throw new Error(`Docs/process fixture must load ${standingDocsAxisFile}.`);
  }
  if (fixtureLoadout.skill === designReviewSkill) {
    throw new Error(
      `Docs/process fixture must not select ${designReviewSkill}.`
    );
  }

  return {
    model,
    headSha,
    approvedModels: APPROVED_CADENCE_CLAUDE_MODELS,
    skill: cadenceReviewSkill,
    axis: standingDocsAxisFile,
    excludedSkill: designReviewSkill,
    fixtureFiles: docsProcessFixtureFiles,
    fixtureLoadout,
  };
};

const parseCliArgs = (argv) => {
  const options = {
    dryRun: false,
    requireEnv: false,
    model: undefined,
    headSha: process.env.HEAD_SHA || process.env.CADENCE_HEAD_SHA || undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--require-env") {
      options.requireEnv = true;
    } else if (arg === "--model") {
      i += 1;
      if (i >= argv.length) throw new Error("--model requires a value.");
      options.model = argv[i];
    } else if (arg === "--head-sha") {
      i += 1;
      if (i >= argv.length) throw new Error("--head-sha requires a value.");
      options.headSha = argv[i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const modelForDryRun = ({ model, requireEnv }) => {
  if (model !== undefined) return model.trim();
  if (process.env.CADENCE_CLAUDE_MODEL !== undefined) {
    return process.env.CADENCE_CLAUDE_MODEL.trim();
  }
  return requireEnv ? "" : DRY_RUN_FIXTURE_MODEL;
};

const runDryRun = (argv) => {
  const options = parseCliArgs(argv);
  if (!options.dryRun) {
    throw new Error("Usage: node verify-cadence-ai-review.cjs --dry-run");
  }

  const result = validateCadenceReviewConfiguration({
    model: modelForDryRun(options),
    headSha: options.headSha || "dry-run-head-sha",
  });

  process.stdout.write(
    [
      "Cadence AI review configuration dry run passed.",
      `Selected model id: ${result.model}`,
      `Approved model ids: ${result.approvedModels.join(", ")}`,
      `Review skill: ${result.skill}`,
      `Loaded review axis: ${result.axis}`,
      `Docs/process fixture files: ${result.fixtureFiles.join(", ")}`,
      `Docs/process fixture loadout: ${
        result.fixtureLoadout.skill
      } + ${result.fixtureLoadout.axes.join(", ")}`,
      `Excluded process-review skill: ${result.excludedSkill}`,
      `Current-head SHA evidence: ${result.headSha}`,
      "",
    ].join("\n")
  );
};

const verifyCadenceAiReview = async function verifyCadenceAiReview({
  github,
  context,
  core,
  reviewOutcome,
  reviewer,
}) {
  const { owner, repo } = context.repo;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\[bot\]$/.test(reviewer || "")) {
    core.setFailed("A trusted Cadence App reviewer login is required.");
    return;
  }

  const number = Number(process.env.PR_NUMBER);
  if (!Number.isInteger(number) || number <= 0) {
    core.setFailed("PR_NUMBER must be set to the reviewed pull request.");
    return;
  }

  const dismissed = [];
  const unreviewed = [];
  const { data: pr } = await github.rest.pulls.get({
    owner,
    repo,
    pull_number: number,
  });
  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  const mine = reviews.filter((review) => review.user?.login === reviewer);
  for (const review of mine) {
    if (review.state === "CHANGES_REQUESTED") {
      await github.rest.pulls.dismissReview({
        owner,
        repo,
        pull_number: number,
        review_id: review.id,
        message:
          "Cadence AI Review does not request changes; this review was dismissed automatically.",
      });
      dismissed.push(`#${number} review ${review.id}`);
    }
  }
  // False-green guard: a successful run must leave a Cadence review at the
  // current head. A failed Action must also fail when an older review exists.
  const validCurrentHeadReview = mine.some(
    (review) =>
      review.commit_id === pr.head.sha &&
      ["APPROVED", "COMMENTED"].includes(review.state)
  );
  if (!validCurrentHeadReview) {
    unreviewed.push(`#${number} (head ${pr.head.sha.slice(0, 8)})`);
  }

  const problems = [];
  if (reviewOutcome !== "success") {
    problems.push(
      `Cadence AI review Action outcome: ${
        reviewOutcome || "unknown"
      }. Review execution did not succeed; inspect the Run Cadence AI review step.`
    );
  }
  if (unreviewed.length > 0) {
    problems.push(
      `No Cadence review at current head for ${unreviewed.join(
        ", "
      )} - no completed review was found.`
    );
  }
  if (dismissed.length > 0) {
    problems.push(
      `Dismissed disallowed REQUEST_CHANGES: ${dismissed.join(", ")}.`
    );
  }
  if (problems.length > 0) {
    core.setFailed(problems.join(" "));
  }
};

verifyCadenceAiReview.APPROVED_CADENCE_CLAUDE_MODELS =
  APPROVED_CADENCE_CLAUDE_MODELS;
verifyCadenceAiReview.validateCadenceReviewConfiguration =
  validateCadenceReviewConfiguration;
verifyCadenceAiReview.reviewLoadoutForChangedFiles =
  reviewLoadoutForChangedFiles;

module.exports = verifyCadenceAiReview;

if (require.main === module) {
  try {
    runDryRun(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
