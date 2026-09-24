import { useEffect, useState } from "react";

type WaveCable = {
  id: string;
  label: string;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  amplitude: number;
  waves: number;
  delay: string;
  duration: string;
  labelX: number;
  labelY: number;
};

const INBOUND_SOURCES: readonly WaveCable[] = [
  {
    id: "sleep",
    label: "Sleep",
    startX: 80,
    startY: 120,
    endX: 520,
    endY: 320,
    amplitude: 48,
    waves: 2.6,
    delay: "0s",
    duration: "4.2s",
    labelX: 16,
    labelY: 116,
  },
  {
    id: "heart-rate",
    label: "Heart rate",
    startX: 60,
    startY: 240,
    endX: 520,
    endY: 320,
    amplitude: 38,
    waves: 3.1,
    delay: "0.35s",
    duration: "3.6s",
    labelX: 8,
    labelY: 236,
  },
  {
    id: "training",
    label: "Training",
    startX: 70,
    startY: 380,
    endX: 520,
    endY: 320,
    amplitude: 44,
    waves: 2.7,
    delay: "0.7s",
    duration: "4.8s",
    labelX: 12,
    labelY: 376,
  },
  {
    id: "nutrition",
    label: "Nutrition",
    startX: 90,
    startY: 500,
    endX: 520,
    endY: 320,
    amplitude: 52,
    waves: 2.4,
    delay: "1.05s",
    duration: "5.1s",
    labelX: 16,
    labelY: 496,
  },
] as const;

const OUTBOUND_INSIGHTS: readonly WaveCable[] = [
  {
    id: "trends",
    label: "Trends",
    startX: 680,
    startY: 320,
    endX: 1120,
    endY: 140,
    amplitude: 44,
    waves: 2.5,
    delay: "0.2s",
    duration: "4s",
    labelX: 1040,
    labelY: 128,
  },
  {
    id: "correlations",
    label: "Correlations",
    startX: 680,
    startY: 320,
    endX: 1130,
    endY: 340,
    amplitude: 36,
    waves: 3,
    delay: "0.55s",
    duration: "3.8s",
    labelX: 1030,
    labelY: 336,
  },
  {
    id: "history",
    label: "History",
    startX: 680,
    startY: 320,
    endX: 1120,
    endY: 500,
    amplitude: 48,
    waves: 2.6,
    delay: "0.9s",
    duration: "4.6s",
    labelX: 1040,
    labelY: 496,
  },
] as const;

/** Build a tapered sine wave along a straight run, phase shifts the undulation. */
function buildWavyPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  amplitude: number,
  waves: number,
  phase: number,
): string {
  const segmentCount = Math.max(24, Math.round(waves * 16));
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const length = Math.hypot(deltaX, deltaY) || 1;
  const normalX = -deltaY / length;
  const normalY = deltaX / length;

  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const progress = index / segmentCount;
    const baseX = startX + deltaX * progress;
    const baseY = startY + deltaY * progress;
    const envelope = Math.sin(progress * Math.PI);
    const offset = Math.sin(progress * waves * Math.PI * 2 + phase) * amplitude * envelope;
    points.push({
      x: baseX + normalX * offset,
      y: baseY + normalY * offset,
    });
  }

  const firstPoint = points[0];
  if (firstPoint == null) {
    throw new Error("Wavy path requires at least one point");
  }

  let path = `M ${firstPoint.x.toFixed(2)} ${firstPoint.y.toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    if (current == null) {
      continue;
    }
    path += ` L ${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
  }
  return path;
}

function wavePhases(cable: WaveCable): { rest: string; crest: string; trough: string } {
  return {
    rest: buildWavyPath(
      cable.startX,
      cable.startY,
      cable.endX,
      cable.endY,
      cable.amplitude,
      cable.waves,
      0,
    ),
    crest: buildWavyPath(
      cable.startX,
      cable.startY,
      cable.endX,
      cable.endY,
      cable.amplitude,
      cable.waves,
      Math.PI / 2,
    ),
    trough: buildWavyPath(
      cable.startX,
      cable.startY,
      cable.endX,
      cable.endY,
      cable.amplitude,
      cable.waves,
      Math.PI,
    ),
  };
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => {
      setPrefersReducedMotion(mediaQuery.matches);
    };
    updatePreference();
    mediaQuery.addEventListener("change", updatePreference);
    return () => {
      mediaQuery.removeEventListener("change", updatePreference);
    };
  }, []);

  return prefersReducedMotion;
}

