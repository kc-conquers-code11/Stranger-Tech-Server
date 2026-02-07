import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// JUDGE0 CONFIG
const JUDGE0_URLS = [
    process.env.JUDGE0_URL,
    'http://172.20.0.10:2358',
    'http://localhost:2358',
    'http://backup:2358'
];

// Supabase Config
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
);

// RATE LIMITER
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // Limit each IP to 60 requests per `window` (here, per 1 minute)
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { status: 'Error', output: 'Too many requests, please try again later.', results: [] }
});

app.use(cors());
app.use(bodyParser.json());

// Apply rate limiter to all api routes
app.use('/api/', limiter);


// Helper to save to Supabase Bucket (Async)
async function saveToBucket(teamName: string, problemId: string, language: string, code: string) {
    try {
        // Sanitize team name for folder safety
        const safeTeamName = teamName.replace(/[^a-z0-9]/gi, '_').toLowerCase();

        const ext = language === 'python' ? 'py' : language === 'javascript' ? 'js' : 'txt';
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${safeTeamName}/${problemId}_${timestamp}.${ext}`;

        const { data, error } = await supabase
            .storage
            .from('codelog')
            .upload(filename, code, {
                contentType: 'text/plain',
                upsert: false
            });

        if (error) {
            console.error("Supabase Storage Error:", error);
            return "error_saving";
        }

        // Return the public URL or just the path if bucket is private (user said public)
        return data.path;

    } catch (err) {
        console.error("Bucket Error:", err);
        return "error_saving";
    }
}

interface TestCase {
    input: string;
    expected: string;
    hidden: boolean;
    params: {
        nums: number[];
        target: number;
    };
}

interface Problem {
    id: string;
    title: string;
    testCases: TestCase[];
    functionName: string;
}

// Problem Registry
const PROBLEMS: Record<string, Problem> = {
    'two-sum': {
        id: 'two-sum',
        title: 'Two Sum',
        testCases: [
            { input: "nums = [2,7,11,15], target = 9", expected: "[0,1]", hidden: false, params: { nums: [2, 7, 11, 15], target: 9 } },
            { input: "nums = [3,2,4], target = 6", expected: "[1,2]", hidden: false, params: { nums: [3, 2, 4], target: 6 } },
            { input: "nums = [3,3], target = 6", expected: "[0,1]", hidden: true, params: { nums: [3, 3], target: 6 } },
            // Random-like case: 50 elements, unsorted, target at variable positions
            {
                input: "nums = [10,4,20...], target = 24",
                expected: "[1,2]",
                hidden: true,
                params: {
                    nums: [10, 4, 20, 15, 8, 3, 12, 1, 9, 50, 40, 30, 25, 60, 70, 80, 90, 100, 5, 2, 99, 88, 77, 66, 55, 44, 33, 22, 11, 13, 14, 16, 17, 18, 19, 21, 23, 24, 26, 27, 28, 29, 31, 32, 34, 35, 36, 37, 38, 39], // 20+8=28 no. 20 is index 2. 8 is index 4. wait. 20+4=24. index 2 and 1. output [1,2] sorted.
                    target: 24
                }
            },
        ],
        functionName: 'twoSum'
    },
    'binary-search': {
        id: 'binary-search',
        title: 'Binary Search',
        testCases: [
            { input: "nums = [-1,0,3,5,9,12], target = 9", expected: "4", hidden: false, params: { nums: [-1, 0, 3, 5, 9, 12], target: 9 } },
            { input: "nums = [-1,0,3,5,9,12], target = 2", expected: "-1", hidden: false, params: { nums: [-1, 0, 3, 5, 9, 12], target: 2 } },
            { input: "nums = [5], target = 5", expected: "0", hidden: true, params: { nums: [5], target: 5 } },
            // Random-like case: Larger sorted array
            {
                input: "nums = [-100...100], target = 42",
                expected: "28", // Index of 42 in this sequence? Let's check logic: -50 to 49. target 42.
                hidden: true,
                params: {
                    nums: [-50, -45, -40, -35, -30, -25, -20, -15, -10, -5, 0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 42, 44, 46, 48, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100],
                    target: 42
                }
            }
        ],
        functionName: 'search'
    }
};

const JUDGE0_LANG_IDS: Record<string, number> = {
    'javascript': 63,
    'typescript': 74,
    'python': 71,
    'java': 62,
    'cpp': 54,
    'c': 50
};

function validateCode(code: string, language: string): boolean {
    if (!code || code.trim().length < 1) return false;

    // Strict Sanitizer: Check for forbidden strings
    const forbidden = [
        'process.exit', 'exec(', 'spawn(', 'os.system', 'eval(', '__import__', 'system(',
        'child_process', 'fork(', 'Runtime.getRuntime', 'ProcessBuilder', 'fs.readFile', 'fs.writeFile', 'open('
    ];
    if (forbidden.some(f => code.includes(f))) return false;

    return true;
}


// Template Cache
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

function wrapCode(code: string, language: string, problem: Problem): string {
    const template = TEMPLATES[language];
    if (!template) {
        console.error(`Template not found for ${language}`);
        return code;
    }

    const testCasesJSON = JSON.stringify(problem.testCases.map((tc) => tc.params));
    let wrapped = template
        .replace('{{USER_CODE}}', code)
        .replace('{{FUNCTION_NAME}}', problem.functionName)
        .replace('{{TEST_CASES_JSON}}', testCasesJSON);

    // Special handling for Compiled Languages (C/C++/Java require static Test Runners)
    if (language === 'java') {
        const sanitizedCode = code.replace(/public\s+class\s+Solution/, 'class Solution');
        wrapped = wrapped.replace('{{USER_CODE}}', sanitizedCode);

        let runnerCode = "";

        if (problem.id === 'two-sum') {
            runnerCode = `
        int[] r1 = sol.twoSum(new int[]{2,7,11,15}, 9);
        Arrays.sort(r1);
        System.out.println("__JUDGE__ Test Case 1: " + Arrays.toString(r1).replaceAll(" ", ""));

        int[] r2 = sol.twoSum(new int[]{3,2,4}, 6);
        Arrays.sort(r2);
        System.out.println("__JUDGE__ Test Case 2: " + Arrays.toString(r2).replaceAll(" ", ""));

        try {
            int[] r3 = sol.twoSum(new int[]{}, -1);
            if (r3 == null || r3.length == 0)
                System.out.println("__JUDGE__ Test Case 3: -1");
            else {
                Arrays.sort(r3);
                System.out.println("__JUDGE__ Test Case 3: " + Arrays.toString(r3).replaceAll(" ", ""));
            }
        } catch (Exception e) {
            System.out.println("__JUDGE__ Test Case 3: -1");
        }

        int[] r4 = sol.twoSum(new int[]{3,3}, 6);
        Arrays.sort(r4);
        System.out.println("__JUDGE__ Test Case 4: " + Arrays.toString(r4).replaceAll(" ", ""));

        int[] nums5 = {10,4,20,15,8,3,12,1,9,50,40,30,25,60,70,80,90,100,5,2,99,88,77,66,55,44,33,22,11,13,14,16,17,18,19,21,23,24,26,27,28,29,31,32,34,35,36,37,38,39};
        int[] r5 = sol.twoSum(nums5, 24);
        Arrays.sort(r5);
        System.out.println("__JUDGE__ Test Case 5: " + Arrays.toString(r5).replaceAll(" ", ""));
        `;
        } else {
            runnerCode = `
        System.out.println("__JUDGE__ Test Case 1: " + sol.search(new int[]{-1,0,3,5,9,12}, 9));
        System.out.println("__JUDGE__ Test Case 2: " + sol.search(new int[]{-1,0,3,5,9,12}, 2));
        System.out.println("__JUDGE__ Test Case 3: " + sol.search(new int[]{5}, 5));

        int[] nums4 = {-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,42,44,46,48,50,55,60,65,70,75,80,85,90,95,100};
        System.out.println("__JUDGE__ Test Case 4: " + sol.search(nums4, 42));
        `;
        }

        wrapped = wrapped.replace('{{TEST_RUNNER}}', runnerCode);
    }
    else if (language === 'cpp') {
        let runnerCode = "";

        if (problem.id === 'two-sum') {
            runnerCode = `
        vector<int> r1 = sol.twoSum({2,7,11,15}, 9);
        sort(r1.begin(), r1.end());
        cout << "__JUDGE__ Test Case 1: "; printVector(r1); cout << endl;

        vector<int> r2 = sol.twoSum({3,2,4}, 6);
        sort(r2.begin(), r2.end());
        cout << "__JUDGE__ Test Case 2: "; printVector(r2); cout << endl;

        vector<int> r3 = sol.twoSum({}, -1);
        if (r3.empty()) cout << "__JUDGE__ Test Case 3: -1" << endl;
        else { sort(r3.begin(), r3.end()); cout << "__JUDGE__ Test Case 3: "; printVector(r3); cout << endl; }

        vector<int> r4 = sol.twoSum({3,3}, 6);
        sort(r4.begin(), r4.end());
        cout << "__JUDGE__ Test Case 4: "; printVector(r4); cout << endl;

        vector<int> nums5 = {10,4,20,15,8,3,12,1,9,50,40,30,25,60,70,80,90,100,5,2,99,88,77,66,55,44,33,22,11,13,14,16,17,18,19,21,23,24,26,27,28,29,31,32,34,35,36,37,38,39};
        vector<int> r5 = sol.twoSum(nums5, 24);
        sort(r5.begin(), r5.end());
        cout << "__JUDGE__ Test Case 5: "; printVector(r5); cout << endl;
        `;
        } else {
            runnerCode = `
        cout << "__JUDGE__ Test Case 1: " << sol.search({-1,0,3,5,9,12}, 9) << endl;
        cout << "__JUDGE__ Test Case 2: " << sol.search({-1,0,3,5,9,12}, 2) << endl;
        cout << "__JUDGE__ Test Case 3: " << sol.search({5}, 5) << endl;

        vector<int> nums4 = {-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,42,44,46,48,50,55,60,65,70,75,80,85,90,95,100};
        cout << "__JUDGE__ Test Case 4: " << sol.search(nums4, 42) << endl;
        `;
        }

        wrapped = wrapped.replace('{{TEST_RUNNER}}', runnerCode);
    }
    else if (language === 'c') {
        let runnerCode = "";

        if (problem.id === 'two-sum') {
            runnerCode = `
        int returnSize;

        int nums1[] = {2,7,11,15};
        int* r1 = twoSum(nums1, 4, 9, &returnSize);
        qsort(r1, returnSize, sizeof(int), cmp);
        printf("__JUDGE__ Test Case 1: "); printArray(r1, returnSize); printf("\\n");

        int nums2[] = {3,2,4};
        int* r2 = twoSum(nums2, 3, 6, &returnSize);
        qsort(r2, returnSize, sizeof(int), cmp);
        printf("__JUDGE__ Test Case 2: "); printArray(r2, returnSize); printf("\\n");

        int nums3[] = {};
        int* r3 = twoSum(nums3, 0, -1, &returnSize);
        if (returnSize == 0) printf("__JUDGE__ Test Case 3: -1\\n");
        else { qsort(r3, returnSize, sizeof(int), cmp); printf("__JUDGE__ Test Case 3: "); printArray(r3, returnSize); printf("\\n"); }

        int nums4[] = {3,3};
        int* r4 = twoSum(nums4, 2, 6, &returnSize);
        qsort(r4, returnSize, sizeof(int), cmp);
        printf("__JUDGE__ Test Case 4: "); printArray(r4, returnSize); printf("\\n");

        int nums5[] = {10,4,20,15,8,3,12,1,9,50,40,30,25,60,70,80,90,100,5,2,99,88,77,66,55,44,33,22,11,13,14,16,17,18,19,21,23,24,26,27,28,29,31,32,34,35,36,37,38,39};
        int* r5 = twoSum(nums5, 50, 24, &returnSize);
        qsort(r5, returnSize, sizeof(int), cmp);
        printf("__JUDGE__ Test Case 5: "); printArray(r5, returnSize); printf("\\n");
        `;
        } else {
            runnerCode = `
        int nums1[] = {-1,0,3,5,9,12};
        printf("__JUDGE__ Test Case 1: %d\\n", search(nums1, 6, 9));

        int nums2[] = {-1,0,3,5,9,12};
        printf("__JUDGE__ Test Case 2: %d\\n", search(nums2, 6, 2));

        int nums3[] = {5};
        printf("__JUDGE__ Test Case 3: %d\\n", search(nums3, 1, 5));

        int nums4[] = {-50,-45,-40,-35,-30,-25,-20,-15,-10,-5,0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,42,44,46,48,50,55,60,65,70,75,80,85,90,95,100};
        printf("__JUDGE__ Test Case 4: %d\\n", search(nums4, 43, 42));
        `;
        }
        wrapped = wrapped.replace('{{TEST_RUNNER}}', runnerCode);
    }

    return wrapped;
}



// Helper: Submit to Judge0 with Fallback
async function submitWithFallback(payload: any): Promise<any> {
    let lastError: any = null;

    for (const url of JUDGE0_URLS) {
        try {
            console.log(`[JUDGE0] Attempting submission to ${url}...`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

            const response = await fetch(`${url}/submissions?base64_encoded=true&wait=false`, { // Async submission (wait=false)
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                // If 4xx, it's a client error (e.g., bad code), don't retry, just throw
                if (response.status >= 400 && response.status < 500) {
                    throw new Error(`Judge0 Client Error: ${response.status} ${response.statusText}`);
                }
                throw new Error(`Judge0 Server Error: ${response.status} ${response.statusText}`);
            }

            const data: any = await response.json();
            console.log(`[JUDGE0] Submission accepted on ${url}. Token: ${data.token}`);
            return { token: data.token, url }; // Return token and the URL used (for polling)

        } catch (err: any) {
            console.error(`[JUDGE0] Failed to submit to ${url}: ${err.message}`);
            lastError = err;
            if (err.message.includes("Client Error")) throw err; // Don't fallback on client error
            // Continue to next URL
        }
    }
    throw lastError || new Error("All Judge0 instances failed.");
}


app.post('/api/execute', async (req: express.Request, res: express.Response) => {
    // ASYNC SUBMISSION FLOW
    const { code, language, problemId, teamName, isSubmission, userId } = req.body;
    console.log(`[EXECUTE] Async Request received for ${problemId} in ${language} (User: ${userId})`);

    const problem = PROBLEMS[problemId] || PROBLEMS['two-sum'];

    if (!validateCode(code, language)) {
        return res.status(400).json({ status: 'Invalid', output: 'Code validation failed: Restricted content detected.', results: [] });
    }

    try {
        console.log(`[EXECUTE] Queueing job for user: ${userId || 'anonymous'}`);

        // 1. Create DB Record (Queued)
        // Check if Supabase client is valid
        if (!supabase) {
            console.error("Supabase client not initialized");
            return res.status(500).json({ error: "Server Configuration Error" });
        }

        const dbPayload = {
            user_id: userId || 'anonymous',
            language,
            code,
            status: 'queued',
            stdout: '',
            stderr: '',
            score: 0
        };

        console.log("[EXECUTE] Inserting into executions table...");
        const { data: insertData, error: dbError } = await supabase
            .from('executions')
            .insert(dbPayload)
            .select()
            .single();

        if (dbError) {
            console.error("Supabase Insert Error:", dbError);
            return res.status(500).json({ error: "Failed to queue execution." });
        }

        console.log("[EXECUTE] Job Queued. ID:", insertData.id);
        const jobId = insertData.id;
        res.json({ job_id: jobId, status: 'queued' }); // Immediate response

        // 2. Trigger Background Submission
        (async () => {
            try {
                let savedFile = null;
                if (isSubmission) {
                    savedFile = await saveToBucket(teamName || "anonymous", problemId || "two-sum", language, code);
                }

                const wrappedCode = wrapCode(code, language, problem);
                const judge0Id = JUDGE0_LANG_IDS[language];

                if (!judge0Id) throw new Error("Unsupported Language");

                const payload = {
                    source_code: Buffer.from(wrappedCode).toString('base64'),
                    language_id: judge0Id,
                    stdin: Buffer.from("").toString('base64'),
                    callback_url: `${process.env.PUBLIC_API_URL || 'http://localhost:3001'}/api/callback` // Optional: if we want webhook
                };

                // Submit to Judge0 (with fallback)
                const { token, url: employedUrl } = await submitWithFallback(payload);

                // Update DB with Token and set status to 'running'
                const { error: updateError } = await supabase
                    .from('executions')
                    .update({
                        status: 'running',
                        metadata: { judge0_token: token, judge0_url: employedUrl, problem_id: problemId, saved_file: savedFile }
                    })
                    .eq('id', jobId);

                if (updateError) {
                    console.error(`[EXECUTE] Failed to update job ${jobId} to running:`, updateError);
                } else {
                    console.log(`[EXECUTE] Job ${jobId} updated to 'running'. Token: ${token}`);
                }

            } catch (bgError: any) {
                console.error(`[BACKGROUND] Job ${jobId} Failed:`, bgError);
                await supabase
                    .from('executions')
                    .update({ status: 'error', stderr: bgError.message })
                    .eq('id', jobId);
            }
        })();

    } catch (e: any) {
        console.error("Judge0 Error:", e);
        res.status(500).json({ status: 'Error', output: `Judge0 Connection Failed: ${e.message}. Is Judge0 running on port 2358?`, results: [] });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Using Judge0 URLs: ${JUDGE0_URLS.join(', ')}`);
});
app.get('/healthcheck', (req: express.Request, res: express.Response) => {
    res.status(200).json({ status: 'ok', judge0_urls: JUDGE0_URLS });
});

