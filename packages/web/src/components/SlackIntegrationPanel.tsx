import { trpc } from "../lib/trpc.ts";

export function SlackIntegrationPanel() {
  const { data, isLoading } = trpc.settings.slackStatus.useQuery();

  if (isLoading) {
    return <div className="text-xs text-zinc-500">Checking Slack status...</div>;
  }

  if (!data?.configured) {
    return (
      <div className="text-xs text-zinc-500">
        Slack integration is not configured on this server.
      </div>
    );
  }

  if (data.connected) {
    return (
      <div className="flex items-center gap-3">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400" />
        <div>
          <div className="text-sm text-zinc-200">Connected</div>
          <div className="text-xs text-zinc-500">DM the bot in Slack to log what you ate</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm text-zinc-300">Log food via Slack</div>
        <div className="text-xs text-zinc-500">
          Add the bot to your workspace, then DM it what you ate
        </div>
      </div>
      <a
        href="/auth/provider/slack"
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-[#4A154B] text-white hover:bg-[#5B2D5C] transition-colors"
      >
        <SlackIcon />
        Add to Slack
      </a>
    </div>
  );
}

function SlackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-label="Slack">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.124 2.521a2.528 2.528 0 0 1 2.52-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.52V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.528 2.528 0 0 1-2.521-2.521V2.522A2.528 2.528 0 0 1 15.166 0a2.528 2.528 0 0 1 2.521 2.522v6.312zm-2.521 10.124a2.528 2.528 0 0 1 2.521 2.52A2.528 2.528 0 0 1 15.166 24a2.528 2.528 0 0 1-2.521-2.522v-2.52h2.521zm0-1.271a2.528 2.528 0 0 1-2.521-2.521 2.528 2.528 0 0 1 2.521-2.521h6.312A2.528 2.528 0 0 1 24 15.166a2.528 2.528 0 0 1-2.522 2.521h-6.312z" />
    </svg>
  );
}
