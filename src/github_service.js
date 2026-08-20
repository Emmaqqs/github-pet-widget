let OctokitModule;

const API_VERSION = '2022-11-28';

function toDate(value) {
    if (!value) return new Date(0);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function loginOf(user) {
    if (!user) return null;
    return user.login || user.name || null;
}

function activityDate(activity) {
    if (!activity) return new Date(0);
    return toDate(activity.submitted_at || activity.created_at || activity.updated_at);
}

function isSameUser(user, username) {
    const login = loginOf(user);
    if (!login || !username) return false;
    return login.toLowerCase() === username.toLowerCase();
}

function isSeen(seenPRs, url, activityAt) {
    if (!seenPRs || !url) return false;
    const marker = seenPRs[url];
    if (!marker) return false;

    if (typeof marker === 'string') {
        return toDate(activityAt).getTime() <= toDate(marker).getTime();
    }
    if (marker.seenAt) {
        return toDate(activityAt).getTime() <= toDate(marker.seenAt).getTime();
    }
    return false;
}

function sortNewestFirst(events) {
    return events.sort((a, b) => b.date.getTime() - a.date.getTime());
}

class GitHubService {
    constructor(token) {
        this.token = token;
        this.octokit = null;
        this.username = null;
        this.lastRateLimit = null;
    }

    async getOctokit() {
        if (!this.octokit) {
            if (!OctokitModule) {
                const mod = await import('octokit');
                OctokitModule = mod.Octokit;
            }
            this.octokit = new OctokitModule({ auth: this.token });
        }
        return this.octokit;
    }

    async verifyUser() {
        try {
            const octokit = await this.getOctokit();
            const { data: user } = await octokit.rest.users.getAuthenticated();
            this.username = user.login;
            return user;
        } catch (error) {
            console.error('Auth verification error:', error.status || error.message);
            return null;
        }
    }

    rememberRateLimit(response) {
        const headers = response?.headers || {};
        if (headers['x-ratelimit-remaining'] !== undefined) {
            this.lastRateLimit = {
                remaining: Number(headers['x-ratelimit-remaining']),
                resetAt: headers['x-ratelimit-reset']
                    ? new Date(Number(headers['x-ratelimit-reset']) * 1000).toISOString()
                    : null,
            };
        }
    }

    async safeFetch(fn, params) {
        try {
            if (typeof fn !== 'function') return [];
            const response = await fn({ ...params, per_page: 100 });
            this.rememberRateLimit(response);
            return Array.isArray(response?.data) ? response.data : [];
        } catch (e) {
            return [];
        }
    }

    async searchPullRequests(username) {
        const octokit = await this.getOctokit();
        const params = {
            q: `is:pr is:open involves:${username}`,
            per_page: 100,
            headers: { 'X-GitHub-Api-Version': API_VERSION },
        };
        if (typeof octokit.request === 'function') {
            const response = await octokit.request('GET /search/issues', params);
            this.rememberRateLimit(response);
            return response.data?.items || [];
        }
        if (octokit.rest?.search?.issuesAndPullRequests) {
            const response = await octokit.rest.search.issuesAndPullRequests(params);
            this.rememberRateLimit(response);
            return response.data?.items || [];
        }
        return [];
    }

    async getPullRequestDiff(owner, repo, pull_number) {
        try {
            const octokit = await this.getOctokit();
            const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner,
                repo,
                pull_number,
                headers: {
                    accept: 'application/vnd.github.v3.diff',
                    'X-GitHub-Api-Version': API_VERSION
                }
            });
            this.rememberRateLimit(response);
            return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        } catch (error) {
            console.error(`Error fetching diff for PR #${pull_number}:`, error.message);
            return '';
        }
    }

    async getStatus(seenPRs = {}, includeSeen = false) {
        try {
            const octokit = await this.getOctokit();
            if (!this.username) {
                const user = await this.verifyUser();
                if (!user) return null;
            }

            const username = this.username;
            const alerts = {
                merge_conflicts: [],
                review_required: [],
                re_review_needed: [],
                my_pr_activity: [],
                meta: { rateLimit: this.lastRateLimit, generatedAt: new Date().toISOString() },
            };
            const items = await this.searchPullRequests(username);

            for (const item of items) {
                const parts = String(item.repository_url || '').split('/').filter(Boolean);
                const repo = parts.pop();
                const owner = parts.pop();
                if (!owner || !repo || !item.number) continue;

                let pr;
                try {
                    const pullResponse = await octokit.rest.pulls.get({
                        owner,
                        repo,
                        pull_number: item.number,
                        headers: { 'X-GitHub-Api-Version': API_VERSION },
                    });
                    this.rememberRateLimit(pullResponse);
                    pr = pullResponse.data;
                } catch (e) {
                    console.error(`Error fetching PR #${item.number}:`, e.message);
                    continue;
                }

                const base = { owner, repo, pull_number: item.number };

                const [reviews, reviewComments, issueComments] = await Promise.all([
                    this.safeFetch(octokit.rest.pulls.listReviews ? octokit.rest.pulls.listReviews.bind(octokit.rest.pulls) : null, base),
                    this.safeFetch(octokit.rest.pulls.listReviewComments ? octokit.rest.pulls.listReviewComments.bind(octokit.rest.pulls) : null, base),
                    this.safeFetch(octokit.rest.issues?.listComments ? octokit.rest.issues.listComments.bind(octokit.rest.issues) : null, {
                        owner, repo, issue_number: item.number,
                    }),
                ]);

                const events = [];
                for (const review of reviews) {
                    if (review && review.state && review.state !== 'PENDING') {
                        events.push({
                            type: 'review',
                            state: review.state,
                            user: loginOf(review.user) || 'reviewer',
                            date: activityDate(review),
                            created_at: review.submitted_at || review.created_at,
                            id: review.id,
                            body: review.body || '',
                            headSha: review.commit_id || null,
                        });
                    }
                }
                for (const comment of reviewComments) {
                    if (comment) {
                        events.push({
                            type: 'inline_comment',
                            user: loginOf(comment.user) || 'reviewer',
                            date: activityDate(comment),
                            created_at: comment.created_at,
                            id: comment.id,
                            body: comment.body || '',
                            headSha: comment.commit_id || null,
                        });
                    }
                }
                for (const comment of issueComments) {
                    if (comment) {
                        events.push({
                            type: 'issue_comment',
                            user: loginOf(comment.user) || 'usuario',
                            date: activityDate(comment),
                            created_at: comment.created_at,
                            id: comment.id,
                            body: comment.body || '',
                            headSha: null,
                        });
                    }
                }
                sortNewestFirst(events);

                const mine = sortNewestFirst(events.filter(e => isSameUser({ login: e.user }, username)));
                const others = sortNewestFirst(events.filter(e => !isSameUser({ login: e.user }, username)));
                const latestMine = mine[0] || null;
                const latestOther = others[0] || null;
                const headSha = pr.head?.sha || null;
                const latestActivityAt = events[0]?.date || toDate(pr.updated_at);
                const seen = isSeen(seenPRs, pr.html_url || item.html_url, latestActivityAt);

                const common = {
                    title: pr.title || item.title || `PR #${item.number}`,
                    url: pr.html_url || item.html_url,
                    updated_at: pr.updated_at,
                    head_sha: headSha,
                    number: item.number,
                    repository: `${owner}/${repo}`,
                    author: loginOf(pr.user) || username,
                    latest_activity_at: latestActivityAt.toISOString(),
                    has_conflict: pr.mergeable === false || pr.mergeable_state === 'dirty',
                };

                // Conflictos de Merge
                if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
                    if (includeSeen || !seen) {
                        alerts.merge_conflicts.push({
                            ...common,
                            state: '💥 Conflictos de Merge (Bloqueado)',
                        });
                    }
                }

                // CASO C: Mi propio PR
                if (isSameUser(pr.user, username)) {
                    const otherFormal = others.find(e => e.type === 'review' && ['CHANGES_REQUESTED', 'APPROVED'].includes(e.state));
                    const newOther = latestOther && (!latestMine || latestOther.date > latestMine.date);
                    
                    let detail = null;
                    if (otherFormal?.state === 'CHANGES_REQUESTED') {
                        detail = `Cambios pedidos por @${otherFormal.user} ⚠️`;
                    } else if (otherFormal?.state === 'APPROVED') {
                        detail = `Aprobado por @${otherFormal.user} ✅`;
                    } else if (newOther) {
                        detail = `Comentario de @${latestOther.user} 💬`;
                    } else if (others.length > 0) {
                        detail = `Actividad reciente en tu PR 💬`;
                    } else {
                        detail = `Abierto y esperando revisión ⏳`;
                    }

                    if (includeSeen || !seen) {
                        alerts.my_pr_activity.push({
                            ...common,
                            state: detail,
                        });
                    }
                    continue;
                }

                // CASOS A y B: PRs de otros
                const requested = (pr.requested_reviewers || []).some(r => isSameUser(r, username));
                if (requested && !latestMine) {
                    if (includeSeen || !seen) {
                        alerts.review_required.push({
                            ...common,
                            state: 'Revisión Requerida: Asignado ⏳',
                        });
                    }
                    continue;
                }

                if (latestMine) {
                    const newCommits = Boolean(headSha && latestMine.headSha && headSha !== latestMine.headSha)
                        || Boolean(toDate(pr.updated_at) > latestMine.date);
                    const newOtherActivity = latestOther && latestOther.date > latestMine.date;

                    if ((newCommits || newOtherActivity) && (includeSeen || !seen)) {
                        let detail = 'Commits nuevos 🔄';
                        if (newOtherActivity && !newCommits) detail = `Respuesta de @${latestOther.user} 💬`;
                        if (newOtherActivity && newCommits) detail = `Commits o respuesta de @${latestOther.user} 💬`;
                        alerts.re_review_needed.push({
                            ...common,
                            state: `Re-revisión Pendiente: ${detail}`,
                        });
                    }
                }
            }

            for (const key of ['merge_conflicts', 'review_required', 're_review_needed', 'my_pr_activity']) {
                alerts[key].sort((a, b) => toDate(b.latest_activity_at || b.updated_at) - toDate(a.latest_activity_at || a.updated_at));
            }
            alerts.meta.rateLimit = this.lastRateLimit;
            return alerts;
        } catch (error) {
            console.error('Error fetching GitHub PR status:', error.message);
            return null;
        }
    }
}

module.exports = GitHubService;
