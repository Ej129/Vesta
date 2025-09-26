// src/api/vesta.ts
import { GoogleGenAI, Type, GenerateContentResponse } from "@google/genai";
import {
  AnalysisReport,
  Finding,
  KnowledgeSource,
  DismissalRule,
  CustomRegulation,
  ChatMessage,
} from "../types";
import { diffWordsWithSpace } from "diff";

let ai: GoogleGenAI | null = null;

/**
 * Lazily initializes and returns the GoogleGenAI client instance.
 * Throws an error if the API key is not available.
 */
function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY environment variable is not set. Please configure it in your deployment settings."
    );
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
      description:
        "A breakdown of scores in different categories from 0-100.",
      properties: {
        project: {
          type: Type.INTEGER,
          description:
            "Overall project score based on clarity, completeness, feasibility, and number of findings. A high score is good.",
        },
        strategicGoals: {
          type: Type.INTEGER,
          description:
            "Score indicating alignment with provided strategic goals and in-house documents. A high score is good.",
        },
        regulations: {
          type: Type.INTEGER,
          description:
            "Score for compliance with provided government regulations. A high score is good.",
        },
        risk: {
          type: Type.INTEGER,
          description:
            "Score representing how well risks are identified and mitigated. A high score indicates low unmitigated risk.",
        },
      },
      required: ["project", "strategicGoals", "regulations", "risk"],
    },
    findings: {
      type: Type.ARRAY,
      description:
        "A list of all issues, gaps, and warnings found in the document.",
      items: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: "A concise, one-sentence title for the finding.",
          },
          severity: {
            type: Type.STRING,
            description:
              "Severity of the issue. Must be one of: 'critical', 'warning'.",
          },
          sourceSnippet: {
            type: Type.STRING,
            description:
              "The exact, verbatim quote from the project plan that this finding is based on.",
          },
          recommendation: {
            type: Type.STRING,
            description:
              "A detailed, actionable recommendation to fix the issue. If possible, cite relevant regulations like BSP circulars or RA 10173.",
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
  if (!resp) return "";

  if (typeof resp.text === "string" && resp.text.trim()) return resp.text.trim();
  if (typeof resp.outputText === "string" && resp.outputText.trim())
    return resp.outputText.trim();

  if (Array.isArray(resp.output) && resp.output.length > 0) {
    try {
      const texts: string[] = [];
      for (const out of resp.output) {
        if (!out) continue;
        if (typeof out === "string" && out.trim()) {
          texts.push(out.trim());
          continue;
        }
        if (Array.isArray(out.content)) {
          for (const c of out.content) {
            if (!c) continue;
            if (typeof c === "string" && c.trim()) texts.push(c.trim());
            else if (c.text && typeof c.text === "string" && c.text.trim())
              texts.push(c.text.trim());
          }
        } else if (out.text && typeof out.text === "string") {
          texts.push(out.text.trim());
        }
      }
      if (texts.length) return texts.join("\n\n").trim();
    } catch {
      // ignore
    }
  }

  if (resp?.candidates?.[0]?.content)
    return String(resp.candidates[0].content).trim();

  if (resp?.choices?.[0]) {
    const choice = resp.choices[0];
    if (choice?.message?.content) return String(choice.message.content).trim();
    if (choice?.message && typeof choice.message === "string")
      return choice.message.trim();
    if (choice?.text) return String(choice.text).trim();
  }

  try {
    const s = JSON.stringify(resp);
    return s === "{}" ? "" : s;
  } catch {
    return String(resp || "");
  }
};

/* ============================
   Utility: clean model output
   ============================ */
