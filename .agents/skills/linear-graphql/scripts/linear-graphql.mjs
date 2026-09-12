#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const API_URL =
  process.env.LINEAR_GRAPHQL_URL || "https://api.linear.app/graphql";

const usage = `Usage:
  node .agents/skills/linear-graphql/scripts/linear-graphql.mjs --query-file query.graphql [--variables-file variables.json]
  printf 'query Viewer { viewer { id name email } }\\n' | node .agents/skills/linear-graphql/scripts/linear-graphql.mjs

Options:
  --query-file <path>       Read GraphQL query from a file. Defaults to stdin.
  --variables-file <path>   Read variables JSON from a file.
  --variables-json <json>   Read variables JSON from an argument.
  --operation-name <name>   Set GraphQL operationName.
  --token-file <path>       Read a personal Linear token from a file.
                            Defaults to LINEAR_TOKEN_FILE or ~/.linear-token.
  --no-token-file           Disable token-file auth.
  --aws-secret-id <id>      AWS Secrets Manager secret id for fallback auth.
                            No AWS secret is used unless this or LINEAR_AWS_SECRET_ID is set.
  --aws-profile <profile>   AWS profile for fallback auth. Defaults to AWS_PROFILE or example.
  --aws-region <region>     AWS region for fallback auth. Defaults to AWS_REGION/AWS_DEFAULT_REGION or us-west-2.
  --no-aws-secret           Disable AWS Secrets Manager fallback auth.
  --public-file-urls-expire-in <seconds>
                            Request temporary signed URLs for uploads.linear.app URLs in GraphQL responses.
  --dry-run                 Print the request body without requiring auth or network.
  --help                    Show this help.

Auth:
  Live requests use LINEAR_API_KEY or LINEAR_API_TOKEN first, then the token file,
  then an explicitly configured AWS Secrets Manager secret.`;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const DEFAULT_TOKEN_FILE = "~/.linear-token";

const readOptionValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${flag} requires a value.\n\n${usage}`);
  }
  return value;
};

const parseArgs = (argv) => {
  const options = {
    dryRun: false,
    noAwsSecret: false,
    noTokenFile: false,
    operationName: undefined,
    publicFileUrlsExpireIn: undefined,
    awsProfile: process.env.AWS_PROFILE || "example",
    awsRegion:
      process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-west-2",
    awsSecretId:
      process.env.LINEAR_AWS_SECRET_ID ||
      process.env.SYMPHONY_LINEAR_API_KEY_SECRET_ID ||
      undefined,
    queryFile: undefined,
    tokenFile: process.env.LINEAR_TOKEN_FILE || DEFAULT_TOKEN_FILE,
    tokenFileExplicit: false,
    variablesFile: undefined,
    variablesJson: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--no-aws-secret") {
      options.noAwsSecret = true;
      continue;
    }
    if (arg === "--no-token-file") {
      options.noTokenFile = true;
      continue;
    }
    if (arg === "--query-file") {
      options.queryFile = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--variables-file") {
      options.variablesFile = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--variables-json") {
      options.variablesJson = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--operation-name") {
      options.operationName = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--token-file") {
      options.tokenFile = readOptionValue(argv, index, arg);
      options.tokenFileExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--aws-secret-id") {
      options.awsSecretId = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--aws-profile") {
      options.awsProfile = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--aws-region") {
      options.awsRegion = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--public-file-urls-expire-in") {
      const seconds = readOptionValue(argv, index, arg);
      if (!/^[1-9][0-9]*$/.test(seconds)) {
        fail(`${arg} requires a positive integer number of seconds.`);
      }
      options.publicFileUrlsExpireIn = seconds;
      index += 1;
      continue;
    }

    fail(`Unknown option: ${arg}\n\n${usage}`);
  }

  if (options.variablesFile && options.variablesJson) {
    fail("Use either --variables-file or --variables-json, not both.");
  }

  return options;
};

const expandHome = (filePath) => {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return `${homedir()}${filePath.slice(1)}`;
  return filePath;
};

const parseJson = (value, source) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`Invalid JSON in ${source}: ${error.message}`);
  }
};

const readQuery = (options) => {
  const query = options.queryFile
    ? readFileSync(options.queryFile, "utf8")
    : readFileSync(0, "utf8");
  if (!query.trim()) {
    fail("GraphQL query is empty. Pass --query-file or pipe a query on stdin.");
  }
  return query;
};

const readVariables = (options) => {
  if (options.variablesFile) {
    return parseJson(readFileSync(options.variablesFile, "utf8"), "variables file");
  }
  if (options.variablesJson) {
    return parseJson(options.variablesJson, "variables JSON");
  }
  return {};
};

const tokenFromFile = ({ tokenFile, tokenFileExplicit }) => {
  if (!tokenFile) return "";

  const expandedTokenFile = expandHome(tokenFile);
  if (!existsSync(expandedTokenFile)) {
    if (tokenFileExplicit) {
      fail(`Linear token file does not exist: ${expandedTokenFile}`);
    }
    return "";
  }

  const fileToken = readFileSync(expandedTokenFile, "utf8").trim();
  if (!fileToken) {
    fail(`Linear token file is empty: ${expandedTokenFile}`);
  }
  return fileToken;
};

const tokenFromAws = ({ awsProfile, awsRegion, awsSecretId }) => {
  if (!awsSecretId) return "";

  try {
    const token = execFileSync(
      "aws",
      [
        "secretsmanager",
        "get-secret-value",
        "--profile",
        awsProfile,
        "--region",
        awsRegion,
        "--secret-id",
        awsSecretId,
        "--query",
        "SecretString",
        "--output",
        "text",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();

    if (!token || token === "None") {
      fail(`AWS secret ${awsSecretId} is empty.`);
    }
    return token;
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    fail(
      `Unable to load Linear token from AWS Secrets Manager secret ${awsSecretId}: ${detail}`
    );
  }
};

const token = (options) => {
  const envToken = process.env.LINEAR_API_KEY || process.env.LINEAR_API_TOKEN;
  if (envToken) return envToken;
  if (!options.noTokenFile) {
    const fileToken = tokenFromFile(options);
    if (fileToken) return fileToken;
  }
  if (options.noAwsSecret) {
    fail(
      "Set LINEAR_API_KEY/LINEAR_API_TOKEN or provide a token file for live Linear GraphQL calls."
    );
  }
  const awsToken = tokenFromAws(options);
  if (awsToken) return awsToken;
  fail(
    "Set LINEAR_API_KEY/LINEAR_API_TOKEN, create ~/.linear-token, or pass --aws-secret-id for live Linear GraphQL calls."
  );
};

const requestLinear = async (body, options) => {
  const authToken = token(options);
  const headers = {
    authorization: authToken,
    "content-type": "application/json",
  };
  if (options.publicFileUrlsExpireIn) {
    headers["public-file-urls-expire-in"] = options.publicFileUrlsExpireIn;
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    fail(`Linear API returned non-JSON response with HTTP ${response.status}.`);
  }

  if (!response.ok) {
    fail(`Linear API HTTP ${response.status}: ${JSON.stringify(payload, null, 2)}`);
  }
  if (payload.errors?.length) {
    fail(`Linear GraphQL errors: ${JSON.stringify(payload.errors, null, 2)}`);
  }

  return payload.data ?? payload;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const body = {
    query: readQuery(options),
    variables: readVariables(options),
  };

  if (options.operationName) {
    body.operationName = options.operationName;
  }

  if (options.dryRun) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const data = await requestLinear(body, options);
  console.log(JSON.stringify(data, null, 2));
};

main().catch((error) => {
  fail(error.message);
});
