import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { useId } from "react";
import { trpc } from "../lib/trpc.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

export const GHOST_MAP_LABELS_SETTING = { key: "ghostMapLabels" } as const;

export function GhostMapLabelsSetting() {
  const description = useId();
  const utils = trpc.useUtils();
  const setting = trpc.settings.get.useQuery(GHOST_MAP_LABELS_SETTING, {
    meta: { persist: false },
  });
  const mutation = trpc.settings.set.useMutation({
    onMutate: async ({ value }) => {
      await utils.settings.get.cancel(GHOST_MAP_LABELS_SETTING);
      const previous = utils.settings.get.getData(GHOST_MAP_LABELS_SETTING);
      if (value === false) {
        utils.settings.get.setData(GHOST_MAP_LABELS_SETTING, {
          ...GHOST_MAP_LABELS_SETTING,
          value,
        });
      }
      return previous;
    },
    onError: (_error, _input, previous) => {
      utils.settings.get.setData(GHOST_MAP_LABELS_SETTING, previous);
    },
    onSuccess: (_result, { value }) => {
      utils.settings.get.setData(GHOST_MAP_LABELS_SETTING, { ...GHOST_MAP_LABELS_SETTING, value });
    },
    onSettled: async () => {
      await Promise.all([
        utils.settings.get.invalidate(GHOST_MAP_LABELS_SETTING),
        utils.ghostSessions.invalidate(),
      ]);
    },
  });

  if (setting.data === undefined) {
    return setting.error ? (
      <QueryStatePanel
        title="Map label preference could not be loaded"
        error={setting.error}
        height={64}
        onRetry={() => void setting.refetch()}
      />
    ) : (
      <QueryStatePanel variant="loading" contextLabel="map label preference" height={64} />
    );
  }

  return (
    <div className="space-y-2">
      <p id={description} className="text-sm text-muted">
        When enabled, Dofek shares recorded GPS coordinates and travel mode with Geoapify to look up
        road and trail names. Turning this off hides those names. Recorded comparisons remain
        available.
      </p>
      <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-foreground">
        <input
          type="checkbox"
          aria-describedby={description}
          className="h-4 w-4 accent-accent"
          checked={setting.data?.value === true}
          disabled={mutation.isPending}
          onChange={(event) =>
            mutation.mutate({ ...GHOST_MAP_LABELS_SETTING, value: event.currentTarget.checked })
          }
        />
        Show road and trail names in Ghost Sessions
      </label>
      {mutation.error ? (
        <p role="alert" className="text-sm text-red-400">
          {userFacingErrorMessage(mutation.error, "Map label preference could not be saved.")}
        </p>
      ) : null}
    </div>
  );
}
