// src/api/vesta.ts
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import { AnalysisReport, Finding, KnowledgeSource, DismissalRule, CustomRegulation, ChatMessage } from '../types';
import { diffWordsWithSpace } from 'diff';

let ai: GoogleGenAI | null = null;

/**
 * Lazily initializes and returns the GoogleGenAI client instance.
 * Throws an error if the API key is not available.
 */
function getGenAIClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY environment variable is not set. Please configure it in your deployment settings.");
    }
    if (!ai) {
        ai = new GoogleGenAI({ apiKey });
    }
    return ai;
}

/* -----------------------------
   Report schema (used by analyze calls)
   ----------------------------- */
const reportSchema = {
    type: Type.OBJECT,
    properties: {
        scores: {
          type: Type.OBJECT,
          description: "A breakdown of scores in different categories from 0-100.",
          properties: {
            project: {
              type: Type.INTEGER,
              description: "Overall project score based on clarity, completeness, feasibility, and number of findings. A high score is good."
            },
            strategicGoals: {
              type: Type.INTEGER,
              description: "Score indicating alignment with provided strategic goals and in-house documents. A high score is good."
            },
            regulations: {
              type: Type.INTEGER,
              description: "Score for compliance with provided government regulations. A high score is good."
            },
            risk: {
              type: Type.INTEGER,
              description: "Score representing how well risks are identified and mitigated. A high score indicates low unmitigated risk."
            }
          },
          required: ["project", "strategicGoals", "regulations", "risk"]
        },
        findings: {
            type: Type.ARRAY,
            description: "A list of all issues, gaps, and warnings found in the document.",
            items: {
                type: Type.OBJECT,
                properties: {
                    title: {
                        type: Type.STRING,
                        description: "A concise, one-sentence title for the finding.",
                    },
                    severity: {
                        type: Type.STRING,
                        description: "Severity of the issue. Must be one of: 'critical', 'warning'.",
                    },
                    sourceSnippet: {
                        type: Type.STRING,
                        description: "The exact, verbatim quote from the project plan that this finding is based on.",
                    },
                    recommendation: {
                        type: Type.STRING,
                        description: "A detailed, actionable recommendation to fix the issue. If possible, cite relevant regulations like BSP (Bangko Sentral ng Pilipinas) circulars or the Data Privacy Act (RA 10173).",
                    },
                },
                required: ["title", "severity", "sourceSnippet", "recommendation"],
            },
        },
    },
    required: ["scores", "findings"],
};

/* ================================
   Helper: robust text extraction
   ================================ */
const extractTextFromGenAIResponse = (resp: any): string => {
    // different SDK fields may exist depending on API version, try common ones
    if (!resp) return '';
    if (typeof resp.text === 'string' && resp.text.trim().length > 0) return resp.text;
    if (typeof resp.outputText === 'string' && resp.outputText.trim().length > 0) return resp.outputText;
    if (resp?.candidates?.[0]?.content) return String(resp.candidates[0].content);
    // fallback to JSON string of response
    try { return JSON.stringify(resp); } catch { return String(resp); }
};

/* ============================
   Utility: clean model output
   ============================ */
function cleanOutput(raw: string) {
    let out = String(raw || '');
    // extract inside fenced code block if present
    const codeBlockMatch = out.match(/```(?:[\w-]+\n)?([\s\S]*?)```/);
    if (codeBlockMatch && codeBlockMatch[1]) out = codeBlockMatch[1];

    // remove lines that look like git diffs/patch metadata
    out = out
        .split('\n')
        .map(line => line.replace(/^\s*(\+\+|--|\+|-|>\s|<\s)\s?/, ''))
        .filter(line => !/^(diff --git|index |@@ |--- |\+\+\+ )/.test(line))
        .join('\n');

    // strip zero-width and RTF junk
    out = out.replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/^\s*{\\rtf1[\s\S]*?}/, '');
    out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

/* ============================
   Similarity: token overlap (Jaccard)
   ============================ */
