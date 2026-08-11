import {
  type BoulderGradeSystem,
  type ClimbingGradePreference,
  DEFAULT_CLIMBING_GRADE_PREFERENCE,
  gradeSystemLabel,
  type RouteGradeSystem,
} from "@dofek/training/climbing-grades";
import { useEffect, useRef, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

const SETTINGS_KEY = "climbingGradeSystems";
const BOULDER_SYSTEMS: BoulderGradeSystem[] = ["v_scale", "font"];
const ROUTE_SYSTEMS: RouteGradeSystem[] = [
  "yds",
  "french",
  "uiaa",
  "ewbank",
  "saxon",
  "norwegian",
  "brazilian_crux",
];

function preferenceFrom(value: unknown): ClimbingGradePreference {
  if (
    typeof value === "object" &&
    value !== null &&
    "boulder" in value &&
    "route" in value &&
    (value.boulder === "v_scale" || value.boulder === "font") &&
    (value.route === "yds" ||
      value.route === "french" ||
      value.route === "uiaa" ||
      value.route === "ewbank" ||
      value.route === "saxon" ||
      value.route === "norwegian" ||
      value.route === "brazilian_crux")
  ) {
    return { boulder: value.boulder, route: value.route };
  }
  return DEFAULT_CLIMBING_GRADE_PREFERENCE;
}

export function ClimbingGradeSystemToggle() {
  const setting = trpc.settings.get.useQuery({ key: SETTINGS_KEY });
  const mutation = trpc.settings.set.useMutation();
  const utils = trpc.useUtils();
  const lastError = useRef<unknown>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const preference = preferenceFrom(setting.data?.value);

  useEffect(() => {
    if (setting.error && lastError.current !== setting.error) {
      lastError.current = setting.error;
      captureException(setting.error, { context: "climbing-grade-systems-read" });
    }
  }, [setting.error]);

  function setPreference(next: ClimbingGradePreference): void {
    const previous = utils.settings.get.getData({ key: SETTINGS_KEY });
    utils.settings.get.setData({ key: SETTINGS_KEY }, { key: SETTINGS_KEY, value: next });
    setWriteError(null);
    mutation.mutate(
      { key: SETTINGS_KEY, value: next },
      {
        onError: (error) => {
          utils.settings.get.setData({ key: SETTINGS_KEY }, previous);
          setWriteError(error.message);
          captureException(error, { context: "climbing-grade-systems-write" });
        },
        onSettled: () => void utils.settings.get.invalidate({ key: SETTINGS_KEY }),
      },
    );
  }

  return (
    <div className="space-y-4">
      <GradeSystemSelect
        label="Boulder grades"
        onChange={(boulder) => setPreference({ ...preference, boulder })}
        options={BOULDER_SYSTEMS}
        value={preference.boulder}
      />
      <GradeSystemSelect
        label="Route grades"
        onChange={(route) => setPreference({ ...preference, route })}
        options={ROUTE_SYSTEMS}
        value={preference.route}
      />
      {(writeError ?? setting.error?.message) ? (
        <p className="text-sm text-red-400" role="alert">
          {writeError ?? setting.error?.message}
        </p>
      ) : null}
    </div>
  );
}

function GradeSystemSelect<T extends BoulderGradeSystem | RouteGradeSystem>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: T) => void;
  options: T[];
  value: T;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="text-muted">{label}</span>
      <select
        className="input w-full"
        onChange={(event) => {
          const next = options.find((option) => option === event.target.value);
          if (next) onChange(next);
        }}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {gradeSystemLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}
