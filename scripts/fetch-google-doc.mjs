#!/usr/bin/env node
// Fetch a Google Doc's text via a service account, with no external dependencies.
//
// Deliberately a bare-node .mjs (not a .ts script): it must run identically on a
// developer machine and on the GitHub runner with no install or build step. It
// signs a service-account JWT with Node's built-in crypto, exchanges it for a
// short-lived access token, and reads the doc through the Docs API.
//
// It uses the Docs API (documents.get), not Drive export, on purpose: docs that
// disable download/copy/export refuse Drive export with 403 cannotExportFile,
// but the Docs API still reads their content.
//
// Provide the service-account key through:
//   - GOOGLE_APPLICATION_CREDENTIALS: path to the service-account JSON key file
//
// The service account must have read access to the doc: share the doc or its
// folder with the service-account email as Viewer. Scopes: drive.readonly and
// documents.readonly.
//
// Usage:  node scripts/fetch-google-doc.mjs <google-doc-url-or-id>
// Output: the document text on stdout.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
].join(" ");

const toBase64Url = (b64) =>
  b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const base64UrlJson = (value) =>
  toBase64Url(Buffer.from(JSON.stringify(value)).toString("base64"));

export const parseDocRequest = (input) => {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/document\/d\/([A-Za-z0-9_-]+)/);
  let requestedTabId;

  try {
    const url = new URL(trimmed);
    requestedTabId = url.searchParams.get("tab") || undefined;
  } catch {
    requestedTabId = undefined;
  }

  const docId = fromUrl ? fromUrl[1] : trimmed;
  if (!/^[A-Za-z0-9_-]+$/.test(docId)) {
    throw new Error(`Could not parse a Google Doc id from "${input}".`);
  }
  return { docId, requestedTabId };
};

const loadCredentials = () => {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) {
    throw new Error(
      "Set GOOGLE_APPLICATION_CREDENTIALS to the service-account JSON key file path."
    );
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read GOOGLE_APPLICATION_CREDENTIALS file: ${
        error.code || error.message
      }`
    );
  }

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS file is not valid JSON.");
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error(
      "Service-account key is missing client_email or private_key."
    );
  }
  return creds;
};

const signJwt = (creds) => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claims = base64UrlJson({
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(creds.private_key, "base64");
  return `${signingInput}.${toBase64Url(signature)}`;
};

const getAccessToken = async (creds) => {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signJwt(creds),
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json();
  if (!response.ok) {
    const reason =
      payload.error_description || payload.error || response.status;
    throw new Error(`Token request failed: ${reason}`);
  }
  return payload.access_token;
};

const paragraphText = (paragraph) =>
  (paragraph.elements || []).map((el) => el.textRun?.content || "").join("");

const renderParagraph = (paragraph) => {
  const text = paragraphText(paragraph).replace(/\n$/, "");
  if (!text.trim()) return "";
  const style = paragraph.paragraphStyle?.namedStyleType || "NORMAL_TEXT";
  const heading = style.match(/^HEADING_(\d)$/);
  if (style === "TITLE") return `# ${text}`;
  if (heading) return `${"#".repeat(Number(heading[1]))} ${text}`;
  if (paragraph.bullet) return `- ${text}`;
  return text;
};

const renderTable = (table) =>
  (table.tableRows || [])
    .map(
      (row) =>
        `| ${(row.tableCells || [])
          .map((cell) =>
            renderContent(cell.content).replace(/\s+/g, " ").trim()
          )
          .join(" | ")} |`
    )
    .join("\n");

const renderContent = (content) =>
  (content || [])
    .map((el) => {
      if (el.paragraph) return renderParagraph(el.paragraph);
      if (el.table) return renderTable(el.table);
      return "";
    })
    .filter((line) => line !== "")
    .join("\n");

const flattenTabs = (tabs, depth = 0) =>
  (tabs || []).flatMap((tab) => {
    const properties = tab.tabProperties || {};
    const current = {
      tabId: properties.tabId,
      title: properties.title || "(untitled tab)",
      depth,
      content: tab.documentTab?.body?.content || [],
    };
    return [current, ...flattenTabs(tab.childTabs, depth + 1)];
  });

const tabHeading = (tab) => {
  const level = Math.min(6, 2 + tab.depth);
  const id = tab.tabId ? ` (${tab.tabId})` : "";
  return `${"#".repeat(level)} Tab: ${tab.title}${id}`;
};

const renderTab = (tab) => {
  const content = renderContent(tab.content);
  return [tabHeading(tab), content].filter(Boolean).join("\n\n");
};

const availableTabsText = (tabs) =>
  tabs
    .map(
      (tab) =>
        `${"  ".repeat(tab.depth)}- ${tab.title} (${tab.tabId || "no id"})`
    )
    .join("\n");

export const renderDocument = (document, { requestedTabId, docId } = {}) => {
  const tabs = flattenTabs(document.tabs);

  if (requestedTabId) {
    const tab = tabs.find((candidate) => candidate.tabId === requestedTabId);
    if (!tab) {
      const availableTabs = availableTabsText(tabs);
      throw new Error(
        [
          `Requested tab "${requestedTabId}" was not found in doc ${
            docId || document.documentId || "unknown"
          }.`,
          availableTabs
            ? `Available tabs:\n${availableTabs}`
            : "No tabs were returned by the Docs API.",
        ].join("\n")
      );
    }
    return `# ${document.title}\n\n${renderTab(tab)}\n`;
  }

  if (tabs.length > 1) {
    return `# ${document.title}\n\n${tabs.map(renderTab).join("\n\n")}\n`;
  }

  const content =
    tabs.length === 1
      ? renderContent(tabs[0].content)
      : renderContent(document.body?.content);
  return `# ${document.title}\n\n${content}\n`;
};

export const documentsGetUrl = (docId) => {
  const url = new URL(`https://docs.googleapis.com/v1/documents/${docId}`);
  url.searchParams.set("includeTabsContent", "true");
  return url.toString();
};

export const fetchDoc = async (docId, accessToken) => {
  const response = await fetch(documentsGetUrl(docId), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = await response.json();
  if (!response.ok) {
    const reason = payload.error?.message || response.status;
    throw new Error(
      `Docs API read failed (${response.status}) for doc ${docId}: ${reason}`
    );
  }
  return payload;
};

const fetchDocText = async ({ docId, requestedTabId }, accessToken) => {
  const document = await fetchDoc(docId, accessToken);
  return renderDocument(document, { requestedTabId, docId });
};

const main = async () => {
  const input = process.argv[2];
  if (!input) {
    throw new Error(
      "Usage: node scripts/fetch-google-doc.mjs <google-doc-url-or-id>"
    );
  }
  const creds = loadCredentials();
  const accessToken = await getAccessToken(creds);
  process.stdout.write(await fetchDocText(parseDocRequest(input), accessToken));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
