// src/screens/AnalysisScreen.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AnalysisReport,
  Finding,
  ScreenLayoutProps,
  FindingStatus,
  FeedbackReason,
  ChatMessage,
  Screen,
} from "../types";
import {
  StarIcon,
  DownloadIcon,
  EditIcon,
  CheckCircleIcon,
  XCircleIcon,
  AlertTriangleIcon,
  AlertCircleIcon,
  SendIcon,
  MessageSquareIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SparklesIcon,
} from "../components/Icons";
import jsPDF from "jspdf";
import { Document as DocxDocument, Packer, Paragraph, TextRun } from "docx";
import * as workspaceApi from "../api/workspace";
import * as vestaApi from "../api/vesta";
import FeedbackModal from "../components/FeedbackModal";
import { AnimatedChecklist } from "../components/AnimatedChecklist";

/* --------------------------------------------------------------------------
  NOTES:
  - This file keeps your previous behaviours but reorganizes for safety
  - Make sure 'docx' and 'jspdf' are installed in your project
  - Ensure your backend sanitizes diffContent; this file applies a client-side
    conservative sanitizer to reduce XSS risk when using dangerouslySetInnerHTML
  -------------------------------------------------------------------------- */

/* ----------------------------- Utilities ------------------------------ */

const escapeHtml = (unsafe: string) =>
  unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A conservative client-side sanitizer: only allow a small set of tags used by your diff (ins, del, mark, br)
function sanitizeHtmlAllowlist(html: string) {
  // Remove any <script> or <style> content outright
  let sanitized = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  sanitized = sanitized.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "");

  // Allow only certain tags and their attributes (very conservative)
  // We'll strip attributes except for 'class' on allowed tags
  // Allowed tags: br, mark, del, ins, strong, b, i, em, p, ul, ol, li, span
  const allowed = [
    "br",
    "mark",
    "del",
    "ins",
    "strong",
    "b",
    "i",
    "em",
    "p",
    "ul",
    "ol",
    "li",
    "span",
  ];

  // Remove any tag that's not allowed
  sanitized = sanitized.replace(/<\/?([a-zA-Z0-9-]+)(\s[^>]*)?>/g, (match, tag, attrs) => {
    if (!allowed.includes(tag.toLowerCase())) return "";
    // Keep tag but strip attributes except class
    if (!attrs) return `<${tag}>`;
    // extract class attr only
    const classMatch = attrs.match(/class\s*=\s*"(.*?)"/i);
    if (classMatch) return `<${tag} class="${classMatch[1]}">`;
    return `<${tag}>`;
  });

  return sanitized;
}

/* Inject snippet ids: find first occurrence of each finding.sourceSnippet in the escaped content
   and wrap with span id="snippet-<id>" so we can scroll-to-highlight.
   This works on plain text and on sanitized HTML (attempts simple replace).
*/
function injectSnippetIdsIntoHtml(html: string, findings: Finding[] = []) {
  let out = html;
  for (const f of findings) {
    if (!f || !f.sourceSnippet) continue;
    const snippet = f.sourceSnippet.trim();
    if (!snippet) continue;

    try {
      const escapedSnippet = escapeHtml(snippet);
      const re = new RegExp(escapeRegExp(escapedSnippet), "i");
      // Only replace first occurrence to avoid multiple id collisions
      if (re.test(out)) {
        out = out.replace(re, `<span id="snippet-${f.id}" class="snippet-target">${escapedSnippet}</span>`);
      } else {
        // If HTML version doesn't contain the escaped snippet (rare), try plain snippet (unescaped)
        const rePlain = new RegExp(escapeRegExp(snippet), "i");
        if (rePlain.test(out)) {
          out = out.replace(rePlain, `<span id="snippet-${f.id}" class="snippet-target">${snippet}</span>`);
        }
      }
    } catch (err) {
      // a replace failure shouldn't break the whole rendering
      console.warn("injectSnippetIdsIntoHtml error for finding:", f.id, err);
    }
  }
  return out;
}

