#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const QUOTAS = {
  "single-session-user": 14,
  "single-session-assistant": 11,
  "single-session-preference": 6,
  "temporal-reasoning": 27,
  "knowledge-update": 16,
  "multi-session": 26
};

const CATEGORY_BY_SOURCE_TYPE = {
  single_hop: "single-session-user",
  assistant_previnfo: "single-session-assistant",
  implicit_preference: "single-session-preference",
  implicit_preference_v2: "single-session-preference",
  temp_reasoning_implicit: "temporal-reasoning",
  temp_reasoning_explicit: "temporal-reasoning",
  knowledge_update: "knowledge-update",
  two_hop: "multi-session",
  multi_session_synthesis: "multi-session"
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const options = {
    questions: null,
    publicQuestions: null,
    sessionCache: null,
    fillerSessions: null,
    output: null,
    manifest: null,
    seed: "orgbrain-longmemeval-unseen-v2",
    fillers: 80
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`${value} requires a value`);
      return argv[index];
    };
    if (value === "--questions") options.questions = next();
    else if (value === "--public-questions") options.publicQuestions = next();
    else if (value === "--session-cache") options.sessionCache = next();
    else if (value === "--filler-sessions") options.fillerSessions = next();
    else if (value === "--output") options.output = next();
    else if (value === "--manifest") options.manifest = next();
    else if (value === "--seed") options.seed = next();
    else if (value === "--fillers") options.fillers = Number(next());
    else throw new Error(`unknown argument: ${value}`);
  }
  for (const key of ["questions", "publicQuestions", "sessionCache", "fillerSessions", "output", "manifest"]) {
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!Number.isInteger(options.fillers) || options.fillers < 1) throw new Error("--fillers must be >= 1");
  return options;
}

function cleanSession(session) {
  return (Array.isArray(session) ? session : []).map((message) => ({
    role: String(message.role ?? "unknown"),
    content: String(message.content ?? "")
  }));
}

function evidenceFor(question, sessionIndex, fillerIndex) {
  const neutral = (question.sessions ?? []).find((session) => session.style === "neutral")
    ?? question.sessions?.[0];
  if (!neutral) return [];
  if (question.question_type === "assistant_previnfo") {
    const source = fillerIndex.get(neutral.session_id);
    return source ? [{ source_id: `answer_${source.session_id}`, session: cleanSession(source.session) }] : [];
  }
  const source = sessionIndex.get(neutral.session_id);
  if (!source) return [];
  if (question.question_type === "two_hop") {
    return [
      { source_id: `answer_${source.session_id}_1`, session: cleanSession(source.session_1) },
      { source_id: `answer_${source.session_id}_2`, session: cleanSession(source.session_2) }
    ];
  }
  if (question.question_type === "knowledge_update") {
    return [
      {
        source_id: `answer_${source.session_id}_1`,
        session: cleanSession(source.session_old ?? source.old_session ?? source.session_1)
      },
      {
        source_id: `answer_${source.session_id}_2`,
        session: cleanSession(source.session_new ?? source.new_session ?? source.session_2)
      }
    ];
  }
  if (Array.isArray(source.sessions)) {
    return source.sessions.map((session, index) => ({
      source_id: `answer_${source.session_id}_${index + 1}`,
      session: cleanSession(session)
    }));
  }
  return [{ source_id: `answer_${source.session_id}`, session: cleanSession(source.session) }];
}

function flattenUserFillers(sessionCache) {
  const output = [];
  for (const source of sessionCache) {
    const variants = [];
    if (Array.isArray(source.session)) variants.push(source.session);
    if (Array.isArray(source.sessions)) variants.push(...source.sessions);
    for (const key of ["session_1", "session_2", "session_old", "session_new", "old_session", "new_session"]) {
      if (Array.isArray(source[key])) variants.push(source[key]);
    }
    for (const [index, session] of variants.entries()) {
      output.push({
        source_id: `filler_user_${source.session_id}_${index + 1}`,
        session: cleanSession(session)
      });
    }
  }
  return output;
}

