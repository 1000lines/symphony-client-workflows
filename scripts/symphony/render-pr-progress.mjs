#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const active = new Set(["active", "evaluating", "in progress", "rework"]);
const waiting = new Set(["inactive", "unhappy", "waiting for ci", "in review", "human input needed", "blocked"]);
export const markers = ["<!-- symphony-pr-progress:start -->", "<!-- symphony-pr-progress:end -->"];

export function stateClass(state) {
  const name = String(state ?? "").trim().toLowerCase();
  return name === "done" ? "completed" : active.has(name) ? "inProgress" : waiting.has(name) ? "waiting" : "neutral";
}

// PR links have a deliberately narrow grammar; never emit callbacks or arbitrary schemes.
export function prUrl(value) {
  return typeof value === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/.test(value)
    ? value.replace(/\/$/, "") : null;
}

// Mermaid decimal entities keep quotes, HTML, Markdown and entity-like prose literal.
const label = (value) => String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
  .replace(/[&"<>`#;\\\[\]{}]/g, (char) => `#${char.codePointAt(0)};`);
const markdown = (value) => String(value).replace(/[\r\n]/g, " ").replace(/[\\`*_{}\[\]<>()#!|]/g, "\\$&");
const linksFor = (snapshot, id) => [...new Set((snapshot.prs?.[id] ?? []).map(prUrl).filter(Boolean))];

export function renderMermaid(snapshot) {
  const { graph, currentNode, states = {} } = snapshot;
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (!/^(LR|RL|TB|TD|BT)$/.test(graph.direction) || ids.size !== graph.nodes.length ||
      graph.nodes.some((node) => !/^[A-Z][A-Z0-9_]*$/.test(node.id) || !node.label?.trim()) ||
      (currentNode != null && !ids.has(currentNode)) ||
      graph.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) ||
      new Set(graph.edges.map((edge) => `${edge.from}:${edge.to}`)).size !== graph.edges.length) {
    throw new Error("Invalid progress topology or current node; use the shared parsed plan");
  }
  if (ids.size < 3 || graph.edges.length < 2) return "";
  const lines = [`flowchart ${graph.direction}`];
  for (const node of graph.nodes) {
    const state = states[node.id]?.trim() || "Unknown";
    const prs = linksFor(snapshot, node.id);
    const text = [node.label, state, prs.length ? prs.map((url) => `PR #${url.split("/").at(-1)}`).join(", ") : "no PR yet"];
    if (node.id === currentNode) text.push("Current PR");
    lines.push(`  ${node.id}["${label(text.join(" — "))}"]:::${stateClass(state)}`);
  }
  for (const { from, to } of graph.edges) lines.push(`  ${from} --> ${to}`);
  lines.push(
    "  classDef completed fill:#dafbe1,color:#116329",
    "  classDef inProgress fill:#ddf4ff,color:#0550ae",
    "  classDef waiting fill:#fff8c5,color:#7d4e00",
    "  classDef neutral fill:#f6f8fa,color:#57606a",
  );
  if (currentNode) lines.push(`  style ${currentNode} stroke:#8250df,stroke-width:4px`);
  for (const node of graph.nodes) {
    const [url] = linksFor(snapshot, node.id);
    if (url) lines.push(`  click ${node.id} href "${url}" "Open PR" _blank`);
  }
  return lines.join("\n") + "\n";
}

export function renderProgress(snapshot) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(snapshot.snapshotTime) ||
      !Number.isFinite(Date.parse(snapshot.snapshotTime))) throw new Error("A UTC snapshotTime is required");
  const graph = renderMermaid(snapshot);
  const lines = [markers[0], `Status checked: ${snapshot.snapshotTime}.`, ""];
  if (graph) lines.push("```mermaid", graph.trimEnd(), "```", "");
  else lines.push("Diagram omitted: fewer than three nodes or two dependencies.", "");
  for (const node of snapshot.graph.nodes) {
    const links = linksFor(snapshot, node.id);
    if (links.length) lines.push(`${node.id}: ${links.map((url) => `[PR #${url.split("/").at(-1)}](${url})`).join(", ")}.`);
  }
  for (const note of snapshot.warnings ?? []) lines.push(`\nLookup: ${markdown(note)}`);
  lines.push(markers[1]);
  return lines.join("\n") + "\n";
}

export function refreshBody(body, snapshot) {
  const [start, end] = markers;
  if (body.split(start).length !== 2 || body.split(end).length !== 2 || body.indexOf(start) > body.indexOf(end)) {
    throw new Error("PR body must contain one ordered pair of progress markers");
  }
  return body.slice(0, body.indexOf(start)) + renderProgress(snapshot).trimEnd() + body.slice(body.indexOf(end) + end.length);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [input, body, ...extra] = process.argv.slice(2);
    if (!input || extra.length) throw new Error("Usage: render-pr-progress.mjs SNAPSHOT.json [BODY.md]");
    const snapshot = JSON.parse(readFileSync(input, "utf8"));
    if (body) writeFileSync(body, refreshBody(readFileSync(body, "utf8"), snapshot));
    else process.stdout.write(renderProgress(snapshot));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
