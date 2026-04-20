// Mail-transport selector, factored out of server.js so the "refuse to
// start in production without SMTP" guard is directly unit-testable.
//
// Rationale (Codex round-6 P1):
//   server.js used to default to `transport: 'log'` whenever SMTP_HOST
//   was unset — even in production. That silently degraded
//   email-dependent flows (verification, password-change notices,
//   vote reminders) to "write to stdout" while /auth endpoints kept
//   returning success. Operators learned about the breakage only when
//   real users complained, because health checks stayed green.
//
//   Behaviour now:
//     - MAIL_TRANSPORT (if set) wins and is returned verbatim. Valid
//       values: smtp | log | memory. In production, 'memory' is
//       refused (throws): it is strictly a test transport.
//     - Otherwise, if SMTP_HOST is set, 'smtp'.
//     - Otherwise, in production, throw — force operators to either
//       configure SMTP or to opt-in to 'log' explicitly (dry-run).
//     - Otherwise (non-prod, no SMTP), 'log' (dev convenience).
//
// Returns a string transport name suitable for createMailer({transport}).

function selectMailTransport(env = process.env) {
  const explicit = (env.MAIL_TRANSPORT || '').trim().toLowerCase();
  const hasSmtp = !!(env.SMTP_HOST && env.SMTP_HOST.trim());
  const isProd = env.NODE_ENV === 'production';

  if (explicit) {
    if (!['smtp', 'log', 'memory'].includes(explicit)) {
      throw new Error(
        `mailer: MAIL_TRANSPORT="${explicit}" is not a valid transport (expected smtp|log|memory)`
      );
    }
    if (isProd && explicit === 'memory') {
      throw new Error(
        'mailer: MAIL_TRANSPORT=memory is not valid in production (in-memory only)'
      );
    }
    return explicit;
  }

  if (hasSmtp) return 'smtp';

  if (isProd) {
    throw new Error(
      'mailer: refusing to start in production without SMTP_HOST (set MAIL_TRANSPORT=log to opt in to stdout delivery explicitly)'
    );
  }

  return 'log';
}

module.exports = { selectMailTransport };
