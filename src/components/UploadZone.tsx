// src/components/UploadModal.tsx
"use client";

import React, { useEffect, useState, useRef } from "react";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";
import { XIcon } from "./Icons"; // replace with your close icon (or remove)

// Configure PDF.js worker for modern bundlers (Vite / Webpack)
// Wrap in try/catch for environments not supporting import.meta.url
try {
  // @ts-ignore
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();
} catch (e) {
  // no-op if not supported in environment
  // console.warn("pdf worker config failed", e);
}

interface UploadModalProps {
  onClose: () => void;
  onUpload: (content: string, fileName: string, quick?: boolean) => void;
  isAnalyzing?: boolean;
  quickPreviewLength?: number; // how many chars to show as preview
}

const DEFAULT_QUICK_PREVIEW = 800;

const steps = [
  "Extracting document content...",
  "Scanning for compliance gaps...",
  "Applying knowledge base rules...",
  "Checking for regulatory conflicts...",
  "Finalizing analysis report...",
];

const LoadingSteps: React.FC = () => {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % steps.length), 2000);
    return () => clearInterval(id);
  }, []);
  return <p className="text-sm text-gray-500 italic mt-2">{steps[index]}</p>;
};

/**
 * Extract text from an uploaded file. Supports pdf, docx, txt, md.
 * Throws on unsupported or scanned PDFs (unless OCR is triggered).
 */
