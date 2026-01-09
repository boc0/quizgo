import { NextRequest, NextResponse } from 'next/server';
import { list, put, head, BlobNotFoundError } from '@vercel/blob';
import { createHash } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type QuizRuleset = 'multiple-choice' | 'number' | 'free-text' | string;

type QuizRound = {
  roundNumber: number;
  ruleset: QuizRuleset;
  questions: Array<{
    number: number;
    text: string;
    options?: string[];
    correctAnswer?: unknown;
  }>;
};

export type QuizPayload = {
  id?: string;
  title?: string;
  rounds: QuizRound[];
  teams?: string[];
};

export type SubmissionPayload = {
  quizId: string;
  teamName: string;
  roundNumber: number;
  answers: Array<{ number: number; answer: string | number }>;
};

type StoredQuiz = {
  id: string;
  title?: string;
  rounds: QuizRound[];
  teams: string[];
  updatedAt: string;
};

type StoredSubmission = {
  id: string;
  quizId: string;
  teamName: string;
  roundNumber: number;
  answers: SubmissionPayload['answers'];
  updatedAt: string;
};

const STORE_PREFIX = process.env.QUIZGO_BLOB_PREFIX?.trim() || 'quizgo-db';
const QUIZZES_PREFIX = `${STORE_PREFIX}/quizzes/`;
const SUBMISSIONS_PREFIX = `${STORE_PREFIX}/submissions/`;
const MIN_CACHE_SECONDS = 60;

function requireBlobToken() {
  // When using the Vercel Blob integration, this env var should exist in production.
  // (The SDK defaults to process.env.BLOB_READ_WRITE_TOKEN when deployed on Vercel.)
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'Missing BLOB_READ_WRITE_TOKEN. Add Vercel Blob to the project and ensure the read-write token is present in the deployment environment.',
    );
  }
}

function encodePathSegment(value: string) {
  return encodeURIComponent(value.trim());
}

function quizPathname(id: string) {
  return `${QUIZZES_PREFIX}${encodePathSegment(id)}.json`;
}

function submissionPathname(quizId: string, teamName: string, roundNumber: number) {
  return `${SUBMISSIONS_PREFIX}${encodePathSegment(quizId)}/${encodePathSegment(teamName)}/${roundNumber}.json`;
}

function stableSubmissionId(quizId: string, teamName: string, roundNumber: number) {
  const hash = createHash('sha256')
    .update(`${quizId}\n${teamName}\n${roundNumber}`)
    .digest('hex')
    .slice(0, 16);
  return `sub_${hash}`;
}

