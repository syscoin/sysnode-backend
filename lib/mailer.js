const nodemailer = require('nodemailer');

// Pluggable mailer. Transports:
//   - 'smtp':   real SMTP via nodemailer (prod)
//   - 'log':    prints to console (dev default)
//   - 'memory': appends to `outbox` array (tests)
//
// Templates are plain strings with {{var}} placeholders. Substitutions are
// HTML-escaped by default; pass `raw: ['url']` to `renderTemplate` if a value
// legitimately needs to be interpolated unescaped (e.g. into an href attribute
// where we already control the template shape).

const HTML_ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

function renderTemplate(tpl, vars, { raw = [] } = {}) {
  const rawSet = new Set(raw);
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in vars)) return '';
    return rawSet.has(name) ? String(vars[name]) : escapeHtml(vars[name]);
  });
}

// ---------------------------------------------------------------------------
// Email footer (compliance / transparency)
// ---------------------------------------------------------------------------
//
// Every outbound email gets a consistent, honest footer:
//   - which address this message was sent to (so forwarded/misrouted mail
//     is recognizable at a glance)
//   - WHY the recipient is getting it (opt-in reminder? transactional
//     security alert? account creation request?)
//   - HOW to manage or disable reminders (for notifications only —
//     transactional messages cannot be disabled)
//   - an attribution line identifying the sender and marking the mail as
//     an automated, do-not-reply notification.
//
// Separating "notification" from "transactional" matters legally: CAN-SPAM
// (US) and CASL (Canada) require an unsubscribe path for commercial/
// notification mail, while strictly transactional messages (verification,
// security alerts) are exempt but should still explain *why* they
// arrived. GDPR/ePrivacy (EU) require equivalent transparency.
//
// Footer `kind`:
//   - 'vote_reminder'          opt-in notification, manage link visible
//   - 'account_security'       password change, etc; cannot disable
//   - 'account_verification'   registration email; no account yet
//   - 'proposal_notification'  transactional update on a proposal the
//                              user authored (submitted, failed); cannot
//                              disable because the user directly initiated
//                              the underlying action by paying collateral.

function buildFooter({ kind, to, accountUrl }) {
  const safeTo = escapeHtml(String(to || ''));
  const safeAcct = accountUrl ? escapeHtml(String(accountUrl)) : '';
  const attributionText =
    'Syscoin Sysnode — automated notification, please do not reply.';
  const attributionHtml = `<p style="color:#888;font-size:11px;line-height:1.55;margin:0;">${attributionText}</p>`;
  const divider =
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0 12px;" />';

  if (kind === 'vote_reminder') {
    const text = [
      '',
      '— — —',
      `You are receiving this email at ${to} because you enabled vote`,
      'reminders on your Syscoin Sysnode account. To change how often these',
      `arrive — or to turn them off entirely — visit: ${accountUrl}`,
      '',
      attributionText,
    ].join('\n');
    const html = `${divider}
<p style="color:#888;font-size:11px;line-height:1.55;margin:0 0 6px;">
  You are receiving this email at <strong>${safeTo}</strong> because you
  enabled vote reminders on your Syscoin Sysnode account. To change how
  often these arrive — or to turn them off entirely —
  <a href="${safeAcct}" style="color:#888;text-decoration:underline;">update your notification preferences</a>.
</p>
${attributionHtml}`;
    return { text, html };
  }

  if (kind === 'account_security') {
    const text = [
      '',
      '— — —',
      `This email was sent to ${to} because a security-sensitive action`,
      'occurred on the Syscoin Sysnode account tied to this address. This',
      'is a transactional security notification and cannot be disabled.',
      accountUrl ? `Review your account: ${accountUrl}` : '',
      '',
      attributionText,
    ]
      .filter(Boolean)
      .join('\n');
    const reviewLink = accountUrl
      ? ` <a href="${safeAcct}" style="color:#888;text-decoration:underline;">Review your account</a>.`
      : '';
    const html = `${divider}
<p style="color:#888;font-size:11px;line-height:1.55;margin:0 0 6px;">
  This email was sent to <strong>${safeTo}</strong> because a
  security-sensitive action occurred on the Syscoin Sysnode account tied
  to this address. This is a transactional security notification and
  cannot be disabled.${reviewLink}
</p>
${attributionHtml}`;
    return { text, html };
  }

  if (kind === 'proposal_notification') {
    const text = [
      '',
      '— — —',
      `This email was sent to ${to} because you authored a governance`,
      'proposal on Syscoin. We only email you about proposals you',
      'submitted yourself, and only for state changes you asked for by',
      'paying collateral. These transactional updates cannot be disabled.',
      accountUrl ? `Your proposals: ${accountUrl}` : '',
      '',
      attributionText,
    ]
      .filter(Boolean)
      .join('\n');
    const reviewLink = accountUrl
      ? ` <a href="${safeAcct}" style="color:#888;text-decoration:underline;">View your proposals</a>.`
      : '';
    const html = `${divider}
<p style="color:#888;font-size:11px;line-height:1.55;margin:0 0 6px;">
  This email was sent to <strong>${safeTo}</strong> because you authored
  a governance proposal on Syscoin. We only email you about proposals
  you submitted yourself, and only for state changes you asked for by
  paying collateral. These transactional updates cannot be disabled.${reviewLink}
</p>
${attributionHtml}`;
    return { text, html };
  }

  if (kind === 'account_verification') {
    const text = [
      '',
      '— — —',
      `This email was sent to ${to} because someone requested a Syscoin`,
      "Sysnode account for this address. If that wasn't you, you can safely",
      'ignore this message — no account will be created without you',
      'confirming the link above.',
      '',
      attributionText,
    ].join('\n');
    const html = `${divider}
<p style="color:#888;font-size:11px;line-height:1.55;margin:0 0 6px;">
  This email was sent to <strong>${safeTo}</strong> because someone
  requested a Syscoin Sysnode account for this address. If that wasn't
  you, you can safely ignore this message — no account will be created
  without you confirming the link above.
</p>
${attributionHtml}`;
    return { text, html };
  }

  throw new Error(`buildFooter: unknown kind ${kind}`);
}

