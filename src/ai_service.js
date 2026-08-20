const https = require('https');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const DEFAULT_REVIEW_PROMPT_TEMPLATE = `Actúa como un Senior Staff Software Engineer realizando un Code Review exhaustivo para el siguiente Pull Request.

Título del PR: {{pr_title}}
Repositorio: {{repository}}
Autor: @{{author}}
URL: {{pr_url}}

### CRITERIOS DE REVISIÓN:
1. 🛡️ Seguridad: Inyecciones, exposición de secretos, sanitización de inputs, validación de permisos.
2. 🚀 Rendimiento y Escalabilidad: Complejidad algorítmica, operaciones bloqueantes, consumo de memoria.
3. 🧹 Clean Code y Arquitectura: Principios SOLID, DRY, nombres claros, manejo de errores robusto.
4. 🧪 Cobertura de Pruebas: Casos límite, regresiones potenciales, tests faltantes.

### FORMATO DE SALIDA (Usa Markdown profesional):
## 📋 Resumen Ejecutivo
(1-2 oraciones resumiendo el propósito y la calidad del cambio)

## 🚦 Veredicto
- **Estado sugerido:** [ ✅ APROBAR / ⚠️ REQUERIR CAMBIOS / 💬 COMENTARIOS ]

## 🔍 Hallazgos Principales
(Lista de puntos clave identificados con nivel de severidad: [ALTA], [MEDIA], [BAJA])

## 💡 Sugerencias y Mejoras de Código
(Comentarios específicos con fragmentos de código sugeridos)
`;

const DEFAULT_AUTOFIX_COMMIT_TEMPLATE = `fix({{scope}}): {{summary}}

- Resuelve feedback de @{{reviewer}}: {{feedback_details}}
- Archivos modificados: {{modified_files}}
`;

const DEFAULT_MERGE_CONFLICT_TEMPLATE = `Analiza el conflicto de merge entre la rama base ({{base_branch}}) y la rama del PR ({{head_branch}}).
Prioriza la integridad lógica del sistema, preservando las nuevas funcionalidades sin borrar código crítico de la rama base.
`;

const GEMINI_MODELS_POOL = [
    'gemini-3.5-flash',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.7-flash'
];

function loadGoogleKeys(explicitConfig = {}) {
    if (Array.isArray(explicitConfig.googleKeys) && explicitConfig.googleKeys.length > 0) {
        return explicitConfig.googleKeys;
    }
    try {
        const appDataPath = path.join(process.env.APPDATA || '', 'github-pet-widget', 'config.json');
        if (fs.existsSync(appDataPath)) {
            const appConfig = JSON.parse(fs.readFileSync(appDataPath, 'utf8'));
            if (Array.isArray(appConfig.googleKeys) && appConfig.googleKeys.length > 0) {
                return appConfig.googleKeys;
            }
        }
    } catch (_) {}

    try {
        const openClawConfigPath = 'D:\\OpenClaw\\data\\openclaw.json';
        if (fs.existsSync(openClawConfigPath)) {
            const oc = JSON.parse(fs.readFileSync(openClawConfigPath, 'utf8'));
            const keys = [];
            if (oc.auth?.profiles) {
                Object.values(oc.auth.profiles).forEach(p => {
                    if (p.provider === 'google' && p.key) keys.push(p.key);
                });
            }
            if (keys.length > 0) return keys;
        }
    } catch (_) {}

    return [];
}

class AIService {
    constructor(config = {}) {
        this.config = config;
        this.googleKeys = loadGoogleKeys(config);
        this.currentKeyIndex = 0;
        this.currentModelIndex = 0;
    }

    getTemplates() {
        return {
            review_prompt_template: this.config.review_prompt_template || DEFAULT_REVIEW_PROMPT_TEMPLATE,
            autofix_commit_template: this.config.autofix_commit_template || DEFAULT_AUTOFIX_COMMIT_TEMPLATE,
            merge_conflict_template: this.config.merge_conflict_template || DEFAULT_MERGE_CONFLICT_TEMPLATE,
        };
    }

