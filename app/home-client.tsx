'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type Ruleset = 'multiple-choice' | 'number' | 'free-text';

type FreeTextCorrectAnswer = {
  bg: string;
  en: string;
};

type QuizRound = {
  roundNumber: number;
  ruleset: Ruleset;
  pointsPerCorrectAnswer?: number;
  pointsExactMatch?: number;
  pointsClosestWithoutExactMatch?: number;
  questions: Array<{
    number: number;
    text: string;
    options?: string[];
    correctAnswer?: string | number | FreeTextCorrectAnswer;
  }>;
};

type Quiz = {
  id: string;
  title?: string;
  rounds: QuizRound[];
  teams: string[];
};

type QuizListItem = {
  id: string;
  title?: string;
  data: { rounds?: QuizRound[]; teams?: string[] };
};

type ManageView = 'quizList' | 'quiz' | 'round' | 'question';
type TeamsView = 'quizList' | 'teamsList';

type RoundScope = 'all' | number;

type SubmissionItem = {
  quizId: string;
  teamName: string;
  roundNumber: number;
  answers: Array<{ number: number; answer: string | number }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isChoice(value: unknown): value is 'A' | 'B' | 'C' | 'D' {
  return value === 'A' || value === 'B' || value === 'C' || value === 'D';
}

function SortableRow(props: {
  id: string;
  disabled?: boolean;
  children: (args: {
    attributes: HTMLAttributes<HTMLElement>;
    listeners: HTMLAttributes<HTMLElement>;
    isDragging: boolean;
  }) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: Boolean(props.disabled),
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'opacity-60' : undefined}
    >
      {props.children({
        attributes: attributes as unknown as HTMLAttributes<HTMLElement>,
        listeners: (listeners ?? {}) as unknown as HTMLAttributes<HTMLElement>,
        isDragging,
      })}
    </div>
  );
}

