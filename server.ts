import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Render/Vercel support
const PORT = process.env.PORT || 3001;

// JUDGE0 CONFIG
const JUDGE0_URLS = [
    process.env.JUDGE0_URL,
    'http://172.20.0.10:2358',
    'http://localhost:2358',
    'http://backup:2358'
].filter(Boolean);

// Supabase Config
const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
);

// RATE LIMITER
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 100, // Increased limit slightly
    standardHeaders: true, 
    legacyHeaders: false, 
    message: { status: 'Error', output: 'Too many requests, please try again later.', results: [] }
});

app.use(cors());
app.use(bodyParser.json());
app.use('/api/', limiter);

// --- TYPES ---
interface TestCase {
    input: string;
    expected: string;
    hidden: boolean;
    params: any;
}

interface Problem {
    id: string;
    title: string;
    testCases: TestCase[];
    functionName: string;
    runner_code_java?: string;
    runner_code_cpp?: string;
    runner_code_c?: string;
}

// --- HARDCODED FALLBACK ---
const FALLBACK_PROBLEMS: Record<string, Problem> = {
    'two-sum': {
        id: 'two-sum',
        title: 'Two Sum',
        functionName: 'twoSum',
        testCases: [
            { input: "nums = [2,7,11,15], target = 9", expected: "[0,1]", hidden: false, params: { nums: [2, 7, 11, 15], target: 9 } },
            { input: "nums = [3,2,4], target = 6", expected: "[1,2]", hidden: false, params: { nums: [3, 2, 4], target: 6 } }
        ]
    }
};

// --- DYNAMIC FETCH FROM DB ---
async function getProblemDetails(problemId: string): Promise<Problem | null> {
    try {
        const { data, error } = await supabase
            .from('coding_problems') 
            .select('*')
            .eq('id', problemId)
            .single();

        if (error || !data) {
            console.warn(`[DB] Problem ${problemId} not found/error, using fallback.`);
            return FALLBACK_PROBLEMS[problemId] || null;
        }

        return {
            id: data.id,
            title: data.title,
            testCases: data.test_cases || [],
            functionName: data.function_name || 'solve',
            runner_code_java: data.runner_code_java,
            runner_code_cpp: data.runner_code_cpp,
            runner_code_c: data.runner_code_c
        };
    } catch (e) {
        console.error("DB Fetch Error:", e);
        return FALLBACK_PROBLEMS[problemId] || null;
    }
}

const JUDGE0_LANG_IDS: Record<string, number> = {
    'javascript': 63,
    'typescript': 74,
    'python': 71,
    'java': 62,
    'cpp': 54,
    'c': 50
};

// --- VALIDATION ---
function validateCode(code: string, language: string): boolean {
    if (!code || code.trim().length < 1) return false;
    const forbidden = [
        'process.exit', 'exec(', 'spawn(', 'os.system', 'eval(', '__import__', 'system(',
        'child_process', 'fork(', 'Runtime.getRuntime', 'ProcessBuilder', 'fs.readFile', 'fs.writeFile', 'open('
    ];
    if (forbidden.some(f => code.includes(f))) return false;
    return true;
}

// --- TEMPLATES ---
const TEMPLATES: Record<string, string> = {};
async function loadTemplates() {
    const langs = ['javascript', 'typescript', 'python', 'java', 'cpp', 'c'];
    for (const lang of langs) {
        try {
            const templatePath = path.join(__dirname, 'templates', `${lang}.txt`);
            TEMPLATES[lang] = await fs.promises.readFile(templatePath, 'utf-8');
        } catch (e) {
            console.error(`Failed to load template for ${lang}:`, e);
        }
    }
}
loadTemplates();

// --- WRAPPER LOGIC ---
function wrapCode(code: string, language: string, problem: Problem): string {
    const template = TEMPLATES[language];
    if (!template) return code;

    const testCasesJSON = JSON.stringify(problem.testCases.map((tc) => tc.params));
    let wrapped = template
        .replace('{{USER_CODE}}', code)
        .replace('{{FUNCTION_NAME}}', problem.functionName)
        .replace('{{TEST_CASES_JSON}}', testCasesJSON);

    // Dynamic Runners for Compiled Languages
    if (language === 'java') {
        const sanitizedCode = code.replace(/public\s+class\s+Solution/, 'class Solution');
        wrapped = wrapped.replace('{{USER_CODE}}', sanitizedCode);
        if (problem.runner_code_java) {
            wrapped = wrapped.replace('{{TEST_RUNNER}}', problem.runner_code_java);
        } else {
            wrapped = wrapped.replace('{{TEST_RUNNER}}', generateFallbackRunner(problem.id, 'java'));
        }
    }
    else if (language === 'cpp' || language === 'c') {
        const field = language === 'cpp' ? 'runner_code_cpp' : 'runner_code_c';
        // @ts-ignore
        if (problem[field]) {
             // @ts-ignore
            wrapped = wrapped.replace('{{TEST_RUNNER}}', problem[field]);
        } else {
            wrapped = wrapped.replace('{{TEST_RUNNER}}', generateFallbackRunner(problem.id, language));
        }
    }

    return wrapped;
}

