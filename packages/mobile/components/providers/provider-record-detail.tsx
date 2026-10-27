import type { AppRouterInputs } from "dofek-server/router";
import { trpc } from "../../lib/trpc";
import { ProviderRecordDetailModal } from "./provider-record-detail-modal";

type RecordDetailInput = AppRouterInputs["providerDetail"]["recordDetail"];
export function ProviderRecordDetail({
  input,
  onClose,
}: {
  input: RecordDetailInput;
  onClose: () => void;
}) {
  const query = trpc.providerDetail.recordDetail.useQuery({ ...input, responseVersion: 2 });
  return (
    <ProviderRecordDetailModal
      state={query}
      dataType={input.dataType}
      activityId={input.dataType === "activities" ? input.recordId : undefined}
      onClose={onClose}
    />
  );
}