/* Small helper to convert diff-style text to plain content (for downloads).
   Keeps only '++ ' lines (additions) or original depending on preference.
*/
function diffToPlainText(diff?: string | null) {
  if (!diff) return "";
  // If diff contains HTML tags, strip tags and return textContent-like using a simple approach
  if (/<\w+[^>]*>/.test(diff)) {
    // naive strip tags
    return diff.replace(/<\/?[^>]+(>|$)/g, "");
  }
  // Otherwise, treat as line diff
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("++ ")) return line.substring(3);
      if (line.startsWith("-- ")) return ""; // removed
      return line;
    })
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/* --------------------------- Small UI bits --------------------------- */

// Arrow Left Icon Component (kept simple)
const ArrowLeftIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
  </svg>
);

const BackButton: React.FC<{ onBack: () => void; title?: string }> = ({ onBack, title }) => (
  <button
    onClick={onBack}
    className="flex items-center space-x-2 px-3 py-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition"
    title={title || "Back to Dashboard"}
    aria-label="Back"
  >
    <ArrowLeftIcon className="w-5 h-5" />
    <span className="text-sm font-medium">Back</span>
  </button>
);

/* ------------------------- Enhance Controls ------------------------- */
const EnhanceControls: React.FC<{
  activeReport: AnalysisReport;
  onAutoEnhance?: (report?: AnalysisReport) => Promise<void> | void;
  isEnhancing?: boolean;
  isAnalyzing?: boolean;
}> = ({ activeReport, onAutoEnhance, isEnhancing, isAnalyzing }) => {
  const busy = !!isEnhancing || !!isAnalyzing;
  const buttonText = isEnhancing ? "Enhancing…" : isAnalyzing ? "Analyzing…" : "Auto-Enhance";

  const handleClick = async () => {
    if (busy || !activeReport || typeof onAutoEnhance !== "function") return;
    try {
      await onAutoEnhance(activeReport);
    } catch (err) {
      console.error("AutoEnhance error:", err);
      // optionally show user-level feedback
    }
  };

  return (
    <div className="w-full">
      <button
        onClick={handleClick}
        disabled={busy}
        aria-label="Auto Enhance Document"
        className={`inline-flex items-center justify-center gap-3 px-4 py-2 rounded-lg font-bold text-white shadow-md w-full transition ${
          busy ? "bg-gray-400 cursor-not-allowed" : "bg-red-600 hover:bg-red-700"
        }`}
        title={busy ? "Operation in progress" : "Automatically improve this document using AI"}
      >
        {isEnhancing ? (
          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <SparklesIcon className="w-4 h-4" />
        )}
        {buttonText}
      </button>
    </div>
  );
};

/* ------------------------- Download Dropdown ------------------------ */
const DownloadDropdown: React.FC<{
  onDownloadPdf: () => void;
  onDownloadTxt: () => void;
  onDownloadDocx: () => void;
}> = ({ onDownloadPdf, onDownloadTxt, onDownloadDocx }) => {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setIsOpen((s) => !s)}
        className="p-2 rounded-lg hover:bg-gray-100"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="Download options"
        title="Download options"
      >
        <DownloadIcon className="w-5 h-5 text-gray-600" />
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-44 bg-white rounded-md shadow border z-30">
          <button
            onClick={() => {
              onDownloadPdf();
              setIsOpen(false);
            }}
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50"
          >
            Download as PDF
          </button>
          <button
            onClick={() => {
              onDownloadDocx();
              setIsOpen(false);
            }}
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50"
          >
            Download as DOCX
          </button>
          <button
            onClick={() => {
              onDownloadTxt();
              setIsOpen(false);
            }}
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50"
          >
            Download as TXT
          </button>
        </div>
      )}
    </div>
  );
};