function WaveCableGroup({
  cable,
  direction,
  prefersReducedMotion,
}: {
  cable: WaveCable;
  direction: "in" | "out";
  prefersReducedMotion: boolean;
}) {
  const phases = wavePhases(cable);
  const strokeGradient = direction === "in" ? "url(#neural-path-in)" : "url(#neural-path-out)";
  const dashColor = direction === "in" ? "var(--color-accent)" : "var(--color-accent-secondary)";
  const packetColor = dashColor;
  const undulateValues = `${phases.rest};${phases.crest};${phases.trough};${phases.rest}`;

  return (
    <g>
      <path
        className="neural-wave"
        d={phases.rest}
        fill="none"
        stroke={strokeGradient}
        strokeWidth="1.75"
        strokeLinecap="round"
      >
        {prefersReducedMotion ? null : (
          <animate
            attributeName="d"
            values={undulateValues}
            dur={cable.duration}
            begin={cable.delay}
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes="0;0.33;0.66;1"
            keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1"
          />
        )}
      </path>
      <path
        className={
          direction === "out" ? "neural-flow-dash neural-flow-dash-out" : "neural-flow-dash"
        }
        d={phases.rest}
        fill="none"
        stroke={dashColor}
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeDasharray="5 14"
        style={{ animationDelay: cable.delay }}
      >
        {prefersReducedMotion ? null : (
          <animate
            attributeName="d"
            values={undulateValues}
            dur={cable.duration}
            begin={cable.delay}
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes="0;0.33;0.66;1"
            keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1"
          />
        )}
      </path>
      {prefersReducedMotion ? null : (
        <circle
          className="neural-packet"
          r="3.5"
          fill={packetColor}
          filter="url(#neural-soft-glow)"
        >
          <animateMotion
            dur="3.4s"
            repeatCount="indefinite"
            begin={cable.delay}
            path={phases.rest}
          />
        </circle>
      )}
      <text x={cable.labelX} y={cable.labelY} className="neural-label" fill="var(--color-muted)">
        {cable.label}
      </text>
    </g>
  );
}

export function NeuralDataFlow() {
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <svg
      className="neural-data-flow h-full w-full"
      viewBox="0 0 1200 640"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Health sources flow into Dofek and insights flow out"
    >
      <defs>
        <radialGradient id="neural-core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.55" />
          <stop offset="55%" stopColor="var(--color-accent)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="neural-path-in" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.12" />
          <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id="neural-path-out" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="var(--color-accent-secondary)" stopOpacity="0.7" />
          <stop offset="100%" stopColor="var(--color-accent-secondary)" stopOpacity="0.12" />
        </linearGradient>
        <filter id="neural-soft-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <circle
        className="neural-core-halo"
        cx="600"
        cy="320"
        r="150"
        fill="url(#neural-core-glow)"
      />

      {INBOUND_SOURCES.map((source) => (
        <WaveCableGroup
          key={source.id}
          cable={source}
          direction="in"
          prefersReducedMotion={prefersReducedMotion}
        />
      ))}

      {OUTBOUND_INSIGHTS.map((insight) => (
        <WaveCableGroup
          key={insight.id}
          cable={insight}
          direction="out"
          prefersReducedMotion={prefersReducedMotion}
        />
      ))}

      <g transform="translate(600 320)">
        <g className="neural-core">
          <circle
            r="54"
            fill="var(--color-surface-solid)"
            stroke="var(--color-border-strong)"
            strokeWidth="1.5"
          />
          <circle
            className="neural-core-ring"
            r="72"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1.25"
            strokeOpacity="0.45"
          />
          <circle
            className="neural-core-ring neural-core-ring-delayed"
            r="92"
            fill="none"
            stroke="var(--color-accent-secondary)"
            strokeWidth="1"
            strokeOpacity="0.28"
          />
          <image href="/icon.svg" x="-22" y="-22" width="44" height="44" />
          <text y="78" textAnchor="middle" className="neural-brand" fill="var(--color-foreground)">
            Dofek
          </text>
        </g>
      </g>
    </svg>
  );
}
