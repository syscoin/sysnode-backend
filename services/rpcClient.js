const { SyscoinRpcClient, rpcServices } = require("@syscoin/syscoin-js");

const config = {
  host: "localhost",
  rpcPort: 8370,
  username: "u",
  password: "p",
  logLevel: "error"
};

const client = new SyscoinRpcClient(config);

module.exports = {
  client,
  rpcServices
};