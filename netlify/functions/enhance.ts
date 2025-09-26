// netlify/functions/enhance.ts

import { Handler, HandlerEvent } from '@netlify/functions';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
import { AnalysisReport } from '../../src/types';
import { diffWordsWithSpace } from 'diff';

// Securely initialize the Gemini client on the server
function getGenAIClient(): GoogleGenerativeAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GEMINI_API_KEY not found in environment variables");
        throw new Error("GEMINI_API_KEY environment variable is not set in the Netlify build environment.");
    }
    console.log("API key found, initializing GoogleGenerativeAI...");
    return new GoogleGenerativeAI(apiKey);
}

// Helper function to generate highlighted HTML from text differences
function highlightChanges(original: string, revised: string): string {
  const escapeHtml = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = diffWordsWithSpace(original || '', revised || '');
  return parts.map(p => {
    const v = escapeHtml(p.value);
    if (p.added) return `<ins class="vesta-added" style="background:#e6ffed;color:#064e3b;text-decoration:none;">${v}</ins>`;
    if (p.removed) return `<del class="vesta-removed" style="background:#ffecec;color:#991b1b;text-decoration:line-through;">${v}</del>`;
    return v;
  }).join('');
}

export const handler: Handler = async (event: HandlerEvent) => {
    console.log("Enhance function called with method:", event.httpMethod);
    
    if (event.httpMethod !== 'POST') {
        return { 
            statusCode: 405, 
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST'
            },
            body: JSON.stringify({ error: 'Method Not Allowed' }) 
        };
    }

    try {
        console.log("Parsing request body...");
        const { planContent, report } = JSON.parse(event.body || '{}') as {
            planContent: string;
            report: AnalysisReport;
        };

        if (!planContent || !report || !report.findings) {
            return { 
                statusCode: 400, 
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ error: 'Missing planContent or report in the request body.' }) 
            };
        }

        console.log("Initializing Gemini AI client...");
        const genAI = getGenAIClient();
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ],
        });

        const findingsSummary = report.findings.map(f =>
            `- Finding: "${f.title}" (Severity: ${f.severity})\n` +
            `  - Recommendation: ${f.recommendation}`
        ).join('\n\n');

        const prompt = `You are an expert compliance editor. Your task is to produce a single, fully revised version of the provided project plan that integrates the suggested recommendations. Return ONLY the full revised document text. Do NOT include commentary, annotations, or metadata. Preserve all original formatting and section headings.

Original Plan:
---
${planContent}
---

Findings & Recommendations to address:
---
${findingsSummary}
---

Return the full revised document text only.`;

        console.log("Sending request to Gemini API...");
        const result = await model.generateContent(prompt);

        if (!result.response) {
            throw new Error("No response from Gemini API");
        }

        const enhancedText = result.response.text().trim();
        console.log("Enhancement successful, generating highlights...");
        
        const highlightedHtml = highlightChanges(planContent, enhancedText);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST'
            },
            body: JSON.stringify({ text: enhancedText, highlightedHtml }),
        };

    } catch (error) {
        console.error('Error in enhance function:', error);
        
        // More detailed error logging
        if (error instanceof Error) {
            console.error('Error name:', error.name);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
        }

        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ 
                error: 'An internal error occurred during enhancement.', 
                details: error instanceof Error ? error.message : 'Unknown error'
            }),
        };
    }
};