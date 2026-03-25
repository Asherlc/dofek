import { useCallback, useRef, useState } from "react";
import { PageLayout } from "../components/PageLayout.tsx";
import { trpc } from "../lib/trpc.ts";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const FOCUS_AREA_LABELS: Record<string, string> = {
  training: "Training",
  recovery: "Recovery",
  sleep: "Sleep",
  nutrition: "Nutrition",
  "stress-management": "Stress Management",
};

const FOCUS_AREA_COLORS: Record<string, string> = {
  training: "bg-blue-500/15 text-blue-400",
  recovery: "bg-emerald-500/15 text-emerald-400",
  sleep: "bg-purple-500/15 text-purple-400",
  nutrition: "bg-amber-500/15 text-amber-400",
  "stress-management": "bg-red-500/15 text-red-400",
};

export function CoachPage() {
  const { data: outlook, isLoading: outlookLoading } = trpc.aiCoach.dailyOutlook.useQuery();
  const chatMutation = trpc.aiCoach.chat.useMutation();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const sendMessage = useCallback(() => {
    if (!input.trim() || chatMutation.isPending) return;

    const userMessage: ChatMessage = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");

    chatMutation.mutate(
      { messages: newMessages },
      {
        onSuccess: (result) => {
          setMessages((prev) => [...prev, { role: "assistant", content: result.response }]);
          messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        },
      },
    );
  }, [input, messages, chatMutation]);

  return (
    <PageLayout title="Coach" subtitle="AI-powered daily outlook and chat">
      <div className="space-y-6">
        {/* Daily Outlook */}
        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Daily Outlook
          </h3>
          {outlookLoading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-4 bg-surface-hover rounded w-3/4" />
              <div className="h-4 bg-surface-hover rounded w-1/2" />
            </div>
          ) : outlook ? (
            <div>
              <p className="text-sm text-foreground mb-4">{outlook.summary}</p>

              {outlook.focusArea && (
                <div className="mb-4">
                  <span className="text-xs text-muted mr-2">Focus today:</span>
                  <span
                    className={`inline-block px-2 py-1 rounded text-xs font-medium ${FOCUS_AREA_COLORS[outlook.focusArea] ?? "bg-surface text-muted"}`}
                  >
                    {FOCUS_AREA_LABELS[outlook.focusArea] ?? outlook.focusArea}
                  </span>
                </div>
              )}

              {outlook.recommendations && outlook.recommendations.length > 0 && (
                <div>
                  <span className="text-xs text-muted block mb-2">Recommendations</span>
                  <ul className="space-y-1.5">
                    {outlook.recommendations.map((rec) => (
                      <li key={rec} className="text-sm text-foreground flex items-start gap-2">
                        <span className="text-accent mt-0.5">-</span>
                        <span>{rec}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-dim">
              Unable to generate daily outlook. Make sure an AI provider is configured.
            </p>
          )}
        </div>

        {/* Chat */}
        <div className="card p-6">
          <h3 className="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Ask Your Coach
          </h3>

          {/* Chat messages */}
          <div className="space-y-3 mb-4 max-h-96 overflow-y-auto">
            {messages.length === 0 && (
              <p className="text-xs text-dim">
                Ask anything about your training, recovery, sleep, or nutrition. Your coach has
                access to your recent health data.
              </p>
            )}
            {messages.map((msg) => (
              <div
                key={`${msg.role}-${msg.content.slice(0, 20)}`}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-accent/15 text-foreground"
                      : "bg-surface border border-border text-foreground"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {chatMutation.isPending && (
              <div className="flex justify-start">
                <div className="bg-surface border border-border rounded-lg px-4 py-2 text-sm text-dim">
                  Thinking...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="Ask your coach..."
              className="flex-1 bg-surface border border-border rounded-lg px-4 py-2 text-sm text-foreground placeholder:text-dim focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={sendMessage}
              disabled={!input.trim() || chatMutation.isPending}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