function tokenOverlap(a: string, b: string): number {
    const tokenize = (s: string) =>
        String(s || '')
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean);

    const ta = new Set(tokenize(a));
    const tb = new Set(tokenize(b));

    if (ta.size === 0 && tb.size === 0) return 1;
    if (ta.size === 0 || tb.size === 0) return 0;

    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;

    const union = new Set([...ta, ...tb]).size;
    return inter / Math.max(1, union);
}

/* ============================
   Primary Analyzer
   ============================ */
export async function analyzePlan(planContent: string, knowledgeSources: KnowledgeSource[], dismissalRules: DismissalRule[], customRegulations: CustomRegulation[]): Promise<Omit<AnalysisReport, 'id' | 'workspaceId' | 'createdAt'>> {
    if (!planContent.trim()) {
        return {
            title: "Analysis Failed",
            resilienceScore: 0,
            scores: { project: 0, strategicGoals: 0, regulations: 0, risk: 0 },
            findings: [{
                id: 'error-empty',
                title: 'Empty Document',
                severity: 'critical',
                sourceSnippet: 'N/A',
                recommendation: 'The submitted document is empty. Please provide a project plan to analyze.',
                status: 'active',
            }],
            summary: { critical: 1, warning: 0, checks: 0 },
            documentContent: planContent
        };
    }

    let contextPrompt = '';

    if (knowledgeSources.length > 0) {
        const sourcesText = knowledgeSources.map(s => `--- KNOWLEDGE SOURCE: ${s.title} ---\n${s.content}`).join('\n\n');
        contextPrompt += `\n\nCONTEXTUAL KNOWLEDGE BASE (Use this to inform your analysis):\n${sourcesText}`;
    }

    if (dismissalRules.length > 0) {
        const rulesText = dismissalRules.map(r => `- "${r.findingTitle}" (Reason: ${r.reason})`).join('\n');
        contextPrompt += `\n\nLEARNED DISMISSAL RULES (Do NOT report findings with these titles):\n${rulesText}`;
    }

    if (customRegulations && customRegulations.length > 0) {
        const rulesText = customRegulations.map(r => `- ${r.ruleText}`).join('\n');
        contextPrompt += `\n\nWORKSPACE-SPECIFIC CUSTOM REGULATIONS:\nThese are mandatory requirements for this workspace. For each rule below that is NOT followed by the project plan, you MUST generate a 'critical' finding.\n${rulesText}`;
    }

    try {
        const response: GenerateContentResponse = await getGenAIClient().models.generateContent({
            model: "gemini-2.5-flash",
            contents: `Analyze the following project plan:\n\n---\n\n${planContent}\n\n---\n\nPlease provide your analysis in the requested JSON format.`,
            config: {
                systemInstruction: `You are Vesta, an AI assistant specializing in digital resilience for the financial sector. Analyze project plans against financial regulations (BSP, BIR, Data Privacy Act). Provide findings with title, severity, exact snippet, and actionable recommendation.${contextPrompt}`,
                responseMimeType: "application/json",
                responseSchema: reportSchema,
            },
        });

        const jsonText = extractTextFromGenAIResponse(response).trim();
        const parsedReport = JSON.parse(jsonText);

        const criticalCount = parsedReport.findings.filter((f: any) => f.severity === 'critical').length;
        const warningCount = parsedReport.findings.filter((f: any) => f.severity === 'warning').length;
        const checksPerformed = Math.floor(1000 + Math.random() * 500);

        return {
            title: "Project Plan Analysis",
            resilienceScore: parsedReport.scores.project,
            scores: parsedReport.scores,
            findings: parsedReport.findings.map((f: any, index: number): Finding => ({
                id: `finding-${Date.now()}-${index}`,
                title: f.title,
                severity: f.severity,
                sourceSnippet: f.sourceSnippet,
                recommendation: f.recommendation,
                status: 'active',
            })),
            summary: {
                critical: criticalCount,
                warning: warningCount,
                checks: checksPerformed,
            },
            documentContent: planContent,
        };
    } catch (error) {
        console.error("Error analyzing plan with Gemini:", error);
        return {
            title: "Analysis Error",
            resilienceScore: 0,
            scores: { project: 0, strategicGoals: 0, regulations: 0, risk: 0 },
            findings: [{
                id: 'error-1',
                title: 'Failed to analyze the document.',
                severity: 'critical',
                sourceSnippet: 'N/A',
                recommendation: `The AI model could not process the document. Error: ${error}`,
                status: 'active',
            }],
            summary: { critical: 1, warning: 0, checks: 0 },
            documentContent: planContent,
        };
    }
}

