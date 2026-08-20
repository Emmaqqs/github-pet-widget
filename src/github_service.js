let OctokitModule;

class GitHubService {
    constructor(token) {
        this.token = token;
        this.octokit = null;
        this.username = null;
    }

    async getOctokit() {
        if (!this.octokit) {
            if (!OctokitModule) {
                const mod = await import("octokit");
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
            console.error("Auth verification error:", error.status || error.message);
            return null;
        }
    }

    async getStatus(seenPRs = {}) {
        function isSeen(url, updatedAt) {
            if (!seenPRs[url]) return false;
            return new Date(updatedAt) <= new Date(seenPRs[url]);
        }

        try {
            const octokit = await this.getOctokit();
            if (!this.username) {
                const user = await this.verifyUser();
                if (!user) return null;
            }

            const username = this.username;

            // Búsqueda de PRs abiertos involucrados usando el endpoint oficial GET /search/issues
            let searchResults;
            if (typeof octokit.request === 'function') {
                const res = await octokit.request('GET /search/issues', {
                    q: `is:pr is:open involves:${username}`,
                    per_page: 50,
                    headers: { 'X-GitHub-Api-Version': '2022-11-28' }
                });
                searchResults = res.data;
            } else if (octokit.rest && octokit.rest.search) {
                const res = await octokit.rest.search.issuesAndPullRequests({
                    q: `is:pr is:open involves:${username}`,
                });
                searchResults = res.data;
            } else {
                searchResults = { items: [] };
            }

            const alerts = {
                review_required: [], // Caso A
                re_review_needed: [], // Caso B
                my_pr_activity: [],  // Caso C
            };

            for (const item of (searchResults.items || [])) {
                const parts = item.repository_url.split("/");
                const owner = parts[parts.length - 2];
                const repo = parts[parts.length - 1];
                const pr_number = item.number;

                // 1. Obtener detalles del PR
                const { data: pr } = await octokit.rest.pulls.get({
                    owner,
                    repo,
                    pull_number: pr_number,
                });

                // 2. Obtener reviews formales
                const { data: reviews } = await octokit.rest.pulls.listReviews({
                    owner,
                    repo,
                    pull_number: pr_number,
                });

                // 3. Obtener comentarios inline en el código (review comments)
                let reviewComments = [];
                try {
                    const { data: rc } = await octokit.rest.pulls.listReviewComments({
                        owner,
                        repo,
                        pull_number: pr_number,
                    });
                    reviewComments = rc || [];
                } catch (_) {}

                // 4. Obtener comentarios generales de discusión (issue comments)
                let issueComments = [];
                try {
                    const { data: ic } = await octokit.rest.issues.listComments({
                        owner,
                        repo,
                        issue_number: pr_number,
                    });
                    issueComments = ic || [];
                } catch (_) {}

                // Recopilar toda la actividad cronológica
                const myActivities = [];
                const othersActivities = [];

                // Analizar reviews formales
                for (const r of (reviews || [])) {
                    const date = new Date(r.submitted_at || r.created_at);
                    if (r.user && r.user.login === username) {
                        myActivities.push({ type: 'review', state: r.state, date });
                    } else if (r.user) {
                        othersActivities.push({ user: r.user.login, type: 'review', state: r.state, date });
                    }
                }

                // Analizar comentarios de código
                for (const c of reviewComments) {
                    const date = new Date(c.created_at);
                    if (c.user && c.user.login === username) {
                        myActivities.push({ type: 'comment', date });
                    } else if (c.user) {
                        othersActivities.push({ user: c.user.login, type: 'comment', date, body: c.body });
                    }
                }

                // Analizar comentarios de discusión
                for (const c of issueComments) {
                    const date = new Date(c.created_at);
                    if (c.user && c.user.login === username) {
                        myActivities.push({ type: 'comment', date });
                    } else if (c.user) {
                        othersActivities.push({ user: c.user.login, type: 'comment', date, body: c.body });
                    }
                }

                // Ordenar actividades por fecha más reciente
                myActivities.sort((a, b) => b.date - a.date);
                othersActivities.sort((a, b) => b.date - a.date);

                const lastMyActivity = myActivities[0] || null;
                const lastOtherActivity = othersActivities[0] || null;
                const prUpdatedAt = new Date(pr.updated_at);

                // ============================================================
                // CASO C: Mi propio PR (donde yo soy el autor)
                // ============================================================
                if (pr.user.login === username) {
                    const lastReview = (reviews || []).filter(r => r.user && r.user.login !== username).pop();
                    if (lastReview && lastReview.state === "CHANGES_REQUESTED") {
                        if (!isSeen(pr.html_url, pr.updated_at)) {
                            alerts.my_pr_activity.push({
                                title: pr.title,
                                url: pr.html_url,
                                updated_at: pr.updated_at,
                                state: `Cambios solicitados por @${lastReview.user?.login || 'reviewer'} ⚠️`
                            });
                        }
                    } else if (lastReview && lastReview.state === "APPROVED") {
                        if (!isSeen(pr.html_url, pr.updated_at)) {
                            alerts.my_pr_activity.push({
                                title: pr.title,
                                url: pr.html_url,
                                updated_at: pr.updated_at,
                                state: `Aprobado por @${lastReview.user?.login || 'reviewer'} ✅`
                            });
                        }
                    } else if (lastOtherActivity && (!lastMyActivity || lastOtherActivity.date > lastMyActivity.date)) {
                        if (!isSeen(pr.html_url, pr.updated_at)) {
                            alerts.my_pr_activity.push({
                                title: pr.title,
                                url: pr.html_url,
                                updated_at: pr.updated_at,
                                state: `Nuevo comentario de @${lastOtherActivity.user} 💬`
                            });
                        }
                    }
                } else {
                    // ============================================================
                    // CASOS A y B: PRs de otros donde participo o me asignaron
                    // ============================================================
                    const isRequested = (pr.requested_reviewers || []).some(r => r.login === username);

                    if (isRequested && !lastMyActivity) {
                        // CASO A: Me asignaron y no he dejado ninguna review ni comentario
                        if (!isSeen(pr.html_url, pr.updated_at)) {
                            alerts.review_required.push({
                                title: pr.title,
                                url: pr.html_url,
                                updated_at: pr.updated_at,
                                state: `Revisión pendiente (Asignado)`
                            });
                        }
                    } else if (lastMyActivity) {
                        // CASO B: Ya revisé o comenté previamente
                        const hasNewCommits = prUpdatedAt > lastMyActivity.date;
                        const hasNewReplies = lastOtherActivity && lastOtherActivity.date > lastMyActivity.date;

                        if (hasNewCommits || hasNewReplies) {
                            let detail = "Nuevos commits 🔄";
                            if (hasNewReplies && !hasNewCommits) {
                                detail = `Respuesta de @${lastOtherActivity.user} 💬`;
                            } else if (hasNewReplies && hasNewCommits) {
                                detail = `Commits y respuesta de @${lastOtherActivity.user} 🔄`;
                            }

                            if (!isSeen(pr.html_url, pr.updated_at)) {
                                alerts.re_review_needed.push({
                                    title: pr.title,
                                    url: pr.html_url,
                                    updated_at: pr.updated_at,
                                    state: detail
                                });
                            }
                        }
                    }
                }
            }

            return alerts;
        } catch (error) {
            console.error("Error fetching GitHub PR status:", error.message);
            return null;
        }
    }
}

module.exports = GitHubService;