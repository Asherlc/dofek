/**
 * Breathwork technique definitions and session helpers.
 *
 * Each technique defines the breathing pattern (inhale/hold/exhale/hold durations)
 * and default number of rounds.
 */

export interface BreathworkTechnique {
  id: string;
  name: string;
  description: string;
  /** Inhale duration in seconds */
  inhaleSeconds: number;
  /** Hold after inhale in seconds (optional) */
  holdInSeconds?: number;
  /** Exhale duration in seconds */
  exhaleSeconds: number;
  /** Hold after exhale in seconds (optional) */
  holdOutSeconds?: number;
  /** Default number of rounds */
  defaultRounds: number;
}

export const TECHNIQUES: BreathworkTechnique[] = [
  {
    id: "box-breathing",
    name: "Box Breathing",
    description:
      "Equal parts inhale, hold, exhale, hold. Used by Navy SEALs to reduce stress and improve focus.",
    inhaleSeconds: 4,
    holdInSeconds: 4,
    exhaleSeconds: 4,
    holdOutSeconds: 4,
    defaultRounds: 4,
  },
  {
    id: "4-7-8",
    name: "4-7-8 Breathing",
    description:
      "Relaxing breath technique. Inhale 4s, hold 7s, exhale 8s. Promotes deep relaxation and sleep.",
    inhaleSeconds: 4,
    holdInSeconds: 7,
    exhaleSeconds: 8,
    defaultRounds: 4,
  },
  {
    id: "coherent",
    name: "Coherent Breathing",
    description:
      "Slow, rhythmic breathing at 5 breaths per minute. Balances the autonomic nervous system and optimizes HRV.",
    inhaleSeconds: 6,
    exhaleSeconds: 6,
    defaultRounds: 10,
  },
  {
    id: "physiological-sigh",
    name: "Physiological Sigh",
    description:
      "Double inhale through the nose followed by a long exhale. Rapidly reduces stress and anxiety.",
    inhaleSeconds: 3,
    holdInSeconds: 1,
    exhaleSeconds: 6,
    defaultRounds: 5,
  },
  {
    id: "wim-hof",
    name: "Wim Hof Method",
    description:
      "Power breathing with deep inhales and passive exhales. Increases energy, focus, and cold tolerance.",
    inhaleSeconds: 2,
    exhaleSeconds: 2,
    defaultRounds: 30,
  },
];

/** Look up a technique by its ID */
export function getTechniqueById(id: string): BreathworkTechnique | undefined {
  return TECHNIQUES.find((t) => t.id === id);
}

/** Compute total session duration in seconds for a given number of rounds */
export function totalSessionSeconds(technique: BreathworkTechnique, rounds: number): number {
  const roundSeconds =
    technique.inhaleSeconds +
    (technique.holdInSeconds ?? 0) +
    technique.exhaleSeconds +
    (technique.holdOutSeconds ?? 0);
  return roundSeconds * rounds;
}