function generateFallbackRunner(problemId: string, lang: 'java' | 'cpp' | 'c'): string {
    // Default fallback runner logic (Simplified for brevity)
    // IMPORTANT: In production, ensure these match the problem logic exactly.
    return `System.out.println("No custom runner found. Please add runner_code_${lang} to DB.");`;
}

// --- BUCKET SAVE ---
async function saveToBucket(teamName: string, problemId: string, language: string, code: string) {
    try {
        const safeTeamName = teamName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const ext = language === 'python' ? 'py' : language === 'javascript' ? 'js' : 'txt';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${safeTeamName}/${problemId}_${timestamp}.${ext}`;

        const { data, error } = await supabase.storage.from('codelog').upload(filename, code, { contentType: 'text/plain', upsert: false });
        if (error) return "error_saving";
        return data.path;
    } catch (err) {
        return "error_saving";
    }
}

// --- JUDGE0 SUBMIT ---
async function submitWithFallback(payload: any): Promise<any> {
    let lastError: any = null;
    for (const url of JUDGE0_URLS) {
        if(!url) continue;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s timeout
            const response = await fetch(`${url}/submissions?base64_encoded=true&wait=false`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status >= 400 && response.status < 500) throw new Error(`Client Error: ${response.status}`);
                throw new Error(`Server Error: ${response.status}`);
            }
            const data: any = await response.json();
            return { token: data.token, url };
        } catch (err: any) {
            lastError = err;
            if (err.message.includes("Client Error")) throw err;
        }
    }
    throw lastError || new Error("All Judge0 instances failed.");
}

// --- 🔥 EXECUTE API ---
app.post('/api/execute', async (req: express.Request, res: express.Response) => {
    const { code, language, problemId, teamName, isSubmission, userId } = req.body;
    
    // 1. Get Problem
    const problem = await getProblemDetails(problemId);
    if (!problem) return res.status(404).json({ status: 'Error', output: 'Problem not found.', results: [] });

    if (!validateCode(code, language)) return res.status(400).json({ status: 'Invalid', output: 'Restricted content detected.', results: [] });

    try {
        // 2. Queue in DB
        const dbPayload = {
            user_id: userId || 'anonymous',
            language,
            code,
            status: 'queued',
            stdout: '', stderr: '', score: 0
        };

        const { data: insertData, error: dbError } = await supabase.from('executions').insert(dbPayload).select().single();
        if (dbError) return res.status(500).json({ error: "DB Insert Failed" });

        const jobId = insertData.id;
        res.json({ job_id: jobId, status: 'queued' }); // Respond immediately

        // 3. Background Process
        (async () => {
            try {
                let savedFile = null;
                if (isSubmission) {
                    savedFile = await saveToBucket(teamName || "anonymous", problemId, language, code);
                }

                const wrappedCode = wrapCode(code, language, problem);
                const judge0Id = JUDGE0_LANG_IDS[language];

                const payload = {
                    source_code: Buffer.from(wrappedCode).toString('base64'),
                    language_id: judge0Id,
                    stdin: Buffer.from("").toString('base64'),
                };

                const { token, url: employedUrl } = await submitWithFallback(payload);

                await supabase.from('executions')
                    .update({
                        status: 'running',
                        metadata: { judge0_token: token, judge0_url: employedUrl, problem_id: problemId, saved_file: savedFile }
                    })
                    .eq('id', jobId);

            } catch (bgError: any) {
                console.error(`[BG] Job ${jobId} Failed:`, bgError);
                await supabase.from('executions').update({ status: 'error', stderr: bgError.message }).eq('id', jobId);
            }
        })();

    } catch (e: any) {
        res.status(500).json({ status: 'Error', output: e.message, results: [] });
    }
});

// --- 🔥 ROBUST OUTPUT PARSER ---
function parseJudge0Output(stdout: string, problem: Problem) {
    const judgeLines = stdout.split('\n').filter((l: string) => l.startsWith('__JUDGE__ '));
    const results: any[] = [];
    let passedCount = 0;

    // Normalizer: Removes ALL whitespace, newlines, and quotes for comparison
    // E.g. "[ 0, 1 ]" -> "[0,1]"
    const normalize = (val: any) => {
        if (val === null || val === undefined) return '';
        return String(val)
            .replace(/\s+/g, '') // Remove spaces
            .replace(/['"]/g, '') // Remove quotes
            .replace(/\n/g, '') // Remove newlines
            .trim()
            .toLowerCase(); // Case insensitive
    };

    problem.testCases.forEach((tc, index) => {
        const searchStr = `__JUDGE__ Test Case ${index + 1}: `;
        const line = judgeLines.find((l: string) => l.includes(searchStr));

        const resObj: any = {
            status: 'Pending',
            input: tc.hidden ? 'Hidden' : tc.input,
            expected: tc.expected,
            actual: 'N/A',
            params: tc.hidden ? {} : tc.params
        };

        if (line) {
            const actualRaw = line.replace(searchStr, '').trim();
            resObj.actual = actualRaw;

            const normExpected = normalize(tc.expected);
            const normActual = normalize(actualRaw);

            // LOGGING FOR DEBUGGING (View in Render logs)
            console.log(`[TEST ${index + 1}] Exp: "${normExpected}" | Act: "${normActual}" | Match: ${normExpected === normActual}`);

            if (normExpected === normActual) {
                resObj.status = 'Accepted';
                passedCount++;
            } else {
                resObj.status = 'Wrong Answer';
            }
        } else {
            resObj.status = 'Runtime Error'; // Line not found means code crashed or didn't print
        }
        results.push(resObj);
    });

    return { results, passedCount };
}

// --- STATUS ENDPOINT ---
app.get('/api/status/:id', async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { data, error } = await supabase.from('executions').select('*').eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'Job not found' });

    if (data.status === 'completed' || data.status === 'success') {
        const problem = await getProblemDetails(data.metadata?.problem_id || 'two-sum');
        if(problem) {
            const { results } = parseJudge0Output(data.stdout || "", problem);
            return res.json({ ...data, results });
        }
    }
    res.json(data);
});

// --- POLLING WORKER ---
setInterval(async () => {
    const { data: jobs } = await supabase
        .from('executions')
        .select('*')
        .eq('status', 'running')
        .not('metadata', 'is', null)
        .limit(10);

    if (!jobs || jobs.length === 0) return;

    for (const job of jobs) {
        try {
            const { judge0_token, judge0_url, problem_id } = job.metadata;
            // Add a timeout to fetch
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(`${judge0_url}/submissions/${judge0_token}?base64_encoded=true`, { 
                signal: controller.signal 
            });
            clearTimeout(timeoutId);
            
            if (!response.ok) continue;
            const data: any = await response.json();

            if (data.status.id <= 2) continue; // Running

            let finalStatus = 'error';
            let output = '';
            let score = 0;
            let stderr = '';

            if (data.status.id === 6) { // Compile Error
                output = Buffer.from(data.compile_output || "", 'base64').toString('utf-8');
                finalStatus = 'error'; // Frontend shows 'Compilation Error'
            } else { // 3 (Accepted) or Runtime Error or Wrong Answer (all are 'finished' execution wise)
                const stdoutRaw = data.stdout ? Buffer.from(data.stdout, 'base64').toString('utf-8') : "";
                stderr = data.stderr ? Buffer.from(data.stderr, 'base64').toString('utf-8') : "";
                
                // Fetch Problem to Calculate Score
                const problem = await getProblemDetails(problem_id);
                if (problem) {
                    const { passedCount } = parseJudge0Output(stdoutRaw, problem);
                    score = parseFloat(((passedCount / problem.testCases.length) * 100).toFixed(2));
                    output = stdoutRaw;
                    finalStatus = 'completed'; // We mark as completed, frontend checks 'results' for pass/fail
                }
            }

            await supabase.from('executions')
                .update({ status: finalStatus, stdout: output, stderr: stderr, score: score })
                .eq('id', job.id);

            // Update Leaderboard Logic
            if (job.user_id && job.user_id !== 'anonymous') {
                // ... (Existing leaderboard logic preserved) ...
                const { data: allExecs } = await supabase.from('executions').select('score, metadata').eq('user_id', job.user_id).or('status.eq.completed,status.eq.success');
                // Simple Sum logic for now (customize as needed)
                let totalScore = 0;
                // Map to store best score per problem
                const bestScores: Record<string, number> = {};
                if(allExecs) {
                    allExecs.forEach((ex: any) => {
                        const pid = ex.metadata?.problem_id;
                        const s = parseFloat(ex.score || '0');
                        if(pid) bestScores[pid] = Math.max(bestScores[pid] || 0, s);
                    });
                }
                // Include current if not present
                bestScores[problem_id] = Math.max(bestScores[problem_id] || 0, score);
                
                // Sum best scores
                const round3Score = Object.values(bestScores).reduce((a, b) => a + b, 0);

                const { data: existing } = await supabase.from('leaderboard').select('*').eq('user_id', job.user_id).single();
                const r1 = existing?.round1_score || 0;
                const r2 = existing?.round2_score || 0;
                
                await supabase.from('leaderboard').upsert({
                    user_id: job.user_id,
                    round3_score: round3Score,
                    overall_score: r1 + r2 + round3Score,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });
            }

        } catch (e) {
            console.error(`[POLL] Job ${job.id} Error:`, e);
        }
    }
}, 2000);

// --- HEALTHCHECK & START ---
app.get('/healthcheck', (req: express.Request, res: express.Response) => {
    res.status(200).json({ status: 'ok', judge0_urls: JUDGE0_URLS });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});