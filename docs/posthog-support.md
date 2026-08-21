# PostHog Support Tickets

The in-app **Help & Support** form (web `/support`, mobile Support screen) files
tickets into the Dofek PostHog project's Support Tickets inbox. The server keeps
the project token and PostHog conversation-token lookup in one integration while
web and mobile use the same tRPC mutation.

PostHog's web SDK uses the same public conversation endpoint and payload shape;
the implementation below follows its official conversation client
([PostHog JS conversations source](https://github.com/PostHog/posthog-js/blob/master/src/extensions/conversations/external/index.ts)).

## Architecture

```text
SupportPanel (web + mobile)
  -> trpc support.createTicket            packages/server/src/routers/support.ts
    -> PostHogConversationsClient.createTicket()
      -> GET /array/{project-token}/config
      -> POST /api/conversations/v1/widget/message
```

The client fetches the project's public conversation token from PostHog remote
configuration and caches it in memory for five minutes. Each form submission
creates a new ticket with the subject included in the message, profile/override
name and email traits, the authenticated Dofek user as `distinct_id`, and a
fresh widget session ID. The router returns PostHog's `ticket_id` to both
clients.

PostHog's authenticated project API exposes the support-ticket resources in its
[API schema](https://us.posthog.com/api/schema/swagger-ui/#/conversations), while
the widget endpoint is intended for client-originated conversation messages.

## Configuration

No support-specific environment variables are required. The existing public
PostHog project key and US host are defined in
[`src/lib/posthog-config.ts`](../src/lib/posthog-config.ts). Keep Support
Tickets enabled for project `347753`; the server fails the submission with a
specific retry message when the project configuration or message request fails.
Sentry and server logs capture the operation and upstream status without
relaying raw PostHog response bodies to error messages.

Manage submitted tickets at the project's
[Support Tickets inbox](https://us.posthog.com/project/347753/support/tickets).