function cleanOutput(raw: string) {
  let out = String(raw || "");
  const codeBlockMatch = out.match(/```(?:[\w-]+\n)?([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1]) out = codeBlockMatch[1];

  out = out
    .split("\n")
    .map((line) => line.replace(/^\s*(\+\+|--|\+|-|>\s|<\s)\s?/, ""))
    .filter(
      (line) =>
        !/^(diff --git|index |@@ |--- |\+\+\+ )/.test(line)
    )
    .join("\n");

  out = out
    .replace(/[\u200B-\u200F\uFEFF]/g, "")
    .replace(/^\s*{\\rtf1[\s\S]*?}/, "");
  out = out.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

/* ============================
   Similarity: token overlap
   ============================ */
function tokenOverlap(a: string, b: string): number {
  const tokenize = (s: string) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
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
   Analyzer
   ============================ */
export async function analyzePlan(
  planContent: string,
  knowledgeSources: KnowledgeSource[],
  dismissalRules: DismissalRule[],
  customRegulations: CustomRegulation[]
): Promise<Omit<AnalysisReport, "id" | "workspaceId" | "createdAt">> {
  if (!planContent.trim()) {
    return {
      title: "Analysis Failed",
      resilienceScore: 0,
      scores: { project: 0, strategicGoals: 0, regulations: 0, risk: 0 },
      findings: [
        {
          id: "error-empty",
          title: "Empty Document",
          severity: "critical",
          sourceSnippet: "N/A",
          recommendation: "The submitted document is empty.",
          status: "active",
        },
      ],
      summary: { critical: 1, warning: 0, checks: 0 },
      documentContent: planContent,
    };
  }

  let contextPrompt = "";
  if (knowledgeSources.length > 0) {
    const sourcesText = knowledgeSources
      .map((s) => `--- KNOWLEDGE SOURCE: ${s.title} ---\n${s.content}`)
      .join("\n\n");
    contextPrompt += `\n\nCONTEXTUAL KNOWLEDGE:\n${sourcesText}`;
  }
  if (dismissalRules.length > 0) {
    const rulesText = dismissalRules
      .map((r) => `- "${r.findingTitle}" (${r.reason})`)
      .join("\n");
    contextPrompt += `\n\nDISMISSALS:\n${rulesText}`;
  }
  if (customRegulations && customRegulations.length > 0) {
    const rulesText = customRegulations.map((r) => `- ${r.ruleText}`).join("\n");
    contextPrompt += `\n\nCUSTOM REGS:\n${rulesText}`;
  }

  try {
    const response: GenerateContentResponse =
      await getGenAIClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Analyze the following project plan:\n${planContent}`,
        config: {
          systemInstruction: `You are Vesta. Analyze against BSP, BIR, and PH Gov. ${contextPrompt}`,
          responseMimeType: "application/json",
          responseSchema: reportSchema,
        },
      });

    const jsonText = extractTextFromGenAIResponse(response).trim();
    const parsedReport = JSON.parse(jsonText);

    const criticalCount = parsedReport.findings.filter(
      (f: any) => f.severity === "critical"
    ).length;
    const warningCount = parsedReport.findings.filter(
      (f: any) => f.severity === "warning"
    ).length;

    return {
      title: "Project Plan Analysis",
      resilienceScore: parsedReport.scores.project,
      scores: parsedReport.scores,
      findings: parsedReport.findings.map(
        (f: any, i: number): Finding => ({
          id: `finding-${Date.now()}-${i}`,
          title: f.title,
          severity: f.severity,
          sourceSnippet: f.sourceSnippet,
          recommendation: f.recommendation,
          status: "active",
        })
      ),
      summary: { critical: criticalCount, warning: warningCount, checks: 1000 },
      documentContent: planContent,
    };
  } catch (error) {
    console.error("Error analyzing plan:", error);
    return {
      title: "Analysis Error",
      resilienceScore: 0,
      scores: { project: 0, strategicGoals: 0, regulations: 0, risk: 0 },
      findings: [
        {
          id: "error-1",
          title: "Failed to analyze the document.",
          severity: "critical",
          sourceSnippet: "N/A",
          recommendation: `Error: ${error}`,
          status: "active",
        },
      ],
      summary: { critical: 1, warning: 0, checks: 0 },
      documentContent: planContent,
    };
  }
}

/* ============================
   Quick Analyzer
   ============================ */
export async function analyzePlanQuick(
  planContent: string,
  knowledgeSources: KnowledgeSource[],
  dismissalRules: DismissalRule[],
  customRegulations: CustomRegulation[]
): Promise<Omit<AnalysisReport, "id" | "workspaceId" | "createdAt">> {
  const truncated = String(planContent || "").slice(0, 4000);

  try {
    const response: GenerateContentResponse =
      await getGenAIClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents: `Quickly analyze:\n${truncated}`,
        config: {
          systemInstruction: `You are Vesta. Fast assessment only.`,
          responseMimeType: "application/json",
          responseSchema: reportSchema,
        },
      });

    const jsonText = extractTextFromGenAIResponse(response).trim();
    const parsedReport = JSON.parse(jsonText);

    return {
      title: "Quick Analysis",
      resilienceScore: parsedReport.scores.project,
      scores: parsedReport.scores,
      findings: parsedReport.findings.slice(0, 8).map(
        (f: any, i: number): Finding => ({
          id: `qfinding-${Date.now()}-${i}`,
          title: f.title,
          severity: f.severity,
          sourceSnippet: f.sourceSnippet,
          recommendation: f.recommendation,
          status: "active",
        })
      ),
      summary: { critical: 0, warning: 0, checks: 300 },
      documentContent: truncated,
    };
  } catch (error) {
    console.error("Error quick analysis:", error);
    return analyzePlan(truncated, [], dismissalRules || [], customRegulations);
  }
}

/* ============================
   IMPROVE PLAN
   ============================ */
