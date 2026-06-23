// Outbound integrations for Yield Security: Slack notifications, Jira issue creation, and
// GitHub commit-status / PR-comment posting. Used by scan-on-push (the webhook) and the
// scheduled re-scans so findings reach where teams already work.

import type { Env } from '../types';
import type { AuditResult } from './audit';
import { decryptToken, postCommitStatus, postIssueComment, prsForCommit } from './github';

export interface IntegrationConfig {
  slack_webhook: string | null;
  jira_base: string | null;
  jira_email: string | null;
  jira_token_enc: string | null;
  jira_project: string | null;
  post_pr_comments: number;
  post_commit_status: number;
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

export async function postSlack(webhook: string, text: string): Promise<void> {
  try { await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch { /* best-effort */ }
}

// Create a Jira issue (REST v2, Basic auth = email:apiToken). Best-effort.
export async function createJiraIssue(env: Env, integ: IntegrationConfig, summary: string, description: string): Promise<void> {
  if (!integ.jira_base || !integ.jira_email || !integ.jira_token_enc || !integ.jira_project) return;
  try {
    const token = await decryptToken(env, integ.jira_token_enc);
    await fetch(`${integ.jira_base.replace(/\/$/, '')}/rest/api/2/issue`, {
      method: 'POST',
      headers: { authorization: `Basic ${b64(`${integ.jira_email}:${token}`)}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ fields: { project: { key: integ.jira_project }, summary: summary.slice(0, 240), description: description.slice(0, 3000), issuetype: { name: 'Task' } } }),
    });
  } catch { /* best-effort */ }
}

function summaryLine(repo: string, r: AuditResult): string {
  const s = r.summary;
  return `🛡 Yield Security — ${repo}: health ${r.codeHealthScore}/100 · ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low`;
}

// Fan out scan results to the user's configured channels + GitHub.
export async function notifyScan(
  env: Env, integ: IntegrationConfig | null, ctx: { repo: string; sha?: string; githubToken?: string; appUrl: string }, result: AuditResult,
): Promise<void> {
  const failing = result.summary.critical + result.summary.high > 0;
  const line = summaryLine(ctx.repo, result);

  // GitHub: commit status + PR comments (needs the repo token).
  if (ctx.githubToken && ctx.sha) {
    if (!integ || integ.post_commit_status) {
      await postCommitStatus(ctx.githubToken, ctx.repo, ctx.sha, failing ? 'failure' : 'success',
        `${result.summary.total} findings (${result.summary.critical} critical, ${result.summary.high} high)`, `${ctx.appUrl}/security`);
    }
    if (integ?.post_pr_comments) {
      const top = result.findings.slice(0, 8).map((f) => `- **${f.severity}** ${f.type.replace(/_/g, ' ')} (${f.cwe}) — \`${f.location.file}:${f.location.line}\``).join('\n');
      const body = `### 🛡 Yield Security\n${line}\n\n${top || '✅ No findings.'}\n\n_Code is analyzed and discarded — only findings are kept._`;
      for (const n of await prsForCommit(ctx.githubToken, ctx.repo, ctx.sha)) await postIssueComment(ctx.githubToken, ctx.repo, n, body);
    }
  }
  if (!integ) return;
  if (integ.slack_webhook) await postSlack(integ.slack_webhook, line);
  // Jira: open a ticket per critical finding (capped).
  if (integ.jira_base) {
    for (const f of result.findings.filter((x) => x.severity === 'CRITICAL').slice(0, 5)) {
      await createJiraIssue(env, integ, `[Security] ${f.type.replace(/_/g, ' ')} in ${ctx.repo}`, `${f.description}\n\nFile: ${f.location.file}:${f.location.line}\nCWE: ${f.cwe}\nFix: ${f.fix}`);
    }
  }
}
