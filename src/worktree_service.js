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

    async ensureLocalRepo(repository) {
        const [owner, repoName] = repository.split('/');
        const repoDir = path.join(this.baseReposDir, `${owner}_${repoName}`);

        if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, '.git'))) {
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
        
        try {
            const fileList = fs.readdirSync(worktreePath);
            const packageJson = fs.existsSync(path.join(worktreePath, 'package.json')) ? fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8').slice(0, 800) : null;
            const composerJson = fs.existsSync(path.join(worktreePath, 'composer.json')) ? fs.readFileSync(path.join(worktreePath, 'composer.json'), 'utf8').slice(0, 800) : null;
            
            const prompt = `Analiza los siguientes archivos en la raíz del proyecto para determinar el comando de tests unitarios exacto:
Archivos presentes: ${fileList.join(', ')}
${packageJson ? 'package.json: ' + packageJson : ''}
${composerJson ? 'composer.json: ' + composerJson : ''}

INSTRUCCIÓN:
Devuelve ÚNICAMENTE el comando exacto para ejecutar los tests (ejemplo: "npm test", "php artisan test", "docker compose exec -T app php artisan test", "pytest", "go test ./...", "cargo test").
Si el proyecto no tiene tests declarados, devuelve "NONE".`;

            let detectedCommand = await this.aiService.executePromptWithFallback(prompt);
            detectedCommand = detectedCommand.replace(/\`\`/g, '').trim();

            if (detectedCommand && detectedCommand !== 'NONE' && detectedCommand.length < 100) {
                console.log(`[WorktreeService] Agente determinó comando de tests: ${detectedCommand}`);
                return await execPromise(detectedCommand, worktreePath);
            }
        } catch (aiErr) {
            console.log('[WorktreeService] Detección por IA omitida:', aiErr.message);
        }

        // Heurística de respaldo
        if (fs.existsSync(path.join(worktreePath, 'artisan'))) {
            return await execPromise('php artisan test || ./vendor/bin/pest || ./vendor/bin/phpunit', worktreePath);
        }
        if (fs.existsSync(path.join(worktreePath, 'package.json'))) {
            return await execPromise('npm test', worktreePath);
        }
        if (fs.existsSync(path.join(worktreePath, 'pytest.ini')) || fs.existsSync(path.join(worktreePath, 'pyproject.toml'))) {
            return await execPromise('pytest', worktreePath);
        }

        return 'No tests declared.';
    }

    // BUCLE DE AUTO-CURACIÓN ITERATIVA (SELF-HEALING TEST LOOP)
    async iterativeSelfHealingTestLoop(worktreePath, targetFiles, maxIterations = 3) {
        let lastError = null;

        for (let iteration = 1; iteration <= maxIterations; iteration++) {
            console.log(`[Self-Healing] Ejecutando suite de pruebas (Intento ${iteration}/${maxIterations})...`);
            try {
                const testOutput = await this.autonomouslyDetectAndRunTests(worktreePath);
                console.log('[Self-Healing] ✅ Pruebas pasaron exitosamente.');
                return { success: true, iterations: iteration, output: testOutput };
            } catch (err) {
                lastError = err.message || 'Error en tests';
                console.warn(`[Self-Healing] ⚠️ Fallo en pruebas (Intento ${iteration}): ${lastError.slice(0, 150)}...`);

                if (iteration === maxIterations) break;

                // Reparar los archivos objetivo alimentando el error a la IA
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

    async resolveMergeConflictsInWorktree({ repository, pull_number, head_branch = 'dev', base_branch = 'main' }) {
        const repoPath = await this.ensureLocalRepo(repository || 'Emmaqqs/opa');
        const worktreePath = path.join(this.baseWorktreeDir, `pr_${pull_number}_merge_${Date.now()}`);
        const result = { success: false, worktreePath, resolvedFiles: [], testsPassed: false, pushed: false };

        try {
            console.log(`[WorktreeService] Obteniendo PR #${pull_number} vía refspec de GitHub...`);
            await execPromise(`git fetch origin pull/${pull_number}/head:pr_${pull_number}_${Date.now()} ${base_branch}:origin/${base_branch}`, repoPath).catch(async () => {
                await execPromise('git fetch origin', repoPath);
            });

            await execPromise(`git worktree add -B merge-pr-${pull_number} "${worktreePath}" pull/${pull_number}/head`, repoPath).catch(async () => {
                await execPromise(`git worktree add -B merge-pr-${pull_number} "${worktreePath}" origin/${head_branch}`, repoPath);
            });

            try {
                await execPromise(`git merge origin/${base_branch} --no-edit`, worktreePath);
                result.success = true;
                result.message = 'Merge limpio sin conflictos.';
            } catch (mergeErr) {
                const statusOutput = await execPromise('git diff --name-only --diff-filter=U', worktreePath);
                const conflictedFiles = statusOutput.split('\n').map(f => f.trim()).filter(Boolean);

                if (conflictedFiles.length === 0) throw mergeErr;

                for (const file of conflictedFiles) {
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

            // Auto-curación iterativa de tests
            const healResult = await this.iterativeSelfHealingTestLoop(worktreePath, result.resolvedFiles);
            result.testsPassed = healResult.success;

            if (result.testsPassed) {
                await execPromise(`git push origin HEAD:${head_branch}`, worktreePath);
                result.pushed = true;
                result.message = `✅ Conflictos resueltos y pusheados con éxito a ${head_branch} con tests pasando.`;
            } else {
                result.message = `⚠️ Conflictos resueltos localmente pero los tests fallaron tras ${healResult.iterations || 3} intentos; push cancelado por seguridad.`;
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

    async autoFixReviewFeedbackInWorktree({ repository, pull_number, head_branch = 'dev', feedbackText }) {
        const repoPath = await this.ensureLocalRepo(repository || 'Emmaqqs/opa');
        const worktreePath = path.join(this.baseWorktreeDir, `pr_${pull_number}_fix_${Date.now()}`);
        const result = { success: false, worktreePath, modifiedFiles: [], testsPassed: false, pushed: false };

        try {
            console.log(`[WorktreeService] Obteniendo PR #${pull_number} para auto-fix...`);
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

            // Auto-curación iterativa de tests
            const healResult = await this.iterativeSelfHealingTestLoop(worktreePath, result.modifiedFiles);
            result.testsPassed = healResult.success;

            if (result.testsPassed && result.modifiedFiles.length > 0) {
                await execPromise(`git push origin HEAD:${head_branch}`, worktreePath);
                result.pushed = true;
                result.success = true;
                result.message = `✅ Feedback resuelto y cambios pusheados a ${head_branch} con tests pasando.`;
            } else {
                result.success = result.modifiedFiles.length > 0;
                result.message = 'Fixes aplicados localmente pero tests fallaron tras reintentos; push cancelado.';
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