// LEADERBOARD ENDPOINT
app.get('/api/leaderboard', async (req: express.Request, res: express.Response) => {
    try {
        const { data, error } = await supabase
            .from('executions')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// Helper to Parse Output
function parseJudge0Output(stdout: string, problemId: string) {
    const problem = PROBLEMS[problemId] || PROBLEMS['two-sum'];
    const judgeLines = stdout.split('\n').filter((l: string) => l.startsWith('__JUDGE__ '));

    const results: any[] = [];
    let passedCount = 0;

    problem.testCases.forEach((tc, index) => {
        const searchStr = `__JUDGE__ Test Case ${index + 1}: `;
        const line = judgeLines.find((l: string) => l.includes(searchStr));

        const resObj: any = {
            status: 'Pending',
            input: tc.hidden ? 'Hidden' : tc.input,
            expected: tc.expected,
            actual: 'N/A',
            params: tc.hidden ? {} : tc.params,
            error: null
        };

        if (line) {
            const actual = line.replace(searchStr, '').trim();
            resObj.actual = actual;

            const normalize = (s: string) => s.replace(/\s+/g, '');
            if (normalize(actual) === normalize(tc.expected)) {
                resObj.status = 'Accepted';
                passedCount++;
            } else {
                resObj.status = 'Wrong Answer';
            }
        } else {
            // Not found (maybe runtime error prevented execution of this case)
            resObj.status = 'Runtime Error';
        }
        results.push(resObj);
    });

    return { results, passedCount, total: problem.testCases.length };
}


// STATUS ENDPOINT
app.get('/api/status/:id', async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { data, error } = await supabase.from('executions').select('*').eq('id', id).single();
    if (error || !data) return res.status(404).json({ error: 'Job not found' });

    // If completed, we reconstruct the detailed results on the fly
    // This avoids storing large JSON in DB if not needed, acts as a "View"
    if (data.status === 'completed' || data.status === 'success') {
        // Get Problem ID from metadata
        const problemId = data.metadata?.problem_id || 'two-sum';
        const { results } = parseJudge0Output(data.stdout || "", problemId);

        // Attach to response
        return res.json({
            ...data,
            results,
            metrics: { time: 0 } // Mock or real if we had it
        });
    }

    res.json(data);
});

// POLLING WORKER
setInterval(async () => {
    // 1. Fetch running jobs
    const { data: jobs, error } = await supabase
        .from('executions')
        .select('*')
        .eq('status', 'running')
        .not('metadata', 'is', null) // Ensure metadata exists
        .limit(10); // Batch size

    // if (jobs && jobs.length > 0) console.log(`[POLL] Found ${jobs.length} running jobs.`);

    if (error || !jobs || jobs.length === 0) return;

    for (const job of jobs) {
        try {
            const { judge0_token, judge0_url, problem_id, saved_file } = job.metadata;
            if (!judge0_token) continue;

            console.log(`[POLL] Checking job ${job.id} at ${judge0_url}...`);

            const response = await fetch(`${judge0_url}/submissions/${judge0_token}?base64_encoded=true`, {
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) continue;

            const data: any = await response.json();

            // Check Status
            // 1: In Queue, 2: Processing, 3: Accepted, 4-14: Errors/Wrong Answer
            if (data.status.id <= 2) {
                // Still running
                continue;
            }

            // Finished! Process Result
            console.log(`[POLL] Job ${job.id} finished with status ${data.status.description}`);

            let finalStatus = 'error';
            let output = '';
            let score = 0;
            let stderr = '';

            if (data.status.id === 6) { // Compilation Error
                output = Buffer.from(data.compile_output || "", 'base64').toString('utf-8');
                finalStatus = 'error';
            } else if (data.status.id > 2) {
                // Execution finished (Success or Runtime Error)
                const stdoutRaw = data.stdout ? Buffer.from(data.stdout, 'base64').toString('utf-8') : "";
                stderr = data.stderr ? Buffer.from(data.stderr, 'base64').toString('utf-8') : "";

                // Reuse validtion logic
                const problem = PROBLEMS[problem_id] || PROBLEMS['two-sum'];

                // ... extract score logic ...
                let passedCount = 0;
                const judgeLines = stdoutRaw.split('\n').filter((l: string) => l.startsWith('__JUDGE__ '));

                // We need to reconstruct the "results" array to store in DB or just store the score/output
                // Connect.md says: "Compute score, Update Supabase"

                problem.testCases.forEach((tc: any, index: number) => {
                    const searchStr = `__JUDGE__ Test Case ${index + 1}: `;
                    const line = judgeLines.find((l: string) => l.includes(searchStr));
                    if (line) {
                        const actual = line.replace(searchStr, '').trim();
                        const normalize = (s: string) => s.replace(/\s+/g, '');
                        if (normalize(actual) === normalize(tc.expected)) passedCount++;
                    }
                });

                score = parseFloat(((passedCount / problem.testCases.length) * 100).toFixed(2));
                output = stdoutRaw; // Store full output or just user logs? Storing full for now.
                finalStatus = 'completed'; // or 'success'
            }

            // Update Supabase
            await supabase
                .from('executions')
                .update({
                    status: finalStatus,
                    stdout: output,
                    stderr: stderr,
                    score: score,
                    // Can store structured results in a JSON column if schema has it, else just text
                })
                .eq('id', job.id);

            // Update Leaderboard (Round 3) - AGGREGATED SCORE
            if (job.user_id && job.user_id !== 'anonymous') {
                // Fetch all successful executions for this user to calculate best score per problem
                const { data: allExecs } = await supabase
                    .from('executions')
                    .select('score, metadata')
                    .eq('user_id', job.user_id)
                    .or('status.eq.completed,status.eq.success');

                let bestTwoSum = 0;
                let bestBinary = 0;

                if (allExecs) {
                    allExecs.forEach((ex: any) => {
                        const pid = ex.metadata?.problem_id;
                        const s = parseFloat(ex.score || '0');
                        if (pid === 'two-sum') bestTwoSum = Math.max(bestTwoSum, s);
                        if (pid === 'binary-search') bestBinary = Math.max(bestBinary, s);
                    });
                }

                // If this current job wasn't in DB fetch yet (race condition), consider it too
                // (though we just updated it above, so it SHOULD be in there if we awaited)
                // But just in case:
                if (problem_id === 'two-sum') bestTwoSum = Math.max(bestTwoSum, score);
                if (problem_id === 'binary-search') bestBinary = Math.max(bestBinary, score);

                const round3Score = (bestTwoSum + bestBinary) / 2;

                const { data: existing } = await supabase.from('leaderboard').select('*').eq('user_id', job.user_id).single();
                const r1 = existing?.round1_score || 0;
                const r2 = existing?.round2_score || 0;

                const newOverall = r1 + r2 + round3Score;

                console.log(`[LEADERBOARD] Updating User ${job.user_id} | TwoSum: ${bestTwoSum}, Binary: ${bestBinary} -> R3: ${round3Score} | Overall: ${newOverall}`);

                await supabase.from('leaderboard').upsert({
                    user_id: job.user_id,
                    round3_score: round3Score,
                    overall_score: newOverall,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'user_id' });
            }

        } catch (e) {
            console.error(`[POLL] Error processing job ${job.id}:`, e);
        }
    }

}, 2000); // Poll every 2s