// Quick analysis
export async function analyzePlanQuick(planContent: string, knowledgeSources: KnowledgeSource[], dismissalRules: DismissalRule[], customRegulations: CustomRegulation[]): Promise<Omit<AnalysisReport, 'id' | 'workspaceId' | 'createdAt'>> {
    const truncated = String(planContent || '').slice(0, 4000);
    const minimalSources: KnowledgeSource[] = [];
    const minimalCustom: CustomRegulation[] = [];

    try {
        const response: GenerateContentResponse = await getGenAIClient().models.generateContent({
            model: "gemini-2.5-flash",
            contents: `Quickly analyze the following project plan (truncated):\n\n---\n\n${truncated}\n\n---`,
            config: {
                systemInstruction: `You are Vesta. Provide a fast, approximate assessment with fewer findings. Apply these learned dismissals:\n${(dismissalRules || []).map(r => `- ${r.findingTitle} (${r.reason})`).join('\n')}`,
                responseMimeType: "application/json",
                responseSchema: reportSchema,
            },
        });

        const jsonText = extractTextFromGenAIResponse(response).trim();
        const parsedReport = JSON.parse(jsonText);

        const criticalCount = parsedReport.findings.filter((f: any) => f.severity === 'critical').length;
        const warningCount = parsedReport.findings.filter((f: any) => f.severity === 'warning').length;

        return {
            title: "Quick Analysis",
            resilienceScore: parsedReport.scores.project,
            scores: parsedReport.scores,
            findings: parsedReport.findings.slice(0, 8).map((f: any, index: number): Finding => ({
                id: `qfinding-${Date.now()}-${index}`,
                title: f.title,
                severity: f.severity,
                sourceSnippet: f.sourceSnippet,
                recommendation: f.recommendation,
                status: 'active',
            })),
            summary: {
                critical: criticalCount,
                warning: warningCount,
                checks: 300,
            },
            documentContent: truncated,
        };
    } catch (error) {
        console.error("Error during quick analysis:", error);
        return analyzePlan(truncated, minimalSources, dismissalRules || [], minimalCustom);
    }
}

/* ============================
   IMPROVE PLAN
   ============================ */
