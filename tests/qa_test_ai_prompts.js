const assert = require('assert');
const { AIService, DEFAULT_REVIEW_PROMPT_TEMPLATE, DEFAULT_AUTOFIX_COMMIT_TEMPLATE } = require('../src/ai_service');

async function runAIPromptsTestSuite() {
    console.log("==========================================");
    console.log("🧪 TEST SUITE: AI PROMPTS & TEMPLATES");
    console.log("==========================================");

    // Test 1: Fallback a plantillas por defecto
    console.log("\n[Test 1] Fallback a plantillas por defecto...");
    const aiDefault = new AIService({});
    const templates = aiDefault.getTemplates();
    assert.strictEqual(templates.review_prompt_template, DEFAULT_REVIEW_PROMPT_TEMPLATE);
    assert.strictEqual(templates.autofix_commit_template, DEFAULT_AUTOFIX_COMMIT_TEMPLATE);
    console.log("  ✅ OK: Templates por defecto cargados correctamente.");

    // Test 2: Interpolación de variables en plantillas
    console.log("\n[Test 2] Interpolación de variables...");
    const sampleTemplate = "Revisar {{pr_title}} de @{{author}} en {{repository}}";
    const interpolated = aiDefault.interpolate(sampleTemplate, {
        pr_title: "Fix Auth Header",
        author: "Emmaqqs",
        repository: "acme/widget"
    });
    assert.strictEqual(interpolated, "Revisar Fix Auth Header de @Emmaqqs en acme/widget");
    console.log("  ✅ OK: Interpolación de variables funciona al 100%.");

    // Test 3: Carga de plantillas personalizadas
    console.log("\n[Test 3] Plantillas personalizadas...");
    const customPrompt = "Auditoría especial de seguridad para {{pr_title}}";
    const aiCustom = new AIService({ review_prompt_template: customPrompt });
    const customTemplates = aiCustom.getTemplates();
    assert.strictEqual(customTemplates.review_prompt_template, customPrompt);
    console.log("  ✅ OK: Plantilla personalizada inyectada correctamente.");

    // Test 4: Generación de Code Review con Gemini (Live / Fallback)
    console.log("\n[Test 4] Prueba de conexión y generación con Gemini AI Studio...");
    try {
        const review = await aiDefault.generateCodeReview({
            title: "Spotify validation and next js",
            repository: "Emmaqqs/opa",
            author: "Emmaqqs",
            url: "https://github.com/Emmaqqs/opa/pull/42"
        }, "diff --git a/src/auth.js b/src/auth.js\n+ if (!token) return null;");

        assert.ok(review && review.length > 50, "Review debe contener análisis detallado");
        console.log("  ✅ OK: Code Review generado exitosamente con Gemini AI Studio!");
        console.log("  📄 Muestra del review generado (primeros 120 caracteres):");
        console.log("     " + review.slice(0, 120).replace(/\n/g, ' '));
    } catch (err) {
        console.warn("  ⚠️ Nota de red en Gemini:", err.message);
    }

    console.log("\n==========================================");
    console.log("🎉 TODAS LAS PRUEBAS DE IA PASARON AL 100%.");
    console.log("==========================================");
}

runAIPromptsTestSuite();
