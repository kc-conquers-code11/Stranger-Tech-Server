import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CONFIGURATION ---
const JUDGE0_URLS = [
    process.env.JUDGE0_URL,
    'http://172.20.0.10:2358',
    'http://localhost:2358',
    'https://judge0-ce.p.rapidapi.com' // Fallback if local fails (requires key, optional)
].filter(Boolean);

const supabase = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
);

app.use(cors());
app.use(bodyParser.json());

// Limit requests to prevent abuse during exam
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 120, // 2 requests per second allowed per IP
    message: { status: 'Error', output: 'Too many submissions. Please wait a moment.' }
});
app.use('/api/', limiter);

// --- LANGUAGE MAPPING ---
const JUDGE0_LANG_IDS: Record<string, number> = {
    'javascript': 63,
    'typescript': 74,
    'python': 71,
    'java': 62,
    'cpp': 54,
    'c': 50
};

// --- HELPER: FORMAT JAVA ARGUMENTS ---
function toJava(val: any): string {
    if (Array.isArray(val)) {
        if (val.length === 0) return "new int[]{}"; // Default empty to int array
        if (typeof val[0] === 'string') return `new String[]{${val.map(s => `"${s}"`).join(',')}}`;
        return `new int[]{${val.join(',')}}`;
    }
    if (typeof val === 'string') return `"${val}"`;
    if (typeof val === 'boolean') return val.toString();
    return val.toString();
}

// --- HELPER: FORMAT C++ ARGUMENTS ---
function toCpp(val: any): string {
    if (Array.isArray(val)) {
        return `{${val.join(',')}}`; // Vector initializer list
    }
    if (typeof val === 'string') return `"${val}"`;
    if (typeof val === 'boolean') return val.toString();
    return val.toString();
}

