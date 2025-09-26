// src/screens/AnalysisScreen.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";
import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
} from "docx";

import {
  AnalysisReport,
  Finding,
  ScreenLayoutProps,
  FindingStatus,
  FeedbackReason,
  ChatMessage,
  Screen,
} from "../types";

import * as workspaceApi from "../api/workspace";
import * as vestaApi from "../api/vesta";
import FeedbackModal from "../components/FeedbackModal";
import { AnimatedChecklist } from "../components/AnimatedChecklist";

import {
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
  PlusIcon,
  BriefcaseIcon,
  MoreVerticalIcon,
} from "../components/Icons";

/* --------------------------------------------------------------------------
  Full AnalysisScreen.tsx
  - Centered, justified viewing + editing
  - Spacing between sections
  - Auto-bold project-plan keywords
  - PDF / DOCX / TXT exports to match view
-----------------------------------------------------------------------------*/

/* -------------------- Utilities & Sanitizer -------------------- */

const escapeHtml = (unsafe: string) =>
  unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sanitizeHtmlAllowlist(html: string) {
  let sanitized = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  sanitized = sanitized.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "");

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
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
  ];

  sanitized = sanitized.replace(/<\/?([a-zA-Z0-9-]+)(\s[^>]*)?>/g, (match, tag, attrs) => {
    if (!allowed.includes(tag.toLowerCase())) return "";
    if (!attrs) return `<${tag}>`;
    const classMatch = attrs.match(/class\s*=\s*"(.*?)"/i);
    if (classMatch) return `<${tag} class="${classMatch[1]}">`;
    return `<${tag}>`;
  });

  return sanitized;
}

// inject snippet ids for finding.sourceSnippet into HTML
function injectSnippetIdsIntoHtml(html: string, findings: Finding[] = []) {
  let out = html;
  for (const f of findings) {
    if (!f || !f.sourceSnippet) continue;
    const snippet = f.sourceSnippet.trim();
    if (!snippet) continue;
    try {
      const escapedSnippet = escapeHtml(snippet);
      const re = new RegExp(escapeRegExp(escapedSnippet), "i");
      if (re.test(out)) {
        out = out.replace(re, `<span id="snippet-${f.id}" class="snippet-target">${escapedSnippet}</span>`);
      } else {
        const rePlain = new RegExp(escapeRegExp(snippet), "i");
        if (rePlain.test(out)) {
          out = out.replace(rePlain, `<span id="snippet-${f.id}" class="snippet-target">${snippet}</span>`);
        }
      }
    } catch (err) {
      console.warn("injectSnippetIdsIntoHtml error:", f.id, err);
    }
  }
  return out;
}

/* -------------------- text -> neat HTML converter -------------------- */
/* Adds mb-4 spacing, headings bolded, lists indented, auto-bold keywords */