// Templates kept inline (small, static, easy to version).
//
// Each template's `text(v)` / `html(v)` returns ONLY the body. The footer
// is appended in buildMessage() below so every outbound email carries a
// consistent disclosure block (who/why/how-to-manage) without the per-
// template code having to remember.
const _builtInTemplates = {
  verification: {
    subject: 'Verify your Syscoin Sysnode account',
    footerKind: 'account_verification',
    text: (v) =>
      `Hi,\n\nConfirm your Sysnode account by opening this link (valid 30 min):\n\n${v.link}\n\n— Syscoin Sysnode`,
    html: (v) =>
      renderTemplate(
        `<p>Confirm your <strong>Sysnode</strong> account by clicking the button below (valid 30 min):</p>
<p><a href="{{link}}" style="display:inline-block;padding:10px 16px;background:#000;color:#fff;border-radius:8px;text-decoration:none;">Verify email</a></p>
<p>Or paste this URL into your browser:<br><code>{{link}}</code></p>`,
        v,
        { raw: ['link'] }
      ),
  },
  passwordChanged: {
    subject: 'Your Sysnode password was changed',
    footerKind: 'account_security',
    text: (v) =>
      `Hi,\n\nYour Sysnode account password was changed at ${v.when}.\n\nIf this wasn't you, secure your account immediately and contact support.\n\n— Syscoin Sysnode`,
    html: (v) =>
      renderTemplate(
        `<p>Your <strong>Sysnode</strong> password was changed at <strong>{{when}}</strong>.</p>
<p style="color:#666;font-size:12px;">If this wasn't you, secure your account immediately and contact support.</p>`,
        v
      ),
  },
  // proposalSubmitted — sent by the dispatcher once a user's proposal
  // reaches GOVERNANCE_FEE_CONFIRMATIONS (6) and gObject_submit
  // returned the governance hash. This is the "it's live on chain"
  // moment — surface the hash so the user can independently verify
  // via any block explorer, and link them to the governance page
  // where their proposal will show up for voting.
  proposalSubmitted: {
    subject: (v) => `Your Syscoin proposal "${v.proposalName}" is live`,
    footerKind: 'proposal_notification',
    text: (v) =>
      `Hi,\n\nYour governance proposal "${v.proposalName}" has been accepted on chain and is now open for masternode voting.\n\nGovernance hash: ${v.governanceHash}\nCollateral txid: ${v.collateralTxid}\n\nView on Sysnode: ${v.proposalUrl}\n\n— Syscoin Sysnode`,
    html: (v) =>
      renderTemplate(
        `<p>Your governance proposal <strong>{{proposalName}}</strong> has been accepted on chain and is now open for masternode voting.</p>
<table style="font-size:13px;color:#444;border-collapse:collapse;margin:12px 0;">
  <tr><td style="padding:2px 8px 2px 0;color:#888;">Governance hash</td><td style="padding:2px 0;font-family:ui-monospace,Menlo,monospace;">{{governanceHash}}</td></tr>
  <tr><td style="padding:2px 8px 2px 0;color:#888;">Collateral txid</td><td style="padding:2px 0;font-family:ui-monospace,Menlo,monospace;">{{collateralTxid}}</td></tr>
</table>
<p><a href="{{proposalUrl}}" style="display:inline-block;padding:10px 16px;background:#000;color:#fff;border-radius:8px;text-decoration:none;">View your proposal</a></p>`,
        v,
        { raw: ['proposalUrl'] }
      ),
  },

  // proposalFailed — sent when the dispatcher gives up on a submission.
  // Reasons we send from (see lib/proposalDispatcher.js):
  //   - collateral_not_found : tx never made it into any block within
  //                            the 7-day window. User likely broadcast
  //                            to the wrong network or the tx was
  //                            double-spent.
  //   - submit_rejected      : Core returned a terminal validation
  //                            error on gObject_submit (payload
  //                            changed, rate limited on the node, etc).
  // The email includes the raw `failDetail` so the user has the same
  // context the /submissions/:id page shows.
  proposalFailed: {
    subject: (v) => `Your Syscoin proposal "${v.proposalName}" could not be published`,
    footerKind: 'proposal_notification',
    text: (v) =>
      `Hi,\n\nWe were unable to publish your governance proposal "${v.proposalName}" on chain.\n\nReason: ${v.failReason}\n${v.failDetail ? `Detail: ${v.failDetail}\n` : ''}\nThe 150 SYS collateral fee is burned by protocol regardless of whether a submission succeeds; we cannot recover it. You can review the failure and start fresh: ${v.proposalUrl}\n\n— Syscoin Sysnode`,
    html: (v) =>
      renderTemplate(
        `<p>We were unable to publish your governance proposal <strong>{{proposalName}}</strong> on chain.</p>
<table style="font-size:13px;color:#444;border-collapse:collapse;margin:12px 0;">
  <tr><td style="padding:2px 8px 2px 0;color:#888;vertical-align:top;">Reason</td><td style="padding:2px 0;">{{failReason}}</td></tr>
  {{detailRow}}
</table>
<p style="background:#fff4e0;border:1px solid #f3d498;color:#7a4a00;padding:10px 12px;border-radius:6px;font-size:13px;">The 150 SYS collateral fee is burned by protocol regardless of whether a submission succeeds; we cannot recover it.</p>
<p><a href="{{proposalUrl}}" style="display:inline-block;padding:10px 16px;background:#000;color:#fff;border-radius:8px;text-decoration:none;">Review failure</a></p>`,
        {
          ...v,
          // Pre-render the optional detail row so we don't need a
          // templating-language conditional. renderTemplate itself
          // escapes placeholder values; the row markup here is fixed.
          detailRow: v.failDetail
            ? `<tr><td style="padding:2px 8px 2px 0;color:#888;vertical-align:top;">Detail</td><td style="padding:2px 0;">${escapeHtml(v.failDetail)}</td></tr>`
            : '',
        },
        { raw: ['proposalUrl', 'detailRow'] }
      ),
  },

  // voteReminder — generic copy (PR 7).
  //
  // The dispatcher sends one of two bucket flavors:
  //   - 'days_before'  — proposals close within ~72h, first-warning tone
  //   - 'final_24h'    — proposals close within 24h, urgent tone
  //
  // By design the body does NOT enumerate per-proposal state or per-MN
  // unvoted counts. That kind of per-row detail would require either
  // leaking the user's masternode ownership to the dispatcher (vault
  // data is client-side only) or plumbing it through the signing-key
  // flow, which is a bigger UX design problem than this PR tries to
  // solve. The CTA takes the user to the governance page where they
  // see the personalized cohort/verified/metadata chips (PR 6c).
  voteReminder: {
    footerKind: 'vote_reminder',
    subject: (v) =>
      v.bucket === 'final_24h'
        ? 'Syscoin governance: under 24 hours left to vote'
        : 'Syscoin governance: proposals closing soon',
    text: (v) => {
      const urgent = v.bucket === 'final_24h';
      const count = Math.max(0, Number.isFinite(v.proposalCount) ? v.proposalCount : 0);
      const countStr = count === 1 ? '1 active proposal' : `${count} active proposals`;
      const closesLine = v.deadlineText
        ? `Voting closes ${v.deadlineText}.`
        : 'Voting closes soon.';
      const lead = urgent
        ? `Less than 24 hours remain to vote on ${countStr}.`
        : `There ${count === 1 ? 'is' : 'are'} ${countStr} awaiting your vote.`;
      return `Hi,\n\n${lead}\n${closesLine}\n\nVote: ${v.governanceUrl}\n\n— Syscoin Sysnode`;
    },
    html: (v) => {
      const urgent = v.bucket === 'final_24h';
      const count = Math.max(0, Number.isFinite(v.proposalCount) ? v.proposalCount : 0);
      const countStr = count === 1 ? '1 active proposal' : `${count} active proposals`;
      const deadlineText = v.deadlineText || 'soon';
      const lead = urgent
        ? `<p style="font-size:16px;"><strong>Less than 24 hours</strong> remain to vote on ${escapeHtml(countStr)}.</p>`
        : `<p style="font-size:16px;">There ${count === 1 ? 'is' : 'are'} <strong>${escapeHtml(countStr)}</strong> awaiting your vote.</p>`;
      const urgentBar = urgent
        ? `<div style="background:#fce8e6;color:#8a2a2a;padding:8px 12px;border-radius:6px;font-size:13px;margin:0 0 14px;">Urgent reminder</div>`
        : '';
      // URLs are already escaped by renderTemplate's default path, but
      // we're concatenating HTML directly here. Use escapeHtml to keep
      // any unusual characters in a custom FRONTEND_URL from breaking
      // the attribute.
      const govHref = escapeHtml(v.governanceUrl);
      return `${urgentBar}
${lead}
<p>Voting closes ${escapeHtml(deadlineText)}.</p>
<p><a href="${govHref}" style="display:inline-block;margin-top:6px;padding:10px 18px;background:#000;color:#fff;border-radius:8px;text-decoration:none;">Vote now</a></p>`;
    },
  },
};