// --- DYNAMIC RUNNER GENERATOR ---
function generateRunner(language: string, problem: any, userCode: string): string {
    const testCases = problem.test_cases || [];
    const funcName = problem.function_name || 'solve';

    // 1. JAVASCRIPT / TYPESCRIPT
    if (language === 'javascript' || language === 'typescript') {
        return `
${userCode}

// --- JUDGE SYSTEM ---
const testCases = ${JSON.stringify(testCases.map((t: any) => t.params))};
testCases.forEach((tc, i) => {
    try {
        // Capture Console Log
        const originalLog = console.log;
        let userOutput = [];
        console.log = (...args) => userOutput.push(args.join(' '));

        // Run Function
        const result = ${funcName}(...Object.values(tc));
        
        // Restore Console
        console.log = originalLog;

        // Print Format for Parser
        const resStr = Array.isArray(result) ? JSON.stringify(result) : result;
        process.stdout.write(\`__JUDGE__ Test Case \${i + 1}: \${resStr}\\n\`);
        
        // Print User Debug Logs if any
        if(userOutput.length > 0) process.stdout.write(\`[User Log]: \${userOutput.join(', ')}\\n\`);

    } catch (e) {
        process.stdout.write(\`__JUDGE__ Test Case \${i + 1}: ERROR_RUNTIME\\n\`);
        console.error(e); // Print full error to stderr
    }
});
`;
    }

    // 2. PYTHON
    if (language === 'python') {
        return `
import sys
import json

# User Code
${userCode}

# Judge System
if __name__ == "__main__":
    try:
        solution = Solution()
        test_cases = ${JSON.stringify(testCases.map((t: any) => t.params))}
        
        for i, tc in enumerate(test_cases):
            try:
                args = list(tc.values())
                result = solution.${funcName}(*args)
                
                # Format output
                if isinstance(result, list):
                    # Sort logic removed to support generic array problems
                    # If specific sorting needed, problem description should say so
                    print(f"__JUDGE__ Test Case {i+1}: {str(result).replace(' ', '')}")
                elif isinstance(result, bool):
                    print(f"__JUDGE__ Test Case {i+1}: {str(result).lower()}") # Python True -> true
                else:
                    print(f"__JUDGE__ Test Case {i+1}: {result}")
            except Exception as e:
                print(f"__JUDGE__ Test Case {i+1}: ERROR_RUNTIME")
                print(f"Error in Test Case {i+1}: {str(e)}", file=sys.stderr)
    except Exception as e:
        print(f"Critical Error: {str(e)}", file=sys.stderr)
`;
    }

    // 3. JAVA (Dynamic Class Wrapper)
    if (language === 'java') {
        // Remove 'public' from class Solution to avoid file name issues
        const sanitizedCode = userCode.replace(/public\s+class\s+Solution/, 'class Solution');
        
        let runnerCalls = testCases.map((tc: any, i: number) => {
            const args = Object.values(tc.params).map(val => toJava(val)).join(', ');
            return `
            try {
                Object res = sol.${funcName}(${args});
                System.out.print("__JUDGE__ Test Case ${i + 1}: ");
                if (res instanceof int[]) System.out.println(java.util.Arrays.toString((int[])res).replaceAll(" ", ""));
                else if (res instanceof String[]) System.out.println(java.util.Arrays.toString((String[])res));
                else System.out.println(res);
            } catch (Exception e) {
                System.out.println("__JUDGE__ Test Case ${i + 1}: ERROR_RUNTIME");
                e.printStackTrace();
            }
            `;
        }).join('\n');

        return `
import java.util.*;
import java.io.*;

${sanitizedCode}

public class Main {
    public static void main(String[] args) {
        Solution sol = new Solution();
        ${runnerCalls}
    }
}
`;
    }

    // 4. C++ (Dynamic Main)
    if (language === 'cpp') {
        let runnerCalls = testCases.map((tc: any, i: number) => {
            const args = Object.values(tc.params).map(val => toCpp(val)).join(', ');
            return `
            try {
                auto res = sol.${funcName}(${args});
                cout << "__JUDGE__ Test Case ${i + 1}: ";
                printResult(res);
                cout << endl;
            } catch (...) {
                cout << "__JUDGE__ Test Case ${i + 1}: ERROR_RUNTIME" << endl;
            }
            `;
        }).join('\n');

        return `
#include <iostream>
#include <vector>
#include <string>
#include <algorithm>
#include <map>
using namespace std;

// Helper to print vectors
template <typename T>
void printResult(const vector<T>& v) {
    cout << "[";
    for (size_t i = 0; i < v.size(); ++i) {
        cout << v[i] << (i < v.size() - 1 ? "," : "");
    }
    cout << "]";
}

// Helper to print basic types
template <typename T>
void printResult(T val) {
    cout << val;
}

// Helper for boolean
void printResult(bool val) {
    cout << (val ? "true" : "false");
}

${userCode}

int main() {
    Solution sol;
    ${runnerCalls}
    return 0;
}
`;
    }

    return userCode;
}

// --- SUBMIT TO JUDGE0 ---
async function submitToJudge0(sourceCode: string, languageId: number) {
    for (const url of JUDGE0_URLS) {
        if (!url) continue;
        try {
            // Wait=true ensures we get the result in one call (simplifies logic for exam)
            const response = await fetch(`${url}/submissions?base64_encoded=true&wait=true`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_code: Buffer.from(sourceCode).toString('base64'),
                    language_id: languageId,
                    stdin: Buffer.from("").toString('base64'),
                    cpu_time_limit: 2 // 2 seconds timeout
                })
            });

            if (!response.ok) continue;
            return await response.json();
        } catch (e) {
            console.error("Judge0 connection error:", e);
        }
    }
    throw new Error("All Judge0 nodes failed/unreachable");
}

