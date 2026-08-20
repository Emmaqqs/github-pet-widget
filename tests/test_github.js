const GitHubService = require('../src/github_service');
require('dotenv').config();

async function runTests() {
    console.log("🧪 Iniciando pruebas de GitHubService...");
    
    if (!process.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN === 'your_p…here') {
        console.error("❌ ERROR: No se ha configurado GITHUB_TOKEN en el archivo .env");
        console.log("   Por favor, edita D:\\OpenClaw\\workspace\\github-pet-widget\\.env");
        process.exit(1);
    }

    const service = new GitHubService();

    try {
        console.log("📡 Conectando con GitHub API...");
        const alerts = await service.getStatus();
        
        if (alerts) {
            console.log("✅ Conexión exitosa.");
            console.log("📊 Resumen de PRs:");
            console.log(`   - Review Required: ${alerts.review_required.length}`);
            console.log(`   - Re-review Needed: ${alerts.re_review_needed.length}`);
            console.log(`   - My PR Activity: ${alerts.my_pr_activity.length}`);
            
            console.log("\n🚀 Prueba finalizada con éxito.");
        } else {
            console.error("❌ Falló la obtención de datos.");
        }
    } catch (error) {
        console.error("❌ Error durante la ejecución del test:", error.message);
    }
}

runTests();