function textToNeatHtml(input: string): string {
  if (!input) return "";

  // normalize line breaks and trim
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // split paragraphs / segments: use double-newline OR single newline where sentence boundary
  const segments = normalized
    .split(/(?<=\.)\s+(?=[A-Z])|[\n]{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  let listMode: null | "ul" | "ol" = null;
  let listItems: string[] = [];

  const flushList = () => {
    if (!listMode || listItems.length === 0) return;
    const items = listItems.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    const cls = listMode === "ul" ? "list-disc" : "list-decimal";
    out.push(`<${listMode} class="mb-4 pl-6 ${cls}">${items}</${listMode}>`);
    listMode = null;
    listItems = [];
  };

  const isHeading = (s: string) =>
    /^(executive summary|summary|introduction|scope|background|conclusion|findings|analysis|recommendations|budget|project timeline|timeline|methodology|objectives|deliverables)[:]?$/i.test(
      s
    ) || (/^[A-Z0-9\s\-\&]{3,}$/.test(s) && s.length < 80);

  const isBullet = (s: string) => /^[-•\u2022\*]\s+/.test(s);
  const isOrdered = (s: string) =>
    /^\(?\d+\)\s+|^\d+[.)]\s+/.test(s) || /^(phase|step)\s+\d+/i.test(s);

  const isFieldLabel = (s: string) => /^[A-Z][\w\s()\-&,]{0,80}:\s+.+/.test(s);

  // try splitting inline label sequences like "Budget: ... Total: ..."
  const trySplitInlineLabels = (str: string) => {
    const parts = str.split(/(?<=\w:\s[^:]+)\s(?=[A-Z][\w\s()\-]{1,20}:)/g);
    if (parts.length > 1) return parts.map((p) => p.trim()).filter(Boolean);
    return [str];
  };

  for (const segRaw of segments) {
    const subs = trySplitInlineLabels(segRaw);
    for (const seg of subs) {
      if (!seg) continue;

      if (isHeading(seg)) {
        flushList();
        out.push(`<h3 class="mb-4 font-bold">${escapeHtml(seg.replace(/:$/, ""))}</h3>`);
        continue;
      }

      if (isBullet(seg)) {
        if (listMode !== "ul") {
          flushList();
          listMode = "ul";
        }
        listItems.push(seg.replace(/^[-•\u2022\*]\s+/, "").trim());
        continue;
      }

      if (isOrdered(seg)) {
        if (listMode !== "ol") {
          flushList();
          listMode = "ol";
        }
        listItems.push(
          seg
            .replace(/^\(?\d+\)\s+/, "")
            .replace(/^\d+[.)]\s+/, "")
            .replace(/^\(?[a-zA-Z]\)\s+/, "")
            .replace(/^(phase|step)\s+\d+:?\s*/i, "")
            .trim()
        );
        continue;
      }

      if (isFieldLabel(seg)) {
        flushList();
        const [label, ...rest] = seg.split(":");
        out.push(`<p class="mb-4"><strong>${escapeHtml(label.trim())}:</strong> ${escapeHtml(rest.join(":").trim())}</p>`);
        continue;
      }

      flushList();
      out.push(`<p class="mb-4">${escapeHtml(seg)}</p>`);
    }
  }

  flushList();

  // auto-bold project plan keywords
  const emphasizeKeywords = [
    "Project Overview",
    "Executive Summary",
    "Objectives",
    "Methodology",
    "Scope",
    "Deliverables",
    "Budget",
    "Project Timeline",
    "Timeline",
    "Conclusion",
    "Risk Assessment",
    "User Onboarding",
  ];

  let finalHtml = out.join("\n");

  for (const kw of emphasizeKeywords) {
    const re = new RegExp(`(${kw})(:)?`, "gi");
    finalHtml = finalHtml.replace(re, "<strong>$1</strong>$2");
  }

  return finalHtml;
}

/* -------------------- diff -> plain text (for downloads) -------------------- */

function diffToPlainText(diff?: string | null): string {
  if (!diff) return "";
  if (/<\w+[^>]*>/.test(diff)) return diff.replace(/<[^>]+>/g, "");
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("++ ")) return line.substring(3);
      if (line.startsWith("-- ")) return "";
      return line;
    })
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/* -------------------- PDF justification + basic formatting -------------------- */

/**
 * Best-effort: handle headings (centered bold), bullets (indent), lists, and justify normal paragraphs.
 * Larger font and wider margins provided by caller via opts.
 */
