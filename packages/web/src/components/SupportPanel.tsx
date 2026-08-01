import { type FormEvent, useState } from "react";
import { trpc } from "../lib/trpc.ts";

export function SupportPanel() {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");

  const createTicket = trpc.support.createTicket.useMutation();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    createTicket.mutate(
      {
        subject: subject.trim(),
        message: message.trim(),
        email: trimmedEmail.length > 0 ? trimmedEmail : undefined,
      },
      {
        onSuccess: () => {
          setSubject("");
          setMessage("");
          setEmail("");
        },
      },
    );
  }

  if (createTicket.isSuccess) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-foreground">
          Thanks — your request was submitted. Our team will reply by email.
        </p>
        <p className="text-xs text-subtle">Ticket ID: {createTicket.data.ticketId}</p>
        <button
          type="button"
          onClick={() => createTicket.reset()}
          className="text-xs text-muted hover:text-foreground border border-border-strong rounded px-3 py-1.5 transition-colors cursor-pointer"
        >
          Submit another request
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-muted">
        Have a question or hit a problem? Send us a message and we'll reply by email.
      </p>

      <div className="space-y-1">
        <label htmlFor="support-subject" className="block text-xs font-medium text-subtle">
          Subject
        </label>
        <input
          id="support-subject"
          type="text"
          required
          maxLength={255}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          className="w-full rounded border border-border bg-surface-solid px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="support-message" className="block text-xs font-medium text-subtle">
          Message
        </label>
        <textarea
          id="support-message"
          required
          maxLength={10_000}
          rows={6}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className="w-full rounded border border-border bg-surface-solid px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="support-email" className="block text-xs font-medium text-subtle">
          Reply-to email (optional)
        </label>
        <input
          id="support-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Defaults to your account email"
          className="w-full rounded border border-border bg-surface-solid px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
        />
      </div>

      {createTicket.error && <p className="text-sm text-red-400">{createTicket.error.message}</p>}

      <button
        type="submit"
        disabled={createTicket.isPending}
        className="inline-flex items-center gap-2 rounded bg-accent px-4 py-2 text-sm text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {createTicket.isPending ? "Sending..." : "Send Message"}
      </button>
    </form>
  );
}
