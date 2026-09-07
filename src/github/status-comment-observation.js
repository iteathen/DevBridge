import { ProtocolError } from '../errors.js';
import { headerValue } from './rate-budget.js';

// GitHub permits 100 comments per page. Ten pages is a finite recovery read
// budget, not permission to infer absence from an incomplete comment stream.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export async function observeStatusComment({ client, repositoryPath, issueNumber, creation, critical }) {
  const marker = `<!-- devbridge-status-effect ${creation.id} -->`;
  const matches = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await client.request('GET', `${repositoryPath}/issues/${issueNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`, { critical });
    if (response.notModified || !Array.isArray(response.data) || response.data.length > PAGE_SIZE) throw new ProtocolError('status comment observation is incomplete or malformed');
    for (const comment of response.data) {
      if (typeof comment?.body !== 'string' || !comment.body.includes(marker)) continue;
      // The nonce becomes public after POST. A copied marker is not ownership.
      let destination;
      try { destination = new URL(comment.issue_url).pathname; } catch { continue; }
      if (destination !== `${repositoryPath}/issues/${issueNumber}` || String(comment.user?.id) !== creation.actorId) continue;
      if (comment.body !== creation.body) return { complete: true, reason: 'creation-content-changed', commentId: null };
      if (!Number.isSafeInteger(comment.id) || comment.id < 1) throw new ProtocolError('status comment observation has an invalid ID');
      matches.push(comment.id);
    }
    const link = headerValue(response.headers, 'link');
    const hasNext = typeof link === 'string' && /rel="next"/u.test(link);
    if (!hasNext && response.data.length < PAGE_SIZE) {
      if (matches.length > 1) return { complete: true, reason: 'creation-ambiguous', commentId: null };
      return { complete: true, reason: matches.length ? 'creation-observed' : 'creation-not-observed', commentId: matches[0] ?? null };
    }
    // Check one further page after a full page. Never follow a remote URL.
  }
  return { complete: false, reason: 'observation-budget-exhausted', commentId: null };
}