function addJustifiedTextToPdf(
  doc: jsPDF,
  content: string,
  opts?: {
    marginMm?: number;
    fontName?: string;
    fontStyle?: string;
    fontSizePt?: number;
    startY?: number;
    paragraphSpacingMm?: number;
    lineHeightMultiplier?: number;
  }
) {
  const margin = opts?.marginMm ?? 25; // mm
  const fontName = opts?.fontName ?? "helvetica";
  const fontStyle = (opts?.fontStyle as any) ?? "normal";
  const fontSize = opts?.fontSizePt ?? 12; // points
  const paragraphSpacing = opts?.paragraphSpacingMm ?? 3; // mm
  const lineHeightMultiplier = opts?.lineHeightMultiplier ?? 1.4;
  let y = opts?.startY ?? 30;

  // set font
  doc.setFont(fontName, fontStyle);
  doc.setFontSize(fontSize);

  const pageWidth =
    typeof doc.internal.pageSize.getWidth === "function"
      ? doc.internal.pageSize.getWidth()
      : (doc.internal.pageSize as any).width;
  const pageHeight =
    typeof doc.internal.pageSize.getHeight === "function"
      ? doc.internal.pageSize.getHeight()
      : (doc.internal.pageSize as any).height;

  const usableWidth = pageWidth - margin * 2;
  const lineHeight = (fontSize / 72) * 25.4 * lineHeightMultiplier; // convert pt -> mm and multiply

  // split into paragraphs by double newlines
  const paragraphs = content
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // heading detection set
  const headingRe = new RegExp(
    "^(executive summary|summary|project overview|objectives|methodology|scope|deliverables|budget|project timeline|timeline|conclusion|risk assessment|user onboarding)",
    "i"
  );

  for (const para of paragraphs) {
    // if heading-like single-line (short), render centered bold and larger
    if (headingRe.test(para) && para.length < 120) {
      // center heading
      const saveFontSize = doc.getFontSize();
      doc.setFontSize(saveFontSize + 2);
      doc.setFont(fontName, "bold");
      if (y + lineHeight > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(para.replace(/:$/, ""), pageWidth / 2, y, { align: "center" });
      y += lineHeight + paragraphSpacing;
      doc.setFontSize(saveFontSize);
      doc.setFont(fontName, fontStyle);
      continue;
    }

    // handle lists: if para starts with '-' or digit patterns, treat as list block
    if (/^[-•\u2022*]\s+/.test(para) || /^\d+[.)]\s+/.test(para) || /^(phase|step)\s+\d+/i.test(para)) {
      // split into lines for this block
      const items = para.split(/(?:\s*[-•\u2022*]\s+)|(?:\s*\d+[.)]\s+)/).map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        if (y + lineHeight > pageHeight - margin) {
          doc.addPage();
          y = margin;
        }
        // render bullet with indent
        const bulletX = margin + 4;
        const textX = margin + 8;
        doc.text("•", bulletX, y);
        // wrap item text within usableWidth - indent
        const lines = doc.splitTextToSize(item, usableWidth - 8);
        for (let i = 0; i < lines.length; i++) {
          const lx = i === 0 ? textX : textX;
          doc.text(lines[i], lx, y);
          y += lineHeight;
          if (y + lineHeight > pageHeight - margin) {
            doc.addPage();
            y = margin;
          }
        }
        y += paragraphSpacing;
      }
      y += paragraphSpacing;
      continue;
    }

    // normal paragraph -> justify
    const words = para.split(" ").filter(Boolean);
    if (words.length === 0) {
      y += paragraphSpacing;
      continue;
    }

    // Greedy line builder using doc.getTextWidth (units mm)
    const spaceW = doc.getTextWidth(" ");
    let currentWords: string[] = [];
    let currentWidth = 0;

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const wW = doc.getTextWidth(w);
      if (currentWords.length === 0) {
        currentWords.push(w);
        currentWidth = wW;
      } else {
        if (currentWidth + spaceW + wW <= usableWidth) {
          currentWords.push(w);
          currentWidth += spaceW + wW;
        } else {
          // render current line (justify except last line)
          if (y + lineHeight > pageHeight - margin) {
            doc.addPage();
            y = margin;
          }
          if (currentWords.length === 1) {
            doc.text(currentWords[0], margin, y);
          } else {
            const totalWordsWidth = currentWords.reduce((acc, wd) => acc + doc.getTextWidth(wd), 0);
            const gaps = currentWords.length - 1;
            const extraPerGap = (usableWidth - totalWordsWidth) / gaps;
            let x = margin;
            for (const wd of currentWords) {
              doc.text(wd, x, y);
              x += doc.getTextWidth(wd) + extraPerGap;
            }
          }
          y += lineHeight;
          currentWords = [w];
          currentWidth = wW;
        }
      }
    }

    // last line - left aligned
    if (currentWords.length > 0) {
      if (y + lineHeight > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(currentWords.join(" "), margin, y);
      y += lineHeight;
    }

    y += paragraphSpacing;
  }
}

/* -------------------------- TXT wrapping -------------------------- */