/* ------------------------- Document Editor ------------------------- */
const DocumentEditor: React.FC<{
  report: AnalysisReport;
  isEditing: boolean;
  onContentChange: (content: string) => void;
  onSaveChanges: () => void;
  onToggleEdit: () => void;
  onDownloadPdf: () => void;
  onDownloadTxt: () => void;
  onDownloadDocx: () => void;
  hoveredFindingId: string | null;
  selectedFindingId: string | null;
}> = ({
  report,
  isEditing,
  onContentChange,
  onSaveChanges,
  onToggleEdit,
  onDownloadPdf,
  onDownloadTxt,
  onDownloadDocx,
  hoveredFindingId,
  selectedFindingId,
}) => {
  const [showComparison, setShowComparison] = useState(true);

  // returns sanitized + injected HTML for display
  const getOriginalHtml = useMemo(() => {
    const raw = report?.documentContent ?? "";
    const escaped = escapeHtml(raw).replace(/\n/g, "<br />");
    // No HTML tags originally, so we can inject snippet ids safely
    return injectSnippetIdsIntoHtml(escaped, report?.findings ?? []);
  }, [report]);

  const getEnhancedHtml = useMemo(() => {
    if (!report?.diffContent) {
      return getOriginalHtml;
    }
    const diff = report.diffContent;
    // If diff contains HTML (ins/del/mark), sanitize and inject snippet ids
    if (/<\w+[^>]*>/.test(diff)) {
      const sanitized = sanitizeHtmlAllowlist(diff);
      return injectSnippetIdsIntoHtml(sanitized, report?.findings ?? []);
    }
    // Otherwise, build html with simple marks
    const html = diff
      .split("\n")
      .map((line) => {
        if (line.startsWith("++ ")) return `<mark class="highlight-added">${escapeHtml(line.substring(3))}</mark>`;
        if (line.startsWith("-- ")) return `<mark class="highlight-removed"><del>${escapeHtml(line.substring(3))}</del></mark>`;
        return escapeHtml(line);
      })
      .join("<br />");
    return injectSnippetIdsIntoHtml(html, report?.findings ?? []);
  }, [report, getOriginalHtml]);

  // When rendering, we want to add a flash/highlight CSS for hovered / selected snippet.
  // We'll render an inline <style> once to ensure the class exists.
  const markFlashStyle = (
    <style key="analysis-screen-styles" dangerouslySetInnerHTML={{
      __html: `
        .mark-flash { animation: markFlash 1.2s ease; }
        @keyframes markFlash {
          0% { box-shadow: 0 0 0 4px rgba(255,215,0,0.15); }
          100% { box-shadow: none; }
        }
        .snippet-target { padding: 0 2px; border-radius: 2px; }
        .snippet-hover { background: rgba(59,130,246,0.08); }
      `
    }} />
  );

  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200 flex flex-col min-h-[60vh]">
      {markFlashStyle}

      {/* Header */}
      <div className="p-4 flex items-start justify-between border-b">
        <div className="pr-4 min-w-0">
          <p className="text-xs text-gray-500">
            {report.workspaceId ? report.workspaceId.replace("-", " ").toUpperCase() : "WORKSPACE"}
          </p>
          <h2 className="font-bold text-lg text-gray-900 truncate">{report.title}</h2>
        </div>

        <div className="flex items-center gap-2">
          {report.diffContent ? (
            <button
              onClick={() => setShowComparison((s) => !s)}
              className="px-3 py-1.5 rounded-lg border text-sm"
              aria-pressed={!showComparison}
            >
              {showComparison ? "Enhanced Only" : "Compare"}
            </button>
          ) : null}

          <DownloadDropdown
            onDownloadPdf={onDownloadPdf}
            onDownloadTxt={onDownloadTxt}
            onDownloadDocx={onDownloadDocx}
          />

          {isEditing ? (
            <button
              onClick={onSaveChanges}
              className="px-4 py-1.5 bg-red-600 text-white rounded-lg font-bold"
              aria-label="Save Draft"
            >
              Save Draft
            </button>
          ) : (
            <button
              onClick={onToggleEdit}
              className="p-2 rounded-lg hover:bg-gray-100"
              title="Edit Document"
              aria-label="Edit Document"
            >
              <EditIcon className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-6 flex-1 overflow-auto">
        {isEditing ? (
          <textarea
            value={report.documentContent}
            onChange={(e) => onContentChange(e.target.value)}
            className="w-full h-[60vh] bg-transparent focus:outline-none resize-none text-base leading-relaxed font-sans"
            aria-label="Edit document content"
            autoFocus
          />
        ) : report.diffContent && showComparison ? (
          <div className="grid md:grid-cols-2 gap-6">
            <div className="prose max-w-none">
              <h3 className="text-sm font-semibold text-gray-500 mb-2">Original</h3>
              <div
                id="original-content"
                className="whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: getOriginalHtml }}
              />
            </div>

            <div className="prose max-w-none">
              <h3 className="text-sm font-semibold text-gray-500 mb-2">Enhanced</h3>
              <div
                id="enhanced-content"
                className="whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: getEnhancedHtml }}
              />
            </div>
          </div>
        ) : (
          <div
            className="prose max-w-none"
            dangerouslySetInnerHTML={{
              __html: report.diffContent ? getEnhancedHtml : getOriginalHtml,
            }}
          />
        )}
      </div>
    </div>
  );
};

/* ----------------------------- Score Card --------------------------- */
const ScoreCard: React.FC<{ label: string; score: number }> = ({ label, score }) => {
  const getScoreColor = (s: number) => {
    if (s >= 90) return "text-green-600";
    if (s >= 70) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="bg-gray-50 p-3 rounded-lg border">
      <p className="text-xs text-gray-500 truncate">{label}</p>
      <p className={`text-2xl font-bold ${getScoreColor(score)}`}>{score}<span className="text-sm font-normal">%</span></p>
    </div>
  );
};

/* ---------------------- Actionable Findings (collapsible) ---------------------- */
const ActionableFindings: React.FC<{
  findings: Finding[];
  onDismiss: (f: Finding) => void;
  onResolve: (id: string) => void;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}> = ({ findings, onDismiss, onResolve, onHover, onClick }) => {
  const [openId, setOpenId] = useState<string | null>(null);

  const toggle = (id: string) => {
    setOpenId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="space-y-3">
      {findings.map((f) => {
        const isOpen = openId === f.id;
        const isCritical = f.severity === "critical";
        const borderClass = isCritical ? "border-red-400" : "border-yellow-300";

        return (
          <div
            key={f.id}
            onMouseEnter={() => onHover(f.id)}
            onMouseLeave={() => onHover(null)}
            className={`bg-white rounded-lg border ${borderClass} shadow-sm overflow-hidden`}
          >
            <button
              onClick={() => {
                toggle(f.id);
                onClick(f.id);
              }}
              className="w-full px-4 py-3 flex justify-between items-center text-left font-semibold hover:bg-gray-50"
              aria-expanded={isOpen}
            >
              <span className="truncate">{f.title}</span>
              <span className="ml-4">{isOpen ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}</span>
            </button>

            <div
              className={`transition-all duration-300 overflow-hidden ${isOpen ? "max-h-[800px]" : "max-h-0"}`}
              aria-hidden={!isOpen}
            >
              <div className="p-4 bg-gray-50 text-sm text-gray-700">
                <p className="mb-2"><strong>Issue:</strong> {f.title}</p>
                {f.regulation && <p className="text-xs text-gray-600 mb-2"><strong>Regulation:</strong> {f.regulation}</p>}
                <p className="mb-2"><strong>Details:</strong> {f.description || f.sourceSnippet}</p>
                {f.recommendation && <p className="mt-2"><strong>Suggested Fix:</strong> {f.recommendation}</p>}

                <div className="mt-3 flex justify-end gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDismiss(f);
                    }}
                    className="px-2 py-1 text-xs bg-gray-200 rounded hover:bg-gray-300"
                  >
                    <XCircleIcon className="inline w-4 h-4 mr-1" /> Dismiss
                  </button>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onResolve(f.id);
                    }}
                    className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
                  >
                    <CheckCircleIcon className="inline w-4 h-4 mr-1" /> Resolve
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* --------------------------- Chat Panel ---------------------------- */
const ChatPanel: React.FC<{ documentContent: string }> = ({ documentContent }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    const currentInput = input;
    const userMessage: ChatMessage = { role: "user", content: currentInput };

    // Append user message locally immediately
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      // Pass the history including this user message to the API
      const historyForApi = [...messages, userMessage];
      const response = await vestaApi.getChatResponse(documentContent, historyForApi, currentInput);
      setMessages((prev) => [...prev, { role: "model", content: response }]);
    } catch (error) {
      console.error("Chat API error:", error);
      setMessages((prev) => [...prev, { role: "model", content: "I'm sorry, I couldn't get a response. Try again later." }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border shadow p-0 flex flex-col h-full">
      <div className="p-4 border-b flex items-center gap-2">
        <MessageSquareIcon className="w-5 h-5 text-red-700" />
        <h3 className="font-bold">Ask Gemini</h3>
      </div>

      <div className="p-4 flex-1 overflow-auto space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`${m.role === "user" ? "bg-red-700 text-white" : "bg-gray-100 text-gray-800"} px-4 py-2 rounded-2xl max-w-xs`}>
              <p className="text-sm">{m.content}</p>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex">
            <div className="bg-gray-100 px-4 py-2 rounded-2xl max-w-xs">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSend} className="p-4 border-t">
        <div className="relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Summarize risk factors..."
            className="w-full pl-4 pr-12 py-2 border rounded-full focus:outline-none bg-gray-50"
            aria-label="Chat input"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-red-700 text-white p-2 rounded-full disabled:opacity-50"
            aria-label="Send message"
          >
            <SendIcon className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
};

/* -------------------------- Main AnalysisScreen -------------------------- */

interface AnalysisScreenProps extends ScreenLayoutProps {
  activeReport: AnalysisReport | null;
  onUpdateReport: (report: AnalysisReport) => void;
  onAutoEnhance?: (report?: AnalysisReport) => Promise<void> | void;
  enhancedDraft?: string;
  enhancedDraftHtml?: string;
  onAcceptEnhanced?: (reportId: string) => Promise<void> | void;
  onRejectEnhanced?: (reportId: string) => void;
  isEnhancing: boolean;
  analysisStatusText: string;
  onBack?: () => void;
}

const AnalysisScreen: React.FC<AnalysisScreenProps> = ({
  activeReport,
  onUpdateReport,
  onAutoEnhance,
  enhancedDraft,
  enhancedDraftHtml,
  onAcceptEnhanced,
  onRejectEnhanced,
  isEnhancing,
  analysisStatusText,
  currentWorkspace,
  navigateTo,
  onBack,
}) => {
  // Local editable copy of the active report. Keep it synced when activeReport changes.
  const [currentReport, setCurrentReport] = useState<AnalysisReport | null>(activeReport);
  const [isEditing, setIsEditing] = useState(false);
  const [feedbackFinding, setFeedbackFinding] = useState<Finding | null>(null);
  const [hoveredFindingId, setHoveredFindingId] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);

  // Sync activeReport -> currentReport whenever activeReport changes.
  useEffect(() => {
    setCurrentReport(activeReport);
  }, [activeReport]);

  // Back handler fallback
  const handleBack = () => {
    if (onBack) return onBack();
    if (navigateTo) return navigateTo(Screen.Dashboard);
    // fallback no-op
  };

  // Auto-Enhance click
  const handleAutoEnhance = async () => {
    if (!currentReport || isEnhancing) return;
    try {
      await onAutoEnhance?.(currentReport);
    } catch (err) {
      console.error("Auto enhance failed:", err);
    }
  };

  // Update finding status locally and inform parent
  const handleFindingStatusChange = (findingId: string, status: FindingStatus) => {
    if (!currentReport) return;
    const updated = {
      ...currentReport,
      findings: currentReport.findings.map((f) => (f.id === findingId ? { ...f, status } : f)),
    };
    setCurrentReport(updated);
    try {
      onUpdateReport(updated);
    } catch (err) {
      console.warn("onUpdateReport failed:", err);
    }
  };

  // Dismiss (open feedback modal flow)
  const handleDismissSubmit = async (reason: FeedbackReason) => {
    if (!feedbackFinding || !currentReport || !currentWorkspace) return;
    try {
      await workspaceApi.addDismissalRule(currentWorkspace.id, {
        findingTitle: feedbackFinding.title,
        reason,
      });
      handleFindingStatusChange(feedbackFinding.id, "dismissed");
      setFeedbackFinding(null);
    } catch (err) {
      console.error("Failed to add dismissal rule:", err);
    }
  };

  // Finding click -> scroll to snippet in document
  const handleFindingClick = (findingId: string) => {
    setSelectedFindingId(findingId);
    const el = document.getElementById(`snippet-${findingId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("mark-flash");
      setTimeout(() => el.classList.remove("mark-flash"), 1200);
    }
  };

  // Downloads: use enhanced content when available, otherwise original
  const getContentForDownload = (report: AnalysisReport) => {
    if (!report) return "";
    if (report.diffContent && report.diffContent.length > 0) {
      return diffToPlainText(report.diffContent);
    }
    return report.documentContent ?? "";
  };

  const handleDownloadPdf = () => {
    if (!currentReport) return;
    try {
      const doc = new jsPDF();
      const title = (currentReport.title || "document").replace(/\.[^/.]+$/, "");
      const content = getContentForDownload(currentReport);

      doc.setProperties({ title });
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text(title, 15, 20);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);

      const pageHeight = doc.internal.pageSize.height || 297;
      const margin = 15;
      let y = 30;
      const lines = doc.splitTextToSize(content, doc.internal.pageSize.width - margin * 2);
      lines.forEach((line) => {
        if (y + 10 > pageHeight - margin) {
          doc.addPage();
          y = margin;
        }
        doc.text(line, margin, y);
        y += 7;
      });

      doc.save(`${title}.pdf`);
    } catch (err) {
      console.error("PDF download failed:", err);
    }
  };

  const handleDownloadTxt = () => {
    if (!currentReport) return;
    try {
      const title = (currentReport.title || "document").replace(/\.[^/.]+$/, "");
      const content = getContentForDownload(currentReport);
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${title}.txt`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("TXT download failed:", err);
    }
  };

  const handleDownloadDocx = () => {
    if (!currentReport) return;
    try {
      const title = (currentReport.title || "document").replace(/\.[^/.]+$/, "");
      const content = getContentForDownload(currentReport);
      const doc = new DocxDocument({
        sections: [
          {
            children: content.split("\n").map((line) =>
              new Paragraph({
                children: [new TextRun(line)],
              })
            ),
          },
        ],
      });

      Packer.toBlob(doc).then((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${title}.docx`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      });
    } catch (err) {
      console.error("DOCX generation failed:", err);
    }
  };

  // Save changes made in editor back to parent
  const handleSaveChanges = () => {
    setIsEditing(false);
    if (!currentReport) return;
    try {
      onUpdateReport(currentReport);
    } catch (err) {
      console.error("onUpdateReport failed:", err);
    }
  };

  if (!currentReport) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <BackButton onBack={handleBack} />
        <p className="text-gray-500 mt-4">No active report. Please select an analysis from the dashboard.</p>
      </div>
    );
  }

  // activeFindings: only 'active' status ones for the actionable panel
  const activeFindings = currentReport.findings?.filter((f) => f.status === "active") ?? [];

  return (
    <div className="relative h-full bg-gray-50 min-h-screen">
      {/* Back button (top-left) */}
      <div className="absolute top-4 left-4 z-20">
        <BackButton onBack={handleBack} />
      </div>

      {/* Overlay loader when enhancing/analyzing */}
      {isEnhancing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-white/80 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 shadow border">
            <div className="animate-spin rounded-full h-10 w-10 border-b-4 border-red-700 mb-3" />
            <p className="font-medium text-gray-700">Analyzing document…</p>
            {analysisStatusText && <p className="text-sm text-gray-500 mt-2">{analysisStatusText}</p>}
          </div>
        </div>
      )}

      {/* Top header bar: workspace left, metrics center, auto-enhance right */}
      <header className="w-full bg-white border-b shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          {/* Left: Workspace & Project info */}
          <div>
            <p className="text-xs text-gray-500">
              {currentReport.workspaceId ? currentReport.workspaceId.replace("-", " ").toUpperCase() : "WORKSPACE"}
            </p>
            <h1 className="text-xl font-bold text-gray-900">{currentReport.title}</h1>
          </div>

          {/* Center: Metrics row */}
          <div className="flex gap-8 items-center">
            <div className="flex gap-4">
              <div className="text-center">
                <p className="text-sm text-gray-600">Project Score</p>
                <p className="font-bold text-green-600">100%</p>
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-600">Strategic Goals</p>
                <p className="font-bold text-green-600">100%</p>
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-600">Regulations</p>
                <p className="font-bold text-green-600">100%</p>
              </div>
              <div className="text-center">
                <p className="text-sm text-gray-600">Risk Mitigation</p>
                <p className="font-bold text-green-600">100%</p>
              </div>
            </div>
          </div>

          {/* Right: Auto-Enhance */}
          <div>
            <button
              onClick={handleAutoEnhance}
              disabled={isEnhancing}
              className="px-5 py-2 rounded-lg bg-red-600 text-white font-bold shadow hover:bg-red-700 disabled:opacity-60"
              aria-label="Auto Enhance"
            >
              Auto-Enhance
            </button>
          </div>
        </div>
      </header>

      {/* Main grid: document centered (two-column layout) */}
      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Document area (span 2) */}
        <section className="xl:col-span-2">
          <DocumentEditor
            report={currentReport}
            isEditing={isEditing}
            onContentChange={(content) => setCurrentReport({ ...currentReport, documentContent: content })}
            onSaveChanges={handleSaveChanges}
            onToggleEdit={() => setIsEditing((s) => !s)}
            onDownloadPdf={handleDownloadPdf}
            onDownloadTxt={handleDownloadTxt}
            onDownloadDocx={handleDownloadDocx}
            hoveredFindingId={hoveredFindingId}
            selectedFindingId={selectedFindingId}
          />
        </section>

        {/* Right column: actionable findings + analysis/scores + chat */}
        <aside className="xl:col-span-1 space-y-6">
          {/* Top: Analysis controls and scores */}
          <div className="bg-white rounded-xl shadow p-4 border">
            <div className="flex items-center justify-between">
              <h3 className="font-bold">Analysis Panel</h3>
            </div>

            <div className="mt-4">
              <EnhanceControls activeReport={currentReport} onAutoEnhance={onAutoEnhance} isEnhancing={isEnhancing} isAnalyzing={!!analysisStatusText} />
            </div>

            <div className="mt-6">
              <h4 className="text-sm font-semibold text-gray-500 mb-3">Compliance Scores</h4>
              {currentReport.scores ? (
                <div className="grid grid-cols-2 gap-3">
                  <ScoreCard label="Project Score" score={currentReport.scores.project} />
                  <ScoreCard label="Strategic Goals" score={currentReport.scores.strategicGoals} />
                  <ScoreCard label="Regulations" score={currentReport.scores.regulations} />
                  <ScoreCard label="Risk Mitigation" score={currentReport.scores.risk} />
                </div>
              ) : (
                <div className="bg-gray-50 p-3 rounded text-center">
                  <p className="text-2xl font-bold text-red-700">{currentReport.resilienceScore ?? 0}%</p>
                  <p className="text-sm text-gray-600">Overall Score</p>
                </div>
              )}
            </div>
          </div>

          {/* Actionable Findings box */}
          <div className="bg-white rounded-xl shadow p-4 border">
            <h4 className="font-bold">Actionable Findings ({activeFindings.length})</h4>
            <div className="mt-3">
              {activeFindings.length > 0 ? (
                <ActionableFindings
                  findings={activeFindings}
                  onDismiss={(f) => setFeedbackFinding(f)}
                  onResolve={(id) => handleFindingStatusChange(id, "resolved")}
                  onHover={(id) => setHoveredFindingId(id)}
                  onClick={handleFindingClick}
                />
              ) : (
                <div className="text-center p-6">
                  <CheckCircleIcon className="w-12 h-12 mx-auto text-green-500" />
                  <p className="font-semibold mt-3">Excellent! No Active Findings</p>
                  <p className="text-sm text-gray-500">This document meets all compliance checks.</p>
                </div>
              )}
            </div>
          </div>

          {/* Chat panel */}
          <div className="h-[420px]">
            <ChatPanel documentContent={currentReport.documentContent ?? ""} />
          </div>
        </aside>
      </main>

      {/* Feedback Modal for dismiss flow */}
      {feedbackFinding && (
        <FeedbackModal finding={feedbackFinding} onClose={() => setFeedbackFinding(null)} onSubmit={handleDismissSubmit} />
      )}
    </div>
  );
};

export default AnalysisScreen;
