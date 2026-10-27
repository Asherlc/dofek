import type { AppRouterInputs } from "dofek-server/router";
import { trpc } from "../lib/trpc.ts";
import { RecordDetailModal } from "./RecordDetailModal.tsx";

type RecordDetailInput = AppRouterInputs["providerDetail"]["recordDetail"];
export function ProviderRecordDetail({
  input,
  onClose,
}: {
  input: RecordDetailInput;
  onClose: () => void;
}) {
  const query = trpc.providerDetail.recordDetail.useQuery(input);
  return (
    <RecordDetailModal
      state={query}
      dataType={input.dataType}
      activityId={input.dataType === "activities" ? input.recordId : undefined}
      onClose={onClose}
    />
  );
}
