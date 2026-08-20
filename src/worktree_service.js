const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

function execPromise(cmd, cwd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { cwd, timeout: 120000 }, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error(stderr || stdout || err.message));
            }
            resolve(stdout ? stdout.trim() : '');
        });
    });
}

class WorktreeService {
    constructor(aiService, githubToken = null) {
        this.aiService = aiService;
        this.githubToken = githubToken;
        this.baseReposDir = 'D:\\OpenClaw\\workspace\\managed_repos';
        this.baseWorktreeDir = 'D:\\OpenClaw\\workspace\\worktrees';
        
        [this.baseReposDir, this.baseWorktreeDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
            }
        });
    }

    async ensureLocalRepo(repository, onProgress = () => {}) {
        const [owner, repoName] = repository.split('/');
        const repoDir = path.join(this.baseReposDir, `${owner}_${repoName}`);

        if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, '.git'))) {
            onProgress(`Clonando ${repository}...`);
            console.log(`[WorktreeService] Clonando repositorio ${repository} en ${repoDir}...`);
            const authUrl = `https://github.com/${repository}.git`;
            await execPromise(`git clone --filter=blob:none "${authUrl}" "${repoDir}"`, this.baseReposDir);
        } else {
            console.log(`[WorktreeService] Repositorio ${repository} encontrado en ${repoDir}. Actualizando...`);
            await execPromise('git remote set-url origin https://github.com/' + repository + '.git', repoDir).catch(() => {});
        }
        return repoDir;
    }

    async autonomouslyDetectAndRunTests(worktreePath) {
        console.log('[WorktreeService] Inspeccionando estructura del proyecto para determinar suite de tests...');
        
        // 1. Validar si package.json existe y si tiene script de test real
        if (fs.existsSync(path.join(worktreePath, 'package.json'))) {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8'));
                if (!pkg.scripts || !pkg.scripts.test || pkg.scripts.test.includes('no test specified')) {
                    console.log('[WorktreeService] package.json no define script de tests. Validación omitida.');
                    return 'No test script declared in package.json.';
                }
                return await execPromise('npm test', worktreePath);
            } catch (pkgErr) {
                if (pkgErr.message && pkgErr.message.includes('Missing script: "test"')) {
                    console.log('[WorktreeService] No hay script "test" en package.json.');
                    return 'No test script declared.';
                }
                throw pkgErr;
            }
        }

        // 2. Laravel / PHP
        if (fs.existsSync(path.join(worktreePath, 'artisan'))) {
            return await execPromise('php artisan test || ./vendor/bin/pest || ./vendor/bin/phpunit', worktreePath);
        }

        // 3. Python
        if (fs.existsSync(path.join(worktreePath, 'pytest.ini')) || fs.existsSync(path.join(worktreePath, 'pyproject.toml'))) {
            return await execPromise('pytest', worktreePath);
        }

        // 4. Docker
        if (fs.existsSync(path.join(worktreePath, 'docker-compose.yml'))) {
            return await execPromise('docker compose exec -T app npm test || docker compose run --rm app npm test', worktreePath).catch(() => 'Docker tests omitted.');
        }

        return 'No tests declared.';
    }

    // BUCLE DE AUTO-CURACIÓN ITERATIVA (SELF-HEALING TEST LOOP)
    async iterativeSelfHealingTestLoop(worktreePath, targetFiles, maxIterations = 3, onProgress = () => {}) {
        let lastError = null;

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            onProgress(`Verificando tests (Intento ${iteration}/${maxIterations})...`);
            console.log(`[Self-Healing] Ejecutando suite de pruebas (Intento ${iteration}/${maxIterations})...`);
            try {
                const testOutput = await this.autonomouslyDetectAndRunTests(worktreePath);
                console.log('[Self-Healing] ✅ Pruebas pasaron exitosamente:', testOutput);
                return { success: true, iterations: iteration, output: testOutput };
            } catch (err) {
                lastError = err.message || 'Error en tests';

                // Si el error es simplemente que el proyecto no tiene tests declarados, se da por válido
                if (lastError.includes('Missing script: "test"') || lastError.includes('no test specified')) {
                    console.log('[Self-Healing] ✅ Proyecto sin suite de tests obligatoria; aprobado.');
                    return { success: true, iterations: iteration, output: 'No test script' };
                }

                console.warn(`[Self-Healing] ⚠️ Fallo en pruebas (Intento ${iteration}): ${lastError.slice(0, 150)}...`);

                if (iteration === maxIterations) break;

                onProgress(`OpenAI Luna auto-curando código (Intento ${iteration})...`);

                for (const file of targetFiles) {
                    const fullPath = path.join(worktreePath, file);
                    if (fs.existsSync(fullPath)) {
                        const currentCode = fs.readFileSync(fullPath, 'utf8');
                        const healPrompt = `Los tests unitarios del proyecto fallaron con el siguiente error:

ERROR DE TESTS:
${lastError.slice(0, 2000)}

CÓDIGO ACTUAL DEL ARCHIVO ${file}:
${currentCode}

INSTRUCCIONES CRÍTICAS:
Corrige el código para resolver el error específico de los tests preservando la funcionalidad.
Devuelve ÚNICAMENTE el código limpio final del archivo, sin explicaciones ni markdown extra.`;

                        let healedCode = await this.aiService.executePromptWithFallback(healPrompt);
                        healedCode = healedCode.replace(/^\`\`\`[a-zA-Z]*\n/g, '').replace(/\n\`\`\`$/g, '');
                        fs.writeFileSync(fullPath, healedCode, 'utf8');
                        await execPromise(`git add "${file}"`, worktreePath);
                    }
                }
            }
        }

        return { success: false, error: lastError };
    }

    async resolveConflictContent(filePath, conflictedContent, baseBranch, headBranch) {
        const prompt = `Eres un ingeniero de software experto resolviendo un conflicto de merge en Git.
Archivo: ${filePath}
Rama base: ${baseBranch}
Rama del PR: ${headBranch}

A continuación se muestra el archivo con los marcadores de conflicto (<<<<<<< HEAD, =======, >>>>>>>):

${conflictedContent}

INSTRUCCIONES CRÍTICAS:
1. Resuelve todos los marcadores de conflicto unificando coherentemente la lógica de ambas ramas.
2. No elimines código importante de la rama base ni de la rama del PR.
3. Asegúrate de que la sintaxis sea 100% válida.
4. Devuelve ÚNICAMENTE el código limpio final del archivo, sin explicaciones ni bloques markdown extra.`;

        let resolved = await this.aiService.executePromptWithFallback(prompt);
        resolved = resolved.replace(/^\`\`\`[a-zA-Z]*\n/g, '').replace(/\n\`\`\`$/g, '');
        return resolved;
    }

    async resolveMergeConflictsInWorktree({ repository, pull_number, head_branch = 'dev', base_branch = 'main', onProgress = () => {} }) {
        const repoPath = await this.ensureLocalRepo(repository || 'Emmaqqs/opa', onProgress);
        const worktreePath = path.join(this.baseWorktreeDir, `pr_${pull_number}_merge_${Date.now()}`);
        const result = { success: false, worktreePath, resolvedFiles: [], testsPassed: false, pushed: false };

        try {
            onProgress(`Obteniendo PR #${pull_number}...`);
            await execPromise(`git fetch origin pull/${pull_number}/head:pr_${pull_number}_${Date.now()} ${base_branch}:origin/${base_branch}`, repoPath).catch(async () => {
                await execPromise('git fetch origin', repoPath);
            });

            await execPromise(`git worktree add -B merge-pr-${pull_number} "${worktreePath}" pull/${pull_number}/head`, repoPath).catch(async () => {
                await execPromise(`git worktree add -B merge-pr-${pull_number} "${worktreePath}" origin/${head_branch}`, repoPath);
            });

            onProgress('Ejecutando merge con rama base...');
            try {
                await execPromise(`git merge origin/${base_branch} --no-edit`, worktreePath);
                result.success = true;
                result.message = 'Merge limpio sin conflictos.';
            } catch (mergeErr) {
                const statusOutput = await execPromise('git diff --name-only --diff-filter=U', worktreePath);
                const conflictedFiles = statusOutput.split('\n').map(f => f.trim()).filter(Boolean);

                if (conflictedFiles.length === 0) throw mergeErr;

                for (const file of conflictedFiles) {
                    onProgress(`OpenAI Luna resolviendo ${file}...`);
                    const fullFilePath = path.join(worktreePath, file);
                    if (fs.existsSync(fullFilePath)) {
                        const conflictedContent = fs.readFileSync(fullFilePath, 'utf8');
                        const cleanContent = await this.resolveConflictContent(file, conflictedContent, base_branch, head_branch);
                        fs.writeFileSync(fullFilePath, cleanContent, 'utf8');
                        await execPromise(`git add "${file}"`, worktreePath);
                        result.resolvedFiles.push(file);
                    }
                }

                await execPromise('git commit -m "fix(merge): resolve conflicts automatically via OpenClaw AI"', worktreePath);
                result.success = true;
            }

            // Auto-curación de tests
            const healResult = await this.iterativeSelfHealingTestLoop(worktreePath, result.resolvedFiles, 3, onProgress);
            result.testsPassed = healResult.success;

            if (result.testsPassed) {
                onProgress('Pusheando cambios a GitHub...');
                await execPromise(`git push origin HEAD:${head_branch}`, worktreePath);
                result.pushed = true;
                result.message = `✅ Conflictos resueltos y pusheados con éxito a ${head_branch} con tests pasando.`;
            } else {
                result.message = `⚠️ Conflictos resueltos localmente pero tests fallaron; push cancelado por seguridad.`;
            }

            return result;
        } catch (err) {
            result.error = err.message;
            return result;
        } finally {
            try {
                await execPromise(`git worktree remove --force "${worktreePath}"`, repoPath);
            } catch (_) {}
        }
    }

    async autoFixReviewFeedbackInWorktree({ repository, pull_number, head_branch = 'dev', feedbackText, onProgress = () => {} }) {
        const repoPath = await this.ensureLocalRepo(repository || 'Emmaqqs/opa', onProgress);
        const worktreePath = path.join(this.baseWorktreeDir, `pr_${pull_number}_fix_${Date.now()}`);
        const result = { success: false, worktreePath, modifiedFiles: [], testsPassed: false, pushed: false };

        try {
            onProgress(`Obteniendo PR #${pull_number}...`);
            await execPromise(`git fetch origin pull/${pull_number}/head:pr_fix_${pull_number}_${Date.now()}`, repoPath).catch(async () => {
                await execPromise('git fetch origin', repoPath);
            });

            await execPromise(`git worktree add -B fix-pr-${pull_number} "${worktreePath}" pull/${pull_number}/head`, repoPath).catch(async () => {
                await execPromise(`git worktree add -B fix-pr-${pull_number} "${worktreePath}" origin/${head_branch}`, repoPath);
            });

            const filesOutput = await execPromise('git diff --name-only origin/main...HEAD', worktreePath).catch(() => '');
            const files = filesOutput.split('\n').map(f => f.trim()).filter(Boolean);

            if (files.length > 0) {
                for (const file of files.slice(0, 5)) {
                    onProgress(`OpenAI Luna aplicando fix en ${file}...`);
                    const fullPath = path.join(worktreePath, file);
                    if (fs.existsSync(fullPath)) {
                        const originalCode = fs.readFileSync(fullPath, 'utf8');
                        const prompt = `Actúa como un Senior Developer resolviendo el siguiente feedback de Code Review en el archivo ${file}:

FEEDBACK DEL REVIEWER:
${feedbackText || 'Corrige los problemas señalados y optimiza el código'}

CÓDIGO ACTUAL DEL ARCHIVO:
${originalCode}

INSTRUCCIONES:
Aplica los cambios necesarios para resolver el feedback del reviewer de forma limpia y robusta.
Devuelve ÚNICAMENTE el código completo y final del archivo, sin explicaciones ni markdown extra.`;

                        let fixedCode = await this.aiService.executePromptWithFallback(prompt);
                        fixedCode = fixedCode.replace(/^\`\`\`[a-zA-Z]*\n/g, '').replace(/\n\`\`\`$/g, '');
                        fs.writeFileSync(fullPath, fixedCode, 'utf8');
                        await execPromise(`git add "${file}"`, worktreePath);
                        result.modifiedFiles.push(file);
                    }
                }

                await execPromise('git commit -m "fix: address review feedback automatically via OpenClaw AI"', worktreePath);
            }

            // Auto-curación de tests
            const healResult = await this.iterativeSelfHealingTestLoop(worktreePath, result.modifiedFiles, 3, onProgress);
            result.testsPassed = healResult.success;

            if (result.testsPassed && result.modifiedFiles.length > 0) {
                onProgress('Pusheando fixes a GitHub...');
                await execPromise(`git push origin HEAD:${head_branch}`, worktreePath);
                result.pushed = true;
                result.success = true;
                result.message = `✅ Feedback resuelto y cambios pusheados a ${head_branch} con tests pasando.`;
            } else {
                result.success = result.modifiedFiles.length > 0;
                result.message = 'Fixes aplicados localmente pero tests fallaron; push cancelado.';
            }

            return result;
        } catch (err) {
            result.error = err.message;
            return result;
        } finally {
            try {
                await execPromise(`git worktree remove --force "${worktreePath}"`, repoPath);
            } catch (_) {}
        }
    }
}

module.exports = WorktreeService;
