const fs = require('fs');
const path = require('path');
const config = require('./src/services/openRouterMatcher/config');
const { runSafeReasoner } = require('./src/services/openRouterMatcher/argumentExtractor');

// Manually parse .env to avoid dotenv dependency
try {
    const envPath = path.join(__dirname, '../.env');
    const envFile = fs.readFileSync(envPath, 'utf8');
    envFile.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            const val = match[2].trim().replace(/^["'](.*)["']$/, '$1');
            if (!process.env[key]) process.env[key] = val;
        }
    });
} catch (e) {
    console.log("No .env file found or couldn't parse it.");
}

async function testHeavy() {
    const filePath = path.join(__dirname, '../recherche/dissipating_glut.txt');
    let content = fs.readFileSync(filePath, 'utf8');

    // enable for test
    config.isEnabled = true;
    config.reasoner.enabled = true;
    if (!config.openRouterApiKey && process.env.OPENROUTER_API_KEY) {
        config.openRouterApiKey = process.env.OPENROUTER_API_KEY;
    }

    const wordCount = content.split(/\s+/).filter(Boolean).length;
    console.log(`Word count: ${wordCount}`);

    // Ensure we don't blow up context limit unnecessarily, limit to 20000 chars if too long
    // But let's keep the whole thing if we want the full heavy test

    console.log("Running " + config.reasoner.heavyModel + " on the PDF text...");
    console.log("--------------------------------------------------------------------------------");

    try {
        const result = await runSafeReasoner({
            postContent: content,
            candidates: [{ event_id: 1, title: 'Dummy Macroeconomics Market', match_score: 1.0, match_method: 'test' }],
            overrideModel: config.reasoner.heavyModel,
            overrideFallbackModels: config.reasoner.heavyFallbackModels
        });

        console.log("Result:");
        console.log(JSON.stringify(result, null, 2));

        // Write out the result to a markdown file to easily review
        const outPath = path.join(__dirname, `../recherche/gemini-3.1-pro-exp-analysis.json`);
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
        console.log(`Saved output to ${outPath}`);

    } catch (err) {
        console.error("Test failed:");
        console.error(err);
    }
}

testHeavy().catch(console.error);