export async function improvePlan(
  planContent: string,
  report: AnalysisReport
): Promise<string> {
  if (!planContent || !planContent.trim()) return planContent;

  const findingsSummary =
    (report?.findings || [])
      .map(
        (f) =>
          `- ${f.title} (${f.severity})\n  Source: "${f.sourceSnippet}"\n  Recommendation: ${f.recommendation}`
      )
      .join("\n\n") || "No findings provided.";

  const normalizedPlan = planContent
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const systemPrompt = `
You are a compliance editor for project plans.
Rules:
- Preserve headings, numbering, bullets.
- No new sections or facts.
- Inline edits only (grammar, clarity, compliance).
- No new regulatory citations unless present in recommendations.
Return only the revised document.
`;

  const userPrompt = `
Plan:
${normalizedPlan}

Findings:
${findingsSummary}
`;

  const genai = getGenAIClient();

  const callModel = async (sys: string, userText: string) => {
    const resp = await genai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: userText,
      config: { systemInstruction: sys, responseMimeType: "text/plain" },
    });
    const t = extractTextFromGenAIResponse(resp);
    if (!t || !t.trim()) throw new Error("Empty response from GenAI");
    return t;
  };

  try {
    const rawPrimary = await callModel(systemPrompt, userPrompt);
    const cleanedPrimary = cleanOutput(rawPrimary);
    const sim = tokenOverlap(normalizedPlan, cleanedPrimary);
    if (sim >= 0.85) return cleanedPrimary;
  } catch (err) {
    console.error("Primary improvePlan failed:", err);
  }

  // fallback: minimal edits
  try {
    const strictSystem = `You are a conservative editor. Only fix grammar/punctuation. Preserve structure.`;
    const rawStrict = await callModel(strictSystem, userPrompt);
    const cleanedStrict = cleanOutput(rawStrict);
    return cleanedStrict;
  } catch (err) {
    console.error("Strict improvePlan failed:", err);
    return normalizedPlan;
  }
}

/* ============================
   Highlight changes
   ============================ */
export function highlightChanges(original: string, revised: string): string {
  const parts = diffWordsWithSpace(original || "", revised || "");
  const escapeHtml = (str: string) =>
    String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  return parts
    .map((p) => {
      const v = escapeHtml(p.value);
      if (p.added) {
        return `<ins style="background:#e6ffed;color:#064e3b;">${v}</ins>`;
      }
      if (p.removed) {
        return `<del style="background:#ffecec;color:#991b1b;">${v}</del>`;
      }
      return v;
    })
    .join("");
}

/* ============================
   Chat helper
   ============================ */
export async function getChatResponse(
  documentContent: string,
  history: ChatMessage[],
  newMessage: string
): Promise<string> {
  const contents = [
    ...history.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
    { role: "user" as const, parts: [{ text: newMessage }] },
  ];

  try {
    const response: GenerateContentResponse =
      await getGenAIClient().models.generateContent({
        model: "gemini-2.5-flash",
        contents,
        config: {
          systemInstruction: `You are Vesta. Answer questions about this document:\n${documentContent}`,
        },
      });
    return extractTextFromGenAIResponse(response).trim();
  } catch (error) {
    console.error("Chat error:", error);
    return "Error occurred while answering.";
  }
}

/* ============================
   HTTP helper
   ============================ */
export async function improvePlanWithHighlights(
  planContent: string,
  report: AnalysisReport
): Promise<{ text: string; highlightedHtml: string }> {
  const resp = await fetch("/.netlify/functions/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planContent, report }),
  });
  if (!resp.ok) throw new Error("Enhancement API failed.");
  return await resp.json();
}

/* ============================
   AUTO-ENHANCE REPORT
   ============================ */
export async function autoEnhanceReport(
  report: AnalysisReport
): Promise<AnalysisReport> {
  const planContent = report.documentContent ?? "";
  if (!planContent.trim()) return report;

  try {
    console.info(
      `[vesta] autoEnhanceReport start — plan length=${planContent.length}`
    );
    const revised = await improvePlan(planContent, report);
    if (!revised || !revised.trim())
      throw new Error("Empty enhancement result from improvePlan");
    const diffHtml = highlightChanges(planContent, revised);
    return { ...report, diffContent: diffHtml };
  } catch (errPrimary) {
    console.error("[vesta] autoEnhanceReport primary failed:", errPrimary);
    try {
      const fallback = await improvePlanWithHighlights(planContent, report);
      return {
        ...report,
        diffContent:
          fallback.highlightedHtml ||
          highlightChanges(planContent, fallback.text || planContent),
      };
    } catch (errFallback) {
      console.error("[vesta] autoEnhanceReport fallback failed:", errFallback);
      throw new Error(
        `Auto-enhance failed. Primary: ${errPrimary}; Fallback: ${errFallback}`
      );
    }
  }
}
