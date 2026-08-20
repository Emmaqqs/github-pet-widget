const assert = require('assert');
const GitHubService = require('../src/github_service');

async function testWatchedTeammates() {
    console.log("==========================================");
    console.log("🧪 TEST SUITE: MONITOREO DE COMPAÑEROS");
    console.log("==========================================");

    const mockOctokit = {
        rest: {
            users: {
                getAuthenticated: async () => ({ data: { login: 'Emmaqqs' } })
            },
            search: {
                issuesAndPullRequests: async ({ q }) => {
                    if (q.includes('Jaime-4-1998/kokoa-colab')) {
                        return {
                            data: {
                                items: [
                                    {
                                        number: 55,
                                        repository_url: 'https://api.github.com/repos/Jaime-4-1998/kokoa-colab',
                                        title: 'Feature New Dashboard by Ehtan',
                                        html_url: 'https://github.com/Jaime-4-1998/kokoa-colab/pull/55'
                                    }
                                ]
                            }
                        };
                    }
                    return {
                        data: {
                            items: [
                                {
                                    number: 43,
                                    repository_url: 'https://api.github.com/repos/Emmaqqs/opa',
                                    title: 'Fix Audio Player by Alan',
                                    html_url: 'https://github.com/Emmaqqs/opa/pull/43'
                                }
                            ]
                        }
                    };
                }
            },
            pulls: {
                get: async ({ owner, repo, pull_number }) => {
                    if (pull_number === 55) {
                        return {
                            data: {
                                title: 'Feature New Dashboard by Ehtan',
                                html_url: 'https://github.com/Jaime-4-1998/kokoa-colab/pull/55',
                                user: { login: 'EhtanEsquivel' },
                                requested_reviewers: [],
                                updated_at: '2026-08-20T08:00:00Z',
                                head: { ref: 'feature/dash', sha: 'sha55' },
                                base: { ref: 'main' }
                            }
                        };
                    } else {
                        return {
                            data: {
                                title: 'Fix Audio Player by Alan',
                                html_url: 'https://github.com/Emmaqqs/opa/pull/43',
                                user: { login: 'alannnn-estrada' },
                                requested_reviewers: [],
                                updated_at: '2026-08-20T08:15:00Z',
                                head: { ref: 'fix/audio', sha: 'sha43' },
                                base: { ref: 'main' }
                            }
                        };
                    }
                },
                listReviews: async () => ({ data: [] }),
                listReviewComments: async () => ({ data: [] })
            },
            issues: {
                listComments: async () => ({ data: [] })
            }
        }
    };

    const gh = new GitHubService("fake_token");
    gh.octokit = mockOctokit;
    gh.username = 'Emmaqqs';

    const watchedDevs = {
        "Emmaqqs/opa": ["alannnn-estrada"],
        "Jaime-4-1998/kokoa-colab": ["EhtanEsquivel", "AlexFloRz26"]
    };

    const status = await gh.getStatus({}, false, {}, watchedDevs);

    console.log("[Test 1] Detección de PR de Alan en Emmaqqs/opa...");
    const alanPR = status.all_prs.find(p => p.number === 43);
    assert.ok(alanPR, "El PR de Alan debe estar en all_prs");
    assert.ok(alanPR.tags.includes('monitored'), "Debe incluir el tag 'monitored'");
    assert.strictEqual(alanPR.state, "🎯 Monitoreado: PR de @alannnn-estrada");
    console.log("  ✅ OK: PR de Alan detectado y clasificado como Monitoreado.");

    console.log("[Test 2] Detección de PR de Ehtan en Jaime-4-1998/kokoa-colab...");
    const ehtanPR = status.all_prs.find(p => p.number === 55);
    assert.ok(ehtanPR, "El PR de Ehtan debe ser descubierto en kokoa-colab");
    assert.ok(ehtanPR.tags.includes('monitored'), "Debe incluir el tag 'monitored'");
    assert.strictEqual(ehtanPR.state, "🎯 Monitoreado: PR de @EhtanEsquivel");
    console.log("  ✅ OK: PR de Ehtan en repo externo detectado con éxito.");

    console.log("[Test 3] Verificación en lista alerts.monitored_prs...");
    assert.strictEqual(status.monitored_prs.length, 2, "Deben haber 2 PRs en monitored_prs");
    console.log("  ✅ OK: Ambos PRs agrupados en la categoría Monitoreados.");

    console.log("==========================================");
    console.log("🎉 TODAS LAS PRUEBAS DE MONITOREO PASARON AL 100%.");
    console.log("==========================================");
}

testWatchedTeammates().catch(err => {
    console.error("❌ Falló test:", err);
    process.exit(1);
});
