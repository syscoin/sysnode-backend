const { SyscoinRpcClient, rpcServices } = require('@syscoin/syscoin-js');

// RPC connection parameters come from the environment so credentials never
// live in source control. See .env.example for the full list.
const config = {
  host: process.env.SYSCOIN_RPC_HOST || 'localhost',
  rpcPort: Number(process.env.SYSCOIN_RPC_PORT) || 8370,
  username: process.env.SYSCOIN_RPC_USER,
  password: process.env.SYSCOIN_RPC_PASS,
  logLevel: process.env.SYSCOIN_RPC_LOG_LEVEL || 'error',
};

if (!config.username || !config.password) {
  // Fail fast in production; stay noisy but non-fatal in dev so contributors
  // can boot without a node attached (unrelated features still work).
  const msg =
    '[rpcClient] SYSCOIN_RPC_USER / SYSCOIN_RPC_PASS are not set. RPC calls will fail until configured.';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(msg);
  }
  // eslint-disable-next-line no-console
  console.warn(msg);
}

const client = new SyscoinRpcClient(config);

module.exports = {
  client,
  rpcServices,
};
