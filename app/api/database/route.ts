import Database from 'better-sqlite3';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';

export const runtime = 'nodejs';

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

type QuizRow = {
  id: string;
  title: string | null;
  data_json: string;
};

type SubmissionRow = {
  id: string;
  quiz_id: string;
  team_name: string;
  round_number: number;
  answers_json: string;
};

const DB_PATH =
  process.env.SQLITE_DB_PATH ||
  path.join(process.cwd(), 'quizgo.db');

let dbSingleton: Database.Database | null = null;

function getDb(): Database.Database {
  if (dbSingleton) return dbSingleton;

  const db = new Database(DB_PATH);
  // Basic durability for local dev.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY,
      title TEXT,
      data_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      answers_json TEXT NOT NULL,
      FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS submissions_unique
      ON submissions (quiz_id, team_name, round_number);

    CREATE INDEX IF NOT EXISTS submissions_by_quiz
      ON submissions (quiz_id);
  `);

  dbSingleton = db;
  return db;
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
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
  const db = getDb();
  const { searchParams } = new URL(req.url);

  const resource = searchParams.get('resource');
  if (!resource) {
    return badRequest(
      "Missing 'resource' query param. Use resource=quizzes|quiz|submissions|submission",
    );
  }

  if (resource === 'quizzes') {
    const rows = db
      .prepare(
        `SELECT id, title, data_json
         FROM quizzes`,
      )
      .all() as QuizRow[];

    return jsonResponse(
      rows.map((r) => ({
        id: r.id,
        title: r.title ?? undefined,
        data: JSON.parse(r.data_json) as unknown,
      })),
    );
  }

  if (resource === 'quiz') {
    const id = searchParams.get('id');
    if (!id) return badRequest("Missing 'id' for resource=quiz");

    const row = db
      .prepare(
        `SELECT id, title, data_json
         FROM quizzes
         WHERE id = ?`,
      )
      .get(id) as QuizRow | undefined;

    if (!row) return jsonResponse({ error: 'Quiz not found' }, 404);

    return jsonResponse({
      id: row.id,
      title: row.title ?? undefined,
      data: JSON.parse(row.data_json) as unknown,
    });
  }

  if (resource === 'submissions') {
    const quizId = searchParams.get('quizId');
    const teamName = searchParams.get('teamName');
    const roundNumber = parseIntParam(searchParams.get('roundNumber'));

    // Build the simplest safe query based on provided filters.
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (quizId) {
      clauses.push('quiz_id = ?');
      params.push(quizId);
    }
    if (teamName) {
      clauses.push('team_name = ?');
      params.push(teamName);
    }
    if (roundNumber != null) {
      clauses.push('round_number = ?');
      params.push(roundNumber);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT id, quiz_id, team_name, round_number, answers_json
         FROM submissions
         ${whereSql}
         ORDER BY rowid DESC`,
      )
      .all(...params) as SubmissionRow[];

    return jsonResponse(
      rows.map((r) => ({
        id: r.id,
        quizId: r.quiz_id,
        teamName: r.team_name,
        roundNumber: r.round_number,
        answers: JSON.parse(r.answers_json) as SubmissionPayload['answers'],
      })),
    );
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

    const row = db
      .prepare(
        `SELECT id, quiz_id, team_name, round_number, answers_json
         FROM submissions
         WHERE quiz_id = ? AND team_name = ? AND round_number = ?`,
      )
      .get(quizId, teamName, roundNumber) as SubmissionRow | undefined;

    if (!row) return jsonResponse({ error: 'Submission not found' }, 404);

    return jsonResponse({
      id: row.id,
      quizId: row.quiz_id,
      teamName: row.team_name,
      roundNumber: row.round_number,
      answers: JSON.parse(row.answers_json) as SubmissionPayload['answers'],
    });
  }

  return badRequest(`Unknown resource: ${resource}`);
}

export async function POST(req: NextRequest) {
  const db = getDb();

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
    const title = typeof quiz.title === 'string' ? quiz.title : null;

    const dataJson = JSON.stringify({
      rounds: quiz.rounds,
      teams: quiz.teams ?? [],
    });

    db.prepare(
      `INSERT INTO quizzes (id, title, data_json)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         data_json = excluded.data_json`,
    ).run(id, title, dataJson);

    return jsonResponse({ id }, 201);
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

    const existing = db
      .prepare(
        `SELECT id FROM submissions
         WHERE quiz_id = ? AND team_name = ? AND round_number = ?`,
      )
      .get(quizId, teamName, roundNumber) as { id: string } | undefined;

    const id = existing?.id ?? makeId('sub');
    const answersJson = JSON.stringify(submission.answers);

    db.prepare(
      `INSERT INTO submissions (id, quiz_id, team_name, round_number, answers_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(quiz_id, team_name, round_number) DO UPDATE SET
         answers_json = excluded.answers_json`,
    ).run(id, quizId, teamName, roundNumber, answersJson);

    return jsonResponse({ id }, 201);
  }

  return badRequest(
    "Unknown action. Use action=upsertQuiz or action=upsertSubmission in JSON body.",
  );
}
