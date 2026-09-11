# SutraAI — Recorded Lectures into Usable Conceptual Notes

> Kalpvruksh 2.0 Mini Hackathon 2026 · Problem P13 · EdTech
> Turn recorded lectures into **threaded conceptual notes** — noise removed, ideas connected, revision-ready.

## What it does

Upload an audio/video lecture. SutraAI:

1. **Transcribes** the lecture locally with Vosk (offline speech-to-text, no account, no API key).
2. **Strips** digressions, repetition, announcements and background noise.
3. **Structures** the real content into: summary, threaded key concepts, cleaned sections, glossary, and concept relationships.
4. **Generates study tools**: flashcards, quiz questions, and a live **mind-map** of concept connections.
5. Every note carries **timestamps** — jump straight back to the part of the lecture it came from.

Everything runs on-device — the audio never leaves your machine.

## Quick start

One click (Windows): double-click **`start-all.cmd`** → opens two consoles, then open **http://localhost:5173**.

Or manually:

```bash
# 1. One-time: install the speech model
py -m pip install vosk
# put vosk-model-small-en-us-0.15 in server/models/ (auto-downloaded on first run)

# 2. Backend
cd server
npm.cmd install
npm.cmd run dev          # http://localhost:4000

# 3. Frontend (second terminal)
cd client
npm.cmd install
npm.cmd run dev          # http://localhost:5173
```

> No console opened? Powershell blocks `npm.ps1`, use `npm.cmd`.

## How it works (fully local)

- `server/lib/transcribe.py` — ffmpeg converts the upload to 16 kHz mono WAV, Vosk transcribes it with word-level timestamps.
- `server/lib/notegen.js` — a rule-based engine extracts key concepts (by frequency & phrasing), splits the lecture into cleaned sections, builds definitions, and generates flashcards, quiz questions, glossary and concept-relationship edges for the mind map.
- `server/index.js` — Express API with `/api/process` (file upload) and `/api/link` (direct media URL), serving the built client from `client/dist`.

There are no built-in sample notes: SutraAI only ever generates notes from a user's actual audio/video file or
direct media link. No API keys required.

## Structure

```
server/   Express API · local transcription (Vosk) · rule-based note engine
client/   React + Vite app · landing · upload · notes workspace
```

## Pitch hints

- Demo by dropping a real recorded lecture (audio or video) or pasting a direct media link — run it on your laptop with no internet needed.
- Use the **Mind Map** tab to show that related ideas (far apart in the audio) are now visually connected — that is the heart of Problem P13.
- Use **Flashcards/Quiz** to show revision time collapsing from hours to minutes.