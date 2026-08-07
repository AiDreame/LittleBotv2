import { useState, useRef, type DragEvent, type ChangeEvent } from "react";

interface UploadResult {
  imported: number;
  skipped: number;
  errors: string[];
  discrepancies_found: number;
}

export default function Upload() {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFile(f: File) {
    if (!f.name.endsWith(".csv")) {
      setError("Only CSV files are accepted.");
      return;
    }
    setFile(f);
    setError(null);
    setResult(null);
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function onDragLeave() {
    setDragOver(false);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  }

  async function submit() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/actuals/upload", {
        method: "POST",
        body: form,
      });

      const data = await res.json();

      if (!res.ok) {
        setError(
          (data as { error?: string }).error ?? `Upload failed (HTTP ${res.status})`,
        );
        return;
      }

      setResult(data as UploadResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="page">
      <h2 className="page-title">Upload Actuals</h2>
      <p className="page-desc">
        Upload a CSV file with actual sales data from the Maloum platform.{" "}
        <a href="#" className="link" onClick={(e) => { e.preventDefault(); alert("CSV format:\ndiscord_id,date,actual_sales,actual_tips,source\n\nExample:\nuser_abc123,2026-07-22,450.00,60.00,maloum"); }}>
          View sample CSV format
        </a>
      </p>

      {/* ── Drop zone ── */}
      <div
        className={`dropzone ${dragOver ? "drag-over" : ""} ${file ? "has-file" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          style={{ display: "none" }}
          onChange={onFileChange}
        />
        {file ? (
          <div className="dropzone-file">
            <span className="file-icon">📄</span>
            <span className="file-name">{file.name}</span>
            <span className="file-size">
              {(file.size / 1024).toFixed(1)} KB
            </span>
          </div>
        ) : (
          <div className="dropzone-empty">
            <span className="dropzone-icon">📤</span>
            <p>Drag and drop a CSV file here, or click to browse</p>
            <p className="dropzone-hint">.csv files only, max 5 MB</p>
          </div>
        )}
      </div>

      {/* ── Submit button ── */}
      <button
        className="btn btn-primary"
        disabled={!file || uploading}
        onClick={submit}
      >
        {uploading ? "Uploading…" : "Upload CSV"}
      </button>

      {/* ── Error ── */}
      {error && <div className="alert alert-error">{error}</div>}

      {/* ── Result ── */}
      {result && (
        <div className="card result-card">
          <h3 className="card-title">Import Results</h3>
          <div className="result-grid">
            <div className="result-item">
              <span className="result-value">{result.imported}</span>
              <span className="result-label">Imported</span>
            </div>
            <div className="result-item">
              <span className="result-value">{result.skipped}</span>
              <span className="result-label">Skipped</span>
            </div>
            <div className="result-item highlight-warn">
              <span className="result-value">{result.discrepancies_found}</span>
              <span className="result-label">Discrepancies Found</span>
            </div>
          </div>
          {result.errors.length > 0 && (
            <div className="result-errors">
              <h4>Errors ({result.errors.length})</h4>
              <ul>
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
