export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';

type Ruleset = 'multiple-choice' | 'number' | 'free-text' | string;

type ParsedQuestion = {
  text: string;
  options?: string[];
  correctAnswer: unknown;
};

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  });
}

function badRequest(message: string, details?: unknown) {
  return jsonResponse({ error: message, details }, 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractStreamDeltaText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const c0 = candidates[0];
  if (!isRecord(c0)) return '';
  const content = c0.content;
  if (!isRecord(content)) return '';
  const parts = content.parts;
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const p of parts) {
    if (isRecord(p) && typeof p.text === 'string') out += p.text;
  }
  return out;
}

function extractTextFromVertexStreamResponse(raw: string): { text: string; events: number } {
  const trimmed = raw.trim();
  if (!trimmed) return { text: '', events: 0 };

  // For this endpoint, the response is commonly a single JSON array streamed over time.
  // Example: [{...},\n,{...},\n,{...}] 
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    // Fallback: try to salvage the JSON array.
    const first = trimmed.indexOf('[');
    const last = trimmed.lastIndexOf(']');
    if (first >= 0 && last > first) {
      parsed = JSON.parse(trimmed.slice(first, last + 1)) as unknown;
    } else {
      throw new Error('Vertex response was not valid JSON');
    }
  }

  if (Array.isArray(parsed)) {
    let out = '';
    for (const evt of parsed) out += extractStreamDeltaText(evt);
    return { text: out.trim(), events: parsed.length };
  }

  // Some environments may return a single object.
  return { text: extractStreamDeltaText(parsed).trim(), events: 1 };
}

function tryParseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty model output');

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Try to extract the first JSON array/object from the text.
    const firstArray = trimmed.indexOf('[');
    const lastArray = trimmed.lastIndexOf(']');
    if (firstArray >= 0 && lastArray > firstArray) {
      const slice = trimmed.slice(firstArray, lastArray + 1);
      return JSON.parse(slice) as unknown;
    }

    const firstObj = trimmed.indexOf('{');
    const lastObj = trimmed.lastIndexOf('}');
    if (firstObj >= 0 && lastObj > firstObj) {
      const slice = trimmed.slice(firstObj, lastObj + 1);
      return JSON.parse(slice) as unknown;
    }

    throw new Error('Model output was not valid JSON');
  }
}

function buildSystemPrompt(ruleset: Ruleset) {
  return [
    'You are helping build a quiz round in a trivia app.',
    'Input: a blob of text that contains multiple questions and their correct answers, possibly with formatting, separators, or annotations.',
    '',
    `The quiz round ruleset is: ${ruleset}.`,
    '',
    'Task:',
    '- Split the text into individual questions.',
    '- Infer how answers are denoted in the text (e.g., after "Answer:", highlighted, in parentheses, etc.).',
    '- Return ONLY JSON (no markdown) representing an array of questions.',
    '',
    'Output JSON schema (array):',
    '[',
    '  {',
    '    "text": string,',
    '    "options"?: string[] (ONLY for multiple-choice; include 4 options in A/B/C/D order if possible),',
    '    "correctAnswer":',
    '      - for multiple-choice: one of "A"|"B"|"C"|"D" (or а, б, в, г)',
    '      - for number: number',
    '      - for free-text: { "bg": string, "en": string } (if only one language present, copy it to both or leave the missing one empty)',
    '  }',
    ']',
    '',
    'Rules:',
    '- Do not include explanations.',
    '- Preserve question wording.',
    '- If options are present, keep them clean (no leading labels like "A)" unless unavoidable).',
  ].join('\n');
}

