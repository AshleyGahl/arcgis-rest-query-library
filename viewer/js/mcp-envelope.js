/**
 * The MCP envelopes the run panels show under a question they just ran.
 *
 * Each panel runs its entry itself — the grid needs every row and raw epoch dates —
 * and then renders the `tools/call` an agent would have sent for the same question.
 * The payload inside comes from the tools' own builders (`libraryQueryPayload`,
 * `tsqlPayload`) and the wrapper from `toolContent`, all exported by `mcp/tools.js`,
 * so what is shown is the envelope the stdio server would have written rather than a
 * lookalike assembled here. `test/mcp.test.js` asserts the two agree.
 *
 * Nothing in the page dispatches any more: this module builds envelopes, it does not
 * execute the protocol. That is why the test above is load-bearing.
 */
import { toolContent } from '../../mcp/tools.js';

/** One monotonic JSON-RPC id sequence for the whole page, as a single client would have. */
let nextId = 1;
export const nextRpcId = () => nextId++;

/** The `tools/call` request envelope for a tool, exactly as it would cross a transport. */
export const toolCallRequest = (name, args) => ({
  jsonrpc: '2.0',
  id: nextRpcId(),
  method: 'tools/call',
  params: { name, arguments: args },
});

/** The response envelope a successful `tools/call` produces, around a known payload. */
export const toolCallResponse = (id, payload) => ({ jsonrpc: '2.0', id, result: toolContent(payload) });