async function extractTextFromFile(file: File): Promise<{ text: string; isScannedPdf?: boolean }> {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";

  if (ext === "pdf") {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = (pdfjsLib as any).getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    let text = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent({ normalizeWhitespace: true });
      const pageText = content.items
        .map((it: any) => (typeof it.str === "string" ? it.str : it.unicode ?? ""))
        .filter(Boolean)
        .join(" ");
      // preserve page separation
      text += pageText.trim() + "\n\n";
    }

    // Heuristic: if text contains very few printable characters relative to length,
    // treat as scanned/garbled PDF.
    const totalLen = Math.max(1, text.length);
    const printableCount = (text.match(/[\p{L}\p{N}\p{P}\p{Zs}\p{S}]/gu) || []).length;
    const printableRatio = printableCount / totalLen;

    // If ratio is low -> likely scanned image pdf
    if (printableRatio < 0.25) {
      return { text: "", isScannedPdf: true };
    }

    return { text: text.replace(/\r\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim(), isScannedPdf: false };
  }

  if (ext === "docx") {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    let raw = result.value || "";
    raw = raw
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ")
      .replace(/[\u200B-\u200F\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text: raw, isScannedPdf: false };
  }

  if (ext === "txt" || ext === "md") {
    const txt = await file.text();
    return { text: txt.replace(/\r\n/g, "\n").trim(), isScannedPdf: false };
  }

  if (ext === "doc") {
    throw new Error("Legacy .doc files are not supported. Save as .docx or .pdf.");
  }

  throw new Error("Unsupported file type. Please upload a PDF, DOCX, or TXT/MD file.");
}

export default function UploadModal({
  onClose,
  onUpload,
  isAnalyzing = false,
  quickPreviewLength = DEFAULT_QUICK_PREVIEW,
}: UploadModalProps) {
  const [processing, setProcessing] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileText, setFileText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isScanned, setIsScanned] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // reset when modal open/close toggles externally
    return () => {
      setProcessing(false);
      setFile(null);
      setFileText("");
      setError(null);
      setIsScanned(false);
    };
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    inputRef.current && (inputRef.current.value = ""); // reset input for same-file re-upload
    setError(null);
    setFile(f);
    setFileText("");
    setIsScanned(false);

    try {
      setProcessing(true);
      const { text, isScannedPdf } = await extractTextFromFile(f);
      if (isScannedPdf) {
        setIsScanned(true);
        setFileText("");
        setError("This PDF appears to be scanned (image-based). You can run OCR (Tesseract) or upload a text-based PDF.");
      } else {
        setFileText(text);
      }
    } catch (err) {
      console.error("extract error", err);
      setError(err instanceof Error ? err.message : "Failed to extract text from file.");
    } finally {
      setProcessing(false);
    }
  };

  // Optional OCR fallback: dynamic import tesseract.js to avoid bundling unless user triggers
  const runOcr = async () => {
    if (!file) return;
    setOcrRunning(true);
    setError(null);
    setOcrProgress(0);

    try {
      // dynamic import; instructs developer to install tesseract.js to enable OCR.
      const { createWorker } = await import("tesseract.js"); // dev: npm i tesseract.js
      const worker = createWorker({
        logger: (m: any) => {
          // m.progress is 0-1 for many steps; combine into percent
          if (m && typeof m.progress === "number") {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });

      await worker.load();
      await worker.loadLanguage("eng");
      await worker.initialize("eng");

      // Recognize using ArrayBuffer or object URL
      const arrayBuffer = await file.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: file.type || "application/pdf" });
      const imageUrl = URL.createObjectURL(blob);

      const { data } = await worker.recognize(imageUrl);
      URL.revokeObjectURL(imageUrl);
      await worker.terminate();

      const text = (data?.text || "").replace(/\r\n/g, "\n").trim();
      if (!text) throw new Error("OCR completed but returned no text.");

      setFileText(text);
      setIsScanned(false);
      setError(null);
    } catch (err) {
      console.error("OCR error", err);
      setError(
        err instanceof Error
          ? `${err.message}. If you want OCR, install \`tesseract.js\` (npm i tesseract.js) and try again.`
          : "OCR failed."
      );
    } finally {
      setOcrRunning(false);
      setOcrProgress(null);
    }
  };

  const handleUploadQuick = () => {
    if (!fileText) return;
    // Quick analyze often uses truncated content to save tokens/context
    const quickSnippet = fileText.slice(0, Math.max(1024, quickPreviewLength));
    onUpload(quickSnippet, file?.name ?? "document", true);
  };

  const handleUploadFull = () => {
    if (!fileText) return;
    onUpload(fileText, file?.name ?? "document", false);
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      aria-modal="true"
      role="dialog"
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-neutral-900 rounded-xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-neutral-100">Upload Document</h3>
          <button
            aria-label="Close"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 p-2 rounded"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <label className="block">
            <div className="mb-2 text-sm text-gray-600 dark:text-neutral-300">Select a file (PDF, DOCX, TXT, MD)</div>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md"
              onChange={handleFileSelect}
              className="w-full"
            />
          </label>

          {processing && (
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full border-b-4 border-red-700 animate-spin" />
              <div>
                <div className="text-sm font-medium">Processing file…</div>
                <div className="text-xs text-gray-500">Extracting text for analysis</div>
              </div>
            </div>
          )}

          {isScanned && (
            <div className="rounded-md p-3 bg-yellow-50 border border-yellow-200">
              <p className="text-sm text-yellow-800">
                This PDF appears to be a scanned image (no selectable text detected). You can:
              </p>
              <ul className="mt-2 text-sm text-yellow-700 list-disc list-inside">
                <li>Run OCR (Tesseract) to extract text — may be slow in browser</li>
                <li>Upload a text-based PDF or DOCX for better extraction</li>
              </ul>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={runOcr}
                  disabled={ocrRunning}
                  className="px-3 py-1.5 bg-amber-600 text-white rounded-md text-sm hover:bg-amber-700 disabled:opacity-60"
                  title="Run OCR (requires tesseract.js to be installed)"
                >
                  {ocrRunning ? (ocrProgress ? `OCR ${ocrProgress}%` : "Running OCR…") : "Run OCR"}
                </button>

                <button
                  onClick={() => {
                    setIsScanned(false);
                    setError("Upload a text-based PDF or a .docx for accurate extraction.");
                  }}
                  className="px-3 py-1.5 bg-gray-100 text-gray-700 rounded-md text-sm hover:bg-gray-200"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md p-3 bg-red-50 border border-red-200 text-sm text-red-700">
              {error}
            </div>
          )}

          {fileText ? (
            <div className="rounded-md border border-gray-100 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm text-gray-600">Preview ({file?.name ?? "document"})</div>
                  <div className="mt-2 text-xs text-gray-700 dark:text-neutral-200 whitespace-pre-wrap max-h-48 overflow-auto">
                    {fileText.slice(0, quickPreviewLength)}
                    {fileText.length > quickPreviewLength && (
                      <span className="text-gray-400">…</span>
                    )}
                  </div>
                </div>

                <div className="text-xs text-gray-400">
                  <div>{fileText.length.toLocaleString()} characters</div>
                  <div className="mt-2 text-right">
                    <div className="text-xs text-gray-500">Suggested</div>
                    <div className="font-medium text-sm">Quick / Full</div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-gray-200 p-4 text-sm text-gray-500">
              No preview available yet — select a file to extract text.
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-md border border-gray-300 bg-white text-sm hover:bg-gray-50"
            >
              Cancel
            </button>

            <button
              onClick={handleUploadQuick}
              disabled={!fileText || processing || isAnalyzing}
              className="px-4 py-2 rounded-md bg-yellow-500 text-white text-sm hover:bg-yellow-600 disabled:opacity-50"
              title="Quick analyze uses truncated content for a faster, cheaper run"
            >
              Quick Analyze
            </button>

            <button
              onClick={handleUploadFull}
              disabled={!fileText || processing || isAnalyzing}
              className="px-4 py-2 rounded-md bg-red-700 text-white text-sm hover:bg-red-800 disabled:opacity-50"
              title="Upload full text for complete analysis"
            >
              Upload & Analyze
            </button>
          </div>

          {isAnalyzing && (
            <div className="mt-2">
              <LoadingSteps />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
