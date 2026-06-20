// Prompt safety guard backed by NVIDIA NeMoGuard JailbreakDetect.
//
// Endpoint accepts {"input": "<user prompt>"} and returns
//   { "jailbreak": boolean, "score": number }   (score in roughly [-1, 1])
// We treat jailbreak=true as a block. A lightweight local heuristic runs first so
// we never burn an inference call on obviously fine prompts, and so the guard
// still "fails safe-ish" if the classifier endpoint is unavailable.

import type { Env } from '../types';
import { GUARD_MODEL, keyForModel } from '../config/models';

export interface GuardResult {
  blocked: boolean;
  score: number;
  reason: string;
  source: 'heuristic' | 'nemoguard' | 'unavailable';
}

// Obvious exploit/override phrasing. Not the primary defense — just a cheap prefilter.
const RED_FLAGS = [
  /ignore (all|any|previous|prior) (instructions|rules|prompts)/i,
  /disregard (the )?(system|previous) (prompt|message|instructions)/i,
  /you are (now )?(dan|do anything now|developer mode|jailbroken)/i,
  /(reveal|print|show|repeat).{0,30}(system prompt|instructions|hidden rules)/i,
  /\bDAN\b.{0,20}\bmode\b/i,
  /pretend (you|to be).{0,40}(no (rules|restrictions|filter))/i,
  /bypass.{0,20}(safety|guardrails|content policy|restrictions)/i,
];

export async function checkPrompt(env: Env, prompt: string): Promise<GuardResult> {
  // 1) Cheap local prefilter.
  for (const re of RED_FLAGS) {
    if (re.test(prompt)) {
      return { blocked: true, score: 1, reason: 'Prompt matches a known jailbreak pattern.', source: 'heuristic' };
    }
  }

  // 2) NVIDIA NeMoGuard classifier.
  try {
    const res = await fetch(env.NVIDIA_JAILBREAK_URL, {
      method: 'POST',
      headers: {
        // Guard is its own API too (NEMOGUARD_API_KEY / model-id name / NVIDIA_API_KEY).
        authorization: `Bearer ${keyForModel(env, GUARD_MODEL)}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ input: prompt }),
    });
    if (!res.ok) {
      // Don't hard-fail the whole app if the guard endpoint hiccups; the heuristic
      // already passed, so allow but mark it as unverified.
      return { blocked: false, score: 0, reason: 'Guard endpoint unavailable; passed prefilter.', source: 'unavailable' };
    }
    const data: any = await res.json();
    const jailbreak = data?.jailbreak === true;
    const score = typeof data?.score === 'number' ? data.score : 0;
    return {
      blocked: jailbreak,
      score,
      reason: jailbreak ? 'The safety guard flagged this prompt as a possible jailbreak attempt.' : 'Clean.',
      source: 'nemoguard',
    };
  } catch {
    return { blocked: false, score: 0, reason: 'Guard endpoint error; passed prefilter.', source: 'unavailable' };
  }
}