function safeSnippet(value: string, max = 2000) {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function describeError(err: unknown) {
  if (err instanceof Error) {
    const anyErr = err as Error & { cause?: unknown };
    return {
      name: err.name,
      message: err.message,
      cause:
        anyErr.cause instanceof Error
          ? { name: anyErr.cause.name, message: anyErr.cause.message }
          : anyErr.cause,
      stack: err.stack,
    };
  }
  return { message: String(err) };
}

function tryExtractGoogleErrorMessage(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const err = parsed.error;
    if (!isRecord(err)) return null;
    const msg = err.message;
    return typeof msg === 'string' ? msg : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const traceId = randomUUID();
  let stage:
    | 'parse_request'
    | 'call_vertex'
    | 'read_vertex_body'
    | 'parse_vertex_body'
    | 'parse_model_json'
    | 'validate_model_output' = 'parse_request';

  const apiKey = process.env.VERTEX_API_KEY?.trim();
  if (!apiKey) {
    return jsonResponse({ error: 'Missing VERTEX_API_KEY in environment.', traceId }, 500);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Expected application/json body');
  }

  const action = isRecord(body) && typeof body.action === 'string' ? body.action : null;
  if (action !== 'parseRoundQuestions') {
    return badRequest('Unknown action. Use action=parseRoundQuestions.');
  }

  const ruleset = isRecord(body) && typeof body.ruleset === 'string' ? body.ruleset : '';
  const text = isRecord(body) && typeof body.text === 'string' ? body.text : '';
  if (!ruleset.trim()) return badRequest('ruleset is required');
  if (!text.trim()) return badRequest('text is required');

  const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash-lite:streamGenerateContent?key=${encodeURIComponent(apiKey)}`;

  const vertexPayload = {
    systemInstruction: {
      role: 'system',
      parts: [{ text: buildSystemPrompt(ruleset) }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
    },
  };

  let modelText = '';
  let vertexStatus: number | null = null;
  let vertexBodySnippet: string | null = null;
  let vertexContentType: string | null = null;
  try {
    stage = 'call_vertex';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(vertexPayload),
      signal: controller.signal,
    });

    vertexStatus = res.status;
    vertexContentType = res.headers.get('content-type');

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      vertexBodySnippet = safeSnippet(errText);
      const googleMsg = tryExtractGoogleErrorMessage(errText);
      clearTimeout(timeout);
      return jsonResponse(
        {
          error: `Vertex call failed (HTTP ${res.status})`,
          details: googleMsg ?? vertexBodySnippet,
          traceId,
          vertexContentType,
        },
        502,
      );
    }

    stage = 'read_vertex_body';
    const rawBody = await res.text();
    vertexBodySnippet = rawBody ? safeSnippet(rawBody) : null;
    clearTimeout(timeout);

    stage = 'parse_vertex_body';
    const extracted = extractTextFromVertexStreamResponse(rawBody);
    modelText = extracted.text;

    stage = 'parse_model_json';
    const parsed = tryParseJsonFromText(modelText);

    stage = 'validate_model_output';
    if (!Array.isArray(parsed)) {
      return jsonResponse(
        {
          error: 'Model did not return a JSON array.',
          details: safeSnippet(modelText),
          traceId,
        },
        502,
      );
    }

    const questions: ParsedQuestion[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;
      const qText = typeof item.text === 'string' ? item.text.trim() : '';
      if (!qText) continue;
      const optionsRaw = item.options;
      const options = Array.isArray(optionsRaw)
        ? optionsRaw.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean)
        : undefined;
      questions.push({
        text: qText,
        options,
        correctAnswer: item.correctAnswer,
      });
    }

    if (questions.length === 0) {
      return jsonResponse(
        {
          error: 'No questions were parsed from the model output.',
          details: safeSnippet(modelText),
          traceId,
        },
        502,
      );
    }

    return jsonResponse({ questions }, 200);
  } catch (err) {
    // Server-side log for debugging. Response stays sanitized.
    console.error('[api/vertex] error', {
      traceId,
      stage,
      vertexStatus,
      vertexBodySnippet,
      vertexContentType,
      error: describeError(err),
      modelTextSnippet: modelText ? safeSnippet(modelText) : null,
    });

    return jsonResponse(
      {
        error: err instanceof Error ? err.message : 'Failed to call Vertex',
        stage,
        traceId,
        vertexStatus,
        vertexDetails: vertexBodySnippet,
        vertexContentType,
        modelText: modelText ? safeSnippet(modelText) : undefined,
      },
      500,
    );
  }
}