export default function HomeClient() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState<'submit' | 'manage' | 'teams' | 'score'>('manage');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [manageView, setManageView] = useState<ManageView>('quizList');
  const [quizList, setQuizList] = useState<QuizListItem[]>([]);
  const [activeQuiz, setActiveQuiz] = useState<Quiz | null>(null);
  const [activeRoundNumber, setActiveRoundNumber] = useState<number | null>(null);
  const [activeQuestionNumber, setActiveQuestionNumber] = useState<number | null>(null);
  const [questionDraft, setQuestionDraft] = useState<{
    text: string;
    correctAnswer: string | number;
    correctAnswerBg: string;
    correctAnswerEn: string;
    options: string[];
    correctChoice: 'A' | 'B' | 'C' | 'D' | '';
  } | null>(null);
  const [isDbBusy, setIsDbBusy] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  const [teamsView, setTeamsView] = useState<TeamsView>('quizList');
  const [teamsQuiz, setTeamsQuiz] = useState<Quiz | null>(null);

  const [submitPdfUrl, setSubmitPdfUrl] = useState<string | null>(null);
  const submitPdfUrlRef = useRef<string | null>(null);
  const submitPdfBlobRef = useRef<Blob | null>(null);
  const submitPdfSourceKeyRef = useRef<string | null>(null);
  const [submitAnswerDrafts, setSubmitAnswerDrafts] = useState<string[]>([]);
  const [submitSelectedQuizId, setSubmitSelectedQuizId] = useState<string>('');
  const [submitQuiz, setSubmitQuiz] = useState<Quiz | null>(null);
  const [submitRoundNumber, setSubmitRoundNumber] = useState<number | ''>('');
  const [submitTeamName, setSubmitTeamName] = useState<string>('');

  const [scoreSelectedQuizId, setScoreSelectedQuizId] = useState<string>('');
  const [scoreQuiz, setScoreQuiz] = useState<Quiz | null>(null);
  const [scoreScope, setScoreScope] = useState<RoundScope>('all');
  const [scoreResults, setScoreResults] = useState<Array<{ teamName: string; points: number }>>([]);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  );

  useEffect(() => {
    return () => {
      if (submitPdfUrlRef.current) {
        URL.revokeObjectURL(submitPdfUrlRef.current);
        submitPdfUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const tab = searchParams.get('tab');
    const nextTab: 'submit' | 'manage' | 'teams' | 'score' =
      tab === 'submit' ? 'submit' : tab === 'teams' ? 'teams' : tab === 'score' ? 'score' : 'manage';
    setActiveTab(nextTab);
  }, [searchParams]);

  const setTab = (tab: 'submit' | 'manage' | 'teams' | 'score') => {
    setActiveTab(tab);

    const params = new URLSearchParams(searchParams.toString());
    // Make Manage the default (no query param). When switching to Submit,
    // set `?tab=submit`; when switching to Manage, remove the param.
    if (tab === 'submit') {
      params.set('tab', 'submit');
    } else if (tab === 'teams') {
      params.set('tab', 'teams');
    } else if (tab === 'score') {
      params.set('tab', 'score');
    } else {
      params.delete('tab');
    }

    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const fetchQuizList = async () => {
    setDbError(null);
    try {
      const res = await fetch('/api/database?resource=quizzes');
      const data = (await res.json()) as unknown;
      if (!res.ok) {
        const msg = isRecord(data) && typeof data.error === 'string' ? data.error : 'Failed to load quizzes.';
        throw new Error(msg);
      }
      setQuizList(Array.isArray(data) ? (data as QuizListItem[]) : []);
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Failed to load quizzes.');
      setQuizList([]);
    }
  };

  useEffect(() => {
    const shouldFetchManage = activeTab === 'manage' && manageView === 'quizList';
    const shouldFetchTeams = activeTab === 'teams' && teamsView === 'quizList';
    const shouldFetchSubmit = activeTab === 'submit' && quizList.length === 0;
    const shouldFetchScore = activeTab === 'score' && quizList.length === 0;
    if (!shouldFetchManage && !shouldFetchTeams && !shouldFetchSubmit && !shouldFetchScore) return;
    void fetchQuizList();
  }, [activeTab, manageView, teamsView, quizList.length]);

  const normalizeText = (value: unknown) =>
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');

  const levenshteinDistance = (a: string, b: string) => {
    if (a === b) return 0;
    const alen = a.length;
    const blen = b.length;
    if (alen === 0) return blen;
    if (blen === 0) return alen;

    const prev = new Array<number>(blen + 1);
    const curr = new Array<number>(blen + 1);
    for (let j = 0; j <= blen; j += 1) prev[j] = j;

    for (let i = 1; i <= alen; i += 1) {
      curr[0] = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= blen; j += 1) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= blen; j += 1) prev[j] = curr[j];
    }
    return prev[blen];
  };

  const isFreeTextCorrect = (answerRaw: unknown, correct: unknown) => {
    const answer = normalizeText(answerRaw);
    if (!answer) return false;

    const bg = isRecord(correct) && typeof correct.bg === 'string' ? correct.bg : typeof correct === 'string' ? correct : '';
    const en = isRecord(correct) && typeof correct.en === 'string' ? correct.en : typeof correct === 'string' ? correct : '';

    const candidates = [normalizeText(bg), normalizeText(en)].filter(Boolean);
    if (!candidates.length) return false;

    const threshold = 0.15;
    return candidates.some((c) => {
      const denom = Math.max(answer.length, c.length);
      if (denom === 0) return false;
      const dist = levenshteinDistance(answer, c);
      return dist / denom <= threshold;
    });
  };

  const getRoundPointsPerCorrect = (round: QuizRound) =>
    typeof round.pointsPerCorrectAnswer === 'number' && Number.isFinite(round.pointsPerCorrectAnswer)
      ? round.pointsPerCorrectAnswer
      : 1;

  const getNumberPointsExact = (round: QuizRound) =>
    typeof round.pointsExactMatch === 'number' && Number.isFinite(round.pointsExactMatch) ? round.pointsExactMatch : 3;

  const getNumberPointsClosest = (round: QuizRound) =>
    typeof round.pointsClosestWithoutExactMatch === 'number' && Number.isFinite(round.pointsClosestWithoutExactMatch)
      ? round.pointsClosestWithoutExactMatch
      : 1;

  const computeRoundScores = (round: QuizRound, submissions: SubmissionItem[]) => {
    const pointsByTeam = new Map<string, number>();
    const ensure = (teamName: string) => {
      if (!pointsByTeam.has(teamName)) pointsByTeam.set(teamName, 0);
    };
    for (const s of submissions) ensure(s.teamName);

    const pointsPerCorrect = getRoundPointsPerCorrect(round);

    for (const q of round.questions) {
      const qNumber = q.number;

      if (round.ruleset === 'number') {
        const correctNumber = Number(q.correctAnswer);
        if (!Number.isFinite(correctNumber)) continue;

        const exactTeams: string[] = [];
        const diffs: Array<{ teamName: string; diff: number }> = [];

        for (const s of submissions) {
          const entry = s.answers.find((a) => a.number === qNumber);
          const n = Number(entry?.answer);
          if (!Number.isFinite(n)) continue;

          if (n === correctNumber) {
            exactTeams.push(s.teamName);
          } else {
            diffs.push({ teamName: s.teamName, diff: Math.abs(n - correctNumber) });
          }
        }

        if (exactTeams.length > 0) {
          const pts = getNumberPointsExact(round);
          for (const teamName of exactTeams) {
            pointsByTeam.set(teamName, (pointsByTeam.get(teamName) ?? 0) + pts);
          }
          continue;
        }

        if (diffs.length === 0) continue;
        const minDiff = diffs.reduce((m, d) => Math.min(m, d.diff), Number.POSITIVE_INFINITY);
        const pts = getNumberPointsClosest(round);
        for (const d of diffs) {
          if (d.diff === minDiff) {
            pointsByTeam.set(d.teamName, (pointsByTeam.get(d.teamName) ?? 0) + pts);
          }
        }
        continue;
      }

      for (const s of submissions) {
        const entry = s.answers.find((a) => a.number === qNumber);
        const ans = entry?.answer;

        if (round.ruleset === 'multiple-choice') {
          const correct = typeof q.correctAnswer === 'string' ? q.correctAnswer : '';
          if (typeof ans === 'string' && ans === correct) {
            pointsByTeam.set(s.teamName, (pointsByTeam.get(s.teamName) ?? 0) + pointsPerCorrect);
          }
          continue;
        }

        if (round.ruleset === 'free-text') {
          if (isFreeTextCorrect(ans, q.correctAnswer)) {
            pointsByTeam.set(s.teamName, (pointsByTeam.get(s.teamName) ?? 0) + pointsPerCorrect);
          }
        }
      }
    }

    return pointsByTeam;
  };

  const computeQuizScores = (quiz: Quiz, scope: RoundScope, submissions: SubmissionItem[]) => {
    const teamNames = Array.from(
      new Set<string>([
        ...quiz.teams,
        ...submissions.map((s) => s.teamName),
      ]),
    );

    const pointsByTeam = new Map<string, number>();
    for (const t of teamNames) pointsByTeam.set(t, 0);

    const roundsToScore =
      scope === 'all'
        ? quiz.rounds
        : quiz.rounds.filter((r) => r.roundNumber === scope);

    for (const r of roundsToScore) {
      const subsForRound = submissions.filter((s) => s.roundNumber === r.roundNumber);
      const map = computeRoundScores(r, subsForRound);
      for (const [teamName, pts] of map.entries()) {
        pointsByTeam.set(teamName, (pointsByTeam.get(teamName) ?? 0) + pts);
      }
    }

    return teamNames
      .map((teamName) => ({ teamName, points: pointsByTeam.get(teamName) ?? 0 }))
      .sort((a, b) => b.points - a.points || a.teamName.localeCompare(b.teamName));
  };

  const fetchSubmissions = async (quizId: string, scope: RoundScope): Promise<SubmissionItem[]> => {
    const params = new URLSearchParams();
    params.set('resource', 'submissions');
    params.set('quizId', quizId);
    if (scope !== 'all') {
      params.set('roundNumber', String(scope));
    }
    const res = await fetch(`/api/database?${params.toString()}`);
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const msg = isRecord(data) && typeof data.error === 'string' ? data.error : 'Failed to load submissions.';
      throw new Error(msg);
    }
    return Array.isArray(data) ? (data as SubmissionItem[]) : [];
  };

  const refreshScoreboard = async (quizId: string, scope: RoundScope) => {
    setIsDbBusy(true);
    setDbError(null);
    try {
      const q = await fetchQuiz(quizId);
      setScoreQuiz(q);
      const subs = await fetchSubmissions(quizId, scope);
      const results = computeQuizScores(q, scope, subs).slice().sort((a, b) => b.points - a.points || a.teamName.localeCompare(b.teamName));
      setScoreResults(results);
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Failed to load score.');
      setScoreQuiz(null);
      setScoreResults([]);
    } finally {
      setIsDbBusy(false);
    }
  };

  const parseDocumentAiAnswers = (documentAiJson: unknown) => {
    const entities =
      isRecord(documentAiJson) && isRecord(documentAiJson.document) && Array.isArray(documentAiJson.document.entities)
        ? (documentAiJson.document.entities as unknown[])
        : [];

    const parsed: Array<{ number: number; text: string }> = [];

    for (const ent of entities) {
      if (!isRecord(ent)) continue;
      if (ent.type !== 'answer') continue;
      if (typeof ent.mentionText !== 'string') continue;

      const raw = ent.mentionText.trim();
      const m = raw.match(/^(\d+)\.(\s*[\s\S]*)$/);
      if (!m) continue;

      const n = Number(m[1]);
      if (!Number.isFinite(n)) continue;

      const text = m[2].trim();
      parsed.push({ number: n, text });
    }

    parsed.sort((a, b) => a.number - b.number);
    return parsed;
  };

  const resetSubmitTab = () => {
    setSelectedFile(null);
    setSubmitAnswerDrafts([]);
    setSubmitSelectedQuizId('');
    setSubmitQuiz(null);
    setSubmitRoundNumber('');
    setSubmitTeamName('');

    if (submitPdfUrlRef.current) {
      URL.revokeObjectURL(submitPdfUrlRef.current);
      submitPdfUrlRef.current = null;
    }
    setSubmitPdfUrl(null);

    submitPdfBlobRef.current = null;
    submitPdfSourceKeyRef.current = null;
  };

  const clearSubmitPdfResult = () => {
    setSubmitAnswerDrafts([]);
    if (submitPdfUrlRef.current) {
      URL.revokeObjectURL(submitPdfUrlRef.current);
      submitPdfUrlRef.current = null;
    }
    setSubmitPdfUrl(null);
    submitPdfBlobRef.current = null;
    submitPdfSourceKeyRef.current = null;
  };

  const fetchQuiz = async (id: string): Promise<Quiz> => {
    const res = await fetch(`/api/database?resource=quiz&id=${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!res.ok) {
      const msg = typeof data?.error === 'string' ? data.error : 'Failed to load quiz.';
      throw new Error(msg);
    }

    const roundsRaw = Array.isArray(data?.data?.rounds) ? (data.data.rounds as QuizRound[]) : [];
    const rounds = roundsRaw.map((r) => {
      const ruleset = (r?.ruleset ?? 'free-text') as Ruleset;
      if (ruleset === 'number') {
        return {
          ...r,
          ruleset,
          pointsExactMatch:
            typeof r.pointsExactMatch === 'number' && Number.isFinite(r.pointsExactMatch) ? r.pointsExactMatch : 3,
          pointsClosestWithoutExactMatch:
            typeof r.pointsClosestWithoutExactMatch === 'number' && Number.isFinite(r.pointsClosestWithoutExactMatch)
              ? r.pointsClosestWithoutExactMatch
              : 1,
        };
      }

      return {
        ...r,
        ruleset,
        pointsPerCorrectAnswer:
          typeof r.pointsPerCorrectAnswer === 'number' && Number.isFinite(r.pointsPerCorrectAnswer)
            ? r.pointsPerCorrectAnswer
            : 1,
      };
    });
    const teams = Array.isArray(data?.data?.teams)
      ? (data.data.teams as unknown[]).filter((t): t is string => typeof t === 'string')
      : [];

    return {
      id: String(data.id),
      title: typeof data.title === 'string' ? data.title : undefined,
      rounds,
      teams,
    };
  };

  const saveQuizToDb = async (quiz: Quiz) => {
    setIsDbBusy(true);
    setDbError(null);
    try {
      const res = await fetch('/api/database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsertQuiz',
          quiz: {
            id: quiz.id,
            title: quiz.title ?? '',
            rounds: quiz.rounds,
            teams: quiz.teams,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = typeof data?.error === 'string' ? data.error : 'Failed to save quiz.';
        throw new Error(msg);
      }
      if ((activeTab === 'manage' && manageView === 'quizList') || (activeTab === 'teams' && teamsView === 'quizList')) {
        await fetchQuizList();
      }
      return data as { id: string };
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Failed to save quiz.');
      throw e;
    } finally {
      setIsDbBusy(false);
    }
  };

  const deleteFromDb = async (payload: Record<string, unknown>) => {
    setIsDbBusy(true);
    setDbError(null);
    try {
      const res = await fetch('/api/database', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = typeof data?.error === 'string' ? data.error : 'Delete failed.';
        throw new Error(msg);
      }
      if ((activeTab === 'manage' && manageView === 'quizList') || (activeTab === 'teams' && teamsView === 'quizList')) {
        await fetchQuizList();
      }
      return data as { ok: boolean; removed?: boolean };
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Delete failed.');
      throw e;
    } finally {
      setIsDbBusy(false);
    }
  };

  const openQuiz = async (id: string) => {
    setIsDbBusy(true);
    setDbError(null);
    try {
      const quiz = await fetchQuiz(id);
      setActiveQuiz(quiz);
      setActiveRoundNumber(null);
      setActiveQuestionNumber(null);
      setQuestionDraft(null);
      setManageView('quiz');
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Failed to load quiz.');
    } finally {
      setIsDbBusy(false);
    }
  };

  const createNewQuiz = async () => {
    setIsDbBusy(true);
    setDbError(null);
    try {
      const res = await fetch('/api/database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upsertQuiz', quiz: { title: '', rounds: [], teams: [] } }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = typeof data?.error === 'string' ? data.error : 'Failed to create quiz.';
        throw new Error(msg);
      }
      const id = String(data.id);
      await fetchQuizList();
      await openQuiz(id);
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Failed to create quiz.');
    } finally {
      setIsDbBusy(false);
    }
  };

  const getRound = () => {
    if (!activeQuiz || activeRoundNumber == null) return null;
    return activeQuiz.rounds.find((r) => r.roundNumber === activeRoundNumber) ?? null;
  };

  const getQuestion = () => {
    const round = getRound();
    if (!round || activeQuestionNumber == null) return null;
    return round.questions.find((q) => q.number === activeQuestionNumber) ?? null;
  };

  const addNewRound = async () => {
    if (!activeQuiz) return;
    const nextRoundNumber = (activeQuiz.rounds.reduce((max, r) => Math.max(max, r.roundNumber), 0) || 0) + 1;

    const updated: Quiz = {
      ...activeQuiz,
      rounds: [
        ...activeQuiz.rounds,
        {
          roundNumber: nextRoundNumber,
          ruleset: 'number',
          pointsExactMatch: 3,
          pointsClosestWithoutExactMatch: 1,
          questions: [],
        },
      ],
    };

    setActiveQuiz(updated);
    await saveQuizToDb(updated);
    setActiveRoundNumber(nextRoundNumber);
    setActiveQuestionNumber(null);
    setQuestionDraft(null);
    setManageView('round');
  };

  const openRound = (roundNumber: number) => {
    setActiveRoundNumber(roundNumber);
    setActiveQuestionNumber(null);
    setQuestionDraft(null);
    setManageView('round');
  };

  const deleteRound = async (roundNumber: number) => {
    if (!activeQuiz) return;
    const ok = window.confirm(`Delete round ${roundNumber}? This cannot be undone.`);
    if (!ok) return;

    await deleteFromDb({ action: 'deleteRound', quizId: activeQuiz.id, roundNumber });

    const updated: Quiz = {
      ...activeQuiz,
      rounds: activeQuiz.rounds.filter((r) => r.roundNumber !== roundNumber),
    };
    setActiveQuiz(updated);
  };

  const setRoundRuleset = async (ruleset: Ruleset) => {
    if (!activeQuiz || activeRoundNumber == null) return;
    const updated: Quiz = {
      ...activeQuiz,
      rounds: activeQuiz.rounds.map((r) => {
        if (r.roundNumber !== activeRoundNumber) return r;

        if (ruleset === 'number') {
          return {
            ...r,
            ruleset,
            pointsExactMatch:
              typeof r.pointsExactMatch === 'number' && Number.isFinite(r.pointsExactMatch) ? r.pointsExactMatch : 3,
            pointsClosestWithoutExactMatch:
              typeof r.pointsClosestWithoutExactMatch === 'number' && Number.isFinite(r.pointsClosestWithoutExactMatch)
                ? r.pointsClosestWithoutExactMatch
                : 1,
          };
        }

        return {
          ...r,
          ruleset,
          pointsPerCorrectAnswer:
            typeof r.pointsPerCorrectAnswer === 'number' && Number.isFinite(r.pointsPerCorrectAnswer)
              ? r.pointsPerCorrectAnswer
              : 1,
        };
      }),
    };
    setActiveQuiz(updated);
    await saveQuizToDb(updated);
  };

  const setRoundScoring = async (
    patch: Partial<Pick<QuizRound, 'pointsPerCorrectAnswer' | 'pointsExactMatch' | 'pointsClosestWithoutExactMatch'>>,
  ) => {
    if (!activeQuiz || activeRoundNumber == null) return;
    const updated: Quiz = {
      ...activeQuiz,
      rounds: activeQuiz.rounds.map((r) => (r.roundNumber === activeRoundNumber ? { ...r, ...patch } : r)),
    };
    setActiveQuiz(updated);
    await saveQuizToDb(updated);
  };

  const addNewQuestion = async () => {
    const round = getRound();
    if (!activeQuiz || !round) return;

    const nextQuestionNumber = (round.questions.reduce((max, q) => Math.max(max, q.number), 0) || 0) + 1;

    const newQuestion =
      round.ruleset === 'multiple-choice'
        ? {
            number: nextQuestionNumber,
            text: '',
            options: ['', '', '', ''],
            correctAnswer: '',
          }
        : round.ruleset === 'free-text'
          ? {
              number: nextQuestionNumber,
              text: '',
              correctAnswer: { bg: '', en: '' },
            }
          : {
              number: nextQuestionNumber,
              text: '',
              correctAnswer: 0,
            };

    const updated: Quiz = {
      ...activeQuiz,
      rounds: activeQuiz.rounds.map((r) =>
        r.roundNumber === round.roundNumber ? { ...r, questions: [...r.questions, newQuestion] } : r,
      ),
    };

    setActiveQuiz(updated);
    await saveQuizToDb(updated);

    setActiveQuestionNumber(nextQuestionNumber);
    setQuestionDraft({
      text: '',
      correctAnswer: round.ruleset === 'number' ? 0 : '',
      correctAnswerBg: '',
      correctAnswerEn: '',
      options: round.ruleset === 'multiple-choice' ? ['', '', '', ''] : ['', '', '', ''],
      correctChoice: '',
    });
    setManageView('question');
  };

  const deleteQuestion = async (questionNumber: number) => {
    if (!activeQuiz || activeRoundNumber == null) return;
    const ok = window.confirm(`Delete question ${questionNumber}? This cannot be undone.`);
    if (!ok) return;

    await deleteFromDb({
      action: 'deleteAnswer',
      quizId: activeQuiz.id,
      roundNumber: activeRoundNumber,
      questionNumber,
    });

    const updated: Quiz = {
      ...activeQuiz,
      rounds: activeQuiz.rounds.map((r) =>
        r.roundNumber === activeRoundNumber
          ? { ...r, questions: r.questions.filter((q) => q.number !== questionNumber) }
          : r,
      ),
    };
    setActiveQuiz(updated);
  };

  const reorderRounds = async (event: DragEndEvent) => {
    if (!activeQuiz) return;
    if (!event.over) return;

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (activeId === overId) return;

    const rounds = activeQuiz.rounds;
    const oldIndex = rounds.findIndex((r) => `round-${r.roundNumber}` === activeId);
    const newIndex = rounds.findIndex((r) => `round-${r.roundNumber}` === overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const nextRounds = arrayMove(rounds, oldIndex, newIndex);
    const updated: Quiz = { ...activeQuiz, rounds: nextRounds };
    setActiveQuiz(updated);
    await saveQuizToDb(updated);
  };

  const reorderQuestions = async (event: DragEndEvent) => {
    if (!activeQuiz || activeRoundNumber == null) return;
    const round = getRound();
    if (!round) return;
    if (!event.over) return;

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    if (activeId === overId) return;

    const questions = round.questions;
    const oldIndex = questions.findIndex((q) => `question-${q.number}` === activeId);
    const newIndex = questions.findIndex((q) => `question-${q.number}` === overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const nextQuestions = arrayMove(questions, oldIndex, newIndex);
    const updated: Quiz = {
      ...activeQuiz,
      rounds: activeQuiz.rounds.map((r) =>
        r.roundNumber === activeRoundNumber ? { ...r, questions: nextQuestions } : r,
      ),
    };

    setActiveQuiz(updated);
    await saveQuizToDb(updated);
  };

  const openQuestion = (questionNumber: number) => {
    const round = getRound();
    if (!round) return;
    const q = round.questions.find((qq) => qq.number === questionNumber);
    if (!q) return;

    const options = Array.isArray(q.options) ? q.options.slice(0, 4) : ['', '', '', ''];
    while (options.length < 4) options.push('');

    const correctChoice: 'A' | 'B' | 'C' | 'D' | '' =
      round.ruleset === 'multiple-choice' && isChoice(q.correctAnswer) ? q.correctAnswer : '';

    let correctAnswerBg = '';
    let correctAnswerEn = '';
    if (round.ruleset === 'free-text') {
      if (isRecord(q.correctAnswer)) {
        correctAnswerBg = typeof q.correctAnswer.bg === 'string' ? q.correctAnswer.bg : '';
        correctAnswerEn = typeof q.correctAnswer.en === 'string' ? q.correctAnswer.en : '';
      } else if (typeof q.correctAnswer === 'string') {
        // Back-compat: old quizzes stored a single string.
        correctAnswerBg = q.correctAnswer;
        correctAnswerEn = q.correctAnswer;
      }
    }

    setActiveQuestionNumber(questionNumber);
    setQuestionDraft({
      text: q.text ?? '',
      correctAnswer: typeof q.correctAnswer === 'number' || typeof q.correctAnswer === 'string' ? q.correctAnswer : '',
      correctAnswerBg,
      correctAnswerEn,
      options,
      correctChoice,
    });
    setManageView('question');
  };

  const persistQuestionDraft = async () => {
    const round = getRound();
    const q = getQuestion();
    if (!activeQuiz || !round || !q || !questionDraft) return;

    const updatedQuestion =
      round.ruleset === 'multiple-choice'
        ? {
            ...q,
            text: questionDraft.text,
            options: questionDraft.options,
            correctAnswer: questionDraft.correctChoice,
          }
        : round.ruleset === 'free-text'
          ? {
              ...q,
              text: questionDraft.text,
              correctAnswer: {
                bg: questionDraft.correctAnswerBg,
                en: questionDraft.correctAnswerEn,
              },
            }
          : {
              ...q,
              text: questionDraft.text,
              correctAnswer: (() => {
                const n = Number(questionDraft.correctAnswer);
                return Number.isFinite(n) ? n : 0;
              })(),
            };

    const updated: Quiz = {
      ...activeQuiz,
      rounds: activeQuiz.rounds.map((r) =>
        r.roundNumber === round.roundNumber
          ? {
              ...r,
              questions: r.questions.map((qq) => (qq.number === q.number ? updatedQuestion : qq)),
            }
          : r,
      ),
    };

    setActiveQuiz(updated);
    await saveQuizToDb(updated);
  };

  const selectedLabel = useMemo(() => {
    if (!selectedFile) return 'No file selected';
    return `${selectedFile.name} (${Math.round(selectedFile.size / 1024)} KB)`;
  }, [selectedFile]);

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Failed to read file.'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });

  const loadImageFromFile = async (file: File): Promise<HTMLImageElement> => {
    const dataUrl = await readFileAsDataUrl(file);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode image.'));
      img.src = dataUrl;
    });
  };

  const resizeHalf = async (file: File): Promise<File> => {
    const targetWidth = 1512;
    const targetHeight = 2016;

    const img = await loadImageFromFile(file);
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available.');

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    const mimeType = file.type?.startsWith('image/') ? file.type : 'image/jpeg';
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to encode resized image.'))),
        mimeType,
        mimeType === 'image/jpeg' ? 0.9 : undefined,
      );
    });

    const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const outName = `${baseName}-half.${ext}`;
    return new File([blob], outName, { type: mimeType });
  };

  const submitToScanKit = async () => {
    if (!selectedFile) return;

    const sourceKey = `${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}`;

    setIsSubmitting(true);
    try {
      let pdfBlob = submitPdfBlobRef.current;

      // If we've already got the ScanKit PDF for this exact source file,
      // reuse it instead of calling ScanKit again (avoids burning credits).
      if (!(pdfBlob && submitPdfSourceKeyRef.current === sourceKey)) {
        const resizedFile = await resizeHalf(selectedFile);

        const form = new FormData();
        form.append('file', resizedFile);
        form.append('return_pdf', 'true');

        const res = await fetch('/api/scankit', {
          method: 'POST',
          body: form,
        });

        const contentType = res.headers.get('content-type') ?? '';

        if (contentType.includes('application/pdf')) {
          const buffer = await res.arrayBuffer();
          pdfBlob = new Blob([buffer], { type: 'application/pdf' });

          submitPdfBlobRef.current = pdfBlob;
          submitPdfSourceKeyRef.current = sourceKey;

          const url = URL.createObjectURL(pdfBlob);
          if (submitPdfUrlRef.current) {
            URL.revokeObjectURL(submitPdfUrlRef.current);
          }
          submitPdfUrlRef.current = url;
          setSubmitPdfUrl(url);
        } else if (contentType.includes('application/json')) {
          console.log('ScanKit response body:', await res.json());
          throw new Error('ScanKit did not return a PDF.');
        } else {
          console.log('ScanKit response body:', await res.text());
          throw new Error('ScanKit did not return a PDF.');
        }
      } else if (!submitPdfUrlRef.current) {
        // Cache hit but the object URL was cleared; recreate it.
        const url = URL.createObjectURL(pdfBlob);
        submitPdfUrlRef.current = url;
        setSubmitPdfUrl(url);
      }

      if (!pdfBlob) {
        throw new Error('Missing ScanKit PDF result.');
      }

      const docForm = new FormData();
      docForm.append('file', new File([pdfBlob], 'scankit-result.pdf', { type: 'application/pdf' }));

      const docRes = await fetch('/api/documentai', {
        method: 'POST',
        body: docForm,
      });

      const docJson = (await docRes.json().catch(() => null)) as unknown;
      console.log('Document AI response body:', docJson);
      if (!docRes.ok) {
        const msg =
          isRecord(docJson) && typeof docJson.error === 'string'
            ? docJson.error
            : 'Document AI request failed.';
        throw new Error(msg);
      }

      const parsed = parseDocumentAiAnswers(docJson);
      const drafts = Array.from({ length: 10 }, () => '');
      for (const a of parsed) {
        if (a.number >= 1 && a.number <= 10) {
          drafts[a.number - 1] = a.text;
        }
      }
      setSubmitAnswerDrafts(drafts);
    } catch (error) {
      setDbError(error instanceof Error ? error.message : 'ScanKit request failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const submitAnswersToDb = async () => {
    if (!submitSelectedQuizId || !submitQuiz || submitRoundNumber === '' || !submitTeamName.trim()) {
      return;
    }

    const round = submitQuiz.rounds.find((r) => r.roundNumber === submitRoundNumber) ?? null;
    const ruleset = round?.ruleset ?? 'free-text';

    const drafts = submitAnswerDrafts.length === 10 ? submitAnswerDrafts : Array.from({ length: 10 }, (_, i) => submitAnswerDrafts[i] ?? '');
    const answers = drafts.map((draft, idx) => {
      const number = idx + 1;
      const raw = String(draft ?? '').trim();

      const answer: string | number =
        ruleset === 'number'
          ? (() => {
              const n = Number(raw);
              return Number.isFinite(n) ? n : 0;
            })()
          : raw;

      return { number, answer };
    });

    setIsDbBusy(true);
    setDbError(null);
    try {
      const res = await fetch('/api/database', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsertSubmission',
          submission: {
            quizId: submitSelectedQuizId,
            teamName: submitTeamName,
            roundNumber: submitRoundNumber,
            answers,
          },
        }),
      });
      const data = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const msg = isRecord(data) && typeof data.error === 'string' ? data.error : 'Failed to save submission.';
        throw new Error(msg);
      }

      resetSubmitTab();
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Failed to save submission.');
    } finally {
      setIsDbBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex items-end gap-1 border-b border-gray-200">
          <button
            type="button"
            onClick={() => setTab('manage')}
            className={
              activeTab === 'manage'
                ? 'relative -mb-px rounded-t-md border border-b-white border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900'
                : 'rounded-t-md border border-transparent px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900'
            }
          >
            Manage
          </button>
          <button
            type="button"
            onClick={() => setTab('submit')}
            className={
              activeTab === 'submit'
                ? 'relative -mb-px rounded-t-md border border-b-white border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900'
                : 'rounded-t-md border border-transparent px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900'
            }
          >
            Submit
          </button>
          <button
            type="button"
            onClick={() => setTab('teams')}
            className={
              activeTab === 'teams'
                ? 'relative -mb-px rounded-t-md border border-b-white border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900'
                : 'rounded-t-md border border-transparent px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900'
            }
          >
            Teams
          </button>
          <button
            type="button"
            onClick={() => setTab('score')}
            className={
              activeTab === 'score'
                ? 'relative -mb-px rounded-t-md border border-b-white border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-900'
                : 'rounded-t-md border border-transparent px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900'
            }
          >
            Score
          </button>
        </div>

        <div className="rounded-b-lg border border-t-0 border-gray-200 bg-white p-6">
          {activeTab === 'submit' ? (
            <>
              <h1 className="text-xl font-semibold">Submit a score sheet</h1>

              {dbError ? (
                <div className="mt-4 rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-700">
                  {dbError}
                </div>
              ) : null}

              <div className={submitPdfUrl ? 'mt-6 flex gap-6' : 'mt-6'}>
                <div className={submitPdfUrl ? 'w-full max-w-md space-y-4' : 'space-y-3'}>
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">Image</label>
                    <input
                      key={selectedFile ? selectedFile.name : 'empty'}
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const next = e.target.files?.[0] ?? null;
                        const prevKey = selectedFile
                          ? `${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}`
                          : null;
                        const nextKey = next ? `${next.name}:${next.size}:${next.lastModified}` : null;

                        if (prevKey && nextKey && prevKey !== nextKey) {
                          clearSubmitPdfResult();
                        }

                        if (!next) {
                          clearSubmitPdfResult();
                        }

                        setSelectedFile(next);
                      }}
                      className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-gray-200"
                    />
                    <div className="text-xs text-gray-500">{selectedLabel}</div>

                    <button
                      type="button"
                      disabled={!selectedFile || isSubmitting}
                      onClick={submitToScanKit}
                      className="mt-2 inline-flex w-full items-center justify-center rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSubmitting ? 'Reading...' : 'Read answers'}
                    </button>
                  </div>

                  {submitPdfUrl ? (
                    <>
                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700">Quiz</label>
                        <select
                          value={submitSelectedQuizId}
                          onChange={async (e) => {
                            const id = e.target.value;
                            setSubmitSelectedQuizId(id);
                            setSubmitQuiz(null);
                            setSubmitRoundNumber('');
                            setSubmitTeamName('');
                            if (!id) return;
                            setIsDbBusy(true);
                            setDbError(null);
                            try {
                              const q = await fetchQuiz(id);
                              setSubmitQuiz(q);
                              const firstRound = q.rounds.slice().sort((a, b) => a.roundNumber - b.roundNumber)[0];
                              setSubmitRoundNumber(firstRound ? firstRound.roundNumber : '');
                              const firstTeam = q.teams[0] ?? '';
                              setSubmitTeamName(firstTeam);
                            } catch (err) {
                              setDbError(err instanceof Error ? err.message : 'Failed to load quiz.');
                            } finally {
                              setIsDbBusy(false);
                            }
                          }}
                          className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                          disabled={isDbBusy}
                        >
                          <option value="">Select…</option>
                          {quizList.map((q) => (
                            <option key={q.id} value={q.id}>
                              {(q.title ?? '').trim() || '(untitled quiz)'}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700">Round</label>
                        <select
                          value={submitRoundNumber}
                          onChange={(e) => setSubmitRoundNumber(e.target.value ? Number(e.target.value) : '')}
                          className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                          disabled={isDbBusy || !submitQuiz}
                        >
                          <option value="">Select…</option>
                          {(submitQuiz?.rounds ?? [])
                            .slice()
                            .sort((a, b) => a.roundNumber - b.roundNumber)
                            .map((r) => (
                              <option key={r.roundNumber} value={r.roundNumber}>
                                Round {r.roundNumber}
                              </option>
                            ))}
                        </select>
                      </div>

                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700">Team</label>
                        <select
                          value={submitTeamName}
                          onChange={(e) => setSubmitTeamName(e.target.value)}
                          className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                          disabled={isDbBusy || !submitQuiz}
                        >
                          <option value="">Select…</option>
                          {(submitQuiz?.teams ?? []).map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700">Answers</label>
                        <div className="space-y-2">
                          {Array.from({ length: 10 }, (_, idx) => (
                            <div key={idx} className="flex items-start gap-2">
                              <div className="w-10 pt-2 text-right text-sm font-medium text-gray-700">
                                {idx + 1}.
                              </div>
                              <input
                                value={submitAnswerDrafts[idx] ?? ''}
                                onChange={(e) =>
                                  setSubmitAnswerDrafts((prev) => {
                                    const next = prev.length ? prev.slice() : Array.from({ length: 10 }, () => '');
                                    while (next.length < 10) next.push('');
                                    next[idx] = e.target.value;
                                    return next;
                                  })
                                }
                                className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                                disabled={isDbBusy}
                              />
                            </div>
                          ))}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => void submitAnswersToDb()}
                        className="mt-2 inline-flex w-full items-center justify-center rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={
                          isDbBusy ||
                          !submitSelectedQuizId ||
                          !submitQuiz ||
                          submitRoundNumber === '' ||
                          !submitTeamName.trim()
                        }
                      >
                        {isDbBusy ? 'Submitting…' : 'Submit answers'}
                      </button>
                    </>
                  ) : null}
                </div>

                {submitPdfUrl ? (
                  <div className="flex-1">
                    <div className="h-[70vh] overflow-hidden rounded-md border border-gray-200 bg-white">
                      <iframe title="ScanKit PDF" src={submitPdfUrl} className="h-full w-full" />
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : activeTab === 'manage' ? (
            <>
              {manageView !== 'quizList' ? (
                <div className="mb-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      if (manageView === 'question') {
                        await persistQuestionDraft();
                        setManageView('round');
                        return;
                      }
                      if (manageView === 'round') {
                        setManageView('quiz');
                        return;
                      }
                      if (manageView === 'quiz') {
                        setActiveQuiz(null);
                        setActiveRoundNumber(null);
                        setActiveQuestionNumber(null);
                        setQuestionDraft(null);
                        setManageView('quizList');
                        return;
                      }
                    }}
                    className="inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    disabled={isDbBusy}
                  >
                    Back
                  </button>
                </div>
              ) : null}

              {dbError ? (
                <div className="mb-4 rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-700">
                  {dbError}
                </div>
              ) : null}

              {manageView === 'quizList' ? (
                <>
                  <h1 className="text-xl font-semibold">Manage Quizzes</h1>
                  <div className="mt-6 space-y-3">
                    {quizList.map((q) => {
                      const title = (q.title ?? '').trim() || '(untitled quiz)';
                      const roundsCount = Array.isArray(q.data?.rounds) ? q.data.rounds.length : 0;
                      return (
                        <button
                          key={q.id}
                          type="button"
                          onClick={() => void openQuiz(q.id)}
                          className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left hover:bg-gray-50"
                          disabled={isDbBusy}
                        >
                          <div className="text-sm font-medium text-gray-900">{title}</div>
                          <div className="mt-1 text-xs text-gray-500">{roundsCount} rounds</div>
                        </button>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => void createNewQuiz()}
                      className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left hover:bg-gray-50"
                      disabled={isDbBusy}
                    >
                      <div className="text-sm font-medium text-gray-900">+ create new quiz</div>
                    </button>
                  </div>
                </>
              ) : null}

              {manageView === 'quiz' && activeQuiz ? (
                <>
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-700">Quiz name</label>
                    <input
                      value={activeQuiz.title ?? ''}
                      onChange={(e) => setActiveQuiz({ ...activeQuiz, title: e.target.value })}
                      onBlur={() => void saveQuizToDb(activeQuiz)}
                      className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                      placeholder="Quiz name"
                      disabled={isDbBusy}
                    />
                  </div>

                  <div className="mt-6 space-y-3">
                    <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={(e) => void reorderRounds(e)}>
                      <SortableContext
                        items={activeQuiz.rounds.map((r) => `round-${r.roundNumber}`)}
                        strategy={verticalListSortingStrategy}
                      >
                        {activeQuiz.rounds.map((r) => (
                          <SortableRow key={r.roundNumber} id={`round-${r.roundNumber}`} disabled={isDbBusy}>
                            {({ attributes, listeners }) => (
                              <div className="flex items-stretch gap-2">
                                <button
                                  type="button"
                                  {...attributes}
                                  {...listeners}
                                  className="shrink-0 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 cursor-grab active:cursor-grabbing"
                                  disabled={isDbBusy}
                                >
                                  Drag
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openRound(r.roundNumber)}
                                  className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left hover:bg-gray-50"
                                  disabled={isDbBusy}
                                >
                                  <div className="text-sm font-medium text-gray-900">Round {r.roundNumber}</div>
                                  <div className="mt-1 text-xs text-gray-500">{r.questions.length} questions  · {r.ruleset}</div>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteRound(r.roundNumber)}
                                  className="shrink-0 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                  disabled={isDbBusy}
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </SortableRow>
                        ))}
                      </SortableContext>
                    </DndContext>

                    <button
                      type="button"
                      onClick={() => void addNewRound()}
                      className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left hover:bg-gray-50"
                      disabled={isDbBusy}
                    >
                      <div className="text-sm font-medium text-gray-900">+ add new round</div>
                    </button>
                  </div>
                </>
              ) : null}

              {manageView === 'round' && activeQuiz && activeRoundNumber != null ? (
                <>
                  <h2 className="text-lg font-semibold">Round {activeRoundNumber}</h2>
                  <div className="mt-4 space-y-2">
                    <label className="block text-sm font-medium text-gray-700">Ruleset</label>
                    <select
                      value={(getRound()?.ruleset ?? 'number') as Ruleset}
                      onChange={(e) => void setRoundRuleset(e.target.value as Ruleset)}
                      className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                      disabled={isDbBusy}
                    >
                      <option value="multiple-choice">multiple-choice</option>
                      <option value="number">number</option>
                      <option value="free-text">free-text</option>
                    </select>
                  </div>

                  {getRound()?.ruleset === 'number' ? (
                    <div className="mt-4 space-y-2">
                      <label className="block text-sm font-medium text-gray-700">Points (exact match)</label>
                      <input
                        type="number"
                        value={String(getRound()?.pointsExactMatch ?? 3)}
                        onChange={(e) =>
                          void setRoundScoring({
                            pointsExactMatch: (() => {
                              const n = Number(e.target.value);
                              return Number.isFinite(n) ? n : 3;
                            })(),
                          })
                        }
                        className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                        disabled={isDbBusy}
                      />

                      <label className="block text-sm font-medium text-gray-700">
                        Points (closest without exact match)
                      </label>
                      <input
                        type="number"
                        value={String(getRound()?.pointsClosestWithoutExactMatch ?? 1)}
                        onChange={(e) =>
                          void setRoundScoring({
                            pointsClosestWithoutExactMatch: (() => {
                              const n = Number(e.target.value);
                              return Number.isFinite(n) ? n : 1;
                            })(),
                          })
                        }
                        className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                        disabled={isDbBusy}
                      />
                    </div>
                  ) : (
                    <div className="mt-4 space-y-2">
                      <label className="block text-sm font-medium text-gray-700">Points per correct answer</label>
                      <input
                        type="number"
                        value={String(getRound()?.pointsPerCorrectAnswer ?? 1)}
                        onChange={(e) =>
                          void setRoundScoring({
                            pointsPerCorrectAnswer: (() => {
                              const n = Number(e.target.value);
                              return Number.isFinite(n) ? n : 1;
                            })(),
                          })
                        }
                        className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                        disabled={isDbBusy}
                      />
                    </div>
                  )}

                  <div className="mt-6 space-y-3">
                    <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={(e) => void reorderQuestions(e)}>
                      <SortableContext
                        items={(getRound()?.questions ?? []).map((q) => `question-${q.number}`)}
                        strategy={verticalListSortingStrategy}
                      >
                        {(getRound()?.questions ?? []).map((q) => (
                          <SortableRow key={q.number} id={`question-${q.number}`} disabled={isDbBusy}>
                            {({ attributes, listeners }) => (
                              <div className="flex items-stretch gap-2">
                                <button
                                  type="button"
                                  {...attributes}
                                  {...listeners}
                                  className="shrink-0 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 cursor-grab active:cursor-grabbing"
                                  disabled={isDbBusy}
                                >
                                  Drag
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openQuestion(q.number)}
                                  className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left hover:bg-gray-50"
                                  disabled={isDbBusy}
                                >
                                  <div className="text-sm font-medium text-gray-900">Question {q.number}</div>
                                  <div className="mt-1 text-xs text-gray-500">{(q.text ?? '').trim() || '(empty)'}</div>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void deleteQuestion(q.number)}
                                  className="shrink-0 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                  disabled={isDbBusy}
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </SortableRow>
                        ))}
                      </SortableContext>
                    </DndContext>

                    <button
                      type="button"
                      onClick={() => void addNewQuestion()}
                      className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left hover:bg-gray-50"
                      disabled={isDbBusy}
                    >
                      <div className="text-sm font-medium text-gray-900">+ add new question</div>
                    </button>
                  </div>
                </>
              ) : null}

              {manageView === 'question' && activeQuiz && activeRoundNumber != null && activeQuestionNumber != null ? (
                <>
                  <h2 className="text-lg font-semibold">Round {activeRoundNumber} · Question {activeQuestionNumber}</h2>

                  <div className="mt-4 space-y-2">
                    <label className="block text-sm font-medium text-gray-700">Question text</label>
                    <textarea
                      value={questionDraft?.text ?? ''}
                      onChange={(e) =>
                        setQuestionDraft((d) =>
                          d
                            ? { ...d, text: e.target.value }
                            : {
                                text: e.target.value,
                                correctAnswer: '',
                                correctAnswerBg: '',
                                correctAnswerEn: '',
                                options: ['', '', '', ''],
                                correctChoice: '',
                              },
                        )
                      }
                      className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                      rows={4}
                      disabled={isDbBusy}
                    />
                  </div>

                  {getRound()?.ruleset === 'number' ? (
                    <div className="mt-4 space-y-2">
                      <label className="block text-sm font-medium text-gray-700">Correct answer</label>
                      <input
                        type="number"
                        value={String(questionDraft?.correctAnswer ?? '')}
                        onChange={(e) => setQuestionDraft((d) => (d ? { ...d, correctAnswer: e.target.value } : d))}
                        className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                        disabled={isDbBusy}
                      />
                    </div>
                  ) : null}

                  {getRound()?.ruleset === 'free-text' ? (
                    <div className="mt-4 space-y-2">
                      <label className="block text-sm font-medium text-gray-700">Correct answer (BG)</label>
                      <input
                        value={String(questionDraft?.correctAnswerBg ?? '')}
                        onChange={(e) =>
                          setQuestionDraft((d) => (d ? { ...d, correctAnswerBg: e.target.value } : d))
                        }
                        className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                        disabled={isDbBusy}
                      />

                      <label className="block text-sm font-medium text-gray-700">Correct answer (EN)</label>
                      <input
                        value={String(questionDraft?.correctAnswerEn ?? '')}
                        onChange={(e) =>
                          setQuestionDraft((d) => (d ? { ...d, correctAnswerEn: e.target.value } : d))
                        }
                        className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                        disabled={isDbBusy}
                      />
                    </div>
                  ) : null}

                    {getRound()?.ruleset === 'multiple-choice' ? (
                    <>
                      <div className="mt-4 space-y-2">
                        <label className="block text-sm font-medium text-gray-700">Choices</label>
                        {(['A', 'B', 'C', 'D'] as const).map((label, idx) => (
                          <div key={label} className="flex items-center gap-2">
                            <div className="w-6 text-sm font-medium text-gray-700">{label}</div>
                            <input
                              value={questionDraft?.options?.[idx] ?? ''}
                              onChange={(e) =>
                                setQuestionDraft((d) => {
                                  if (!d) return d;
                                  const next = d.options.slice();
                                  next[idx] = e.target.value;
                                  return { ...d, options: next };
                                })
                              }
                              className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                              disabled={isDbBusy}
                            />
                          </div>
                        ))}
                      </div>

                      <div className="mt-4 space-y-2">
                        <label className="block text-sm font-medium text-gray-700">Correct answer</label>
                        <select
                          value={questionDraft?.correctChoice ?? ''}
                          onChange={(e) =>
                            setQuestionDraft((d) =>
                              d ? { ...d, correctChoice: e.target.value as 'A' | 'B' | 'C' | 'D' | '' } : d,
                            )
                          }
                          className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                          disabled={isDbBusy}
                        >
                          <option value="">Select…</option>
                          <option value="A">A</option>
                          <option value="B">B</option>
                          <option value="C">C</option>
                          <option value="D">D</option>
                        </select>
                      </div>
                    </>
                  ) : null}

                  <button
                    type="button"
                    onClick={async () => {
                      await persistQuestionDraft();
                      setManageView('round');
                    }}
                    className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isDbBusy}
                  >
                    {isDbBusy ? 'Saving…' : 'Save'}
                  </button>
                </>
              ) : null}
            </>
          ) : activeTab === 'teams' ? (
            <>
              {teamsView !== 'quizList' ? (
                <div className="mb-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTeamsQuiz(null);
                      setTeamsView('quizList');
                    }}
                    className="inline-flex items-center rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    disabled={isDbBusy}
                  >
                    Back
                  </button>
                </div>
              ) : null}

              {dbError ? (
                <div className="mb-4 rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-700">
                  {dbError}
                </div>
              ) : null}

              {teamsView === 'quizList' ? (
                <>
                  <h1 className="text-xl font-semibold">Teams</h1>
                  <div className="mt-6 space-y-3">
                    {quizList.map((q) => {
                      const title = (q.title ?? '').trim() || '(untitled quiz)';
                      const roundsCount = Array.isArray(q.data?.rounds) ? q.data.rounds.length : 0;
                      return (
                        <button
                          key={q.id}
                          type="button"
                          onClick={async () => {
                            setIsDbBusy(true);
                            setDbError(null);
                            try {
                              const quiz = await fetchQuiz(q.id);
                              setTeamsQuiz(quiz);
                              setTeamsView('teamsList');
                            } catch (e) {
                              setDbError(e instanceof Error ? e.message : 'Failed to load quiz.');
                            } finally {
                              setIsDbBusy(false);
                            }
                          }}
                          className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left hover:bg-gray-50"
                          disabled={isDbBusy}
                        >
                          <div className="text-sm font-medium text-gray-900">{title}</div>
                          <div className="mt-1 text-xs text-gray-500">{roundsCount} rounds</div>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}

              {teamsView === 'teamsList' && teamsQuiz ? (
                <>
                  <h1 className="text-xl font-semibold">
                    Teams · {(teamsQuiz.title ?? '').trim() || '(untitled quiz)'}
                  </h1>
                  <div className="mt-6 space-y-3">
                    {teamsQuiz.teams.map((name) => (
                      <div
                        key={name}
                        className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left"
                      >
                        <div className="text-sm font-medium text-gray-900">{name}</div>
                      </div>
                    ))}

                    <button
                      type="button"
                      onClick={async () => {
                        const raw = window.prompt('Team name');
                        if (!raw) return;
                        const name = raw.trim();
                        if (!name) return;

                        if (teamsQuiz.teams.includes(name)) return;

                        const updated: Quiz = {
                          ...teamsQuiz,
                          teams: [...teamsQuiz.teams, name],
                        };

                        setTeamsQuiz(updated);
                        try {
                          await saveQuizToDb(updated);
                        } catch {
                          // saveQuizToDb already sets dbError.
                        }
                      }}
                      className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left hover:bg-gray-50"
                      disabled={isDbBusy}
                    >
                      <div className="text-sm font-medium text-gray-900">+ add new team</div>
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">Score</h1>

              {dbError ? (
                <div className="mt-4 rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-700">
                  {dbError}
                </div>
              ) : null}

              <div className="mt-6 space-y-4">
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">Quiz</label>
                  <select
                    value={scoreSelectedQuizId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setScoreSelectedQuizId(id);
                      setScoreScope('all');
                      setScoreResults([]);
                      setScoreQuiz(null);
                      if (!id) return;
                      void refreshScoreboard(id, 'all');
                    }}
                    className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                    disabled={isDbBusy}
                  >
                    <option value="">Select…</option>
                    {quizList.map((q) => (
                      <option key={q.id} value={q.id}>
                        {(q.title ?? '').trim() || '(untitled quiz)'}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">Scope</label>
                  <select
                    value={scoreScope === 'all' ? 'all' : String(scoreScope)}
                    onChange={(e) => {
                      if (!scoreSelectedQuizId) return;
                      const v = e.target.value;
                      const scope: RoundScope = v === 'all' ? 'all' : Number(v);
                      setScoreScope(scope);
                      void refreshScoreboard(scoreSelectedQuizId, scope);
                    }}
                    className="block w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
                    disabled={isDbBusy || !scoreSelectedQuizId}
                  >
                    <option value="all">Whole quiz</option>
                    {(scoreQuiz?.rounds ?? [])
                      .slice()
                      .sort((a, b) => a.roundNumber - b.roundNumber)
                      .map((r) => (
                        <option key={r.roundNumber} value={r.roundNumber}>
                          Round {r.roundNumber}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="mt-2 space-y-3">
                  {scoreResults.map((row) => (
                    <div
                      key={row.teamName}
                      className="block w-full rounded-md border border-gray-200 bg-white p-4 text-left"
                    >
                      <div className="text-sm font-medium text-gray-900">{row.teamName}</div>
                      <div className="mt-1 text-xs text-gray-500">{row.points} points</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
