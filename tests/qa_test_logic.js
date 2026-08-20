const GitHubService = require('../src/github_service');

async function testLogic() {
    console.log("🧪 QA-TEST-02: Verificando lógica de clasificación de PRs...");
    
    // Mock de Octokit
    const mockOctokit = {
        rest: {
            users: { getAuthenticated: async () => ({ data: { login: 'tester' } }) },
            search: { issuesAndPullRequests: async () => ({ data: { items: [
                { number: 1, repository_url: '.../repo', title: 'Review Me', html_url: '...' },
                { number: 2, repository_url: '.../repo', title: 'My PR', html_url: '...' },
                { number: 3, repository_url: '.../repo', title: 'Commit After Comment', html_url: '...' }
            ] } }) },
            pulls: { 
                get: async ({ pull_number }) => {
                    if (pull_number === 1) return { data: { user: { login: 'other' }, requested_reviewers: [{ login: 'tester' }], updated_at: '2026-08-20T00:00:00Z' } };
                    if (pull_number === 3) return { data: { user: { login: 'other' }, requested_reviewers: [], head: { sha: 'new-sha' }, updated_at: '2026-08-20T02:00:00Z' } };
                    return { data: { user: { login: 'tester' }, requested_reviewers: [], updated_at: '2026-08-20T00:00:00Z' } };
                },
                listReviews: async ({ pull_number }) => {
                    if (pull_number === 2) return { data: [{ state: 'APPROVED', user: { login: 'other' } }] };
                    if (pull_number === 3) return { data: [{ state: 'COMMENTED', user: { login: 'tester' }, submitted_at: '2026-08-20T01:00:00Z' }] };
                    return { data: [] };
                }
            }
        }
    };

    const service = new GitHubService('fake-token');
    service.octokit = mockOctokit;

    const alerts = await service.getStatus();
    
    let pass = true;
    if (alerts.review_required.length !== 1) { console.error("❌ Falló: No detectó PR pendiente de revisión."); pass = false; }
    if (alerts.my_pr_activity.length !== 1) { console.error("❌ Falló: No detectó actividad en mi PR."); pass = false; }

    if (pass) console.log("✅ ÉXITO: Lógica de clasificación validada.");
    else process.exit(1);
}

testLogic();
