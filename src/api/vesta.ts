// src/api/vesta.ts
import {
    AnalysisReport,
    Finding,
    KnowledgeSource,
    DismissalRule,
    CustomRegulation,
    ChatMessage,
  } from "../types";
  import { diffWordsWithSpace } from "diff";
  
  // All AI operations now go through Netlify functions (server-side)
  // No direct client-side Google AI usage
  
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
     API Helper: Make requests with proper error handling
     ============================ */
  async function makeAPIRequest(endpoint: string, data: any) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(data),
    });
  
    if (!response.ok) {
      let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error;
        }
        if (errorData.details) {
          errorMessage += ` - ${errorData.details}`;
        }
      } catch (e) {
        // If we can't parse the error response, use the generic message
      }
      throw new Error(errorMessage);
    }
  
    const result = await response.json();
    if (result.error) {
      throw new Error(result.error);
    }
  
    return result;
  }
  
  /* ============================
     Analyzer - Uses Netlify function
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
  
    try {
      const result = await makeAPIRequest("/.netlify/functions/analyze", {
        planContent,
        knowledgeSources,
        dismissalRules,
        customRegulations,
      });
  
      return result;
  
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
            recommendation: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            status: "active",
          },
        ],
        summary: { critical: 1, warning: 0, checks: 0 },
        documentContent: planContent,
      };
    }
  }
  
  /* ============================
     Quick Analyzer - Uses Netlify function
     ============================ */
  export async function analyzePlanQuick(
    planContent: string,
    knowledgeSources: KnowledgeSource[],
    dismissalRules: DismissalRule[],
    customRegulations: CustomRegulation[]
  ): Promise<Omit<AnalysisReport, "id" | "workspaceId" | "createdAt">> {
    const truncated = String(planContent || "").slice(0, 4000);
  
    try {
      const result = await makeAPIRequest("/.netlify/functions/analyze-quick", {
        planContent: truncated,
        knowledgeSources,
        dismissalRules,
        customRegulations,
      });
  
      return result;
  
    } catch (error) {
      console.error("Error quick analysis:", error);
      // Fallback to regular analysis
      return analyzePlan(truncated, [], dismissalRules || [], customRegulations);
    }
  }
  
  /* ============================
     IMPROVE PLAN - Uses Netlify function
     ============================ */
  export async function improvePlan(
    planContent: string,
    report: AnalysisReport
  ): Promise<string> {
    if (!planContent || !planContent.trim()) return planContent;
  
    const normalizedPlan = planContent
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  
    try {
      const result = await makeAPIRequest("/.netlify/functions/enhance", {
        planContent: normalizedPlan,
        report,
      });
  
      const rawPrimary = result.text || normalizedPlan;
      const cleanedPrimary = cleanOutput(rawPrimary);
      const sim = tokenOverlap(normalizedPlan, cleanedPrimary);
      
      // If similarity is reasonable, return the enhanced version
      if (sim >= 0.7) return cleanedPrimary;
      
      // If similarity is too low, return the original
      console.warn("Enhanced version too different from original, returning original");
      return normalizedPlan;
  
    } catch (err) {
      console.error("improvePlan failed:", err);
      throw err;
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
     Chat helper - Uses Netlify function
     ============================ */
  export async function getChatResponse(
    documentContent: string,
    history: ChatMessage[],
    newMessage: string
  ): Promise<string> {
    try {
      const result = await makeAPIRequest("/.netlify/functions/chat", {
        documentContent,
        history,
        newMessage,
      });
  
      return result.response || "Sorry, I couldn't generate a response.";
  
    } catch (error) {
      console.error("Chat error:", error);
      return `Error occurred while answering: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
  
  /* ============================
     HTTP helper - Enhanced error handling
     ============================ */
  export async function improvePlanWithHighlights(
    planContent: string,
    report: AnalysisReport
  ): Promise<{ text: string; highlightedHtml: string }> {
    try {
      const result = await makeAPIRequest("/.netlify/functions/enhance", {
        planContent,
        report,
      });
  
      return {
        text: result.text || planContent,
        highlightedHtml: result.highlightedHtml || highlightChanges(planContent, result.text || planContent),
      };
  
    } catch (error) {
      console.error("Enhancement with highlights failed:", error);
      throw error;
    }
  }
  
  /* ============================
     AUTO-ENHANCE REPORT - Streamlined
     ============================ */
  export async function autoEnhanceReport(
    report: AnalysisReport
  ): Promise<AnalysisReport> {
    const planContent = report.documentContent ?? "";
    if (!planContent.trim()) {
      throw new Error("Document content is empty");
    }
  
    try {
      console.info(
        `[vesta] autoEnhanceReport start — plan length=${planContent.length}`
      );
      
      // Use the API-based improvePlanWithHighlights function
      const result = await improvePlanWithHighlights(planContent, report);
      
      if (!result.text || !result.text.trim()) {
        throw new Error("Enhancement returned empty content");
      }
  
      const diffHtml = result.highlightedHtml || highlightChanges(planContent, result.text);
      
      console.info("[vesta] autoEnhanceReport completed successfully");
      return { 
        ...report, 
        diffContent: diffHtml 
      };
      
    } catch (error) {
      console.error("[vesta] autoEnhanceReport failed:", error);
      
      // Provide more specific error messages
      let errorMessage = "Auto-enhance failed";
      if (error instanceof Error) {
        if (error.message.includes("GEMINI_API_KEY")) {
          errorMessage = "API configuration error - please ensure Gemini API key is properly configured";
        } else if (error.message.includes("API request failed")) {
          errorMessage = "Enhancement service is temporarily unavailable";
        } else if (error.message.includes("network") || error.message.includes("fetch")) {
          errorMessage = "Network error occurred - please check your connection";
        } else if (error.message.includes("timeout")) {
          errorMessage = "Enhancement request timed out - please try again";
        } else {
          errorMessage = error.message;
        }
      }
      
      throw new Error(errorMessage);
    }
  }