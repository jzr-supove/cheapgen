/** A JSON-RPC error to send back for a request. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.rpcCode = code;
    this.data = data;
  }
}
