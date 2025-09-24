"use client";

import React, { useState, useEffect } from "react";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist";

// Configure PDF worker for bundlers (Vite, Webpack, etc.)
try {
  // @ts-ignore
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url
  ).toString();
} catch {
  // ignore environments where import.meta.url isn't supported
}

interface UploadModalProps {
  onClose: () => void;
  onUpload: (content: string, fileName: string, quick?: boolean) => void;
  isAnalyzing: boolean;
}

const steps = [
  "Extracting document content...",
  "Scanning for compliance gaps...",
  "Applying knowledge base rules...",
  "Checking for regulatory conflicts...",
  "Finalizing analysis report...",
];

const LoadingSteps: React.FC = () => {
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const interval = setInterval(
      () => setCurrentStep((prev) => (prev + 1) % steps.length),
      2000
    );
    return () => clearInterval(interval);
  }, []);

  return (
    <p className="text-sm text-gray-500 dark:text-neutral-400 italic mt-2">
      {steps[currentStep]}
    </p>
  );
};

const extractTextFromFile = async (file: File): Promise<string> => {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";

  if (ext === "pdf") {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await (pdfjsLib as any).getDocument({ data: arrayBuffer })
      .promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent({
        normalizeWhitespace: true,
      });
      const pageText = textContent.items
        .map((item: any) =>
          typeof item.str === "string" ? item.str : item.unicode ?? ""
        )
        .join(" ");
      text += pageText + "\n\n"; // keep spacing between pages
    }

    // Heuristic: check if scanned (garbled text)
    const printableCount =
      (text.match(/[\p{L}\p{N}\p{P}\p{Zs}\p{S}]/gu) || []).length;
    if (text.length > 0 && printableCount / text.length < 0.25) {
      throw new Error(
        "This PDF looks scanned (image-based). Please upload a text-based PDF or enable OCR."
      );
    }

    return text.replace(/[ \t]{2,}/g, " ").trim();
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
      .replace(/\n{3,}/g, "\n\n");
    return raw.trim();
  }

  if (ext === "txt" || ext === "md") {
    return await file.text();
  }

  if (ext === "doc") {
    throw new Error(
      "Legacy .doc files are not supported. Please save as .docx or .pdf."
    );
  }

  throw new Error("Unsupported file type. Use .pdf, .docx, or .txt.");
};

const UploadModal: React.FC<UploadModalProps> = ({
  onClose,
  onUpload,
  isAnalyzing,
}) => {
  const [fileContent, setFileContent] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError(null);

    try {
      const text = await extractTextFromFile(file);
      setFileContent(text);
    } catch (err) {
      console.error("File extraction error", err);
      setFileContent("");
      setError(
        err instanceof Error ? err.message : "Failed to extract file content."
      );
    }
  };

  const handleUpload = (quick?: boolean) => {
    if (!fileContent) return;
    onUpload(fileContent, fileName, quick);
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl p-6 w-full max-w-md relative"
        onClick={(e) => e.stopPropagation()}
      >
        {isAnalyzing ? (
          <div className="flex flex-col items-center justify-center py-6">
            <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-red-700 mb-4"></div>
            <p className="text-lg font-semibold text-gray-700 dark:text-neutral-300">
              Analyzing your document...
            </p>
            <LoadingSteps />
          </div>
        ) : (
          <>
            <h2 className="text-xl font-bold mb-4 text-gray-800 dark:text-neutral-200">
              New Analysis
            </h2>
            <div className="mb-4 p-3 rounded-lg border border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800/50">
              <input
                type="file"
                accept=".txt,.md,.docx,.pdf"
                onChange={handleFileChange}
                className="block w-full text-sm text-gray-700 dark:text-neutral-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-red-700 file:text-white hover:file:bg-red-800"
              />
            </div>
            {error && (
              <p className="text-sm text-red-600 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900 rounded-md p-2 mb-3">
                {error}
              </p>
            )}
            <div className="flex justify-between gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md border border-gray-300 dark:border-neutral-600 bg-white/80 backdrop-blur text-gray-700 dark:text-neutral-200 hover:bg-white dark:hover:bg-neutral-700 transition shadow-sm"
              >
                Cancel
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => handleUpload(true)}
                  disabled={!fileContent}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-gradient-to-r from-amber-500 to-yellow-500 text-white hover:from-amber-600 hover:to-yellow-600 disabled:opacity-50 shadow-sm"
                  title="Faster, uses truncated input and less context"
                >
                  <span className="h-2 w-2 rounded-full bg-white animate-pulse" />{" "}
                  Quick Analyze
                </button>
                <button
                  onClick={() => handleUpload(false)}
                  disabled={!fileContent}
                  className="px-4 py-2 rounded-md bg-gradient-to-r from-red-700 to-red-800 text-white hover:from-red-800 hover:to-red-900 disabled:opacity-50 shadow-sm"
                >
                  Upload & Analyze
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default UploadModal;