function wrapTextToWidth(text: string, maxChars = 80) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim());
  const out: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/);
    let line = "";
    for (const w of words) {
      if ((line + " " + w).trim().length <= maxChars) {
        line = (line + " " + w).trim();
      } else {
        if (line) out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
    out.push("");
  }
  if (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/* ----------------------------- Small UI Bits ----------------------------- */

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

/* ------------------------- Download Dropdown -------------------------- */

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
            onClick={() => { onDownloadPdf(); setIsOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50"
          >
            Download as PDF
          </button>
          <button
            onClick={() => { onDownloadDocx(); setIsOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50"
          >
            Download as DOCX
          </button>
          <button
            onClick={() => { onDownloadTxt(); setIsOpen(false); }}
            className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50"
          >
            Download as TXT
          </button>
        </div>
      )}
    </div>
  );
};

/* ------------------------- Document Editor Component ------------------------- */

const DocumentEditor: React.FC<{
  report: AnalysisReport;
  isEditing: boolean;
  onContentChange: (content: string) => void;
  onTitleChange: (title: string) => void;
  onSaveChanges: () => void;
  onToggleEdit: () => void;
  onDownloadPdf: () => void;
  onDownloadTxt: () => void;
  onDownloadDocx: () => void;
  hoveredFindingId: string | null;
  selectedFindingId: string | null;
  onBack: () => void;
}> = ({
  report,
  isEditing,
  onContentChange,
  onTitleChange,
  onSaveChanges,
  onToggleEdit,
  onDownloadPdf,
  onDownloadTxt,
  onDownloadDocx,
  hoveredFindingId,
  selectedFindingId,
  onBack,
}) => {
  const [showComparison, setShowComparison] = useState(true);

  const getOriginalHtml = useMemo(() => {
    const raw = report?.documentContent ?? "";
    const neat = textToNeatHtml(raw);
    return injectSnippetIdsIntoHtml(neat, report?.findings ?? []);
  }, [report]);

  const getEnhancedHtml = useMemo(() => {
    if (!report?.diffContent) return getOriginalHtml;
    const diff = report.diffContent;
    if (/<\w+[^>]*>/.test(diff)) {
      const sanitized = sanitizeHtmlAllowlist(diff);
      return injectSnippetIdsIntoHtml(sanitized, report?.findings ?? []);
    }
    const html = diff
      .split("\n\n")
      .map((para) => {
        const lines = para.split("\n").map((line) => {
          if (line.startsWith("++ ")) return `<mark class="highlight-added">${escapeHtml(line.substring(3))}</mark>`;
          if (line.startsWith("-- ")) return `<mark class="highlight-removed"><del>${escapeHtml(line.substring(3))}</del></mark>`;
          return escapeHtml(line);
        });
        return `<p class="mb-4">${lines.join("<br/>")}</p>`;
      })
      .join("");
    return injectSnippetIdsIntoHtml(html, report?.findings ?? []);
  }, [report, getOriginalHtml]);

  const markFlashStyle = (
    <style key="analysis-screen-styles" dangerouslySetInnerHTML={{
      __html: `
        .mark-flash { animation: markFlash 1.2s ease; }
        @keyframes markFlash {
          0% { box-shadow: 0 0 0 8px rgba(255,215,0,0.12); }
          100% { box-shadow: none; }
        }
        .snippet-target { padding: 0 2px; border-radius: 2px; }
        .highlight-added { background: #ecfee8; color: #0b6312; padding: 0 2px; border-radius: 2px; }
        .highlight-removed { background: #ffecec; color: #8a1111; padding: 0 2px; border-radius: 2px; text-decoration: line-through; }
      `
    }} />
  );

  return (
    <div className="bg-white rounded-xl shadow-lg border border-gray-200 flex flex-col h-full">
      {markFlashStyle}

      {/* Title & controls */}
      <div className="p-3 flex items-center justify-between border-b bg-gray-50">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <button
            onClick={onBack}
            className="flex items-center space-x-1 px-2 py-1 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition flex-shrink-0"
            title="Back to Dashboard"
            aria-label="Back"
          >
            <ArrowLeftIcon className="w-4 h-4" />
            <span className="text-sm font-medium">Back</span>
          </button>

          <div className="w-px h-6 bg-gray-300" />

          <input
            type="text"
            value={report.title ?? ""}
            onChange={(e) => onTitleChange && onTitleChange(e.target.value)}
            className="text-lg font-bold text-gray-900 bg-transparent border-none focus:outline-none flex-1 min-w-0"
            placeholder="Document Title"
            aria-label="Edit document title"
          />
        </div>

        <div className="flex items-center gap-2 ml-4">
          {report.diffContent ? (
            <button
              onClick={() => setShowComparison((s) => !s)}
              className="px-3 py-1.5 rounded-lg border text-sm bg-white hover:bg-gray-50"
              aria-pressed={!showComparison}
            >
              {showComparison ? "Enhanced Only" : "Compare"}
            </button>
          ) : null}

          <DownloadDropdown onDownloadPdf={onDownloadPdf} onDownloadTxt={onDownloadTxt} onDownloadDocx={onDownloadDocx} />

          {isEditing ? (
            <button onClick={onSaveChanges} className="px-4 py-1.5 bg-red-600 text-white rounded-lg font-bold" aria-label="Save Draft">
              Save Draft
            </button>
          ) : (
            <button onClick={onToggleEdit} className="p-2 rounded-lg hover:bg-gray-100" title="Edit Document" aria-label="Edit Document">
              <EditIcon className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4 flex-1 overflow-auto">
        {isEditing ? (
          <div className="flex justify-center">
            <textarea
              value={report.documentContent}
              onChange={(e) => onContentChange && onContentChange(e.target.value)}
              className="w-full max-w-3xl mx-auto text-justify leading-relaxed bg-transparent focus:outline-none resize-none text-base font-sans px-6 py-6"
              aria-label="Edit document content"
              autoFocus
            />
          </div>
        ) : report.diffContent && showComparison ? (
          <div className="grid md:grid-cols-2 gap-6 h-full">
            <div>
              <h3 className="text-sm font-semibold text-gray-500 mb-2">Original</h3>
              <div className="flex justify-center">
                <div
                  className="prose max-w-3xl mx-auto text-justify leading-relaxed px-6"
                  dangerouslySetInnerHTML={{ __html: getOriginalHtml }}
                />
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-500 mb-2">Enhanced</h3>
              <div className="flex justify-center">
                <div
                  className="prose max-w-3xl mx-auto text-justify leading-relaxed px-6"
                  dangerouslySetInnerHTML={{ __html: getEnhancedHtml }}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex justify-center">
            <div
              className="prose max-w-3xl mx-auto text-justify leading-relaxed px-6"
              dangerouslySetInnerHTML={{ __html: report.diffContent ? getEnhancedHtml : getOriginalHtml }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------- Actionable Findings ------------------------ */

const ActionableFindings: React.FC<{
  findings: Finding[];
  onDismiss: (f: Finding) => void;
  onResolve: (id: string) => void;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}> = ({ findings, onDismiss, onResolve, onHover, onClick }) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = (id: string) => setOpenId((prev) => (prev === id ? null : id));

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

            <div className={`transition-all duration-300 overflow-hidden ${isOpen ? "max-h-[800px]" : "max-h-0"}`} aria-hidden={!isOpen}>
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

/* ----------------------------- Chat Panel ---------------------------- */

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

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
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

/* --------------------------- Main AnalysisScreen --------------------------- */

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
  const [currentReport, setCurrentReport] = useState<AnalysisReport | null>(activeReport);
  const [isEditing, setIsEditing] = useState(false);
  const [feedbackFinding, setFeedbackFinding] = useState<Finding | null>(null);
  const [hoveredFindingId, setHoveredFindingId] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);

  useEffect(() => {
    setCurrentReport(activeReport);
  }, [activeReport]);

  const handleBack = () => {
    if (onBack) return onBack();
    if (navigateTo) return navigateTo(Screen.Dashboard);
  };

  const handleAutoEnhance = async () => {
    if (!currentReport || isEnhancing) return;
    try {
      // Call autoEnhanceReport directly from vesta.ts
      const enhanced = await vestaApi.autoEnhanceReport(currentReport);
  
      // Update local state and bubble up to parent
      setCurrentReport(enhanced);
      try {
        onUpdateReport(enhanced);
      } catch (err) {
        console.warn("onUpdateReport failed after auto-enhance:", err);
      }
    } catch (err) {
      console.error("Auto enhance failed:", err);
      alert("Enhancement failed: " + String(err));
    }
  };
  

  const handleFindingStatusChange = (findingId: string, status: FindingStatus) => {
    if (!currentReport) return;
    const updated = { ...currentReport, findings: currentReport.findings.map((f) => (f.id === findingId ? { ...f, status } : f)) };
    setCurrentReport(updated);
    try {
      onUpdateReport(updated);
    } catch (err) {
      console.warn("onUpdateReport failed:", err);
    }
  };

  const handleDismissSubmit = async (reason: FeedbackReason) => {
    if (!feedbackFinding || !currentReport || !currentWorkspace) return;
    try {
      await workspaceApi.addDismissalRule(currentWorkspace.id, { findingTitle: feedbackFinding.title, reason });
      handleFindingStatusChange(feedbackFinding.id, "dismissed");
      setFeedbackFinding(null);
    } catch (err) {
      console.error("Failed to add dismissal rule:", err);
    }
  };

  const handleFindingClick = (findingId: string) => {
    setSelectedFindingId(findingId);
    const el = document.getElementById(`snippet-${findingId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("mark-flash");
      setTimeout(() => el.classList.remove("mark-flash"), 1200);
    }
  };

  const getContentForDownload = (report: AnalysisReport) => {
    if (!report) return "";
    if (report.diffContent && report.diffContent.length > 0) return diffToPlainText(report.diffContent);
    return report.documentContent ?? "";
  };

  /* ------------------------ Export: PDF / TXT / DOCX ------------------------ */

  const handleDownloadPdf = () => {
    if (!currentReport) return;
    try {
      const title = (currentReport.title || "document").replace(/\.[^/.]+$/, "");
      const content = getContentForDownload(currentReport) || "";

      const doc = new jsPDF({
        unit: "mm",
        format: "a4",
      });

      // Title: centered, bold
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      const pageWidth = typeof doc.internal.pageSize.getWidth === "function"
        ? doc.internal.pageSize.getWidth()
        : (doc.internal.pageSize as any).width;
      doc.text(title, pageWidth / 2, 24, { align: "center" });

      // Body: larger font, wider margins, better line height
      addJustifiedTextToPdf(doc, content, {
        marginMm: 20,
        fontName: "helvetica",
        fontStyle: "normal",
        fontSizePt: 12,
        startY: 34,
        paragraphSpacingMm: 4,
        lineHeightMultiplier: 1.4,
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
      const content = getContentForDownload(currentReport) || "";
      const wrapped = wrapTextToWidth(content, 80);
      const blob = new Blob([wrapped], { type: "text/plain;charset=utf-8" });
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
      const content = getContentForDownload(currentReport) || "";

      const paragraphs = content
        .split(/\n{2,}/)
        .map((p) => p.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map(
          (p) =>
            new Paragraph({
              children: [new TextRun({ text: p, size: 24 })], // 24 half-points = 12pt
              alignment: AlignmentType.JUSTIFIED,
              spacing: { after: 160 }, // spacing after
            })
        );

        const doc = new DocxDocument({
          sections: [
            {
              properties: {
                page: {
                  margin: {
                    top: 1500,     // ~0.8"
                    right: 1500,
                    bottom: 1500,
                    left: 1500,
                  },
                },
              },
              children: content.split("\n").map((line) =>
                new Paragraph({
                  children: [new TextRun(line)],
                  alignment: "both",  // justify text
                  spacing: {
                    after: 200,       // extra spacing between paragraphs (~0.2")
                    line: 360,        // 1.5 line spacing
                  },
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

  /* ---------------------- Save helpers & state ---------------------- */

  const handleSaveChanges = () => {
    setIsEditing(false);
    if (!currentReport) return;
    try {
      onUpdateReport(currentReport);
    } catch (err) {
      console.error("onUpdateReport failed:", err);
    }
  };

  async function saveReportTitle(newTitle?: string) {
    if (!currentReport) return;
    try {
      const updatedReport = { ...currentReport, title: newTitle ?? currentReport.title };
      setCurrentReport(updatedReport);
      try {
        onUpdateReport(updatedReport);
      } catch (err) {
        console.warn("onUpdateReport failed in saveReportTitle:", err);
      }
    } catch (err) {
      console.error("Failed to save report title:", err);
    }
  }

  if (!currentReport) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <BackButton onBack={handleBack} />
        <p className="text-gray-500 mt-4">No active report. Please select an analysis from the dashboard.</p>
      </div>
    );
  }

  const activeFindings = currentReport.findings?.filter((f) => f.status === "active") ?? [];

  return (
    <div className="h-full bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b shadow-sm flex-shrink-0">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-gray-900 truncate">{currentWorkspace?.name || "WORKSPACE TITLE"}</h1>
            </div>

            <div className="flex items-center gap-8 overflow-x-auto">
              <div className="text-center min-w-[80px]">
                <p className="text-sm text-gray-600">Project Score</p>
                <p className="font-bold text-green-600 text-lg">{currentReport.scores?.project ?? 100}%</p>
              </div>

              <div className="text-center min-w-[80px]">
                <p className="text-sm text-gray-600">Strategic Goals</p>
                <p className="font-bold text-green-600 text-lg">{currentReport.scores?.strategicGoals ?? 100}%</p>
              </div>

              <div className="text-center min-w-[80px]">
                <p className="text-sm text-gray-600">Regulations</p>
                <p className="font-bold text-green-600 text-lg">{currentReport.scores?.regulations ?? 100}%</p>
              </div>

              <div className="text-center min-w-[80px]">
                <p className="text-sm text-gray-600">Risk Mitigation</p>
                <p className="font-bold text-green-600 text-lg">{currentReport.scores?.risk ?? 100}%</p>
              </div>
            </div>

            <div className="min-w-[140px]">
              <button
                onClick={handleAutoEnhance}
                disabled={isEnhancing}
                className="w-full px-4 py-2 bg-red-600 text-white font-bold rounded-lg shadow hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                aria-label="Auto Enhance"
              >
                {isEnhancing ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <SparklesIcon className="w-4 h-4" />
                )}
                Auto-Enhance
              </button>
            </div>
          </div>
        </div>
      </header>

      {isEnhancing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-white/80 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 shadow border">
            <div className="animate-spin rounded-full h-10 w-10 border-b-4 border-red-700 mb-3" />
            <p className="font-medium text-gray-700">Analyzing document…</p>
            {analysisStatusText && <p className="text-sm text-gray-500 mt-2">{analysisStatusText}</p>}
          </div>
        </div>
      )}

      {/* Main layout */}
      <main className="flex-1 p-4 grid grid-cols-1 lg:grid-cols-4 gap-4 w-full">
        <section className="lg:col-span-3">
          <DocumentEditor
            report={currentReport}
            isEditing={isEditing}
            onContentChange={(content) => setCurrentReport({ ...currentReport, documentContent: content })}
            onTitleChange={(title) => saveReportTitle(title)}
            onSaveChanges={handleSaveChanges}
            onToggleEdit={() => setIsEditing((s) => !s)}
            onDownloadPdf={handleDownloadPdf}
            onDownloadTxt={handleDownloadTxt}
            onDownloadDocx={handleDownloadDocx}
            hoveredFindingId={hoveredFindingId}
            selectedFindingId={selectedFindingId}
            onBack={handleBack}
          />
        </section>

        <aside className="lg:col-span-1 space-y-4 flex flex-col">
          <div className="bg-white rounded-xl shadow p-4 border flex-1 min-h-0">
            <h4 className="font-bold mb-3">Actionable Findings ({activeFindings.length})</h4>
            <div className="overflow-auto h-full">
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

          <div className="h-[380px] flex-shrink-0">
            <ChatPanel documentContent={currentReport.documentContent ?? ""} />
          </div>
        </aside>
      </main>

      {feedbackFinding && (
        <FeedbackModal finding={feedbackFinding} onClose={() => setFeedbackFinding(null)} onSubmit={handleDismissSubmit} />
      )}
    </div>
  );
};

export default AnalysisScreen;