function deterministicPick(pool, count, key) {
  if (pool.length < count) throw new Error(`filler pool has ${pool.length} entries; ${count} required`);
  const start = Number.parseInt(sha256(key).slice(0, 8), 16) % pool.length;
  const step = 1;
  const selected = [];
  const seen = new Set();
  let index = start;
  while (selected.length < count) {
    if (!seen.has(index)) {
      seen.add(index);
      selected.push(pool[index]);
    }
    index = (index + step) % pool.length;
    if (seen.size === pool.length && selected.length < count) {
      throw new Error("could not select enough unique filler sessions");
    }
  }
  return selected;
}

function dateFor(base, index) {
  const timestamp = Date.parse(`${String(base).replaceAll("/", "-")}T00:00:00Z`);
  const safe = Number.isFinite(timestamp) ? timestamp : Date.UTC(2023, 5, 1);
  return new Date(safe + index * 60_000).toISOString().replace("T", " ").slice(0, 16);
}

export function selectUnseenQuestions(questions, publicQuestionIds, eligible, seed, quotas = QUOTAS) {
  const selected = [];
  for (const [category, quota] of Object.entries(quotas)) {
    const candidates = questions
      .filter((question) =>
        CATEGORY_BY_SOURCE_TYPE[question.question_type] === category
        && !publicQuestionIds.has(String(question.question_id))
        && question.human_valid_label !== false
        && eligible(question)
      )
      .sort((left, right) =>
        Number(right.human_valid_label === true) - Number(left.human_valid_label === true)
        || sha256(`${seed}:${left.question_id}`).localeCompare(sha256(`${seed}:${right.question_id}`))
      );
    if (candidates.length < quota) {
      throw new Error(`${category} has ${candidates.length} eligible unseen questions; ${quota} required`);
    }
    selected.push(...candidates.slice(0, quota));
  }
  return selected.sort((left, right) => String(left.question_id).localeCompare(String(right.question_id)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [questionsRaw, publicRaw, sessionsRaw, fillersRaw] = await Promise.all([
    readFile(options.questions, "utf8"),
    readFile(options.publicQuestions, "utf8"),
    readFile(options.sessionCache, "utf8"),
    readFile(options.fillerSessions, "utf8")
  ]);
  const questions = JSON.parse(questionsRaw);
  const publicQuestions = JSON.parse(publicRaw);
  const sessionCache = JSON.parse(sessionsRaw);
  const fillerSessions = JSON.parse(fillersRaw);
  const sessionIndex = new Map(sessionCache.map((session) => [session.session_id, session]));
  const fillerIndex = new Map(fillerSessions.map((session) => [session.session_id, session]));
  const publicQuestionIds = new Set(publicQuestions.map((question) => String(question.question_id)));
  const eligible = (question) => evidenceFor(question, sessionIndex, fillerIndex)
    .every((entry) => entry.session.length > 0)
    && evidenceFor(question, sessionIndex, fillerIndex).length > 0;
  const selected = selectUnseenQuestions(
    questions,
    publicQuestionIds,
    eligible,
    options.seed
  );
  const userFillers = flattenUserFillers(sessionCache);
  const shareGptFillers = fillerSessions
    .filter((session) => String(session.session_id).includes("sharegpt"))
    .map((session) => ({ source_id: `filler_${session.session_id}`, session: cleanSession(session.session) }));
  const ultraChatFillers = fillerSessions
    .filter((session) => String(session.session_id).includes("ultrachat"))
    .map((session) => ({ source_id: `filler_${session.session_id}`, session: cleanSession(session.session) }));
  const rows = selected.map((question) => {
    const evidence = evidenceFor(question, sessionIndex, fillerIndex);
    const fillers = [
      ...deterministicPick(userFillers, Math.ceil(options.fillers * 0.5), `${options.seed}:${question.question_id}:user`),
      ...deterministicPick(shareGptFillers, Math.floor(options.fillers * 0.25), `${options.seed}:${question.question_id}:sharegpt`),
      ...deterministicPick(ultraChatFillers, Math.floor(options.fillers * 0.25), `${options.seed}:${question.question_id}:ultrachat`)
    ];
    const fillerOrder = [...fillers].sort((left, right) =>
      sha256(`${options.seed}:${question.question_id}:order:${left.source_id}`)
        .localeCompare(sha256(`${options.seed}:${question.question_id}:order:${right.source_id}`))
    );
    const ordered = question.question_type === "knowledge_update" && evidence.length === 2
      ? [
          ...fillerOrder.slice(0, Math.floor(fillerOrder.length / 3)),
          evidence[0],
          ...fillerOrder.slice(Math.floor(fillerOrder.length / 3), Math.floor(fillerOrder.length * 2 / 3)),
          evidence[1],
          ...fillerOrder.slice(Math.floor(fillerOrder.length * 2 / 3))
        ]
      : [...fillerOrder, ...evidence].sort((left, right) =>
          sha256(`${options.seed}:${question.question_id}:combined:${left.source_id}`)
            .localeCompare(sha256(`${options.seed}:${question.question_id}:combined:${right.source_id}`))
        );
    const baseDate = question.question_content?.unified_date
      ?? question.question_content?.question_date
      ?? "2023/06/01";
    const dates = ordered.map((_, index) => dateFor(baseDate, index));
    if (
      question.question_type === "temp_reasoning_implicit"
      && Array.isArray(question.question_content?.facts)
    ) {
      for (const [index, evidenceEntry] of evidence.entries()) {
        const position = ordered.findIndex((entry) => entry.source_id === evidenceEntry.source_id);
        const factDate = question.question_content.facts[index]?.date;
        if (position >= 0 && factDate) dates[position] = dateFor(factDate, 0);
      }
    }
    return {
      question_id: `unseen-${question.question_id}`,
      source_question_id: question.question_id,
      question_type: CATEGORY_BY_SOURCE_TYPE[question.question_type],
      source_question_type: question.question_type,
      question: question.question_content?.question,
      answer: question.question_content?.answer,
      question_date: dateFor(baseDate, ordered.length + 1),
      haystack_dates: dates,
      haystack_session_ids: ordered.map((entry) => entry.source_id),
      haystack_sessions: ordered.map((entry) => entry.session),
      answer_session_ids: evidence.map((entry) => entry.source_id)
    };
  });
  const outputRaw = `${JSON.stringify(rows, null, 2)}\n`;
  const selectedIds = selected.map((question) => String(question.question_id));
  const manifest = {
    benchmark: "LongMemEval custom-history unseen holdout",
    status: "sealed-before-evaluation",
    seed: options.seed,
    question_count: rows.length,
    filler_sessions_per_question: options.fillers,
    category_quotas: QUOTAS,
    public_question_overlap: selectedIds.filter((id) => publicQuestionIds.has(id)).length,
    source_human_validation: {
      validated_true: selected.filter((question) => question.human_valid_label === true).length,
      unreviewed: selected.filter((question) => question.human_valid_label == null).length,
      rejected_false: selected.filter((question) => question.human_valid_label === false).length
    },
    source: {
      repository: "https://github.com/xiaowu0162/LongMemEval",
      custom_history_questions_sha256: sha256(questionsRaw),
      public_500_questions_sha256: sha256(publicRaw),
      session_cache_sha256: sha256(sessionsRaw),
      filler_sessions_sha256: sha256(fillersRaw)
    },
    selected_question_ids_sha256: sha256(selectedIds.join("\n")),
    dataset_sha256: sha256(outputRaw)
  };
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(dirname(options.manifest), { recursive: true });
  await writeFile(options.output, outputRaw, { mode: 0o600 });
  await writeFile(options.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: options.output, manifest: options.manifest, ...manifest }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
