import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { buildNotes } from "./lib/notegen.js";
import { createTranscriber } from "./lib/transcribe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env next to this file (no dependencies).
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith("#")) {
        process.env[m[1]] = process.env[m[1]] ?? m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {} // never crash on env parse
const UPLOAD_DIR = path.join(__dirname, "uploads");
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const transcriber = createTranscriber((line) => process.stderr?.write?.(line));
process.on("exit", () => transcriber.stop());
process.on("SIGINT", () => transcriber.stop());
process.on("SIGTERM", () => transcriber.stop());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 900 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(mp3|wav|m4a|webm|ogg|mp4|mov|aac|flac|mkv)$/i.test(file.originalname);
    cb(ok ? null : new Error("Unsupported file type"), ok);
  },
});

const llama = (name) => name.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "local",
    engine: "vosk (persistent worker) + rule-based note generation",
    parallel: "on",
  });
});

app.post("/api/process", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { buffer, mimetype, originalname } = req.file;
    const start = Date.now();

    // Write to temp file for Python transcription
    const tmpDir = path.join(__dirname, "uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const ext = path.extname(originalname) || ".wav";
    const tmpFile = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(tmpFile, buffer);

    try {
      // Persistent Vosk worker — model stays loaded, long audio is parallel-chunked
      const transcript = await transcriber.transcribe(tmpFile);

      // Generate structured notes from transcript
      const result = buildNotes(transcript);
      result.processed_s = ((Date.now() - start) / 1000).toFixed(1);
      result.source = "local";
      result.file_name = originalname;

      res.json(result);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch (err) {
    res.status(500).json({ error: "Processing failed", detail: String(err.message || err) });
  }
});

const MEDIA_EXT = /\.(mp3|wav|m4a|webm|ogg|mp4|mov|aac|flac|mkv)(\?.*)?$/i;
const MAX_LINK_BYTES = 200 * 1024 * 1024;

function goesForIt(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "http:" || u.protocol === "https:";
}

async function downloadMedia(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(90_000),
    headers: { "user-agent": "SutraAI-hackathon-demo/1.0" },
  });
  if (!res.ok) throw new Error(`Remote server responded ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_LINK_BYTES) throw new Error("Remote file is larger than 200 MB — try a smaller file");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_LINK_BYTES) throw new Error("Remote file is larger than 200 MB — try a smaller file");
  return { buffer: buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
}

app.post("/api/link", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !goesForIt(url)) {
      return res.status(400).json({ error: "Please provide a valid http(s) link" });
    }
    const start = Date.now();
    const sourceName = url.split("?")[0];

    if (!MEDIA_EXT.test(sourceName)) {
      return res.status(400).json({
        error: "This link isn't a direct media file",
        hint: "Paste a direct link to an audio/video file (e.g. ending in .mp3, .mp4, .webm).",
      });
    }

    const media = await downloadMedia(url);
    const ext = path.extname(sourceName).split("?")[0] || ".mp3";
    const tmpDir = path.join(__dirname, "uploads");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(tmpFile, media.buffer);

    try {
      const transcript = await transcriber.transcribe(tmpFile);

      const result = buildNotes(transcript);
      result.processed_s = ((Date.now() - start) / 1000).toFixed(1);
      result.source = "local";
      result.link = url;
      result.link_status = "downloaded and processed locally";
      result.title = result.title || sourceName.split("/").pop();

      res.json(result);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  } catch (err) {
    const msg = err.message || String(err);
    if (/larger than|Remote server/i.test(msg)) {
      return res.status(502).json({ error: "Could not fetch that file", detail: msg });
    }
    res.status(500).json({ error: "Link processing failed", detail: msg });
  }
});

app.post("/api/ppt", express.json({ limit: "15mb" }), async (req, res) => {
  const note = req.body?.note;
  if (!note || typeof note !== "object") {
    return res.status(400).json({ error: "No note data sent" });
  }
  const tmpDir = path.join(__dirname, "uploads");
  fs.mkdirSync(tmpDir, { recursive: true });
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const jsonPath = path.join(tmpDir, `${token}.json`);
  const pptxPath = path.join(tmpDir, `${token}.pptx`);
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(note));
    const pyScript = path.join(__dirname, "lib", "pptgen.py");
    const code = await new Promise((resolve, reject) => {
      const py = spawn("py", [pyScript, jsonPath, pptxPath], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      py.stdout.on("data", () => {});
      py.stderr.on("data", d => (stderr += d));
      py.on("close", resolve);
      py.on("error", reject);
    });
    if (code !== 0) throw new Error(stderr || "PPT generation failed");
    const base = (note.title || "sutraai-notes").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "notes";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.pptx"`);
    res.sendFile(pptxPath, () => {
      try { fs.unlinkSync(jsonPath); } catch {}
      try { fs.unlinkSync(pptxPath); } catch {}
    });
  } catch (err) {
    try { fs.unlinkSync(jsonPath); } catch {}
    try { fs.unlinkSync(pptxPath); } catch {}
    res.status(500).json({ error: "PPT generation failed", detail: String(err.message || err) });
  }
});

if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
  app.use(express.static(CLIENT_DIST, { setHeaders: (res, p) => {
    if (p.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
    } else {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
  } }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res
      .status(200)
      .send(
        "SutraAI server is running. Build the client first: <code>cd client && npm run build</code>, then reload http://localhost:4000"
      );
  });
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`SutraAI server on http://localhost:${PORT}  ·  on-device Vosk worker + rule-based notes`);
});