    interpolate(template, variables) {
        let result = template;
        for (const [key, value] of Object.entries(variables)) {
            const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
            result = result.replace(regex, String(value ?? ''));
        }
        return result;
    }

    // 1. LLAMADA PRIMARIA A OPENAI LUNA (VÍA OPENCLAW AGENT MAIN)
    async callOpenAILuna(prompt) {
        return new Promise((resolve, reject) => {
            const tempPromptFile = path.join('D:\\OpenClaw\\workspace', `prompt_${Date.now()}.txt`);
            fs.writeFileSync(tempPromptFile, prompt, 'utf8');

            const cmd = `openclaw agent --agent main --message "Lee el archivo ${tempPromptFile} y genera la respuesta solicitada."`;
            exec(cmd, { cwd: 'D:\\OpenClaw', timeout: 60000 }, (error, stdout, stderr) => {
                try { fs.unlinkSync(tempPromptFile); } catch (_) {}

                if (!error && stdout && stdout.length > 20) {
                    const lines = stdout.split('\n');
                    const cleanLines = lines.filter(l => 
                        !l.startsWith('[plugins]') && 
                        !l.startsWith('EMBEDDED FALLBACK') &&
                        !l.startsWith('Gateway target') &&
                        !l.startsWith('Source:') &&
                        !l.startsWith('Config:') &&
                        !l.startsWith('Bind:') &&
                        !l.startsWith('Possible causes') &&
                        !l.includes('openclaw doctor') &&
                        !l.startsWith('tools policy:') &&
                        !l.startsWith('[tools]') &&
                        !l.startsWith('[agents/tool-policy]') &&
                        !l.startsWith('[agent/embedded]') &&
                        !l.startsWith('[agent] run')
                    );
                    const cleanResponse = cleanLines.join('\n').trim();
                    if (cleanResponse.length > 10) {
                        console.log('[AI Engine] ✅ Respuesta generada exitosamente con OpenAI Luna.');
                        return resolve(cleanResponse);
                    }
                }
                reject(new Error(stderr || error?.message || 'OpenClaw Luna no devolvió contenido'));
            });
        });
    }

    // 2. LLAMADA DE RESPALDO A GOOGLE GEMINI (POOL MULTI-MODELO)
    async callGeminiWithRotation(prompt) {
        if (!this.googleKeys || this.googleKeys.length === 0) {
            this.googleKeys = loadGoogleKeys(this.config);
        }

        const totalModels = GEMINI_MODELS_POOL.length;
        const totalKeys = this.googleKeys.length > 0 ? this.googleKeys.length : 1;

        for (let m = 0; m < totalModels; m++) {
            const model = GEMINI_MODELS_POOL[(this.currentModelIndex + m) % totalModels];
            for (let k = 0; k < totalKeys; k++) {
                const key = this.googleKeys.length > 0 ? this.googleKeys[(this.currentKeyIndex + k) % totalKeys] : null;
                if (!key) continue;
                try {
                    const result = await this._requestGemini(key, model, prompt);
                    this.currentModelIndex = (this.currentModelIndex + m) % totalModels;
                    this.currentKeyIndex = (this.currentKeyIndex + k) % totalKeys;
                    console.log(`[AI Engine] ✅ Respuesta generada con Gemini (${model}).`);
                    return result;
                } catch (err) {
                    continue;
                }
            }
        }
        throw new Error('Todas las opciones de IA fallaron.');
    }