// --- EXECUTE API ---
app.post('/api/execute', async (req: express.Request, res: express.Response) => {
    const { code, language, problemId, userId } = req.body;

    try {
        // 1. Fetch Problem
        const { data: problem, error } = await supabase
            .from('coding_problems')
            .select('*')
            .eq('id', problemId)
            .single();

        if (error || !problem) {
            return res.status(404).json({ 
                status: 'Error', 
                output: 'Problem not found in database.', 
                results: [] 
            });
        }

        // 2. Wrap Code
        const fullCode = generateRunner(language, problem, code);
        const langId = JUDGE0_LANG_IDS[language];

        if (!langId) return res.status(400).json({ status: 'Error', output: 'Unsupported Language' });

        // 3. Run Code
        const result = await submitToJudge0(fullCode, langId);

        // 4. Decode Output
        let stdout = "";
        let stderr = "";
        let compile_output = "";

        if (result.stdout) stdout = Buffer.from(result.stdout, 'base64').toString('utf-8');
        if (result.stderr) stderr = Buffer.from(result.stderr, 'base64').toString('utf-8');
        if (result.compile_output) compile_output = Buffer.from(result.compile_output, 'base64').toString('utf-8');

        // 5. Handle Errors (Syntax / Compilation)
        // Judge0 Status IDs: 6 = Compilation Error, 3 = Accepted
        if (result.status.id === 6) {
            return res.json({
                status: 'Compilation Error',
                output: compile_output, // Show syntax error to user
                error: compile_output,
                results: [],
                score: 0
            });
        }

        // 6. Parse Logic Results
        const judgeLines = stdout.split('\n').filter(l => l.startsWith('__JUDGE__ '));
        const finalResults: any[] = [];
        let passedCount = 0;

        const testCases = problem.test_cases || [];

        testCases.forEach((tc: any, index: number) => {
            const searchStr = `__JUDGE__ Test Case ${index + 1}: `;
            const line = judgeLines.find(l => l.includes(searchStr));
            
            const resObj = {
                status: 'Runtime Error', // Default if line missing
                expected: tc.expected,
                actual: 'Error/No Output',
                input: tc.hidden ? 'Hidden Case' : tc.input,
                params: tc.hidden ? {} : tc.params
            };

            if (line) {
                const actual = line.replace(searchStr, '').trim();
                resObj.actual = actual;
                
                // Aggressive Normalization for Comparison
                const normExpected = String(tc.expected).replace(/\s+/g, '').replace(/['"]/g, '').toLowerCase();
                const normActual = String(actual).replace(/\s+/g, '').replace(/['"]/g, '').toLowerCase();

                if (normExpected === normActual) {
                    resObj.status = 'Accepted';
                    passedCount++;
                } else {
                    resObj.status = 'Wrong Answer';
                }
            }
            finalResults.push(resObj);
        });

        const score = (testCases.length > 0) ? (passedCount / testCases.length) * 100 : 0;

        // 7. Store Result (Async)
        // Don't await this to keep UI snappy
        const status = (result.status.id === 3 && stderr === "") ? 'success' : 'completed_with_errors';
        
        supabase.from('executions').insert({
            user_id: userId || 'anon',
            language,
            code,
            status: status,
            stdout, // Store full output for debugging
            stderr: stderr || compile_output,
            score,
            metadata: { problem_id: problemId }
        }).then(() => {});

        // 8. Send Response
        // Combine stderr and stdout for the user console
        const userConsoleOutput = (stderr ? `[STDERR]\n${stderr}\n` : "") + (stdout ? `[STDOUT]\n${stdout}` : "");

        res.json({
            status: status,
            output: userConsoleOutput, // This goes to the "Console" tab in UI
            results: finalResults, // This goes to "Test Cases" tab
            score: score
        });

    } catch (e: any) {
        console.error("Execution Error:", e);
        res.status(500).json({ status: 'Server Error', output: e.message, results: [] });
    }
});

// Healthcheck
app.get('/healthcheck', (req, res) => res.json({ status: 'ok', judge0: JUDGE0_URLS[0] }));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});