async function readJsonBlob<T>(pathname: string): Promise<T | null> {
  try {
    requireBlobToken();
    const meta = await head(pathname);
    const res = await fetch(meta.url, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Failed to fetch blob content for ${pathname} (HTTP ${res.status})`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

async function listAllBlobs(prefix: string) {
  requireBlobToken();
  const blobs: Array<{ pathname: string; url: string; uploadedAt: Date }> = [];
  let cursor: string | undefined;
  // Simple pagination loop (limit is 1000 by default).
  for (;;) {
    const page = await list({ prefix, cursor });
    blobs.push(
      ...page.blobs.map((b) => ({ pathname: b.pathname, url: b.url, uploadedAt: b.uploadedAt })),
    );
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  return blobs;
}

async function writeJsonBlob(pathname: string, value: unknown) {
  requireBlobToken();
  await put(pathname, JSON.stringify(value), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: MIN_CACHE_SECONDS,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      // Avoid accidental caching of API responses.
      'cache-control': 'no-store',
    },
  });
}

function badRequest(message: string, details?: unknown) {
  return jsonResponse({ error: message, details }, 400);
}

function parseIntParam(value: string | null): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const resource = searchParams.get('resource');
  if (!resource) {
    return badRequest(
      "Missing 'resource' query param. Use resource=quizzes|quiz|submissions|submission",
    );
  }

  if (resource === 'quizzes') {
    try {
      const blobs = await listAllBlobs(QUIZZES_PREFIX);
      // Read each quiz JSON; tolerate missing/corrupt entries by surfacing an error.
      const quizzes = await Promise.all(
        blobs.map(async (b) => {
          const res = await fetch(b.url, { method: 'GET' });
          if (!res.ok) {
            throw new Error(`Failed to fetch quiz blob ${b.pathname} (HTTP ${res.status})`);
          }
          return (await res.json()) as StoredQuiz;
        }),
      );

      // Most recent first.
      quizzes.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

      return jsonResponse(
        quizzes.map((q) => ({
          id: q.id,
          title: q.title,
          data: {
            rounds: q.rounds,
            teams: q.teams,
          },
        })),
      );
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Failed to list quizzes' },
        500,
      );
    }
  }

  if (resource === 'quiz') {
    const id = searchParams.get('id');
    if (!id) return badRequest("Missing 'id' for resource=quiz");

    try {
      const quiz = await readJsonBlob<StoredQuiz>(quizPathname(id));
      if (!quiz) return jsonResponse({ error: 'Quiz not found' }, 404);

      return jsonResponse({
        id: quiz.id,
        title: quiz.title,
        data: {
          rounds: quiz.rounds,
          teams: quiz.teams,
        },
      });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Failed to load quiz' },
        500,
      );
    }
  }

  if (resource === 'submissions') {
    const quizId = searchParams.get('quizId');
    const teamName = searchParams.get('teamName');
    const roundNumber = parseIntParam(searchParams.get('roundNumber'));

    try {
      let prefix = SUBMISSIONS_PREFIX;
      if (quizId) prefix = `${SUBMISSIONS_PREFIX}${encodePathSegment(quizId)}/`;
      if (quizId && teamName) {
        prefix = `${SUBMISSIONS_PREFIX}${encodePathSegment(quizId)}/${encodePathSegment(teamName)}/`;
      }

      const blobs = await listAllBlobs(prefix);
      const submissions = await Promise.all(
        blobs.map(async (b) => {
          const res = await fetch(b.url, { method: 'GET' });
          if (!res.ok) {
            throw new Error(`Failed to fetch submission blob ${b.pathname} (HTTP ${res.status})`);
          }
          return (await res.json()) as StoredSubmission;
        }),
      );

      const filtered = submissions.filter((s) => {
        if (quizId && s.quizId !== quizId) return false;
        if (teamName && s.teamName !== teamName) return false;
        if (roundNumber != null && s.roundNumber !== roundNumber) return false;
        return true;
      });

      filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

      return jsonResponse(
        filtered.map((s) => ({
          id: s.id,
          quizId: s.quizId,
          teamName: s.teamName,
          roundNumber: s.roundNumber,
          answers: s.answers,
        })),
      );
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Failed to list submissions' },
        500,
      );
    }
  }

  if (resource === 'submission') {
    const quizId = searchParams.get('quizId');
    const teamName = searchParams.get('teamName');
    const roundNumber = parseIntParam(searchParams.get('roundNumber'));

    if (!quizId || !teamName || roundNumber == null) {
      return badRequest(
        "Missing one of required query params for resource=submission: quizId, teamName, roundNumber",
      );
    }

    try {
      const submission = await readJsonBlob<StoredSubmission>(
        submissionPathname(quizId, teamName, roundNumber),
      );
      if (!submission) return jsonResponse({ error: 'Submission not found' }, 404);

      return jsonResponse({
        id: submission.id,
        quizId: submission.quizId,
        teamName: submission.teamName,
        roundNumber: submission.roundNumber,
        answers: submission.answers,
      });
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Failed to load submission' },
        500,
      );
    }
  }

  return badRequest(`Unknown resource: ${resource}`);
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Expected application/json body');
  }

  const action = isRecord(body) && typeof body.action === 'string' ? body.action : null;
  if (action === 'upsertQuiz') {
    const quizValue = isRecord(body) ? body.quiz : undefined;
    if (!isRecord(quizValue)) return badRequest('Missing quiz payload');

    const roundsValue = quizValue.rounds;
    if (!Array.isArray(roundsValue)) return badRequest('quiz.rounds must be an array');

    const teamsValue = quizValue.teams;
    const teams = Array.isArray(teamsValue)
      ? teamsValue.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean)
      : [];

    const quiz: QuizPayload = {
      id: typeof quizValue.id === 'string' ? quizValue.id : undefined,
      title: typeof quizValue.title === 'string' ? quizValue.title : undefined,
      rounds: roundsValue as QuizRound[],
      teams,
    };

    const id = typeof quiz.id === 'string' && quiz.id.trim() ? quiz.id.trim() : makeId('quiz');

    const stored: StoredQuiz = {
      id,
      title: typeof quiz.title === 'string' ? quiz.title : undefined,
      rounds: quiz.rounds,
      teams: quiz.teams ?? [],
      updatedAt: new Date().toISOString(),
    };

    try {
      requireBlobToken();
      await put(quizPathname(id), JSON.stringify(stored), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: MIN_CACHE_SECONDS,
      });

      return jsonResponse({ id }, 201);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Failed to save quiz' },
        500,
      );
    }
  }

  if (action === 'upsertSubmission') {
    const submissionValue = isRecord(body) ? body.submission : undefined;
    if (!isRecord(submissionValue)) {
      return badRequest('Missing submission payload');
    }

    const quizIdRaw = submissionValue.quizId;
    const teamNameRaw = submissionValue.teamName;
    const roundNumberRaw = submissionValue.roundNumber;
    const answersRaw = submissionValue.answers;

    if (typeof quizIdRaw !== 'string' || !quizIdRaw.trim()) {
      return badRequest('submission.quizId is required');
    }
    if (typeof teamNameRaw !== 'string' || !teamNameRaw.trim()) {
      return badRequest('submission.teamName is required');
    }
    if (typeof roundNumberRaw !== 'number' || !Number.isFinite(roundNumberRaw)) {
      return badRequest('submission.roundNumber must be a number');
    }
    if (!Array.isArray(answersRaw)) {
      return badRequest('submission.answers must be an array');
    }

    const submission: SubmissionPayload = {
      quizId: quizIdRaw,
      teamName: teamNameRaw,
      roundNumber: roundNumberRaw,
      answers: answersRaw as SubmissionPayload['answers'],
    };

    const quizId = submission.quizId.trim();
    const teamName = submission.teamName.trim();
    const roundNumber = Math.trunc(submission.roundNumber);

    const id = stableSubmissionId(quizId, teamName, roundNumber);

    const stored: StoredSubmission = {
      id,
      quizId,
      teamName,
      roundNumber,
      answers: submission.answers,
      updatedAt: new Date().toISOString(),
    };

    try {
      requireBlobToken();
      await put(submissionPathname(quizId, teamName, roundNumber), JSON.stringify(stored), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: MIN_CACHE_SECONDS,
      });

      return jsonResponse({ id }, 201);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Failed to save submission' },
        500,
      );
    }
  }

  return badRequest(
    "Unknown action. Use action=upsertQuiz or action=upsertSubmission in JSON body.",
  );
}

export async function DELETE(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Expected application/json body');
  }

  const action = isRecord(body) && typeof body.action === 'string' ? body.action : null;

  if (action === 'deleteRound') {
    const quizIdRaw = isRecord(body) ? body.quizId : undefined;
    const roundNumberRaw = isRecord(body) ? body.roundNumber : undefined;

    if (typeof quizIdRaw !== 'string' || !quizIdRaw.trim()) {
      return badRequest('quizId is required');
    }
    if (typeof roundNumberRaw !== 'number' || !Number.isFinite(roundNumberRaw)) {
      return badRequest('roundNumber must be a number');
    }

    const quizId = quizIdRaw.trim();
    const roundNumber = Math.trunc(roundNumberRaw);

    try {
      const quiz = await readJsonBlob<StoredQuiz>(quizPathname(quizId));
      if (!quiz) return jsonResponse({ error: 'Quiz not found' }, 404);

      const before = quiz.rounds.length;
      const nextRounds = quiz.rounds.filter((r) => r.roundNumber !== roundNumber);
      const removed = nextRounds.length !== before;

      const stored: StoredQuiz = {
        ...quiz,
        rounds: nextRounds,
        updatedAt: new Date().toISOString(),
      };

      await writeJsonBlob(quizPathname(quizId), stored);

      return jsonResponse({ ok: true, removed }, 200);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Failed to delete round' },
        500,
      );
    }
  }

  if (action === 'deleteAnswer' || action === 'deleteQuestion') {
    // "Answer" here refers to a question entry within a round (the thing teams answer).
    const quizIdRaw = isRecord(body) ? body.quizId : undefined;
    const roundNumberRaw = isRecord(body) ? body.roundNumber : undefined;
    const questionNumberRaw = isRecord(body) ? body.questionNumber : undefined;

    if (typeof quizIdRaw !== 'string' || !quizIdRaw.trim()) {
      return badRequest('quizId is required');
    }
    if (typeof roundNumberRaw !== 'number' || !Number.isFinite(roundNumberRaw)) {
      return badRequest('roundNumber must be a number');
    }
    if (typeof questionNumberRaw !== 'number' || !Number.isFinite(questionNumberRaw)) {
      return badRequest('questionNumber must be a number');
    }

    const quizId = quizIdRaw.trim();
    const roundNumber = Math.trunc(roundNumberRaw);
    const questionNumber = Math.trunc(questionNumberRaw);

    try {
      const quiz = await readJsonBlob<StoredQuiz>(quizPathname(quizId));
      if (!quiz) return jsonResponse({ error: 'Quiz not found' }, 404);

      let removed = false;
      const nextRounds = quiz.rounds.map((r) => {
        if (r.roundNumber !== roundNumber) return r;
        const before = r.questions.length;
        const nextQuestions = r.questions.filter((q) => q.number !== questionNumber);
        if (nextQuestions.length !== before) removed = true;
        return { ...r, questions: nextQuestions };
      });

      const stored: StoredQuiz = {
        ...quiz,
        rounds: nextRounds,
        updatedAt: new Date().toISOString(),
      };

      await writeJsonBlob(quizPathname(quizId), stored);

      return jsonResponse({ ok: true, removed }, 200);
    } catch (err) {
      return jsonResponse(
        { error: err instanceof Error ? err.message : 'Failed to delete answer' },
        500,
      );
    }
  }

  return badRequest(
    "Unknown action. Use action=deleteRound or action=deleteAnswer (aka deleteQuestion) in JSON body.",
  );
}
