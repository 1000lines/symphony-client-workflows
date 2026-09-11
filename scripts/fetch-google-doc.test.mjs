import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchDoc,
  parseDocRequest,
  renderDocument,
} from "./fetch-google-doc.mjs";

const paragraph = (text, namedStyleType = "NORMAL_TEXT") => ({
  paragraph: {
    elements: [{ textRun: { content: `${text}\n` } }],
    paragraphStyle: { namedStyleType },
  },
});

const tabbedDoc = {
  documentId: "doc-123",
  title: "Symphony rollout plan",
  tabs: [
    {
      tabProperties: { tabId: "t.main", title: "Main Proposal" },
      documentTab: {
        body: { content: [paragraph("Main proposal intro")] },
      },
      childTabs: [
        {
          tabProperties: {
            tabId: "t.detail",
            title: "Detailed Four Week Plan",
          },
          documentTab: {
            body: {
              content: [
                paragraph("Week one plan", "HEADING_1"),
                paragraph("Ship the preflight"),
              ],
            },
          },
        },
      ],
    },
    {
      tabProperties: {
        tabId: "t.cost",
        title: "Cost And Production Credibility",
      },
      documentTab: {
        body: { content: [paragraph("Keep production behavior unchanged")] },
      },
    },
  ],
};

test("parseDocRequest extracts doc id and selected tab from Google Docs URLs", () => {
  assert.deepEqual(
    parseDocRequest(
      "https://docs.google.com/document/d/SYNTHETIC_DOC_ID_1234567890_ABCDEFGHIJKLMN/edit?pli=1&tab=t.sbj1efaq3qnq#heading=h.1"
    ),
    {
      docId: "SYNTHETIC_DOC_ID_1234567890_ABCDEFGHIJKLMN",
      requestedTabId: "t.sbj1efaq3qnq",
    }
  );
});

test("parseDocRequest accepts a bare Google Docs id", () => {
  assert.deepEqual(parseDocRequest("abc_123-XYZ"), {
    docId: "abc_123-XYZ",
    requestedTabId: undefined,
  });
});

test("renderDocument preserves ordinary body content when no tabs are returned", () => {
  assert.equal(
    renderDocument({
      title: "Retrospective",
      body: {
        content: [
          paragraph("Email Beta Retrospective", "TITLE"),
          paragraph("Observation"),
        ],
      },
    }),
    "# Retrospective\n\n# Email Beta Retrospective\nObservation\n"
  );
});

test("renderDocument returns only the requested tab when a tab id is selected", () => {
  const rendered = renderDocument(tabbedDoc, {
    requestedTabId: "t.detail",
    docId: "doc-123",
  });

  assert.match(
    rendered,
    /^# Symphony rollout plan\n\n### Tab: Detailed Four Week Plan \(t\.detail\)/
  );
  assert.match(rendered, /# Week one plan\nShip the preflight/);
  assert.doesNotMatch(rendered, /Main proposal intro/);
});

test("renderDocument includes all tab headings when no tab is selected", () => {
  const rendered = renderDocument(tabbedDoc);

  assert.match(
    rendered,
    /## Tab: Main Proposal \(t\.main\)\n\nMain proposal intro/
  );
  assert.match(
    rendered,
    /### Tab: Detailed Four Week Plan \(t\.detail\)\n\n# Week one plan/
  );
  assert.match(
    rendered,
    /## Tab: Cost And Production Credibility \(t\.cost\)\n\nKeep production behavior unchanged/
  );
});

test("renderDocument explains missing requested tabs and lists available tabs", () => {
  assert.throws(
    () =>
      renderDocument(tabbedDoc, {
        requestedTabId: "t.missing",
        docId: "doc-123",
      }),
    (error) => {
      assert.match(
        error.message,
        /Requested tab "t\.missing" was not found in doc doc-123\./
      );
      assert.match(error.message, /- Main Proposal \(t\.main\)/);
      assert.match(error.message, /  - Detailed Four Week Plan \(t\.detail\)/);
      return true;
    }
  );
});

test("fetchDoc asks the Docs API for tab content with bearer auth", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  let requestedHeaders;

  globalThis.fetch = async (url, options) => {
    requestedUrl = url;
    requestedHeaders = options.headers;
    return new Response(JSON.stringify({ title: "Doc", tabs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await fetchDoc("doc-123", "access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/v1/documents/doc-123");
  assert.equal(url.searchParams.get("includeTabsContent"), "true");
  assert.equal(requestedHeaders.authorization, "Bearer access-token");
});
