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

// Templates kept inline (small, static, easy to version).
const _builtInTemplates = {
  verification: {
    subject: 'Verify your Syscoin Sysnode account',
    text: (v) =>
      `Hi,\n\nConfirm your Sysnode account by opening this link (valid 30 min):\n\n${v.link}\n\nIf you did not request this, ignore this email.\n\n— Syscoin Sysnode`,
    html: (v) =>
      renderTemplate(
        `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;">
<p>Confirm your <strong>Sysnode</strong> account by clicking the button below (valid 30 min):</p>
<p><a href="{{link}}" style="display:inline-block;padding:10px 16px;background:#000;color:#fff;border-radius:8px;text-decoration:none;">Verify email</a></p>
<p>Or paste this URL into your browser:<br><code>{{link}}</code></p>
<p style="color:#666;font-size:12px;">If you did not request this, ignore this email.</p>
</body></html>`,
        v,
        { raw: ['link'] }
      ),
  },
  passwordChanged: {
    subject: 'Your Sysnode password was changed',
    text: (v) =>
      `Hi,\n\nYour Sysnode account password was changed at ${v.when}. If this wasn't you, contact support immediately.\n\n— Syscoin Sysnode`,
    html: (v) =>
      renderTemplate(
        `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;">
<p>Your <strong>Sysnode</strong> password was changed at <strong>{{when}}</strong>.</p>
<p style="color:#666;font-size:12px;">If this wasn't you, contact support immediately.</p>
</body></html>`,
        v
      ),
  },
  voteReminder: {
    subject: (v) =>
      v.bucket === '1d'
        ? 'Last day to vote on Syscoin proposals'
        : v.bucket === '3d'
          ? 'Vote on Syscoin proposals — 3 days left'
          : 'Reminder: vote on Syscoin proposals',
    text: (v) => {
      const lines = v.proposals.map(
        (p) =>
          `- ${p.name} (${p.unvotedCount} masternode${p.unvotedCount === 1 ? '' : 's'} not voted, deadline ${p.deadlineText})\n  ${p.voteUrl}`
      );
      return `Hi,\n\nYou have Syscoin proposals awaiting your vote:\n\n${lines.join('\n')}\n\nVote at https://syscoin.dev/governance\n\n— Syscoin Sysnode`;
    },
    html: (v) => {
      const rows = v.proposals
        .map((p) =>
          renderTemplate(
            `<tr>
  <td style="padding:12px 0;border-top:1px solid #eee;">
    <div style="font-weight:600;">{{name}}</div>
    <div style="color:#666;font-size:13px;">{{unvotedCount}} masternode(s) have not voted · deadline {{deadlineText}}</div>
    <a href="{{voteUrl}}" style="display:inline-block;margin-top:6px;padding:6px 12px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;">Vote now</a>
  </td>
</tr>`,
            p,
            { raw: ['voteUrl'] }
          )
        )
        .join('');
      return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;">
<p>You have Syscoin proposals awaiting your vote:</p>
<table style="width:100%;border-collapse:collapse;">${rows}</table>
<p style="color:#666;font-size:12px;margin-top:24px;">You're receiving this because you enabled vote reminders in your Sysnode preferences. <a href="https://syscoin.dev/account">Manage preferences</a>.</p>
</body></html>`;
    },
  },
};

function buildMessage(templateName, vars) {
  const tpl = _builtInTemplates[templateName];
  if (!tpl) throw new Error(`Unknown mail template: ${templateName}`);
  const subject =
    typeof tpl.subject === 'function' ? tpl.subject(vars) : tpl.subject;
  return { subject, text: tpl.text(vars), html: tpl.html(vars) };
}

function createMailer(opts = {}) {
  const {
    transport = process.env.NODE_ENV === 'test' ? 'memory' : 'log',
    from = process.env.MAIL_FROM || 'no-reply@syscoin.dev',
    smtp = {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  } = opts;

  const outbox = [];
  let smtpTransport = null;

  async function deliver(msg) {
    if (!msg.to) throw new Error('mailer: missing "to"');
    const envelope = { ...msg, from };
    outbox.push(envelope);

    if (transport === 'memory') return;
    if (transport === 'log') {
      // eslint-disable-next-line no-console
      console.log(
        `[mailer] to=${msg.to} subject="${msg.subject}"\n${msg.text}`
      );
      return;
    }
    if (transport === 'smtp') {
      if (!smtpTransport) {
        if (!smtp.host) throw new Error('mailer: SMTP_HOST is required');
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
      await smtpTransport.sendMail(envelope);
      return;
    }
    throw new Error(`mailer: unknown transport ${transport}`);
  }

  async function sendVerification({ to, link }) {
    const body = buildMessage('verification', { link });
    await deliver({ to, ...body });
  }

  async function sendPasswordChanged({ to, when }) {
    const body = buildMessage('passwordChanged', {
      when: new Date(when).toISOString(),
    });
    await deliver({ to, ...body });
  }

  async function sendVoteReminder({ to, proposals, bucket }) {
    const body = buildMessage('voteReminder', { proposals, bucket });
    await deliver({ to, ...body });
  }

  return {
    outbox,
    sendVerification,
    sendPasswordChanged,
    sendVoteReminder,
  };
}

module.exports = {
  createMailer,
  renderTemplate,
  _builtInTemplates,
};
