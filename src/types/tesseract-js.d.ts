// Minimal ambient declarations for optional OCR dependency
// This silences TS errors when using dynamic import('tesseract.js')

declare module 'tesseract.js' {
  export interface CreateWorkerOptions {
    logger?: (m: any) => void;
    [key: string]: any;
  }

  export interface TesseractWorker {
    load(): Promise<void>;
    loadLanguage(lang: string): Promise<void>;
    initialize(lang: string): Promise<void>;
    recognize(image: string | Blob | ArrayBuffer): Promise<{ data?: any }>;
    terminate(): Promise<void>;
  }

  export function createWorker(options?: CreateWorkerOptions): TesseractWorker;
}