// HTML document shell that every outbound email is wrapped in. Kept
// narrow (560px) and system-font based to render consistently across
// Gmail, Outlook, Fastmail, and Apple Mail without webfonts. The shell
// is the place to put any global <head> rules (e.g. dark-mode media
// queries) in the future.
function wrapHtmlDocument(bodyHtml, footerHtml) {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:560px;margin:0 auto;padding:16px;">
${bodyHtml}
${footerHtml}
</body></html>`;
}

function buildMessage(templateName, vars, footerCtx) {
  const tpl = _builtInTemplates[templateName];
  if (!tpl) throw new Error(`Unknown mail template: ${templateName}`);
  const subject =
    typeof tpl.subject === 'function' ? tpl.subject(vars) : tpl.subject;
  // Every outbound email gets a compliance footer. `footerKind` is a
  // required property on the template definition so a future contributor
  // can't add a new email template that silently ships without a "why
  // are you getting this" block. The send* wrapper is responsible for
  // passing the recipient `to` and (where applicable) the `accountUrl`.
  if (!tpl.footerKind) {
    throw new Error(
      `mailer: template "${templateName}" is missing footerKind — every template must declare its footer type (account_verification | account_security | vote_reminder)`
    );
  }
  const footer = buildFooter({
    kind: tpl.footerKind,
    to: (footerCtx && footerCtx.to) || '',
    accountUrl: (footerCtx && footerCtx.accountUrl) || '',
  });
  const text = `${tpl.text(vars)}${footer.text}`;
  const html = wrapHtmlDocument(tpl.html(vars), footer.html);
  return { subject, text, html };
}

function createMailer(opts = {}) {
  const {
    transport = process.env.NODE_ENV === 'test' ? 'memory' : 'log',
    from = process.env.MAIL_FROM || 'no-reply@syscoin.dev',
    // `publicBaseUrl` is the user-facing web origin (the FRONTEND, e.g.
    // https://sysnode.info). All clickable links rendered inside email
    // bodies must be built from this value — NOT from the backend API
    // origin (e.g. https://syscoin.dev) which only serves JSON. Callers
    // thread `FRONTEND_URL` here so the reminder/verification CTAs land
    // on real HTML pages the user can interact with.
    publicBaseUrl = process.env.FRONTEND_URL ||
      process.env.CORS_ORIGIN ||
      'http://localhost:3000',
    smtp = {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  } = opts;

  const normalizedBase = String(publicBaseUrl).replace(/\/$/, '');

  if (!['smtp', 'log', 'memory'].includes(transport)) {
    throw new Error(`mailer: unknown transport ${transport}`);
  }

  // `outbox` is a test affordance, meaningful only for the 'memory'
  // transport. It must NOT be populated for 'smtp' or 'log', because those
  // are long-running production/dev modes where an unbounded in-process
  // array of every verification + vote-reminder + password-change email
  // ever sent turns into a straightforward memory leak.
  const outbox = [];
  let smtpTransport = null;

  // SMTP config validation is eager (Codex round-8 P1). The previous
  // implementation deferred the SMTP_HOST check to the first deliver()
  // call, which meant a production deploy with `transport: 'smtp'` and
  // no SMTP_HOST started up happy, accepted registrations, and then
  // silently dropped every email while /auth kept returning 202. We
  // now fail at createMailer time so a broken deploy crashes at boot
  // rather than slipping past health checks.
  if (transport === 'smtp') {
    if (!smtp.host || !String(smtp.host).trim()) {
      throw new Error(
        'mailer: SMTP_HOST is required when transport=smtp (set MAIL_TRANSPORT=log to opt into stdout delivery instead)'
      );
    }
    if (!Number.isFinite(smtp.port) || smtp.port <= 0 || smtp.port > 65535) {
      throw new Error(
        `mailer: SMTP_PORT must be a positive port number (got ${smtp.port})`
      );
    }
    // Partial SMTP auth is almost always a config typo: nodemailer will
    // attempt authless delivery which a relay silently rejects. Refuse
    // at construction time.
    if ((smtp.user && !smtp.pass) || (!smtp.user && smtp.pass)) {
      throw new Error(
        'mailer: SMTP_USER and SMTP_PASS must be set together (or neither)'
      );
    }
    // Build the nodemailer transport now so that obvious misconfig
    // (unreachable hostname syntax, invalid TLS settings) surfaces at
    // startup instead of on first send.
    smtpTransport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth:
        smtp.user && smtp.pass
          ? { user: smtp.user, pass: smtp.pass }
          : undefined,
    });
  }

  async function deliver(msg) {
    if (!msg.to) throw new Error('mailer: missing "to"');
    const envelope = { ...msg, from };

    if (transport === 'memory') {
      outbox.push(envelope);
      return;
    }
    if (transport === 'log') {
      // eslint-disable-next-line no-console
      console.log(
        `[mailer] to=${msg.to} subject="${msg.subject}"\n${msg.text}`
      );
      return;
    }
    // transport === 'smtp' — smtpTransport was constructed up front.
    await smtpTransport.sendMail(envelope);
  }

  async function sendVerification({ to, link }) {
    // Verification emails intentionally omit accountUrl from the footer
    // — the account does not exist yet, and pre-pointing users at a
    // /account page they can't log into would be worse than no link.
    const body = buildMessage('verification', { link }, { to });
    await deliver({ to, ...body });
  }

  async function sendPasswordChanged({ to, when }) {
    const body = buildMessage(
      'passwordChanged',
      { when: new Date(when).toISOString() },
      { to, accountUrl: `${normalizedBase}/account` }
    );
    await deliver({ to, ...body });
  }

  async function sendVoteReminder({
    to,
    bucket,
    proposalCount,
    deadlineText,
  }) {
    const accountUrl = `${normalizedBase}/account`;
    const body = buildMessage(
      'voteReminder',
      {
        bucket,
        proposalCount,
        deadlineText,
        governanceUrl: `${normalizedBase}/governance`,
      },
      { to, accountUrl }
    );
    await deliver({ to, ...body });
  }

  // Build the canonical URL for a user's submission. Kept here (not in
  // routes/govProposals.js) so both mail senders share one source of
  // truth — the dispatcher doesn't know anything about URL shapes.
  function proposalUrl(submissionId) {
    return `${normalizedBase}/governance/proposals/${submissionId}`;
  }

  async function sendProposalSubmitted({
    to,
    proposalName,
    governanceHash,
    collateralTxid,
    submissionId,
  }) {
    const accountUrl = `${normalizedBase}/account`;
    const body = buildMessage(
      'proposalSubmitted',
      {
        proposalName: proposalName || '(unnamed)',
        governanceHash,
        collateralTxid,
        proposalUrl: proposalUrl(submissionId),
      },
      { to, accountUrl }
    );
    await deliver({ to, ...body });
  }

  async function sendProposalFailed({
    to,
    proposalName,
    failReason,
    failDetail,
    submissionId,
  }) {
    const accountUrl = `${normalizedBase}/account`;
    const body = buildMessage(
      'proposalFailed',
      {
        proposalName: proposalName || '(unnamed)',
        failReason: failReason || 'unknown',
        failDetail: failDetail || '',
        proposalUrl: proposalUrl(submissionId),
      },
      { to, accountUrl }
    );
    await deliver({ to, ...body });
  }

  return {
    outbox,
    sendVerification,
    sendPasswordChanged,
    sendVoteReminder,
    sendProposalSubmitted,
    sendProposalFailed,
  };
}

module.exports = {
  createMailer,
  renderTemplate,
  buildFooter,
  _builtInTemplates,
};
