-- rootstock-migration: additive
-- The call log: one row per MCP tool call, written off the response path by
-- usage's postgresCallLog. The arguments are always kept (`{}` when a call had
-- none); a failure keeps its class, never its message. Run with search_path
-- set to the target schema, so nothing here is schema-qualified.
CREATE TABLE mcp_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  caller text NOT NULL,
  on_behalf_of text,
  turn_id text,
  tool text NOT NULL,
  args jsonb NOT NULL,
  duration_ms integer NOT NULL,
  ok boolean NOT NULL,
  error_class text,
  result_ids jsonb,
  phases jsonb,
  tokens jsonb,
  cost_usd numeric,
  cost_note text,
  output_text text,
  extra jsonb,
  server_sha text,
  client_ua text,
  mcp_protocol text
);
CREATE INDEX mcp_calls_created_idx ON mcp_calls (created_at DESC);
CREATE INDEX mcp_calls_caller_created_idx ON mcp_calls (caller, created_at DESC);
CREATE INDEX mcp_calls_tool_created_idx ON mcp_calls (tool, created_at DESC);
CREATE INDEX mcp_calls_turn_id_idx ON mcp_calls (turn_id) WHERE turn_id IS NOT NULL;
