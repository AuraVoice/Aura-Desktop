/**
 * Per-question retrieval over the candidate's profile graph.
 *
 * The whole resume already rides the answer prompt's cached prefix, so recall
 * is never the problem: the model has every fact every turn. What it lacked
 * was FOCUS: which project "your project" or "your MCP" most likely means.
 * `retrieveFocus` answers that by plain lexical ranking of project nodes
 * against the question, the same mechanism `relevantInterviewBriefSlice`
 * already uses for claims, then one hop of adjacency brings the project's
 * tools, employer and metrics along. Sub-millisecond on a graph of sixty
 * nodes, no network on the answer path.
 *
 * This ranks EVIDENCE; it decides nothing. Whether the question is about the
 * project at all, and in what order to cover it, is the model's call from the
 * intent it writes on its first line (see the backend's intent_styles). A
 * concept question is told to ignore focus. That split is what keeps this on
 * the right side of interviewPolicy.ts: no word list here ever picks a
 * register or an action.
 */

import type { InterviewBrief, InterviewProfileGraph, InterviewProfileNode } from "./interviewBrief";
import { tokens } from "./interviewBrief";

export interface InterviewFocusNode {
  nodeId: string;
  kind: string;
  label: string;
  text: string;
  links: string[];
}

export interface InterviewFocus {
  nodes: InterviewFocusNode[];
}

const MAX_NODES = 8;
const MAX_TEXT = 2_000;
const MAX_LINKS = 12;
/** "Your recent project" names nothing; rank 0 is what the builder called the
 * most recent or substantial, and this prior is what resolves it. */
const RANK_PRIOR = 0.5;

function score(node: InterviewProfileNode, query: Set<string>): number {
  const nodeTokens = tokens(`${node.label} ${node.text}`);
  let overlap = 0;
  nodeTokens.forEach((token) => {
    if (query.has(token)) overlap += 1;
  });
  return overlap / Math.sqrt(Math.max(1, nodeTokens.size));
}

function adjacency(graph: InterviewProfileGraph): Map<string, Set<string>> {
  const links = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!links.has(edge.fromId)) links.set(edge.fromId, new Set());
    if (!links.has(edge.toId)) links.set(edge.toId, new Set());
    links.get(edge.fromId)!.add(edge.toId);
    links.get(edge.toId)!.add(edge.fromId);
  }
  return links;
}

function toFocusNode(node: InterviewProfileNode, links: Map<string, Set<string>>): InterviewFocusNode {
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    label: node.label,
    text: node.text.slice(0, MAX_TEXT),
    links: [...(links.get(node.nodeId) ?? [])].slice(0, MAX_LINKS),
  };
}

/**
 * The project the question most likely concerns plus its neighbours, or the
 * rank-0 project when nothing in the question names one. Null when the brief
 * carries no graph: a brief built before the graph shipped, or a resume-only
 * session, sends nothing volatile and the model answers from the prefix as
 * it always did.
 */
export function retrieveFocus(
  brief: InterviewBrief | null,
  question: string,
  recentRemote: string,
): InterviewFocus | null {
  const graph = brief?.profile ?? null;
  if (!graph || graph.nodes.length === 0) return null;
  const projects = graph.nodes.filter((node) => node.kind === "project");
  if (projects.length === 0) return null;
  const query = tokens(`${question} ${recentRemote}`);
  const ranked = projects
    .map((node, index) => ({
      node,
      index,
      score: score(node, query) + (node.rank === 0 ? RANK_PRIOR : 0),
    }))
    .sort((left, right) => right.score - left.score || left.node.rank - right.node.rank || left.index - right.index);
  const best = ranked[0].node;
  const links = adjacency(graph);
  const byId = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  // Tools and skills first, then metrics, then the employer: a script names
  // tools by name and closes on the outcome.
  const rankKind = (node: InterviewProfileNode) =>
    node.kind === "tool" || node.kind === "skill" ? 0 : node.kind === "metric" ? 1 : 2;
  const neighbours = [...(links.get(best.nodeId) ?? [])]
    .map((other) => byId.get(other))
    .filter((node): node is InterviewProfileNode => Boolean(node))
    .sort((a, b) => rankKind(a) - rankKind(b) || b.text.length - a.text.length);
  // When the question named a project other than the most recent one, the
  // rank-0 project rides along as a second candidate so "and your latest
  // work" in the same breath still has something to point at.
  const recent = projects.find((node) => node.rank === 0 && node.nodeId !== best.nodeId);
  const seen = new Set<string>();
  const nodes = [best, ...neighbours, ...(recent ? [recent] : [])]
    .filter((node) => (seen.has(node.nodeId) ? false : (seen.add(node.nodeId), true)))
    .slice(0, MAX_NODES)
    .map((node) => toFocusNode(node, links));
  return { nodes };
}
