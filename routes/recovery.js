const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { getAddress } = require('ethers');

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Challenge = z
  .object({
    chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    account: Address,
  })
  .strict();
const Subscribe = z
  .object({
    challengeId: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z
      .string()
      .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
      .max(131074),
    label: z
      .string()
      .trim()
      .max(64)
      .regex(/^[^\u0000-\u001f\u007f]*$/)
      .default(''),
  })
  .strict();
const Disable = z
  .object({
    oldAuthHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();

function createRecoveryRouter({
  repository: repo,
  monitor,
  users,
  sessions,
  totp,
  sessionMw,
  csrfMw,
  limiter,
  frontendUrl,
  now = Date.now,
}) {
  const router = express.Router();
  router.use(sessionMw.requireAuth);
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((err) => {
      const expected = new Set([
        'challenge_expired',
        'invalid_signature',
        'recovery_not_installed',
        'already_subscribed',
        'subscription_limit',
        'too_many_challenges',
      ]);
      if (expected.has(err.message))
        return res.status(err.status || 400).json({ error: err.message });
      if (err.code === 'kdf_config')
        return res.status(503).json({ error: 'server_misconfigured' });
      return res.status(503).json({ error: 'monitor_unavailable' });
    });
  const wire = (sub) => ({
    id: sub.id,
    chainId: sub.chain_id,
    recoveryModule: sub.module_address,
    account: sub.account,
    label: sub.label,
    createdAt: sub.created_at,
    monitoring: {
      status:
        !monitor.chains.some(
          (chain) =>
            chain.chainId === sub.chain_id &&
            chain.recoveryModule.toLowerCase() === sub.module_address
        ) ||
        (sub.checked_at && now() - sub.checked_at > 60000)
          ? 'degraded'
          : sub.status,
      lastCheckedAt: sub.checked_at,
      lastBlockTimestamp: sub.block_timestamp,
    },
    pending: repo.operations(sub.id).map((op) => ({
      operationId: op.operation_id,
      scheduledAt: op.scheduled_at,
      executableAt: op.executable_at,
      expiresAt: op.expires_at,
      status: op.state,
      txHash: op.tx_hash,
    })),
  });
  router.get('/chains', (_req, res) =>
    res.json({
      chains: monitor.chains.map(
        ({ chainId, name, recoveryModule, explorerUrl, testnet }) => ({
          chainId,
          name,
          recoveryModule,
          explorerUrl,
          testnet,
        })
      ),
    })
  );
  router.get('/subscriptions', (req, res) =>
    res.json({ subscriptions: repo.subscriptions(req.user.id).map(wire) })
  );
  router.post(
    '/challenges',
    csrfMw.require,
    limiter,
    wrap(async (req, res) => {
      const parsed = Challenge.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'invalid_body' });
      const { chainId } = parsed.data;
      let account;
      try {
        account = getAddress(parsed.data.account);
      } catch {
        return res.status(400).json({ error: 'invalid_body' });
      }
      const chain = monitor.chains.find((v) => v.chainId === chainId);
      if (!chain) return res.status(400).json({ error: 'unsupported_chain' });
      const snapshot = await chain.rpc.snapshot(account);
      if (!snapshot.installed)
        return res.status(400).json({ error: 'recovery_not_installed' });
      const id = crypto.randomBytes(32).toString('hex');
      const expiresAt = now() + 300000;
      const origin = new URL(frontendUrl).origin;
      const message = [
        'Enable Sysnode recovery email alerts',
        `Service: ${origin}`,
        `Email: ${req.user.email}`,
        `User: ${req.user.id}`,
        `Chain ID: ${chainId}`,
        `Smart account: ${account}`,
        `Recovery module: ${chain.recoveryModule}`,
        `Nonce: ${id}`,
        `Expires: ${new Date(expiresAt).toISOString()}`,
        'This links public recovery activity to this email. It cannot move funds or cancel recovery.',
      ].join('\n');
      repo.addChallenge({
        id,
        userId: req.user.id,
        chainId,
        recoveryModule: chain.recoveryModule,
        account,
        message,
        expiresAt,
      });
      return res.json({ id, message, expiresAt, chainId, account });
    })
  );
  router.post(
    '/subscriptions',
    csrfMw.require,
    limiter,
    wrap(async (req, res) => {
      const parsed = Subscribe.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'invalid_body' });
      const input = parsed.data;
      const challenge = repo.challenge(input.challengeId, req.user.id);
      if (!challenge || challenge.consumed_at || challenge.expires_at <= now())
        throw new Error('challenge_expired');
      const chain = monitor.chains.find(
        (v) => v.chainId === challenge.chain_id
      );
      if (!chain) return res.status(400).json({ error: 'unsupported_chain' });
      if (chain.recoveryModule.toLowerCase() !== challenge.module_address)
        throw new Error('challenge_expired');
      const snapshot = await chain.rpc.snapshot(challenge.account);
      if (!snapshot.installed) throw new Error('recovery_not_installed');
      if (
        !(await chain.rpc.verifySignature(
          challenge.account,
          challenge.message,
          input.signature,
          snapshot.block
        ))
      )
        throw new Error('invalid_signature');
      // Recheck after RPC awaits: a password/email change, deletion or an expired
      // session must not enable alerts from a stale proof verification request.
      const currentUser = users.findById(req.user.id);
      const currentSession = sessions.verify(req.sessionToken);
      if (
        !currentUser ||
        !currentUser.emailVerified ||
        currentUser.email !== req.user.email ||
        !currentSession ||
        currentSession.id !== req.session.id ||
        currentSession.userId !== req.user.id
      )
        return res.status(401).json({ error: 'unauthorized' });
      let sub;
      repo.atomic(() => {
        if (!repo.consume(challenge.id, req.user.id))
          throw new Error('challenge_expired');
        sub = repo.subscribe(
          req.user.id,
          challenge.chain_id,
          challenge.account.toLowerCase(),
          input.label,
          snapshot.block,
          chain.recoveryModule
        );
        repo.queue(
          sub.id,
          `${sub.id}:enabled:${sub.created_at}`,
          'enabled',
          null
        );
        monitor.bootstrap(sub, snapshot);
      });
      return res
        .status(201)
        .json({ subscription: wire(repo.getSubscription(sub.id)) });
    })
  );
  router.delete(
    '/subscriptions/:id',
    csrfMw.require,
    limiter,
    wrap(async (req, res) => {
      const parsed = Disable.safeParse(req.body);
      if (!parsed.success || !/^[1-9]\d*$/.test(req.params.id))
        return res.status(400).json({ error: 'invalid_body' });
      const sub = repo.getSubscription(Number(req.params.id));
      if (!sub || sub.user_id !== req.user.id || !sub.enabled)
        return res.status(404).json({ error: 'not_found' });
      if (!users.verifyAuth(req.user.email, parsed.data.oldAuthHash))
        return res.status(401).json({ error: 'invalid_credentials' });
      if (totp.status(req.user.id).enabled) {
        if (!parsed.data.code)
          return res.status(400).json({ error: 'totp_required' });
        try {
          totp.verifyUserCode(req.user.id, parsed.data.code);
        } catch {
          return res.status(400).json({ error: 'invalid_totp_code' });
        }
      }
      repo.atomic(() => {
        repo.disable(sub.id);
        repo.queue(sub.id, `${sub.id}:disabled:${now()}`, 'disabled', null);
      });
      return res.status(204).end();
    })
  );
  return router;
}
module.exports = { createRecoveryRouter };
