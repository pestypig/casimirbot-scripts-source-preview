import fs from "node:fs";
import path from "node:path";

import { resolveDocsRetrievalAuthority } from "../server/services/helix-ask/docs-search";

const workspaceRoot = process.cwd();
const docsRoot = path.resolve(workspaceRoot, "docs");

const markdownPaths: string[] = [];
const visit = (directory: string): void => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(absolutePath);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      markdownPaths.push(path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/"));
    }
  }
};

visit(docsRoot);

const statusCounts: Record<string, number> = {};
const topicCounts: Record<string, Record<string, number>> = {};
const primaryDocuments: string[] = [];
const archivalWithoutSupersession: string[] = [];

for (const documentPath of markdownPaths.sort()) {
  const authority = resolveDocsRetrievalAuthority(documentPath);
  statusCounts[authority.retrieval_status] =
    (statusCounts[authority.retrieval_status] ?? 0) + 1;
  if (authority.topic_id) {
    const topic = topicCounts[authority.topic_id] ?? {};
    topic[authority.retrieval_status] =
      (topic[authority.retrieval_status] ?? 0) + 1;
    topicCounts[authority.topic_id] = topic;
  }
  if (authority.retrieval_status === "primary") {
    primaryDocuments.push(documentPath);
  }
  if (
    authority.retrieval_status === "archive" &&
    authority.topic_id &&
    !authority.superseded_by
  ) {
    archivalWithoutSupersession.push(documentPath);
  }
}

process.stdout.write(`${JSON.stringify({
  schema: "casimirbot.docs_retrieval_authority_audit.v1",
  generated_at: new Date().toISOString(),
  total_markdown_documents: markdownPaths.length,
  status_counts: statusCounts,
  topic_counts: topicCounts,
  primary_documents: primaryDocuments,
  archival_topic_documents_without_supersession: archivalWithoutSupersession,
}, null, 2)}\n`);
