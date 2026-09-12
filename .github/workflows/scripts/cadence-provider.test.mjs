import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import yaml from 'js-yaml';

const read = name => yaml.load(readFileSync(new URL(`../${name}.yml`, import.meta.url), 'utf8'));
const trigger = read('cadence-ai-review-trigger');
const runWorkflow = read('cadence-ai-review-run');
const keys = ['CADENCE_OPENAI_API_KEY', 'CADENCE_AI_REVIEW_ANTHROPIC_API_KEY'];
const steps = runWorkflow.jobs.review.steps;
const providers = steps.filter(step => /^(openai\/codex-action|anthropics\/claude-code-action)@/.test(step.uses));
const selected = provider => providers.filter(step => new Function('steps', 'inputs', `return ${step.if}`)(
  { plan: { outputs: { run_claude: 'true' } } }, { provider }));
const verify = createRequire(import.meta.url)('./verify-cadence-ai-review.cjs');

// Exercise the real YAML shell step with secrets delivered through each actual
// reusable boundary. Fake values are test data, never credentials or live proof.
for (const route of ['cadence-ai-review-trigger', 'cadence-ai-review-events', 'cadence-ai-review']) {
  for (const [openai, anthropic, expected] of [
    ['openai-fixture', '', 'codex'], ['', 'anthropic-fixture', 'claude'],
    ['openai-fixture', 'anthropic-fixture', 'codex'], ['', '', null], [' \t', '\n', null],
  ]) {
    test(`${route}: OpenAI ${Boolean(openai)}, Anthropic ${Boolean(anthropic)} selects ${expected}`, () => {
      const caller = read(route);
      for (const key of keys) assert.equal(caller.on.workflow_call.secrets[key].required, false);
      let secrets = { [keys[0]]: openai, [keys[1]]: anthropic };
      if (route !== 'cadence-ai-review-trigger') {
        secrets = Object.fromEntries(keys.map(key => {
          assert.equal(caller.jobs.review.secrets[key], `\${{ secrets.${key} }}`);
          return [key, secrets[key]];
        }));
      }
      const preflight = trigger.jobs.accept.steps[0];
      assert.equal(preflight.id, 'provider');
      for (const key of keys) assert.equal(preflight.env[key], `\${{ secrets.${key} }}`);
      const directory = mkdtempSync(join(tmpdir(), 'cadence-provider-'));
      try {
        const output = join(directory, 'output');
        const result = spawnSync('bash', ['-e', '-c', preflight.run], {
          encoding: 'utf8', env: { ...secrets, GITHUB_OUTPUT: output },
        });
        if (!expected) {
          assert.notEqual(result.status, 0);
          assert.match(result.stdout, /::error::Configure CADENCE_OPENAI_API_KEY or CADENCE_AI_REVIEW_ANTHROPIC_API_KEY/);
          return;
        }
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), `provider=${expected}\n`);
        const [action] = selected(expected);
        assert.equal(selected(expected).length, 1);
        assert.equal(action['continue-on-error'], undefined);
        const input = expected === 'codex' ? 'openai-api-key' : 'anthropic_api_key';
        assert.equal(action.with[input], `\${{ secrets.${expected === 'codex' ? keys[0] : keys[1]} }}`);
        for (const value of Object.values(secrets).filter(Boolean)) {
          assert.ok(!result.stdout.includes(value));
          assert.ok(!result.stderr.includes(value));
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

test('providers share the review task, minted publishing identity and Linear workpad', () => {
  assert.equal(providers.length, 2);
  assert.equal(providers[0].with.prompt, providers[1].with.prompt);
  for (const action of providers) {
    assert.match(action.uses, /@[a-f0-9]{40}$/);
    assert.equal(action.env.GH_TOKEN, '${{ steps.app-token.outputs.token }}');
    assert.equal(action.env.LINEAR_API_TOKEN, '${{ secrets.CADENCE_LINEAR_API_TOKEN }}');
    assert.match(action.with.prompt, /post one GitHub PR review/);
    assert.match(action.with.prompt, /Cadence Linear Workpad/);
    assert.match(action.with.prompt, /Current PR head SHA:/);
    assert.match(action.with.prompt, /Do not execute PR-controlled code/);
  }
  const codex = providers.find(step => step.id === 'codex_review');
  assert.equal(codex.with['safety-strategy'], 'drop-sudo');
  assert.equal(codex.with['allow-users'], undefined);
  assert.equal(codex.with['allow-bots'], undefined);
  assert.equal(codex.with['allow-bot-users'], providers[0].with.allowed_bots);
  assert.equal(codex.with['codex-home'], '${{ runner.temp }}/cadence-codex');
  assert.match(steps.find(step => step.name === 'Configure Codex review network access').run, /network_access = true/);
  assert.match(steps.find(step => step.name === 'Verify Claude review configuration').if, /provider == 'claude'/);
  assert.equal(trigger.jobs.review.needs, 'accept');
  assert.equal(trigger.jobs.accept.outputs.provider, '${{ steps.provider.outputs.provider }}');
  assert.equal(trigger.jobs.finish.if.startsWith('always()'), true);
});

test('selected-provider failures cannot use the skipped provider or an older successful review', async t => {
  const previous = process.env.PR_NUMBER;
  process.env.PR_NUMBER = '42';
  t.after(() => previous === undefined ? delete process.env.PR_NUMBER : process.env.PR_NUMBER = previous);
  const outcome = steps.find(step => step.name.startsWith('Verify review outcomes'));
  const expression = outcome.env.CADENCE_REVIEW_OUTCOME.slice(3, -2);
  for (const provider of ['codex', 'claude']) {
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      const evaluations = {
        codex_review: { outcome: provider === 'codex' ? result : 'skipped' },
        cadence_review: { outcome: provider === 'claude' ? result : 'skipped' },
      };
      const actual = new Function('steps', 'inputs', `return ${expression}`)(evaluations, { provider });
      assert.equal(actual, result);
      assert.equal(selected(provider).length, 1);
      const errors = [];
      await verify({
        reviewOutcome: actual, reviewer: 'cadence[bot]',
        context: { repo: { owner: 'client', repo: 'adopter' } }, core: { setFailed: value => errors.push(value) },
        github: {
          rest: { pulls: { get: async () => ({ data: { head: { sha: 'current' } } }), listReviews: 'reviews' } },
          paginate: async () => [{ user: { login: 'cadence[bot]' }, state: 'APPROVED', commit_id: 'current' }],
        },
      });
      assert.equal(errors.length, result === 'success' ? 0 : 1);
    }
  }
});

test('every reusable boundary declares and forwards only named secrets; ingress has none', () => {
  for (const name of ['cadence-ai-review-trigger', 'cadence-ai-review-run', 'cadence-ai-review-events', 'cadence-ai-review', 'cadence-linear-rework', 'cadence-review-check-cleanup']) {
    const workflow = read(name);
    assert.equal(workflow.on.workflow_call.secrets.CADENCE_APP_PRIVATE_KEY.required, true);
    for (const job of Object.values(workflow.jobs)) {
      if (job.uses) {
        assert.equal(typeof job.secrets, 'object');
        for (const key of Object.keys(trigger.on.workflow_call.secrets)) {
          assert.equal(job.secrets[key], `\${{ secrets.${key} }}`);
        }
      }
      for (const step of job.steps || []) {
        if (step.uses?.startsWith('actions/checkout@')) {
          assert.equal(step.with.repository, '1000lines/symphony-client-workflows');
          assert.equal(step.with.ref, "${{ inputs.helpers-ref || 'main' }}");
          assert.equal(step.with['persist-credentials'], false);
        }
      }
    }
  }
  for (const name of ['cadence-linear-rework', 'cadence-review-check-cleanup']) {
    for (const key of keys) assert.equal(read(name).on.workflow_call.secrets[key], undefined);
  }
  assert.doesNotMatch(JSON.stringify(read('cadence-review-ingress')), /secrets|environment|checkout@/);
});