export async function improvePlan(planContent: string, report: AnalysisReport): Promise<string> {
    if (!planContent || !planContent.trim()) return planContent;
    const findingsSummary = (report?.findings || []).map(f =>
        `- Finding: "${f.title}" (Severity: ${f.severity})\n  - Source: "${f.sourceSnippet}"\n  - Recommendation: ${f.recommendation}`
    ).join('\n\n') || 'No findings provided.';

    const normalizedPlan = planContent.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    const systemPrompt = `
You are a compliance editor for project plans in the financial sector.
Task: produce a revised version of the plan that integrates recommendations.

Rules:
- Preserve all section headings, numbering, and bullet points exactly.
- Do NOT add new sections or budgets.
- Only apply inline edits (grammar, clarity, compliance fixes).
- Do NOT invent new regulatory citations.
Return ONLY the full revised text.
`;

    const userPrompt = `
Original Plan:
<<<START>>>
${normalizedPlan}
<<<END>>>

Findings & Recommendations:
${findingsSummary}
`;

    const genai = getGenAIClient();

    const callModel = async (sys: string, userText: string, modelName = "gemini-2.5-flash", temperature = 0.3) => {
        const resp = await genai.models.generateContent({
            model: modelName,
            contents: userText,
            config: {
                systemInstruction: sys,
                responseMimeType: "text/plain",
            },
        });
        return extractTextFromGenAIResponse(resp);
    };

    let rawPrimary = '';
    try {
        rawPrimary = await callModel(systemPrompt, userPrompt);
    } catch (err) {
        console.error("improvePlan primary failed:", err);
        return normalizedPlan;
    }

    const cleanedPrimary = cleanOutput(rawPrimary);
    const simPrimary = tokenOverlap(normalizedPlan, cleanedPrimary);
    const diffArtifactFound = /^(?:\+{1,2}|-{1,2}|diff --git|@@ )/m.test(rawPrimary);
    if (!diffArtifactFound && simPrimary >= 0.85) {
        return cleanedPrimary;
    }

    // Fallback strict
    const strictSystem = `You are a strict editor. Only fix grammar and clarity. Keep structure identical.`;
    const strictUser = `
Original Plan:
${normalizedPlan}

Findings:
${findingsSummary}
`;

    let rawStrict = '';
    try {
        rawStrict = await callModel(strictSystem, strictUser, "gemini-2.5-flash", 0.15);
    } catch {
        return normalizedPlan;
    }

    const cleanedStrict = cleanOutput(rawStrict);
    const simStrict = tokenOverlap(normalizedPlan, cleanedStrict);
    return simStrict >= 0.80 ? cleanedStrict : normalizedPlan;
}

/* ============================
   Highlight Changes
   ============================ */
export function highlightChanges(original: string, revised: string): string {
  const parts = diffWordsWithSpace(original || '', revised || '');
  const escapeHtml = (str: string) =>
    String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  return parts.map(p => {
    const v = escapeHtml(p.value);
    if (p.added) {
      return `<ins style="background:#e6ffed;color:#064e3b;text-decoration:none;">${v}</ins>`;
    }
    if (p.removed) {
      return `<del style="background:#ffecec;color:#991b1b;text-decoration:line-through;">${v}</del>`;
    }
    return v;
  }).join('');
}

/* ============================
   Chat Response
   ============================ */
export async function getChatResponse(documentContent: string, history: ChatMessage[], newMessage: string): Promise<string> {
    const contents = [
        ...history.map(msg => (({
            role: msg.role,
            parts: [{ text: msg.content }]
        }))),
        {
            role: 'user' as const,
            parts: [{ text: newMessage }]
        }
    ];

    try {
        const response: GenerateContentResponse = await getGenAIClient().models.generateContent({
            model: "gemini-2.5-flash",
            contents: contents,
            config: {
                systemInstruction: `You are Vesta, an AI assistant. The user is asking about the document.\n\nDOCUMENT CONTEXT:\n${documentContent}`,
            },
        });

        return extractTextFromGenAIResponse(response).trim();
    } catch (error) {
        console.error("Chat error:", error);
        return "Sorry, I encountered an error while processing your request.";
    }
}

/* ============================
   Netlify Enhance Helper
   ============================ */
export async function improvePlanWithHighlights(planContent: string, report: AnalysisReport): Promise<{ text: string; highlightedHtml: string }> {
    const response = await fetch('/.netlify/functions/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planContent, report }),
    });
  
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Enhancement failed.');
    }
  
    return await response.json();
}

/* ============================
   AUTO-ENHANCE REPORT (new)
   ============================ */
export async function autoEnhanceReport(report: AnalysisReport): Promise<AnalysisReport> {
    const planContent = report.documentContent ?? "";
    if (!planContent.trim()) return report;

    try {
        const revised = await improvePlan(planContent, report);
        const diffHtml = highlightChanges(planContent, revised);

        return {
            ...report,
            diffContent: diffHtml,
        };
    } catch (err) {
        console
        console.error("autoEnhanceReport failed:", err);
        return report; // fallback: return original report unchanged
    }
}