    _requestGemini(apiKey, model, prompt) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 4096,
                }
            });

            const path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;
            const options = {
                hostname: 'generativelanguage.googleapis.com',
                port: 443,
                path: path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout: 25000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text) resolve(text);
                            else reject(new Error('Respuesta vacía de Gemini'));
                        } else {
                            reject(new Error(json.error?.message || `HTTP ${res.statusCode}`));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout en solicitud a Gemini'));
            });

            req.write(payload);
            req.end();
        });
    }

    // MOTOR HÍBRIDO: 1. OpenAI Luna -> 2. Gemini
    async executePromptWithFallback(prompt) {
        try {
            return await this.callOpenAILuna(prompt);
        } catch (lunaErr) {
            console.log(`[AI Engine] Nota de OpenAI Luna (${lunaErr.message}). Usando Gemini Pool de respaldo...`);
            return await this.callGeminiWithRotation(prompt);
        }
    }

        // CLASIFICADOR SEMÁNTICO DE INTENCIÓN DE COMENTARIOS
    async classifyCommentIntent(commentBody) {
        if (!commentBody || typeof commentBody !== 'string' || commentBody.trim().length === 0) {
            return { type: 'INFORMATIONAL', summary: 'Sin comentarios', requiresChange: false };
        }

        const prompt = `Analiza el siguiente comentario de Code Review dejado por un revisor en un Pull Request:

COMENTARIO:
"${commentBody.slice(0, 2000)}"

CRITERIOS ESTRICTOS:
1. Si el comentario contiene CUALQUIER sugerencia de cambio, ajuste menor, detalle técnico, o nota pendiente (incluso si el revisor dice "aprobado", "LGTM", "buen trabajo" o "sin bloqueantes pero revisa X"): clasifícalo como REQUIRES_CODE_CHANGE con requiresChange: true.
2. ÚNICAMENTE clasifica como APPROVED_NO_BLOCKERS cuando la aprobación sea 100% limpia y NO mencione absolutamente ningún cambio, sugerencia o detalle pendiente.
3. Si es una simple pregunta o confirmación sin acciones, clasifícalo como INFORMATIONAL.

Responde ÚNICAMENTE con un JSON válido con este formato:
{
  "type": "APPROVED_NO_BLOCKERS" | "REQUIRES_CODE_CHANGE" | "INFORMATIONAL",
  "summary": "1 frase corta resumiendo la intención exacta",
  "requiresChange": true | false
}`;

        try {
            const raw = await this.executePromptWithFallback(prompt);
            const clean = raw.replace(/^\`\`\`json\n?/g, '').replace(/\n?\`\`\`$/g, '').trim();
            const parsed = JSON.parse(clean);
            return {
                type: parsed.type || 'INFORMATIONAL',
                summary: parsed.summary || commentBody.slice(0, 50),
                requiresChange: Boolean(parsed.requiresChange)
            };
        } catch (_) {
            const lower = commentBody.toLowerCase();
            const hasPendingMention = lower.includes('pero') || lower.includes('falta') || lower.includes('cambia') || lower.includes('corrige') || lower.includes('revisa') || lower.includes('non-block') || lower.includes('detalle');
            const isPureApproval = (lower.includes('aprobado') || lower.includes('lgtm') || lower.includes('buen trabajo') || lower.includes('sin bloqueantes')) && !hasPendingMention;
            return {
                type: isPureApproval ? 'APPROVED_NO_BLOCKERS' : 'REQUIRES_CODE_CHANGE',
                summary: commentBody.slice(0, 50),
                requiresChange: !isPureApproval
            };
        }
    }

    async generateCodeReview(pr, diff) {
        const templates = this.getTemplates();
        const basePrompt = this.interpolate(templates.review_prompt_template, {
            pr_title: pr.title,
            repository: pr.repository || 'repo',
            author: pr.author,
            pr_url: pr.url
        });

        const diffExcerpt = (diff || '').slice(0, 30000);
        const fullPrompt = basePrompt + '\n\n### DIFF DEL PULL REQUEST:\n```diff\n' + diffExcerpt + '\n```';
        return await this.executePromptWithFallback(fullPrompt);
    }
}

module.exports = {
    AIService,
    DEFAULT_REVIEW_PROMPT_TEMPLATE,
    DEFAULT_AUTOFIX_COMMIT_TEMPLATE,
    DEFAULT_MERGE_CONFLICT_TEMPLATE
};
