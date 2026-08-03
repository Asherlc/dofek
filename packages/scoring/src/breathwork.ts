/**
 * Breathwork technique definitions and session helpers.
 *
 * Each technique defines the breathing pattern (inhale/hold/exhale/hold durations)
 * and default number of rounds.
 */

export interface BreathworkTechnique {
  id: string;
  name: string;
  /** Concise user-facing reason to choose this practice */
  purpose: string;
  description: string;
  /** User-facing difficulty label */
  difficulty: BreathworkDifficulty;
  /** Possible benefit supported by technique-specific evidence, never a guarantee */
  possibleBenefit?: string;
  /** Material guidance that clients must show before a session starts */
  safety: BreathworkSafetyGuidance;
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

export const BREATHWORK_DIFFICULTIES = ["Beginner", "Intermediate", "Advanced"] as const;
export type BreathworkDifficulty = (typeof BREATHWORK_DIFFICULTIES)[number];

export interface BreathworkTechniqueDetails extends BreathworkTechnique {
  /** Server-computed duration for the default session */
  durationSeconds: number;
}

export interface BreathworkSafetyGuidance {
  position: string;
  warnings: string[];
  stopCriteria: string;
  emergency: string;
}

export const PERCEIVED_BREATHWORK_EFFECTS = ["better", "same", "worse"] as const;
export type PerceivedBreathworkEffect = (typeof PERCEIVED_BREATHWORK_EFFECTS)[number];

export interface BreathworkOutcomeReport {
  stressBefore: number | null;
  stressAfter: number | null;
  dizzinessAfter: boolean | null;
  perceivedEffect: PerceivedBreathworkEffect | null;
}

/**
 * Safety wording follows NHS breathing/fainting guidance:
 * https://www.asph.nhs.uk/nervous-system-regulation
 * https://www.nhs.uk/symptoms/fainting/
 */
const STANDARD_SAFETY: BreathworkSafetyGuidance = {
  position: "Practice seated or lying down in a comfortable, safe place.",
  warnings: ["Do not force or strain your breath."],
  stopCriteria: "Stop and return to normal breathing if you feel dizzy or lightheaded.",
  emergency:
    "Call emergency services if someone faints and is not breathing, cannot be woken within 1 minute, or has not fully recovered.",
};

/**
 * Safety guidance for intense breathing rounds:
 * https://www.wimhofmethod.com/breathing-exercises
 */
const POWER_BREATHING_SAFETY: BreathworkSafetyGuidance = {
  position: "Practice only while seated or lying down in a safe place.",
  warnings: [
    "Intense rounds can, in rare cases, cause loss of consciousness.",
    "Never practice in or near water, while driving, or anywhere fainting could cause injury.",
  ],
  stopCriteria: STANDARD_SAFETY.stopCriteria,
  emergency: STANDARD_SAFETY.emergency,
};

export const TECHNIQUES: BreathworkTechnique[] = [
  {
    id: "box-breathing",
    name: "Box Breathing",
    purpose: "Calm focus",
    description:
      "Breathe in for 4 seconds, hold for 4 seconds, breathe out for 4 seconds, then hold for 4 seconds.",
    difficulty: "Beginner",
    // RCT evidence: https://doi.org/10.1016/j.xcrm.2022.100895
    possibleBenefit: "Regular practice may support a more positive mood.",
    safety: STANDARD_SAFETY,
    inhaleSeconds: 4,
    holdInSeconds: 4,
    exhaleSeconds: 4,
    holdOutSeconds: 4,
    defaultRounds: 4,
  },
  {
    id: "4-7-8",
    name: "4-7-8 Breathing",
    purpose: "Wind down",
    description:
      "Breathe in for 4 seconds, hold for 7 seconds, then breathe out slowly for 8 seconds.",
    difficulty: "Intermediate",
    safety: STANDARD_SAFETY,
    inhaleSeconds: 4,
    holdInSeconds: 7,
    exhaleSeconds: 8,
    defaultRounds: 4,
  },
  {
    id: "coherent",
    name: "Coherent Breathing",
    purpose: "Steady calm",
    description:
      "Breathe in for 6 seconds and out for 6 seconds, creating an even rhythm of about 5 breaths per minute.",
    difficulty: "Beginner",
    safety: STANDARD_SAFETY,
    inhaleSeconds: 6,
    exhaleSeconds: 6,
    defaultRounds: 10,
  },
  {
    id: "physiological-sigh",
    name: "Physiological Sigh",
    purpose: "Quick reset",
    description: "Take two small inhales through the nose, followed by one longer exhale.",
    difficulty: "Beginner",
    // RCT evidence: https://doi.org/10.1016/j.xcrm.2022.100895
    possibleBenefit:
      "Regular practice may support a more positive mood and slower resting breathing.",
    safety: STANDARD_SAFETY,
    inhaleSeconds: 3,
    holdInSeconds: 1,
    exhaleSeconds: 6,
    defaultRounds: 5,
  },
  {
    id: "wim-hof",
    name: "Power Breathing",
    purpose: "Energizing practice",
    description: "Take 30 rounds of active 2-second inhales followed by 2-second exhales.",
    difficulty: "Advanced",
    safety: POWER_BREATHING_SAFETY,
    inhaleSeconds: 2,
    exhaleSeconds: 2,
    defaultRounds: 30,
  },
];

/** Look up a technique by its ID */
export function getTechniqueById(id: string): BreathworkTechnique | undefined {
  return TECHNIQUES.find((t) => t.id === id);
}

const LEGACY_TECHNIQUE_LABELS: Record<string, string> = {
  resonance: "Resonant Breathing",
};

/** Return a human-readable label without exposing a stored technique identifier. */
export function getBreathworkTechniqueLabel(techniqueId: string): string {
  return (
    getTechniqueById(techniqueId)?.name ??
    LEGACY_TECHNIQUE_LABELS[techniqueId] ??
    "Breathwork session"
  );
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

/** Add the server-owned default-session duration to a technique definition. */
export function toBreathworkTechniqueDetails(
  technique: BreathworkTechnique,
): BreathworkTechniqueDetails {
  return {
    ...technique,
    durationSeconds: totalSessionSeconds(technique, technique.defaultRounds),
  };
}
