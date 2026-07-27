import {
  PRIMARY_GOAL_OPTIONS,
  PRIMARY_GOAL_SETTINGS_KEY,
  type PrimaryGoal,
  parsePrimaryGoal,
} from "@dofek/onboarding/primary-goal";
import { useEffect, useRef, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { trpc } from "../lib/trpc.ts";

export function PrimaryGoalSelector({ showHeading = true }: { showHeading?: boolean }) {
  const setting = trpc.settings.get.useQuery({ key: PRIMARY_GOAL_SETTINGS_KEY });
  const setSettingMutation = trpc.settings.set.useMutation();
  const trpcUtils = trpc.useUtils();
  const [writeError, setWriteError] = useState<string | null>(null);
  const lastReadError = useRef<unknown>(null);
  const currentGoal = parsePrimaryGoal(setting.data?.value);

  useEffect(() => {
    if (setting.error && lastReadError.current !== setting.error) {
      lastReadError.current = setting.error;
      captureException(setting.error, { context: "primary-goal-read" });
    }
  }, [setting.error]);

  const handleChange = (goal: PrimaryGoal) => {
    const previousSetting = trpcUtils.settings.get.getData({
      key: PRIMARY_GOAL_SETTINGS_KEY,
    });
    trpcUtils.settings.get.setData(
      { key: PRIMARY_GOAL_SETTINGS_KEY },
      { key: PRIMARY_GOAL_SETTINGS_KEY, value: goal },
    );
    setWriteError(null);
    setSettingMutation.mutate(
      { key: PRIMARY_GOAL_SETTINGS_KEY, value: goal },
      {
        onError: (error) => {
          trpcUtils.settings.get.setData({ key: PRIMARY_GOAL_SETTINGS_KEY }, previousSetting);
          setWriteError(error.message);
          captureException(error, { context: "primary-goal-write" });
        },
        onSettled: () => {
          void trpcUtils.settings.get.invalidate({ key: PRIMARY_GOAL_SETTINGS_KEY });
        },
      },
    );
  };

  return (
    <section
      className="space-y-3"
      aria-labelledby={showHeading ? "primary-goal-heading" : undefined}
    >
      {showHeading ? (
        <div>
          <h2 id="primary-goal-heading" className="text-sm font-medium text-foreground">
            Primary goal
          </h2>
          <p className="text-xs text-subtle mt-0.5">
            Choose the outcome Dofek should optimize toward. You can change this anytime.
          </p>
        </div>
      ) : null}
      {(writeError ?? setting.error?.message) && (
        <p role="alert" className="text-xs text-red-400">
          {writeError ?? setting.error?.message}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {PRIMARY_GOAL_OPTIONS.map((option) => {
          const isSelected = currentGoal === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => handleChange(option.id)}
              aria-pressed={isSelected}
              className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
                isSelected
                  ? "border-accent bg-accent/10"
                  : "border-border-strong bg-accent/5 hover:bg-surface-hover"
              }`}
            >
              <div className="text-xs font-medium text-foreground">{option.label}</div>
              <div className="text-xs text-subtle mt-0.5">{option.description}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
